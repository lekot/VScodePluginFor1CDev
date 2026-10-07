import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  assertNoSymlinkSegments,
  assertPathWithinRoot,
  PathBoundaryError,
} from './pathBoundary';
import { hashContent } from './atomicFileStorage';
import { Logger } from '../../utils/logger';

export type MutationExpectation =
  | { readonly state: 'missing' }
  | { readonly state: 'file'; readonly hash: string }
  | { readonly state: 'directory' };

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
  release(): Promise<void>;
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

/** Executes serializable filesystem plans with a write-ahead journal and reverse recovery. */
export class MutationPlanExecutor {
  private readonly journalRoot: string;

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
    await fs.promises.mkdir(this.journalRoot, { recursive: true });
    const leasePath = path.join(this.journalRoot, ROOT_LEASE_FILE);
    const leaseId = randomUUID();

    const tryAcquire = async (): Promise<boolean> => {
      const record: RootLeaseRecord = {
        leaseId,
        pid: process.pid,
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
        operationId,
      };
      try {
        await fs.promises.writeFile(leasePath, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
        return true;
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
          return false;
        }
        throw err;
      }
    };

    let acquired = await tryAcquire();
    if (!acquired) {
      let existingRecord: RootLeaseRecord | undefined;
      try {
        const raw = await fs.promises.readFile(leasePath, 'utf8');
        existingRecord = JSON.parse(raw) as RootLeaseRecord;
      } catch (err) {
        if (isMissingError(err)) {
          acquired = await tryAcquire();
        }
      }

      if (!acquired && existingRecord) {
        const isHolderAlive = isProcessAlive(existingRecord.pid);
        const lastHeartbeat = existingRecord.heartbeatAt || existingRecord.createdAt || 0;
        const isHeartbeatFresh = Date.now() - lastHeartbeat <= LEASE_TTL_MS;

        if (isHolderAlive && isHeartbeatFresh) {
          throw new MutationPlanError(
            'PLAN_CONFLICT',
            `Configuration is actively locked by process ${existingRecord.pid}.`,
          );
        }

        await fs.promises.rm(leasePath, { force: true }).catch(() => undefined);
        acquired = await tryAcquire();
        if (!acquired) {
          throw new MutationPlanError(
            'PLAN_CONFLICT',
            'Configuration root lease acquisition conflict after breaking stale lease.',
          );
        }
      }
    }

    const heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          const raw = await fs.promises.readFile(leasePath, 'utf8');
          const current = JSON.parse(raw) as RootLeaseRecord;
          if (current.leaseId === leaseId) {
            current.heartbeatAt = Date.now();
            await fs.promises.writeFile(leasePath, JSON.stringify(current), 'utf8');
          }
        } catch {
          // ignore transient error
        }
      })();
    }, LEASE_HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }

    let released = false;
    const release = async (): Promise<void> => {
      if (released) { return; }
      released = true;
      clearInterval(heartbeatTimer);
      try {
        const raw = await fs.promises.readFile(leasePath, 'utf8');
        const current = JSON.parse(raw) as RootLeaseRecord;
        if (current.leaseId === leaseId) {
          await fs.promises.rm(leasePath, { force: true });
        }
      } catch {
        // ignore error
      }
      await this.removeJournalRootWhenEmpty().catch(() => undefined);
    };

    return { leaseId, release };
  }

  private async removeOperationDir(operationPath: string): Promise<void> {
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

    await this.recoverLocked();
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
        await this.applyStep(plan.steps[index]!);
        journal.appliedSteps = index + 1;
        await this.writeJournal(operationPath, journal);
      }
      journal.state = 'committed';
      await this.writeJournal(operationPath, journal);
      // Commit is durable; cleanup is best-effort and recovery will remove a committed journal.
      await this.removeOperationDir(operationPath).catch(() => undefined);
      await this.removeJournalRootWhenEmpty().catch(() => undefined);
      return plan.result;
    } catch (error) {
      journal.state = 'rollback-required';
      await this.writeJournal(operationPath, journal).catch(() => undefined);
      const isPreEffectConflict =
        (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT')
        || error instanceof PathBoundaryError;
      const snapshotsToRestore = isPreEffectConflict
        ? snapshotsForAppliedSteps(plan, snapshots, journal.appliedSteps)
        : snapshots;
      try {
        await this.restoreSnapshots(operationPath, snapshotsToRestore);
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
        await this.recoverLocked();
      } finally {
        await lease.release();
      }
    } finally {
      release();
    }
  }

  private async recoverLocked(): Promise<void> {
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
      if (!entry.isDirectory()) {
        continue;
      }
      const operationPath = path.join(this.journalRoot, entry.name);

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
            await this.removeOperationDir(operationPath);
          } catch (cleanupError) {
            Logger.warn(`Failed to clean up committed operation directory: ${operationPath}`, cleanupError);
          }
          continue;
        }

        // #183: Rollback was explicitly required after an error.
        // It must be restored and removed rather than blocking with PLAN_CONFLICT.
        if (journal.state === 'rollback-required') {
          await this.restoreSnapshots(operationPath, journal.snapshots);
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
        await this.restoreSnapshots(operationPath, journal.snapshots);
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
        if (owner === undefined && entry.name.startsWith('.')) {
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
        await this.removeOperationDir(operationPath).catch((err) => {
          Logger.warn(`Failed to remove orphan mutation journal dir: ${operationPath}`, err);
        });
        continue;
      }
    }
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

  private async restoreSnapshots(operationPath: string, snapshots: readonly PathSnapshot[]): Promise<void> {
    for (const snapshot of [...snapshots].reverse()) {
      const { canonicalTarget } = await assertPathWithinRoot(this.rootPath, snapshot.targetPath);
      if (snapshot.state === 'directory' && !snapshot.contentsBackedUp) {
        // ensureDirectory found an existing directory; it has no content effect to undo.
        continue;
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

async function assertExpectation(targetPath: string, expected: MutationExpectation): Promise<void> {
  const actual = await inspectPath(targetPath);
  if (
    actual.state !== expected.state
    || (expected.state === 'file' && actual.state === 'file' && actual.hash !== expected.hash)
  ) {
    throw new MutationPlanError('PLAN_CONFLICT', `Pre-state changed for ${targetPath}.`);
  }
}

async function inspectPath(targetPath: string): Promise<MutationExpectation> {
  try {
    const stat = await fs.promises.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw new MutationPlanError('PLAN_CONFLICT', `Symbolic-link target is forbidden: ${targetPath}`);
    }
    if (stat.isDirectory()) {
      return { state: 'directory' };
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

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isNotEmptyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOTEMPTY');
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

