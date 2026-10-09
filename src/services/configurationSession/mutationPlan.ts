import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
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

export type MutationExpectation =
  | { readonly state: 'missing' }
  | { readonly state: 'file'; readonly hash: string }
  | { readonly state: 'directory'; readonly fingerprint?: string };

export type MutationStep =
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
  readonly snapshots: readonly PathSnapshot[];
}

export interface OperationOwner {
  readonly pid: number;
  readonly createdAt: number;
  readonly heartbeatAt?: number;
  readonly leaseId?: string;
}

const ROOT_LEASE_FILE = '.root-lease.json';
const ROOT_LEASE_QUARANTINE_PREFIX = `${ROOT_LEASE_FILE}.claim-`;
const LEASE_TTL_MS = 15000;
const LEASE_HEARTBEAT_INTERVAL_MS = 2000;

interface RootLeaseRecord {
  leaseId: string;
  pid: number;
  createdAt: number;
  heartbeatAt: number;
  operationId: string;
}

interface ActiveRootLease {
  leaseId: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface RootLeaseHeartbeatRecord {
  leaseId: string;
  heartbeatAt: number;
}

export class MutationPlanError extends Error {
  constructor(
    readonly code: 'PLAN_CONFLICT' | 'PLAN_FAILED' | 'RECOVERY_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'MutationPlanError';
  }
}

class RootLeaseOwnershipError extends MutationPlanError {
  constructor(message: string) {
    super('PLAN_CONFLICT', message);
    this.name = 'RootLeaseOwnershipError';
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
        await removeRootLeaseIfUnchanged(leasePath, leaseId).catch(() => false);
        await fs.promises.rm(heartbeatPath, { force: true }).catch(() => undefined);
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
        await fs.promises.rm(existingHeartbeatPath, { force: true }).catch(() => undefined);
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
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeatTimer = setInterval(() => {
      if (released || heartbeatInFlight) { return; }
      heartbeatInFlight = (async () => {
        await assertRootLeaseOwned(leasePath, this.journalRoot, leaseId);
        await writeRootLeaseHeartbeat(heartbeatPath, leaseId, Date.now());
      })().catch(() => undefined).finally(() => {
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

    const release = async (): Promise<void> => {
      if (released) { return; }
      released = true;
      clearInterval(heartbeatTimer);
      await heartbeatInFlight?.catch(() => undefined);
      try {
        await assertRootLeaseOwned(leasePath, this.journalRoot, leaseId);
        await removeRootLeaseIfUnchanged(leasePath, leaseId);
      } catch {
        // A different lease owner must never be removed during release.
      }
      await fs.promises.rm(heartbeatPath, { force: true }).catch(() => undefined);
      await this.removeJournalRootWhenEmpty().catch(() => undefined);
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
    await this.validatePlan(plan);
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
      await this.removeJournalRootWhenEmpty().catch(() => undefined);
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
      await this.removeOperationDir(operationPath).catch(() => undefined);
      await this.removeJournalRootWhenEmpty().catch(() => undefined);
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
      await this.writeJournal(operationPath, journal).catch(() => undefined);
      const isPreEffectConflict =
        (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT')
        || error instanceof PathBoundaryError;
      const snapshotsToRestore = isPreEffectConflict
        ? snapshotsForAppliedSteps(plan, snapshots, journal.appliedSteps)
        : snapshots;
      try {
        await this.restoreSnapshots(operationPath, snapshotsToRestore, plan, journal.appliedSteps);
        await this.removeOperationDir(operationPath);
        await this.removeJournalRootWhenEmpty();
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
      try {
        await lease.assertOwned();
        await this.recoverLocked(lease);
      } finally {
        await lease.release();
      }
    } finally {
      release();
    }
  }

  private async recoverLocked(lease: ActiveRootLease): Promise<void> {
    const { canonicalJournalRoot } = await assertJournalNamespace(this.rootPath);
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
            Logger.warn(`Failed to clean up committed operation directory: ${operationPath}`, cleanupError);
          }
          continue;
        }

        // #183: Rollback was explicitly required after an error.
        // It must be restored and removed rather than blocking with PLAN_CONFLICT.
        if (journal.state === 'rollback-required') {
          await lease.assertOwned();
          await this.restoreSnapshots(operationPath, journal.snapshots, journal.plan, journal.appliedSteps);
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

        // Pre-effect orphan operation directory from terminated process or stale unowned dir:
        // No mutation steps were ever applied to target files; clean up safely without throwing RECOVERY_REQUIRED.
        const ownerInfo = owner ? ` from terminated process ${owner.pid}` : '';
        Logger.warn(`Removed orphan mutation journal dir${ownerInfo} without journal.json: ${operationPath}`);
        await lease.assertOwned();
        await this.removeOperationDir(operationPath).catch((err) => {
          Logger.warn(`Failed to remove orphan mutation journal dir: ${operationPath}`, err);
        });
        continue;
      }
    }
    await lease.assertOwned();
    await this.removeJournalRootWhenEmpty();
  }

  private async validatePlan(plan: MutationPlan<unknown>): Promise<void> {
    if (!plan.kind.trim() || plan.steps.length === 0) {
      throw new MutationPlanError('PLAN_CONFLICT', 'Mutation plan must have a kind and at least one step.');
    }
    const previouslyMutated = new Set<string>();
    for (const step of plan.steps) {
      for (const targetPath of stepPaths(step)) {
        const { canonicalTarget } = await assertPathWithinRoot(this.rootPath, targetPath);
        if (canonicalTarget === this.journalRoot || canonicalTarget.startsWith(`${this.journalRoot}${path.sep}`)) {
          throw new MutationPlanError('PLAN_CONFLICT', 'Mutation plan cannot modify its own journal.');
        }
      }
      switch (step.type) {
        case 'writeFile':
        case 'deletePath':
          if (!previouslyMutated.has(step.targetPath)) {
            await assertExpectation(step.targetPath, step.expected);
          }
          previouslyMutated.add(step.targetPath);
          break;
        case 'movePath':
          if (!previouslyMutated.has(step.sourcePath)) {
            await assertExpectation(step.sourcePath, step.sourceExpected);
          }
          if (!previouslyMutated.has(step.targetPath)) {
            await assertExpectation(step.targetPath, step.targetExpected);
          }
          previouslyMutated.add(step.sourcePath);
          previouslyMutated.add(step.targetPath);
          break;
        case 'ensureDirectory':
          previouslyMutated.add(step.targetPath);
          break;
      }
    }
  }

  private async captureSnapshots(plan: MutationPlan<unknown>, operationPath: string): Promise<PathSnapshot[]> {
    const targets = new Map<string, boolean>();
    for (const step of plan.steps) {
      if (step.type === 'movePath') {
        targets.set(step.sourcePath, true);
        targets.set(step.targetPath, true);
      } else {
        targets.set(step.targetPath, (targets.get(step.targetPath) ?? false) || step.type !== 'ensureDirectory');
      }
    }
    const snapshots: PathSnapshot[] = [];
    let index = 0;
    for (const [targetPath, contentsBackedUp] of targets) {
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
      await fs.promises.rename(tempPath, canonical);
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
  ): Promise<void> {
    const effectiveSteps = (plan && typeof appliedSteps === 'number')
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
      if (!isMissingError(error) && !isNotEmptyError(error)) {
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
  const appliedPaths = new Set(
    plan.steps.slice(0, appliedSteps).flatMap((step) => stepPaths(step)),
  );
  return snapshots.filter((snapshot) => appliedPaths.has(snapshot.targetPath));
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
  const wasMissing = !snapshot || snapshot.state === 'missing';

  const childNames = new Set<string>();
  for (let i = 0; i < appliedSteps; i++) {
    const step = plan.steps[i];
    if (!step) {
      continue;
    }
    const paths = stepPaths(step);
    for (const p of paths) {
      const rel = path.relative(dirPath, p);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        const firstSegment = rel.split(/[\\/]/)[0];
        if (firstSegment) {
          childNames.add(firstSegment);
        }
      }
    }
  }

  if (childNames.size === 0) {
    if (wasMissing) {
      return EMPTY_DIRECTORY_FINGERPRINT;
    }
    return snapshot.fingerprint;
  }

  if (wasMissing) {
    const sortedNames = [...childNames].sort((a, b) => a.localeCompare(b));
    const hashes: string[] = [];
    for (const name of sortedNames) {
      const childPath = path.join(dirPath, name);
      const childExpected = expectedPostState(childPath, snapshots, plan, appliedSteps);
      if (childExpected.state === 'missing') {
        continue;
      }
      if (childExpected.state === 'file' && childExpected.hash) {
        hashes.push(`F:${name}:${childExpected.hash}`);
      } else if (childExpected.state === 'directory') {
        const fp = childExpected.fingerprint ?? computeExpectedDirectoryFingerprint(childPath, snapshots, plan, appliedSteps) ?? EMPTY_DIRECTORY_FINGERPRINT;
        hashes.push(`D:${name}:${fp}`);
      }
    }
    return hashContent(Buffer.from(hashes.join('\n'), 'utf8'));
  }

  return snapshot.fingerprint;
}

function expectedPostState(
  targetPath: string,
  snapshots: readonly PathSnapshot[],
  plan: MutationPlan<unknown>,
  appliedSteps: number,
): MutationExpectation {
  for (let i = appliedSteps - 1; i >= 0; i--) {
    const step = plan.steps[i];
    if (!step) {
      continue;
    }
    if (step.type === 'writeFile' && isSamePath(step.targetPath, targetPath)) {
      return {
        state: 'file',
        hash: hashContent(Buffer.from(step.content, step.encoding)),
      };
    }
    if (step.type === 'deletePath' && isSamePath(step.targetPath, targetPath)) {
      return { state: 'missing' };
    }
    if (step.type === 'ensureDirectory' && isSamePath(step.targetPath, targetPath)) {
      const fingerprint = computeExpectedDirectoryFingerprint(targetPath, snapshots, plan, appliedSteps);
      return { state: 'directory', ...(fingerprint !== undefined ? { fingerprint } : {}) };
    }
    if (step.type === 'movePath') {
      if (isSamePath(step.sourcePath, targetPath)) {
        return { state: 'missing' };
      }
      if (isSamePath(step.targetPath, targetPath)) {
        return expectedPostState(step.sourcePath, snapshots, plan, i);
      }
    }
  }

  const snapshot = snapshots.find((s) => isSamePath(s.targetPath, targetPath));
  if (!snapshot) {
    return { state: 'missing' };
  }
  if (snapshot.state === 'file') {
    return { state: 'file', hash: snapshot.hash! };
  }
  if (snapshot.state === 'directory') {
    return { state: 'directory', fingerprint: snapshot.fingerprint };
  }
  return { state: snapshot.state };
}

async function assertRollbackExpectation(
  targetPath: string,
  expected: MutationExpectation,
): Promise<void> {
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

  const unrecordedPaths = stepPaths(nextStep);
  let matchesUnapplied = true;
  let matchesApplied = true;

  for (const p of unrecordedPaths) {
    const { canonicalTarget } = await assertPathWithinRoot(rootPath, p);
    const actual = await inspectPath(canonicalTarget);

    const expectedUnapplied = expectedPostState(p, snapshots, plan, appliedSteps);
    if (!matchesExpectation(actual, expectedUnapplied)) {
      matchesUnapplied = false;
    }

    const expectedApplied = expectedPostState(p, snapshots, plan, appliedSteps + 1);
    if (!matchesExpectation(actual, expectedApplied)) {
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
    `Post-state diverged for ${canonicalTarget}: expected ${describeExpectation(expectedUnapplied)}, actual ${describeExpectation(actual)}. Recovery aborted to protect external changes.`,
  );
}

export async function calculateDirectoryFingerprint(dirPath: string): Promise<string> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const hashes: string[] = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new MutationPlanError('PLAN_CONFLICT', `Forbidden symbolic link inside directory: ${full}`);
    }
    if (entry.isFile()) {
      const content = await fs.promises.readFile(full);
      hashes.push(`F:${entry.name}:${hashContent(content)}`);
    } else if (entry.isDirectory()) {
      hashes.push(`D:${entry.name}:${await calculateDirectoryFingerprint(full)}`);
    }
  }
  return hashContent(Buffer.from(hashes.join('\n'), 'utf8'));
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

function rootLeaseHeartbeatPath(journalRoot: string, leaseId: string): string {
  const leaseKey = createHash('sha256').update(leaseId, 'utf8').digest('hex');
  return path.join(journalRoot, `${ROOT_LEASE_FILE}.${leaseKey}.heartbeat`);
}

function parseRootLeaseClaimTimestamp(name: string): number | undefined {
  const suffix = name.slice(ROOT_LEASE_QUARANTINE_PREFIX.length);
  if (!suffix.startsWith('v2-')) { return undefined; }
  const match = /^v2-(\d+)-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(suffix);
  if (!match) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease claim name is malformed.');
  }
  const claimedAt = Number(match[1]);
  const claimantPid = Number(match[2]);
  if (!Number.isSafeInteger(claimedAt) || claimedAt < 0
    || !Number.isSafeInteger(claimantPid) || claimantPid <= 0) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease claim metadata is invalid.');
  }
  return claimedAt;
}

function parseRootLeaseRecord(raw: string): RootLeaseRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Configuration root lease contains malformed JSON: ${errorMessage(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease record must be an object.');
  }
  const record = parsed as Partial<RootLeaseRecord>;
  const now = Date.now();
  if (
    typeof record.leaseId !== 'string'
    || record.leaseId.trim().length === 0
    || record.leaseId.length > 256
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.createdAt !== 'number'
    || !Number.isFinite(record.createdAt)
    || record.createdAt < 0
    || record.createdAt > now + LEASE_TTL_MS
    || typeof record.heartbeatAt !== 'number'
    || !Number.isFinite(record.heartbeatAt)
    || record.heartbeatAt < 0
    || record.heartbeatAt > now + LEASE_TTL_MS
    || typeof record.operationId !== 'string'
    || record.operationId.trim().length === 0
  ) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease record has invalid fields.');
  }
  return record as RootLeaseRecord;
}

function parseRootLeaseHeartbeat(raw: string, leaseId: string): RootLeaseHeartbeatRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Configuration root lease heartbeat is malformed: ${errorMessage(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease heartbeat must be an object.');
  }
  const heartbeat = parsed as Partial<RootLeaseHeartbeatRecord>;
  if (
    heartbeat.leaseId !== leaseId
    || typeof heartbeat.heartbeatAt !== 'number'
    || !Number.isFinite(heartbeat.heartbeatAt)
    || heartbeat.heartbeatAt < 0
    || heartbeat.heartbeatAt > Date.now() + LEASE_TTL_MS
  ) {
    throw new MutationPlanError('PLAN_CONFLICT', 'Configuration root lease heartbeat has invalid fields.');
  }
  return heartbeat as RootLeaseHeartbeatRecord;
}

async function readRootLeaseHeartbeat(
  heartbeatPath: string,
  lease: RootLeaseRecord,
): Promise<number> {
  try {
    const raw = await fs.promises.readFile(heartbeatPath, 'utf8');
    return parseRootLeaseHeartbeat(raw, lease.leaseId).heartbeatAt;
  } catch (error) {
    if (isMissingError(error)) {
      return lease.heartbeatAt;
    }
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Cannot inspect configuration root lease heartbeat: ${errorMessage(error)}`,
    );
  }
}

async function writeRootLeaseHeartbeat(
  heartbeatPath: string,
  leaseId: string,
  heartbeatAt: number,
): Promise<void> {
  const tempPath = `${heartbeatPath}.${randomUUID()}.tmp`;
  try {
    const heartbeat: RootLeaseHeartbeatRecord = { leaseId, heartbeatAt };
    await fs.promises.writeFile(tempPath, JSON.stringify(heartbeat), { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(tempPath, heartbeatPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensureRootLeaseQuarantineClear(journalRoot: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(journalRoot);
  } catch (error) {
    if (isMissingError(error)) { return; }
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Cannot inspect configuration root lease state: ${errorMessage(error)}`,
    );
  }
  for (const name of entries.filter((entryName) => entryName.startsWith(ROOT_LEASE_QUARANTINE_PREFIX))) {
    const claimPath = path.join(journalRoot, name);
    let claim: RootLeaseRecord;
    try {
      claim = parseRootLeaseRecord(await fs.promises.readFile(claimPath, 'utf8'));
    } catch (error) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        `Configuration root lease claim cannot be validated: ${errorMessage(error)}`,
      );
    }
    const claimedAt = parseRootLeaseClaimTimestamp(name);
    if (claimedAt !== undefined && Date.now() - claimedAt < LEASE_TTL_MS) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        'Configuration root lease is being fenced by an active process.',
      );
    }
    const heartbeatPath = rootLeaseHeartbeatPath(journalRoot, claim.leaseId);
    const lastHeartbeat = await readRootLeaseHeartbeat(heartbeatPath, claim);
    if (isProcessAlive(claim.pid) && Date.now() - lastHeartbeat <= LEASE_TTL_MS) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        'Configuration root lease is being fenced by an active process.',
      );
    }
    try {
      await fs.promises.rm(claimPath, { force: true });
      await fs.promises.rm(heartbeatPath, { force: true });
    } catch (error) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        `Cannot recover stale configuration root lease claim: ${errorMessage(error)}`,
      );
    }
  }
}

async function assertRootLeaseOwned(
  leasePath: string,
  journalRoot: string,
  expectedLeaseId: string,
): Promise<void> {
  try {
    await ensureRootLeaseQuarantineClear(journalRoot);
    const raw = await fs.promises.readFile(leasePath, 'utf8');
    const current = parseRootLeaseRecord(raw);
    if (current.leaseId !== expectedLeaseId) {
      throw new RootLeaseOwnershipError('Configuration root lease ownership was lost.');
    }
  } catch (error) {
    if (error instanceof RootLeaseOwnershipError) { throw error; }
    throw new RootLeaseOwnershipError(
      `Configuration root lease ownership could not be verified: ${errorMessage(error)}`,
    );
  }
}

async function restoreRootLeaseClaim(claimPath: string, leasePath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.promises.link(claimPath, leasePath);
      break;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        if (attempt === 9) { return false; }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        `Cannot restore a replaced configuration root lease: ${errorMessage(error)}`,
      );
    }
  }
  try {
    await fs.promises.rm(claimPath, { force: true });
  } catch (error) {
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Configuration root lease was restored but its claim marker remains: ${errorMessage(error)}`,
    );
  }
  return true;
}

/** Removes a lease only after atomically moving and validating the exact file at the path. */
async function removeRootLeaseIfUnchanged(leasePath: string, expectedLeaseId: string): Promise<boolean> {
  const claimPath = path.join(
    path.dirname(leasePath),
    `${ROOT_LEASE_QUARANTINE_PREFIX}v2-${Date.now()}-${process.pid}-${randomUUID()}`,
  );
  try {
    await fs.promises.rename(leasePath, claimPath);
  } catch (error) {
    if (isMissingError(error)) { return false; }
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Cannot fence configuration root lease: ${errorMessage(error)}`,
    );
  }

  let movedLease: RootLeaseRecord;
  try {
    movedLease = parseRootLeaseRecord(await fs.promises.readFile(claimPath, 'utf8'));
  } catch (error) {
    const restored = await restoreRootLeaseClaim(claimPath, leasePath).catch(() => false);
    if (!restored) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        'Configuration root lease could not be validated or restored; the claim marker was preserved.',
      );
    }
    throw error instanceof MutationPlanError
      ? error
      : new MutationPlanError('PLAN_CONFLICT', `Cannot validate moved root lease: ${errorMessage(error)}`);
  }

  if (movedLease.leaseId !== expectedLeaseId) {
    const restored = await restoreRootLeaseClaim(claimPath, leasePath);
    if (!restored) {
      throw new MutationPlanError(
        'PLAN_CONFLICT',
        'A replacement root lease appeared during fencing; its predecessor was preserved in a claim marker.',
      );
    }
    return false;
  }

  try {
    await fs.promises.rm(claimPath, { force: true });
  } catch (error) {
    throw new MutationPlanError(
      'PLAN_CONFLICT',
      `Configuration root lease was fenced but its claim marker could not be removed: ${errorMessage(error)}`,
    );
  }
  return true;
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

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'EPERM');
  }
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
