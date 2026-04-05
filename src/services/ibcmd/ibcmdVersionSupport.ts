/**
 * ibcmd из платформы ниже 8.3.27 при вызове `infobase config import|export|check` с `--config=*.yaml`
 * может **игнорировать** YAML и подключаться к каталогу standalone-server по умолчанию — пользователь видит
 * «Информационная база не обнаружена» и путь `…\standalone-server\db-data\…` при корректном логе расширения.
 *
 * @see docs/WOW/ibcmd-api-reference.md (минимальная платформа для YAML)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Минимальная версия платформы 1С для YAML-подключения в режиме infobase config (Administrator Guide / ibcmd). */
export const IBCMD_MIN_YAML_INFOBASE_PATCH = 27 as const;

export interface ParsedIbcmdVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly build: number;
  readonly raw: string;
}

const versionQueryByPath = new Map<string, Promise<ParsedIbcmdVersion | undefined>>();

/** Сброс кэша версий (например после смены пути к ibcmd). */
export function invalidateIbcmdVersionQueryCache(): void {
  versionQueryByPath.clear();
}

/**
 * Разбор первой строки вывода `ibcmd --version` (например `8.3.23.2157`).
 */
export function tryParseIbcmdVersionOutput(stdout: string): ParsedIbcmdVersion | undefined {
  const line = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\s*$/.exec(line);
  if (!m) {
    return undefined;
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const build = Number(m[4]);
  if (![major, minor, patch, build].every((n) => Number.isFinite(n))) {
    return undefined;
  }
  return { major, minor, patch, build, raw: line };
}

/**
 * true, если версия ≥ 8.3.27 (включая 8.4+, 9+).
 */
export function isIbcmdVersionYamlInfobaseConfigSupported(v: ParsedIbcmdVersion): boolean {
  if (v.major > 8) {
    return true;
  }
  if (v.major < 8) {
    return false;
  }
  if (v.minor > 3) {
    return true;
  }
  if (v.minor < 3) {
    return false;
  }
  return v.patch >= IBCMD_MIN_YAML_INFOBASE_PATCH;
}

export function ibcmdYamlInfobaseTooOldUserMessage(detectedRaw: string): string {
  return (
    `Обнаружена версия ibcmd ${detectedRaw}. Команды «infobase config import / export / check» с подключением через YAML (параметр --config) поддерживаются начиная с платформы 1С 8.3.27. ` +
    `Укажите в настройках расширения путь к ibcmd из каталога bin установки 8.3.27 или новее. ` +
    `На более старых сборках ibcmd часто **игнорирует** --config и обращается к каталогу standalone-server по умолчанию — отсюда ошибки «Информационная база не обнаружена» и путь …\\\\standalone-server\\\\db-data\\\\….`
  );
}

export type IbcmdVersionExecFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/**
 * Запрашивает `ibcmd --version` (с кэшем на путь к exe).
 */
export async function queryParsedIbcmdVersion(
  executablePath: string,
  execImpl: IbcmdVersionExecFn = execFileAsync as IbcmdVersionExecFn,
): Promise<ParsedIbcmdVersion | undefined> {
  const pending = versionQueryByPath.get(executablePath);
  if (pending) {
    return pending;
  }
  const run = (async (): Promise<ParsedIbcmdVersion | undefined> => {
    try {
      const { stdout } = await execImpl(executablePath, ['--version'], {
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      });
      const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
      return tryParseIbcmdVersionOutput(text);
    } catch {
      return undefined;
    }
  })();
  versionQueryByPath.set(executablePath, run);
  return run;
}

// ---------------------------------------------------------------------------
// Incremental support probe (ibcmd import files / export status / sync / objects)
// ---------------------------------------------------------------------------

export interface IncrementalSupportProbe {
  importFiles: boolean;
  exportStatus: boolean;
  exportSync: boolean;
  exportObjects: boolean;
}

const incrementalProbeByPath = new Map<string, Promise<IncrementalSupportProbe>>();

/** Сброс кэша проверки инкрементальных команд (например после смены пути к ibcmd). */
export function invalidateIncrementalSupportProbeCache(): void {
  incrementalProbeByPath.clear();
}

/**
 * Проверяет, поддерживает ли данный исполняемый ibcmd инкрементальные подкоманды.
 * Результат кэшируется на путь к исполняемому файлу.
 */
export async function probeIncrementalSupport(
  executablePath: string,
  execImpl: IbcmdVersionExecFn = execFileAsync as IbcmdVersionExecFn,
): Promise<IncrementalSupportProbe> {
  const pending = incrementalProbeByPath.get(executablePath);
  if (pending) {
    return pending;
  }

  const run = (async (): Promise<IncrementalSupportProbe> => {
    const execOpts = {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    };

    async function getHelpText(args: readonly string[]): Promise<string> {
      try {
        const result = await execImpl(executablePath, args, execOpts);
        const out = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
        const err = typeof result.stderr === 'string' ? result.stderr : result.stderr.toString('utf8');
        return out + err;
      } catch (e: unknown) {
        // ibcmd exits with non-zero for --help; capture output from the error object
        if (e && typeof e === 'object') {
          const ex = e as { stdout?: string | Buffer; stderr?: string | Buffer };
          const out = ex.stdout ? (typeof ex.stdout === 'string' ? ex.stdout : ex.stdout.toString('utf8')) : '';
          const err = ex.stderr ? (typeof ex.stderr === 'string' ? ex.stderr : ex.stderr.toString('utf8')) : '';
          return out + err;
        }
        return '';
      }
    }

    const importHelp = await getHelpText(['infobase', 'config', 'import', '--help']);
    const exportHelp = await getHelpText(['infobase', 'config', 'export', '--help']);

    return {
      importFiles: importHelp.includes('files'),
      exportStatus: exportHelp.includes('status'),
      exportSync: exportHelp.includes('sync'),
      exportObjects: exportHelp.includes('objects'),
    };
  })();

  incrementalProbeByPath.set(executablePath, run);
  return run;
}

// ---------------------------------------------------------------------------

/**
 * Если версия известна и ниже порога — текст ошибки для UI; иначе `undefined` (можно вызывать ibcmd).
 */
export async function getIbcmdYamlInfobaseConfigUnsupportedMessage(
  executablePath: string,
  execImpl?: IbcmdVersionExecFn,
): Promise<string | undefined> {
  const parsed = await queryParsedIbcmdVersion(executablePath, execImpl);
  if (!parsed) {
    return undefined;
  }
  if (isIbcmdVersionYamlInfobaseConfigSupported(parsed)) {
    return undefined;
  }
  return ibcmdYamlInfobaseTooOldUserMessage(parsed.raw);
}
