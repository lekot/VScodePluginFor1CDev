import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { compareCodeUnits } from '../../utils/compareCodeUnits';
import { trimTrailingPathSeparators } from '../normalizedFilePath';
import type { CompareTreeNode } from '../compareTreeTypes';
import type { BslModuleIndexEntry } from './bslModuleIndexer';

export interface BslModuleComparisonReference {
  readonly nodeId: string;
  readonly moduleLabel: string;
  /** The selected target/receiver side of the compare. */
  readonly leftFilePath: string;
  /** The incoming source side of the compare. */
  readonly rightFilePath: string;
  readonly leftTextHash: string;
  readonly rightTextHash: string;
}

export interface BslModuleComparisonSnapshot {
  readonly label: string;
  readonly sourceSnapshotText: string;
  readonly targetFilePath: string;
}

export type BslModuleComparisonResolution =
  | { readonly ok: true; readonly snapshot: BslModuleComparisonSnapshot }
  | { readonly ok: false; readonly message: string };

export function createBslModuleComparisonReference(input: {
  readonly nodeId: string;
  readonly moduleLabel: string;
  readonly leftFilePath: string;
  readonly rightFilePath: string;
  readonly leftText: string;
  readonly rightText: string;
}): BslModuleComparisonReference {
  return {
    nodeId: input.nodeId,
    moduleLabel: input.moduleLabel,
    leftFilePath: input.leftFilePath,
    rightFilePath: input.rightFilePath,
    leftTextHash: hashTextUtf8(input.leftText),
    rightTextHash: hashTextUtf8(input.rightText),
  };
}

export function createBslModuleComparisonReferences(input: {
  readonly leftModules: readonly BslModuleIndexEntry[];
  readonly rightModules: readonly BslModuleIndexEntry[];
  readonly leftSources: ReadonlyMap<string, string>;
  readonly rightSources: ReadonlyMap<string, string>;
}): ReadonlyMap<string, BslModuleComparisonReference> {
  const leftById = groupModulesById(input.leftModules);
  const rightById = groupModulesById(input.rightModules);
  const references = new Map<string, BslModuleComparisonReference>();

  for (const moduleId of [...new Set([...leftById.keys(), ...rightById.keys()])].sort(compareCodeUnits)) {
    const left = leftById.get(moduleId);
    const right = rightById.get(moduleId);
    if (left?.length !== 1 || right?.length !== 1) {
      continue;
    }

    const leftModule = left[0]!;
    const rightModule = right[0]!;
    const leftText = input.leftSources.get(leftModule.identity.filePath);
    const rightText = input.rightSources.get(rightModule.identity.filePath);
    if (leftText === undefined || rightText === undefined) {
      continue;
    }

    const nodeId = `bsl:module:${moduleId}`;
    references.set(nodeId, createBslModuleComparisonReference({
      nodeId,
      moduleLabel: rightModule.identity.displayName || leftModule.identity.displayName || moduleId,
      leftFilePath: leftModule.identity.filePath,
      rightFilePath: rightModule.identity.filePath,
      leftText,
      rightText,
    }));
  }

  return references;
}

export function hashTextUtf8(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

export function listCanonicalBslModuleComparisonNodeIds(
  root: CompareTreeNode,
  references: ReadonlyMap<string, BslModuleComparisonReference>
): string[] {
  if (references.size === 0) {return [];}
  const canonicalModuleIds = collectCanonicalBslModuleIds(root);
  return [...references.entries()]
    .filter(([nodeId, reference]) => reference.nodeId === nodeId && canonicalModuleIds.has(nodeId))
    .map(([nodeId]) => nodeId)
    .sort(compareCodeUnits);
}

export async function resolveVerifiedBslModuleComparison(input: {
  readonly nodeId: string;
  readonly reference?: BslModuleComparisonReference;
  readonly root: CompareTreeNode;
  readonly leftRootPath: string;
  readonly rightRootPath: string;
  readonly isCurrent: () => boolean;
}): Promise<BslModuleComparisonResolution> {
  const reference = input.reference;
  if (!reference || reference.nodeId !== input.nodeId || !findCanonicalBslModule(input.root, input.nodeId)) {
    return { ok: false, message: 'Сравнение этого BSL-модуля недоступно. Обновите сравнение.' };
  }

  try {
    const [target, source] = await Promise.all([
      readVerifiedBslModule(input.leftRootPath, reference.leftFilePath, reference.leftTextHash),
      readVerifiedBslModule(input.rightRootPath, reference.rightFilePath, reference.rightTextHash),
    ]);
    if (!input.isCurrent()) {
      return { ok: false, message: 'Состояние сравнения изменилось. Обновите сравнение и попробуйте снова.' };
    }
    return {
      ok: true,
      snapshot: {
        label: reference.moduleLabel,
        sourceSnapshotText: source.text,
        targetFilePath: target.realPath,
      },
    };
  } catch {
    return { ok: false, message: 'Файл модуля изменился или не прошёл проверку. Обновите сравнение и попробуйте снова.' };
  }
}

function groupModulesById(modules: readonly BslModuleIndexEntry[]): Map<string, BslModuleIndexEntry[]> {
  const grouped = new Map<string, BslModuleIndexEntry[]>();
  for (const module of modules) {
    const entries = grouped.get(module.identity.moduleId) ?? [];
    entries.push(module);
    grouped.set(module.identity.moduleId, entries);
  }
  return grouped;
}

async function readVerifiedBslModule(
  rootPath: string,
  candidatePath: string,
  expectedHash: string
): Promise<{ text: string; realPath: string }> {
  if (!path.isAbsolute(candidatePath) && !path.win32.isAbsolute(candidatePath)) {
    throw new Error('BSL module path must be absolute.');
  }

  const rootRealPath = await fs.realpath(rootPath);
  const realPath = await fs.realpath(candidatePath);
  if (!pathContains(rootRealPath, realPath)) {
    throw new Error('BSL module path escaped its comparison root.');
  }

  const before = await lstatRegularFileWithoutSymlinks(candidatePath);
  const text = await fs.readFile(candidatePath, 'utf8');
  const after = await lstatRegularFileWithoutSymlinks(candidatePath);
  const realPathAfter = await fs.realpath(candidatePath);
  if (
    !sameNormalizedPath(realPath, realPathAfter) ||
    before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    hashTextUtf8(text) !== expectedHash
  ) {
    throw new Error('BSL module changed after comparison.');
  }

  return { text, realPath };
}

async function lstatRegularFileWithoutSymlinks(
  filePath: string
): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  const absolutePath = path.resolve(filePath);
  const parsed = path.parse(absolutePath);
  const segments = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let currentPath = parsed.root;
  let finalStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) {
      currentPath = path.join(currentPath, segments[index]!);
    }
    const stat = await fs.lstat(currentPath);
    if (stat.isSymbolicLink()) {
      throw new Error('BSL module path contains a symbolic link.');
    }
    const isFile = index === segments.length - 1;
    if ((isFile && !stat.isFile()) || (!isFile && !stat.isDirectory())) {
      throw new Error('BSL module path is not a regular file.');
    }
    finalStat = stat;
  }
  if (!finalStat || !finalStat.isFile()) {
    throw new Error('BSL module path is not a regular file.');
  }
  return finalStat;
}

function findCanonicalBslModule(root: CompareTreeNode, nodeId: string): CompareTreeNode | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === nodeId) {
      return node.kind === 'bslModule' ? node : undefined;
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]!);
    }
  }
  return undefined;
}

function collectCanonicalBslModuleIds(root: CompareTreeNode): Set<string> {
  const moduleIds = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.kind === 'bslModule') {moduleIds.add(node.id);}
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]!);
    }
  }
  return moduleIds;
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sameNormalizedPath(left: string, right: string): boolean {
  const normalizedLeft = trimTrailingPathSeparators(path.resolve(left));
  const normalizedRight = trimTrailingPathSeparators(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}
