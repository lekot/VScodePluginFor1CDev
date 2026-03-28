import { spawn, type ChildProcess } from 'child_process';
import type * as vscode from 'vscode';

/** Default ring buffer for captured stdout+stderr (design §6). */
export const IBCMD_STREAM_RING_BUFFER_MAX_BYTES = 384 * 1024;

export interface IbcmdStreamCancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): vscode.Disposable;
}

export interface IbcmdStreamingRunnerOptions {
  executablePath: string;
  args: string[];
  timeoutMs: number;
  cancellation: IbcmdStreamCancellation;
  /** Invoked for each decoded chunk (UTF-8). */
  onStreamChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  ringBufferMaxBytes?: number;
  /** Injected for tests (default: `child_process.spawn`). */
  spawnImpl?: typeof spawn;
}

export interface IbcmdStreamingRawOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Last N bytes of interleaved capture (stdout then stderr chunks in arrival order). */
  combinedLog: string;
  logTruncated: boolean;
  cancelled: boolean;
  timedOut: boolean;
  /** Set when spawn fails (e.g. ENOENT). */
  spawnErrorCode?: string;
  spawnErrorMessage?: string;
}

class RingBufferText {
  private buf = '';
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(s: string): void {
    if (!s) {
      return;
    }
    this.buf += s;
    if (this.buf.length > this.maxBytes) {
      this.truncated = true;
      this.buf = this.buf.slice(this.buf.length - this.maxBytes);
    }
  }

  get state(): { text: string; truncated: boolean } {
    return { text: this.buf, truncated: this.truncated };
  }
}

/** Long-running ibcmd: `spawn` + streaming stdout/stderr (does not use `runIbcmdExecutable`). */
export async function runIbcmdStreaming(
  options: IbcmdStreamingRunnerOptions,
): Promise<IbcmdStreamingRawOutcome> {
  const maxBytes = options.ringBufferMaxBytes ?? IBCMD_STREAM_RING_BUFFER_MAX_BYTES;
  const ring = new RingBufferText(maxBytes);
  const spawnFn = options.spawnImpl ?? spawn;

  let child: ChildProcess | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let cancelDisp: vscode.Disposable | undefined;

  const cleanupTimers = (): void => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };

  const killTree = (proc: ChildProcess | undefined): void => {
    if (!proc || proc.killed) {
      return;
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32') {
      setTimeout(() => {
        try {
          if (!proc.killed && proc.exitCode === null) {
            proc.kill('SIGKILL');
          }
        } catch {
          /* ignore */
        }
      }, 1500).unref?.();
    }
  };

  return await new Promise<IbcmdStreamingRawOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: IbcmdStreamingRawOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      cancelDisp?.dispose();
      const { text, truncated } = ring.state;
      resolve({ ...outcome, combinedLog: text, logTruncated: outcome.logTruncated || truncated });
    };

    try {
      child = spawnFn(options.executablePath, options.args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      finish({
        exitCode: null,
        signal: null,
        combinedLog: '',
        logTruncated: false,
        cancelled: false,
        timedOut: false,
        spawnErrorCode: typeof e.code === 'string' ? e.code : 'SPAWN_ERROR',
        spawnErrorMessage: e.message ?? String(err),
      });
      return;
    }

    if (!child) {
      finish({
        exitCode: null,
        signal: null,
        combinedLog: '',
        logTruncated: false,
        cancelled: false,
        timedOut: false,
        spawnErrorCode: 'NO_CHILD',
        spawnErrorMessage: 'spawn returned no child process',
      });
      return;
    }

    const onData =
      (stream: 'stdout' | 'stderr') =>
      (chunk: Buffer | string): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        ring.append(text);
        options.onStreamChunk?.(text, stream);
      };

    if (typeof child.stdout?.setEncoding === 'function') {
      child.stdout.setEncoding('utf8');
    }
    if (typeof child.stderr?.setEncoding === 'function') {
      child.stderr.setEncoding('utf8');
    }
    child.stdout?.on('data', onData('stdout'));
    child.stderr?.on('data', onData('stderr'));

    child.on('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      finish({
        exitCode: null,
        signal: null,
        combinedLog: '',
        logTruncated: false,
        cancelled: false,
        timedOut: false,
        spawnErrorCode: e.code,
        spawnErrorMessage: e.message,
      });
    });

    timeoutId = setTimeout(() => {
      killTree(child);
      const { text, truncated } = ring.state;
      finish({
        exitCode: null,
        signal: 'SIGTERM',
        combinedLog: text,
        logTruncated: truncated,
        cancelled: false,
        timedOut: true,
      });
    }, options.timeoutMs);

    if (options.cancellation.isCancellationRequested) {
      killTree(child);
      cleanupTimers();
      cancelDisp?.dispose();
      const { text, truncated } = ring.state;
      finish({
        exitCode: null,
        signal: 'SIGTERM',
        combinedLog: text,
        logTruncated: truncated,
        cancelled: true,
        timedOut: false,
      });
      return;
    }

    cancelDisp = options.cancellation.onCancellationRequested(() => {
      killTree(child);
    });

    child.on('close', (code, signal) => {
      cleanupTimers();
      cancelDisp?.dispose();
      const { text, truncated } = ring.state;
      const cancelled = options.cancellation.isCancellationRequested && code !== 0;
      finish({
        exitCode: code,
        signal: (signal as NodeJS.Signals | null) ?? null,
        combinedLog: text,
        logTruncated: truncated,
        cancelled,
        timedOut: false,
      });
    });
  });
}
