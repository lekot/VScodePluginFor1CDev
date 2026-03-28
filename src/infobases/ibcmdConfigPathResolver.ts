import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { InfobaseEntry } from './models/infobaseEntry';

const WEB_UNSUPPORTED =
  'Операции import/export/check через ibcmd не поддерживаются для веб-базы. Используйте файловую или серверную запись.';

const MISSING_CONNECTION =
  'Укажите путь к YAML в свойствах базы (Редактировать…) или заполните параметры подключения.';

const EXPLICIT_YAML_MISSING = (p: string) =>
  `Файл конфигурации ibcmd не найден: ${p}. Проверьте поле YAML в свойствах базы.`;

/** Escape a scalar for double-quoted YAML (minimal subset for ibcmd paths and names). */
export function yamlDoubleQuotedScalar(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function buildFileInfobaseYamlContent(opts: {
  filePath: string;
  user?: string;
  password?: string;
}): string {
  const lines = ['infobase:', `  file: ${yamlDoubleQuotedScalar(path.resolve(opts.filePath))}`];
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

export type PrepareYamlFailureCode = 'WEB_NOT_SUPPORTED' | 'MISSING_PARAMS' | 'YAML_NOT_FOUND';

export interface PrepareYamlFailure {
  ok: false;
  code: PrepareYamlFailureCode;
  userMessage: string;
}

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
  await fs.promises.writeFile(tmp, body, { encoding: 'utf8' });
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
    return { ok: false, code: 'WEB_NOT_SUPPORTED', userMessage: WEB_UNSUPPORTED };
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
