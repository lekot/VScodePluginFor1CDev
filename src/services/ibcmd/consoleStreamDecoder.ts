import iconv from 'iconv-lite';
import type { IbcmdConsoleOutputEncoding } from './ibcmdConsoleEncodingTypes';

type LegacyCyrillicEncoding = 'cp866' | 'cp1251';
const AUTO_ENCODING_SAMPLE_BYTES = 256;
const AUTO_ENCODING_SAMPLE_CAPACITY = AUTO_ENCODING_SAMPLE_BYTES + 3;

function russianLetterCount(text: string): number {
  return text.match(/[А-Яа-яЁё]/gu)?.length ?? 0;
}

/**
 * Chooses the legacy Cyrillic code page whose decoded text contains more Russian letters.
 * CP866 wins ties (including when no Russian letters are present, e.g. binary/symbol bytes)
 * because ibcmd is a console application and Windows console defaults to OEM code page CP866.
 */
export function detectLegacyCyrillicEncoding(raw: Buffer): LegacyCyrillicEncoding {
  const cp866Score = russianLetterCount(iconv.decode(raw, 'cp866'));
  const cp1251Score = russianLetterCount(iconv.decode(raw, 'cp1251'));
  return cp866Score >= cp1251Score ? 'cp866' : 'cp1251';
}

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
 * Full-buffer heuristic: prefer UTF-8 when the byte sequence is valid UTF-8; on Windows otherwise detect CP866 / CP1251.
 */
export function decodeConsoleStreamAuto(raw: Buffer): string {
  if (raw.length === 0) {
    return '';
  }
  if (isValidUtf8Buffer(raw)) {
    return raw.toString('utf8');
  }
  return iconv.decode(raw, detectLegacyCyrillicEncoding(raw));
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
 * `auto` mode buffers at most 259 bytes per stream after its first non-ASCII byte.
 * An invalid UTF-8 sequence selects the better-scoring legacy Cyrillic encoding;
 * 256 complete valid UTF-8 bytes select UTF-8. Short streams are classified on flush.
 * The first stream that can be classified selects the shared encoding for stdout and stderr.
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
    let legacyEncoding: LegacyCyrillicEncoding = 'cp866';
    type AutoStreamState = {
      sample: Buffer;
      sampleBytes: number;
      utf8Decoder: InstanceType<typeof TextDecoder>;
    };
    const createState = (): AutoStreamState => ({
      sample: Buffer.allocUnsafe(AUTO_ENCODING_SAMPLE_CAPACITY),
      sampleBytes: 0,
      utf8Decoder: new TextDecoder('utf-8', { fatal: false }),
    });
    const decodeSelected = (chunk: Buffer, state: AutoStreamState): string => useUtf8
      ? state.utf8Decoder.decode(chunk, { stream: true })
      : iconv.decode(chunk, legacyEncoding);
    const decodePending = (state: AutoStreamState): string => {
      if (state.sampleBytes === 0) {
        return '';
      }
      const pending = state.sample.subarray(0, state.sampleBytes);
      state.sampleBytes = 0;
      return decodeSelected(pending, state);
    };
    const decodeAuto = (chunk: Buffer, state: AutoStreamState): string => {
      if (chunk.length === 0) {
        return '';
      }
      if (decided) {
        return decodePending(state) + decodeSelected(chunk, state);
      }

      let asciiPrefix = '';
      let candidate = chunk;
      if (state.sampleBytes === 0) {
        const firstHighByte = chunk.findIndex((byte) => byte >= 0x80);
        if (firstHighByte < 0) {
          return chunk.toString('ascii');
        }
        asciiPrefix = chunk.subarray(0, firstHighByte).toString('ascii');
        candidate = chunk.subarray(firstHighByte);
      }

      const remainingCapacity = AUTO_ENCODING_SAMPLE_CAPACITY - state.sampleBytes;
      const copiedBytes = Math.min(candidate.length, remainingCapacity);
      candidate.copy(state.sample, state.sampleBytes, 0, copiedBytes);
      state.sampleBytes += copiedBytes;

      const sample = state.sample.subarray(0, state.sampleBytes);
      const validUtf8Prefix = isLikelyUtf8(sample);
      const completeUtf8 = validUtf8Prefix && isValidUtf8Buffer(sample);
      if (!validUtf8Prefix) {
        decided = true;
        useUtf8 = false;
        legacyEncoding = detectLegacyCyrillicEncoding(sample);
      } else if (state.sampleBytes >= AUTO_ENCODING_SAMPLE_BYTES && completeUtf8) {
        decided = true;
        useUtf8 = true;
      } else if (state.sampleBytes >= AUTO_ENCODING_SAMPLE_CAPACITY) {
        // A valid UTF-8 sequence can be at most four bytes, so the bounded tail
        // allowance above should complete it. If it still cannot, use legacy decoding.
        decided = true;
        useUtf8 = false;
        legacyEncoding = detectLegacyCyrillicEncoding(sample);
      }

      if (!decided) {
        return asciiPrefix;
      }
      const rest = candidate.subarray(copiedBytes);
      return asciiPrefix + decodePending(state) + decodeSelected(rest, state);
    };
    const flushAuto = (state: AutoStreamState): string => {
      if (!decided && state.sampleBytes > 0) {
        const sample = state.sample.subarray(0, state.sampleBytes);
        useUtf8 = isValidUtf8Buffer(sample);
        if (!useUtf8) {
          legacyEncoding = detectLegacyCyrillicEncoding(sample);
        }
        decided = true;
      }
      const pending = decodePending(state);
      return pending + (useUtf8 ? state.utf8Decoder.decode() : '');
    };

    const stdout = createState();
    const stderr = createState();

    return {
      decodeStdout: (chunk: Buffer) => decodeAuto(chunk, stdout),
      decodeStderr: (chunk: Buffer) => decodeAuto(chunk, stderr),
      flushStdout: () => flushAuto(stdout),
      flushStderr: () => flushAuto(stderr),
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
