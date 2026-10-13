import * as path from 'path';

import type { MergeOperation } from './mergePreview';
import type { MergePathSnapshot, MergeSnapshotDirectory } from './mergeSnapshot';
import { mutationFingerprint } from './mergeSnapshot';
import type { MutationExpectation, MutationPlan, MutationStep } from '../../services/configurationSession/mutationPlan';
import { isPathInside, isSamePath } from '../../services/configurationSession/pathBoundary';

export interface PreparedMergeAction {
  readonly targetPath: string;
  readonly targetUri: string;
  readonly operations: readonly MergeOperation[];
  readonly before: MergePathSnapshot;
  readonly kind: 'writeFile' | 'deleteFile' | 'deleteDirectory' | 'replaceDirectory';
  readonly contentBase64?: string;
  readonly directory?: MergeSnapshotDirectory;
  readonly backupPaths: readonly string[];
}

export interface MergeMutationPlanResult {
  readonly applied: readonly {
    operationId: string;
    kind: MergeOperation['kind'];
    targetUri?: string;
    backupPath?: string;
  }[];
  readonly backupPaths: readonly string[];
}

/** Converts already captured merge state into the one journaled mutation plan. */
export function buildMergeMutationPlan(
  rootPath: string,
  actions: readonly PreparedMergeAction[],
): MutationPlan<MergeMutationPlanResult> {
  const steps: MutationStep[] = [];
  const applied: MergeMutationPlanResult['applied'][number][] = [];
  const backupPaths: string[] = [];
  const ensuredDirectories: string[] = [];

  for (const action of actions) {
    ensureParents(rootPath, action.targetPath, steps, ensuredDirectories);
    const expected = expectationFor(action.before);

    if (action.kind === 'writeFile') {
      if (action.contentBase64 === undefined) {
        throw new Error(`Merge file write has no captured content: ${action.targetPath}`);
      }
      if (action.before.state !== 'missing' && action.before.type !== 'file') {
        throw new Error(`Merge file write target is not a file: ${action.targetPath}`);
      }
      steps.push({
        type: 'writeFile',
        targetPath: action.targetPath,
        content: action.contentBase64,
        encoding: 'base64',
        expected,
      });
    } else if (action.kind === 'deleteFile') {
      if (action.before.state !== 'missing' && action.before.type !== 'file') {
        throw new Error(`Merge file delete target is not a file: ${action.targetPath}`);
      }
      steps.push({ type: 'deletePath', targetPath: action.targetPath, expected });
    } else if (action.kind === 'deleteDirectory') {
      if (action.before.state !== 'missing' && action.before.type !== 'directory') {
        throw new Error(`Merge folder delete target is not a directory: ${action.targetPath}`);
      }
      steps.push({ type: 'deletePath', targetPath: action.targetPath, expected });
    } else {
      if (action.before.state !== 'missing' && action.before.type !== 'directory') {
        throw new Error(`Merge folder replacement target is not a directory: ${action.targetPath}`);
      }
      if (!action.directory) {
        throw new Error(`Merge folder replacement has no captured source manifest: ${action.targetPath}`);
      }
      if (action.before.state !== 'missing') {
        steps.push({ type: 'deletePath', targetPath: action.targetPath, expected });
      }
      appendDirectory(action.targetPath, action.directory, steps, ensuredDirectories);
    }

    for (const backupPath of action.backupPaths) {
      backupPaths.push(backupPath);
    }
    for (const operation of action.operations) {
      applied.push({
        operationId: operation.operationId,
        kind: operation.kind,
        targetUri: operation.targetUri,
        backupPath: action.backupPaths[0],
      });
    }
  }

  return {
    kind: 'configuration-compare-merge',
    steps,
    result: { applied, backupPaths },
  };
}

function expectationFor(snapshot: MergePathSnapshot): MutationExpectation {
  if (snapshot.state === 'missing') {
    return { state: 'missing' };
  }
  if (snapshot.type === 'file') {
    return { state: 'file', hash: snapshot.hash };
  }
  return { state: 'directory', fingerprint: mutationFingerprint(snapshot) };
}

function ensureParents(
  rootPath: string,
  targetPath: string,
  steps: MutationStep[],
  ensuredDirectories: string[],
): void {
  const parents: string[] = [];
  let cursor = path.dirname(targetPath);
  while (isPathInside(rootPath, cursor) && !isSamePath(rootPath, cursor)) {
    parents.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  for (const directoryPath of parents) {
    ensureDirectory(directoryPath, steps, ensuredDirectories);
  }
}

function appendDirectory(
  targetRoot: string,
  directory: MergeSnapshotDirectory,
  steps: MutationStep[],
  ensuredDirectories: string[],
): void {
  ensureDirectory(targetRoot, steps, ensuredDirectories);
  for (const entry of directory.children) {
    const targetPath = path.join(targetRoot, path.basename(entry.relativePath));
    if (entry.type === 'directory') {
      appendDirectory(targetPath, entry, steps, ensuredDirectories);
    } else {
      ensureParents(targetRoot, targetPath, steps, ensuredDirectories);
      steps.push({
        type: 'writeFile',
        targetPath,
        content: requireCapturedContent(entry, targetPath),
        encoding: 'base64',
        expected: { state: 'missing' },
      });
    }
  }
}

function requireCapturedContent(
  entry: Extract<MergeSnapshotDirectory['children'][number], { readonly type: 'file' }>,
  targetPath: string,
): string {
  if (entry.contentBase64 === undefined) {
    throw new Error(`Merge source bytes were not captured for ${targetPath}`);
  }
  return entry.contentBase64;
}

function ensureDirectory(
  directoryPath: string,
  steps: MutationStep[],
  ensuredDirectories: string[],
): void {
  if (ensuredDirectories.some((existing) => isSamePath(existing, directoryPath))) {
    return;
  }
  ensuredDirectories.push(directoryPath);
  steps.push({ type: 'ensureDirectory', targetPath: directoryPath });
}
