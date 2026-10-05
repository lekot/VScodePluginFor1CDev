import type { Socket } from 'net';

export const SCOM_TRAILER = Buffer.from([0x66, 0x53, 0xb2, 0xa6]);
export const SCOM_ESCAPE = Buffer.from([0x65, 0x52, 0xb1, 0xa5]);

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Escapes reserved sequences inside a binary SCOM frame; the final trailer stays literal. */
export function encodeBinaryScomFrame(frame: Buffer): Buffer {
  if (!frame.subarray(-SCOM_TRAILER.length).equals(SCOM_TRAILER)) {
    throw new Error('Binary SCOM frame must end with its trailer.');
  }
  const body = frame.subarray(0, -SCOM_TRAILER.length);
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < body.length;) {
    const candidate = body.subarray(offset, offset + SCOM_TRAILER.length);
    if (candidate.equals(SCOM_TRAILER) || candidate.equals(SCOM_ESCAPE)) {
      pieces.push(SCOM_ESCAPE, candidate);
      offset += SCOM_TRAILER.length;
    } else {
      pieces.push(body.subarray(offset, offset + 1));
      offset += 1;
    }
  }
  pieces.push(SCOM_TRAILER);
  return Buffer.concat(pieces);
}

/**
 * Incremental SCOM reader. Text handshake frames use a plain trailer; binary frames
 * escape trailer and escape markers in their body. Partial TCP reads are retained.
 */
export class ScomFrameBuffer {
  private buffered = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) {return;}
    if (this.buffered.length + chunk.length > this.maxFrameBytes) {
      throw new Error(`TestClient response exceeds the ${this.maxFrameBytes}-byte frame limit.`);
    }
    this.buffered = this.buffered.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffered, chunk]);
  }

  takeTextFrame(): Buffer | undefined {
    const end = this.buffered.indexOf(SCOM_TRAILER);
    if (end < 0) {return undefined;}
    const frameEnd = end + SCOM_TRAILER.length;
    const frame = this.buffered.subarray(0, frameEnd);
    this.buffered = this.buffered.subarray(frameEnd);
    return frame;
  }

  takeBytes(length: number): Buffer | undefined {
    if (!Number.isInteger(length) || length < 1) {
      throw new Error('Requested raw TestClient prefix length must be a positive integer.');
    }
    if (this.buffered.length < length) {return undefined;}
    const bytes = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return bytes;
  }

  takeBinaryFrame(): Buffer | undefined {
    const decoded: Buffer[] = [];
    let offset = 0;
    while (offset < this.buffered.length) {
      const remaining = this.buffered.length - offset;
      const candidate = this.buffered.subarray(offset, offset + SCOM_TRAILER.length);
      if (remaining >= SCOM_TRAILER.length && candidate.equals(SCOM_TRAILER)) {
        const frameEnd = offset + SCOM_TRAILER.length;
        const frame = Buffer.concat([...decoded, SCOM_TRAILER]);
        this.buffered = this.buffered.subarray(frameEnd);
        return frame;
      }
      if (remaining < SCOM_TRAILER.length && isPrefix(candidate, SCOM_TRAILER)) {return undefined;}

      if (remaining >= SCOM_ESCAPE.length && candidate.equals(SCOM_ESCAPE)) {
        if (remaining < SCOM_ESCAPE.length * 2) {return undefined;}
        const escaped = this.buffered.subarray(offset + SCOM_ESCAPE.length, offset + SCOM_ESCAPE.length * 2);
        if (escaped.equals(SCOM_TRAILER) || escaped.equals(SCOM_ESCAPE)) {
          decoded.push(escaped);
          offset += SCOM_ESCAPE.length * 2;
          continue;
        }
        decoded.push(SCOM_ESCAPE);
        offset += SCOM_ESCAPE.length;
        continue;
      }

      decoded.push(this.buffered.subarray(offset, offset + 1));
      offset += 1;
    }
    return undefined;
  }

  get pendingBytes(): number {
    return this.buffered.length;
  }

  reset(): void {
    this.buffered = Buffer.alloc(0);
  }
}

export class NativeTestClientChannel {
  private readonly frames = new ScomFrameBuffer();
  private waiter?: {
    binary: boolean;
    byteCount?: number;
    resolve: (frame: Buffer) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    signal?: AbortSignal;
    abort?: () => void;
  };
  private closed = false;
  private terminalError?: Error;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('Соединение с TestClient закрыто.')));
  }

  get connected(): boolean {
    return !this.closed && !this.socket.destroyed && this.socket.readable && this.socket.writable;
  }

  async sendFrame(frame: Buffer, binary: boolean, signal?: AbortSignal): Promise<void> {
    this.throwIfClosed();
    if (signal?.aborted) {throw abortError();}
    const wire = binary ? encodeBinaryScomFrame(frame) : frame;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal?.removeEventListener('abort', onAbort);
        this.close();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.socket.write(wire, (error?: Error | null) => {
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          this.close();
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  readFrame(binary: boolean, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
    return this.readNext({ binary }, timeoutMs, signal);
  }

  readBytes(length: number, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
    return this.readNext({ binary: false, byteCount: length }, timeoutMs, signal);
  }

  private readNext(
    request: { binary: boolean; byteCount?: number },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    this.throwIfClosed();
    if (signal?.aborted) {return Promise.reject(abortError());}
    if (this.waiter) {return Promise.reject(new Error('Only one TestClient response may be read at a time.'));}
    const buffered = this.takeRequested(request);
    if (buffered) {return Promise.resolve(buffered);}
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectWaiter(new Error('Таймаут ответа TestClient; соединение закрыто, подключитесь повторно.'));
        this.close();
      }, timeoutMs);
      const abort = () => {
        this.rejectWaiter(abortError());
        this.close();
      };
      this.waiter = { ...request, resolve, reject, timer, signal, abort };
      signal?.addEventListener('abort', abort, { once: true });
      this.onData(Buffer.alloc(0));
    });
  }

  close(): void {
    if (this.closed) {return;}
    this.closed = true;
    this.rejectWaiter(new Error('Соединение с TestClient закрыто.'));
    this.frames.reset();
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    if (this.closed) {return;}
    try {
      this.frames.append(chunk);
      if (this.waiter) {
        const frame = this.takeRequested(this.waiter);
        if (frame) {
          const waiter = this.waiter;
          this.clearWaiter();
          waiter.resolve(frame);
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private takeFrame(binary: boolean): Buffer | undefined {
    return binary ? this.frames.takeBinaryFrame() : this.frames.takeTextFrame();
  }

  private takeRequested(request: { binary: boolean; byteCount?: number }): Buffer | undefined {
    return request.byteCount === undefined
      ? this.takeFrame(request.binary)
      : this.frames.takeBytes(request.byteCount);
  }

  private fail(error: Error): void {
    if (this.closed) {return;}
    this.terminalError = error;
    this.rejectWaiter(error);
    this.closed = true;
    this.frames.reset();
    this.socket.destroy();
  }

  private rejectWaiter(error: Error): void {
    const waiter = this.waiter;
    if (!waiter) {return;}
    this.clearWaiter();
    waiter.reject(error);
  }

  private clearWaiter(): void {
    const waiter = this.waiter;
    if (!waiter) {return;}
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.abort!);
    this.waiter = undefined;
  }

  private throwIfClosed(): void {
    if (this.closed || !this.connected) {
      throw this.terminalError ?? new Error('Соединение с TestClient закрыто.');
    }
  }
}

function isPrefix(value: Buffer, full: Buffer): boolean {
  return value.length <= full.length && full.subarray(0, value.length).equals(value);
}

function abortError(): Error {
  const error = new Error('Операция TestClient отменена.');
  error.name = 'AbortError';
  return error;
}
