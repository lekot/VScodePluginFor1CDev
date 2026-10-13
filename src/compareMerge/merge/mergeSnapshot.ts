import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

import {
  calculateDirectoryFingerprintFromEntries,
  type DirectoryFingerprintEntry,
} from '../../services/configurationSession/mutationPlan';

export interface MergeSnapshotFile {
  readonly state: 'file';
  readonly relativePath: string;
  readonly type: 'file';
  readonly contentBase64?: string;
  readonly hash: string;
}

export interface MergeSnapshotDirectory {
  readonly state: 'directory';
  readonly relativePath: string;
  readonly type: 'directory';
  readonly children: readonly MergeSnapshotEntry[];
  readonly mergeHash: string;
  readonly mutationFingerprint: string;
}

export type MergeSnapshotEntry = MergeSnapshotFile | MergeSnapshotDirectory;

export type MergePathSnapshot =
  | { readonly state: 'missing' }
  | MergeSnapshotFile
  | MergeSnapshotDirectory;

/** Captures regular files and directories without following links or special entries. */
export async function captureMergePath(
  filePath: string,
  options: { readonly retainContent?: boolean } = {},
): Promise<MergePathSnapshot> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (isMissing(error)) {
      return { state: 'missing' };
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Merge snapshot refuses symbolic links: ${filePath}`);
  }
  if (stat.isFile()) {
    const content = await fs.readFile(filePath);
    return {
      state: 'file',
      relativePath: '',
      type: 'file',
      contentBase64: options.retainContent === false ? undefined : content.toString('base64'),
      hash: hashBuffer(content),
    };
  }
  if (!stat.isDirectory()) {
    throw new Error(`Merge snapshot refuses special filesystem entries: ${filePath}`);
  }

  return captureDirectory(filePath, '', options.retainContent !== false);
}

/** Hash format matches the established compare/merge folder-preview algorithm. */
export function mergeSnapshotHash(snapshot: MergePathSnapshot): string {
  if (snapshot.state === 'missing') {
    throw new Error('A missing path has no merge snapshot hash.');
  }
  return snapshot.type === 'file' ? snapshot.hash : snapshot.mergeHash;
}

/** Fingerprint format is the one used by MutationPlan directory expectations. */
export function mutationFingerprint(snapshot: MergePathSnapshot): string {
  if (snapshot.state === 'missing' || snapshot.type !== 'directory') {
    throw new Error('Only a captured directory has a mutation fingerprint.');
  }
  return snapshot.mutationFingerprint;
}

export function mutationEntriesForDirectory(
  snapshot: MergeSnapshotDirectory,
): readonly DirectoryFingerprintEntry[] {
  return snapshot.children.map((entry) => entry.type === 'file'
    ? { name: basename(entry.relativePath), type: 'file', hash: entry.hash }
    : {
        name: basename(entry.relativePath),
        type: 'directory',
        fingerprint: entry.mutationFingerprint,
      });
}

async function captureDirectory(
  directoryPath: string,
  relativePath: string,
  retainContent: boolean,
): Promise<MergeSnapshotDirectory> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const captured: MergeSnapshotEntry[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directoryPath, entry.name);
    const childRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Merge snapshot refuses symbolic links: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      captured.push(await captureDirectory(entryPath, childRelativePath, retainContent));
      continue;
    }
    if (entry.isFile()) {
      const content = await fs.readFile(entryPath);
      captured.push({
        state: 'file',
        relativePath: childRelativePath,
        type: 'file',
        contentBase64: retainContent ? content.toString('base64') : undefined,
        hash: hashBuffer(content),
      });
      continue;
    }
    throw new Error(`Merge snapshot refuses special filesystem entries: ${entryPath}`);
  }

  const mergeParts = captured.map((entry) => entry.type === 'file'
    ? `file:${basename(entry.relativePath)}:${entry.hash}`
    : `dir:${basename(entry.relativePath)}:${entry.mergeHash}`);
  const mergeHash = hashText(mergeParts.join('\n'));
  const fingerprintEntries: DirectoryFingerprintEntry[] = captured.map((entry) => entry.type === 'file'
    ? { name: basename(entry.relativePath), type: 'file', hash: entry.hash }
    : {
        name: basename(entry.relativePath),
        type: 'directory',
        fingerprint: entry.mutationFingerprint,
      });
  const mutationFingerprint = calculateDirectoryFingerprintFromEntries(fingerprintEntries);
  return { state: 'directory', relativePath, type: 'directory', children: captured, mergeHash, mutationFingerprint };
}

function hashBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function hashText(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function basename(relativePath: string): string {
  return path.basename(relativePath);
}
