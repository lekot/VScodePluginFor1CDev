import * as fs from 'fs';
import * as path from 'path';

export interface ConfigurationTreePublishHooks {
  /** Replace the default recursive copy in tests or in a host with an audited FS wrapper. */
  readonly copyEntry?: (sourcePath: string, destinationPath: string) => Promise<number>;
  readonly rename?: (sourcePath: string, destinationPath: string) => Promise<void>;
  readonly remove?: (targetPath: string, options: { recursive?: boolean; force?: boolean }) => Promise<void>;
}

interface ExportedUnit {
  readonly relativePath: string;
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

async function copyTreeOverwrite(srcDir: string, destDir: string): Promise<number> {
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

async function copyPublishEntry(sourcePath: string, destinationPath: string): Promise<number> {
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

async function discoverExportedUnits(sourceDir: string): Promise<string[]> {
  const relativeUnits: string[] = [];
  const rootEntries = await fs.promises.readdir(sourceDir, { withFileTypes: true });

  for (const entry of rootEntries) {
    if (entry.isFile()) {
      relativeUnits.push(entry.name);
    } else if (entry.isDirectory()) {
      const categoryDir = path.join(sourceDir, entry.name);
      const childEntries = await fs.promises.readdir(categoryDir, { withFileTypes: true });
      const objectNamesWithXml = new Set<string>();

      for (const child of childEntries) {
        if (child.isFile() && child.name.endsWith('.xml')) {
          const objectName = path.basename(child.name, '.xml');
          objectNamesWithXml.add(objectName);
          relativeUnits.push(path.join(entry.name, child.name));
          relativeUnits.push(path.join(entry.name, objectName));
        }
      }

      for (const child of childEntries) {
        if (child.isDirectory() && !objectNamesWithXml.has(child.name)) {
          relativeUnits.push(path.join(entry.name, child.name));
        }
      }

      if (childEntries.length === 0) {
        relativeUnits.push(entry.name);
      }
    }
  }

  return relativeUnits;
}

/**
 * Publishes individual exported metadata objects atomically from temp directory
 * into configuration destination directory.
 *
 * Each object's definition file (`<Category>/<Name>.xml`) and entire companion directory
 * (`<Category>/<Name>`) form an atomic replacement unit. Any child artifacts
 * (forms, templates, modules) deleted in the infobase are cleanly removed without
 * leaving workspace orphans, while unrelated sibling objects in the same category
 * remain untouched.
 */
export async function publishExportedObjectsTree(
  sourceDir: string,
  destinationDir: string,
  hooks: ConfigurationTreePublishHooks = {},
): Promise<number> {
  const source = path.resolve(sourceDir);
  const destination = path.resolve(destinationDir);
  if (source === destination) {
    throw new Error('Нельзя опубликовать объекты конфигурации поверх исходного каталога.');
  }

  const sourceStat = await fs.promises.stat(source);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Источник выгрузки не является каталогом: ${source}`);
  }

  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const transactionRoot = path.join(destination, `.cdt-export-objects-${suffix}`);
  const stagingRoot = path.join(transactionRoot, 'staging');
  const backupRoot = path.join(transactionRoot, 'backup');
  const rename = hooks.rename ?? (async (from: string, to: string) => fs.promises.rename(from, to));
  const remove = hooks.remove ?? (async (target: string, options: { recursive?: boolean; force?: boolean }) => {
    await fs.promises.rm(target, options);
  });
  const copyEntry = hooks.copyEntry ?? copyPublishEntry;

  await fs.promises.mkdir(destination, { recursive: true });
  await fs.promises.mkdir(stagingRoot, { recursive: true });
  await fs.promises.mkdir(backupRoot, { recursive: true });

  const relativePaths = await discoverExportedUnits(source);
  const units: ExportedUnit[] = relativePaths.map((rel) => ({
    relativePath: rel,
    sourcePath: path.join(source, rel),
    destinationPath: path.join(destination, rel),
    stagingPath: path.join(stagingRoot, rel),
    backupPath: path.join(backupRoot, rel),
    sourceExists: false,
    destinationExists: false,
    staged: false,
    backedUp: false,
    installed: false,
  }));

  let copied = 0;
  let committed = false;
  let rollbackFailure: unknown;

  try {
    // 1. Stage existing source entries into staging directory
    for (const unit of units) {
      unit.sourceExists = await pathExists(unit.sourcePath);
      if (!unit.sourceExists) {
        continue;
      }
      await fs.promises.mkdir(path.dirname(unit.stagingPath), { recursive: true });
      copied += await copyEntry(unit.sourcePath, unit.stagingPath);
      unit.staged = true;
    }

    // 2. Move existing destination entries into backup directory
    for (const unit of units) {
      unit.destinationExists = await pathExists(unit.destinationPath);
      if (!unit.destinationExists) {
        continue;
      }
      await fs.promises.mkdir(path.dirname(unit.backupPath), { recursive: true });
      await rename(unit.destinationPath, unit.backupPath);
      unit.backedUp = true;
    }

    // 3. Move staged entries into destination
    for (const unit of units) {
      if (!unit.staged) {
        continue;
      }
      await fs.promises.mkdir(path.dirname(unit.destinationPath), { recursive: true });
      await rename(unit.stagingPath, unit.destinationPath);
      unit.installed = true;
    }

    committed = true;
    return copied;
  } catch (error) {
    // Rollback: delete installed entries, restore backed up entries
    try {
      for (const unit of [...units].reverse()) {
        if (!unit.installed) {
          continue;
        }
        await remove(unit.destinationPath, { recursive: true, force: true });
      }
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
