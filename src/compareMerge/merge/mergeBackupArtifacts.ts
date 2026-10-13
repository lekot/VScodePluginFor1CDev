import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

import type { BackupPlan } from './mergePreview';
import type { MergePathSnapshot, MergeSnapshotDirectory, MergeSnapshotEntry } from './mergeSnapshot';
import { canonicalizePathWithMissingSuffix, isPathInside, isSamePath } from '../../services/configurationSession/pathBoundary';

export interface MergeBackupArtifact {
  readonly operationId: string;
  readonly backupPath: string;
}

export class MergeBackupArtifactExportError extends Error {
  constructor(
    message: string,
    readonly createdArtifacts: readonly MergeBackupArtifact[],
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MergeBackupArtifactExportError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Exports only unique, exclusively-created snapshots outside both configuration trees. */
export async function exportMergeBackupArtifacts(input: {
  readonly backupPlan: BackupPlan;
  readonly leftRootPath: string;
  readonly rightRootPath: string;
  readonly snapshotsByOperationId: ReadonlyMap<string, MergePathSnapshot>;
}): Promise<readonly MergeBackupArtifact[]> {
  const leftRoot = await fs.realpath(input.leftRootPath);
  const rightRoot = await fs.realpath(input.rightRootPath);
  const destinations: Array<{ operationId: string; backupPath: string; snapshot?: MergePathSnapshot }> = [];

  for (const item of input.backupPlan.items) {
    const backupPath = filePathFromUri(item.backupUri);
    const canonicalDestination = await validateBackupDestination(
      backupPath,
      [leftRoot, rightRoot],
    );
    const previous = destinations.find((entry) =>
      isSamePath(entry.backupPath, canonicalDestination)
      || isPathInside(entry.backupPath, canonicalDestination)
      || isPathInside(canonicalDestination, entry.backupPath)
    );
    if (previous) {
      throw new Error(`Backup artifact destinations must be unique: ${backupPath}`);
    }
    const snapshot = input.snapshotsByOperationId.get(item.operationId);
    destinations.push({ operationId: item.operationId, backupPath: canonicalDestination, snapshot });
  }

  const createdArtifacts: MergeBackupArtifact[] = [];
  for (const destination of destinations) {
    if (!destination.snapshot || destination.snapshot.state === 'missing') {
      continue;
    }
    try {
      await createSafeParentDirectories(destination.backupPath, [leftRoot, rightRoot]);
      await exportSnapshot(destination.snapshot, destination.backupPath, [leftRoot, rightRoot]);
      createdArtifacts.push({ operationId: destination.operationId, backupPath: destination.backupPath });
    } catch (error) {
      throw new MergeBackupArtifactExportError(
        error instanceof Error ? error.message : String(error),
        createdArtifacts,
        error,
      );
    }
  }

  return createdArtifacts;
}

async function validateBackupDestination(
  destinationPath: string,
  roots: readonly string[],
): Promise<string> {
  const absolute = path.resolve(destinationPath);
  await assertSafeBackupPath(absolute, roots, true);
  const canonical = await canonicalizePathWithMissingSuffix(absolute);
  try {
    await fs.lstat(canonical);
    throw new Error(`Backup artifact destination already exists: ${destinationPath}`);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  return canonical;
}

async function assertNoSymlinkSegments(absolutePath: string): Promise<void> {
  const parsed = path.parse(absolutePath);
  const relative = path.relative(parsed.root, absolutePath);
  let cursor = parsed.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`Backup artifact path contains a symbolic link: ${cursor}`);
      }
      if (!stat.isDirectory() && !isSamePath(cursor, absolutePath)) {
        throw new Error(`Backup artifact parent is not a directory: ${cursor}`);
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      break;
    }
  }
}

async function assertSafeBackupPath(
  candidatePath: string,
  roots: readonly string[],
  expectMissingLeaf: boolean,
  rejectRootAncestors = true,
): Promise<void> {
  const absolute = path.resolve(candidatePath);
  await assertNoSymlinkSegments(absolute);
  const canonical = await canonicalizePathWithMissingSuffix(absolute);
  for (const root of roots) {
    if (isPathInside(root, canonical) || (rejectRootAncestors && isPathInside(canonical, root))) {
      throw new Error(`Backup artifact must be outside both configuration roots: ${candidatePath}`);
    }
    const journalRoot = path.join(root, '.cdt-journal');
    if (isPathInside(journalRoot, canonical) || (rejectRootAncestors && isPathInside(canonical, journalRoot))) {
      throw new Error(`Backup artifact overlaps a configuration journal namespace: ${candidatePath}`);
    }
  }
  try {
    const stat = await fs.lstat(absolute);
    if (expectMissingLeaf) {
      throw new Error(`Backup artifact destination already exists: ${candidatePath}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Backup artifact directory changed to a link or non-directory: ${candidatePath}`);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

async function createSafeParentDirectories(
  destinationPath: string,
  excludedRoots: readonly string[],
): Promise<void> {
  const parentPath = path.dirname(destinationPath);
  const parsed = path.parse(parentPath);
  const relative = path.relative(parsed.root, parentPath);
  let cursor = parsed.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    await assertSafeBackupPath(cursor, excludedRoots, false, false);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Backup artifact parent changed to a link or non-directory: ${cursor}`);
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      try {
        await assertSafeBackupPath(cursor, excludedRoots, true, false);
        await fs.mkdir(cursor);
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) {
          throw mkdirError;
        }
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`Backup artifact parent changed to a link or non-directory: ${cursor}`);
        }
      }
    }
  }
}

async function exportSnapshot(
  snapshot: MergePathSnapshot,
  destinationPath: string,
  excludedRoots: readonly string[],
): Promise<void> {
  if (snapshot.state === 'missing') {
    return;
  }
  if (snapshot.type === 'file') {
    if (snapshot.contentBase64 === undefined) {
      throw new Error(`Captured backup bytes are unavailable for ${destinationPath}`);
    }
    await assertSafeBackupPath(destinationPath, excludedRoots, true);
    await fs.writeFile(destinationPath, Buffer.from(snapshot.contentBase64, 'base64'), { flag: 'wx' });
    return;
  }

  await assertSafeBackupPath(destinationPath, excludedRoots, true);
  await fs.mkdir(destinationPath);
  await exportDirectory(snapshot, destinationPath, excludedRoots);
}

async function exportDirectory(
  directory: MergeSnapshotDirectory,
  destinationPath: string,
  excludedRoots: readonly string[],
): Promise<void> {
  for (const entry of directory.children) {
    assertSafeRelativeEntry(entry);
    const childPath = path.join(destinationPath, basename(entry.relativePath));
    if (entry.type === 'directory') {
      await assertSafeBackupPath(childPath, excludedRoots, true);
      await fs.mkdir(childPath);
      await exportDirectory(entry, childPath, excludedRoots);
    } else {
      if (entry.contentBase64 === undefined) {
        throw new Error(`Captured backup bytes are unavailable for ${childPath}`);
      }
      await assertSafeBackupPath(childPath, excludedRoots, true);
      await fs.writeFile(childPath, Buffer.from(entry.contentBase64, 'base64'), { flag: 'wx' });
    }
  }
}

function assertSafeRelativeEntry(entry: MergeSnapshotEntry): void {
  const relativePath = entry.relativePath;
  const segments = relativePath.split(path.sep);
  if (
    !relativePath
    || path.isAbsolute(relativePath)
    || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))
  ) {
    throw new Error(`Backup manifest contains an unsafe relative entry: ${entry.relativePath}`);
  }
}

function basename(relativePath: string): string {
  return path.basename(relativePath);
}

function filePathFromUri(uri: string): string {
  try {
    return path.resolve(fileURLToPath(uri));
  } catch {
    throw new Error(`Backup artifact URI is not a local file URI: ${uri}`);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST';
}
