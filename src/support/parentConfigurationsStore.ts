import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ConfigurationId } from '../services/configurationSession/types';
import { AtomicFileStorage } from '../services/configurationSession/atomicFileStorage';
import { runExclusiveConfigurationOperation } from '../services/configurationSession/configurationMutationGateway';
import { ParentConfigurationsCodec, ParsedParentConfigurations } from './parentConfigurationsCodec';
import type { SupportTokenPatchPlan } from './parentConfigurationsCodec';
import { MetadataUniverseResolver } from './metadataUniverseResolver';
import type { MasterSupportState, SupportMutationResult } from './supportTypes';
import { SupportMutationError } from './supportTypes';

const SUPPORT_RELATIVE_PATH = path.join('Ext', 'ParentConfigurations.bin');
const RECOVERY_DIRECTORY = '.cdt-support-recovery';
const RECOVERY_JOURNAL_FILE = 'journal.json';
const RECOVERY_BACKUP_FILE = 'ParentConfigurations.bin.backup';
const SHA256 = /^[0-9a-f]{64}$/;

interface SupportRecoveryJournal {
  readonly version: 1;
  readonly configurationId: string;
  readonly targetRelativePath: string;
  readonly beforeGenerationId: string;
  readonly plannedAfterGenerationId: string;
  readonly expectedMetadataUniverseGenerationId: string | null;
  readonly backupFile: typeof RECOVERY_BACKUP_FILE;
}

type RecoveryResult =
  | { readonly kind: 'clean' }
  | { readonly kind: 'recovered' }
  | {
      readonly kind: 'required';
      readonly diagnostics: readonly string[];
      readonly observedGenerationId?: string;
    };

export interface ParentConfigurationsStoreDeps {
  readonly universeResolver?: MetadataUniverseResolver;
  readonly createStorage?: (configRoot: string) => AtomicFileStorage;
  readonly readFile?: (filePath: string) => Promise<Buffer>;
  readonly stat?: (filePath: string) => Promise<{ size: number; mtimeMs: number; ino?: number }>;
  readonly syncDirectory?: (directoryPath: string) => Promise<void>;
  readonly runExclusive?: <T>(resourcePath: string, kind: string, operation: () => Promise<T>) => Promise<T>;
}

export class ParentConfigurationsStore {
  private readonly documentsByGeneration = new Map<string, ParsedParentConfigurations>();

  constructor(
    private readonly configurationId: ConfigurationId,
    private readonly deps: ParentConfigurationsStoreDeps = {},
  ) {}

  async read(configRoot: string): Promise<MasterSupportState> {
    return (await this.readParsed(configRoot)).state;
  }

  async readParsed(configRoot: string): Promise<ParsedParentConfigurations> {
    const root = path.resolve(configRoot);
    const filePath = path.join(root, SUPPORT_RELATIVE_PATH);
    if (await this.hasRecoveryArtifacts(root)) {
      return this.runExclusive(
        filePath,
        'support.recoverParentConfigurations',
        () => this.readParsedWithinExclusiveLease(root),
      );
    }
    return this.readMaster(root);
  }

  /**
   * Reads and recovers the support master while the caller already owns the configuration lease.
   * This method deliberately never enters the configuration mutation gateway.
   */
  async readParsedWithinExclusiveLease(configRoot: string): Promise<ParsedParentConfigurations> {
    const root = path.resolve(configRoot);
    const recovery = await this.recoverPending(root);
    if (recovery.kind === 'required') {
      return this.recoveryUnknown(root, recovery);
    }
    return this.readFreshMaster(root);
  }

  async commit(plan: SupportTokenPatchPlan, expectedGenerationId: string): Promise<SupportMutationResult> {
    const configRoot = path.resolve(plan.configRoot);
    const resourcePath = path.join(configRoot, SUPPORT_RELATIVE_PATH);
    return this.runExclusive(
      resourcePath,
      'support.commitParentConfigurations',
      () => this.commitWithinExclusiveLease(plan, expectedGenerationId),
    );
  }

  /**
   * Performs recovery, universe CAS and master CAS while the caller already owns the lease.
   * Unlike {@link commit}, this method never reacquires the configuration mutation gateway.
   */
  async commitWithinExclusiveLease(
    plan: SupportTokenPatchPlan,
    expectedGenerationId: string,
  ): Promise<SupportMutationResult> {
    const configRoot = path.resolve(plan.configRoot);
    const resourcePath = path.join(configRoot, SUPPORT_RELATIVE_PATH);
    return this.commitExclusive(plan, expectedGenerationId, configRoot, resourcePath);
  }

  private async commitExclusive(
    plan: SupportTokenPatchPlan,
    expectedGenerationId: string,
    configRoot: string,
    resourcePath: string,
  ): Promise<SupportMutationResult> {
    if (
      plan.before.configurationId !== this.configurationId
      || plan.before.generationId !== expectedGenerationId
      || normalizePath(plan.before.filePath) !== normalizePath(resourcePath)
    ) {
      throw new SupportMutationError('SUPPORT_STALE_GENERATION', 'Support mutation generation or target is stale.');
    }

    const pendingRecovery = await this.recoverPending(configRoot);
    this.throwIfRecoveryRequired(pendingRecovery);

    if (plan.expectedMetadataUniverseGenerationId) {
      const currentUniverse = await this.resolveUniverse(configRoot);
      if (currentUniverse.metadataUniverseGenerationId !== plan.expectedMetadataUniverseGenerationId) {
        throw new SupportMutationError('SUPPORT_METADATA_UNIVERSE_STALE', 'Metadata universe changed before commit.');
      }
    }

    const live = await this.readFreshMaster(configRoot);
    if (live.state.kind !== 'ready' || live.state.snapshot.generationId !== expectedGenerationId) {
      throw new SupportMutationError('SUPPORT_STALE_GENERATION', 'Support master changed before commit.');
    }

    await this.prepareRecoveryJournal(
      configRoot,
      Buffer.from(live.bytes),
      plan.before.generationId,
      plan.after.generationId,
      plan.expectedMetadataUniverseGenerationId,
    );

    const storage = this.createStorage(configRoot);
    const replacement = await storage.replace(resourcePath, plan.afterDocument.bytes, expectedGenerationId);
    if (replacement.status === 'conflict') {
      await this.cleanupAfterProvenNoWrite(configRoot);
      throw new SupportMutationError('SUPPORT_STALE_GENERATION', replacement.message);
    }
    if (replacement.status === 'rolledBack') {
      const recovery = await this.recoverPending(configRoot);
      this.throwIfRecoveryRequired(recovery);
      throw new Error(replacement.message);
    }
    if (replacement.status === 'recoveryRequired') {
      const recovery = await this.recoverPending(configRoot);
      this.throwIfRecoveryRequired(recovery);
      throw new Error(replacement.message);
    }

    const postWrite = await this.readFreshMaster(configRoot);
    if (postWrite.state.kind !== 'ready' || postWrite.state.snapshot.generationId !== plan.after.generationId) {
      await this.restoreAfterFailedValidation(configRoot, ['Post-write generation mismatch.']);
    }

    if (plan.expectedMetadataUniverseGenerationId) {
      const afterUniverse = await this.resolveUniverse(configRoot);
      if (afterUniverse.metadataUniverseGenerationId !== plan.expectedMetadataUniverseGenerationId) {
        await this.restoreAfterFailedValidation(configRoot, ['Metadata universe changed after commit.']);
      }
    }

    if (postWrite.state.kind !== 'ready') {
      throw new SupportMutationError('SUPPORT_MASTER_RECOVERY_REQUIRED', 'Post-write support master is unreadable.');
    }
    await this.cleanupRecoveryArtifacts(configRoot);
    this.documentsByGeneration.set(postWrite.state.snapshot.generationId, postWrite);
    return {
      before: plan.before,
      after: postWrite.state.snapshot,
      changedTokenCount: plan.patches.length,
    };
  }

  private async readMaster(configRoot: string): Promise<ParsedParentConfigurations> {
    const filePath = path.join(configRoot, SUPPORT_RELATIVE_PATH);
    let bytes: Buffer;
    try {
      bytes = await this.stableRead(filePath);
    } catch (error) {
      if (isMissing(error)) {
        return new ParsedParentConfigurations(Buffer.alloc(0), {
          configurationId: this.configurationId,
          filePath,
          configRoot,
        }, {
          kind: 'unmanaged',
          reason: 'missing',
          configurationId: this.configurationId,
          expectedFilePath: filePath,
        });
      }
      return this.unknown(filePath, configRoot, `Stable read failed: ${errorMessage(error)}`);
    }
    if (bytes.length === 0) {
      return new ParsedParentConfigurations(bytes, {
        configurationId: this.configurationId,
        filePath,
        configRoot,
      }, {
        kind: 'unmanaged',
        reason: 'empty',
        configurationId: this.configurationId,
        expectedFilePath: filePath,
      });
    }
    const document = ParentConfigurationsCodec.parse(bytes, {
      configurationId: this.configurationId,
      filePath,
      configRoot,
    });
    if (document.state.kind === 'ready') {
      const cached = this.documentsByGeneration.get(document.state.snapshot.generationId);
      if (cached) { return cached; }
      this.documentsByGeneration.set(document.state.snapshot.generationId, document);
    }
    return document;
  }

  private async recoverPending(configRoot: string): Promise<RecoveryResult> {
    const recoveryPath = this.recoveryPath(configRoot);
    const journalPath = path.join(recoveryPath, RECOVERY_JOURNAL_FILE);
    const backupPath = path.join(recoveryPath, RECOVERY_BACKUP_FILE);
    const journalExists = await exists(journalPath);
    const backupExists = await exists(backupPath);
    if (!journalExists && !backupExists) {
      return { kind: 'clean' };
    }

    if (!journalExists && backupExists) {
      try {
        const live = await this.readFreshMaster(configRoot);
        if (live.state.kind !== 'ready') {
          return { kind: 'required', diagnostics: ['Orphan recovery backup exists and live master is not valid.'] };
        }
        await this.cleanupRecoveryArtifacts(configRoot);
        return { kind: 'recovered' };
      } catch (error) {
        return { kind: 'required', diagnostics: [`Orphan recovery backup cleanup failed: ${errorMessage(error)}`] };
      }
    }
    if (!backupExists) {
      return { kind: 'required', diagnostics: ['Recovery journal exists without its exact backup.'] };
    }

    let journal: SupportRecoveryJournal;
    let backup: Buffer;
    try {
      journal = parseRecoveryJournal(await fs.readFile(journalPath, 'utf8'), this.configurationId);
      backup = await fs.readFile(backupPath);
    } catch (error) {
      return { kind: 'required', diagnostics: [`Recovery artifacts are invalid: ${errorMessage(error)}`] };
    }
    if (hash(backup) !== journal.beforeGenerationId) {
      return { kind: 'required', diagnostics: ['Recovery backup hash does not match beforeGenerationId.'] };
    }
    const expectedTarget = path.join(configRoot, SUPPORT_RELATIVE_PATH);
    if (journal.targetRelativePath !== SUPPORT_RELATIVE_PATH.replace(/\\/g, '/')) {
      return { kind: 'required', diagnostics: ['Recovery journal target path is invalid.'] };
    }

    let liveBytes: Buffer;
    try {
      liveBytes = await this.stableRead(expectedTarget);
    } catch (error) {
      return { kind: 'required', diagnostics: [`Recovery live master is unreadable: ${errorMessage(error)}`] };
    }
    const observedGenerationId = hash(liveBytes);
    if (observedGenerationId === journal.beforeGenerationId) {
      const parsed = ParentConfigurationsCodec.parse(liveBytes, {
        configurationId: this.configurationId,
        filePath: expectedTarget,
        configRoot,
      });
      if (parsed.state.kind !== 'ready') {
        return { kind: 'required', observedGenerationId, diagnostics: ['Recovery before-generation is not a valid master.'] };
      }
      try {
        await this.cleanupRecoveryArtifacts(configRoot);
        return { kind: 'recovered' };
      } catch (error) {
        return { kind: 'required', observedGenerationId, diagnostics: [`Recovery cleanup failed: ${errorMessage(error)}`] };
      }
    }
    if (observedGenerationId !== journal.plannedAfterGenerationId) {
      return {
        kind: 'required',
        observedGenerationId,
        diagnostics: ['Conditional restore refused: live master is a third generation.'],
      };
    }

    const restore = await this.createStorage(configRoot).replace(
      expectedTarget,
      backup,
      journal.plannedAfterGenerationId,
    );
    if (restore.status !== 'committed' || restore.newHash !== journal.beforeGenerationId) {
      return {
        kind: 'required',
        observedGenerationId,
        diagnostics: [`Conditional restore failed: ${restore.status}.`],
      };
    }
    try {
      const restored = await this.stableRead(expectedTarget);
      const parsed = ParentConfigurationsCodec.parse(restored, {
        configurationId: this.configurationId,
        filePath: expectedTarget,
        configRoot,
      });
      if (hash(restored) !== journal.beforeGenerationId || parsed.state.kind !== 'ready') {
        return {
          kind: 'required',
          observedGenerationId: hash(restored),
          diagnostics: ['Restored source generation could not be proven.'],
        };
      }
      await this.cleanupRecoveryArtifacts(configRoot);
      this.documentsByGeneration.clear();
      return { kind: 'recovered' };
    } catch (error) {
      return {
        kind: 'required',
        observedGenerationId,
        diagnostics: [`Restored source validation failed: ${errorMessage(error)}`],
      };
    }
  }

  private async prepareRecoveryJournal(
    configRoot: string,
    backup: Buffer,
    beforeGenerationId: string,
    plannedAfterGenerationId: string,
    expectedUniverseGenerationId: string | undefined,
  ): Promise<void> {
    if (hash(backup) !== beforeGenerationId) {
      throw new SupportMutationError('SUPPORT_STALE_GENERATION', 'Exact backup does not match the planned generation.');
    }
    const recoveryPath = this.recoveryPath(configRoot);
    await fs.mkdir(recoveryPath, { recursive: true });
    await this.syncDirectory(configRoot);
    const backupPath = path.join(recoveryPath, RECOVERY_BACKUP_FILE);
    const journalPath = path.join(recoveryPath, RECOVERY_JOURNAL_FILE);
    const journal: SupportRecoveryJournal = {
      version: 1,
      configurationId: this.configurationId,
      targetRelativePath: SUPPORT_RELATIVE_PATH.replace(/\\/g, '/'),
      beforeGenerationId,
      plannedAfterGenerationId,
      expectedMetadataUniverseGenerationId: expectedUniverseGenerationId ?? null,
      backupFile: RECOVERY_BACKUP_FILE,
    };
    await writeNewAndSync(backupPath, backup);
    await writeNewAndSync(journalPath, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8'));
    await this.syncDirectory(recoveryPath);
  }

  private async cleanupAfterProvenNoWrite(configRoot: string): Promise<void> {
    try {
      await this.stableRead(path.join(configRoot, SUPPORT_RELATIVE_PATH));
      await this.cleanupRecoveryArtifacts(configRoot);
    } catch {
      // Leave the durable journal intact; the next read will fail closed instead of guessing.
    }
  }

  private async restoreAfterFailedValidation(configRoot: string, diagnostics: readonly string[]): Promise<never> {
    const recovery = await this.recoverPending(configRoot);
    if (recovery.kind === 'required') {
      throw new SupportMutationError(
        'SUPPORT_MASTER_RECOVERY_REQUIRED',
        [...diagnostics, ...recovery.diagnostics].join(' '),
      );
    }
    throw new SupportMutationError('SUPPORT_METADATA_UNIVERSE_STALE', diagnostics.join(' '));
  }

  private throwIfRecoveryRequired(recovery: RecoveryResult): void {
    if (recovery.kind === 'required') {
      throw new SupportMutationError('SUPPORT_MASTER_RECOVERY_REQUIRED', recovery.diagnostics.join(' '));
    }
  }

  private recoveryUnknown(configRoot: string, recovery: Extract<RecoveryResult, { kind: 'required' }>): ParsedParentConfigurations {
    const filePath = path.join(configRoot, SUPPORT_RELATIVE_PATH);
    return new ParsedParentConfigurations(Buffer.alloc(0), {
      configurationId: this.configurationId,
      filePath,
      configRoot,
    }, {
      kind: 'unknown',
      configurationId: this.configurationId,
      filePath,
      generationId: recovery.observedGenerationId,
      errorCode: 'SUPPORT_MASTER_RECOVERY_REQUIRED',
      diagnostics: recovery.diagnostics,
    });
  }

  private async readFreshMaster(configRoot: string): Promise<ParsedParentConfigurations> {
    this.documentsByGeneration.clear();
    return this.readMaster(configRoot);
  }

  private async stableRead(filePath: string): Promise<Buffer> {
    const readFile = this.deps.readFile ?? fs.readFile;
    const stat = this.deps.stat ?? fs.stat;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await stat(filePath);
      const bytes = await readFile(filePath);
      const after = await stat(filePath);
      if (sameStat(before, after) && bytes.length === after.size) { return Buffer.from(bytes); }
    }
    throw new Error('Support master changed during stable read.');
  }

  private resolveUniverse(configRoot: string) {
    const resolver = this.deps.universeResolver ?? new MetadataUniverseResolver();
    return resolver.resolve(configRoot);
  }

  private unknown(filePath: string, configRoot: string, diagnostic: string): ParsedParentConfigurations {
    return new ParsedParentConfigurations(Buffer.alloc(0), {
      configurationId: this.configurationId,
      filePath,
      configRoot,
    }, {
      kind: 'unknown',
      configurationId: this.configurationId,
      filePath,
      errorCode: 'SUPPORT_FILE_INVALID',
      diagnostics: [diagnostic],
    });
  }

  private runExclusive<T>(resourcePath: string, kind: string, operation: () => Promise<T>): Promise<T> {
    const runner = this.deps.runExclusive ?? runExclusiveConfigurationOperation;
    return runner(resourcePath, kind, operation);
  }

  private createStorage(configRoot: string): AtomicFileStorage {
    return this.deps.createStorage?.(configRoot) ?? new AtomicFileStorage(configRoot);
  }

  private recoveryPath(configRoot: string): string {
    return path.join(configRoot, RECOVERY_DIRECTORY);
  }

  private async hasRecoveryArtifacts(configRoot: string): Promise<boolean> {
    const recoveryPath = this.recoveryPath(configRoot);
    return (await exists(path.join(recoveryPath, RECOVERY_JOURNAL_FILE)))
      || (await exists(path.join(recoveryPath, RECOVERY_BACKUP_FILE)));
  }

  private async cleanupRecoveryArtifacts(configRoot: string): Promise<void> {
    const recoveryPath = this.recoveryPath(configRoot);
    await fs.rm(path.join(recoveryPath, RECOVERY_JOURNAL_FILE), { force: true });
    await fs.rm(path.join(recoveryPath, RECOVERY_BACKUP_FILE), { force: true });
    await this.syncDirectory(recoveryPath);
    await fs.rmdir(recoveryPath);
    await this.syncDirectory(configRoot);
  }

  private syncDirectory(directoryPath: string): Promise<void> {
    return (this.deps.syncDirectory ?? syncDirectory)(directoryPath);
  }
}

function parseRecoveryJournal(text: string, configurationId: ConfigurationId): SupportRecoveryJournal {
  const parsed = JSON.parse(text) as Partial<SupportRecoveryJournal>;
  if (
    parsed.version !== 1
    || parsed.configurationId !== configurationId
    || parsed.targetRelativePath !== SUPPORT_RELATIVE_PATH.replace(/\\/g, '/')
    || typeof parsed.beforeGenerationId !== 'string'
    || !SHA256.test(parsed.beforeGenerationId)
    || typeof parsed.plannedAfterGenerationId !== 'string'
    || !SHA256.test(parsed.plannedAfterGenerationId)
    || parsed.beforeGenerationId === parsed.plannedAfterGenerationId
    || (parsed.expectedMetadataUniverseGenerationId !== null
      && (typeof parsed.expectedMetadataUniverseGenerationId !== 'string'
        || !SHA256.test(parsed.expectedMetadataUniverseGenerationId)))
    || parsed.backupFile !== RECOVERY_BACKUP_FILE
  ) {
    throw new Error('Recovery journal schema is invalid.');
  }
  return parsed as SupportRecoveryJournal;
}

async function writeNewAndSync(filePath: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(filePath, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
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
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (process.platform !== 'win32' || typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'EISDIR';
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) { return false; }
    throw error;
  }
}

function sameStat(
  left: { size: number; mtimeMs: number; ino?: number },
  right: { size: number; mtimeMs: number; ino?: number },
): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs
    && (left.ino === undefined || right.ino === undefined || left.ino === right.ino);
}

function normalizePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
