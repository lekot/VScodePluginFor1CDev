import { spawn } from 'child_process';
import { getIbcmdService } from './ibcmd/ibcmdServiceSingleton';
import {
  runIbcmdExecutableRaw,
  type IbcmdExecutableProcessOptions,
} from './ibcmd/IbcmdProcessRunner';
import { getIbcmdConsoleOutputEncodingSetting } from './metadataTreeSettings';
import { getIbcmdYamlInfobaseConfigUnsupportedMessage } from './ibcmd/ibcmdVersionSupport';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';
import { prepareIbcmdConfigYaml } from '../infobases/ibcmdConfigPathResolver';
import {
  buildInfobaseConfigImportArgs,
  ibcmdOfflineConnectionFromPrepared,
  type IbcmdConfigCliCredentials,
} from './ibcmd/ibcmdInfobaseConfigArgs';
import {
  InfobaseConfigurationOperationCancelledError,
  runInfobaseConfigurationOperation,
} from '../infobases/infobaseConfigurationOperationQueue';
import type { IbcmdStreamCancellation } from './ibcmd/IbcmdStreamingRunner';
import type { ProcessTreeTerminationOutcome } from './ibcmd/processTreeTermination';

const PREVIEW_MAX = 8000;

export type IbcmdXmlPreflightCode =
  | 'IBCMD_NOT_FOUND'
  | 'UNSUPPORTED_VERSION'
  | 'PREPARE_FAILED'
  | 'IMPORT_FAILED'
  | 'CANCELLED'
  | 'IN_DOUBT';

export interface IbcmdXmlPreflightResult {
  ok: boolean;
  code?: IbcmdXmlPreflightCode;
  message: string;
  durationMs: number;
  /** True when the process started and the import effect may already have occurred. */
  effectPossible?: boolean;
  termination?: ProcessTreeTerminationOutcome;
}

function combineOutput(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`.trim().slice(0, PREVIEW_MAX);
}

function cancelledResult(startedAt: number): IbcmdXmlPreflightResult {
  return {
    ok: false,
    code: 'CANCELLED',
    effectPossible: false,
    durationMs: Date.now() - startedAt,
    message: 'ibcmd config import preflight отменён до запуска процесса.',
  };
}

function inDoubtResult(
  startedAt: number,
  details: string,
  termination?: ProcessTreeTerminationOutcome,
): IbcmdXmlPreflightResult {
  const terminationDetails = termination && !termination.terminated
    ? ` Остановка дерева не подтверждена: ${[
        ...termination.survivingPids.map((pid) => `PID ${pid}`),
        ...termination.errors,
      ].join('; ') || 'процесс мог продолжить работу'}.`
    : '';
  const outputTail = details ? `\n${details}` : '';
  return {
    ok: false,
    code: 'IN_DOUBT',
    effectPossible: true,
    durationMs: Date.now() - startedAt,
    message: `ibcmd config import preflight завершился после запуска процесса; результат неопределён (inDoubt).${terminationDetails}${outputTail}`,
    ...(termination ? { termination } : {}),
  };
}

function errorCode(outcome: Awaited<ReturnType<typeof runIbcmdExecutableRaw>>): string {
  if (typeof outcome.exitCode === 'number') {
    return `exitCode=${outcome.exitCode}`;
  }
  if (outcome.spawnErrorCode) {
    return outcome.spawnErrorCode;
  }
  if (outcome.timedOut) {
    return 'timeout';
  }
  if (outcome.signal) {
    return `signal=${outcome.signal}`;
  }
  return 'failed';
}

export async function runIbcmdXmlImportPreflight(params: {
  entry: InfobaseEntry;
  storage: InfobaseStorageService;
  absoluteSourceDir: string;
  ibcmdExtensionName?: string;
  token?: IbcmdStreamCancellation;
  /** Process boundary injection for deterministic lifecycle tests. */
  spawnImpl?: typeof spawn;
  terminateProcessTreeImpl?: IbcmdExecutableProcessOptions['terminateProcessTreeImpl'];
}): Promise<IbcmdXmlPreflightResult> {
  const startedAt = Date.now();
  if (params.token?.isCancellationRequested) {
    return cancelledResult(startedAt);
  }

  const ibcmd = getIbcmdService();
  const pathResult = await ibcmd.resolveExecutablePathAsync();
  if (params.token?.isCancellationRequested) {
    return cancelledResult(startedAt);
  }
  if (pathResult.kind !== 'resolved') {
    return {
      ok: false,
      code: 'IBCMD_NOT_FOUND',
      durationMs: Date.now() - startedAt,
      effectPossible: false,
      message:
        'Исполняемый файл ibcmd не найден. Укажите путь в настройках или переменную IBCMD_PATH.',
    };
  }

  const processOptions: IbcmdExecutableProcessOptions = {
    cancellation: params.token,
    consoleOutputEncoding: getIbcmdConsoleOutputEncodingSetting(),
    ...(params.spawnImpl ? { spawnImpl: params.spawnImpl } : {}),
    ...(params.terminateProcessTreeImpl
      ? { terminateProcessTreeImpl: params.terminateProcessTreeImpl }
      : {}),
  };
  const unsupportedMessage = await getIbcmdYamlInfobaseConfigUnsupportedMessage(
    pathResult.path,
    { ...processOptions, maxBuffer: 64 * 1024 },
  );
  if (params.token?.isCancellationRequested) {
    return cancelledResult(startedAt);
  }
  if (unsupportedMessage) {
    return {
      ok: false,
      code: 'UNSUPPORTED_VERSION',
      durationMs: Date.now() - startedAt,
      effectPossible: false,
      message: unsupportedMessage,
    };
  }

  const prep = await prepareIbcmdConfigYaml(params.entry, (id) => params.storage.readPasswordSecret(id));
  if (!prep.ok) {
    return {
      ok: false,
      code: 'PREPARE_FAILED',
      durationMs: Date.now() - startedAt,
      effectPossible: false,
      message: prep.userMessage,
    };
  }

  try {
    if (params.token?.isCancellationRequested) {
      return cancelledResult(startedAt);
    }
    const entryUser = params.entry.user?.trim();
    const entryPassword = params.entry.hasStoredPassword
      ? (await params.storage.readPasswordSecret(params.entry.id)) ?? undefined
      : undefined;
    const credentials: IbcmdConfigCliCredentials | undefined =
      entryUser || (entryPassword !== undefined && entryPassword.length > 0)
        ? { user: entryUser || undefined, password: entryPassword }
        : undefined;
    const args = buildInfobaseConfigImportArgs(
      ibcmdOfflineConnectionFromPrepared(prep),
      params.absoluteSourceDir,
      {
        extension: params.ibcmdExtensionName?.trim() || undefined,
        credentials,
      },
    );
    const runOptions: IbcmdExecutableProcessOptions = {
      ...processOptions,
      ...(credentials?.password ? { redactedValues: [credentials.password] } : {}),
    };

    const outcome = await runInfobaseConfigurationOperation(
      params.entry,
      () => runIbcmdExecutableRaw(
        pathResult.path,
        args,
        ibcmd.getTimeoutMs(),
        runOptions,
      ),
      params.token,
    );
    const details = combineOutput(outcome.stdout, outcome.stderr);

    if (outcome.spawnErrorCode === 'ENOENT' || outcome.spawnErrorCode === 'ENOTDIR') {
      ibcmd.invalidatePathCache();
    }

    if (outcome.cancelled && !outcome.effectPossible) {
      return cancelledResult(startedAt);
    }
    if (
      outcome.effectPossible
      && (outcome.cancelled || outcome.timedOut || outcome.spawnErrorCode === 'PROCESS_TREE_TERMINATION_FAILED')
    ) {
      return inDoubtResult(startedAt, details, outcome.termination);
    }

    if (outcome.outputTruncated) {
      const truncationDetails = `stdout/stderr обрезаны по лимиту ${outcome.processMaxBuffer} байт; результат импорта нельзя подтвердить.`;
      if (outcome.effectPossible) {
        return inDoubtResult(
          startedAt,
          [details, truncationDetails].filter(Boolean).join('\n'),
          outcome.termination,
        );
      }
      return {
        ok: false,
        code: 'IMPORT_FAILED',
        durationMs: Date.now() - startedAt,
        effectPossible: false,
        message: `ibcmd config import preflight не подтверждён: ${truncationDetails}${details ? `\n${details}` : ''}`,
        ...(outcome.termination ? { termination: outcome.termination } : {}),
      };
    }

    if (outcome.exitCode === 0 && !outcome.spawnErrorCode && !outcome.timedOut && !outcome.cancelled) {
      return {
        ok: true,
        durationMs: Date.now() - startedAt,
        effectPossible: outcome.effectPossible,
        message: details || 'ibcmd config import preflight завершился успешно.',
        ...(outcome.termination ? { termination: outcome.termination } : {}),
      };
    }

    const tail = details ? `\n${details}` : outcome.spawnErrorMessage ? `\n${outcome.spawnErrorMessage}` : '';
    return {
      ok: false,
      code: 'IMPORT_FAILED',
      durationMs: Date.now() - startedAt,
      effectPossible: outcome.effectPossible,
      message: `ibcmd config import preflight failed (${errorCode(outcome)}).${tail}`,
      ...(outcome.termination ? { termination: outcome.termination } : {}),
    };
  } catch (error: unknown) {
    if (error instanceof InfobaseConfigurationOperationCancelledError) {
      return cancelledResult(startedAt);
    }
    const err = error as {
      code?: string | number;
      status?: number;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
      processOutcome?: Awaited<ReturnType<typeof runIbcmdExecutableRaw>>;
    };
    const raw = err.processOutcome;
    if (raw?.effectPossible && (raw.cancelled || raw.timedOut)) {
      return inDoubtResult(startedAt, combineOutput(raw.stdout, raw.stderr), raw.termination);
    }
    if (err.code === 'ENOENT') {
      ibcmd.invalidatePathCache();
    }
    const code = typeof err.status === 'number'
      ? `exitCode=${err.status}`
      : typeof err.code === 'number'
        ? `exitCode=${err.code}`
        : err.signal
          ? `signal=${err.signal}`
          : typeof err.code === 'string'
            ? err.code
            : 'failed';
    const rawOut = err.stdout != null ? err.stdout : Buffer.alloc(0);
    const rawErr = err.stderr != null ? err.stderr : Buffer.alloc(0);
    const details = combineOutput(
      typeof rawOut === 'string' ? rawOut : rawOut.toString('utf8'),
      typeof rawErr === 'string' ? rawErr : rawErr.toString('utf8'),
    );
    const tail = details ? `\n${details}` : err.message ? `\n${err.message}` : '';
    return {
      ok: false,
      code: 'IMPORT_FAILED',
      durationMs: Date.now() - startedAt,
      effectPossible: raw?.effectPossible ?? false,
      message: `ibcmd config import preflight failed (${code}).${tail}`,
    };
  } finally {
    await prep.dispose();
  }
}
