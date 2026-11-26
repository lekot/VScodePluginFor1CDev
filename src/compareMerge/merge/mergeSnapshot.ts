import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { Dirent } from 'fs';

import {
  calculateDirectoryFingerprintFromEntries,
  type DirectoryFingerprintEntry,
} from '../../services/configurationSession/mutationPlan';
import { throwIfCompareCancelled, type CompareCancellationToken } from '../compareCancellation';
import { probeXmlRootExpandedName } from '../xml/xmlRootProbe';

export interface MergeSnapshotFile {
  readonly state: 'file';
  readonly relativePath: string;
  readonly type: 'file';
  readonly contentBase64?: string;
  readonly hash: string;
  readonly rootExpandedName?: string;
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

interface SnapshotFilePath {
  readonly filePath: string;
  readonly relativePath: string;
}

/** Captures regular files and directories without following links or special entries. */
export async function captureMergePath(
  filePath: string,
  options: {
    readonly retainContent?: boolean;
    readonly probeXmlRootNames?: boolean;
    readonly cancellation?: CompareCancellationToken;
  } = {},
): Promise<MergePathSnapshot> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    throwIfCompareCancelled(options.cancellation);
    stat = await fs.lstat(filePath);
    throwIfCompareCancelled(options.cancellation);
  } catch (error) {
    throwIfCompareCancelled(options.cancellation);
    if (isMissing(error)) {
      return { state: 'missing' };
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Merge snapshot refuses symbolic links: ${filePath}`);
  }
  if (stat.isFile()) {
    if (options.retainContent === false) {
      return captureHashOnlyFile(filePath, '', options.probeXmlRootNames === true, options.cancellation);
    }
    return captureRetainedFile(filePath, '', options.probeXmlRootNames === true, options.cancellation);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Merge snapshot refuses special filesystem entries: ${filePath}`);
  }

  return captureDirectory(filePath, '', options.retainContent !== false, options.probeXmlRootNames === true, options.cancellation);
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
  probeXmlRootNames: boolean,
  cancellation?: CompareCancellationToken,
): Promise<MergeSnapshotDirectory> {
  throwIfCompareCancelled(cancellation);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    throwIfCompareCancelled(cancellation);
    throw error;
  }
  throwIfCompareCancelled(cancellation);
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
  const captured = retainContent
    ? await captureRetainedDirectoryEntries(directoryPath, relativePath, sortedEntries, probeXmlRootNames, cancellation)
    : await captureHashOnlyDirectoryEntries(directoryPath, relativePath, sortedEntries, probeXmlRootNames, cancellation);

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
  throwIfCompareCancelled(cancellation);
  return { state: 'directory', relativePath, type: 'directory', children: captured, mergeHash, mutationFingerprint };
}

async function captureRetainedDirectoryEntries(
  directoryPath: string,
  relativePath: string,
  entries: readonly Dirent[],
  probeXmlRootNames: boolean,
  cancellation?: CompareCancellationToken,
): Promise<MergeSnapshotEntry[]> {
  const captured: MergeSnapshotEntry[] = [];
  for (const entry of entries) {
    throwIfCompareCancelled(cancellation);
    const entryPath = path.join(directoryPath, entry.name);
    const childRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Merge snapshot refuses symbolic links: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      captured.push(await captureDirectory(entryPath, childRelativePath, true, probeXmlRootNames, cancellation));
      throwIfCompareCancelled(cancellation);
      continue;
    }
    if (entry.isFile()) {
      captured.push(await captureRetainedFile(entryPath, childRelativePath, probeXmlRootNames, cancellation));
      continue;
    }
    throw new Error(`Merge snapshot refuses special filesystem entries: ${entryPath}`);
  }
  return captured;
}

async function captureHashOnlyDirectoryEntries(
  directoryPath: string,
  relativePath: string,
  entries: readonly Dirent[],
  probeXmlRootNames: boolean,
  cancellation?: CompareCancellationToken,
): Promise<MergeSnapshotEntry[]> {
  const captured: MergeSnapshotEntry[] = [];
  let index = 0;
  while (index < entries.length) {
    throwIfCompareCancelled(cancellation);
    const entry = entries[index]!;
    const entryPath = path.join(directoryPath, entry.name);
    const childRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Merge snapshot refuses symbolic links: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      captured.push(await captureDirectory(entryPath, childRelativePath, false, probeXmlRootNames, cancellation));
      throwIfCompareCancelled(cancellation);
      index += 1;
      continue;
    }
    if (entry.isFile()) {
      const batch = collectAdjacentFileBatch(directoryPath, relativePath, entries, index);
      captured.push(...await captureHashOnlyBatch(batch.files, probeXmlRootNames, cancellation));
      index = batch.nextIndex;
      continue;
    }
    throw new Error(`Merge snapshot refuses special filesystem entries: ${entryPath}`);
  }
  return captured;
}

function collectAdjacentFileBatch(
  directoryPath: string,
  relativePath: string,
  entries: readonly Dirent[],
  startIndex: number,
): { readonly files: SnapshotFilePath[]; readonly nextIndex: number } {
  const files: SnapshotFilePath[] = [];
  let index = startIndex;
  while (index < entries.length && files.length < 2 && entries[index]!.isFile()) {
    const entry = entries[index]!;
    files.push({
      filePath: path.join(directoryPath, entry.name),
      relativePath: relativePath ? path.join(relativePath, entry.name) : entry.name,
    });
    index += 1;
  }
  return { files, nextIndex: index };
}

async function captureRetainedFile(
  filePath: string,
  relativePath: string,
  probeXmlRootNames: boolean,
  cancellation?: CompareCancellationToken,
): Promise<MergeSnapshotFile> {
  const content = await readFileWithCancellation(filePath, cancellation);
  const rootExpandedName = probeXmlRootNames && shouldProbeXmlRoot(filePath)
    ? probeXmlRootExpandedName(content.subarray(0, 64 * 1024).toString('utf8'))
    : undefined;
  return {
    state: 'file',
    relativePath,
    type: 'file',
    contentBase64: content.toString('base64'),
    hash: hashBuffer(content),
    ...(rootExpandedName ? { rootExpandedName } : {}),
  };
}

async function captureHashOnlyBatch(
  files: readonly SnapshotFilePath[],
  probeXmlRootNames: boolean,
  cancellation?: CompareCancellationToken,
): Promise<MergeSnapshotFile[]> {
  const results = await Promise.allSettled(files.map((file) =>
    captureHashOnlyFile(file.filePath, file.relativePath, probeXmlRootNames, cancellation),
  ));
  throwIfCompareCancelled(cancellation);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    throw failure.reason;
  }
  return results.map((result) => {
    if (result.status !== 'fulfilled') {
      throw result.reason;
    }
    return result.value;
  });
}

async function captureHashOnlyFile(
  filePath: string,
  relativePath: string,
  probeXmlRootNames: boolean,
  cancellation?: CompareCancellationToken,
): Promise<MergeSnapshotFile> {
  const probeXml = probeXmlRootNames && shouldProbeXmlRoot(filePath);
  throwIfCompareCancelled(cancellation);
  const handle = await fs.open(filePath, 'r');
  let snapshot: MergeSnapshotFile | undefined;
  let captureFailure: unknown;
  let captureFailed = false;
  try {
    snapshot = await readHashOnlyFile(handle, relativePath, probeXml, cancellation);
  } catch (error) {
    captureFailure = error;
    captureFailed = true;
  }

  let closeFailure: unknown;
  let closeFailed = false;
  try {
    await handle.close();
  } catch (error) {
    closeFailure = error;
    closeFailed = true;
  }
  if (captureFailed) { throw captureFailure; }
  if (closeFailed) { throw closeFailure; }
  throwIfCompareCancelled(cancellation);
  return snapshot!;
}

async function readHashOnlyFile(
  handle: Awaited<ReturnType<typeof fs.open>>,
  relativePath: string,
  probeXml: boolean,
  cancellation?: CompareCancellationToken,
): Promise<MergeSnapshotFile> {
  const probePrefix = probeXml ? Buffer.alloc(64 * 1024) : undefined;
  const hash = createHash('sha256');
  const readBuffer = Buffer.alloc(64 * 1024);
  let probeBytes = 0;
  let reachedEnd = false;
  while (!reachedEnd) {
    throwIfCompareCancelled(cancellation);
    let result: Awaited<ReturnType<typeof handle.read>>;
    try {
      result = await handle.read(readBuffer, 0, readBuffer.length, null);
    } catch (error) {
      throwIfCompareCancelled(cancellation);
      throw error;
    }
    throwIfCompareCancelled(cancellation);
    if (result.bytesRead === 0) {
      reachedEnd = true;
      continue;
    }
    const chunk = readBuffer.subarray(0, result.bytesRead);
    hash.update(chunk);
    if (probePrefix && probeBytes < probePrefix.length) {
      const copiedBytes = Math.min(chunk.length, probePrefix.length - probeBytes);
      chunk.copy(probePrefix, probeBytes, 0, copiedBytes);
      probeBytes += copiedBytes;
    }
  }
  const rootExpandedName = probePrefix
    ? probeXmlRootExpandedName(probePrefix.subarray(0, probeBytes).toString('utf8'))
    : undefined;
  return {
    state: 'file',
    relativePath,
    type: 'file',
    contentBase64: undefined,
    hash: hash.digest('hex'),
    ...(rootExpandedName ? { rootExpandedName } : {}),
  };
}

async function readFileWithCancellation(filePath: string, cancellation?: CompareCancellationToken): Promise<Buffer> {
  throwIfCompareCancelled(cancellation);
  try {
    const content = await fs.readFile(filePath);
    throwIfCompareCancelled(cancellation);
    return content;
  } catch (error) {
    throwIfCompareCancelled(cancellation);
    throw error;
  }
}

function shouldProbeXmlRoot(filePath: string): boolean {
  const name = path.basename(filePath).toLocaleLowerCase('en-US');
  return name === 'rights.xml' || name === 'template.xml';
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
