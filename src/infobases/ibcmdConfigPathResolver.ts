import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { InfobaseEntry } from './models/infobaseEntry';

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

/** Strip password scalars from YAML text for safe diagnostics (Output channel). */
export function redactIbcmdYamlPasswordLines(body: string): string {
  return body.replace(/^\s*password:\s*.+$/gm, '  password: <redacted>');
}

export function buildFileInfobaseYamlContent(opts: {
  filePath: string;
  user?: string;
  password?: string;
}): string {
  const lines = ['infobase:', `  file: ${yamlDoubleQuotedScalar(resolvePathForIbcmdYamlFileField(opts.filePath))}`];
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

/** Successful result of {@link prepareIbcmdConfigYaml} (narrowed). */
export interface PreparedIbcmdYaml {
  ok: true;
  /** Absolute path passed to `--config=`. */
  absoluteConfigPath: string;
  /** When true, {@link dispose} deletes a temp file under os.tmpdir(). */
  isTemporary: boolean;
  dispose: () => Promise<void>;
}

export type PrepareIbcmdYamlResult = PreparedIbcmdYaml | PrepareYamlFailure;

async function writeTempYaml(entryId: string, body: string): Promise<{ path: string; dispose: () => Promise<void> }> {
  const suffix = randomBytes(8).toString('hex');
  const tmp = path.join(os.tmpdir(), `1cviewer-ibcmd-${entryId}-${suffix}.yaml`);
  // UTF-8 BOM helps Windows tools (including some 1C builds) detect encoding for paths with Cyrillic in YAML.
  const payload = process.platform === 'win32' ? `\ufeff${body}` : body;
  await fs.promises.writeFile(tmp, payload, { encoding: 'utf8' });
  const dispose = async (): Promise<void> => {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* ignore */
    }
  };
  return { path: path.resolve(tmp), dispose };
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
        if (!fs.existsSync(dataAbs)) {
          return {
            ok: false,
            code: 'IB_FILE_DATA_PATH_NOT_FOUND',
            userMessage: ibFileDataPathNotFoundMessage(dataAbs),
          };
        }
      }
    } catch {
      /* не удалось прочитать YAML для проверки file: — поведение как раньше, ibcmd сам диагностирует */
    }
    return {
      ok: true,
      absoluteConfigPath: abs,
      isTemporary: false,
      dispose: async () => {},
    };
  }

  if (entry.type === 'file') {
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
    let password: string | undefined;
    if (entry.hasStoredPassword) {
      password = (await readPassword(entry.id)) ?? undefined;
    }
    const body = buildFileInfobaseYamlContent({
      filePath: fp,
      user: entry.user,
      password,
    });
    const { path: tmpPath, dispose } = await writeTempYaml(entry.id, body);
    return {
      ok: true,
      absoluteConfigPath: tmpPath,
      isTemporary: true,
      dispose,
    };
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
    const { path: tmpPath, dispose } = await writeTempYaml(entry.id, body);
    return {
      ok: true,
      absoluteConfigPath: tmpPath,
      isTemporary: true,
      dispose,
    };
  }

  return { ok: false, code: 'MISSING_PARAMS', userMessage: MISSING_CONNECTION };
}

/** For tests / logging: true if text looks like a password line (must stay out of public logs). */
export function textLooksLikeYamlPasswordLine(s: string): boolean {
  return /^\s*password:\s+/m.test(s);
}
