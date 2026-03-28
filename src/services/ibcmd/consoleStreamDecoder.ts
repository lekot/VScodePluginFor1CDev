import iconv from 'iconv-lite';
import type { IbcmdConsoleOutputEncoding } from './ibcmdConsoleEncodingTypes';

function isValidUtf8Buffer(buf: Buffer): boolean {
  if (buf.length === 0) {
    return true;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Full-buffer heuristic: prefer UTF-8 when the byte sequence is valid UTF-8; on Windows otherwise use CP866 (typical console).
 */
export function decodeConsoleStreamAuto(raw: Buffer): string {
  if (raw.length === 0) {
    return '';
  }
  if (isValidUtf8Buffer(raw)) {
    return raw.toString('utf8');
  }
  if (process.platform === 'win32') {
    return iconv.decode(raw, 'cp866');
  }
  return raw.toString('utf8');
}

export function decodeConsoleStream(raw: Buffer, mode: IbcmdConsoleOutputEncoding): string {
  if (raw.length === 0) {
    return '';
  }
  switch (mode) {
    case 'utf8':
      return raw.toString('utf8');
    case 'oem866':
      return iconv.decode(raw, 'cp866');
    case 'windows1251':
      return iconv.decode(raw, 'cp1251');
    case 'auto':
    default:
      return decodeConsoleStreamAuto(raw);
  }
}

export function decodeIbcmdProcessStreams(
  stdout: string | Buffer,
  stderr: string | Buffer,
  mode: IbcmdConsoleOutputEncoding,
): { stdout: string; stderr: string } {
  const outBuf = typeof stdout === 'string' ? Buffer.from(stdout, 'utf8') : stdout;
  const errBuf = typeof stderr === 'string' ? Buffer.from(stderr, 'utf8') : stderr;
  return {
    stdout: decodeConsoleStream(outBuf, mode),
    stderr: decodeConsoleStream(errBuf, mode),
  };
}

export interface IbcmdStreamChunkDecoders {
  decodeStdout: (chunk: Buffer) => string;
  decodeStderr: (chunk: Buffer) => string;
  flushStdout: () => string;
  flushStderr: () => string;
}

/**
 * Per-chunk decoding for spawn streams. CP866 / windows-1251 are single-byte; UTF-8 uses TextDecoder `{ stream: true }` per stream.
 * For `auto` on Windows, stream chunks as CP866 (same default as design ADR-2); use setting `utf8` if ibcmd already emits UTF-8.
 */
export function createIbcmdStreamChunkDecoders(mode: IbcmdConsoleOutputEncoding): IbcmdStreamChunkDecoders {
  const singleByte = (enc: 'cp866' | 'cp1251') => ({
    decodeStdout: (chunk: Buffer) => iconv.decode(chunk, enc),
    decodeStderr: (chunk: Buffer) => iconv.decode(chunk, enc),
    flushStdout: () => '',
    flushStderr: () => '',
  });

  if (mode === 'oem866') {
    return singleByte('cp866');
  }
  if (mode === 'windows1251') {
    return singleByte('cp1251');
  }

  const useUtf8Streaming = mode === 'utf8' || (mode === 'auto' && process.platform !== 'win32');
  if (useUtf8Streaming) {
    const dOut = new TextDecoder('utf-8', { fatal: false });
    const dErr = new TextDecoder('utf-8', { fatal: false });
    return {
      decodeStdout: (chunk: Buffer) => dOut.decode(chunk, { stream: true }),
      decodeStderr: (chunk: Buffer) => dErr.decode(chunk, { stream: true }),
      flushStdout: () => dOut.decode(),
      flushStderr: () => dErr.decode(),
    };
  }

  // auto + win32
  return singleByte('cp866');
}
