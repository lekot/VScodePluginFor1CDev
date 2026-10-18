import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface ExportedObjectsPublishHooks {
  /** Replace the default recursive copy in tests or in a host with an audited FS wrapper. */
  readonly copyEntry?: (sourcePath: string, destinationPath: string) => Promise<number>;
  readonly rename?: (sourcePath: string, destinationPath: string) => Promise<void>;
  readonly remove?: (targetPath: string, options: { recursive?: boolean; force?: boolean }) => Promise<void>;
}

interface PublishedObjectUnit {
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
  readonly action: 'install' | 'remove';
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly stagingPath: string;
  readonly backupPath: string;
  sourceExists: boolean;
  destinationExists: boolean;
  staged: boolean;
  backedUp: boolean;
  installed: boolean;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function copyTree(srcDir: string, destDir: string): Promise<number> {
  let count = 0;
  for (const entry of await fs.promises.readdir(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await fs.promises.mkdir(destPath, { recursive: true });
      count += await copyTree(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
      count++;
    }
  }
  return count;
}

async function defaultCopyPublishEntry(sourcePath: string, destinationPath: string): Promise<number> {
  const stat = await fs.promises.lstat(sourcePath);
  if (stat.isDirectory()) {
    await fs.promises.mkdir(destinationPath, { recursive: true });
    return copyTree(sourcePath, destinationPath);
  }
  if (stat.isFile()) {
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, destinationPath);
    return 1;
  }
  throw new Error(`Неподдерживаемый тип записи выгрузки: ${sourcePath}`);
}

/**
 * Publishes exported metadata objects from a temporary directory into the workspace
 * configuration root with staging, backup, and atomic rollback guarantees (#350).
 *
 * For each exported object descriptor `<Category>/<Name>.xml`:
 * - Stages the descriptor file and its corresponding object directory `<Category>/<Name>` (if present).
 * - If the object directory existed in destination but not in the export (e.g. all forms/templates
 *   were deleted in the infobase), the stale destination directory is backed up and removed.
 * - Sibling metadata objects and non-metadata workspace files remain untouched.
 * - On failure during install, all changes are rolled back from backup.
 */
export async function publishExportedObjects(
  sourceDir: string,
  destinationDir: string,
  hooks: ExportedObjectsPublishHooks = {},
): Promise<number> {
  const source = path.resolve(sourceDir);
  const destination = path.resolve(destinationDir);
  if (source === destination) {
    throw new Error('Нельзя опубликовать объекты поверх исходного каталога.');
  }
  const sourceStat = await fs.promises.stat(source);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Источник выгрузки не является каталогом: ${source}`);
  }

  const suffix = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const transactionRoot = path.join(destination, `.cdt-objects-publish-${suffix}`);
  const stagingRoot = path.join(transactionRoot, 'staging');
  const backupRoot = path.join(transactionRoot, 'backup');
  const rename = hooks.rename ?? (async (from: string, to: string) => fs.promises.rename(from, to));
  const remove = hooks.remove ?? (async (target: string, options: { recursive?: boolean; force?: boolean }) => {
    await fs.promises.rm(target, options);
  });
  const copyEntry = hooks.copyEntry ?? defaultCopyPublishEntry;

  await fs.promises.mkdir(destination, { recursive: true });
  await fs.promises.mkdir(stagingRoot, { recursive: true });
  await fs.promises.mkdir(backupRoot, { recursive: true });

  const units: PublishedObjectUnit[] = [];
  const handledDirs = new Set<string>();

  const isDir = async (p: string): Promise<boolean> => {
    try {
      const s = await fs.promises.lstat(p);
      return s.isDirectory();
    } catch {
      return false;
    }
  };

  const addUnit = (
    relativePath: string,
    kind: 'file' | 'directory',
    action: 'install' | 'remove',
  ) => {
    units.push({
      relativePath,
      kind,
      action,
      sourcePath: path.join(source, relativePath),
      destinationPath: path.join(destination, relativePath),
      stagingPath: path.join(stagingRoot, relativePath),
      backupPath: path.join(backupRoot, relativePath),
      sourceExists: action === 'install',
      destinationExists: false,
      staged: false,
      backedUp: false,
      installed: false,
    });
  };

  const rootEntries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const rootEntry of rootEntries) {
    if (rootEntry.isFile()) {
      addUnit(rootEntry.name, 'file', 'install');
    } else if (rootEntry.isDirectory()) {
      const categoryName = rootEntry.name;
      const categorySourceDir = path.join(source, categoryName);
      const catEntries = await fs.promises.readdir(categorySourceDir, { withFileTypes: true });

      // First pass: scan files (descriptors)
      for (const catEntry of catEntries) {
        if (catEntry.isFile()) {
          const relFilePath = path.join(categoryName, catEntry.name);
          addUnit(relFilePath, 'file', 'install');

          if (catEntry.name.toLowerCase().endsWith('.xml')) {
            const baseName = catEntry.name.slice(0, -4);
            const relDirPath = path.join(categoryName, baseName);
            const sourceDirPath = path.join(source, relDirPath);
            const destDirPath = path.join(destination, relDirPath);
            handledDirs.add(relDirPath.toLowerCase());

            if (await isDir(sourceDirPath)) {
              addUnit(relDirPath, 'directory', 'install');
            } else if (await isDir(destDirPath)) {
              // The object in infobase has no child artifacts, but destination has a stale folder
              addUnit(relDirPath, 'directory', 'remove');
            }
          }
        }
      }

      // Second pass: scan directories that were not paired with a descriptor
      for (const catEntry of catEntries) {
        if (catEntry.isDirectory()) {
          const relDirPath = path.join(categoryName, catEntry.name);
          if (!handledDirs.has(relDirPath.toLowerCase())) {
            handledDirs.add(relDirPath.toLowerCase());
            addUnit(relDirPath, 'directory', 'install');
          }
        }
      }
    }
  }

  let copied = 0;
  let committed = false;
  let rollbackFailure: unknown;

  try {
    // 1. Staging pass
    for (const unit of units) {
      if (unit.action !== 'install') {
        continue;
      }
      await fs.promises.mkdir(path.dirname(unit.stagingPath), { recursive: true });
      copied += await copyEntry(unit.sourcePath, unit.stagingPath);
      unit.staged = true;
    }

    // 2. Backup pass
    for (const unit of units) {
      unit.destinationExists = await pathExists(unit.destinationPath);
      if (!unit.destinationExists) {
        continue;
      }
      await fs.promises.mkdir(path.dirname(unit.backupPath), { recursive: true });
      await rename(unit.destinationPath, unit.backupPath);
      unit.backedUp = true;
    }

    // 3. Install pass
    for (const unit of units) {
      if (unit.action !== 'install' || !unit.staged) {
        continue;
      }
      await fs.promises.mkdir(path.dirname(unit.destinationPath), { recursive: true });
      await rename(unit.stagingPath, unit.destinationPath);
      unit.installed = true;
    }

    committed = true;
    return copied;
  } catch (error) {
    try {
      // Rollback: remove newly installed units
      for (const unit of [...units].reverse()) {
        if (!unit.installed) {
          continue;
        }
        await remove(unit.destinationPath, { recursive: true, force: true });
      }
      // Rollback: restore backed-up units
      for (const unit of [...units].reverse()) {
        if (!unit.backedUp) {
          continue;
        }
        await fs.promises.mkdir(path.dirname(unit.destinationPath), { recursive: true });
        await rename(unit.backupPath, unit.destinationPath);
      }
    } catch (restoreError) {
      rollbackFailure = restoreError;
    }

    if (rollbackFailure !== undefined) {
      throw new Error(
        `Не удалось опубликовать выгруженные объекты и восстановить прежние файлы. ` +
        `Резервная копия сохранена: ${backupRoot}. ` +
        `Исходная ошибка: ${error instanceof Error ? error.message : String(error)}. ` +
        `Ошибка восстановления: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`,
      );
    }
    throw error;
  } finally {
    if (committed || rollbackFailure === undefined) {
      await remove(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    } else {
      await remove(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
