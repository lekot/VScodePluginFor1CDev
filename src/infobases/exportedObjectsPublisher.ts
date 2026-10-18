import * as fs from 'fs';
import * as path from 'path';

export interface ConfigurationTreePublishHooks {
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly remove?: (target: string, options: { recursive?: boolean; force?: boolean }) => Promise<void>;
  readonly copyEntry?: (from: string, to: string) => Promise<number>;
}

export interface PublishedObjectEntry {
  readonly relativePath: string;
  readonly isDirectory: boolean;
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

export async function copyTreeOverwrite(srcDir: string, destDir: string): Promise<number> {
  let count = 0;
  for (const entry of await fs.promises.readdir(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await fs.promises.mkdir(destPath, { recursive: true });
      count += await copyTreeOverwrite(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
      count++;
    }
  }
  return count;
}

export async function copyObjectPublishEntry(sourcePath: string, destinationPath: string): Promise<number> {
  const stat = await fs.promises.lstat(sourcePath);
  if (stat.isDirectory()) {
    await fs.promises.mkdir(destinationPath, { recursive: true });
    return copyTreeOverwrite(sourcePath, destinationPath);
  }
  if (stat.isFile()) {
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, destinationPath);
    return 1;
  }
  throw new Error(`Неподдерживаемый тип записи выгрузки: ${sourcePath}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Publishes individual exported metadata objects from a temporary directory into
 * the workspace configuration directory (#350).
 *
 * Transactional semantics:
 * - Replaces object XML/MDO files and entire object subdirectories (forms, templates, modules).
 * - Stale nested child artifacts (deleted in infobase) are cleanly removed from destination.
 * - Objects with no child folder in export have their stale folder removed from destination.
 * - Unrelated metadata objects and non-1C workspace files are never touched.
 * - Staged on the destination filesystem volume with automatic rollback on error.
 */
export async function publishExportedObjectsTree(
  sourceDir: string,
  destinationDir: string,
  hooks: ConfigurationTreePublishHooks = {},
): Promise<number> {
  const source = path.resolve(sourceDir);
  const destination = path.resolve(destinationDir);
  if (source === destination) {
    throw new Error('Нельзя опубликовать конфигурацию поверх исходного каталога.');
  }
  const sourceStat = await fs.promises.stat(source);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Источник выгрузки не является каталогом: ${source}`);
  }

  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const transactionRoot = path.join(destination, `.cdt-objects-publish-${suffix}`);
  const stagingRoot = path.join(transactionRoot, 'staging');
  const backupRoot = path.join(transactionRoot, 'backup');
  const rename = hooks.rename ?? (async (from: string, to: string) => fs.promises.rename(from, to));
  const remove = hooks.remove ?? (async (target: string, options: { recursive?: boolean; force?: boolean }) => {
    await fs.promises.rm(target, options);
  });
  const copyEntry = hooks.copyEntry ?? copyObjectPublishEntry;

  await fs.promises.mkdir(destination, { recursive: true });
  await fs.promises.mkdir(stagingRoot, { recursive: true });
  await fs.promises.mkdir(backupRoot, { recursive: true });

  const entries: PublishedObjectEntry[] = [];
  const entriesByRelPath = new Set<string>();

  const addEntry = (relPath: string, isDirectory: boolean) => {
    const normalized = path.normalize(relPath);
    if (entriesByRelPath.has(normalized)) {
      return;
    }
    entriesByRelPath.add(normalized);
    entries.push({
      relativePath: normalized,
      isDirectory,
      sourcePath: path.join(source, normalized),
      destinationPath: path.join(destination, normalized),
      stagingPath: path.join(stagingRoot, normalized),
      backupPath: path.join(backupRoot, normalized),
      sourceExists: false,
      destinationExists: false,
      staged: false,
      backedUp: false,
      installed: false,
    });
  };

  const scanTypeFolder = async (typeFolderRel: string) => {
    const typeDirPath = path.join(source, typeFolderRel);
    let dirents: fs.Dirent[] = [];
    try {
      dirents = await fs.promises.readdir(typeDirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const rel = path.join(typeFolderRel, dirent.name);
      if (dirent.isDirectory()) {
        addEntry(rel, true);
      } else if (dirent.isFile()) {
        addEntry(rel, false);
        const ext = path.extname(dirent.name);
        if (ext === '.xml' || ext === '.mdo') {
          const objectBaseName = path.basename(dirent.name, ext);
          const companionDirRel = path.join(typeFolderRel, objectBaseName);
          const companionDirSource = path.join(source, companionDirRel);
          const companionDirDest = path.join(destination, companionDirRel);
          if (!fs.existsSync(companionDirSource) && fs.existsSync(companionDirDest)) {
            addEntry(companionDirRel, true);
          }
        }
      }
    }
  };

  for (const dirent of await fs.promises.readdir(source, { withFileTypes: true })) {
    if (dirent.isFile()) {
      addEntry(dirent.name, false);
    } else if (dirent.isDirectory()) {
      const typeFolderRel = dirent.name;
      if (typeFolderRel === 'src') {
        const srcDirPath = path.join(source, 'src');
        let srcDirents: fs.Dirent[] = [];
        try {
          srcDirents = await fs.promises.readdir(srcDirPath, { withFileTypes: true });
        } catch {
          srcDirents = [];
        }
        for (const subDirent of srcDirents) {
          if (subDirent.isFile()) {
            addEntry(path.join('src', subDirent.name), false);
          } else if (subDirent.isDirectory()) {
            if (subDirent.name === 'Configuration') {
              const cfgDir = path.join(srcDirPath, 'Configuration');
              for (const cfgDirent of await fs.promises.readdir(cfgDir, { withFileTypes: true })) {
                addEntry(path.join('src', 'Configuration', cfgDirent.name), cfgDirent.isDirectory());
              }
            } else {
              await scanTypeFolder(path.join('src', subDirent.name));
            }
          }
        }
      } else {
        await scanTypeFolder(typeFolderRel);
      }
    }
  }

  let copied = 0;
  let committed = false;
  let rollbackFailure: unknown;
  try {
    for (const entry of entries) {
      entry.sourceExists = await pathExists(entry.sourcePath);
      if (!entry.sourceExists) {
        continue;
      }
      copied += await copyEntry(entry.sourcePath, entry.stagingPath);
      entry.staged = true;
    }

    for (const entry of entries) {
      entry.destinationExists = await pathExists(entry.destinationPath);
      if (!entry.destinationExists) {
        continue;
      }
      await fs.promises.mkdir(path.dirname(entry.backupPath), { recursive: true });
      await rename(entry.destinationPath, entry.backupPath);
      entry.backedUp = true;
    }

    for (const entry of entries) {
      if (!entry.staged) {
        continue;
      }
      await fs.promises.mkdir(path.dirname(entry.destinationPath), { recursive: true });
      await rename(entry.stagingPath, entry.destinationPath);
      entry.installed = true;
    }
    committed = true;
    return copied;
  } catch (error) {
    try {
      for (const entry of [...entries].reverse()) {
        if (!entry.installed) {
          continue;
        }
        await remove(entry.destinationPath, { recursive: true, force: true });
      }
      for (const entry of [...entries].reverse()) {
        if (!entry.backedUp) {
          continue;
        }
        await fs.promises.mkdir(path.dirname(entry.destinationPath), { recursive: true });
        await rename(entry.backupPath, entry.destinationPath);
      }
    } catch (restoreError) {
      rollbackFailure = restoreError;
    }

    if (rollbackFailure !== undefined) {
      throw new Error(
        `Не удалось опубликовать выгруженные объекты и полностью восстановить прежние файлы. ` +
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
