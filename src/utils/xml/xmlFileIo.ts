import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { configurationPathKey } from '../configurationPathIdentity';
import { Logger } from '../logger';
import { xmlBuilder } from './xmlCore';

export function buildXmlString(data: unknown): string {
  return xmlBuilder.build(data);
}

/**
 * Hooks for customizing file operations during write with backup.
 * @internal Test hook only.
 */
export interface WriteUtf8BackupHooks {
  writeFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  unlink?: (path: string) => Promise<void>;
}

/**
 * Options for writeUtf8FileWithBackup.
 * @internal Test options only.
 */
export interface WriteUtf8FileWithBackupOptions {
  hooks?: WriteUtf8BackupHooks;
}

/**
 * Error thrown when writing a file fails and subsequent rollback to original content also fails.
 * Preserves the disk path to the recovery backup and both underlying errors.
 */
export class XmlWriteRollbackError extends Error {
  constructor(
    readonly backupPath: string,
    readonly writeError: unknown,
    readonly rollbackError: unknown
  ) {
    const writeMsg = writeError instanceof Error ? writeError.message : String(writeError);
    const rollbackMsg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    super(
      `Unable to write to file and rollback failed. Recovery backup preserved at: ${backupPath}. ` +
      `Write error: ${writeMsg}. Rollback error: ${rollbackMsg}`
    );
    this.name = 'XmlWriteRollbackError';
  }
}

const fileWriteLocks = new Map<string, Promise<void>>();

async function acquireFileLock(filePath: string): Promise<() => void> {
  const canonical = configurationPathKey(filePath);
  const current = fileWriteLocks.get(canonical) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = current.then(() => next, () => next);
  fileWriteLocks.set(canonical, chained);
  await current.catch(() => undefined);
  return () => {
    release();
    if (fileWriteLocks.get(canonical) === chained) {
      fileWriteLocks.delete(canonical);
    }
  };
}

function generateBackupPath(filePath: string): string {
  return `${filePath}.${Date.now()}-${randomUUID()}.bak`;
}

/**
 * Replace file contents with UTF-8 text, keeping a unique .bak of the previous content.
 * Restores from backup if the write fails; removes .bak after a successful write or successful rollback.
 * If both write and rollback fail, preserves the backup file on disk and reports where it is retained.
 */
export async function writeUtf8FileWithBackup(
  filePath: string,
  originalContent: string,
  newContent: string,
  options?: WriteUtf8FileWithBackupOptions
): Promise<void> {
  const releaseLock = await acquireFileLock(filePath);
  try {
    const writeFile = options?.hooks?.writeFile ?? ((p, d, e) => fs.promises.writeFile(p, d, e));
    const unlink = options?.hooks?.unlink ?? ((p) => fs.promises.unlink(p));

    const backupPath = generateBackupPath(filePath);
    try {
      await writeFile(backupPath, originalContent, 'utf-8');
    } catch (backupErr) {
      Logger.error(`Failed to create backup ${backupPath}`, backupErr);
      const msg = backupErr instanceof Error ? backupErr.message : String(backupErr);
      throw new Error(`Failed to create backup: ${backupPath}. ${msg}`);
    }

    try {
      await writeFile(filePath, newContent, 'utf-8');
    } catch (writeError) {
      Logger.error(`Failed to write file: ${filePath}`, writeError);
      let rollbackSucceeded = false;
      let rollbackError: unknown;
      try {
        await writeFile(filePath, originalContent, 'utf-8');
        rollbackSucceeded = true;
        Logger.info(`Rolled back ${filePath} from backup`);
      } catch (rErr) {
        rollbackError = rErr;
        Logger.error(`Rollback failed for ${filePath}`, rErr);
      }

      if (rollbackSucceeded) {
        try {
          await unlink(backupPath);
        } catch {
          Logger.debug(`Could not remove backup after successful rollback ${backupPath}`);
        }
        const writeMsg = writeError instanceof Error ? writeError.message : String(writeError);
        throw new Error(
          `Unable to write to file. Check file permissions and disk space. ${writeMsg}`
        );
      } else {
        // Rollback failed: PRESERVE BACKUP FILE on disk! Do NOT unlink!
        throw new XmlWriteRollbackError(backupPath, writeError, rollbackError);
      }
    }

    try {
      await unlink(backupPath);
    } catch {
      Logger.debug(`Could not remove backup ${backupPath}`);
    }
  } finally {
    releaseLock();
  }
}
