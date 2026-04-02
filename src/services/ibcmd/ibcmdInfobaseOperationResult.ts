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
  'Превышено время ожидания ibcmd. Увеличьте 1cMetadataTree.ibcmd.timeout (секунды) или переменную IBCMD_TIMEOUT_MS (мс).';

const SPAWN_ENOENT =
  'Исполняемый файл ibcmd не найден. Проверьте путь в настройках или переменную IBCMD_PATH.';

const INTERACTIVE_PROMPT_ABORT =
  'ibcmd запросил учётные данные интерактивно. Укажите имя пользователя и пароль через контекстное меню → «Настроить учётные данные».';

const IMPORT_EXIT_MESSAGES: Record<number, string> = {
  0: 'Операция завершена успешно.',
  1: 'Ошибка выполнения операции (см. вывод ibcmd).',
  2: 'База заблокирована. Завершите сеансы 1С и повторите.',
  3: 'Не удалось подключиться к информационной базе. Проверьте путь, сервер и учётные данные.',
};

const GENERIC_NONZERO = 'Ошибка выполнения операции (см. вывод ibcmd).';

/** Shown when log indicates CLI rejected force / similar (not IB lock). */
const IMPORT_FORCE_PARAM_PARSE_MSG =
  'Ошибка ibcmd: параметр принудительной загрузки отклонён при разборе командной строки (это не блокировка базы). См. вывод в канале.';

const CANCELLED_MSG = 'Операция отменена.';

/**
 * True when ibcmd output suggests the process failed parsing a force-related flag (`--force`, `-F`).
 * Used to avoid mapping exit code 2 to «база заблокирована» and to retry import without `-F`.
 */
export function isIbcmdForceParameterRejectedLog(log: string): boolean {
  const t = log.trim();
  if (!t) {
    return false;
  }
  const lower = t.toLowerCase();
  const mentionsForce =
    lower.includes('--force') ||
    /\bforce\b/.test(lower) ||
    /(?:^|[\s:])-f(?:\s|$|:)/i.test(t);
  if (!mentionsForce) {
    return false;
  }
  const ru = lower.includes('разбора параметра') || lower.includes('разбор параметра');
  const en = lower.includes('parameter parsing') || lower.includes('invalid parameter');
  return ru || en;
}

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

  if (raw.abortPatternMatched) {
    return {
      status: 'error',
      exitCode: raw.exitCode,
      signal: raw.signal ?? undefined,
      userMessage: INTERACTIVE_PROMPT_ABORT,
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

  if (op === 'import' && typeof code === 'number' && code !== 0) {
    const userMessage = isIbcmdForceParameterRejectedLog(logExcerpt)
      ? IMPORT_FORCE_PARAM_PARSE_MSG
      : mapImportExit(code);
    return {
      status: 'error',
      exitCode: code,
      signal: raw.signal ?? undefined,
      userMessage,
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
