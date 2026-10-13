import type { IbcmdConsoleOutputEncoding, IbcmdRunOutcome } from './ibcmdConsoleEncodingTypes';
import {
  RingBufferText,
  runIbcmdStreaming,
  type IbcmdStreamCancellation,
  type IbcmdStreamingRawOutcome,
  type IbcmdStreamingRunnerOptions,
} from './IbcmdStreamingRunner';

/** Same per-stream bound previously used by `execFile` for legacy ibcmd callers. */
export const IBCMD_EXEC_MAX_BUFFER = 4 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 600_000;

export interface IbcmdExecutableProcessOptions extends Pick<
  IbcmdStreamingRunnerOptions,
  'spawnImpl' | 'terminateProcessTreeImpl' | 'terminationGraceMs' | 'redactedValues'
> {
  cancellation?: IbcmdStreamCancellation;
  consoleOutputEncoding?: IbcmdConsoleOutputEncoding;
  /** Maximum retained diagnostic output for each stream. Defaults to the legacy maxBuffer. */
  maxBuffer?: number;
}

export interface IbcmdExecutableRawOutcome extends IbcmdStreamingRawOutcome {
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  processMaxBuffer: number;
}

export interface IbcmdExecutableError extends Error {
  code?: number | string;
  status?: number;
  signal?: NodeJS.Signals;
  killed?: boolean;
  stdout: string;
  stderr: string;
  started: boolean;
  effectPossible: boolean;
  termination?: IbcmdStreamingRawOutcome['termination'];
  processOutcome: IbcmdExecutableRawOutcome;
}

const NEVER_CANCELLED: IbcmdStreamCancellation = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

/**
 * Timeout: positive `settingsTimeoutMs` wins; else `IBCMD_TIMEOUT_MS` if valid; else 600000.
 */
export function resolveIbcmdTimeoutMs(settingsTimeoutMs: number | undefined, envTimeoutRaw: string | undefined): number {
  if (typeof settingsTimeoutMs === 'number' && settingsTimeoutMs > 0 && Number.isFinite(settingsTimeoutMs)) {
    return settingsTimeoutMs;
  }
  const envMs = Number.parseInt(envTimeoutRaw ?? '', 10);
  if (Number.isFinite(envMs) && envMs > 0) {
    return envMs;
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Runs an owned one-shot ibcmd command with the shared lifecycle and bounded output.
 * The separated decoded streams and raw lifecycle receipt keep legacy consumers compatible
 * while allowing preflight to distinguish cancellation from an uncertain post-spawn result.
 */
export async function runIbcmdExecutableRaw(
  executable: string,
  args: string[],
  timeoutMs: number,
  options: IbcmdExecutableProcessOptions = {},
): Promise<IbcmdExecutableRawOutcome> {
  const maxBuffer = Math.max(0, options.maxBuffer ?? IBCMD_EXEC_MAX_BUFFER);
  const stdout = new RingBufferText(maxBuffer);
  const stderr = new RingBufferText(maxBuffer);
  const raw = await runIbcmdStreaming({
    executablePath: executable,
    args,
    timeoutMs,
    cancellation: options.cancellation ?? NEVER_CANCELLED,
    consoleOutputEncoding: options.consoleOutputEncoding ?? 'auto',
    ringBufferMaxBytes: maxBuffer,
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
    ...(options.terminateProcessTreeImpl
      ? { terminateProcessTreeImpl: options.terminateProcessTreeImpl }
      : {}),
    ...(options.terminationGraceMs !== undefined
      ? { terminationGraceMs: options.terminationGraceMs }
      : {}),
    ...(options.redactedValues ? { redactedValues: options.redactedValues } : {}),
    onStreamChunk: (chunk, stream) => {
      (stream === 'stdout' ? stdout : stderr).append(chunk);
    },
  });
  const stdoutState = stdout.state;
  const stderrState = stderr.state;
  return {
    ...raw,
    stdout: stdoutState.text,
    stderr: stderrState.text,
    outputTruncated: stdoutState.truncated || stderrState.truncated,
    processMaxBuffer: maxBuffer,
  };
}

function execFileCompatibleError(outcome: IbcmdExecutableRawOutcome): IbcmdExecutableError {
  let code: string | number | undefined = outcome.spawnErrorCode;
  let message = outcome.spawnErrorMessage ?? 'ibcmd process failed.';
  let killed = false;
  if (outcome.outputTruncated) {
    code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    message = `ibcmd output exceeded maxBuffer (${outcome.processMaxBuffer} bytes).`;
    killed = true;
  } else if (outcome.timedOut) {
    code = 'ETIMEDOUT';
    message = 'ibcmd process timed out.';
    killed = true;
  } else if (outcome.cancelled) {
    code = 'ABORT_ERR';
    message = 'ibcmd process was cancelled.';
    killed = true;
  } else if (typeof outcome.exitCode === 'number' && outcome.exitCode !== 0) {
    code = outcome.exitCode;
    message = `ibcmd exited with code ${outcome.exitCode}.`;
  } else if (outcome.exitCode !== 0 && !code) {
    code = 'PROCESS_EXIT_UNKNOWN';
    message = 'ibcmd process exited without a numeric code.';
  }

  const error = new Error(message) as IbcmdExecutableError;
  error.name = 'IbcmdExecutableError';
  if (code !== undefined) {
    error.code = code;
  }
  if (typeof outcome.exitCode === 'number') {
    error.status = outcome.exitCode;
  }
  if (outcome.signal) {
    error.signal = outcome.signal;
  }
  if (killed) {
    error.killed = true;
  }
  error.stdout = outcome.stdout;
  error.stderr = outcome.stderr;
  error.started = outcome.started;
  error.effectPossible = outcome.effectPossible;
  if (outcome.termination) {
    error.termination = outcome.termination;
  }
  error.processOutcome = outcome;
  return error;
}

/**
 * Legacy decoded output/exit contract backed by the shared streaming lifecycle.
 * Nonzero exit, timeout, cancellation, spawn failure, and overflow still reject with
 * execFile-compatible `code`/`status`/`stdout`/`stderr` fields.
 */
export async function runIbcmdExecutable(
  executable: string,
  args: string[],
  timeoutMs: number,
  options: IbcmdExecutableProcessOptions = {},
): Promise<IbcmdRunOutcome> {
  const outcome = await runIbcmdExecutableRaw(executable, args, timeoutMs, options);
  if (
    outcome.spawnErrorCode
    || outcome.spawnErrorMessage
    || outcome.cancelled
    || outcome.timedOut
    || outcome.exitCode !== 0
    || outcome.outputTruncated
  ) {
    throw execFileCompatibleError(outcome);
  }
  return { stdout: outcome.stdout, stderr: outcome.stderr };
}
