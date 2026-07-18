import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  assertNoSymlinkSegments,
  assertPathWithinRoot,
  PathBoundaryError,
} from './pathBoundary';
import { hashContent } from './atomicFileStorage';

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
      return await this.executeLocked(plan, operationId);
    } finally {
      release();
    }
  }

  private async executeLocked<T>(plan: MutationPlan<T>, operationId: string): Promise<T> {
    await this.recoverLocked();
    const operationPath = path.join(this.journalRoot, operationId);
    await this.validatePlan(plan);
    await fs.promises.mkdir(path.join(operationPath, 'backups'), { recursive: true });
    const snapshots = await this.captureSnapshots(plan, operationPath);
    const journal: MutationJournal<T> = {
      version: 1,
      operationId,
      plan,
      state: 'prepared',
      appliedSteps: 0,
      snapshots,
    };
    await this.writeJournal(operationPath, journal);

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
      await fs.promises.rm(operationPath, { recursive: true, force: true }).catch(() => undefined);
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
        await fs.promises.rm(operationPath, { recursive: true, force: true });
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
      await this.recoverLocked();
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
      let journal: MutationJournal;
      try {
        journal = JSON.parse(await fs.promises.readFile(path.join(operationPath, 'journal.json'), 'utf8')) as MutationJournal;
        if (journal.version !== 1 || !Array.isArray(journal.snapshots)) {
          throw new Error('Unsupported or corrupt mutation journal.');
        }
        if (journal.state !== 'committed') {
          await this.restoreSnapshots(operationPath, journal.snapshots);
        }
        await fs.promises.rm(operationPath, { recursive: true, force: true });
      } catch (error) {
        throw new MutationPlanError(
          'RECOVERY_REQUIRED',
          `Cannot recover mutation journal ${entry.name}: ${errorMessage(error)}`,
        );
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

const planMutationTails = new Map<string, Promise<void>>();

async function acquirePlanMutationLock(rootPath: string): Promise<() => void> {
  const absolute = path.resolve(rootPath);
  const resolved = await fs.promises.realpath(absolute).catch(() => absolute);
  const key = process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
  const previous = planMutationTails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const tail = previous.then(() => gate, () => gate);
  planMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  return () => {
    releaseGate();
    if (planMutationTails.get(key) === tail) {
      planMutationTails.delete(key);
    }
  };
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
