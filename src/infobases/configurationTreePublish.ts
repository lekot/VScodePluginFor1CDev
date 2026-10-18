import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  assertNoSymlinkSegments,
  assertPathWithinRoot,
  isPathInside,
  validateWorkspaceRelativePath,
} from '../services/configurationSession/pathBoundary';

export interface ConfigurationTreePublishHooks {
  /** Replace filesystem boundaries in tests or in a host with an audited wrapper. */
  readonly copyEntry?: (sourcePath: string, destinationPath: string) => Promise<number>;
  /** Runs after a destination is checked and immediately before its rename is checked again. */
  readonly beforeRename?: (sourcePath: string, destinationPath: string) => Promise<void>;
  readonly rename?: (sourcePath: string, destinationPath: string) => Promise<void>;
  readonly remove?: (targetPath: string, options: { recursive?: boolean; force?: boolean }) => Promise<void>;
}

export interface ConfigurationTreePublishUnit {
  /** A metadata file or object directory, relative to both tree roots. */
  readonly relativePath: string;
  /** Remove the destination unit when the exported tree intentionally omits it. */
  readonly removeWhenMissing?: boolean;
}

export type ConfigurationTreePublishTransaction = 'config' | 'objects';

interface PlannedPublishUnit {
  readonly relativePath: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly stagingPath: string;
  readonly backupPath: string;
  readonly action: 'install' | 'remove';
  readonly destinationExists: boolean;
  staged: boolean;
  stagedFingerprint?: EntryFingerprint;
  originalFingerprint?: EntryFingerprint;
  backupAttempted: boolean;
  backupConfirmed: boolean;
  installAttempted: boolean;
  installConfirmed: boolean;
}

type FsEntryKind = 'file' | 'directory';
type RenameReconciliation = 'moved' | 'notMoved' | 'ambiguous';

interface EntryFingerprint {
  readonly kind: FsEntryKind;
  readonly identity: string;
  readonly digest: string;
}

async function copyTree(sourceDir: string, destinationDir: string): Promise<number> {
  await fs.promises.mkdir(destinationDir, { recursive: true });
  let copied = 0;
  for (const entry of await fs.promises.readdir(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const stat = await fs.promises.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Нельзя копировать символическую ссылку в выгрузке: ${sourcePath}`);
    }
    if (stat.isDirectory()) {
      copied += await copyTree(sourcePath, destinationPath);
    } else if (stat.isFile()) {
      await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
      copied++;
    } else {
      throw new Error(`Неподдерживаемый тип записи выгрузки: ${sourcePath}`);
    }
  }
  return copied;
}

async function copyPublishEntry(sourcePath: string, destinationPath: string): Promise<number> {
  const stat = await fs.promises.lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Нельзя копировать символическую ссылку в выгрузке: ${sourcePath}`);
  }
  if (stat.isDirectory()) {
    return copyTree(sourcePath, destinationPath);
  }
  if (stat.isFile()) {
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    return 1;
  }
  throw new Error(`Неподдерживаемый тип записи выгрузки: ${sourcePath}`);
}

/**
 * Transactionally publishes a set of non-overlapping metadata units.
 * Every path stays under its canonical root, and symlinks, junctions, and
 * special filesystem entries fail closed before the first publication write.
 */
export async function publishConfigurationTreeUnits(
  sourceDir: string,
  destinationDir: string,
  units: readonly ConfigurationTreePublishUnit[],
  transaction: ConfigurationTreePublishTransaction,
  hooks: ConfigurationTreePublishHooks = {},
): Promise<number> {
  const source = await canonicalDirectory(sourceDir, 'Источник выгрузки');
  const destination = await canonicalDirectory(destinationDir, 'Каталог конфигурации');
  if (isPathInside(source, destination) || isPathInside(destination, source)) {
    throw new Error('Источник выгрузки и каталог конфигурации не должны пересекаться.');
  }

  const normalizedUnits = normalizeAndCheckUnits(units);
  const suffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const transactionRoot = path.join(destination, `.cdt-${transaction}-publish-${suffix}`);
  const stagingRoot = path.join(transactionRoot, 'staging');
  const backupRoot = path.join(transactionRoot, 'backup');
  const rename = hooks.rename ?? (async (from: string, to: string) => fs.promises.rename(from, to));
  const beforeRename = hooks.beforeRename ?? (async () => undefined);
  const remove = hooks.remove ?? (async (target: string, options: { recursive?: boolean; force?: boolean }) => {
    await fs.promises.rm(target, options);
  });
  const copyEntry = hooks.copyEntry ?? copyPublishEntry;
  const planned = await preflightUnits(source, destination, normalizedUnits, stagingRoot, backupRoot);
  if (planned.length === 0) { return 0; }

  let transactionCreated = false;
  let committed = false;
  let rollbackFailure: unknown;
  let copied = 0;
  try {
    await assertMissingOrSafeDirectory(destination, transactionRoot);
    await fs.promises.mkdir(transactionRoot);
    transactionCreated = true;
    await createSafeDirectory(destination, stagingRoot);
    await createSafeDirectory(destination, backupRoot);

    for (const unit of planned) {
      if (unit.action !== 'install') { continue; }
      await assertSafeEntry(source, unit.sourcePath);
      await createSafeDirectory(destination, path.dirname(unit.stagingPath));
      await assertPathMissing(destination, unit.stagingPath);
      copied += await copyEntry(unit.sourcePath, unit.stagingPath);
      await assertSafeEntry(destination, unit.stagingPath);
      unit.staged = true;
      unit.stagedFingerprint = await fingerprintEntry(destination, unit.stagingPath);
    }

    for (const unit of planned) {
      if (!unit.destinationExists) { continue; }
      await assertSafeEntry(destination, unit.destinationPath);
      unit.originalFingerprint = await fingerprintEntry(destination, unit.destinationPath);
      await createSafeDirectory(destination, path.dirname(unit.backupPath));
      await assertPathMissing(destination, unit.backupPath);
      await guardedRename(
        destination,
        unit.destinationPath,
        unit.backupPath,
        rename,
        beforeRename,
        unit.originalFingerprint,
        () => { unit.backupConfirmed = true; },
        () => { unit.backupAttempted = true; },
      );
    }

    for (const unit of planned) {
      if (unit.action !== 'install' || !unit.staged) { continue; }
      await createSafeDirectory(destination, path.dirname(unit.destinationPath));
      await assertSafeEntry(destination, unit.stagingPath);
      await assertPathMissing(destination, unit.destinationPath);
      await guardedRename(
        destination,
        unit.stagingPath,
        unit.destinationPath,
        rename,
        beforeRename,
        unit.stagedFingerprint!,
        () => { unit.installConfirmed = true; },
        () => { unit.installAttempted = true; },
      );
    }

    committed = true;
    return copied;
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const unit of [...planned].reverse()) {
      if (!unit.installAttempted) { continue; }
      try {
        const reconciliation = await reconcileRename(
          destination,
          unit.stagingPath,
          unit.destinationPath,
          unit.stagedFingerprint!,
        );
        if (reconciliation === 'notMoved') { continue; }
        if (reconciliation === 'ambiguous') {
          throw new Error(`Нельзя подтвердить владение опубликованным путём: ${unit.destinationPath}`);
        }

        unit.installConfirmed = true;
        const actual = await fingerprintEntry(destination, unit.destinationPath);
        if (!sameFingerprint(actual, unit.stagedFingerprint!)) {
          throw new Error(`Опубликованный путь изменён другим процессом: ${unit.destinationPath}`);
        }
        await remove(unit.destinationPath, { recursive: true, force: true });
      } catch (rollbackError) {
        rollbackErrors.push(messageOf(rollbackError));
      }
    }

    for (const unit of [...planned].reverse()) {
      if (!unit.backupAttempted || !unit.originalFingerprint) { continue; }
      try {
        const reconciliation = await reconcileRename(
          destination,
          unit.destinationPath,
          unit.backupPath,
          unit.originalFingerprint,
        );
        if (reconciliation === 'notMoved') { continue; }
        if (reconciliation === 'ambiguous') {
          throw new Error(`Нельзя подтвердить содержимое резервной копии: ${unit.backupPath}`);
        }

        unit.backupConfirmed = true;
        await assertPathMissing(destination, unit.destinationPath);
        await createSafeDirectory(destination, path.dirname(unit.destinationPath));
        let restoreAttempted = false;
        try {
          await guardedRename(
            destination,
            unit.backupPath,
            unit.destinationPath,
            rename,
            beforeRename,
            unit.originalFingerprint,
            () => undefined,
            () => { restoreAttempted = true; },
          );
        } catch (restoreError) {
          if (!restoreAttempted) { throw restoreError; }
          const restored = await reconcileRename(
            destination,
            unit.backupPath,
            unit.destinationPath,
            unit.originalFingerprint,
          );
          if (restored !== 'moved') { throw restoreError; }
        }
      } catch (rollbackError) {
        rollbackErrors.push(messageOf(rollbackError));
      }
    }

    if (rollbackErrors.length > 0) {
      rollbackFailure = new Error(rollbackErrors.join('; '));
    }

    if (rollbackFailure !== undefined) {
      throw new Error(
        `Не удалось опубликовать выгрузку и полностью восстановить прежние файлы. ` +
        `Резервная копия сохранена: ${backupRoot}. ` +
        `Исходная ошибка: ${messageOf(error)}. Ошибка восстановления: ${messageOf(rollbackFailure)}`,
      );
    }
    throw error;
  } finally {
    if (transactionCreated) {
      if (committed || rollbackFailure === undefined) {
        await removeSafely(destination, transactionRoot, remove);
      } else {
        await removeSafely(destination, stagingRoot, remove);
      }
    }
  }
}

async function canonicalDirectory(directory: string, description: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await fs.promises.realpath(path.resolve(directory));
  } catch (error) {
    throw new Error(`${description} недоступен: ${messageOf(error)}`);
  }
  const stat = await fs.promises.lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${description} не является обычным каталогом: ${directory}`);
  }
  return canonical;
}

function normalizeAndCheckUnits(units: readonly ConfigurationTreePublishUnit[]): ConfigurationTreePublishUnit[] {
  const normalized = units.map((unit) => ({
    relativePath: validateWorkspaceRelativePath(unit.relativePath).replace(/\\/g, '/'),
    removeWhenMissing: unit.removeWhenMissing === true,
  }));
  const keys = normalized.map((unit) => process.platform === 'win32'
    ? unit.relativePath.toLocaleLowerCase()
    : unit.relativePath);
  for (let index = 0; index < keys.length; index++) {
    for (let other = index + 1; other < keys.length; other++) {
      const left = keys[index]!;
      const right = keys[other]!;
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        throw new Error(`Пути публикации пересекаются: ${normalized[index]!.relativePath}, ${normalized[other]!.relativePath}`);
      }
    }
  }
  return normalized;
}

async function preflightUnits(
  sourceRoot: string,
  destinationRoot: string,
  units: readonly ConfigurationTreePublishUnit[],
  stagingRoot: string,
  backupRoot: string,
): Promise<PlannedPublishUnit[]> {
  const planned: PlannedPublishUnit[] = [];
  for (const unit of units) {
    const sourcePath = treePath(sourceRoot, unit.relativePath);
    const destinationPath = treePath(destinationRoot, unit.relativePath);
    const sourceExists = await assertSafeEntry(sourceRoot, sourcePath, true);
    const destinationExists = sourceExists || unit.removeWhenMissing
      ? await assertSafeEntry(destinationRoot, destinationPath, true)
      : false;
    if (!sourceExists && !unit.removeWhenMissing) { continue; }
    if (!sourceExists && !destinationExists) { continue; }
    planned.push({
      relativePath: unit.relativePath,
      sourcePath,
      destinationPath,
      stagingPath: treePath(stagingRoot, unit.relativePath),
      backupPath: treePath(backupRoot, unit.relativePath),
      action: sourceExists ? 'install' : 'remove',
      destinationExists,
      staged: false,
      backupAttempted: false,
      backupConfirmed: false,
      installAttempted: false,
      installConfirmed: false,
    });
  }
  return planned;
}

async function assertSafeEntry(root: string, target: string, allowMissing = false): Promise<boolean> {
  const kind = await verifyDirectPath(root, target, allowMissing);
  if (kind === 'directory') { await assertSafeTree(root, target); }
  return kind !== undefined;
}

async function assertSafeTree(root: string, directory: string): Promise<void> {
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const kind = await verifyDirectPath(root, target);
    if (kind === 'directory') { await assertSafeTree(root, target); }
  }
}

async function verifyDirectPath(
  root: string,
  target: string,
  allowMissing = false,
): Promise<FsEntryKind | undefined> {
  await assertPathWithinRoot(root, target);
  await assertNoSymlinkSegments(root, target);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(target);
  } catch (error) {
    if (allowMissing && isMissing(error)) { return undefined; }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Символическая ссылка запрещена в дереве публикации: ${target}`);
  }
  if (stat.isFile()) { return 'file'; }
  if (stat.isDirectory()) { return 'directory'; }
  throw new Error(`Неподдерживаемый тип записи в дереве публикации: ${target}`);
}

async function assertPathMissing(root: string, target: string): Promise<void> {
  const kind = await verifyDirectPath(root, target, true);
  if (kind !== undefined) {
    throw new Error(`Целевой путь публикации уже занят: ${target}`);
  }
}

async function assertMissingOrSafeDirectory(root: string, target: string): Promise<void> {
  const kind = await verifyDirectPath(root, target, true);
  if (kind !== undefined) {
    throw new Error(`Каталог транзакции уже существует: ${target}`);
  }
}

async function createSafeDirectory(root: string, directory: string): Promise<void> {
  await assertPathWithinRoot(root, directory);
  await assertNoSymlinkSegments(root, directory);
  await fs.promises.mkdir(directory, { recursive: true });
  const kind = await verifyDirectPath(root, directory);
  if (kind !== 'directory') {
    throw new Error(`Не удалось создать безопасный каталог: ${directory}`);
  }
}

async function guardedRename(
  root: string,
  source: string,
  destination: string,
  rename: (sourcePath: string, destinationPath: string) => Promise<void>,
  beforeRename: (sourcePath: string, destinationPath: string) => Promise<void>,
  expected: EntryFingerprint,
  onConfirmed: () => void,
  onAttempted: () => void,
): Promise<void> {
  const sourceFingerprint = await fingerprintEntry(root, source);
  if (!sameFingerprint(sourceFingerprint, expected)) {
    throw new Error(`Источник публикации изменился перед перемещением: ${source}`);
  }
  await assertPathMissing(root, destination);
  onAttempted();

  try {
    await beforeRename(source, destination);
    const sourceBeforeRename = await fingerprintEntry(root, source);
    if (!sameFingerprint(sourceBeforeRename, expected)) {
      throw new Error(`Источник публикации изменился перед перемещением: ${source}`);
    }
    await assertPathMissing(root, destination);
    await rename(source, destination);
  } catch (error) {
    const reconciliation = await reconcileRename(root, source, destination, expected);
    if (reconciliation === 'moved') {
      onConfirmed();
    } else if (reconciliation === 'ambiguous') {
      throw new Error(
        `Не удалось определить результат перемещения ${source} в ${destination}. ` +
        `Исходная ошибка: ${messageOf(error)}`,
      );
    }
    throw error;
  }

  const reconciliation = await reconcileRename(root, source, destination, expected);
  if (reconciliation === 'moved') {
    onConfirmed();
    return;
  }
  throw new Error(
    reconciliation === 'notMoved'
      ? `Перемещение не изменило ожидаемые пути: ${source} -> ${destination}`
      : `Не удалось подтвердить перемещение ${source} в ${destination}`,
  );
}

async function fingerprintEntry(root: string, target: string): Promise<EntryFingerprint> {
  const kind = await verifyDirectPath(root, target);
  if (!kind) { throw new Error(`Не найден путь для фиксации публикации: ${target}`); }
  const stat = await fs.promises.lstat(target);
  const identity = `${stat.dev}:${stat.ino}:${kind}`;
  const hash = createHash('sha256').update(`${identity}\0`);

  if (kind === 'file') {
    for await (const chunk of fs.createReadStream(target)) {
      hash.update(chunk as Buffer);
    }
  } else {
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childPath = path.join(target, entry.name);
      const child = await fingerprintEntry(root, childPath);
      hash.update(`${entry.name}\0${child.kind}\0${child.identity}\0${child.digest}\0`);
    }
  }

  const afterKind = await verifyDirectPath(root, target);
  const afterStat = await fs.promises.lstat(target);
  if (
    afterKind !== kind
    || afterStat.dev !== stat.dev
    || afterStat.ino !== stat.ino
  ) {
    throw new Error(`Путь изменился во время проверки публикации: ${target}`);
  }

  return { kind, identity, digest: hash.digest('hex') };
}

async function fingerprintIfPresent(root: string, target: string): Promise<EntryFingerprint | undefined> {
  try {
    return await fingerprintEntry(root, target);
  } catch (error) {
    if (isMissing(error)) { return undefined; }
    throw error;
  }
}

async function reconcileRename(
  root: string,
  source: string,
  destination: string,
  expected: EntryFingerprint,
): Promise<RenameReconciliation> {
  try {
    const [sourceFingerprint, destinationFingerprint] = await Promise.all([
      fingerprintIfPresent(root, source),
      fingerprintIfPresent(root, destination),
    ]);
    if (sourceFingerprint && sameFingerprint(sourceFingerprint, expected) && !destinationFingerprint) {
      return 'notMoved';
    }
    if (!sourceFingerprint && destinationFingerprint && sameFingerprint(destinationFingerprint, expected)) {
      return 'moved';
    }
    return 'ambiguous';
  } catch {
    return 'ambiguous';
  }
}

function sameFingerprint(left: EntryFingerprint, right: EntryFingerprint): boolean {
  return left.kind === right.kind && left.identity === right.identity && left.digest === right.digest;
}

async function removeSafely(
  root: string,
  target: string,
  remove: (targetPath: string, options: { recursive?: boolean; force?: boolean }) => Promise<void>,
): Promise<void> {
  try {
    if (!await assertSafeEntry(root, target, true)) { return; }
    await remove(target, { recursive: true, force: true });
  } catch {
    // Cleanup must never follow an entry that changed into an unsafe path.
  }
}

function treePath(root: string, relativePath: string): string {
  return path.resolve(root, ...relativePath.split('/'));
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
