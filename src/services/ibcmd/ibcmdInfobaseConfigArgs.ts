/**
 * CLI argument builders for `ibcmd infobase config` (import / export / check).
 *
 * Сверка с `ibcmdrunner` (vanessa-runner): offline-режим требует **`--data=<каталог данных АС>`**;
 * для **файловой** ИБ подключение задаётся **`--db-path=<каталог ИБ>`**, а не только YAML `--config`
 * (на Windows spawn без оболочки `--config` с `infobase.file` часто не применяется — симптом `…/db-data/1Cv8.1CD.cfl`).
 *
 * Экспорт: каталог назначения — **последний позиционный** аргумент (как в ibcmdrunner), не `--out=`.
 *
 * @see docs/WOW/ibcmd-api-reference.md
 */

import * as fs from 'fs';
import type { PreparedIbcmdFileDb, PreparedIbcmdYaml } from '../../infobases/ibcmdConfigPathResolver';

/**
 * On Windows, `os.tmpdir()` / `path.resolve` may yield 8.3 short components (e.g. `2BA0~1`).
 * ibcmd has been observed to mis-associate paths when the path is short-form; expand via `realpathSync.native` for existing paths.
 */
export function resolveIbcmdCliPathForWindowsSpawn(absPath: string): string {
  const t = absPath.trim();
  if (process.platform !== 'win32' || !t) {
    return t;
  }
  try {
    if (fs.existsSync(t)) {
      return fs.realpathSync.native(t);
    }
  } catch {
    /* keep logical path */
  }
  return t;
}

export interface IbcmdConfigCliCredentials {
  user?: string;
  password?: string;
}

/** Подключение к ИБ для offline ibcmd (порядок аргументов как в ibcmdrunner). */
export type IbcmdOfflineConnection =
  | { kind: 'fileDb'; dbCatalogPath: string; offlineDataDir: string }
  | { kind: 'yaml'; absoluteConfigPath: string; offlineDataDir: string };

/** Свести результат {@link prepareIbcmdConfigYaml} к аргументам подключения ibcmd. */
export function ibcmdOfflineConnectionFromPrepared(
  prep: PreparedIbcmdYaml | PreparedIbcmdFileDb,
): IbcmdOfflineConnection {
  if (prep.kind === 'fileDb') {
    return {
      kind: 'fileDb',
      dbCatalogPath: prep.dbCatalogPath,
      offlineDataDir: prep.offlineDataDir,
    };
  }
  return {
    kind: 'yaml',
    absoluteConfigPath: prep.absoluteConfigPath,
    offlineDataDir: prep.offlineDataDir,
  };
}

function appendCredentials(args: string[], creds?: IbcmdConfigCliCredentials): void {
  if (!creds) {
    return;
  }
  const u = creds.user?.trim();
  if (u) {
    args.push(`--user=${u}`);
  }
  const p = creds.password;
  if (typeof p === 'string' && p.length > 0) {
    args.push(`--password=${p}`);
  }
}

/** Как `ibcmdrunner.ДобавитьОбщиеПараметрыИБ`: подключение → учётка → `--data`. */
function appendConnectionAuthData(
  args: string[],
  connection: IbcmdOfflineConnection,
  creds?: IbcmdConfigCliCredentials,
): void {
  if (connection.kind === 'fileDb') {
    args.push(`--db-path=${resolveIbcmdCliPathForWindowsSpawn(connection.dbCatalogPath)}`);
  } else {
    args.push(`--config=${resolveIbcmdCliPathForWindowsSpawn(connection.absoluteConfigPath)}`);
  }
  appendCredentials(args, creds);
  args.push(`--data=${resolveIbcmdCliPathForWindowsSpawn(connection.offlineDataDir)}`);
}

export function buildInfobaseConfigCheckArgs(
  connection: IbcmdOfflineConnection,
  options?: { credentials?: IbcmdConfigCliCredentials; force?: boolean },
): string[] {
  const args = ['infobase', 'config', 'check'];
  appendConnectionAuthData(args, connection, options?.credentials);
  if (options?.force) {
    args.push('--force');
  }
  return args;
}

/**
 * Импорт из каталога выгрузки. Флаги принудительной загрузки (`-F` / `--force`) на ряде сборок 8.3.27
 * для `config import` дают «Ошибка разбора параметра» — не передаём (как `ibcmdrunner.ЗагрузитьКонфигурациюИзФайлов`).
 */
export function buildInfobaseConfigImportArgs(
  connection: IbcmdOfflineConnection,
  sourcePath: string,
  options?: { credentials?: IbcmdConfigCliCredentials; extension?: string },
): string[] {
  const src = resolveIbcmdCliPathForWindowsSpawn(sourcePath);
  const args = ['infobase', 'config', 'import'];
  appendConnectionAuthData(args, connection, options?.credentials);
  const ext = options?.extension?.trim();
  if (ext) {
    args.push(`--extension=${ext}`);
  }
  args.push(src);
  return args;
}

export function buildInfobaseConfigApplyArgs(
  connection: IbcmdOfflineConnection,
  options?: { credentials?: IbcmdConfigCliCredentials; extension?: string },
): string[] {
  const args = ['infobase', 'config', 'apply'];
  appendConnectionAuthData(args, connection, options?.credentials);
  const ext = options?.extension?.trim();
  if (ext) {
    args.push(`--extension=${ext}`);
  }
  return args;
}

/**
 * Инкрементальный импорт: загружает только указанные XML/BSL-файлы из каталога конфигурации.
 * Файлы передаются как позиционные аргументы после `--base-dir=`.
 *
 * Порядок аргументов: `infobase config import files` → подключение/учётка/data → `--extension=` → `--no-check` → файлы → `--base-dir=`.
 */
export function buildInfobaseConfigImportFilesArgs(
  connection: IbcmdOfflineConnection,
  files: readonly string[],
  baseDir: string,
  options?: {
    credentials?: IbcmdConfigCliCredentials;
    extension?: string;
    noCheck?: boolean;
  },
): string[] {
  const args = ['infobase', 'config', 'import', 'files'];
  appendConnectionAuthData(args, connection, options?.credentials);
  const ext = options?.extension?.trim();
  if (ext) {
    args.push(`--extension=${ext}`);
  }
  if (options?.noCheck) {
    args.push('--no-check');
  }
  for (const f of files) {
    args.push(f);
  }
  args.push(`--base-dir=${resolveIbcmdCliPathForWindowsSpawn(baseDir)}`);
  return args;
}

/**
 * Статус конфигурации: сравнивает ИБ с файлами на диске.
 * `--base=` указывает на `ConfigDumpInfo.xml`.
 */
export function buildInfobaseConfigExportStatusArgs(
  connection: IbcmdOfflineConnection,
  configDumpInfoPath: string,
  options?: {
    credentials?: IbcmdConfigCliCredentials;
    extension?: string;
    short?: boolean;
  },
): string[] {
  const args = ['infobase', 'config', 'export', 'status'];
  appendConnectionAuthData(args, connection, options?.credentials);
  const ext = options?.extension?.trim();
  if (ext) {
    args.push(`--extension=${ext}`);
  }
  args.push(`--base=${resolveIbcmdCliPathForWindowsSpawn(configDumpInfoPath)}`);
  if (options?.short) {
    args.push('--short');
  }
  return args;
}

export function buildInfobaseConfigExportArgs(
  connection: IbcmdOfflineConnection,
  outPath: string,
  options?: { credentials?: IbcmdConfigCliCredentials; extension?: string; format?: string },
): string[] {
  const out = resolveIbcmdCliPathForWindowsSpawn(outPath);
  const args = ['infobase', 'config', 'export'];
  appendConnectionAuthData(args, connection, options?.credentials);
  const ext = options?.extension?.trim();
  if (ext) {
    args.push(`--extension=${ext}`);
  }
  const fmt = options?.format?.trim();
  if (fmt) {
    args.push(`--format=${fmt}`);
  }
  args.push(out);
  return args;
}
