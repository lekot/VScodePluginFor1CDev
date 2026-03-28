import type { IbcmdStreamingRawOutcome } from './IbcmdStreamingRunner';

export type IbcmdInfobaseConfigOpKind = 'import' | 'export' | 'check';

export interface IbcmdInfobaseOperationResult {
  status: 'success' | 'cancelled' | 'error';
  exitCode: number | null;
  signal?: string;
  userMessage: string;
  /** Captured process output (ring buffer); safe for Output Channel — must not contain secrets from argv (catalog uses YAML for secrets). */
  logExcerpt: string;
  /** True when ring buffer trimmed output (see runner). */
  logTruncated?: boolean;
}

const TIMEOUT_HINT =
  'Превышено время ожидания ibcmd. Увеличьте 1cMetadataTree.ibcmd.timeout или переменную IBCMD_TIMEOUT_MS.';

const SPAWN_ENOENT =
  'Исполняемый файл ibcmd не найден. Проверьте путь в настройках или переменную IBCMD_PATH.';

const IMPORT_EXIT_MESSAGES: Record<number, string> = {
  0: 'Операция завершена успешно.',
  1: 'Ошибка выполнения операции (см. вывод ibcmd).',
  2: 'База заблокирована. Завершите сеансы 1С и повторите.',
  3: 'Не удалось подключиться к информационной базе. Проверьте путь, сервер и учётные данные.',
};

const GENERIC_NONZERO = 'Ошибка выполнения операции (см. вывод ibcmd).';

const CANCELLED_MSG = 'Операция отменена.';

function mapImportExit(exitCode: number): string {
  return IMPORT_EXIT_MESSAGES[exitCode] ?? GENERIC_NONZERO;
}

/**
 * Interprets raw process outcome into a stable UI result (RU strings).
 */
export function interpretIbcmdInfobaseOutcome(
  op: IbcmdInfobaseConfigOpKind,
  raw: IbcmdStreamingRawOutcome,
): IbcmdInfobaseOperationResult {
  const logExcerpt = raw.combinedLog;
  const logTruncated = raw.logTruncated;

  if (raw.cancelled) {
    return {
      status: 'cancelled',
      exitCode: raw.exitCode,
      signal: raw.signal ?? undefined,
      userMessage: CANCELLED_MSG,
      logExcerpt,
      logTruncated,
    };
  }

  if (raw.timedOut) {
    return {
      status: 'error',
      exitCode: raw.exitCode,
      signal: raw.signal ?? undefined,
      userMessage: TIMEOUT_HINT,
      logExcerpt,
      logTruncated,
    };
  }

  if (raw.spawnErrorCode === 'ENOENT' || raw.spawnErrorCode === 'ENOTDIR') {
    return {
      status: 'error',
      exitCode: null,
      userMessage: SPAWN_ENOENT,
      logExcerpt,
      logTruncated,
    };
  }

  if (raw.spawnErrorCode || raw.spawnErrorMessage) {
    return {
      status: 'error',
      exitCode: null,
      userMessage: `Не удалось запустить ibcmd: ${raw.spawnErrorMessage ?? raw.spawnErrorCode ?? 'unknown'}`,
      logExcerpt,
      logTruncated,
    };
  }

  const code = raw.exitCode;
  if (code === 0) {
    return {
      status: 'success',
      exitCode: 0,
      signal: raw.signal ?? undefined,
      userMessage: IMPORT_EXIT_MESSAGES[0],
      logExcerpt,
      logTruncated,
    };
  }

  if (op === 'import' && typeof code === 'number') {
    return {
      status: 'error',
      exitCode: code,
      signal: raw.signal ?? undefined,
      userMessage: mapImportExit(code),
      logExcerpt,
      logTruncated,
    };
  }

  return {
    status: 'error',
    exitCode: code,
    signal: raw.signal ?? undefined,
    userMessage: GENERIC_NONZERO,
    logExcerpt,
    logTruncated,
  };
}
