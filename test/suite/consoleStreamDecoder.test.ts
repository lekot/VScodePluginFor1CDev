import * as assert from 'assert';
import iconv from 'iconv-lite';
import {
  createIbcmdStreamChunkDecoders,
  decodeConsoleStream,
  decodeConsoleStreamAuto,
} from '../../src/services/ibcmd/consoleStreamDecoder';

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

  test('on Windows, invalid UTF-8 bytes fall back to CP866', () => {
    const raw = iconv.encode('Только OEM', 'cp866');
    if (process.platform === 'win32') {
      assert.strictEqual(decodeConsoleStreamAuto(raw), 'Только OEM');
    } else {
      // Non-Windows: invalid UTF-8 uses utf8 toString (replacement / mojibake), not OEM.
      assert.ok(typeof decodeConsoleStreamAuto(raw) === 'string');
    }
  });
});

suite('consoleStreamDecoder createIbcmdStreamChunkDecoders', () => {
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

  test('auto on Windows uses per-chunk CP866', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const dec = createIbcmdStreamChunkDecoders('auto');
    const raw = iconv.encode('Путь не найден', 'cp866');
    assert.strictEqual(dec.decodeStderr(raw), 'Путь не найден');
  });

  test('auto uses UTF-8 streaming decoder on non-Windows', () => {
    if (process.platform === 'win32') {
      return;
    }
    const dec = createIbcmdStreamChunkDecoders('auto');
    const buf = Buffer.from('unicode тест', 'utf8');
    assert.strictEqual(dec.decodeStdout(buf), 'unicode тест');
  });
});
