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
 * Heuristic check: returns true if the buffer looks like valid UTF-8.
 * Trailing incomplete multi-byte sequences (chunk boundary) are tolerated and not counted as errors.
 * Exported for unit testing.
 */
export function isLikelyUtf8(buf: Buffer): boolean {
  let i = 0;
  let invalidCount = 0;

  while (i < buf.length) {
    const b = buf[i];

    if (b <= 0x7f) {
      // ASCII single byte — always valid
      i++;
      continue;
    }

    // Determine expected continuation bytes
    let seqLen: number;
    if (b >= 0xc2 && b <= 0xdf) {
      seqLen = 2;
    } else if (b >= 0xe0 && b <= 0xef) {
      seqLen = 3;
    } else if (b >= 0xf0 && b <= 0xf4) {
      seqLen = 4;
    } else {
      // 0x80-0xBF without a lead, 0xC0-0xC1 (overlong), 0xF5+ — invalid
      invalidCount++;
      i++;
      continue;
    }

    const remaining = buf.length - i;
    if (remaining < seqLen) {
      // Trailing incomplete sequence at chunk boundary — tolerate, stop here
      break;
    }

    // Validate continuation bytes
    let valid = true;
    for (let k = 1; k < seqLen; k++) {
      const cb = buf[i + k];
      if (cb < 0x80 || cb > 0xbf) {
        valid = false;
        break;
      }
    }

    if (valid) {
      i += seqLen;
    } else {
      invalidCount++;
      i++;
    }
  }

  return invalidCount === 0;
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
    case 'utf16le':
      return raw.toString('utf16le');
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
 *
 * `auto` mode detects encoding on the first chunk containing non-ASCII bytes (≥ 0x80).
 * If that chunk is valid UTF-8, all subsequent chunks are decoded as UTF-8 streaming.
 * Otherwise the fallback encoding is CP1251 on Windows or CP866 on other platforms.
 * If no non-ASCII bytes appear before the stream ends, UTF-8 is used throughout.
 *
 * The encoding decision is shared between stdout and stderr: the first non-ASCII chunk
 * from either stream determines the encoding for both.
 *
 * `utf16le` uses UTF-16 LE streaming (e.g. some wide-character pipes / tools on Windows).
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

  if (mode === 'utf16le') {
    const dOut = new TextDecoder('utf-16le', { fatal: false });
    const dErr = new TextDecoder('utf-16le', { fatal: false });
    return {
      decodeStdout: (chunk: Buffer) => dOut.decode(chunk, { stream: true }),
      decodeStderr: (chunk: Buffer) => dErr.decode(chunk, { stream: true }),
      flushStdout: () => dOut.decode(),
      flushStderr: () => dErr.decode(),
    };
  }

  if (mode === 'auto') {
    let decided = false;
    let useUtf8 = true;
    const utf8Out = new TextDecoder('utf-8', { fatal: false });
    const utf8Err = new TextDecoder('utf-8', { fatal: false });
    const fallbackEnc = process.platform === 'win32' ? 'cp1251' : 'cp866';

    const decodeAuto = (chunk: Buffer, utf8Dec: InstanceType<typeof TextDecoder>): string => {
      if (!decided) {
        const hasHighBytes = chunk.some(b => b >= 0x80);
        if (hasHighBytes) {
          decided = true;
          useUtf8 = isLikelyUtf8(chunk);
          if (!useUtf8) {
            return iconv.decode(chunk, fallbackEnc);
          }
        }
      }
      if (useUtf8) {
        return utf8Dec.decode(chunk, { stream: true });
      }
      return iconv.decode(chunk, fallbackEnc);
    };

    return {
      decodeStdout: (chunk: Buffer) => decodeAuto(chunk, utf8Out),
      decodeStderr: (chunk: Buffer) => decodeAuto(chunk, utf8Err),
      flushStdout: () => (useUtf8 ? utf8Out.decode() : ''),
      flushStderr: () => (useUtf8 ? utf8Err.decode() : ''),
    };
  }

  if (mode === 'utf8') {
    const dOut = new TextDecoder('utf-8', { fatal: false });
    const dErr = new TextDecoder('utf-8', { fatal: false });
    return {
      decodeStdout: (chunk: Buffer) => dOut.decode(chunk, { stream: true }),
      decodeStderr: (chunk: Buffer) => dErr.decode(chunk, { stream: true }),
      flushStdout: () => dOut.decode(),
      flushStderr: () => dErr.decode(),
    };
  }

  const _exhaustive: never = mode;
  throw new Error(`Unexpected ibcmd consoleOutputEncoding: ${String(_exhaustive)}`);
}
