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

type IbcmdQueryCancellation = NonNullable<IbcmdExecutableProcessOptions['cancellation']>;

interface VersionQueryCacheEntry {
  promise: Promise<ParsedIbcmdVersion | undefined>;
  cancel: () => void;
  waiters: number;
  settled: boolean;
}

const versionQueryByPath = new Map<string, VersionQueryCacheEntry>();

function createIbcmdQueryCancellation(): { token: IbcmdQueryCancellation; cancel: () => void } {
  let requested = false;
  const listeners = new Set<() => void>();
  return {
    token: {
      get isCancellationRequested() { return requested; },
      onCancellationRequested(listener) {
        if (requested) {
          listener();
          return { dispose: () => undefined };
        }
        listeners.add(listener);
        return { dispose: () => { listeners.delete(listener); } };
      },
    },
    cancel() {
      if (requested) {
        return;
      }
      requested = true;
      listeners.forEach((listener) => listener());
    },
  };
}

function awaitVersionQuery(
  executablePath: string,
  entry: VersionQueryCacheEntry,
  cancellation: IbcmdExecutableProcessOptions['cancellation'],
): Promise<ParsedIbcmdVersion | undefined> {
  if (cancellation?.isCancellationRequested) {
    if (entry.waiters === 0 && !entry.settled) {
      entry.cancel();
      if (versionQueryByPath.get(executablePath) === entry) {
        versionQueryByPath.delete(executablePath);
      }
    }
    return Promise.resolve(undefined);
  }

  entry.waiters += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    let cancellationSubscription: { dispose(): void } | undefined;
    const releaseWaiter = (): void => {
      entry.waiters -= 1;
      if (entry.waiters === 0 && !entry.settled) {
        entry.cancel();
        if (versionQueryByPath.get(executablePath) === entry) {
          versionQueryByPath.delete(executablePath);
        }
      }
    };
    const finish = (value: ParsedIbcmdVersion | undefined): void => {
      if (finished) {
        return;
      }
      finished = true;
      cancellationSubscription?.dispose();
      cancellationSubscription = undefined;
      releaseWaiter();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (finished) {
        return;
      }
      finished = true;
      cancellationSubscription?.dispose();
      cancellationSubscription = undefined;
      releaseWaiter();
      reject(error);
    };

    if (cancellation) {
      cancellationSubscription = cancellation.onCancellationRequested(() => finish(undefined));
      if (finished) {
        cancellationSubscription.dispose();
        cancellationSubscription = undefined;
      } else if (cancellation.isCancellationRequested) {
        finish(undefined);
      }
    }
    void entry.promise.then(finish, fail);
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
    return awaitVersionQuery(executablePath, pending, processOptions.cancellation);
  }
  const queryCancellation = createIbcmdQueryCancellation();
  const entry: VersionQueryCacheEntry = {
    promise: Promise.resolve(undefined),
    cancel: queryCancellation.cancel,
    waiters: 0,
    settled: false,
  };
  const run = Promise.resolve().then(async (): Promise<ParsedIbcmdVersion | undefined> => {
    try {
      const { stdout } = await runIbcmdExecutable(
        executablePath,
        ['--version'],
        processOptions.timeoutMs ?? 15_000,
        {
          ...processOptions,
          cancellation: queryCancellation.token,
          maxBuffer: processOptions.maxBuffer ?? 64 * 1024,
        },
      );
      return tryParseIbcmdVersionOutput(stdout);
    } catch {
      return undefined;
    }
  });
  entry.promise = run.then(
    (version) => {
      entry.settled = true;
      if (!version && queryCancellation.token.isCancellationRequested) {
        if (versionQueryByPath.get(executablePath) === entry) {
          versionQueryByPath.delete(executablePath);
        }
      }
      return version;
    },
    (error: unknown) => {
      entry.settled = true;
      if (versionQueryByPath.get(executablePath) === entry) {
        versionQueryByPath.delete(executablePath);
      }
      throw error;
    },
  );
  versionQueryByPath.set(executablePath, entry);
  return awaitVersionQuery(executablePath, entry, processOptions.cancellation);
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

type IncrementalProbeCancellation = IbcmdQueryCancellation;

interface IncrementalProbeCacheEntry {
  promise: Promise<IncrementalSupportProbe | undefined>;
  cancel: () => void;
  waiters: number;
  settled: boolean;
}

const incrementalProbeByPath = new Map<string, IncrementalProbeCacheEntry>();

function noIncrementalSupport(): IncrementalSupportProbe {
  return {
    importFiles: false,
    exportStatus: false,
    exportSync: false,
    exportObjects: false,
  };
}

const INCREMENTAL_PROBE_CANCELLED = Symbol('incremental probe cancelled');

function awaitIncrementalProbe(
  executablePath: string,
  entry: IncrementalProbeCacheEntry,
  cancellation: IncrementalProbeCancellation | undefined,
): Promise<IncrementalSupportProbe> {
  if (cancellation?.isCancellationRequested) {
    return Promise.resolve(noIncrementalSupport());
  }
  entry.waiters += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    let cancellationSubscription: { dispose(): void } | undefined;
    const releaseWaiter = (): void => {
      entry.waiters -= 1;
      if (entry.waiters === 0 && !entry.settled) {
        entry.cancel();
        if (incrementalProbeByPath.get(executablePath) === entry) {
          incrementalProbeByPath.delete(executablePath);
        }
      }
    };
    const finish = (probe: IncrementalSupportProbe | undefined): void => {
      if (finished) {
        return;
      }
      finished = true;
      cancellationSubscription?.dispose();
      cancellationSubscription = undefined;
      releaseWaiter();
      resolve(probe ?? noIncrementalSupport());
    };
    const fail = (error: unknown): void => {
      if (finished) {
        return;
      }
      finished = true;
      cancellationSubscription?.dispose();
      cancellationSubscription = undefined;
      releaseWaiter();
      reject(error);
    };

    if (cancellation) {
      cancellationSubscription = cancellation.onCancellationRequested(() => finish(undefined));
      if (finished) {
        cancellationSubscription.dispose();
        cancellationSubscription = undefined;
      } else if (cancellation.isCancellationRequested) {
        finish(undefined);
      }
    }
    void entry.promise.then(finish, fail);
  });
}

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
  if (processOptions.cancellation?.isCancellationRequested) {
    return noIncrementalSupport();
  }
  const pending = incrementalProbeByPath.get(executablePath);
  if (pending) {
    return awaitIncrementalProbe(executablePath, pending, processOptions.cancellation);
  }

  const probeCancellation = createIbcmdQueryCancellation();
  const entry: IncrementalProbeCacheEntry = {
    promise: Promise.resolve(undefined),
    cancel: probeCancellation.cancel,
    waiters: 0,
    settled: false,
  };
  const run = Promise.resolve().then(async (): Promise<IncrementalSupportProbe | undefined> => {
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
          {
            ...processOptions,
            cancellation: probeCancellation.token,
            maxBuffer: processOptions.maxBuffer ?? 64 * 1024,
          },
        );
        return true;
      } catch (e: unknown) {
        if (e && typeof e === 'object') {
          const ex = e as {
            code?: string | number | null;
            killed?: boolean;
            status?: number;
            processOutcome?: { cancelled?: boolean };
          };
          if (probeCancellation.token.isCancellationRequested || ex.processOutcome?.cancelled) {
            throw INCREMENTAL_PROBE_CANCELLED;
          }
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

    try {
      const [importFiles, exportStatus, exportSync, exportObjects] = await Promise.all([
        isSubcommandSupported(['infobase', 'config', 'import', 'files', fakeDb, '--base-dir=.', 'probe.xml']),
        isSubcommandSupported(['infobase', 'config', 'export', 'status', fakeDb, '--base=.']),
        isSubcommandSupported(['infobase', 'config', 'export', 'sync', fakeDb]),
        isSubcommandSupported(['infobase', 'config', 'export', 'objects', fakeDb, '--out=.', 'Probe.Test']),
      ]);

      return { importFiles, exportStatus, exportSync, exportObjects };
    } catch (error) {
      if (error === INCREMENTAL_PROBE_CANCELLED || probeCancellation.token.isCancellationRequested) {
        return undefined;
      }
      throw error;
    }
  });

  entry.promise = run.then(
    (result) => {
      entry.settled = true;
      if (!result && incrementalProbeByPath.get(executablePath) === entry) {
        incrementalProbeByPath.delete(executablePath);
      }
      return result;
    },
    (error: unknown) => {
      entry.settled = true;
      if (incrementalProbeByPath.get(executablePath) === entry) {
        incrementalProbeByPath.delete(executablePath);
      }
      throw error;
    },
  );
  incrementalProbeByPath.set(executablePath, entry);
  return awaitIncrementalProbe(executablePath, entry, processOptions.cancellation);
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
