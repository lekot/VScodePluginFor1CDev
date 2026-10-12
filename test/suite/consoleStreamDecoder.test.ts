import * as assert from 'assert';
import iconv from 'iconv-lite';
import {
  createIbcmdStreamChunkDecoders,
  detectLegacyCyrillicEncoding,
  decodeConsoleStream,
  decodeConsoleStreamAuto,
  decodeIbcmdProcessStreams,
  isLikelyUtf8,
} from '../../src/services/ibcmd/consoleStreamDecoder';
import { createPowerShellStreamChunkDecoders } from '../../src/services/skd/powershellStreamDecoder';

suite('consoleStreamDecoder detectLegacyCyrillicEncoding', () => {
  const message = 'Ошибка исключительной блокировки информационной базы.';

  test('detects ibcmd OEM866 output', () => {
    assert.strictEqual(detectLegacyCyrillicEncoding(iconv.encode(message, 'cp866')), 'cp866');
  });

  test('detects Windows-1251 output', () => {
    assert.strictEqual(detectLegacyCyrillicEncoding(iconv.encode(message, 'cp1251')), 'cp1251');
  });

  test('empty buffer returns cp866 as default', () => {
    assert.strictEqual(detectLegacyCyrillicEncoding(Buffer.alloc(0)), 'cp866');
  });

  test('single high-byte buffer detects encoding without crashing', () => {
    const singleByte = Buffer.from([0xc0]);
    const detected = detectLegacyCyrillicEncoding(singleByte);
    assert.ok(detected === 'cp866' || detected === 'cp1251');
  });

  test('high-byte buffer without Cyrillic characters returns cp866 as tie-breaker default', () => {
    const nonCyrillicHighBytes = Buffer.from([0xb0, 0xb1]);
    assert.strictEqual(detectLegacyCyrillicEncoding(nonCyrillicHighBytes), 'cp866');
  });
});

suite('consoleStreamDecoder isLikelyUtf8', () => {
  test('ASCII-only buffer returns true', () => {
    assert.strictEqual(isLikelyUtf8(Buffer.from('hello world', 'ascii')), true);
  });

  test('valid UTF-8 Cyrillic returns true', () => {
    assert.strictEqual(isLikelyUtf8(Buffer.from('Справочник', 'utf8')), true);
  });

  test('CP1251 Cyrillic returns false', () => {
    const raw = iconv.encode('Справочник', 'cp1251');
    assert.strictEqual(isLikelyUtf8(raw), false);
  });

  test('trailing incomplete UTF-8 sequence returns true', () => {
    // 'Справочник' in UTF-8, truncate last byte (mid-character)
    const full = Buffer.from('Справочник', 'utf8');
    const truncated = full.subarray(0, full.length - 1);
    assert.strictEqual(isLikelyUtf8(truncated), true);
  });

  test('empty buffer returns true', () => {
    assert.strictEqual(isLikelyUtf8(Buffer.alloc(0)), true);
  });
});

suite('consoleStreamDecoder decodeConsoleStream', () => {
  test('utf8 mode decodes UTF-8 bytes', () => {
    const buf = Buffer.from('Путь C:\\Users\\тест\\file', 'utf8');
    assert.strictEqual(decodeConsoleStream(buf, 'utf8'), 'Путь C:\\Users\\тест\\file');
  });

  test('oem866 mode decodes typical console bytes', () => {
    const raw = iconv.encode('Ошибка 3', 'cp866');
    assert.strictEqual(decodeConsoleStream(raw, 'oem866'), 'Ошибка 3');
  });

  test('windows1251 mode decodes ANSI Cyrillic', () => {
    const raw = iconv.encode('Сообщение', 'cp1251');
    assert.strictEqual(decodeConsoleStream(raw, 'windows1251'), 'Сообщение');
  });

  test('utf16le mode decodes UTF-16 LE bytes', () => {
    const buf = Buffer.from('Путь UTF-16', 'utf16le');
    assert.strictEqual(decodeConsoleStream(buf, 'utf16le'), 'Путь UTF-16');
  });

  test('empty buffer yields empty string for all modes', () => {
    const empty = Buffer.alloc(0);
    assert.strictEqual(decodeConsoleStream(empty, 'utf8'), '');
    assert.strictEqual(decodeConsoleStream(empty, 'utf16le'), '');
    assert.strictEqual(decodeConsoleStream(empty, 'oem866'), '');
    assert.strictEqual(decodeConsoleStream(empty, 'auto'), '');
  });
});

suite('consoleStreamDecoder decodeConsoleStreamAuto', () => {
  test('valid UTF-8 is decoded as UTF-8', () => {
    const buf = Buffer.from('Кириллица UTF-8', 'utf8');
    assert.strictEqual(decodeConsoleStreamAuto(buf), 'Кириллица UTF-8');
  });

  test('invalid UTF-8 bytes fall back to CP866', () => {
    const raw = iconv.encode('Только OEM', 'cp866');
    assert.strictEqual(decodeConsoleStreamAuto(raw), 'Только OEM');
  });

  test('invalid UTF-8 bytes fall back to CP1251', () => {
    const raw = iconv.encode('Только ANSI', 'cp1251');
    assert.strictEqual(decodeConsoleStreamAuto(raw), 'Только ANSI');
  });
});

suite('consoleStreamDecoder decodeIbcmdProcessStreams', () => {
  test('decodes stdout and stderr buffers with the selected encoding', () => {
    const streams = decodeIbcmdProcessStreams(
      iconv.encode('Вывод', 'cp1251'),
      iconv.encode('Ошибка', 'cp1251'),
      'windows1251',
    );

    assert.deepStrictEqual(streams, { stdout: 'Вывод', stderr: 'Ошибка' });
  });
});

suite('console stream decoders', () => {
  test('utf8 mode splits a multibyte character across chunks then flush is empty', () => {
    const dec = createIbcmdStreamChunkDecoders('utf8');
    const full = Buffer.from('я', 'utf8');
    assert.strictEqual(full.length, 2);
    const a = dec.decodeStdout(full.subarray(0, 1));
    const b = dec.decodeStdout(full.subarray(1, 2));
    assert.strictEqual(a + b, 'я');
    assert.strictEqual(dec.flushStdout(), '');
    assert.strictEqual(dec.flushStderr(), '');
  });

  test('utf8 mode flush completes trailing decoder state for stdout and stderr', () => {
    const dec = createIbcmdStreamChunkDecoders('utf8');
    const part = Buffer.from([0xf0, 0x9f, 0x98]); // incomplete 😀
    dec.decodeStdout(part);
    const tail = dec.flushStdout();
    assert.ok(tail.length > 0);
    const dec2 = createIbcmdStreamChunkDecoders('utf8');
    dec2.decodeStderr(part);
    assert.ok(dec2.flushStderr().length > 0);
  });

  test('utf16le mode merges BMP character split across stdout chunks', () => {
    const dec = createIbcmdStreamChunkDecoders('utf16le');
    const full = Buffer.from('я', 'utf16le');
    assert.strictEqual(full.length, 2);
    const a = dec.decodeStdout(full.subarray(0, 1));
    const b = dec.decodeStdout(full.subarray(1, 2));
    assert.strictEqual(a + b, 'я');
    assert.strictEqual(dec.flushStdout(), '');
  });

  test('oem866 and windows1251 have independent stdout/stderr decoders (same bytes)', () => {
    const oem = createIbcmdStreamChunkDecoders('oem866');
    const b = iconv.encode('X', 'cp866');
    assert.strictEqual(oem.decodeStdout(b), 'X');
    assert.strictEqual(oem.decodeStderr(b), 'X');
    assert.strictEqual(oem.flushStdout(), '');
    assert.strictEqual(oem.flushStderr(), '');

    const win = createIbcmdStreamChunkDecoders('windows1251');
    const b2 = iconv.encode('Y', 'cp1251');
    assert.strictEqual(win.decodeStdout(b2), 'Y');
    assert.strictEqual(win.decodeStderr(b2), 'Y');
  });

  test('auto: UTF-8 Cyrillic chunk decoded correctly', () => {
    const dec = createIbcmdStreamChunkDecoders('auto');
    const buf = Buffer.from('Импорт конфигурации из XML', 'utf8');
    const decoded = dec.decodeStdout(buf) + dec.flushStdout();
    assert.strictEqual(decoded, 'Импорт конфигурации из XML');
  });

  test('auto: CP1251 chunk decoded correctly', () => {
    const dec = createIbcmdStreamChunkDecoders('auto');
    const raw = iconv.encode('Справочник', 'cp1251');
    assert.strictEqual(dec.decodeStdout(raw), 'Справочник');
  });

  test('auto: ibcmd CP866 error is decoded without mojibake', () => {
    const message = 'Ошибка исключительной блокировки информационной базы.';
    const dec = createIbcmdStreamChunkDecoders('auto');
    assert.strictEqual(dec.decodeStderr(iconv.encode(message, 'cp866')), message);
  });

  for (const stream of ['stdout', 'stderr'] as const) {
    test(`PowerShell auto: CP866 розница survives every two-chunk split on ${stream}`, () => {
      const message = 'розница';
      const raw = iconv.encode(message, 'cp866');
      assert.strictEqual(raw.toString('hex'), 'e0aea7ada8e6a0');

      for (let split = 1; split < raw.length; split++) {
        const dec = createPowerShellStreamChunkDecoders();
        const decode = stream === 'stdout' ? dec.decodeStdout : dec.decodeStderr;
        const flush = stream === 'stdout' ? dec.flushStdout : dec.flushStderr;
        const actual = decode(raw.subarray(0, split))
          + decode(raw.subarray(split))
          + flush();
        assert.strictEqual(actual, message, `incorrect decode with split after byte ${split}`);
      }

      const dec = createPowerShellStreamChunkDecoders();
      const decode = stream === 'stdout' ? dec.decodeStdout : dec.decodeStderr;
      const flush = stream === 'stdout' ? dec.flushStdout : dec.flushStderr;
      const bytewise = [...raw].map((byte) => decode(Buffer.from([byte]))).join('') + flush();
      assert.strictEqual(bytewise, message, 'one-byte chunks must preserve the complete CP866 word');
    });

    test(`PowerShell auto: UTF-8 Cyrillic survives every two-chunk split on ${stream}`, () => {
      const message = 'Розница';
      const raw = Buffer.from(message, 'utf8');

      for (let split = 1; split < raw.length; split++) {
        const dec = createPowerShellStreamChunkDecoders();
        const decode = stream === 'stdout' ? dec.decodeStdout : dec.decodeStderr;
        const flush = stream === 'stdout' ? dec.flushStdout : dec.flushStderr;
        const actual = decode(raw.subarray(0, split))
          + decode(raw.subarray(split))
          + flush();
        assert.strictEqual(actual, message, `incorrect decode with split after byte ${split}`);
      }
    });
  }

  test('PowerShell auto: shared CP866 decision resolves an incomplete lead buffered on the other stream', () => {
    const dec = createPowerShellStreamChunkDecoders();
    const stdout = iconv.encode('розница', 'cp866');
    const stderr = iconv.encode('Ошибка', 'cp866');
    let decodedStdout = dec.decodeStdout(stdout.subarray(0, 1));
    let decodedStderr = dec.decodeStderr(stderr.subarray(0, 1));
    decodedStderr += dec.decodeStderr(stderr.subarray(1));
    decodedStdout += dec.decodeStdout(stdout.subarray(1));
    decodedStdout += dec.flushStdout();
    decodedStderr += dec.flushStderr();

    assert.strictEqual(decodedStdout, 'розница');
    assert.strictEqual(decodedStderr, 'Ошибка');
  });

  test('PowerShell auto: valid UTF-8 stream releases its bounded detection sample before end of stream', () => {
    const dec = createPowerShellStreamChunkDecoders();
    const message = 'А'.repeat(10000);
    const raw = Buffer.from(message, 'utf8');
    let decoded = '';
    let emittedBeforeEnd = false;

    for (let index = 0; index < raw.length; index++) {
      const chunk = dec.decodeStdout(raw.subarray(index, index + 1));
      decoded += chunk;
      emittedBeforeEnd ||= chunk.length > 0;
    }
    decoded += dec.flushStdout();

    assert.strictEqual(decoded, message);
    assert.strictEqual(emittedBeforeEnd, true, 'auto detection must not retain an unbounded stream prefix');
  });

  test('auto: ASCII-only chunks defer decision and decode as UTF-8', () => {
    const dec = createIbcmdStreamChunkDecoders('auto');
    const ascii = Buffer.from('hello world', 'ascii');
    assert.strictEqual(dec.decodeStdout(ascii), 'hello world');
    // After ASCII chunks, UTF-8 should still work
    const utf8chunk = Buffer.from('Тест', 'utf8');
    const decoded = dec.decodeStdout(utf8chunk) + dec.flushStdout();
    assert.strictEqual(decoded, 'Тест');
  });

  test('oem866 on Windows decodes CP866 chunks', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const dec = createIbcmdStreamChunkDecoders('oem866');
    const raw = iconv.encode('Путь не найден', 'cp866');
    assert.strictEqual(dec.decodeStderr(raw), 'Путь не найден');
  });
});
