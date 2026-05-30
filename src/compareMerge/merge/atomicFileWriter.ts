import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

import { hashText } from '../bsl/bslRoutineLogicalScanner';
import type { CompareMessage } from '../domain/compareContracts';

export interface AtomicWriteFileHandle {
  writeFile(content: string, encoding: 'utf8'): Promise<void>;
  sync?(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicWriteFileSystem {
  mkdir(directoryPath: string, options: { recursive: true }): Promise<unknown>;
  realpath(filePath: string): Promise<string>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  open(filePath: string, flags: 'wx'): Promise<AtomicWriteFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  copyFile(sourcePath: string, targetPath: string): Promise<void>;
  rm(filePath: string, options: { force: true }): Promise<void>;
}

export interface AtomicWriteRestoreResult {
  attempted: boolean;
  ok: boolean;
  code?: string;
  message?: string;
}

export type AtomicWriteResult =
  | {
      ok: true;
      targetPath: string;
      backupPath: string;
      newHash: string;
      diagnostics: [];
    }
  | {
      ok: false;
      code: string;
      message: string;
      targetPath?: string;
      backupPath?: string;
      restore?: AtomicWriteRestoreResult;
      diagnostics: CompareMessage[];
    };

export interface AtomicWriteInput {
  rootUri?: string;
  targetUri: string;
  backupPath: string;
  expectedOldHash: string;
  nextContent: string;
  newHash: string;
  sourceId?: string;
  nodeId?: string;
  tempNameFactory?: () => string;
  fileSystem?: AtomicWriteFileSystem;
}

const nodeFileSystem: AtomicWriteFileSystem = {
  mkdir(directoryPath, options) {
    return fs.mkdir(directoryPath, options);
  },
  realpath(filePath) {
    return fs.realpath(filePath);
  },
  readFile(filePath, encoding) {
    return fs.readFile(filePath, encoding);
  },
  open(filePath, flags) {
    return fs.open(filePath, flags);
  },
  rename(oldPath, newPath) {
    return fs.rename(oldPath, newPath);
  },
  copyFile(sourcePath, targetPath) {
    return fs.copyFile(sourcePath, targetPath);
  },
  rm(filePath, options) {
    return fs.rm(filePath, options);
  },
};

export async function writeAtomicWithBackup(input: AtomicWriteInput): Promise<AtomicWriteResult> {
  const fileSystem = input.fileSystem ?? nodeFileSystem;
  const targetPath = uriToPath(input.targetUri);
  if (!targetPath) {
    return failure('MERGE_TARGET_GUARD_MISSING', 'Target uri is not a file uri.', input);
  }

  const boundaryFailure = await validateCanonicalBoundary(input, targetPath, fileSystem);
  if (boundaryFailure) {
    return boundaryFailure;
  }

  const currentSourceResult = await readTarget(targetPath, fileSystem, input);
  if (!currentSourceResult.ok) {
    return currentSourceResult.result;
  }

  if (hashText(currentSourceResult.source) !== input.expectedOldHash) {
    return failure(
      'MERGE_STALE_TARGET_HASH',
      'Target file hash changed before atomic merge execution.',
      input,
      targetPath
    );
  }

  let backupCreated = false;
  let tempPath: string | undefined;
  try {
    await fileSystem.mkdir(path.dirname(input.backupPath), { recursive: true });
    await writeExclusive(fileSystem, input.backupPath, currentSourceResult.source, 'backup');
    backupCreated = true;

    const latestSource = await fileSystem.readFile(targetPath, 'utf8');
    if (hashText(latestSource) !== input.expectedOldHash) {
      return await failAfterBackup(
        input,
        fileSystem,
        targetPath,
        undefined,
        'MERGE_STALE_TARGET_HASH',
        'Target file hash changed immediately before replacement.'
      );
    }

    tempPath = path.join(path.dirname(targetPath), input.tempNameFactory?.() ?? randomTempName());
    await writeExclusive(fileSystem, tempPath, input.nextContent, 'temp');
    await fileSystem.rename(tempPath, targetPath);
    tempPath = undefined;

    const writtenSource = await fileSystem.readFile(targetPath, 'utf8');
    const writtenHash = hashText(writtenSource);
    if (writtenHash !== input.newHash) {
      return await failAfterBackup(
        input,
        fileSystem,
        targetPath,
        tempPath,
        'MERGE_POST_WRITE_HASH_MISMATCH',
        'Target file hash after replacement does not match merge preview hash.'
      );
    }

    return {
      ok: true,
      targetPath,
      backupPath: input.backupPath,
      newHash: writtenHash,
      diagnostics: [],
    };
  } catch (error) {
    const code = classifyWriteError(
      error,
      backupCreated ? 'MERGE_WRITE_FAILED' : 'MERGE_BACKUP_WRITE_FAILED'
    );
    const message = `${backupCreated ? 'Atomic merge write failed' : 'Backup creation failed'}: ${errorMessage(
      error
    )}`;
    if (!backupCreated) {
      return failure(code, message, input, targetPath, input.backupPath);
    }

    return failAfterBackup(input, fileSystem, targetPath, tempPath, code, message);
  } finally {
    if (tempPath) {
      await removeTemp(fileSystem, tempPath);
    }
  }
}

async function validateCanonicalBoundary(
  input: AtomicWriteInput,
  targetPath: string,
  fileSystem: AtomicWriteFileSystem
): Promise<AtomicWriteResult | undefined> {
  if (!input.rootUri) {
    return undefined;
  }

  const rootPath = uriToPath(input.rootUri);
  if (!rootPath) {
    return failure(
      'MERGE_TARGET_ROOT_MISSING',
      'Left configuration root uri is not a file uri.',
      input,
      targetPath
    );
  }

  try {
    const canonicalRoot = await fileSystem.realpath(rootPath);
    const canonicalTarget = await fileSystem.realpath(targetPath);
    if (!isPathInsideRoot(canonicalRoot, canonicalTarget)) {
      return failure(
        'MERGE_TARGET_OUTSIDE_ROOT',
        'Merge target file is outside the left configuration root.',
        input,
        targetPath
      );
    }
  } catch (error) {
    return failure(
      'MERGE_TARGET_READ_FAILED',
      `Failed to canonicalize merge target path: ${errorMessage(error)}`,
      input,
      targetPath
    );
  }

  return undefined;
}

async function readTarget(
  targetPath: string,
  fileSystem: AtomicWriteFileSystem,
  input: AtomicWriteInput
): Promise<{ ok: true; source: string } | { ok: false; result: AtomicWriteResult }> {
  try {
    return {
      ok: true,
      source: await fileSystem.readFile(targetPath, 'utf8'),
    };
  } catch (error) {
    return {
      ok: false,
      result: failure(
        'MERGE_TARGET_READ_FAILED',
        `Failed to read target file: ${errorMessage(error)}`,
        input,
        targetPath
      ),
    };
  }
}

async function writeExclusive(
  fileSystem: AtomicWriteFileSystem,
  filePath: string,
  content: string,
  kind: 'backup' | 'temp'
): Promise<void> {
  let handle: AtomicWriteFileHandle | undefined;
  try {
    handle = await fileSystem.open(filePath, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync?.();
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new ExclusivePathExistsError(kind);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function failAfterBackup(
  input: AtomicWriteInput,
  fileSystem: AtomicWriteFileSystem,
  targetPath: string,
  tempPath: string | undefined,
  code: string,
  message: string
): Promise<AtomicWriteResult> {
  if (tempPath) {
    await removeTemp(fileSystem, tempPath);
  }

  const restore = await restoreFromBackup(fileSystem, input.backupPath, targetPath);
  const diagnostics = restore.ok
    ? []
    : [
        diagnostic(
          'MERGE_RESTORE_FAILED',
          `Failed to restore target from backup after merge failure: ${restore.message ?? 'unknown error'}`,
          input,
          targetPath
        ),
      ];

  return {
    ok: false,
    code,
    message,
    targetPath,
    backupPath: input.backupPath,
    restore,
    diagnostics,
  };
}

async function restoreFromBackup(
  fileSystem: AtomicWriteFileSystem,
  backupPath: string,
  targetPath: string
): Promise<AtomicWriteRestoreResult> {
  try {
    await fileSystem.copyFile(backupPath, targetPath);
    return {
      attempted: true,
      ok: true,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      code: 'MERGE_RESTORE_FAILED',
      message: errorMessage(error),
    };
  }
}

async function removeTemp(fileSystem: AtomicWriteFileSystem, tempPath: string): Promise<void> {
  try {
    await fileSystem.rm(tempPath, { force: true });
  } catch {
    // Best effort cleanup. The caller receives the primary write/restore failure.
  }
}

function failure(
  code: string,
  message: string,
  input: AtomicWriteInput,
  targetPath?: string,
  backupPath?: string
): AtomicWriteResult {
  return {
    ok: false,
    code,
    message,
    targetPath,
    backupPath,
    diagnostics: [diagnostic(code, message, input, targetPath)],
  };
}

function diagnostic(
  code: string,
  message: string,
  input: AtomicWriteInput,
  targetPath?: string
): CompareMessage {
  return {
    severity: 'error',
    code,
    phase: 'execute',
    sourceId: input.sourceId ?? 'unknown-source',
    nodeId: input.nodeId,
    path: targetPath ?? input.targetUri,
    blocking: true,
    suggestedAction: message,
  };
}

function randomTempName(): string {
  return `.merge-${randomUUID()}.tmp`;
}

function uriToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const root = normalizeBoundaryPath(rootPath);
  const target = normalizeBoundaryPath(targetPath);
  return (
    target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
  );
}

function normalizeBoundaryPath(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function classifyWriteError(error: unknown, fallback: string): string {
  if (error instanceof ExclusivePathExistsError) {
    return error.kind === 'backup' ? 'MERGE_BACKUP_EXISTS' : 'MERGE_TEMP_EXISTS';
  }

  return fallback;
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ExclusivePathExistsError extends Error {
  constructor(readonly kind: 'backup' | 'temp') {
    super(`${kind} path already exists`);
  }
}
