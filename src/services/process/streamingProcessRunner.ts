import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { StringDecoder } from 'string_decoder';
import {
  terminateProcessTree,
  type ProcessTreeTerminationOutcome,
} from '../ibcmd/processTreeTermination';

export const STREAMING_PROCESS_RING_BUFFER_MAX_BYTES = 384 * 1024;

export interface DisposableLike {
  dispose(): void;
}

export interface StreamCancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): DisposableLike;
}

export interface StreamChunkDecoders {
  decodeStdout(chunk: Buffer): string;
  decodeStderr(chunk: Buffer): string;
  flushStdout(): string;
  flushStderr(): string;
}

export interface StreamingProcessRunnerOptions {
  executablePath: string;
  args: readonly string[];
  timeoutMs: number;
  cancellation: StreamCancellation;
  onStreamChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Receives every redacted decoded character before bounded-log truncation. */
  inspectStreamChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  ringBufferMaxBytes?: number;
  spawnImpl?: typeof spawn;
  spawnOptions?: Pick<SpawnOptions, 'cwd' | 'env'>;
  streamDecoders?: StreamChunkDecoders;
  /** Exact values removed before chunks enter callbacks or the bounded log ring. */
  redactedValues?: readonly string[];
  abortPattern?: RegExp;
  terminationGraceMs?: number;
  terminateProcessTreeImpl?: (
    child: ChildProcess,
    graceMs: number
  ) => Promise<ProcessTreeTerminationOutcome>;
}

export interface StreamingProcessRawOutcome {
  /** True only after Node emitted `spawn`, not merely after `spawn()` returned a handle. */
  started: boolean;
  /**
   * True when a child handle was returned and termination/close left room for an external effect.
   * A synchronous throw or a genuine pre-`spawn` error event keeps this false.
   */
  effectPossible: boolean;
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

export async function runStreamingProcess(
  options: StreamingProcessRunnerOptions
): Promise<StreamingProcessRawOutcome> {
  const ring = new RingBufferText(
    options.ringBufferMaxBytes ?? STREAMING_PROCESS_RING_BUFFER_MAX_BYTES
  );
  if (options.cancellation.isCancellationRequested) {
    return {
      started: false,
      effectPossible: false,
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
    child = spawnFn(options.executablePath, [...options.args], {
      ...options.spawnOptions,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(process.platform === 'win32' ? {} : { detached: true }),
    });
  } catch (error) {
    const spawnError = error as NodeJS.ErrnoException;
    return {
      started: false,
      effectPossible: false,
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
      started: false,
      effectPossible: false,
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

  return new Promise<StreamingProcessRawOutcome>((resolve) => {
    let settled = false;
    let started = false;
    let effectPossible = true;
    let streamsFlushed = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancelDisposable: DisposableLike | undefined;
    let terminationReason: TerminationReason | undefined;
    let closeExitCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    const decoders = options.streamDecoders ?? createUtf8StreamChunkDecoders();
    const stdoutRedactor = new StreamingTextRedactor(options.redactedValues ?? []);
    const stderrRedactor = new StreamingTextRedactor(options.redactedValues ?? []);

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
      const tailOut = stdoutRedactor.append(decoders.flushStdout()) + stdoutRedactor.flush();
      const tailErr = stderrRedactor.append(decoders.flushStderr()) + stderrRedactor.flush();
      if (tailOut) {
        options.inspectStreamChunk?.(tailOut, 'stdout');
        ring.append(tailOut);
        options.onStreamChunk?.(tailOut, 'stdout');
      }
      if (tailErr) {
        options.inspectStreamChunk?.(tailErr, 'stderr');
        ring.append(tailErr);
        options.onStreamChunk?.(tailErr, 'stderr');
      }
    };

    const finish = (
      outcome: Omit<
        StreamingProcessRawOutcome,
        'started' | 'effectPossible' | 'combinedLog' | 'logTruncated'
      >
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const state = ring.state;
      resolve({
        ...outcome,
        started,
        effectPossible,
        combinedLog: state.text,
        logTruncated: state.truncated,
      });
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
      const decoded = stream === 'stdout'
        ? decoders.decodeStdout(bytes)
        : decoders.decodeStderr(bytes);
      const text = stream === 'stdout'
        ? stdoutRedactor.append(decoded)
        : stderrRedactor.append(decoded);
      if (!text) {
        return;
      }
      options.inspectStreamChunk?.(text, stream);
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
    child.on('spawn', () => {
      started = true;
    });

    child.on('error', (error) => {
      flushDecodedStreams();
      const spawnError = error as NodeJS.ErrnoException;
      if (!started) {
        effectPossible = false;
        finish({
          exitCode: null,
          signal: null,
          cancelled: false,
          timedOut: false,
          ...(spawnError.code ? { spawnErrorCode: spawnError.code } : {}),
          spawnErrorMessage: spawnError.message,
        });
        return;
      }
      if (terminationReason) {
        return;
      }
      finish({
        exitCode: null,
        signal: null,
        cancelled: false,
        timedOut: false,
        ...(spawnError.code ? { spawnErrorCode: spawnError.code } : {}),
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

    timeoutId = setTimeout(() => requestTermination('timedOut'), Math.max(0, options.timeoutMs));
    cancelDisposable = options.cancellation.onCancellationRequested(() =>
      requestTermination('cancelled')
    );
    if (options.cancellation.isCancellationRequested) {
      requestTermination('cancelled');
    }
  });
}

class StreamingTextRedactor {
  private readonly secrets: readonly string[];
  private readonly retainedCharacters: number;
  private pending = '';

  constructor(values: readonly string[]) {
    this.secrets = [...new Set(values.filter((value) => value.length > 0))]
      .sort((left, right) => right.length - left.length);
    this.retainedCharacters = Math.max(0, ...this.secrets.map((secret) => secret.length - 1));
  }

  append(text: string): string {
    this.pending += text;
    if (this.secrets.length === 0) {
      const complete = this.pending;
      this.pending = '';
      return complete;
    }
    let emitLength = Math.max(0, this.pending.length - this.retainedCharacters);
    for (const secret of this.secrets) {
      const crossingStart = this.pending.lastIndexOf(secret, Math.max(0, emitLength - 1));
      if (crossingStart >= 0 && crossingStart < emitLength && crossingStart + secret.length > emitLength) {
        emitLength = crossingStart;
      }
    }
    const complete = this.pending.slice(0, emitLength);
    this.pending = this.pending.slice(emitLength);
    return redactValues(complete, this.secrets);
  }

  flush(): string {
    const complete = redactValues(this.pending, this.secrets);
    this.pending = '';
    return complete;
  }
}

function redactValues(text: string, values: readonly string[]): string {
  return values.reduce(
    (redacted, value) => redacted.split(value).join('<redacted>'),
    text
  );
}

function createUtf8StreamChunkDecoders(): StreamChunkDecoders {
  const stdout = new StringDecoder('utf8');
  const stderr = new StringDecoder('utf8');
  return {
    decodeStdout: (chunk) => stdout.write(chunk),
    decodeStderr: (chunk) => stderr.write(chunk),
    flushStdout: () => stdout.end(),
    flushStderr: () => stderr.end(),
  };
}
