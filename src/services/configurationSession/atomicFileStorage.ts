import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { assertNoSymlinkSegments, assertPathWithinRoot, PathBoundaryError } from './pathBoundary';

export type StorageOutcome =
  | { status: 'committed'; targetPath: string; newHash: string }
  | { status: 'conflict'; code: 'STALE_TARGET_HASH' | 'TARGET_OUTSIDE_ROOT'; message: string }
  | { status: 'rolledBack'; code: 'WRITE_FAILED'; message: string }
  | { status: 'recoveryRequired'; code: 'POST_WRITE_VALIDATION_FAILED'; message: string };

export interface AtomicFileHandle {
  writeFile(data: string | Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicFileSystem {
  readFile(filePath: string): Promise<Buffer>;
  open(filePath: string, flags: 'wx'): Promise<AtomicFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(filePath: string, options: { force: true }): Promise<void>;
}

const nodeFileSystem: AtomicFileSystem = {
  readFile(filePath) {
    return fs.readFile(filePath);
  },
  open(filePath, flags) {
    return fs.open(filePath, flags);
  },
  rename(oldPath, newPath) {
    return fs.rename(oldPath, newPath);
  },
  rm(filePath, options) {
    return fs.rm(filePath, options);
  },
};
const atomicMutationTails = new Map<string, Promise<void>>();

/** Tier-1 single-file compare-and-swap storage. */
export class AtomicFileStorage {
  constructor(
    readonly rootPath: string,
    private readonly fileSystem: AtomicFileSystem = nodeFileSystem,
  ) {}

  async replace(
    targetPath: string,
    content: string | Uint8Array,
    expectedHash: string,
  ): Promise<StorageOutcome> {
    let canonicalTarget: string;
    let canonicalRoot: string;
    try {
      ({ canonicalRoot, canonicalTarget } = await assertPathWithinRoot(this.rootPath, targetPath));
    } catch (error) {
      if (error instanceof PathBoundaryError) {
        return { status: 'conflict', code: 'TARGET_OUTSIDE_ROOT', message: error.message };
      }
      throw error;
    }

    const release = await acquireAtomicMutationLock(canonicalTarget);
    try {
    let current: Buffer;
    try {
      current = await this.fileSystem.readFile(canonicalTarget);
    } catch (error) {
      return { status: 'rolledBack', code: 'WRITE_FAILED', message: errorMessage(error) };
    }
    if (hashContent(current) !== expectedHash) {
      return {
        status: 'conflict',
        code: 'STALE_TARGET_HASH',
        message: 'Файл изменился после чтения; запись отменена.',
      };
    }

    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const expectedNewHash = hashContent(bytes);
    const tempPath = path.join(path.dirname(canonicalTarget), `.cdt-${randomUUID()}.tmp`);
    let handle: AtomicFileHandle | undefined;
    let replaced = false;
    try {
      handle = await this.fileSystem.open(tempPath, 'wx');
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;

      // Revalidate both namespace containment and the old content immediately before effect.
      const revalidated = await assertPathWithinRoot(this.rootPath, targetPath);
      if (revalidated.canonicalTarget !== canonicalTarget) {
        throw new PathBoundaryError(
          'PATH_OUTSIDE_ROOT',
          `Target namespace changed during atomic replacement: ${targetPath}`,
          targetPath,
        );
      }
      await assertNoSymlinkSegments(canonicalRoot, canonicalTarget);
      const latest = await this.fileSystem.readFile(canonicalTarget);
      if (hashContent(latest) !== expectedHash) {
        return {
          status: 'conflict',
          code: 'STALE_TARGET_HASH',
          message: 'Файл изменился непосредственно перед заменой; запись отменена.',
        };
      }

      await this.fileSystem.rename(tempPath, canonicalTarget);
      replaced = true;
      const written = await this.fileSystem.readFile(canonicalTarget);
      const newHash = hashContent(written);
      if (newHash !== expectedNewHash) {
        return {
          status: 'recoveryRequired',
          code: 'POST_WRITE_VALIDATION_FAILED',
          message: 'Хэш файла после атомарной замены не совпадает с ожидаемым.',
        };
      }
      return { status: 'committed', targetPath: canonicalTarget, newHash };
    } catch (error) {
      if (error instanceof PathBoundaryError) {
        return { status: 'conflict', code: 'TARGET_OUTSIDE_ROOT', message: error.message };
      }
      const classified = await this.classifyAmbiguousOutcome(
        canonicalTarget,
        expectedHash,
        expectedNewHash,
        error,
      );
      replaced = classified.status === 'committed';
      return classified;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!replaced) {
        await this.fileSystem.rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
    } finally {
      release();
    }
  }

  private async classifyAmbiguousOutcome(
    canonicalTarget: string,
    expectedOldHash: string,
    expectedNewHash: string,
    cause: unknown,
  ): Promise<StorageOutcome> {
    try {
      const actualHash = hashContent(await this.fileSystem.readFile(canonicalTarget));
      if (actualHash === expectedNewHash) {
        return { status: 'committed', targetPath: canonicalTarget, newHash: actualHash };
      }
      if (actualHash === expectedOldHash) {
        return { status: 'rolledBack', code: 'WRITE_FAILED', message: errorMessage(cause) };
      }
      return {
        status: 'recoveryRequired',
        code: 'POST_WRITE_VALIDATION_FAILED',
        message: `Atomic replacement has an unknown post-state. ${errorMessage(cause)}`,
      };
    } catch (classificationError) {
      return {
        status: 'recoveryRequired',
        code: 'POST_WRITE_VALIDATION_FAILED',
        message: `Atomic replacement post-state is unreadable. ${errorMessage(cause)} ${errorMessage(classificationError)}`,
      };
    }
  }
}

async function acquireAtomicMutationLock(targetPath: string): Promise<() => void> {
  const key = process.platform === 'win32' ? targetPath.toLocaleLowerCase() : targetPath;
  const previous = atomicMutationTails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const tail = previous.then(() => gate, () => gate);
  atomicMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  return () => {
    releaseGate();
    if (atomicMutationTails.get(key) === tail) {
      atomicMutationTails.delete(key);
    }
  };
}

export function hashContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
