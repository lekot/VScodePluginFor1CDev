import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  assertJournalNamespace,
  assertLexicallyInside,
  assertNoSymlinkSegments,
  assertPathWithinRoot,
  isPathInside,
  isSamePath,
  PathBoundaryError,
} from './pathBoundary';
import { hashContent } from './atomicFileStorage';
import { Logger } from '../../utils/logger';
import { filesystemErrorCode, logCleanupFailure } from './journalCleanupDiagnostics';
import type { RootLeaseCleanupFailure } from './journalCleanupDiagnostics';
import { assertValidRollbackAppliedSteps } from './rollbackJournalBoundary';
import {
  assertRootLeaseOwned,
  cleanupCurrentRootLeaseHeartbeatTemps,
  cleanupStaleRootLeaseHeartbeats,
  ensureRootLeaseQuarantineClear,
  isProcessAlive,
  LEASE_HEARTBEAT_INTERVAL_MS,
  LEASE_TTL_MS,
  MutationPlanError,
  parseRootLeaseRecord,
  readRootLeaseHeartbeat,
  removeRootLeaseIfUnchanged,
  ROOT_LEASE_FILE,
  rootLeaseHeartbeatPath,
  RootLeaseOwnershipError,
  type RootLeaseRecord,
  writeRootLeaseHeartbeat,
} from './rootLease';
export { MutationPlanError } from './rootLease';

export type MutationExpectation =
  | { readonly state: 'missing' }
  | { readonly state: 'file'; readonly hash: string }
  | { readonly state: 'directory'; readonly fingerprint?: string };

export type MutationStep =
  | {
      readonly type: 'assertFile';
      readonly targetPath: string;
      readonly expected: { readonly state: 'file'; readonly hash: string };
    }
  | {
      readonly type: 'assertDirectory';
      readonly targetPath: string;
      readonly expected:
        | { readonly state: 'missing' }
        | { readonly state: 'directory'; readonly fingerprint: string };
    }
  | {
      readonly type: 'writeFile';
      readonly targetPath: string;
      readonly content: string;
      readonly encoding: 'utf8' | 'base64';
      readonly expected: MutationExpectation;
    }
  | { readonly type: 'ensureDirectory'; readonly targetPath: string }
  | { readonly type: 'deletePath'; readonly targetPath: string; readonly expected: MutationExpectation }
  | {
      readonly type: 'movePath';
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly sourceExpected: MutationExpectation;
      readonly targetExpected: MutationExpectation;
    };

export type DirectoryFingerprintEntry =
  | { readonly name: string; readonly type: 'file'; readonly hash: string }
  | { readonly name: string; readonly type: 'directory'; readonly fingerprint: string };

export function calculateDirectoryFingerprintFromEntries(
  entries: readonly DirectoryFingerprintEntry[],
): string {
  const hashes = [...entries]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => entry.type === 'file'
      ? `F:${entry.name}:${entry.hash}`
      : `D:${entry.name}:${entry.fingerprint}`);
  return hashContent(Buffer.from(hashes.join('\n'), 'utf8'));
}

export function isReadOnlyAssertionStep(
  step: MutationStep,
): step is Extract<MutationStep, { readonly type: 'assertFile' | 'assertDirectory' }> {
  return step.type === 'assertFile' || step.type === 'assertDirectory';
}

export interface MutationPlan<T> {
  readonly kind: string;
  readonly steps: readonly MutationStep[];
  readonly result: T;
}

interface PathSnapshot {
  readonly targetPath: string;
  readonly state: MutationExpectation['state'];
  readonly hash?: string;
  readonly fingerprint?: string;
  readonly backupName?: string;
  readonly contentsBackedUp: boolean;
}

interface MutationJournal<T = unknown> {
  readonly version: 1;
  readonly operationId: string;
  readonly plan: MutationPlan<T>;
  state: 'prepared' | 'applying' | 'rollback-required' | 'committed';
  appliedSteps: number;
  rollbackAppliedSteps?: number;
  readonly snapshots: readonly PathSnapshot[];
}

export interface OperationOwner {
  readonly pid: number;
  readonly createdAt: number;
  readonly heartbeatAt?: number;
  readonly leaseId?: string;
}

interface ActiveRootLease {
  leaseId: string;
  assertOwned(): Promise<void>;
  release(): Promise<RootLeaseCleanupOutcome>;
}

interface RootLeaseCleanupOutcome {
  readonly failures: readonly RootLeaseCleanupFailure[];
}

class AmbiguousMutationEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousMutationEffectError';
  }
}

/** Executes serializable filesystem plans with a write-ahead journal and reverse recovery. */
export class MutationPlanExecutor {
  private journalRoot: string;

  constructor(private readonly rootPath: string) {
    this.journalRoot = path.join(rootPath, '.cdt-journal');
  }

  async execute<T>(plan: MutationPlan<T>, operationId: string = randomUUID()): Promise<T> {
    const release = await acquirePlanMutationLock(this.rootPath);
    try {
      const lease = await this.acquireRootLease(operationId);
      try {
        return await this.executeLocked(plan, operationId, lease);
      } finally {
        await lease.release();
      }
    } finally {
      release();
    }
  }

  private async acquireRootLease(operationId: string): Promise<ActiveRootLease> {
    await assertJournalNamespace(this.rootPath);

    try {
      await fs.promises.mkdir(this.journalRoot, { recursive: false });
    } catch (mkdirError) {
      if (!isAlreadyExistsError(mkdirError)) {
        throw mkdirError;
      }
    }
    await assertJournalNamespace(this.rootPath);

    const leasePath = path.join(this.journalRoot, ROOT_LEASE_FILE);
    const leaseId = randomUUID();
    const heartbeatPath = rootLeaseHeartbeatPath(this.journalRoot, leaseId);

    await ensureRootLeaseQuarantineClear(this.journalRoot);

    const tryAcquire = async (): Promise<boolean> => {
      const now = Date.now();
      const record: RootLeaseRecord = {
        leaseId,
        pid: process.pid,
        createdAt: now,
        heartbeatAt: now,
        operationId,
      };
      try {
        await fs.promises.writeFile(leasePath, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
          return false;
        }
        throw err;
      }
      try {
        await ensureRootLeaseQuarantineClear(this.journalRoot);
      } catch (error) {
        const leaseLifecycle = {
          leaseId,
          processId: process.pid,
          state: 'acquisition-aborted',
          heartbeatStarted: false,
        } as const;
        try {
          const removed = await removeRootLeaseIfUnchanged(leasePath, leaseId);
          if (!removed) {
            await logCleanupFailure(
              this.rootPath,
              this.journalRoot,
              'root-lease-acquisition-cleanup',
              new Error('Acquired root lease was no longer present during cleanup.'),
              leasePath,
              leaseLifecycle,
            );
          }
        } catch (cleanupError) {
          await logCleanupFailure(
            this.rootPath,
            this.journalRoot,
            'root-lease-acquisition-cleanup',
            cleanupError,
            leasePath,
            leaseLifecycle,
          );
        }
        try {
          await fs.promises.rm(heartbeatPath, { force: true });
        } catch (cleanupError) {
          await logCleanupFailure(
            this.rootPath,
            this.journalRoot,
            'root-lease-heartbeat-remove',
            cleanupError,
            heartbeatPath,
            leaseLifecycle,
          );
        }
        throw error;
      }
      return true;
    };

    let acquired = await tryAcquire();
    if (!acquired) {
      let existingRecord: RootLeaseRecord | undefined;
      try {
        const raw = await fs.promises.readFile(leasePath, 'utf8');
        existingRecord = parseRootLeaseRecord(raw);
      } catch (err) {
        if (isMissingError(err)) {
          acquired = await tryAcquire();
        } else {
          throw new MutationPlanError(
            'PLAN_CONFLICT',
            `Cannot inspect configuration root lease: ${errorMessage(err)}`,
          );
        }
      }

      if (!acquired && existingRecord) {
        const existingHeartbeatPath = rootLeaseHeartbeatPath(this.journalRoot, existingRecord.leaseId);
        const lastHeartbeat = await readRootLeaseHeartbeat(existingHeartbeatPath, existingRecord);
        const isHolderAlive = isProcessAlive(existingRecord.pid);
        const isHeartbeatFresh = Date.now() - lastHeartbeat <= LEASE_TTL_MS;

        if (isHolderAlive && isHeartbeatFresh) {
          throw new MutationPlanError(
            'PLAN_CONFLICT',
            `Configuration is actively locked by process ${existingRecord.pid}.`,
          );
        }

        const removed = await removeRootLeaseIfUnchanged(leasePath, existingRecord.leaseId);
        if (!removed) {
          throw new MutationPlanError(
            'PLAN_CONFLICT',
            'Configuration root lease changed while attempting stale lease takeover.',
          );
        }
        try {
          await fs.promises.rm(existingHeartbeatPath, { force: true });
        } catch (cleanupError) {
          await logCleanupFailure(
            this.rootPath,
            this.journalRoot,
            'stale-root-lease-heartbeat-remove',
            cleanupError,
            existingHeartbeatPath,
            {
              leaseId: existingRecord.leaseId,
              processId: existingRecord.pid,
              createdAt: existingRecord.createdAt,
              heartbeatAt: lastHeartbeat,
              state: 'stale-takeover',
            },
          );
        }
        acquired = await tryAcquire();
        if (!acquired) {
          throw new MutationPlanError(
            'PLAN_CONFLICT',
            'Configuration root lease acquisition conflict after breaking stale lease.',
          );
        }
      }
    }

    if (!acquired) {
      throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease acquisition conflict.');
    }

    let released = false;
    const cleanupFailures: RootLeaseCleanupFailure[] = [];
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeatTimer = setInterval(() => {
      if (released || heartbeatInFlight) { return; }
      heartbeatInFlight = (async () => {
        await assertRootLeaseOwned(leasePath, this.journalRoot, leaseId);
        await writeRootLeaseHeartbeat(heartbeatPath, leaseId, Date.now());
      })().catch(async (error: unknown) => {
        await logCleanupFailure(
          this.rootPath,
          this.journalRoot,
          'root-lease-heartbeat-write',
          error,
          heartbeatPath,
          {
            leaseId,
            processId: process.pid,
            state: 'active',
            heartbeatInFlight: true,
          },
        );
      }).finally(() => {
        heartbeatInFlight = undefined;
      });
    }, LEASE_HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }

    const assertOwned = async (): Promise<void> => {
      if (released) {
        throw new RootLeaseOwnershipError('Configuration root lease ownership was lost.');
      }
      await assertRootLeaseOwned(leasePath, this.journalRoot, leaseId);
    };

    const release = async (): Promise<RootLeaseCleanupOutcome> => {
      if (released) { return { failures: cleanupFailures }; }
      released = true;
      clearInterval(heartbeatTimer);
      await heartbeatInFlight?.catch(async (error: unknown) => {
        await logCleanupFailure(
          this.rootPath,
          this.journalRoot,
          'root-lease-heartbeat-wait',
          error,
          heartbeatPath,
          { leaseId, processId: process.pid, state: 'releasing', heartbeatStopped: true },
        );
      });
      const report = async (stage: string, error: unknown, targetPath: string): Promise<RootLeaseCleanupFailure> => {
        try {
          return await logCleanupFailure(
            this.rootPath,
            this.journalRoot,
            stage,
            error,
            targetPath,
            {
              leaseId,
              processId: process.pid,
              state: 'releasing',
              heartbeatStopped: true,
              heartbeatInFlight: false,
            },
          );
        } catch {
          return { stage, fsCode: filesystemErrorCode(error) };
        }
      };
      let ownershipVerified = false;
      let ownershipLost = false;
      try {
        await assertRootLeaseOwned(leasePath, this.journalRoot, leaseId);
        ownershipVerified = true;
        const heartbeatTempIssues = await cleanupCurrentRootLeaseHeartbeatTemps(
          this.rootPath,
          this.journalRoot,
          leaseId,
          async () => assertRootLeaseOwned(leasePath, this.journalRoot, leaseId),
        );
        let ownershipCheckFailed = false;
        for (const issue of heartbeatTempIssues) {
          const failure = await report('root-lease-heartbeat-temp-cleanup', issue.error, issue.targetPath);
          const issueIsOwnershipError = issue.error instanceof RootLeaseOwnershipError;
          if (!issueIsOwnershipError || issue.error.reason !== 'lost') {
            cleanupFailures.push(failure);
          }
          if (issueIsOwnershipError) {
            ownershipLost = issue.error.reason === 'lost';
            ownershipVerified = false;
            ownershipCheckFailed = true;
            break;
          }
        }
        if (!ownershipCheckFailed) {
          const removed = await removeRootLeaseIfUnchanged(leasePath, leaseId);
          if (!removed) {
            ownershipLost = true;
            ownershipVerified = false;
            await report(
              'root-lease-release',
              new Error('Root lease was replaced or removed before release completed.'),
              leasePath,
            );
          }
        }
      } catch (error) {
        const failure = await report('root-lease-release', error, leasePath);
        ownershipLost = error instanceof RootLeaseOwnershipError && error.reason === 'lost';
        if (error instanceof RootLeaseOwnershipError) { ownershipVerified = false; }
        if (!ownershipLost) {
          cleanupFailures.push(failure);
        }
      }
      if (ownershipVerified && !ownershipLost) {
        try {
          await fs.promises.rm(heartbeatPath, { force: true });
        } catch (error) {
          cleanupFailures.push(await report('root-lease-heartbeat-remove', error, heartbeatPath));
        }
      }
      try {
        await this.removeJournalRootWhenEmpty();
      } catch (error) {
        if (!isNotEmptyError(error)) {
          cleanupFailures.push(await report('journal-root-removal', error, this.journalRoot));
        }
      }
      return { failures: cleanupFailures };
    };

    return { leaseId, assertOwned, release };
  }

  private async removeOperationDir(operationPath: string): Promise<void> {
    assertLexicallyInside(this.journalRoot, operationPath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(operationPath);
    } catch (error) {
      if (isMissingError(error)) {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new PathBoundaryError(
        'PATH_OUTSIDE_ROOT',
        `Refusing to remove symbolic link operation directory: ${operationPath}`,
        operationPath,
      );
    }
    const { canonicalJournalRoot } = await assertJournalNamespace(this.rootPath);
    const canonicalTarget = await fs.promises.realpath(operationPath);
    if (!isPathInside(canonicalJournalRoot, canonicalTarget)) {
      throw new PathBoundaryError(
        'PATH_OUTSIDE_ROOT',
        `Operation directory escapes journal root: ${operationPath}`,
        operationPath,
      );
    }
    await fs.promises.rm(operationPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  private async executeLocked<T>(plan: MutationPlan<T>, operationId: string, lease: ActiveRootLease): Promise<T> {
    if (
      !operationId ||
      path.basename(operationId) !== operationId ||
      operationId.startsWith('.') ||
      operationId.includes('/') ||
      operationId.includes('\\')
    ) {
      throw new MutationPlanError('PLAN_CONFLICT', `Invalid or unsafe operationId: "${operationId}"`);
    }

    await lease.assertOwned();
    await this.recoverLocked(lease);
    const operationPath = path.join(this.journalRoot, operationId);
    await this.validatePlanPaths(plan);
    let snapshots: PathSnapshot[];
    let journal: MutationJournal<T>;
    const stagingPath = path.join(this.journalRoot, `.prep-${operationId}-${randomUUID()}`);
    let isPublished = false;
    try {
      await fs.promises.mkdir(stagingPath, { recursive: true });
      const owner: OperationOwner = {
        pid: process.pid,
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
        leaseId: lease.leaseId,
      };
      await fs.promises.writeFile(
        path.join(stagingPath, 'owner.json'),
        JSON.stringify(owner),
        { encoding: 'utf8', flag: 'wx' },
      );
      await fs.promises.rename(stagingPath, operationPath);
      isPublished = true;

      await fs.promises.mkdir(path.join(operationPath, 'backups'), { recursive: true });
      snapshots = await this.captureSnapshots(plan, operationPath);
      await this.validatePlan(plan, snapshots);
      journal = {
        version: 1,
        operationId,
        plan,
        state: 'prepared',
        appliedSteps: 0,
        snapshots,
      };
      await this.writeJournal(operationPath, journal);
    } catch (prepError) {
      await this.removeOperationDir(stagingPath).catch(() => undefined);
      if (isPublished) {
        await this.removeOperationDir(operationPath).catch((err) => {
          Logger.warn(`Failed to clean up preparation directory: ${operationPath}`, err);
        });
      }
      throw prepError;
    }

    try {
      journal.state = 'applying';
      await this.writeJournal(operationPath, journal);
      for (let index = 0; index < plan.steps.length; index++) {
        await lease.assertOwned();
        await this.applyStep(plan.steps[index]!);
        journal.appliedSteps = index + 1;
        await this.writeJournal(operationPath, journal);
      }
      await lease.assertOwned();
      journal.state = 'committed';
      await this.writeJournal(operationPath, journal);
      // Commit is durable; cleanup is best-effort and recovery will remove a committed journal.
      try {
        await this.removeOperationDir(operationPath);
      } catch (cleanupError) {
        await logCleanupFailure(
          this.rootPath,
          this.journalRoot,
          'committed-operation-directory',
          cleanupError,
          operationPath,
          { leaseId: lease.leaseId, processId: process.pid, state: 'committed', heartbeatStopped: false },
        );
      }
      return plan.result;
    } catch (error) {
      const leaseWasLost = error instanceof RootLeaseOwnershipError;
      if (leaseWasLost) {
        throw new MutationPlanError(
          'RECOVERY_REQUIRED',
          `Mutation stopped after root lease ownership changed: ${errorMessage(error)}`,
        );
      }
      journal.state = 'rollback-required';
      const isPreEffectConflict =
        (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT')
        || error instanceof PathBoundaryError;
      if (isPreEffectConflict) {
        journal.rollbackAppliedSteps = journal.appliedSteps;
      } else {
        delete journal.rollbackAppliedSteps;
      }
      await this.writeJournal(operationPath, journal).catch(() => undefined);

      if (error instanceof AmbiguousMutationEffectError) {
        throw new MutationPlanError(
          'RECOVERY_REQUIRED',
          `Mutation outcome is ambiguous and requires recovery: ${errorMessage(error)}`,
        );
      }

      const snapshotsToRestore = isPreEffectConflict
        ? snapshotsForAppliedSteps(plan, snapshots, journal.appliedSteps)
        : snapshots;
      try {
        await this.restoreSnapshots(
          operationPath,
          snapshotsToRestore,
          plan,
          journal.appliedSteps,
          isPreEffectConflict,
        );
        await this.removeOperationDir(operationPath);
      } catch (rollbackError) {
        throw new MutationPlanError(
          'RECOVERY_REQUIRED',
          `Mutation failed and rollback is incomplete: ${errorMessage(error)}; ${errorMessage(rollbackError)}`,
        );
      }
      if (
        (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT')
        || error instanceof PathBoundaryError
      ) {
        throw error;
      }
      throw new MutationPlanError('PLAN_FAILED', `Mutation was rolled back: ${errorMessage(error)}`);
    }
  }

  async recover(): Promise<void> {
    const release = await acquirePlanMutationLock(this.rootPath);
    try {
      const lease = await this.acquireRootLease('recovery');
      let recoveryFailed = false;
      let recoveryError: unknown;
      try {
        await lease.assertOwned();
        await this.recoverLocked(lease);
      } catch (error) {
        recoveryFailed = true;
        recoveryError = error;
      }

      let cleanupOutcome: RootLeaseCleanupOutcome = { failures: [] };
      try {
        cleanupOutcome = await lease.release();
      } catch (error) {
        const failure = await logCleanupFailure(
          this.rootPath,
          this.journalRoot,
          'root-lease-release',
          error,
          path.join(this.journalRoot, ROOT_LEASE_FILE),
          { leaseId: lease.leaseId, processId: process.pid, state: 'releasing' },
        );
        cleanupOutcome = { failures: [failure] };
      }

      if (recoveryFailed) {
        throw recoveryError;
      }
      if (cleanupOutcome.failures.length > 0) {
        const stages = [...new Set(cleanupOutcome.failures.map((failure) => failure.stage))];
        const fsCodes = [...new Set(cleanupOutcome.failures
          .map((failure) => failure.fsCode)
          .filter((code): code is string => code !== undefined))];
        const detail = [stages.join(', '), fsCodes.length > 0 ? fsCodes.join(', ') : undefined]
          .filter((value): value is string => value !== undefined)
          .join(' (');
        throw new MutationPlanError(
          'RECOVERY_REQUIRED',
          `Recovery completed with incomplete root journal cleanup: ${detail}${fsCodes.length > 0 ? ')' : ''}.`,
        );
      }
    } finally {
      release();
    }
  }

  private async recoverLocked(lease: ActiveRootLease): Promise<void> {
    const { canonicalJournalRoot } = await assertJournalNamespace(this.rootPath);
    await lease.assertOwned();
    await cleanupStaleRootLeaseHeartbeats(
      this.rootPath,
      this.journalRoot,
      lease.leaseId,
      () => lease.assertOwned(),
    );
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.journalRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingError(error)) {
        return;
      }
      throw new MutationPlanError('RECOVERY_REQUIRED', errorMessage(error));
    }
    for (const entry of entries) {
      if (entry.name === ROOT_LEASE_FILE || entry.name.startsWith(ROOT_LEASE_FILE)) {
        continue;
      }
      if (entry.name.startsWith('.journal-') && entry.name.endsWith('.tmp')) {
        continue;
      }

      const operationPath = path.join(this.journalRoot, entry.name);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(operationPath);
      } catch (error) {
        if (isMissingError(error)) {
          continue;
        }
        throw new MutationPlanError('RECOVERY_REQUIRED', errorMessage(error));
      }

      if (stat.isSymbolicLink()) {
        throw new MutationPlanError(
          'RECOVERY_REQUIRED',
          `Forbidden symbolic link in journal directory: "${entry.name}"`,
        );
      }

      if (!stat.isDirectory()) {
        continue;
      }

      const canonicalOp = await fs.promises.realpath(operationPath);
      const expectedCanonicalOp = path.join(canonicalJournalRoot, entry.name);
      if (!isSamePath(canonicalOp, expectedCanonicalOp)) {
        throw new PathBoundaryError(
          'PATH_OUTSIDE_ROOT',
          `Operation path escapes journal root: ${operationPath}`,
          operationPath,
        );
      }

      const isStaging = entry.name.startsWith('.prep-');
      const isNormalOp = !entry.name.startsWith('.')
        && path.basename(entry.name) === entry.name
        && !entry.name.includes('/')
        && !entry.name.includes('\\');

      if (!isStaging && !isNormalOp) {
        throw new MutationPlanError(
          'RECOVERY_REQUIRED',
          `Unrecognized directory in journal: "${entry.name}"`,
        );
      }

      let opEntries: string[];
      try {
        opEntries = await fs.promises.readdir(operationPath);
      } catch (opReadError) {
        throw new MutationPlanError(
          'RECOVERY_REQUIRED',
          `Cannot read operation directory "${entry.name}": ${errorMessage(opReadError)}`,
        );
      }
      const hasAlienFiles = opEntries.some((name) =>
        name !== 'owner.json' && name !== 'journal.json' && name !== 'backups' && !(name.startsWith('.journal-') && name.endsWith('.tmp'))
      );
      if (hasAlienFiles) {
        throw new MutationPlanError(
          'RECOVERY_REQUIRED',
          `Operation directory contains unrecognized files: "${entry.name}"`,
        );
      }

      if (opEntries.includes('backups')) {
        const backupsPath = path.join(operationPath, 'backups');
        let backupStat: fs.Stats;
        try {
          backupStat = await fs.promises.lstat(backupsPath);
        } catch (backupStatError) {
          throw new MutationPlanError(
            'RECOVERY_REQUIRED',
            `Cannot stat backups directory in "${entry.name}": ${errorMessage(backupStatError)}`,
          );
        }
        if (backupStat.isSymbolicLink() || !backupStat.isDirectory()) {
          throw new MutationPlanError(
            'RECOVERY_REQUIRED',
            `Invalid backups entry in "${entry.name}"`,
          );
        }
        let backupEntries: string[];
        try {
          backupEntries = await fs.promises.readdir(backupsPath);
        } catch (backupReadError) {
          throw new MutationPlanError(
            'RECOVERY_REQUIRED',
            `Cannot read backups directory in "${entry.name}": ${errorMessage(backupReadError)}`,
          );
        }
        for (const backupName of backupEntries) {
          if (!/^\d+$/.test(backupName)) {
            throw new MutationPlanError(
              'RECOVERY_REQUIRED',
              `Operation backups directory contains unrecognized non-numeric entry: "${entry.name}/${backupName}"`,
            );
          }
          await assertSafeBackupEntry(path.join(backupsPath, backupName), canonicalJournalRoot);
        }
      }

      const hasOwnerFile = opEntries.includes('owner.json');
      const hasJournalFile = opEntries.includes('journal.json');
      const hasTempJournal = opEntries.some((name) => name.startsWith('.journal-') && name.endsWith('.tmp'));
      const isCdtOwned = isStaging || hasOwnerFile || hasJournalFile || hasTempJournal;
      if (!isCdtOwned) {
        throw new MutationPlanError(
          'RECOVERY_REQUIRED',
          `Unrecognized non-CDT directory in journal: "${entry.name}"`,
        );
      }

      await lease.assertOwned();

      let owner: OperationOwner | undefined;
      try {
        const ownerRaw = await fs.promises.readFile(path.join(operationPath, 'owner.json'), 'utf8');
        const parsed = JSON.parse(ownerRaw) as Partial<OperationOwner>;
        if (typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid)) {
          owner = {
            pid: parsed.pid,
            createdAt: Number(parsed.createdAt) || 0,
            heartbeatAt: typeof parsed.heartbeatAt === 'number' ? parsed.heartbeatAt : undefined,
            leaseId: typeof parsed.leaseId === 'string' ? parsed.leaseId : undefined,
          };
        } else {
          throw new Error('Invalid owner metadata in owner.json.');
        }
      } catch (ownerError) {
        if (!isMissingError(ownerError)) {
          throw new MutationPlanError(
            'RECOVERY_REQUIRED',
            `Cannot recover mutation journal ${entry.name}: ${errorMessage(ownerError)}`,
          );
        }
      }

      let journalRaw: string | undefined;
      let journalMissing = false;
      try {
        journalRaw = await fs.promises.readFile(path.join(operationPath, 'journal.json'), 'utf8');
      } catch (readError) {
        if (isMissingError(readError)) {
          journalMissing = true;
        } else {
          throw new MutationPlanError(
            'RECOVERY_REQUIRED',
            `Cannot recover mutation journal ${entry.name}: ${errorMessage(readError)}`,
          );
        }
      }

      if (journalRaw !== undefined) {
        let journal: MutationJournal;
        try {
          journal = JSON.parse(journalRaw) as MutationJournal;
          if (journal.version !== 1 || !Array.isArray(journal.snapshots)) {
            throw new Error('Unsupported or corrupt mutation journal.');
          }
          assertValidRollbackAppliedSteps(journal);
        } catch (error) {
          throw new MutationPlanError(
            'RECOVERY_REQUIRED',
            `Cannot recover mutation journal ${entry.name}: ${errorMessage(error)}`,
          );
        }

        // Durable commit: all changes are safe and permanent.
        // It is completely safe to clean up even if owner process PID is still alive.
        if (journal.state === 'committed') {
          try {
            await lease.assertOwned();
            await this.removeOperationDir(operationPath);
          } catch (cleanupError) {
            await logCleanupFailure(
              this.rootPath,
              this.journalRoot,
              'committed-operation-directory',
              cleanupError,
              operationPath,
              { leaseId: lease.leaseId, processId: process.pid, state: 'committed', heartbeatStopped: false },
            );
          }
          continue;
        }

        // #183: Rollback was explicitly required after an error.
        // It must be restored and removed rather than blocking with PLAN_CONFLICT.
        if (journal.state === 'rollback-required') {
          await lease.assertOwned();
          const hasKnownRollbackPrefix = typeof journal.rollbackAppliedSteps === 'number';
          const snapshotsToRestore = hasKnownRollbackPrefix
            ? snapshotsForAppliedSteps(journal.plan, journal.snapshots, journal.rollbackAppliedSteps!)
            : journal.snapshots;
          await this.restoreSnapshots(
            operationPath,
            snapshotsToRestore,
            journal.plan,
            hasKnownRollbackPrefix ? journal.rollbackAppliedSteps : journal.appliedSteps,
            hasKnownRollbackPrefix,
          );
          await lease.assertOwned();
          await this.removeOperationDir(operationPath);
          continue;
        }

        // Uncommitted journal (prepared or applying):
        // If owner process is alive AND its heartbeat is fresh (if tracked), fail-closed against concurrent mutations.
        // If heartbeat is expired, treat as stale/reused PID (#212) and recover.
        if (isOwnerActivelyRunning(owner)) {
          throw new MutationPlanError(
            'PLAN_CONFLICT',
            `Operation "${entry.name}" is actively in progress by process ${owner!.pid}.`,
          );
        }

        // Owner process is terminated/absent or stale: rollback interrupted plan.
        await lease.assertOwned();
        await this.restoreSnapshots(operationPath, journal.snapshots, journal.plan, journal.appliedSteps);
        await lease.assertOwned();
        await this.removeOperationDir(operationPath);
        continue;
      }

      if (journalMissing) {
        // If owner is alive and heartbeat is fresh (if tracked), the operation is actively in preparation! Fail-closed.
        if (isOwnerActivelyRunning(owner)) {
          throw new MutationPlanError(
            'PLAN_CONFLICT',
            `Operation "${entry.name}" is actively in progress by process ${owner!.pid}.`,
          );
        }

        // If staging directory without owner is recent, another process might be initializing it! Fail-closed.
        if (owner === undefined && isStaging) {
          try {
            const stat = await fs.promises.stat(operationPath);
            const ageMs = Date.now() - stat.mtimeMs;
            if (ageMs < 5000) {
              throw new MutationPlanError(
                'PLAN_CONFLICT',
                `Operation "${entry.name}" is actively being prepared.`,
              );
            }
          } catch (statError) {
            if (statError instanceof MutationPlanError) {
              throw statError;
            }
          }
        }

        // Pre-effect orphan operation directory has no applied mutation steps.
        await lease.assertOwned();
        try {
          await this.removeOperationDir(operationPath);
          const ownerInfo = owner ? ` from terminated process ${owner.pid}` : '';
          Logger.info(`Removed orphan mutation journal dir${ownerInfo} without journal.json: ${entry.name}`);
        } catch (error) {
          await logCleanupFailure(
            this.rootPath,
            this.journalRoot,
            'orphan-operation-directory',
            error,
            operationPath,
            { leaseId: lease.leaseId, processId: process.pid, state: 'recovering', heartbeatStopped: false },
          );
          throw new MutationPlanError(
            'RECOVERY_REQUIRED',
            `Cannot remove orphan mutation journal directory "${entry.name}": ${errorMessage(error)}`,
          );
        }
        continue;
      }
    }
    await lease.assertOwned();
  }

  private async validatePlanPaths(plan: MutationPlan<unknown>): Promise<void> {
    if (!plan.kind.trim() || plan.steps.length === 0) {
      throw new MutationPlanError('PLAN_CONFLICT', 'Mutation plan must have a kind and at least one step.');
    }
    for (const step of plan.steps) {
      for (const targetPath of stepPaths(step)) {
        const { canonicalTarget } = await assertPathWithinRoot(this.rootPath, targetPath);
        if (isPathInside(this.journalRoot, canonicalTarget)) {
          throw new MutationPlanError('PLAN_CONFLICT', 'Mutation plan cannot modify its own journal.');
        }
      }
    }
  }

  private async validatePlan(
    plan: MutationPlan<unknown>,
    snapshots: readonly PathSnapshot[],
  ): Promise<void> {
    for (let index = 0; index < plan.steps.length; index++) {
      const step = plan.steps[index]!;
      if (isReadOnlyAssertionStep(step)) {
        // Assertions describe source state at admission and remain independent
        // from the projected effects of earlier plan steps.
        await assertExpectation(step.targetPath, step.expected);
        continue;
      }

      if (step.type === 'writeFile' || step.type === 'deletePath') {
        await this.validateExpectedPreState(step.targetPath, step.expected, snapshots, plan, index);
      } else if (step.type === 'movePath') {
        await this.validateExpectedPreState(step.sourcePath, step.sourceExpected, snapshots, plan, index);
        await this.validateExpectedPreState(step.targetPath, step.targetExpected, snapshots, plan, index);
      }
    }
  }

  private async validateExpectedPreState(
    targetPath: string,
    expected: MutationExpectation,
    snapshots: readonly PathSnapshot[],
    plan: MutationPlan<unknown>,
    appliedSteps: number,
  ): Promise<void> {
    const projected = expectedPostState(targetPath, snapshots, plan, appliedSteps);
    if (!projected || !matchesExpectation(projected, expected)) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        `Plan conflict: pre-state is inconsistent for ${targetPath}: expected ${describeExpectation(expected)}, projected ${projected ? describeExpectation(projected) : 'unknown'}.`,
      );
    }

    if (!hasPriorPathEffect(targetPath, snapshots, plan, appliedSteps)) {
      // Keep admission CAS against the original disk state for paths that the
      // plan has not already replaced or reset through an ancestor.
      await assertExpectation(targetPath, expected);
    }
  }

  private async captureSnapshots(plan: MutationPlan<unknown>, operationPath: string): Promise<PathSnapshot[]> {
    const targets: Array<{ targetPath: string; contentsBackedUp: boolean }> = [];
    for (const step of plan.steps) {
      if (step.type === 'movePath') {
        addSnapshotTarget(targets, step.sourcePath, true);
        addSnapshotTarget(targets, step.targetPath, true);
      } else if (!isReadOnlyAssertionStep(step)) {
        addSnapshotTarget(targets, step.targetPath, step.type !== 'ensureDirectory');
      }
    }
    const snapshots: PathSnapshot[] = [];
    let index = 0;
    for (const { targetPath, contentsBackedUp } of targets) {
      const snapshot = await inspectPath(targetPath);
      const backupName = snapshot.state === 'missing' || !contentsBackedUp ? undefined : String(index++);
      if (backupName) {
        await copyPath(targetPath, path.join(operationPath, 'backups', backupName));
      }
      snapshots.push({
        targetPath,
        state: snapshot.state,
        hash: snapshot.state === 'file' ? snapshot.hash : undefined,
        fingerprint: snapshot.state === 'directory' ? snapshot.fingerprint : undefined,
        backupName,
        contentsBackedUp,
      });
    }
    return snapshots;
  }

  private async applyStep(step: MutationStep): Promise<void> {
    switch (step.type) {
      case 'assertFile': {
        const canonicalTarget = await this.revalidateParent(step.targetPath);
        await assertExpectation(canonicalTarget, step.expected);
        return;
      }
      case 'assertDirectory': {
        const canonicalTarget = await this.revalidateParent(step.targetPath);
        await assertExpectation(canonicalTarget, step.expected);
        return;
      }
      case 'ensureDirectory':
        await this.revalidateParent(step.targetPath);
        await fs.promises.mkdir(step.targetPath, { recursive: true });
        return;
      case 'writeFile': {
        await assertExpectation(step.targetPath, step.expected);
        const bytes = Buffer.from(step.content, step.encoding);
        await this.writeAtomic(step.targetPath, bytes, step.expected);
        return;
      }
      case 'deletePath': {
        await assertExpectation(step.targetPath, step.expected);
        const canonicalTarget = await this.revalidateParent(step.targetPath);
        // The earlier preflight is advisory. This check is the CAS fence directly
        // adjacent to the namespace effect and uses the same canonical target.
        await assertExpectation(canonicalTarget, step.expected);
        await fs.promises.rm(canonicalTarget, { recursive: true, force: false });
        return;
      }
      case 'movePath': {
        await assertExpectation(step.sourcePath, step.sourceExpected);
        await assertExpectation(step.targetPath, step.targetExpected);
        const canonicalSource = await this.revalidateParent(step.sourcePath);
        const canonicalTarget = await this.revalidateParent(step.targetPath);
        await assertExpectation(canonicalSource, step.sourceExpected);
        await assertExpectation(canonicalTarget, step.targetExpected);
        await fs.promises.rename(canonicalSource, canonicalTarget);
        return;
      }
    }
  }

  private async writeAtomic(
    targetPath: string,
    content: Buffer,
    expected: MutationExpectation,
  ): Promise<void> {
    const canonical = await this.revalidateParent(targetPath);
    const parentPath = path.dirname(canonical);
    const tempPath = path.join(parentPath, `.cdt-plan-${randomUUID()}.tmp`);
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(tempPath, 'wx');
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      const revalidatedTarget = await this.revalidateParent(targetPath);
      if (revalidatedTarget !== canonical) {
        throw new PathBoundaryError(
          'PATH_OUTSIDE_ROOT',
          `Target namespace changed during mutation plan: ${targetPath}`,
          targetPath,
        );
      }
      await assertExpectation(canonical, expected);
      if (expected.state === 'missing') {
        try {
          await fs.promises.link(tempPath, canonical);
        } catch (error) {
          if (isAlreadyExistsError(error)) {
            throw new MutationPlanError('PLAN_CONFLICT', `Target was created concurrently: ${canonical}.`);
          }
          throw new AmbiguousMutationEffectError(
            `Could not confirm atomic creation of ${canonical}: ${errorMessage(error)}`,
          );
        }
      } else {
        await fs.promises.rename(tempPath, canonical);
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async revalidateParent(targetPath: string): Promise<string> {
    const { canonicalRoot, canonicalTarget } = await assertPathWithinRoot(this.rootPath, targetPath);
    await assertNoSymlinkSegments(canonicalRoot, canonicalTarget);
    return canonicalTarget;
  }

  private async restoreSnapshots(
    operationPath: string,
    snapshots: readonly PathSnapshot[],
    plan?: MutationPlan<unknown>,
    appliedSteps?: number,
    appliedStepsAreAuthoritative = false,
  ): Promise<void> {
    const effectiveSteps = (plan && typeof appliedSteps === 'number' && !appliedStepsAreAuthoritative)
      ? await resolveEffectiveAppliedSteps(this.rootPath, snapshots, plan, appliedSteps)
      : appliedSteps;

    if (plan && typeof effectiveSteps === 'number') {
      for (const snapshot of snapshots) {
        if (snapshot.state === 'directory' && !snapshot.contentsBackedUp) {
          // ensureDirectory found an existing directory; it has no content effect to undo.
          continue;
        }
        const { canonicalTarget } = await assertPathWithinRoot(this.rootPath, snapshot.targetPath);
        const expected = expectedPostState(snapshot.targetPath, snapshots, plan, effectiveSteps);
        await assertRollbackExpectation(canonicalTarget, expected);
      }
    }

    for (const snapshot of [...snapshots].reverse()) {
      const { canonicalTarget } = await assertPathWithinRoot(this.rootPath, snapshot.targetPath);
      if (snapshot.state === 'directory' && !snapshot.contentsBackedUp) {
        // ensureDirectory found an existing directory; it has no content effect to undo.
        continue;
      }

      if (snapshot.state === 'missing') {
        const stat = await fs.promises.lstat(canonicalTarget).catch(() => undefined);
        if (stat?.isDirectory()) {
          const isMoveTarget = plan?.steps.some(
            (s) => s.type === 'movePath' && isSamePath(s.targetPath, snapshot.targetPath)
          );
          if (!isMoveTarget) {
            const entries = await fs.promises.readdir(canonicalTarget).catch(() => []);
            if (entries.length > 0) {
              throw new MutationPlanError(
                'RECOVERY_REQUIRED',
                `Cannot remove newly-created directory ${canonicalTarget}: directory is not empty (${entries.length} unexpected item(s)). Recovery aborted to protect external changes.`
              );
            }
            await fs.promises.rmdir(canonicalTarget);
            continue;
          }
        }
      }

      await fs.promises.rm(canonicalTarget, { recursive: true, force: true });
      if (snapshot.state !== 'missing') {
        if (!snapshot.backupName) {
          throw new Error(`Missing backup for ${snapshot.targetPath}.`);
        }
        await copyPath(path.join(operationPath, 'backups', snapshot.backupName), canonicalTarget);
      }
    }
  }

  private async writeJournal(operationPath: string, journal: MutationJournal): Promise<void> {
    const journalPath = path.join(operationPath, 'journal.json');
    const tempPath = path.join(operationPath, `.journal-${randomUUID()}.tmp`);
    await fs.promises.writeFile(tempPath, JSON.stringify(journal), { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(tempPath, journalPath);
  }

  private async removeJournalRootWhenEmpty(): Promise<void> {
    await fs.promises.rmdir(this.journalRoot).catch((error) => {
      if (!isMissingError(error)) {
        throw error;
      }
    });
  }
}

const planMutationAdmissionTails = new Map<string, Promise<void>>();
const planMutationTails = new Map<string, Promise<void>>();

async function acquirePlanMutationLock(rootPath: string): Promise<() => void> {
  const absolute = path.resolve(rootPath);
  const admissionKey = normalizeLockKey(absolute);
  const releaseAdmission = await acquireQueuedLock(planMutationAdmissionTails, admissionKey);
  try {
    const resolved = await fs.promises.realpath(absolute).catch(() => absolute);
    const releaseMutation = await acquireQueuedLock(planMutationTails, normalizeLockKey(resolved));
    return () => {
      releaseMutation();
      releaseAdmission();
    };
  } catch (error) {
    releaseAdmission();
    throw error;
  }
}

async function acquireQueuedLock(
  tails: Map<string, Promise<void>>,
  key: string,
): Promise<() => void> {
  const previous = tails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const tail = previous.then(() => gate, () => gate);
  tails.set(key, tail);
  await previous.catch(() => undefined);
  return () => {
    releaseGate();
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  };
}

function normalizeLockKey(targetPath: string): string {
  return process.platform === 'win32' ? targetPath.toLocaleLowerCase() : targetPath;
}

export function utf8WriteStep(
  targetPath: string,
  content: string,
  expected: MutationExpectation,
): MutationStep {
  return { type: 'writeFile', targetPath, content, encoding: 'utf8', expected };
}

function stepPaths(step: MutationStep): string[] {
  return step.type === 'movePath' ? [step.sourcePath, step.targetPath] : [step.targetPath];
}

function snapshotsForAppliedSteps(
  plan: MutationPlan<unknown>,
  snapshots: readonly PathSnapshot[],
  appliedSteps: number,
): PathSnapshot[] {
  const appliedPaths =
    plan.steps.slice(0, appliedSteps)
      .filter((step) => !isReadOnlyAssertionStep(step))
      .flatMap((step) => stepPaths(step));
  return snapshots.filter((snapshot) => appliedPaths.some((appliedPath) => isSamePath(appliedPath, snapshot.targetPath)));
}

function addSnapshotTarget(
  targets: Array<{ targetPath: string; contentsBackedUp: boolean }>,
  targetPath: string,
  contentsBackedUp: boolean,
): void {
  const existing = targets.find((target) => isSamePath(target.targetPath, targetPath));
  if (existing) {
    existing.contentsBackedUp ||= contentsBackedUp;
    return;
  }
  targets.push({ targetPath, contentsBackedUp });
}

function matchesExpectation(actual: MutationExpectation, expected: MutationExpectation): boolean {
  if (actual.state !== expected.state) {
    return false;
  }
  if (expected.state === 'file' && actual.state === 'file') {
    return actual.hash === expected.hash;
  }
  if (expected.state === 'directory' && actual.state === 'directory') {
    if (expected.fingerprint !== undefined) {
      return actual.fingerprint === expected.fingerprint;
    }
    return true;
  }
  return true;
}

function describeExpectation(expected: MutationExpectation): string {
  if (expected.state === 'file') {
    return `file(${expected.hash})`;
  }
  if (expected.state === 'directory') {
    return expected.fingerprint ? `directory(${expected.fingerprint})` : 'directory';
  }
  return expected.state;
}

async function assertExpectation(targetPath: string, expected: MutationExpectation): Promise<void> {
  const actual = await inspectPath(targetPath);
  if (!matchesExpectation(actual, expected)) {
    throw new MutationPlanError('PLAN_CONFLICT', `Pre-state changed for ${targetPath}.`);
  }
}

export const EMPTY_DIRECTORY_FINGERPRINT = hashContent(Buffer.from('', 'utf8'));

function computeExpectedDirectoryFingerprint(
  dirPath: string,
  snapshots: readonly PathSnapshot[],
  plan: MutationPlan<unknown>,
  appliedSteps: number,
): string | undefined {
  const snapshot = snapshots.find((s) => isSamePath(s.targetPath, dirPath));
  let resetIndex = -1;
  for (let i = 0; i < appliedSteps; i++) {
    const step = plan.steps[i];
    if (step?.type === 'deletePath' && isPathInside(step.targetPath, dirPath)) {
      resetIndex = i;
    }
  }

  if (resetIndex < 0 && snapshot?.state === 'directory') {
    return hasDirectoryContentMutation(dirPath, snapshots, plan, 0, appliedSteps)
      ? undefined
      : snapshot.fingerprint;
  }

  const childPaths: string[] = [];
  for (let i = resetIndex + 1; i < appliedSteps; i++) {
    const step = plan.steps[i];
    if (!step || isReadOnlyAssertionStep(step)) {
      continue;
    }
    const paths = stepPaths(step);
    for (const p of paths) {
      if (isSamePath(dirPath, p) || !isPathInside(dirPath, p)) {
        continue;
      }
      const rel = path.relative(dirPath, p);
      if (!rel || path.isAbsolute(rel)) {
        continue;
      }
      const firstSegment = rel.split(path.sep)[0];
      if (!firstSegment) {
        continue;
      }
      const childPath = path.join(dirPath, firstSegment);
      if (!childPaths.some((existing) => isSamePath(existing, childPath))) {
        childPaths.push(childPath);
      }
    }
  }

  const entries: DirectoryFingerprintEntry[] = [];
  for (const childPath of childPaths) {
    const childExpected = expectedPostState(childPath, snapshots, plan, appliedSteps);
    if (!childExpected) {
      return undefined;
    }
    if (childExpected.state === 'missing') {
      continue;
    }
    const name = path.basename(childPath);
    if (childExpected.state === 'file') {
      entries.push({ name, type: 'file', hash: childExpected.hash });
    } else {
      const fingerprint = childExpected.fingerprint
        ?? computeExpectedDirectoryFingerprint(childPath, snapshots, plan, appliedSteps);
      if (fingerprint === undefined) {
        return undefined;
      }
      entries.push({ name, type: 'directory', fingerprint });
    }
  }
  return calculateDirectoryFingerprintFromEntries(entries);
}

function hasDirectoryContentMutation(
  dirPath: string,
  snapshots: readonly PathSnapshot[],
  plan: MutationPlan<unknown>,
  startIndex: number,
  appliedSteps: number,
): boolean {
  for (let index = startIndex; index < appliedSteps; index++) {
    const step = plan.steps[index];
    if (!step || isReadOnlyAssertionStep(step)) {
      continue;
    }
    if (step.type === 'writeFile' || step.type === 'deletePath') {
      if (isPathInside(dirPath, step.targetPath)) {
        return true;
      }
      continue;
    }
    if (step.type === 'ensureDirectory') {
      if (!isSamePath(dirPath, step.targetPath) && isPathInside(dirPath, step.targetPath)) {
        const ensureSnapshot = snapshots.find((snapshot) => isSamePath(snapshot.targetPath, step.targetPath));
        if (ensureSnapshot?.state !== 'directory') {
          return true;
        }
      }
      continue;
    }

    if (
      isSamePath(dirPath, step.targetPath)
      && snapshots.find((snapshot) => isSamePath(snapshot.targetPath, step.sourcePath))?.state === 'directory'
    ) {
      // A directory move preserves its captured tree fingerprint at the exact
      // destination path. Descendant effects still make that fingerprint opaque.
      continue;
    }
    if (
      isPathInside(dirPath, step.sourcePath)
      || isPathInside(step.sourcePath, dirPath)
      || isPathInside(dirPath, step.targetPath)
      || isPathInside(step.targetPath, dirPath)
    ) {
      return true;
    }
  }
  return false;
}

function expectedPostState(
  targetPath: string,
  snapshots: readonly PathSnapshot[],
  plan: MutationPlan<unknown>,
  appliedSteps: number,
): MutationExpectation | undefined {
  for (let i = appliedSteps - 1; i >= 0; i--) {
    const step = plan.steps[i];
    if (!step || isReadOnlyAssertionStep(step)) {
      continue;
    }
    if (step.type === 'writeFile' && isSamePath(step.targetPath, targetPath)) {
      return {
        state: 'file',
        hash: hashContent(Buffer.from(step.content, step.encoding)),
      };
    }
    if (step.type === 'deletePath' && isPathInside(step.targetPath, targetPath)) {
      return { state: 'missing' };
    }
    if (step.type === 'ensureDirectory' && isSamePath(step.targetPath, targetPath)) {
      const beforeEnsure = expectedPostState(targetPath, snapshots, plan, i);
      if (!beforeEnsure) {
        return undefined;
      }
      if (beforeEnsure.state !== 'directory' && beforeEnsure.state !== 'missing') {
        return beforeEnsure;
      }

      if (beforeEnsure.state === 'directory') {
        let resetIndex = -1;
        for (let priorIndex = 0; priorIndex < i; priorIndex++) {
          const priorStep = plan.steps[priorIndex];
          if (priorStep?.type === 'deletePath' && isPathInside(priorStep.targetPath, targetPath)) {
            resetIndex = priorIndex;
          }
        }
        if (resetIndex < 0) {
          const targetSnapshot = snapshots.find((snapshot) => isSamePath(snapshot.targetPath, targetPath));
          if (targetSnapshot?.state === 'directory') {
            return hasDirectoryContentMutation(targetPath, snapshots, plan, 0, appliedSteps)
              ? { state: 'directory' }
              : beforeEnsure;
          }

          let exactMoveIndex = -1;
          for (let priorIndex = 0; priorIndex < i; priorIndex++) {
            const priorStep = plan.steps[priorIndex];
            if (priorStep?.type === 'movePath' && isSamePath(priorStep.targetPath, targetPath)) {
              exactMoveIndex = priorIndex;
            }
          }
          if (exactMoveIndex >= 0) {
            return hasDirectoryContentMutation(targetPath, snapshots, plan, exactMoveIndex + 1, appliedSteps)
              ? { state: 'directory' }
              : beforeEnsure;
          }
        }
      }

      const fingerprint = computeExpectedDirectoryFingerprint(targetPath, snapshots, plan, appliedSteps);
      return fingerprint !== undefined ? { state: 'directory', fingerprint } : undefined;
    }
    if (
      step.type === 'ensureDirectory'
      && isPathInside(targetPath, step.targetPath)
      && !isSamePath(step.targetPath, targetPath)
    ) {
      const projectedParent = projectFreshDirectory(targetPath, snapshots, plan, appliedSteps);
      if (projectedParent.matched) {
        return projectedParent.expectation;
      }
    }
    if (
      step.type === 'ensureDirectory'
      && isPathInside(step.targetPath, targetPath)
      && !isSamePath(step.targetPath, targetPath)
      && isFreshDirectoryEnsure(step.targetPath, snapshots, plan, i)
    ) {
      return { state: 'missing' };
    }
    if (step.type === 'movePath') {
      if (isSamePath(step.sourcePath, targetPath)) {
        return hasDirectoryContentMutation(targetPath, snapshots, plan, i + 1, appliedSteps)
          ? undefined
          : { state: 'missing' };
      }
      if (isSamePath(step.targetPath, targetPath)) {
        const sourceState = expectedPostState(step.sourcePath, snapshots, plan, i);
        return sourceState?.state === 'directory'
          && hasDirectoryContentMutation(targetPath, snapshots, plan, i + 1, appliedSteps)
          ? { state: 'directory' }
          : sourceState;
      }
      if (isPathInside(step.sourcePath, targetPath)) {
        return { state: 'missing' };
      }
      if (isPathInside(step.targetPath, targetPath)) {
        // A moved directory's descendants are not represented in the plan or
        // journal snapshots. Do not infer them from the destination's old state.
        return undefined;
      }
    }
  }

  const freshDirectory = projectFreshDirectory(targetPath, snapshots, plan, appliedSteps);
  if (freshDirectory.matched) {
    return freshDirectory.expectation;
  }

  const snapshot = snapshots.find((s) => isSamePath(s.targetPath, targetPath));
  if (!snapshot) {
    return undefined;
  }
  if (snapshot.state === 'file') {
    return { state: 'file', hash: snapshot.hash! };
  }
  if (snapshot.state === 'directory') {
    if (hasDirectoryContentMutation(targetPath, snapshots, plan, 0, appliedSteps)) {
      return { state: 'directory' };
    }
    return { state: 'directory', fingerprint: snapshot.fingerprint };
  }
  return { state: snapshot.state };
}

function isFreshDirectoryEnsure(
  targetPath: string,
  snapshots: readonly PathSnapshot[],
  plan: MutationPlan<unknown>,
  ensureIndex: number,
): boolean {
  return expectedPostState(targetPath, snapshots, plan, ensureIndex)?.state === 'missing';
}

function projectFreshDirectory(
  targetPath: string,
  snapshots: readonly PathSnapshot[],
  plan: MutationPlan<unknown>,
  appliedSteps: number,
): { matched: false } | { matched: true; expectation?: MutationExpectation } {
  const snapshot = snapshots.find((item) => isSamePath(item.targetPath, targetPath));
  let resetIndex = -1;
  for (let index = 0; index < appliedSteps; index++) {
    const step = plan.steps[index];
    if (step?.type === 'deletePath' && isPathInside(step.targetPath, targetPath)) {
      resetIndex = index;
    }
  }

  const hasFreshBase = resetIndex >= 0 || !snapshot || snapshot.state === 'missing';
  if (!hasFreshBase) {
    return { matched: false };
  }

  const hasEnsure = plan.steps.slice(resetIndex + 1, appliedSteps).some((step) =>
    step.type === 'ensureDirectory' && isPathInside(targetPath, step.targetPath)
  );
  if (!hasEnsure) {
    return { matched: false };
  }

  const fingerprint = computeExpectedDirectoryFingerprint(targetPath, snapshots, plan, appliedSteps);
  return fingerprint === undefined
    ? { matched: true }
    : { matched: true, expectation: { state: 'directory', fingerprint } };
}

function hasPriorPathEffect(
  targetPath: string,
  snapshots: readonly PathSnapshot[],
  plan: MutationPlan<unknown>,
  appliedSteps: number,
): boolean {
  for (let index = 0; index < appliedSteps; index++) {
    const step = plan.steps[index];
    if (!step || isReadOnlyAssertionStep(step)) {
      continue;
    }
    if (step.type === 'movePath') {
      if ([step.sourcePath, step.targetPath].some((item) => isSamePath(item, targetPath))) {
        return true;
      }
      continue;
    }
    if (isSamePath(step.targetPath, targetPath)) {
      return true;
    }
    if (step.type === 'deletePath' && isPathInside(step.targetPath, targetPath)) {
      return true;
    }
    if (
      step.type === 'ensureDirectory'
      && isPathInside(step.targetPath, targetPath)
      && isFreshDirectoryEnsure(step.targetPath, snapshots, plan, index)
    ) {
      return true;
    }
  }
  return false;
}

async function assertRollbackExpectation(
  targetPath: string,
  expected: MutationExpectation | undefined,
): Promise<void> {
  if (!expected || (expected.state === 'directory' && expected.fingerprint === undefined)) {
    throw new MutationPlanError(
      'RECOVERY_REQUIRED',
      `Cannot prove the projected post-state for ${targetPath}. Recovery aborted to protect external changes.`,
    );
  }
  const actual = await inspectPath(targetPath);
  if (!matchesExpectation(actual, expected)) {
    const expectedDesc = describeExpectation(expected);
    const actualDesc = describeExpectation(actual);
    throw new MutationPlanError(
      'RECOVERY_REQUIRED',
      `Post-state diverged for ${targetPath}: expected ${expectedDesc}, actual ${actualDesc}. Recovery aborted to protect external changes.`,
    );
  }
}

async function resolveEffectiveAppliedSteps(
  rootPath: string,
  snapshots: readonly PathSnapshot[],
  plan: MutationPlan<unknown>,
  appliedSteps: number,
): Promise<number> {
  if (appliedSteps >= plan.steps.length) {
    return appliedSteps;
  }
  const nextStep = plan.steps[appliedSteps];
  if (!nextStep) {
    return appliedSteps;
  }
  if (isReadOnlyAssertionStep(nextStep)) {
    // Read-only CAS checks have no post-state to infer. Treat them as consumed so
    // recovery can continue to the next effect without inspecting/restoring source.
    return appliedSteps + 1;
  }

  if (nextStep.type === 'writeFile' && nextStep.expected.state === 'missing') {
    const { canonicalTarget } = await assertPathWithinRoot(rootPath, nextStep.targetPath);
    try {
      await fs.promises.lstat(canonicalTarget);
    } catch (error) {
      if (isMissingError(error)) {
        return appliedSteps;
      }
      throw new MutationPlanError(
        'RECOVERY_REQUIRED',
        `Cannot confirm ownership of an interrupted create at ${canonicalTarget}: ${errorMessage(error)}`,
      );
    }
    throw new MutationPlanError(
      'RECOVERY_REQUIRED',
      `Cannot prove ownership of an unrecorded expected-missing create at ${canonicalTarget}. Recovery aborted to protect external changes.`,
    );
  }

  const unrecordedPaths = stepPaths(nextStep);
  let matchesUnapplied = true;
  let matchesApplied = true;

  for (const p of unrecordedPaths) {
    const { canonicalTarget } = await assertPathWithinRoot(rootPath, p);
    const actual = await inspectPath(canonicalTarget);

    const expectedUnapplied = expectedPostState(p, snapshots, plan, appliedSteps);
    if (!expectedUnapplied || !matchesExpectation(actual, expectedUnapplied)) {
      matchesUnapplied = false;
    }

    const expectedApplied = expectedPostState(p, snapshots, plan, appliedSteps + 1);
    if (!expectedApplied || !matchesExpectation(actual, expectedApplied)) {
      matchesApplied = false;
    }
  }

  if (matchesApplied) {
    return appliedSteps + 1;
  }
  if (matchesUnapplied) {
    return appliedSteps;
  }

  const firstPath = unrecordedPaths[0] ?? '';
  const { canonicalTarget } = await assertPathWithinRoot(rootPath, firstPath);
  const actual = await inspectPath(canonicalTarget).catch(() => ({ state: 'missing' as const }));
  const expectedUnapplied = expectedPostState(firstPath, snapshots, plan, appliedSteps);
  throw new MutationPlanError(
    'RECOVERY_REQUIRED',
    `Post-state diverged for ${canonicalTarget}: expected ${expectedUnapplied ? describeExpectation(expectedUnapplied) : 'unknown'}, actual ${describeExpectation(actual)}. Recovery aborted to protect external changes.`,
  );
}

export async function calculateDirectoryFingerprint(dirPath: string): Promise<string> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const fingerprintEntries: DirectoryFingerprintEntry[] = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new MutationPlanError('PLAN_CONFLICT', `Forbidden symbolic link inside directory: ${full}`);
    }
    if (entry.isFile()) {
      const content = await fs.promises.readFile(full);
      fingerprintEntries.push({ name: entry.name, type: 'file', hash: hashContent(content) });
    } else if (entry.isDirectory()) {
      fingerprintEntries.push({
        name: entry.name,
        type: 'directory',
        fingerprint: await calculateDirectoryFingerprint(full),
      });
    }
  }
  return calculateDirectoryFingerprintFromEntries(fingerprintEntries);
}

async function inspectPath(targetPath: string): Promise<MutationExpectation> {
  try {
    const stat = await fs.promises.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw new MutationPlanError('PLAN_CONFLICT', `Symbolic-link target is forbidden: ${targetPath}`);
    }
    if (stat.isDirectory()) {
      return {
        state: 'directory',
        fingerprint: await calculateDirectoryFingerprint(targetPath),
      };
    }
    if (stat.isFile()) {
      return { state: 'file', hash: hashContent(await fs.promises.readFile(targetPath)) };
    }
    throw new MutationPlanError('PLAN_CONFLICT', `Unsupported filesystem entry: ${targetPath}`);
  } catch (error) {
    if (isMissingError(error)) {
      return { state: 'missing' };
    }
    throw error;
  }
}

async function copyPath(sourcePath: string, targetPath: string): Promise<void> {
  const stat = await fs.promises.lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new MutationPlanError('PLAN_CONFLICT', `Refusing to journal a symbolic link: ${sourcePath}`);
  }
  if (stat.isDirectory()) {
    await fs.promises.mkdir(targetPath, { recursive: true });
    for (const entry of await fs.promises.readdir(sourcePath, { withFileTypes: true })) {
      await copyPath(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
    }
    return;
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.copyFile(sourcePath, targetPath);
}

async function assertSafeBackupEntry(
  itemPath: string,
  canonicalJournalRoot: string,
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(itemPath);
  } catch (error) {
    throw new MutationPlanError(
      'RECOVERY_REQUIRED',
      `Cannot stat backup item "${itemPath}": ${errorMessage(error)}`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw new MutationPlanError(
      'RECOVERY_REQUIRED',
      `Forbidden symbolic link in backup item: "${itemPath}"`,
    );
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new MutationPlanError(
      'RECOVERY_REQUIRED',
      `Invalid backup item type (not file or directory): "${itemPath}"`,
    );
  }
  const canonicalItem = await fs.promises.realpath(itemPath);
  if (!isPathInside(canonicalJournalRoot, canonicalItem)) {
    throw new PathBoundaryError(
      'PATH_OUTSIDE_ROOT',
      `Backup item escapes journal root: "${itemPath}"`,
      itemPath,
    );
  }
  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(itemPath);
    } catch (error) {
      throw new MutationPlanError(
        'RECOVERY_REQUIRED',
        `Cannot read backup directory "${itemPath}": ${errorMessage(error)}`,
      );
    }
    for (const entry of entries) {
      await assertSafeBackupEntry(path.join(itemPath, entry), canonicalJournalRoot);
    }
  }
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isNotEmptyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOTEMPTY');
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'EEXIST');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isOwnerActivelyRunning(owner: OperationOwner | undefined): boolean {
  if (owner === undefined || !isProcessAlive(owner.pid)) {
    return false;
  }
  if (typeof owner.heartbeatAt === 'number') {
    return Date.now() - owner.heartbeatAt <= LEASE_TTL_MS;
  }
  return true;
}
