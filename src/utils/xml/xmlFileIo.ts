import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';
import { xmlBuilder } from './xmlCore';

export function buildXmlString(data: unknown): string {
  return xmlBuilder.build(data);
}

export interface WriteUtf8BackupHooks {
  writeFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  unlink?: (path: string) => Promise<void>;
}

export interface WriteUtf8FileWithBackupOptions {
  hooks?: WriteUtf8BackupHooks;
}

const fileWriteLocks = new Map<string, Promise<void>>();

async function acquireFileLock(filePath: string): Promise<() => void> {
  const canonical = path.resolve(filePath);
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
    const readFile = options?.hooks?.readFile ?? ((p, e) => fs.promises.readFile(p, e));
    const unlink = options?.hooks?.unlink ?? ((p) => fs.promises.unlink(p));

    const backupPath = generateBackupPath(filePath);
    let backupCreated = false;
    try {
      await writeFile(backupPath, originalContent, 'utf-8');
      backupCreated = true;
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
      if (backupCreated) {
        try {
          const restored = await readFile(backupPath, 'utf-8');
          await writeFile(filePath, restored, 'utf-8');
          rollbackSucceeded = true;
          Logger.info(`Rolled back ${filePath} from backup`);
        } catch (rErr) {
          rollbackError = rErr;
          Logger.error(`Rollback failed for ${filePath}`, rErr);
        }
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
        const writeMsg = writeError instanceof Error ? writeError.message : String(writeError);
        const rollbackMsg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        const err = new Error(
          `Unable to write to file and rollback failed. Recovery backup preserved at: ${backupPath}. ` +
          `Write error: ${writeMsg}. Rollback error: ${rollbackMsg}`
        );
        Object.assign(err, {
          backupPath,
          writeError,
          rollbackError,
        });
        throw err;
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
