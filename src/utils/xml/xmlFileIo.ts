import * as fs from 'fs';
import { Logger } from '../logger';
import { xmlBuilder } from './xmlCore';

export function buildXmlString(data: unknown): string {
  return xmlBuilder.build(data);
}

/**
 * Replace file contents with UTF-8 text, keeping a .bak of the previous content.
 * Restores from backup if the write fails; removes .bak after a successful write.
 */
export async function writeUtf8FileWithBackup(
  filePath: string,
  originalContent: string,
  newContent: string
): Promise<void> {
  const backupPath = `${filePath}.bak`;
  try {
    await fs.promises.writeFile(backupPath, originalContent, 'utf-8');
  } catch (backupErr) {
    Logger.warn(`Failed to create backup ${backupPath}`, backupErr);
  }

  try {
    await fs.promises.writeFile(filePath, newContent, 'utf-8');
  } catch (writeError) {
    Logger.error(`Failed to write file: ${filePath}`, writeError);
    try {
      if (fs.existsSync(backupPath)) {
        const restored = await fs.promises.readFile(backupPath, 'utf-8');
        await fs.promises.writeFile(filePath, restored, 'utf-8');
        Logger.info(`Rolled back ${filePath} from backup`);
      }
    } catch (rollbackErr) {
      Logger.error(`Rollback failed for ${filePath}`, rollbackErr);
    } finally {
      // Always clean up backup file even if rollback failed
      try {
        await fs.promises.unlink(backupPath);
      } catch {
        Logger.debug(`Could not remove backup after failed write ${backupPath}`);
      }
    }
    throw new Error(
      `Unable to write to file. Check file permissions and disk space. ${
        writeError instanceof Error ? writeError.message : String(writeError)
      }`
    );
  }

  try {
    await fs.promises.unlink(backupPath);
  } catch {
    Logger.debug(`Could not remove backup ${backupPath}`);
  }
}
