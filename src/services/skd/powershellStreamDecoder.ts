import iconv from 'iconv-lite';
import { detectLegacyCyrillicEncoding, isLikelyUtf8 } from '../ibcmd/consoleStreamDecoder';
import type { StreamChunkDecoders } from '../process/streamingProcessRunner';

const AUTO_ENCODING_SAMPLE_BYTES = 256;
const AUTO_ENCODING_SAMPLE_CAPACITY = AUTO_ENCODING_SAMPLE_BYTES + 3;

function isValidUtf8Buffer(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * PowerShell output is captured as a completed Agent SKD payload, so auto detection can retain a
 * bounded prefix while distinguishing UTF-8 from legacy console encodings. ibcmd keeps its own
 * immediate auto decoder because its interactive prompts must reach abort-pattern checks live.
 */
export function createPowerShellStreamChunkDecoders(): StreamChunkDecoders {
  let decided = false;
  let useUtf8 = true;
  let legacyEncoding: 'cp866' | 'cp1251' = 'cp866';

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
      // UTF-8 code points are at most four bytes; this allowance includes their trailing bytes.
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
    decodeStdout: (chunk) => decodeAuto(chunk, stdout),
    decodeStderr: (chunk) => decodeAuto(chunk, stderr),
    flushStdout: () => flushAuto(stdout),
    flushStderr: () => flushAuto(stderr),
  };
}
