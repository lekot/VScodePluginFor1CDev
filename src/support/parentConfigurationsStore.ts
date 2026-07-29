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
const RECOVERY_LIVE_DIRECTORY = 'live';
const RECOVERY_TOMBSTONE_DIRECTORY = 'tombstone';
const RECOVERY_JOURNAL_FILE = 'journal.json';
const RECOVERY_BACKUP_FILE = 'ParentConfigurations.bin.backup';
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_CACHED_GENERATIONS_PER_ROOT = 8;

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
  readonly recoveryRoot: string;
  readonly universeResolver?: MetadataUniverseResolver;
  readonly createStorage?: (configRoot: string) => AtomicFileStorage;
  readonly readFile?: (filePath: string) => Promise<Buffer>;
  readonly stat?: (filePath: string) => Promise<{ size: number; mtimeMs: number; ino?: number }>;
  readonly syncDirectory?: (directoryPath: string) => Promise<void>;
  readonly runExclusive?: <T>(resourcePath: string, kind: string, operation: () => Promise<T>) => Promise<T>;
}

export class ParentConfigurationsStore {
  private readonly documentsByRoot = new Map<string, Map<string, ParsedParentConfigurations>>();
  private readonly recoveryRoot: string;

  constructor(
    private readonly configurationId: ConfigurationId,
    private readonly deps: ParentConfigurationsStoreDeps,
  ) {
    this.recoveryRoot = path.resolve(deps.recoveryRoot);
  }

  async read(configRoot: string): Promise<MasterSupportState> {
    return (await this.readParsed(configRoot)).state;
  }

  async readParsed(configRoot: string): Promise<ParsedParentConfigurations> {
    const root = path.resolve(configRoot);
    const filePath = path.join(root, SUPPORT_RELATIVE_PATH);
    if (await this.hasRecoveryArtifacts()) {
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
    await this.invalidateRoot(configRoot);
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
    const canonicalRoot = await canonicalConfigRoot(configRoot);
    this.cacheDocument(canonicalRoot, resourcePath, postWrite.state.snapshot.generationId, postWrite);
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
    const generationId = hash(bytes);
    const canonicalRoot = await canonicalConfigRoot(configRoot);
    const cached = this.cachedDocument(canonicalRoot, filePath, generationId);
    if (cached) {
      return cached;
    }
    const document = ParentConfigurationsCodec.parse(bytes, {
      configurationId: this.configurationId,
      filePath,
      configRoot,
    });
    this.cacheDocument(canonicalRoot, filePath, generationId, document);
    return document;
  }

  private async recoverPending(configRoot: string): Promise<RecoveryResult> {
    try {
      await this.invalidateRoot(configRoot);
      return await this.recoverPendingGuarded(configRoot);
    } catch (error) {
      return {
        kind: 'required',
        diagnostics: [`Support recovery failed closed: ${errorMessage(error)}`],
      };
    }
  }

  private async recoverPendingGuarded(configRoot: string): Promise<RecoveryResult> {
    if (!await this.recoveryRootExists()) {
      return { kind: 'clean' };
    }
    await this.validateRecoveryBase();
    const livePath = this.liveRecoveryPath();
    const tombstonePath = this.tombstoneRecoveryPath();
    const liveExists = await this.safeRecoveryExists(livePath);
    const tombstoneExists = await this.safeRecoveryExists(tombstonePath);
    if (liveExists && tombstoneExists) {
      return {
        kind: 'required',
        diagnostics: ['Both live and tombstone support recovery markers exist.'],
      };
    }
    if (tombstoneExists) {
      return this.deleteValidatedTombstone();
    }
    if (!liveExists) {
      return { kind: 'clean' };
    }

    const liveEntries = await this.validateRecoveryDirectory(livePath, 'live');
    const journalPath = path.join(livePath, RECOVERY_JOURNAL_FILE);
    const backupPath = path.join(livePath, RECOVERY_BACKUP_FILE);
    const journalExists = liveEntries.has(RECOVERY_JOURNAL_FILE);
    const backupExists = liveEntries.has(RECOVERY_BACKUP_FILE);
    if (!journalExists && backupExists) {
      try {
        const live = await this.readFreshMaster(configRoot);
        if (live.state.kind !== 'ready') {
          return { kind: 'required', diagnostics: ['Orphan recovery backup exists and live master is not valid.'] };
        }
        return this.finalizeRecoveryDirectory();
      } catch (error) {
        return { kind: 'required', diagnostics: [`Orphan recovery backup cleanup failed: ${errorMessage(error)}`] };
      }
    }
    if (!journalExists && !backupExists) {
      return this.finalizeRecoveryDirectory();
    }
    if (!backupExists) {
      return { kind: 'required', diagnostics: ['Recovery journal exists without its exact backup.'] };
    }

    let journal: SupportRecoveryJournal;
    let backup: Buffer;
    try {
      await assertSafeRecoveryPath(this.recoveryRoot, journalPath, 'read recovery journal');
      journal = parseRecoveryJournal(await fs.readFile(journalPath, 'utf8'), this.configurationId);
      await assertSafeRecoveryPath(this.recoveryRoot, backupPath, 'read recovery backup');
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
        return await this.finalizeRecoveryDirectory();
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
      return await this.finalizeRecoveryDirectory();
    } catch (error) {
      return {
        kind: 'required',
        observedGenerationId,
        diagnostics: [`Restored source validation failed: ${errorMessage(error)}`],
      };
    }
  }

  private async prepareRecoveryJournal(
    backup: Buffer,
    beforeGenerationId: string,
    plannedAfterGenerationId: string,
    expectedUniverseGenerationId: string | undefined,
  ): Promise<void> {
    if (hash(backup) !== beforeGenerationId) {
      throw new SupportMutationError('SUPPORT_STALE_GENERATION', 'Exact backup does not match the planned generation.');
    }
    await this.ensureRecoveryRoot();
    await this.validateRecoveryBase();
    const livePath = this.liveRecoveryPath();
    if (
      await this.safeRecoveryExists(livePath)
      || await this.safeRecoveryExists(this.tombstoneRecoveryPath())
    ) {
      throw new SupportMutationError(
        'SUPPORT_MASTER_RECOVERY_REQUIRED',
        'Support recovery marker already exists.',
      );
    }
    await assertSafeRecoveryPath(this.recoveryRoot, livePath, 'create live recovery marker');
    await fs.mkdir(livePath);
    await assertSafeRecoveryPath(this.recoveryRoot, livePath, 'use live recovery marker');
    const backupPath = path.join(livePath, RECOVERY_BACKUP_FILE);
    const journalPath = path.join(livePath, RECOVERY_JOURNAL_FILE);
    const journal: SupportRecoveryJournal = {
      version: 1,
      configurationId: this.configurationId,
      targetRelativePath: SUPPORT_RELATIVE_PATH.replace(/\\/g, '/'),
      beforeGenerationId,
      plannedAfterGenerationId,
      expectedMetadataUniverseGenerationId: expectedUniverseGenerationId ?? null,
      backupFile: RECOVERY_BACKUP_FILE,
    };
    await assertSafeRecoveryPath(this.recoveryRoot, backupPath, 'write recovery backup');
    await writeNewAndSync(backupPath, backup);
    await assertSafeRecoveryPath(this.recoveryRoot, journalPath, 'write recovery journal');
    await writeNewAndSync(journalPath, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8'));
    await assertSafeRecoveryPath(this.recoveryRoot, livePath, 'sync live recovery marker');
    await this.syncDirectory(livePath);
    await this.syncDirectory(this.recoveryRoot);
  }

  private async cleanupAfterProvenNoWrite(configRoot: string): Promise<void> {
    try {
      await this.stableRead(path.join(configRoot, SUPPORT_RELATIVE_PATH));
      await this.cleanupRecoveryArtifacts(configRoot);
    } catch (error) {
      if (error instanceof RecoveryPathViolation) {
        throw error;
      }
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
    await this.invalidateRoot(configRoot);
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

  private cachedDocument(
    canonicalRoot: string,
    filePath: string,
    generationId: string,
  ): ParsedParentConfigurations | undefined {
    const rootKey = normalizePath(canonicalRoot);
    const cache = this.documentsByRoot.get(rootKey);
    if (!cache) {
      return undefined;
    }
    const key = documentCacheKey(canonicalRoot, filePath, generationId);
    const document = cache.get(key);
    if (document) {
      // Refresh insertion order so eviction behaves as a small per-root LRU.
      cache.delete(key);
      cache.set(key, document);
    }
    return document;
  }

  private cacheDocument(
    canonicalRoot: string,
    filePath: string,
    generationId: string,
    document: ParsedParentConfigurations,
  ): void {
    const rootKey = normalizePath(canonicalRoot);
    const cache = this.documentsByRoot.get(rootKey) ?? new Map<string, ParsedParentConfigurations>();
    const key = documentCacheKey(canonicalRoot, filePath, generationId);
    cache.delete(key);
    cache.set(key, document);
    while (cache.size > MAX_CACHED_GENERATIONS_PER_ROOT) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
    this.documentsByRoot.set(rootKey, cache);
  }

  private async invalidateRoot(configRoot: string): Promise<void> {
    const canonicalRoot = await canonicalConfigRoot(configRoot);
    this.documentsByRoot.delete(normalizePath(canonicalRoot));
  }

  private liveRecoveryPath(): string {
    return path.join(this.recoveryRoot, RECOVERY_LIVE_DIRECTORY);
  }

  private tombstoneRecoveryPath(): string {
    return path.join(this.recoveryRoot, RECOVERY_TOMBSTONE_DIRECTORY);
  }

  private async recoveryRootExists(): Promise<boolean> {
    try {
      const stat = await fs.lstat(this.recoveryRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new RecoveryPathViolation(
          'inspect recovery root',
          `recovery root is not a trusted directory: ${this.recoveryRoot}`,
        );
      }
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  private async ensureRecoveryRoot(): Promise<void> {
    await fs.mkdir(this.recoveryRoot, { recursive: true });
    if (!await this.recoveryRootExists()) {
      throw new RecoveryPathViolation('create recovery root', 'recovery root was not created');
    }
  }

  private async safeRecoveryExists(filePath: string): Promise<boolean> {
    await assertSafeRecoveryPath(this.recoveryRoot, filePath, 'inspect recovery artifact');
    try {
      await fs.lstat(filePath);
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  private async validateRecoveryBase(): Promise<void> {
    await assertSafeRecoveryPath(this.recoveryRoot, this.recoveryRoot, 'inspect recovery namespace');
    const entries = await fs.readdir(this.recoveryRoot);
    const allowed = new Set([RECOVERY_LIVE_DIRECTORY, RECOVERY_TOMBSTONE_DIRECTORY]);
    const foreign = entries.filter((entry) => !allowed.has(entry));
    if (foreign.length > 0) {
      throw new RecoveryPathViolation(
        'inspect recovery namespace',
        `foreign entries exist: ${foreign.join(', ')}`,
      );
    }
  }

  private async validateRecoveryDirectory(
    directoryPath: string,
    marker: 'live' | 'tombstone',
  ): Promise<ReadonlySet<string>> {
    await assertSafeRecoveryPath(this.recoveryRoot, directoryPath, `validate ${marker} recovery marker`);
    const directoryStat = await fs.lstat(directoryPath);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new RecoveryPathViolation(
        `validate ${marker} recovery marker`,
        `${directoryPath} is not a plain directory`,
      );
    }
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    const allowed = new Set([RECOVERY_JOURNAL_FILE, RECOVERY_BACKUP_FILE]);
    for (const entry of entries) {
      if (!allowed.has(entry.name) || !entry.isFile()) {
        throw new RecoveryPathViolation(
          `validate ${marker} recovery marker`,
          `foreign entry exists: ${entry.name}`,
        );
      }
      await assertSafeRecoveryPath(
        this.recoveryRoot,
        path.join(directoryPath, entry.name),
        `validate ${marker} recovery evidence`,
      );
    }
    return new Set(entries.map((entry) => entry.name));
  }

  private async hasRecoveryArtifacts(): Promise<boolean> {
    try {
      if (!await this.recoveryRootExists()) {
        return false;
      }
      await this.validateRecoveryBase();
      return await this.safeRecoveryExists(this.liveRecoveryPath())
        || await this.safeRecoveryExists(this.tombstoneRecoveryPath());
    } catch {
      // Any invalid namespace must enter the exclusive fail-closed recovery path.
      return true;
    }
  }

  private async finalizeRecoveryDirectory(): Promise<RecoveryResult> {
    await this.validateRecoveryBase();
    const livePath = this.liveRecoveryPath();
    const tombstonePath = this.tombstoneRecoveryPath();
    await this.validateRecoveryDirectory(livePath, 'live');
    if (await this.safeRecoveryExists(tombstonePath)) {
      return {
        kind: 'required',
        diagnostics: ['Tombstone marker already exists before recovery finalization.'],
      };
    }
    try {
      await assertSafeRecoveryPath(this.recoveryRoot, livePath, 'rename live recovery marker');
      await assertSafeRecoveryPath(this.recoveryRoot, tombstonePath, 'create recovery tombstone marker');
      await fs.rename(livePath, tombstonePath);
    } catch (error) {
      const liveExists = await this.safeRecoveryExists(livePath);
      const tombstoneExists = await this.safeRecoveryExists(tombstonePath);
      if (liveExists || !tombstoneExists) {
        return {
          kind: 'required',
          diagnostics: [`Recovery marker rename failed: ${errorMessage(error)}`],
        };
      }
    }
    return this.deleteValidatedTombstone();
  }

  private async deleteValidatedTombstone(): Promise<RecoveryResult> {
    const tombstonePath = this.tombstoneRecoveryPath();
    try {
      await this.validateRecoveryBase();
      await this.validateRecoveryDirectory(tombstonePath, 'tombstone');
      await assertSafeRecoveryPath(this.recoveryRoot, tombstonePath, 'delete recovery tombstone');
      await fs.rm(tombstonePath, { recursive: true });
      return { kind: 'recovered' };
    } catch (error) {
      let markerExists = true;
      try {
        markerExists = await this.safeRecoveryExists(tombstonePath);
      } catch {
        // An unreadable marker remains fail-closed.
      }
      if (!markerExists) {
        return { kind: 'recovered' };
      }
      return {
        kind: 'required',
        diagnostics: [`Recovery tombstone cleanup failed: ${errorMessage(error)}`],
      };
    }
  }

  private async cleanupRecoveryArtifacts(configRoot: string): Promise<void> {
    await this.invalidateRoot(configRoot);
    const cleanup = await this.finalizeRecoveryDirectory();
    this.throwIfRecoveryRequired(cleanup);
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

async function canonicalConfigRoot(configRoot: string): Promise<string> {
  return path.resolve(await fs.realpath(path.resolve(configRoot)));
}

function documentCacheKey(configRoot: string, filePath: string, generationId: string): string {
  return `${normalizePath(configRoot)}\0${normalizePath(filePath)}\0${generationId}`;
}

class RecoveryPathViolation extends SupportMutationError {
  constructor(operation: string, detail: string) {
    super(
      'SUPPORT_MASTER_RECOVERY_REQUIRED',
      `Unsafe support recovery path during ${operation}: ${detail}. Recovery evidence was preserved.`,
    );
    this.name = 'RecoveryPathViolation';
  }
}

async function assertSafeRecoveryPath(
  configRoot: string,
  targetPath: string,
  operation: string,
): Promise<void> {
  const canonicalRoot = path.resolve(await fs.realpath(path.resolve(configRoot)));
  const resolvedTarget = path.resolve(targetPath);
  if (!isContainedPath(path.resolve(configRoot), resolvedTarget)) {
    throw new RecoveryPathViolation(operation, 'target escapes the configuration root');
  }

  const relative = path.relative(path.resolve(configRoot), resolvedTarget);
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = canonicalRoot;
  await assertExistingComponentSafe(canonicalRoot, current, operation);
  for (const component of components) {
    current = path.join(current, component);
    try {
      await assertExistingComponentSafe(canonicalRoot, current, operation);
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
  }
}

async function assertExistingComponentSafe(
  canonicalRoot: string,
  componentPath: string,
  operation: string,
): Promise<void> {
  const stat = await fs.lstat(componentPath);
  if (stat.isSymbolicLink()) {
    throw new RecoveryPathViolation(operation, `link or reparse component ${componentPath}`);
  }
  const realComponent = path.resolve(await fs.realpath(componentPath));
  if (!isContainedPath(canonicalRoot, realComponent)) {
    throw new RecoveryPathViolation(operation, `component resolves outside the configuration root: ${componentPath}`);
  }
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
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
