/**
 * ibcmd из платформы ниже 8.3.27 при вызове `infobase config import|export|check` с `--config=*.yaml`
 * может **игнорировать** YAML и подключаться к каталогу standalone-server по умолчанию — пользователь видит
 * «Информационная база не обнаружена» и путь `…\standalone-server\db-data\…` при корректном логе расширения.
 *
 * @see docs/WOW/ibcmd-api-reference.md (минимальная платформа для YAML)
 */

import {
  runIbcmdExecutable,
  type IbcmdExecutableProcessOptions,
} from './IbcmdProcessRunner';

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

function awaitVersionQuery(
  pending: Promise<ParsedIbcmdVersion | undefined>,
  cancellation: IbcmdExecutableProcessOptions['cancellation'],
): Promise<ParsedIbcmdVersion | undefined> {
  if (!cancellation) {
    return pending;
  }
  if (cancellation.isCancellationRequested) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    let settled = false;
    const subscription: { current?: { dispose(): void } } = {};
    const finish = (value: ParsedIbcmdVersion | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      subscription.current?.dispose();
      resolve(value);
    };
    subscription.current = cancellation.onCancellationRequested(() => finish(undefined));
    void pending.then(finish, () => finish(undefined));
    if (cancellation.isCancellationRequested) {
      finish(undefined);
    }
  });
}

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

export interface IbcmdVersionProcessOptions extends IbcmdExecutableProcessOptions {
  timeoutMs?: number;
}

/**
 * Запрашивает `ibcmd --version` (с кэшем на путь к exe).
 */
export async function queryParsedIbcmdVersion(
  executablePath: string,
  processOptions: IbcmdVersionProcessOptions = {},
): Promise<ParsedIbcmdVersion | undefined> {
  if (processOptions.cancellation?.isCancellationRequested) {
    return undefined;
  }
  const pending = versionQueryByPath.get(executablePath);
  if (pending) {
    return awaitVersionQuery(pending, processOptions.cancellation);
  }
  const run = (async (): Promise<ParsedIbcmdVersion | undefined> => {
    try {
      const { stdout } = await runIbcmdExecutable(
        executablePath,
        ['--version'],
        processOptions.timeoutMs ?? 15_000,
        { ...processOptions, maxBuffer: processOptions.maxBuffer ?? 64 * 1024 },
      );
      return tryParseIbcmdVersionOutput(stdout);
    } catch {
      return undefined;
    }
  })();
  versionQueryByPath.set(executablePath, run);
  if (processOptions.cancellation) {
    void run.then(() => {
      if (
        processOptions.cancellation?.isCancellationRequested
        && versionQueryByPath.get(executablePath) === run
      ) {
        versionQueryByPath.delete(executablePath);
      }
    });
  }
  return awaitVersionQuery(run, processOptions.cancellation);
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
  processOptions: IbcmdVersionProcessOptions = {},
): Promise<IncrementalSupportProbe> {
  const pending = incrementalProbeByPath.get(executablePath);
  if (pending) {
    return pending;
  }

  const run = (async (): Promise<IncrementalSupportProbe> => {
    /**
     * Проверяет поддержку подкоманды, подавая фейковый --db-path.
     *
     * Без --db-path ibcmd ждёт интерактивного ввода и зависает (→ SIGTERM по таймауту).
     * С --db-path=<несуществующий> ibcmd:
     *   - для реальной подкоманды: возвращает числовой exit code (ошибка подключения)
     *   - для несуществующей: зависает → killed + code=null
     */
    async function isSubcommandSupported(args: readonly string[]): Promise<boolean> {
      try {
        await runIbcmdExecutable(
          executablePath,
          [...args],
          processOptions.timeoutMs ?? 10_000,
          { ...processOptions, maxBuffer: processOptions.maxBuffer ?? 64 * 1024 },
        );
        return true;
      } catch (e: unknown) {
        if (e && typeof e === 'object') {
          const ex = e as { code?: string | number | null; killed?: boolean; status?: number };
          // killed === true → ibcmd завис и убит по таймауту → подкоманда не существует
          if (ex.killed) {
            return false;
          }
          // числовой code (включая 4294967295) → ibcmd распознал подкоманду, но упал на подключении
          return typeof ex.code === 'number' || typeof ex.status === 'number';
        }
        return false;
      }
    }

    const fakeDb = '--db-path=C:\\__ibcmd_probe_nonexistent__';

    const [importFiles, exportStatus, exportSync, exportObjects] = await Promise.all([
      isSubcommandSupported(['infobase', 'config', 'import', 'files', fakeDb, '--base-dir=.', 'probe.xml']),
      isSubcommandSupported(['infobase', 'config', 'export', 'status', fakeDb, '--base=.']),
      isSubcommandSupported(['infobase', 'config', 'export', 'sync', fakeDb]),
      isSubcommandSupported(['infobase', 'config', 'export', 'objects', fakeDb, '--out=.', 'Probe.Test']),
    ]);

    return { importFiles, exportStatus, exportSync, exportObjects };
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
  processOptions?: IbcmdVersionProcessOptions,
): Promise<string | undefined> {
  const parsed = await queryParsedIbcmdVersion(executablePath, processOptions);
  if (!parsed) {
    return undefined;
  }
  if (isIbcmdVersionYamlInfobaseConfigSupported(parsed)) {
    return undefined;
  }
  return ibcmdYamlInfobaseTooOldUserMessage(parsed.raw);
}
