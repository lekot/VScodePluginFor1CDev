import { spawn, type ChildProcess } from 'child_process';
import type { IbcmdConsoleOutputEncoding } from './ibcmdConsoleEncodingTypes';
import { createIbcmdStreamChunkDecoders } from './consoleStreamDecoder';
import {
  envForIbcmdExplicitConfigSpawn,
  ibcmdArgvImpliesExplicitOfflineConnection,
} from './ibcmdSpawnEnv';
import {
  terminateProcessTree,
  type ProcessTreeTerminationOutcome,
} from './processTreeTermination';

export const IBCMD_STREAM_RING_BUFFER_MAX_BYTES = 384 * 1024;

export interface IDisposable {
  dispose(): void;
}

export interface IbcmdStreamCancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): IDisposable;
}

export interface IbcmdStreamingRunnerOptions {
  executablePath: string;
  args: string[];
  timeoutMs: number;
  cancellation: IbcmdStreamCancellation;
  consoleOutputEncoding?: IbcmdConsoleOutputEncoding;
  onStreamChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  ringBufferMaxBytes?: number;
  spawnImpl?: typeof spawn;
  abortPattern?: RegExp;
  terminationGraceMs?: number;
  terminateProcessTreeImpl?: (
    child: ChildProcess,
    graceMs: number
  ) => Promise<ProcessTreeTerminationOutcome>;
}

export interface IbcmdStreamingRawOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  combinedLog: string;
  logTruncated: boolean;
  cancelled: boolean;
  timedOut: boolean;
  spawnErrorCode?: string;
  spawnErrorMessage?: string;
  abortPatternMatched?: boolean;
  termination?: ProcessTreeTerminationOutcome;
}

export class RingBufferText {
  private chunks: Buffer[] = [];
  private headIndex = 0;
  private headOffset = 0;
  private byteLength = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(text: string): void {
    if (!text) {
      return;
    }
    const chunk = Buffer.from(text, 'utf-8');
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
    this.trimToLimit();
  }

  get state(): { text: string; truncated: boolean } {
    const retained: Buffer[] = [];
    for (let index = this.headIndex; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
      retained.push(index === this.headIndex && this.headOffset > 0 ? chunk.subarray(this.headOffset) : chunk);
    }
    return {
      text: Buffer.concat(retained, this.byteLength).toString('utf-8'),
      truncated: this.truncated,
    };
  }

  /** Total backing-buffer storage retained by the ring. */
  get retainedStorageBytes(): number {
    return this.chunks.reduce((total, chunk) => total + chunk.length, 0);
  }

  private trimToLimit(): void {
    const limit = Math.max(0, this.maxBytes);
    let bytesToDrop = this.byteLength - limit;
    if (bytesToDrop <= 0) {
      return;
    }
    this.truncated = true;
    while (bytesToDrop > 0 && this.headIndex < this.chunks.length) {
      const available = this.chunks[this.headIndex].length - this.headOffset;
      if (bytesToDrop < available) {
        this.headOffset += bytesToDrop;
        this.byteLength -= bytesToDrop;
        bytesToDrop = 0;
        break;
      }
      bytesToDrop -= available;
      this.byteLength -= available;
      this.headIndex += 1;
      this.headOffset = 0;
    }
    this.alignHeadToUtf8Boundary();
    if (this.headIndex > 0) {
      this.chunks = this.chunks.slice(this.headIndex);
      this.headIndex = 0;
    }
    if (this.headOffset > 0 && this.chunks.length > 0) {
      this.chunks[0] = Buffer.from(this.chunks[0].subarray(this.headOffset));
      this.headOffset = 0;
    }
  }

  private alignHeadToUtf8Boundary(): void {
    while (this.headIndex < this.chunks.length) {
      const chunk = this.chunks[this.headIndex];
      while (
        this.headOffset < chunk.length &&
        (chunk[this.headOffset] & 0xc0) === 0x80
      ) {
        this.headOffset += 1;
        this.byteLength -= 1;
      }
      if (this.headOffset < chunk.length) {
        return;
      }
      this.headIndex += 1;
      this.headOffset = 0;
    }
  }
}

type TerminationReason = 'cancelled' | 'timedOut' | 'abortPattern';

export async function runIbcmdStreaming(
  options: IbcmdStreamingRunnerOptions
): Promise<IbcmdStreamingRawOutcome> {
  const ring = new RingBufferText(
    options.ringBufferMaxBytes ?? IBCMD_STREAM_RING_BUFFER_MAX_BYTES
  );
  if (options.cancellation.isCancellationRequested) {
    return {
      exitCode: null,
      signal: null,
      combinedLog: '',
      logTruncated: false,
      cancelled: true,
      timedOut: false,
    };
  }

  const spawnFn = options.spawnImpl ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnFn(options.executablePath, options.args, {
      ...(ibcmdArgvImpliesExplicitOfflineConnection(options.args)
        ? { env: envForIbcmdExplicitConfigSpawn() }
        : {}),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(process.platform === 'win32' ? {} : { detached: true }),
    });
  } catch (error) {
    const spawnError = error as NodeJS.ErrnoException;
    return {
      exitCode: null,
      signal: null,
      combinedLog: '',
      logTruncated: false,
      cancelled: false,
      timedOut: false,
      spawnErrorCode: spawnError.code ?? 'SPAWN_ERROR',
      spawnErrorMessage: spawnError.message,
    };
  }

  if (!child) {
    return {
      exitCode: null,
      signal: null,
      combinedLog: '',
      logTruncated: false,
      cancelled: false,
      timedOut: false,
      spawnErrorCode: 'NO_CHILD',
      spawnErrorMessage: 'spawn returned no child process',
    };
  }

  return new Promise<IbcmdStreamingRawOutcome>((resolve) => {
    let settled = false;
    let streamsFlushed = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancelDisposable: IDisposable | undefined;
    let terminationReason: TerminationReason | undefined;
    let closeExitCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    const encoding = options.consoleOutputEncoding ?? 'auto';
    const decoders = createIbcmdStreamChunkDecoders(encoding);

    const cleanup = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      cancelDisposable?.dispose();
      cancelDisposable = undefined;
    };

    const flushDecodedStreams = (): void => {
      if (streamsFlushed) {
        return;
      }
      streamsFlushed = true;
      const tailOut = decoders.flushStdout();
      const tailErr = decoders.flushStderr();
      if (tailOut) {
        ring.append(tailOut);
        options.onStreamChunk?.(tailOut, 'stdout');
      }
      if (tailErr) {
        ring.append(tailErr);
        options.onStreamChunk?.(tailErr, 'stderr');
      }
    };

    const finish = (
      outcome: Omit<IbcmdStreamingRawOutcome, 'combinedLog' | 'logTruncated'>
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const state = ring.state;
      resolve({ ...outcome, combinedLog: state.text, logTruncated: state.truncated });
    };

    const requestTermination = (reason: TerminationReason): void => {
      if (settled || terminationReason) {
        return;
      }
      terminationReason = reason;
      cleanup();
      const graceMs = Math.max(0, options.terminationGraceMs ?? 1500);
      const terminate =
        options.terminateProcessTreeImpl ??
        ((target: ChildProcess, targetGraceMs: number) =>
          terminateProcessTree(target, { graceMs: targetGraceMs }));
      void terminate(child, graceMs)
        .catch((error): ProcessTreeTerminationOutcome => ({
          terminated: false,
          hardKillUsed: false,
          survivingPids: child.pid ? [child.pid] : [],
          errors: [error instanceof Error ? error.message : String(error)],
        }))
        .then((termination) => {
          flushDecodedStreams();
          const cleanupFailed = !termination.terminated;
          finish({
            exitCode: closeExitCode ?? child.exitCode,
            signal: closeSignal ?? 'SIGTERM',
            cancelled: reason === 'cancelled',
            timedOut: reason === 'timedOut',
            ...(reason === 'abortPattern' ? { abortPatternMatched: true } : {}),
            ...(cleanupFailed
              ? {
                  spawnErrorCode: 'PROCESS_TREE_TERMINATION_FAILED',
                  spawnErrorMessage: termination.errors.join('; ') || 'Process tree survived termination',
                }
              : {}),
            termination,
          });
        });
    };

    const appendDecoded = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk;
      const text =
        stream === 'stdout'
          ? decoders.decodeStdout(bytes)
          : decoders.decodeStderr(bytes);
      if (!text) {
        return;
      }
      ring.append(text);
      if (options.abortPattern && !settled && !terminationReason) {
        options.abortPattern.lastIndex = 0;
        if (options.abortPattern.test(ring.state.text)) {
          requestTermination('abortPattern');
          return;
        }
      }
      options.onStreamChunk?.(text, stream);
    };

    child.stdout?.on('data', (chunk) => appendDecoded('stdout', chunk));
    child.stderr?.on('data', (chunk) => appendDecoded('stderr', chunk));

    child.on('error', (error) => {
      if (terminationReason) {
        return;
      }
      flushDecodedStreams();
      const spawnError = error as NodeJS.ErrnoException;
      finish({
        exitCode: null,
        signal: null,
        cancelled: false,
        timedOut: false,
        spawnErrorCode: spawnError.code,
        spawnErrorMessage: spawnError.message,
      });
    });

    child.on('close', (code, signal) => {
      closeExitCode = code;
      closeSignal = (signal as NodeJS.Signals | null) ?? null;
      if (terminationReason) {
        return;
      }
      flushDecodedStreams();
      finish({
        exitCode: code,
        signal: closeSignal,
        cancelled: false,
        timedOut: false,
      });
    });

    timeoutId = setTimeout(() => requestTermination('timedOut'), options.timeoutMs);
    cancelDisposable = options.cancellation.onCancellationRequested(() =>
      requestTermination('cancelled')
    );
    if (options.cancellation.isCancellationRequested) {
      requestTermination('cancelled');
    }
  });
}
