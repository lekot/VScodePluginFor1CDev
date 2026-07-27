import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ConfigurationId } from '../services/configurationSession/types';
import type {
  SupportRunSummary,
  SupportOperationalErrorCode,
  TargetGenerationRef,
  TargetSupportSyncResult,
  TargetSupportSyncState,
  TargetSupportVerifyResult,
} from './supportTypes';
import { SUPPORT_OPERATIONAL_ERROR_CODES } from './supportTypes';

const JOURNAL_VERSION = 1;
const INTERRUPTED = 'SUPPORT_RUN_INTERRUPTED';

interface ActiveSupportRun {
  readonly kind: 'active';
  readonly runId: string;
  readonly configurationId: ConfigurationId;
  readonly desiredGenerationId: string;
  readonly operation: 'sync' | 'verify';
  readonly scope: 'replicated';
  readonly targets: readonly TargetSupportSyncState[];
}

interface TerminalSupportRun {
  readonly kind: 'terminal';
  readonly summary: SupportRunSummary;
}

type StoredSupportRun = ActiveSupportRun | TerminalSupportRun;

type JournalPublication =
  | { readonly status: 'durable' }
  | {
      readonly status: 'committedWithBarrierLimitation';
      readonly barrierError: unknown;
    };

interface JournalDocument {
  readonly version: typeof JOURNAL_VERSION;
  readonly runs: readonly StoredSupportRun[];
}

export interface SupportRunJournalFileSystem {
  readFile(filePath: string): Promise<string>;
  mkdir(directoryPath: string): Promise<void>;
  writeNewFile(filePath: string, contents: string): Promise<void>;
  rename(sourcePath: string, targetPath: string): Promise<void>;
  remove(filePath: string): Promise<void>;
  syncDirectory(directoryPath: string): Promise<void>;
}

export interface SupportRunJournalDeps {
  readonly fileSystem?: SupportRunJournalFileSystem;
  readonly createTemporaryId?: () => string;
}

export class SupportRunJournalError extends Error {
  constructor(
    readonly code:
      | 'SUPPORT_JOURNAL_INVALID'
      | 'SUPPORT_JOURNAL_CONFLICT'
      | 'SUPPORT_JOURNAL_DURABILITY_BARRIER_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'SupportRunJournalError';
  }
}

/**
 * Durable, one-record-per-configuration fan-out journal.
 *
 * Only identifiers, state discriminants and error codes are persisted. Payloads, command lines,
 * credentials and arbitrary process diagnostics cannot enter the on-disk schema.
 */
export class SupportRunJournal {
  private readonly fileSystem: SupportRunJournalFileSystem;
  private readonly createTemporaryId: () => string;
  private loaded = false;
  private runs = new Map<ConfigurationId, StoredSupportRun>();
  private tail: Promise<void> = Promise.resolve();
  private fatalError: SupportRunJournalError | undefined;

  constructor(
    private readonly filePath: string,
    deps: SupportRunJournalDeps = {},
  ) {
    this.fileSystem = deps.fileSystem ?? nodeFileSystem;
    this.createTemporaryId = deps.createTemporaryId ?? randomUUID;
  }

  async begin(
    header: {
      readonly runId: string;
      readonly configurationId: ConfigurationId;
      readonly desiredGenerationId: string;
      readonly operation: 'sync' | 'verify';
    },
    targets: readonly TargetGenerationRef[],
  ): Promise<void> {
    await this.mutate(async () => {
      const current = this.runs.get(header.configurationId);
      if (current?.kind === 'active') {
        throw new SupportRunJournalError(
          'SUPPORT_JOURNAL_CONFLICT',
          `Support run ${current.runId} is already active for ${header.configurationId}.`,
        );
      }
      validateTargetCollection(
        targets.map((target) => ({ ...target, state: 'pending' as const })),
        header.desiredGenerationId,
        'begin.targets',
      );
      const next = new Map(this.runs);
      next.set(header.configurationId, {
        kind: 'active',
        ...header,
        scope: 'replicated',
        targets: targets.map((target) => ({ ...target, state: 'pending' })),
      });
      const publication = await this.persist(next);
      this.runs = next;
      this.raiseBarrierLimitation(publication);
    });
  }

  async transition(
    configurationId: ConfigurationId,
    runId: string,
    target: TargetSupportSyncState,
  ): Promise<void> {
    await this.mutate(async () => {
      const run = this.requireActive(configurationId, runId);
      const index = run.targets.findIndex(
        (candidate) => candidate.canonicalTargetId === target.canonicalTargetId,
      );
      if (index < 0) {
        throw new SupportRunJournalError(
          'SUPPORT_JOURNAL_CONFLICT',
          `Target ${target.canonicalTargetId} is not part of support run ${runId}.`,
        );
      }
      if (target.desiredGenerationId !== run.desiredGenerationId) {
        throw new SupportRunJournalError(
          'SUPPORT_JOURNAL_CONFLICT',
          `Target ${target.canonicalTargetId} has a stale desired generation.`,
        );
      }
      if (
        run.operation === 'verify'
        && (
          target.state === 'preparing'
          || target.state === 'applying'
          || target.state === 'applied'
          || (target.state === 'failed' && target.stage !== 'verify')
          || (target.state === 'inDoubt' && target.stage !== 'reconcile')
        )
      ) {
        throw new SupportRunJournalError(
          'SUPPORT_JOURNAL_CONFLICT',
          `Verify run ${runId} cannot enter ${target.state}.`,
        );
      }
      const targets = [...run.targets];
      assertLegalTransition(run.operation, targets[index]!, target);
      targets[index] = copyTargetState(target);
      const next = new Map(this.runs);
      next.set(configurationId, { ...run, targets });
      const publication = await this.persist(next);
      this.runs = next;
      this.raiseBarrierLimitation(publication);
    });
  }

  async complete(summary: SupportRunSummary): Promise<void> {
    await this.mutate(async () => {
      const current = this.runs.get(summary.configurationId);
      if (current?.kind === 'active' && current.runId !== summary.runId) {
        throw new SupportRunJournalError(
          'SUPPORT_JOURNAL_CONFLICT',
          `Support run ${current.runId} cannot be completed as ${summary.runId}.`,
        );
      }
      const validated = parseSummary(
        JSON.parse(JSON.stringify(summary)) as unknown,
        'summary',
      );
      if (current?.kind === 'active') {
        assertActiveMatchesSummary(current, validated);
      }
      const next = new Map(this.runs);
      next.set(summary.configurationId, {
        kind: 'terminal',
        summary: validated,
      });
      const publication = await this.persist(next);
      this.runs = next;
      this.raiseBarrierLimitation(publication);
    });
  }

  async getLastRun(configurationId: ConfigurationId): Promise<SupportRunSummary | undefined> {
    this.assertUsable();
    await this.tail;
    this.assertUsable();
    await this.ensureLoaded();
    const record = this.runs.get(configurationId);
    return record?.kind === 'terminal' ? copySummary(record.summary) : undefined;
  }

  async getActiveRun(configurationId: ConfigurationId): Promise<ActiveSupportRun | undefined> {
    this.assertUsable();
    await this.tail;
    this.assertUsable();
    await this.ensureLoaded();
    const record = this.runs.get(configurationId);
    return record?.kind === 'active' ? copyActiveRun(record) : undefined;
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    this.assertUsable();
    let release: (() => void) | undefined;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const predecessor = this.tail;
    this.tail = next;
    await predecessor;
    try {
      this.assertUsable();
      await this.ensureLoaded();
      await operation();
    } finally {
      release?.();
    }
  }

  private async ensureLoaded(): Promise<void> {
    this.assertUsable();
    if (this.loaded) {
      return;
    }
    let document: JournalDocument = { version: JOURNAL_VERSION, runs: [] };
    try {
      document = parseDocument(await this.fileSystem.readFile(this.filePath));
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof SupportRunJournalError) {
          throw error;
        }
        throw new SupportRunJournalError(
          'SUPPORT_JOURNAL_INVALID',
          `Support run journal cannot be read: ${errorMessage(error)}`,
        );
      }
    }

    const nextRuns = new Map(document.runs.map((run) => [configurationIdOf(run), run]));
    let normalized = false;
    for (const [configurationId, run] of nextRuns) {
      if (run.kind === 'active') {
        nextRuns.set(configurationId, {
          kind: 'terminal',
          summary: normalizeInterruptedRun(run),
        });
        normalized = true;
      }
    }
    const publication = normalized ? await this.persist(nextRuns) : undefined;
    this.runs = nextRuns;
    this.loaded = true;
    if (publication) {
      this.raiseBarrierLimitation(publication);
    }
  }

  private requireActive(configurationId: ConfigurationId, runId: string): ActiveSupportRun {
    const run = this.runs.get(configurationId);
    if (run?.kind !== 'active' || run.runId !== runId) {
      throw new SupportRunJournalError(
        'SUPPORT_JOURNAL_CONFLICT',
        `Support run ${runId} is not active for ${configurationId}.`,
      );
    }
    return run;
  }

  private async persist(runs: ReadonlyMap<ConfigurationId, StoredSupportRun>): Promise<JournalPublication> {
    const directoryPath = path.dirname(this.filePath);
    await this.fileSystem.mkdir(directoryPath);
    const tempPath = path.join(
      directoryPath,
      `.${path.basename(this.filePath)}.${this.createTemporaryId()}.tmp`,
    );
    const document: JournalDocument = {
      version: JOURNAL_VERSION,
      runs: [...runs.values()],
    };
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    try {
      await this.fileSystem.writeNewFile(tempPath, serialized);
      await this.fileSystem.rename(tempPath, this.filePath);
      try {
        await this.fileSystem.syncDirectory(directoryPath);
        return { status: 'durable' };
      } catch (barrierError) {
        try {
          const published = await this.fileSystem.readFile(this.filePath);
          parseDocument(published);
          if (published === serialized) {
            return { status: 'committedWithBarrierLimitation', barrierError };
          }
        } catch {
          // The target cannot be proven to contain the intended strict journal document.
        }
        const fatal = new SupportRunJournalError(
          'SUPPORT_JOURNAL_INVALID',
          `Support journal publication is uncertain after rename; reload required: ${errorMessage(barrierError)}`,
        );
        this.fatalError = fatal;
        throw fatal;
      }
    } finally {
      await this.fileSystem.remove(tempPath).catch(() => undefined);
    }
  }

  private raiseBarrierLimitation(publication: JournalPublication): void {
    if (publication.status === 'committedWithBarrierLimitation') {
      throw new SupportRunJournalError(
        'SUPPORT_JOURNAL_DURABILITY_BARRIER_FAILED',
        `Support journal was committed, but its directory durability barrier failed: ${errorMessage(publication.barrierError)}`,
      );
    }
  }

  private assertUsable(): void {
    if (this.fatalError) {
      throw this.fatalError;
    }
  }
}

function normalizeInterruptedRun(run: ActiveSupportRun): SupportRunSummary {
  const targets = run.targets.map(normalizeInterruptedTarget);
  if (run.operation === 'verify') {
    const verifyTargets = targets.map(assertVerifyResult);
    return {
      runId: run.runId,
      configurationId: run.configurationId,
      desiredGenerationId: run.desiredGenerationId,
      operation: 'verify',
      scope: 'replicated',
      targets: verifyTargets,
      state: aggregateRunState(verifyTargets),
    };
  }
  return {
    runId: run.runId,
    configurationId: run.configurationId,
    desiredGenerationId: run.desiredGenerationId,
    operation: 'sync',
    scope: 'replicated',
    targets,
    state: aggregateRunState(targets),
  };
}

function normalizeInterruptedTarget(target: TargetSupportSyncState): TargetSupportSyncResult {
  const ref = generationRef(target);
  switch (target.state) {
    case 'pending':
      return { ...ref, state: 'skipped', reason: 'cancelled' };
    case 'preparing':
      return { ...ref, state: 'failed', stage: 'prepare', errorCode: INTERRUPTED, retryable: true };
    case 'applying':
      return { ...ref, state: 'inDoubt', stage: 'apply', errorCode: INTERRUPTED };
    case 'verifying':
      return { ...ref, state: 'failed', stage: 'verify', errorCode: INTERRUPTED, retryable: true };
    case 'reconciling':
      return { ...ref, state: 'inDoubt', stage: 'reconcile', errorCode: INTERRUPTED };
    default:
      return copyTargetState(target);
  }
}

function aggregateRunState(
  targets: readonly (TargetSupportSyncResult | TargetSupportVerifyResult)[],
): 'complete' | 'partial' | 'failed' | 'cancelled' {
  if (targets.some((target) => target.state === 'skipped' && target.reason === 'cancelled')) {
    return 'cancelled';
  }
  if (targets.some((target) =>
    (target.state === 'failed' || target.state === 'inDoubt')
    && (
      target.errorCode === 'CONFIGURATOR_CANCELLED_BEFORE_START'
      || target.errorCode === 'CONFIGURATOR_CANCELLED_AFTER_START'
    ))) {
    return 'cancelled';
  }
  const successes = targets.filter((target) => target.state === 'applied' || target.state === 'verified').length;
  if (successes === targets.length) {
    return 'complete';
  }
  return successes > 0 ? 'partial' : 'failed';
}

function assertVerifyResult(target: TargetSupportSyncResult): TargetSupportVerifyResult {
  if (target.state === 'verified' || target.state === 'stale' || target.state === 'skipped') {
    return target;
  }
  if (target.state === 'failed' && target.stage === 'verify') {
    return {
      ...generationRef(target),
      state: 'failed',
      stage: 'verify',
      errorCode: target.errorCode,
      retryable: target.retryable,
    };
  }
  if (target.state === 'inDoubt' && target.stage === 'reconcile') {
    return {
      ...generationRef(target),
      state: 'inDoubt',
      stage: 'reconcile',
      errorCode: target.errorCode,
    };
  }
  throw new SupportRunJournalError(
    'SUPPORT_JOURNAL_INVALID',
    `Verify run contains illegal terminal target state ${target.state}.`,
  );
}

function parseDocument(text: string): JournalDocument {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new SupportRunJournalError('SUPPORT_JOURNAL_INVALID', `Invalid journal JSON: ${errorMessage(error)}`);
  }
  const root = requireRecord(value, 'journal');
  requireExactKeys(root, ['version', 'runs'], 'journal');
  if (root.version !== JOURNAL_VERSION || !Array.isArray(root.runs)) {
    throw new SupportRunJournalError('SUPPORT_JOURNAL_INVALID', 'Unsupported support journal schema.');
  }
  const runs = root.runs.map(parseStoredRun);
  const configurationIds = new Set<string>();
  for (const run of runs) {
    const configurationId = configurationIdOf(run);
    if (configurationIds.has(configurationId)) {
      throw new SupportRunJournalError(
        'SUPPORT_JOURNAL_INVALID',
        `Duplicate support journal record for ${configurationId}.`,
      );
    }
    configurationIds.add(configurationId);
  }
  return { version: JOURNAL_VERSION, runs };
}

function parseStoredRun(value: unknown, index: number): StoredSupportRun {
  const record = requireRecord(value, `runs[${index}]`);
  if (record.kind === 'terminal') {
    requireExactKeys(record, ['kind', 'summary'], `runs[${index}]`);
    return { kind: 'terminal', summary: parseSummary(record.summary, `runs[${index}].summary`) };
  }
  if (record.kind !== 'active') {
    throw invalid(`runs[${index}].kind`);
  }
  requireExactKeys(
    record,
    ['kind', 'runId', 'configurationId', 'desiredGenerationId', 'operation', 'scope', 'targets'],
    `runs[${index}]`,
  );
  const operation = requireOneOf(record.operation, ['sync', 'verify'] as const, `runs[${index}].operation`);
  if (record.scope !== 'replicated' || !Array.isArray(record.targets)) {
    throw invalid(`runs[${index}]`);
  }
  const targets = record.targets.map((target, targetIndex) =>
    parseTargetState(target, `runs[${index}].targets[${targetIndex}]`));
  const desiredGenerationId = requireString(
    record.desiredGenerationId,
    `runs[${index}].desiredGenerationId`,
  );
  validateTargetCollection(targets, desiredGenerationId, `runs[${index}].targets`);
  if (operation === 'verify') {
    for (const target of targets) {
      if (
        target.state === 'preparing'
        || target.state === 'applying'
        || target.state === 'applied'
        || (target.state === 'failed' && target.stage !== 'verify')
        || (target.state === 'inDoubt' && target.stage !== 'reconcile')
      ) {
        throw invalid(`runs[${index}].targets`);
      }
    }
  }
  return {
    kind: 'active',
    runId: requireString(record.runId, `runs[${index}].runId`),
    configurationId: requireString(record.configurationId, `runs[${index}].configurationId`) as ConfigurationId,
    desiredGenerationId,
    operation,
    scope: 'replicated',
    targets,
  };
}

function parseSummary(value: unknown, location: string): SupportRunSummary {
  const record = requireRecord(value, location);
  const operation = requireOneOf(record.operation, ['sync', 'verify'] as const, `${location}.operation`);
  const scope = requireOneOf(record.scope, ['masterOnly', 'replicated'] as const, `${location}.scope`);
  const baseKeys = ['runId', 'configurationId', 'desiredGenerationId', 'operation', 'scope', 'targets', 'state'];
  const state = requireOneOf(
    record.state,
    ['complete', 'partial', 'failed', 'cancelled', 'obsolete'] as const,
    `${location}.state`,
  );
  requireExactKeys(record, state === 'obsolete' ? [...baseKeys, 'supersededByGenerationId'] : baseKeys, location);
  if (!Array.isArray(record.targets)) {
    throw invalid(`${location}.targets`);
  }
  const header = {
    runId: requireString(record.runId, `${location}.runId`),
    configurationId: requireString(record.configurationId, `${location}.configurationId`) as ConfigurationId,
    desiredGenerationId: requireString(record.desiredGenerationId, `${location}.desiredGenerationId`),
  };
  if (scope === 'masterOnly') {
    if (state !== 'complete' || record.targets.length !== 0) {
      throw invalid(location);
    }
    return operation === 'sync'
      ? { ...header, operation, scope, targets: [], state }
      : { ...header, operation, scope, targets: [], state };
  }
  const parsedTargets = record.targets.map((target, index) =>
    requireTerminal(parseTargetState(target, `${location}.targets[${index}]`), `${location}.targets[${index}]`));
  validateTargetCollection(parsedTargets, header.desiredGenerationId, `${location}.targets`);
  const supersededByGenerationId = state === 'obsolete'
    ? requireString(record.supersededByGenerationId, `${location}.supersededByGenerationId`)
    : undefined;
  if (state !== 'obsolete' && state !== aggregateRunState(parsedTargets)) {
    throw invalid(`${location}.state`);
  }
  if (
    state === 'obsolete'
    && (
      supersededByGenerationId === header.desiredGenerationId
      || !parsedTargets.some(
        (target) =>
          (target.state === 'skipped' && target.reason === 'obsolete')
          || (target.state === 'stale' && target.reason === 'masterAdvanced'),
      )
    )
  ) {
    throw invalid(location);
  }
  if (operation === 'verify') {
    const targets = parsedTargets.map(assertVerifyResult);
    return state === 'obsolete'
      ? { ...header, operation, scope, targets, state, supersededByGenerationId: supersededByGenerationId! }
      : { ...header, operation, scope, targets, state };
  }
  return state === 'obsolete'
    ? { ...header, operation, scope, targets: parsedTargets, state, supersededByGenerationId: supersededByGenerationId! }
    : { ...header, operation, scope, targets: parsedTargets, state };
}

function parseTargetState(value: unknown, location: string): TargetSupportSyncState {
  const record = requireRecord(value, location);
  const state = requireOneOf(
    record.state,
    ['pending', 'preparing', 'applying', 'verifying', 'reconciling', 'applied', 'verified', 'stale', 'failed', 'inDoubt', 'skipped'] as const,
    `${location}.state`,
  );
  const refKeys = ['canonicalTargetId', 'infobaseIds', 'desiredGenerationId', 'state'];
  const ref = {
    canonicalTargetId: requireString(record.canonicalTargetId, `${location}.canonicalTargetId`),
    infobaseIds: requireStringArray(record.infobaseIds, `${location}.infobaseIds`),
    desiredGenerationId: requireString(record.desiredGenerationId, `${location}.desiredGenerationId`),
  };
  switch (state) {
    case 'pending':
      requireExactKeys(record, refKeys, location);
      return { ...ref, state };
    case 'preparing':
    case 'applying':
    case 'verifying':
    case 'reconciling':
      requireExactKeys(record, [...refKeys, 'startedAt'], location);
      return { ...ref, state, startedAt: requireString(record.startedAt, `${location}.startedAt`) };
    case 'applied':
      requireExactKeys(record, [...refKeys, 'acknowledgedGenerationId', 'evidence'], location);
      return {
        ...ref,
        state,
        acknowledgedGenerationId: requireString(record.acknowledgedGenerationId, `${location}.acknowledgedGenerationId`),
        evidence: requireOneOf(
          record.evidence,
          ['configuratorAck', 'cachedConfiguratorAck'] as const,
          `${location}.evidence`,
        ),
      };
    case 'verified':
      requireExactKeys(record, [...refKeys, 'verifiedGenerationId', 'evidence'], location);
      if (record.evidence !== 'semanticDump') {
        throw invalid(`${location}.evidence`);
      }
      return {
        ...ref,
        state,
        verifiedGenerationId: requireString(record.verifiedGenerationId, `${location}.verifiedGenerationId`),
        evidence: 'semanticDump',
      };
    case 'stale': {
      const hasLast = record.lastAppliedGenerationId !== undefined;
      requireExactKeys(record, hasLast ? [...refKeys, 'reason', 'lastAppliedGenerationId'] : [...refKeys, 'reason'], location);
      return {
        ...ref,
        state,
        reason: requireOneOf(record.reason, ['masterAdvanced', 'targetDrift'] as const, `${location}.reason`),
        ...(hasLast
          ? { lastAppliedGenerationId: requireString(record.lastAppliedGenerationId, `${location}.lastAppliedGenerationId`) }
          : {}),
      };
    }
    case 'failed':
      requireExactKeys(record, [...refKeys, 'stage', 'errorCode', 'retryable'], location);
      if (typeof record.retryable !== 'boolean') {
        throw invalid(`${location}.retryable`);
      }
      return {
        ...ref,
        state,
        stage: requireOneOf(record.stage, ['prepare', 'apply', 'verify'] as const, `${location}.stage`),
        errorCode: requireOperationalErrorCode(record.errorCode, `${location}.errorCode`),
        retryable: record.retryable,
      };
    case 'inDoubt':
      requireExactKeys(record, [...refKeys, 'stage', 'errorCode'], location);
      return {
        ...ref,
        state,
        stage: requireOneOf(record.stage, ['apply', 'reconcile'] as const, `${location}.stage`),
        errorCode: requireOperationalErrorCode(record.errorCode, `${location}.errorCode`),
      };
    case 'skipped':
      requireExactKeys(record, [...refKeys, 'reason'], location);
      return {
        ...ref,
        state,
        reason: requireOneOf(record.reason, ['cancelled', 'obsolete'] as const, `${location}.reason`),
      };
  }
}

function requireTerminal(target: TargetSupportSyncState, location: string): TargetSupportSyncResult {
  if (
    target.state === 'applied'
    || target.state === 'verified'
    || target.state === 'stale'
    || target.state === 'failed'
    || target.state === 'inDoubt'
    || target.state === 'skipped'
  ) {
    return target;
  }
  throw invalid(location);
}

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(location);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], location: string): void {
  const expected = new Set(keys);
  if (Object.keys(record).some((key) => !expected.has(key)) || keys.some((key) => !(key in record))) {
    throw invalid(location);
  }
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== 'string' || !value) {
    throw invalid(location);
  }
  return value;
}

function requireOperationalErrorCode(value: unknown, location: string): SupportOperationalErrorCode {
  const code = requireString(value, location);
  if (!(SUPPORT_OPERATIONAL_ERROR_CODES as readonly string[]).includes(code)) {
    throw invalid(location);
  }
  return code as SupportOperationalErrorCode;
}

function requireStringArray(value: unknown, location: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw invalid(location);
  }
  return [...value] as string[];
}

function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalid(location);
  }
  return value as T;
}

function invalid(location: string): SupportRunJournalError {
  return new SupportRunJournalError('SUPPORT_JOURNAL_INVALID', `Invalid support journal field: ${location}.`);
}

function generationRef(target: TargetGenerationRef): TargetGenerationRef {
  return {
    canonicalTargetId: target.canonicalTargetId,
    infobaseIds: [...target.infobaseIds],
    desiredGenerationId: target.desiredGenerationId,
  };
}

function validateTargetCollection(
  targets: readonly TargetSupportSyncState[],
  desiredGenerationId: string,
  location: string,
): void {
  const canonicalTargetIds = new Set<string>();
  for (const target of targets) {
    if (
      target.desiredGenerationId !== desiredGenerationId
      || canonicalTargetIds.has(target.canonicalTargetId)
      || (
        target.state === 'applied'
        && target.acknowledgedGenerationId !== desiredGenerationId
      )
      || (
        target.state === 'verified'
        && target.verifiedGenerationId !== desiredGenerationId
      )
    ) {
      throw invalid(location);
    }
    canonicalTargetIds.add(target.canonicalTargetId);
  }
}

function assertActiveMatchesSummary(
  active: ActiveSupportRun,
  summary: SupportRunSummary,
): void {
  if (
    summary.runId !== active.runId
    || summary.configurationId !== active.configurationId
    || summary.desiredGenerationId !== active.desiredGenerationId
    || summary.operation !== active.operation
    || summary.scope !== 'replicated'
    || summary.targets.length !== active.targets.length
  ) {
    throw new SupportRunJournalError(
      'SUPPORT_JOURNAL_CONFLICT',
      `Terminal summary does not match active support run ${active.runId}.`,
    );
  }
  const activeById = new Map(active.targets.map((target) => [target.canonicalTargetId, target]));
  for (const target of summary.targets) {
    const current = activeById.get(target.canonicalTargetId);
    if (!current) {
      throw new SupportRunJournalError(
        'SUPPORT_JOURNAL_CONFLICT',
        `Terminal target ${target.canonicalTargetId} does not match active journal state.`,
      );
    }
    if (JSON.stringify(current) !== JSON.stringify(target)) {
      assertLegalTransition(active.operation, current, target);
    }
  }
}

function assertLegalTransition(
  operation: 'sync' | 'verify',
  before: TargetSupportSyncState,
  after: TargetSupportSyncState,
): void {
  if (
    before.canonicalTargetId !== after.canonicalTargetId
    || before.desiredGenerationId !== after.desiredGenerationId
    || JSON.stringify(before.infobaseIds) !== JSON.stringify(after.infobaseIds)
  ) {
    throw new SupportRunJournalError(
      'SUPPORT_JOURNAL_CONFLICT',
      `Support target identity changed during transition for ${before.canonicalTargetId}.`,
    );
  }
  const obsoleteSkip = after.state === 'skipped' && after.reason === 'obsolete';
  let legal = false;
  switch (before.state) {
    case 'pending':
      legal = after.state === 'preparing'
        || after.state === 'verifying'
        || after.state === 'reconciling'
        || (after.state === 'failed' && (after.stage === 'prepare' || after.stage === 'verify'))
        || (after.state === 'inDoubt' && after.stage === 'reconcile')
        || after.state === 'skipped';
      break;
    case 'preparing':
      legal = after.state === 'applied'
        || after.state === 'verified'
        || after.state === 'verifying'
        || after.state === 'applying'
        || (after.state === 'failed' && after.stage === 'prepare')
        || (after.state === 'stale' && after.reason === 'targetDrift')
        || obsoleteSkip;
      break;
    case 'applying':
      legal = after.state === 'applied'
        || (after.state === 'failed' && after.stage === 'apply')
        || (after.state === 'inDoubt' && after.stage === 'apply')
        || (after.state === 'stale' && after.reason === 'targetDrift')
        || obsoleteSkip;
      break;
    case 'applied':
      legal = after.state === 'verifying'
        || (after.state === 'stale' && after.reason === 'masterAdvanced');
      break;
    case 'verifying':
      legal = after.state === 'verified'
        || (after.state === 'failed' && after.stage === 'verify')
        || after.state === 'stale'
        || obsoleteSkip;
      break;
    case 'inDoubt':
      legal = after.state === 'reconciling';
      break;
    case 'reconciling':
      legal = after.state === 'verified'
        || (operation === 'sync' && after.state === 'applying')
        || (after.state === 'stale' && after.reason === 'masterAdvanced')
        || (operation === 'verify' && after.state === 'stale' && after.reason === 'targetDrift')
        || (after.state === 'inDoubt' && after.stage === 'reconcile');
      break;
    case 'verified':
      legal = after.state === 'stale' && after.reason === 'masterAdvanced';
      break;
    case 'stale':
    case 'failed':
    case 'skipped':
      legal = false;
      break;
  }
  if (!legal) {
    throw new SupportRunJournalError(
      'SUPPORT_JOURNAL_CONFLICT',
      `Illegal support target transition ${before.state} -> ${after.state}.`,
    );
  }
}

function copyTargetState<T extends TargetSupportSyncState>(target: T): T {
  return { ...target, infobaseIds: [...target.infobaseIds] };
}

function copyActiveRun(run: ActiveSupportRun): ActiveSupportRun {
  return { ...run, targets: run.targets.map(copyTargetState) };
}

function copySummary<T extends SupportRunSummary>(summary: T): T {
  return {
    ...summary,
    targets: summary.targets.map(copyTargetState),
  } as T;
}

function configurationIdOf(run: StoredSupportRun): ConfigurationId {
  return run.kind === 'active' ? run.configurationId : run.summary.configurationId;
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT',
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const nodeFileSystem: SupportRunJournalFileSystem = {
  readFile: (filePath) => fs.readFile(filePath, 'utf8'),
  mkdir: async (directoryPath) => {
    await fs.mkdir(directoryPath, { recursive: true });
  },
  writeNewFile: async (filePath, contents) => {
    const handle = await fs.open(filePath, 'wx');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (sourcePath, targetPath) => fs.rename(sourcePath, targetPath),
  remove: async (filePath) => {
    await fs.rm(filePath, { force: true });
  },
  syncDirectory: async (directoryPath) => {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(directoryPath, 'r');
      await handle.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) {
        throw error;
      }
    } finally {
      await handle?.close();
    }
  },
};

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (process.platform !== 'win32' || !error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'EISDIR';
}
