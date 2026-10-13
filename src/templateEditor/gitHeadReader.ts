import type { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import {
  runStreamingProcess,
  type StreamCancellation,
  type StreamingProcessRawOutcome,
} from '../services/process/streamingProcessRunner';
import type { ProcessTreeTerminationOutcome } from '../services/ibcmd/processTreeTermination';

const DEFAULT_GIT_HEAD_TIMEOUT_MS = 30_000;
const DEFAULT_GIT_HEAD_STDOUT_LIMIT_BYTES = 256 * 1024 * 1024;
const DEFAULT_GIT_HEAD_STDERR_LIMIT_BYTES = 64 * 1024;

export type GitHeadReadErrorCode =
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT'
  | 'TERMINATION_FAILED'
  | 'SPAWN_FAILED'
  | 'GIT_FAILED';

export interface GitHeadReadOptions {
  token?: StreamCancellation;
  timeoutMs?: number;
}

export interface GitHeadReadDependencies {
  resolveGitExecutable?: () => Promise<string>;
  spawnImpl?: typeof spawn;
  terminateProcessTreeImpl?: (child: ChildProcess, graceMs: number) => Promise<ProcessTreeTerminationOutcome>;
  /** Test seam for exercising the overflow path with a small payload. */
  maxStdoutBytes?: number;
  /** Test seam for exercising the stderr overflow path with a small payload. */
  maxStderrBytes?: number;
}

export class GitHeadReadError extends Error {
  readonly name = 'GitHeadReadError';

  constructor(
    readonly code: GitHeadReadErrorCode,
    message: string,
    readonly processOutcome?: StreamingProcessRawOutcome
  ) {
    super(message);
  }
}

export async function readGitHeadProcess(
  file: string,
  options: GitHeadReadOptions,
  dependencies: GitHeadReadDependencies & { resolveGitExecutable: () => Promise<string> },
  cancellation: LinkedCancellation
): Promise<string> {
  if (cancellation.isCancellationRequested) {
    throw new GitHeadReadError('CANCELLED', 'Получение версии из Git отменено.');
  }

  let gitPath: string;
  try {
    gitPath = await dependencies.resolveGitExecutable();
  } catch (error) {
    if (cancellation.isCancellationRequested) {
      throw new GitHeadReadError('CANCELLED', 'Получение версии из Git отменено.');
    }
    throw error;
  }

  if (cancellation.isCancellationRequested) {
    throw new GitHeadReadError('CANCELLED', 'Получение версии из Git отменено.');
  }
  if (!gitPath || !path.isAbsolute(gitPath)) {
    throw new GitHeadReadError(
      'SPAWN_FAILED',
      'Встроенное расширение Git в VS Code не предоставило абсолютный путь к Git.'
    );
  }

  const maxStdoutBytes = Math.max(
    0,
    dependencies.maxStdoutBytes ?? DEFAULT_GIT_HEAD_STDOUT_LIMIT_BYTES
  );
  const maxStderrBytes = Math.max(
    0,
    dependencies.maxStderrBytes ?? DEFAULT_GIT_HEAD_STDERR_LIMIT_BYTES
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputLimitExceeded: 'stdout' | 'stderr' | undefined;

  const outcome = await runStreamingProcess({
    executablePath: gitPath,
    args: ['-c', 'core.quotepath=off', 'show', `HEAD:./${path.basename(file)}`],
    spawnOptions: { cwd: path.dirname(file) },
    timeoutMs: options.timeoutMs ?? DEFAULT_GIT_HEAD_TIMEOUT_MS,
    cancellation,
    ...(dependencies.spawnImpl ? { spawnImpl: dependencies.spawnImpl } : {}),
    ...(dependencies.terminateProcessTreeImpl
      ? { terminateProcessTreeImpl: dependencies.terminateProcessTreeImpl }
      : {}),
    onStreamChunk: (chunk, stream) => {
      if (outputLimitExceeded) {
        return;
      }
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (stream === 'stdout') {
        if (stdoutBytes + chunkBytes > maxStdoutBytes) {
          outputLimitExceeded = 'stdout';
          cancellation.cancel();
          return;
        }
        stdoutBytes += chunkBytes;
        stdout.push(chunk);
        return;
      }
      if (stderrBytes + chunkBytes > maxStderrBytes) {
        outputLimitExceeded = 'stderr';
        cancellation.cancel();
        return;
      }
      stderrBytes += chunkBytes;
      stderr.push(chunk);
    },
  });

  if (
    outcome.termination?.terminated === false ||
    outcome.spawnErrorCode === 'PROCESS_TREE_TERMINATION_FAILED'
  ) {
    throw new GitHeadReadError(
      'TERMINATION_FAILED',
      `Не удалось подтвердить остановку Git: ${outcome.spawnErrorMessage ?? outcome.termination?.errors.join('; ') ?? 'процесс или его дочерние процессы ещё работают.'}`,
      outcome
    );
  }
  if (outputLimitExceeded) {
    throw new GitHeadReadError(
      'OUTPUT_LIMIT',
      `Git превысил лимит ${outputLimitExceeded === 'stdout' ? 'stdout' : 'stderr'} при чтении версии файла.`,
      outcome
    );
  }
  if (outcome.cancelled) {
    throw new GitHeadReadError('CANCELLED', 'Получение версии из Git отменено.', outcome);
  }
  if (outcome.timedOut) {
    throw new GitHeadReadError('TIMEOUT', 'Превышено время ожидания ответа Git.', outcome);
  }
  if (outcome.spawnErrorCode || outcome.stdinErrorCode) {
    throw new GitHeadReadError(
      'SPAWN_FAILED',
      outcome.spawnErrorMessage ?? outcome.stdinErrorMessage ?? 'Не удалось запустить Git.',
      outcome
    );
  }

  const stderrText = stderr.join('');
  if (outcome.exitCode === 0) {
    return stripBom(stdout.join(''));
  }
  if (
    outcome.started &&
    outcome.exitCode !== null &&
    /exists on disk, but not in|does not exist in/.test(stderrText)
  ) {
    return '';
  }

  const diagnostic = stderrText.trim();
  throw new GitHeadReadError(
    'GIT_FAILED',
    diagnostic || `git show завершился с кодом ${String(outcome.exitCode)} без диагностики.`,
    outcome
  );
}

export class LinkedCancellation implements StreamCancellation {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();
  private readonly externalDisposable?: { dispose(): void };

  constructor(private readonly external?: StreamCancellation) {
    if (external?.isCancellationRequested) {
      this.cancelled = true;
    } else if (external) {
      this.externalDisposable = external.onCancellationRequested(() => this.cancel());
    }
  }

  get isCancellationRequested(): boolean {
    return this.cancelled || Boolean(this.external?.isCancellationRequested);
  }

  onCancellationRequested(listener: () => void): { dispose(): void } {
    if (this.isCancellationRequested) {
      listener();
      return { dispose: () => undefined };
    }
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const listener of this.listeners) {
      listener();
    }
  }

  dispose(): void {
    this.externalDisposable?.dispose();
    this.listeners.clear();
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
