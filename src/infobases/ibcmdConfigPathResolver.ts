import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { InfobaseEntry } from './models/infobaseEntry';
import { createIbcmdOfflineServerDataDir } from '../services/ibcmd/ibcmdOfflineDataDir';

/** Единый RU-текст CDT 41: ibcmd недоступен для веб-записи каталога. */
export const IB_FILE_IBCMD_WEB_UNSUPPORTED_RU =
  'Операции import/export/check через ibcmd не поддерживаются для веб-базы. Используйте файловую или серверную запись.';

const MISSING_CONNECTION =
  'Укажите путь к YAML в свойствах базы (Редактировать…) или заполните параметры подключения.';

const EXPLICIT_YAML_MISSING = (p: string) =>
  `Файл конфигурации ibcmd не найден: ${p}. Проверьте поле YAML в свойствах базы.`;

function ibFileDataPathNotFoundMessage(abs: string): string {
  return (
    `Путь к данным файловой информационной базы не найден: ${abs}. ` +
    'Проверьте каталог на диске (для standalone-сервера — наличие db-data и файлов ИБ, например 1Cv8.1CD) и совпадение пути в свойствах базы или строки file в YAML для ibcmd. ibcmd не запускался.'
  );
}

/**
 * Извлекает скаляр `file:` из фрагмента YAML конфигурации ibcmd (как у {@link buildFileInfobaseYamlContent}).
 * Не полноценный парсер YAML: при неоднозначном содержимом возвращает undefined — проверка пути пропускается.
 */
export function tryParseInfobaseFileScalarFromYaml(content: string): string | undefined {
  const dq = content.match(/^\s*file:\s*"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/m);
  if (dq?.[1] !== undefined) {
    return dq[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  const sq = content.match(/^\s*file:\s*'([^']*)'\s*(?:#.*)?$/m);
  if (sq?.[1] !== undefined) {
    return sq[1];
  }
  const uq = content.match(/^\s*file:\s+([^#\r\n]+?)\s*(?:#.*)?$/m);
  if (uq?.[1] !== undefined) {
    return uq[1].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/** Escape a scalar for double-quoted YAML (minimal subset for ibcmd paths and names). */
export function yamlDoubleQuotedScalar(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Absolute path for `infobase.file` in generated ibcmd YAML (and existence checks).
 * Resolves to a logical absolute path, then `fs.realpathSync.native` so junctions/symlinks match
 * the path ibcmd will use (avoids «в каталоге Documents», а ibcmd ругается на `AppData\…`).
 * If realpath fails (нет цели), остаётся логический путь.
 */
export function resolvePathForIbcmdYamlFileField(filePath: string): string {
  const t = filePath.trim();
  const logical =
    process.platform === 'win32'
      ? path.win32.normalize(path.win32.resolve(t))
      : path.resolve(t);
  try {
    return fs.realpathSync.native(logical);
  } catch {
    return logical;
  }
}

/**
 * Scalar for YAML `infobase.file` on Windows: forward slashes avoid ambiguous backslash escapes in
 * double-quoted YAML (`\U…`) and match vendor examples that use `C:/…` style paths.
 */
export function formatFilePathForIbcmdYamlScalar(resolvedAbsPath: string): string {
  if (process.platform !== 'win32') {
    return resolvedAbsPath;
  }
  return resolvedAbsPath.replace(/\\/g, '/');
}

/**
 * When a path already exists on disk, expand Windows 8.3 segments (`Users\2BA0~1` → long `Users\…`).
 * Same inode as the short form — not a wrong user or broken encoding; short names are optional NTFS aliases.
 * Used so logs and `absoluteConfigPath` match what `realpathSync.native` gives ibcmd.
 */
export function resolveExistingPathToLongOnWin32(absPath: string): string {
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

function find1Cv8Dot1CDFileInDirectory(dirAbs: string): string | undefined {
  try {
    const exact = path.join(dirAbs, '1Cv8.1CD');
    if (fs.existsSync(exact)) {
      const st = fs.statSync(exact);
      if (st.isFile()) {
        return exact;
      }
    }
    if (process.platform === 'win32') {
      for (const name of fs.readdirSync(dirAbs)) {
        if (!/^1cv8\.1cd$/i.test(name)) {
          continue;
        }
        const full = path.join(dirAbs, name);
        if (fs.statSync(full).isFile()) {
          return full;
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Resolves a path that may be a file-IB **catalog folder** or a direct `1Cv8.1CD` path — for **existence
 * checks** in {@link prepareIbcmdConfigYaml} (explicit user YAML). Do **not** use this for the scalar written
 * into **generated** temp YAML: vendor docs and several `ibcmd` builds expect `infobase.file` to be the
 * **directory**; pointing at `…\\1Cv8.1CD` can make the CLI ignore the block and fall back to the default
 * standalone-server layout (`…\\standalone-server\\db-data\\…`).
 */
export function prefer1Cv8Dot1CDDataPathIfPresent(resolvedAbsPath: string): string {
  const p = resolvedAbsPath.trim();
  if (!p || !fs.existsSync(p)) {
    return p;
  }
  try {
    const st = fs.statSync(p);
    const base = path.basename(p);
    if (st.isFile()) {
      if (/^1cv8\.1cd$/i.test(base)) {
        try {
          return fs.realpathSync.native(p);
        } catch {
          return p;
        }
      }
      return p;
    }
    if (st.isDirectory()) {
      const oneCd = find1Cv8Dot1CDFileInDirectory(p);
      if (oneCd) {
        try {
          return fs.realpathSync.native(oneCd);
        } catch {
          return oneCd;
        }
      }
      try {
        return fs.realpathSync.native(p);
      } catch {
        return p;
      }
    }
  } catch {
    return p;
  }
  return p;
}

/** Strip password scalars from YAML text for safe diagnostics (Output channel). */
export function redactIbcmdYamlPasswordLines(body: string): string {
  return body.replace(/^\s*password:\s*.+$/gm, '  password: <redacted>');
}

export function buildFileInfobaseYamlContent(opts: {
  filePath: string;
  user?: string;
  password?: string;
}): string {
  const resolvedFile = resolvePathForIbcmdYamlFileField(opts.filePath);
  // Windows ibcmd has been observed to ignore `file:` when the scalar used `/` (forward slashes);
  // vendor samples use backslashes with YAML escaping — {@link yamlDoubleQuotedScalar} doubles `\`.
  const fileScalar =
    process.platform === 'win32' ? resolvedFile : formatFilePathForIbcmdYamlScalar(resolvedFile);
  const lines = ['infobase:', `  file: ${yamlDoubleQuotedScalar(fileScalar)}`];
  const u = opts.user?.trim();
  if (u) {
    lines.push(`  user: ${yamlDoubleQuotedScalar(u)}`);
  }
  if (typeof opts.password === 'string' && opts.password.length > 0) {
    lines.push(`  password: ${yamlDoubleQuotedScalar(opts.password)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function buildServerInfobaseYamlContent(opts: {
  server: string;
  ref: string;
  user?: string;
  password?: string;
}): string {
  const lines = [
    'infobase:',
    `  server: ${yamlDoubleQuotedScalar(opts.server)}`,
    `  ref: ${yamlDoubleQuotedScalar(opts.ref)}`,
  ];
  const u = opts.user?.trim();
  if (u) {
    lines.push(`  user: ${yamlDoubleQuotedScalar(u)}`);
  }
  if (typeof opts.password === 'string' && opts.password.length > 0) {
    lines.push(`  password: ${yamlDoubleQuotedScalar(opts.password)}`);
  }
  return `${lines.join('\n')}\n`;
}

export type PrepareYamlFailureCode =
  | 'WEB_NOT_SUPPORTED'
  | 'MISSING_PARAMS'
  | 'YAML_NOT_FOUND'
  /** Разрешённый путь к данным файловой ИБ отсутствует на диске; каталоги ИБ не создаём. */
  | 'IB_FILE_DATA_PATH_NOT_FOUND';

export interface PrepareYamlFailure {
  ok: false;
  code: PrepareYamlFailureCode;
  userMessage: string;
}

/** YAML `--config` + каталог `--data` (ibcmdrunner). */
export interface PreparedIbcmdYaml {
  ok: true;
  kind: 'yaml';
  /** Absolute path passed to `--config=` (on Windows, long form after `realpath` when the file exists — no `2BA0~1` in logs). */
  absoluteConfigPath: string;
  /** Каталог данных автономного сервера для `--data=`. */
  offlineDataDir: string;
  /** When true, {@link dispose} deletes the temp YAML under os.tmpdir(). */
  isTemporary: boolean;
  dispose: () => Promise<void>;
}

/** Файловая ИБ: `--db-path` + `--data` без YAML (надёжно из spawn; см. ibcmdrunner). */
export interface PreparedIbcmdFileDb {
  ok: true;
  kind: 'fileDb';
  /** Каталог файловой ИБ для `--db-path=`. */
  dbCatalogPath: string;
  offlineDataDir: string;
  dispose: () => Promise<void>;
}

export type PrepareIbcmdYamlResult = PreparedIbcmdYaml | PreparedIbcmdFileDb | PrepareYamlFailure;

async function writeTempYaml(entryId: string, body: string): Promise<{ path: string; dispose: () => Promise<void> }> {
  const suffix = randomBytes(8).toString('hex');
  const tmp = path.join(os.tmpdir(), `1cviewer-ibcmd-${entryId}-${suffix}.yaml`);
  // UTF-8 without BOM: some ibcmd builds mis-parse a leading BOM so `infobase` is not recognized. Cyrillic paths remain valid in UTF-8.
  await fs.promises.writeFile(tmp, body, { encoding: 'utf8' });
  const logical = path.resolve(tmp);
  const canonical = resolveExistingPathToLongOnWin32(logical);
  const dispose = async (): Promise<void> => {
    try {
      await fs.promises.unlink(canonical);
    } catch {
      try {
        await fs.promises.unlink(logical);
      } catch {
        /* ignore */
      }
    }
  };
  return { path: canonical, dispose };
}

/**
 * Файловая ИБ из записи каталога: `--db-path` + `--data` (как vanessa-runner / ibcmdrunner), без временного YAML.
 */
async function prepareFileInfobaseDirectIbcmd(
  entry: InfobaseEntry,
  _readPassword: (entryId: string) => Promise<string | undefined>,
): Promise<PrepareIbcmdYamlResult> {
  const fp = entry.filePath?.trim();
  if (!fp) {
    return { ok: false, code: 'MISSING_PARAMS', userMessage: MISSING_CONNECTION };
  }
  const dataAbs = resolvePathForIbcmdYamlFileField(fp);
  if (!fs.existsSync(dataAbs)) {
    return {
      ok: false,
      code: 'IB_FILE_DATA_PATH_NOT_FOUND',
      userMessage: ibFileDataPathNotFoundMessage(dataAbs),
    };
  }
  const dataHandle = await createIbcmdOfflineServerDataDir(entry.id);
  return {
    ok: true,
    kind: 'fileDb',
    dbCatalogPath: dataAbs,
    offlineDataDir: dataHandle.path,
    dispose: dataHandle.dispose,
  };
}

/**
 * Resolves `--config` for ibcmd: explicit YAML, or generated temp YAML for file/server entries.
 * Caller must always `await dispose()` in `finally` when `ok` (including non-temporary: no-op).
 */
export async function prepareIbcmdConfigYaml(
  entry: InfobaseEntry,
  readPassword: (entryId: string) => Promise<string | undefined>,
): Promise<PrepareIbcmdYamlResult> {
  if (entry.type === 'web') {
    return { ok: false, code: 'WEB_NOT_SUPPORTED', userMessage: IB_FILE_IBCMD_WEB_UNSUPPORTED_RU };
  }

  const explicitYaml = entry.ibcmdConfigYamlPath?.trim();
  if (explicitYaml) {
    const abs = path.resolve(explicitYaml);
    if (!fs.existsSync(abs)) {
      /** Явный YAML отсутствует — для файловой ИБ с валидным каталогом данных подключаемся через `--db-path`. */
      if (entry.type === 'file') {
        const fb = await prepareFileInfobaseDirectIbcmd(entry, readPassword);
        if (fb.ok) {
          return fb;
        }
        if (!fb.ok && fb.code === 'IB_FILE_DATA_PATH_NOT_FOUND') {
          return fb;
        }
      }
      return {
        ok: false,
        code: 'YAML_NOT_FOUND',
        userMessage: EXPLICIT_YAML_MISSING(abs),
      };
    }
    try {
      const body = await fs.promises.readFile(abs, 'utf8');
      const fileScalar = tryParseInfobaseFileScalarFromYaml(body);
      if (fileScalar !== undefined) {
        const dataAbs = resolvePathForIbcmdYamlFileField(fileScalar);
        const dataCheck = prefer1Cv8Dot1CDDataPathIfPresent(dataAbs);
        if (!fs.existsSync(dataCheck)) {
          return {
            ok: false,
            code: 'IB_FILE_DATA_PATH_NOT_FOUND',
            userMessage: ibFileDataPathNotFoundMessage(dataCheck),
          };
        }
        const dataHandle = await createIbcmdOfflineServerDataDir(entry.id);
        return {
          ok: true,
          kind: 'fileDb',
          dbCatalogPath: resolvePathForIbcmdYamlFileField(fileScalar),
          offlineDataDir: dataHandle.path,
          dispose: dataHandle.dispose,
        };
      }
    } catch {
      /* не удалось прочитать YAML для проверки file: — ниже: YAML для server/ref */
    }
    const dataHandleExplicit = await createIbcmdOfflineServerDataDir(entry.id);
    return {
      ok: true,
      kind: 'yaml',
      absoluteConfigPath: resolveExistingPathToLongOnWin32(abs),
      offlineDataDir: dataHandleExplicit.path,
      isTemporary: false,
      dispose: dataHandleExplicit.dispose,
    };
  }

  if (entry.type === 'file') {
    return prepareFileInfobaseDirectIbcmd(entry, readPassword);
  }

  if (entry.type === 'server') {
    const server = entry.server?.trim() ?? '';
    const database = entry.database?.trim() ?? '';
    if (!server || !database) {
      return { ok: false, code: 'MISSING_PARAMS', userMessage: MISSING_CONNECTION };
    }
    let password: string | undefined;
    if (entry.hasStoredPassword) {
      password = (await readPassword(entry.id)) ?? undefined;
    }
    const body = buildServerInfobaseYamlContent({
      server,
      ref: database,
      user: entry.user,
      password,
    });
    const dataHandle = await createIbcmdOfflineServerDataDir(entry.id);
    const { path: tmpPath, dispose: disposeYaml } = await writeTempYaml(entry.id, body);
    return {
      ok: true,
      kind: 'yaml',
      absoluteConfigPath: tmpPath,
      offlineDataDir: dataHandle.path,
      isTemporary: true,
      dispose: async (): Promise<void> => {
        await disposeYaml();
        await dataHandle.dispose();
      },
    };
  }

  return { ok: false, code: 'MISSING_PARAMS', userMessage: MISSING_CONNECTION };
}

/** For tests / logging: true if text looks like a password line (must stay out of public logs). */
export function textLooksLikeYamlPasswordLine(s: string): boolean {
  return /^\s*password:\s+/m.test(s);
}
