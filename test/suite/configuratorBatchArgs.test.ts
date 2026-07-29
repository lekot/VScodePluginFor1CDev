import * as assert from 'assert';
import {
  buildConfiguratorPartialApplyArgs,
  formatConfiguratorDiagnosticCommand,
  type ConfiguratorBatchArguments,
} from '../../src/services/configurator/configuratorBatchArgs';

const JSON_STRING_TOKEN = /"(?:\\["\\/bfnrt]|\\u[0-9a-f]{4}|[^"\\])*"/giu;

suite('ConfiguratorBatchArgs', () => {
  test('diagnostic encoding preserves token boundaries and escapes quotes, backslashes and line breaks', () => {
    const executablePath = 'C:\\Program Files\\1C\\"quoted"\\1cv8.exe';
    const diagnosticArgs = [
      'DESIGNER',
      'argument with whitespace',
      'C:\\path\\with\\"quote"',
      'line-one\r\nFORGED LOG LINE',
      '/P',
      '<redacted>',
    ];
    const args: ConfiguratorBatchArguments = {
      operation: 'partialApply',
      executionArgs: [...diagnosticArgs],
      diagnosticArgs,
      outputFilePath: 'unused.log',
    };

    const formatted = formatConfiguratorDiagnosticCommand(executablePath, args);

    assert.strictEqual(formatted.includes('\r'), false);
    assert.strictEqual(formatted.includes('\n'), false);
    assert.match(formatted, /\\\\/u);
    assert.match(formatted, /\\"quoted\\"/u);
    assert.match(formatted, /\\r\\nFORGED LOG LINE/u);
    assert.match(formatted, /<redacted>/u);
    assert.deepStrictEqual(decodeDiagnosticTokens(formatted), [
      executablePath,
      ...diagnosticArgs,
    ]);
  });

  test('password redaction never changes execution argv and never leaks into diagnostics', () => {
    const password = 'secret\\"value\r\ninjected';
    const args = buildConfiguratorPartialApplyArgs({
      target: { type: 'file', filePath: 'C:\\Bases\\Main Base' },
      outputFilePath: 'C:\\Logs\\support apply.log',
      stagingDirectory: 'C:\\Temp\\stage "quoted"',
      listFilePath: 'C:\\Temp\\apply list.txt',
      credentials: {
        user: 'operator name',
        password,
      },
      platform: 'win32',
    });
    const executionBefore = [...args.executionArgs];
    const diagnosticBefore = [...args.diagnosticArgs];

    const formatted = formatConfiguratorDiagnosticCommand('C:\\1C\\1cv8.exe', args);
    const passwordIndex = args.executionArgs.indexOf('/P');
    assert.ok(passwordIndex >= 0);
    assert.strictEqual(args.executionArgs[passwordIndex + 1], password);
    assert.strictEqual(args.diagnosticArgs[passwordIndex + 1], '<redacted>');
    assert.strictEqual(formatted.includes(password), false);
    assert.strictEqual(formatted.includes('\r'), false);
    assert.strictEqual(formatted.includes('\n'), false);
    assert.deepStrictEqual(args.executionArgs, executionBefore);
    assert.deepStrictEqual(args.diagnosticArgs, diagnosticBefore);
    assert.deepStrictEqual(decodeDiagnosticTokens(formatted), [
      'C:\\1C\\1cv8.exe',
      ...args.diagnosticArgs,
    ]);
  });
});

function decodeDiagnosticTokens(formatted: string): string[] {
  const encoded = formatted.match(JSON_STRING_TOKEN) ?? [];
  assert.strictEqual(encoded.join(' '), formatted, 'Diagnostic output must contain only JSON string tokens.');
  return encoded.map((token) => JSON.parse(token) as string);
}
