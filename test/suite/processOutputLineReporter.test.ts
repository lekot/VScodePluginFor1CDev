import * as assert from 'assert';
import {
  createProcessOutputLineReporter,
  PROCESS_OUTPUT_LINE_MAX_CHARS,
} from '../../src/services/process/processOutputLineReporter';

suite('ProcessOutputLineReporter', () => {
  test('assembles split lines and handles CRLF split across chunks', () => {
    const lines: string[] = [];
    const reporter = createProcessOutputLineReporter((line) => lines.push(line));
    reporter.accept('first par');
    reporter.accept('t\r');
    reporter.accept('\nsecond\nthird');
    reporter.flush();

    assert.deepStrictEqual(lines, ['first part', 'second', 'third']);
  });

  test('caps a process line and flushes the remaining unterminated text', () => {
    const lines: string[] = [];
    const reporter = createProcessOutputLineReporter((line) => lines.push(line));
    reporter.accept('x'.repeat(PROCESS_OUTPUT_LINE_MAX_CHARS * 2 + 5));
    reporter.flush();

    assert.strictEqual(lines.length, 3);
    assert.ok(lines.every((line) => line.length <= PROCESS_OUTPUT_LINE_MAX_CHARS));
    assert.ok(lines[0]?.endsWith('…'));
    assert.ok(lines[1]?.endsWith('…'));
    assert.strictEqual(lines.join('').replace(/…/gu, ''), 'x'.repeat(PROCESS_OUTPUT_LINE_MAX_CHARS * 2 + 5));
  });

  test('keeps a multi-byte character intact when a long line is split', () => {
    const lines: string[] = [];
    const reporter = createProcessOutputLineReporter((line) => lines.push(line));
    reporter.accept(`${'x'.repeat(PROCESS_OUTPUT_LINE_MAX_CHARS - 1)}🙂tail\n`);
    reporter.flush();

    assert.deepStrictEqual(lines, [
      `${'x'.repeat(PROCESS_OUTPUT_LINE_MAX_CHARS - 1)}…`,
      '🙂tail',
    ]);
  });

  test('drops empty output lines and accepts output without a reporting sink', () => {
    const lines: string[] = [];
    const reporter = createProcessOutputLineReporter((line) => lines.push(line));
    reporter.accept('\r\n\t\n useful output \n');
    reporter.flush();
    assert.deepStrictEqual(lines, ['useful output']);
    assert.doesNotThrow(() => {
      const silentReporter = createProcessOutputLineReporter(undefined);
      silentReporter.accept('output');
      silentReporter.flush();
    });
  });
});
