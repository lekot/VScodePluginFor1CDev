import * as assert from 'assert';
import {
  buildConfiguratorDumpExternalArgs,
  buildConfiguratorLoadExternalArgs,
  buildConfiguratorMinimalDumpArgs,
  buildConfiguratorPartialApplyArgs,
  formatConfiguratorDiagnosticCommand,
  type ConfiguratorBatchArguments,
} from '../../src/services/configurator/configuratorBatchArgs';

const JSON_STRING_TOKEN = /"(?:\\["\\/bfnrt]|\\u[0-9a-f]{4}|[^"\\])*"/giu;

suite('ConfiguratorBatchArgs', () => {
  for (const format of ['Plain', 'Hierarchical'] as const) {
    test(`dump external emits exact standalone argv with explicit ${format} format`, () => {
      const args = buildConfiguratorDumpExternalArgs({
        outputFilePath: 'C:\\logs\\out.log',
        dumpDirectory: 'C:\\src\\epf_src',
        externalFilePath: 'C:\\files\\MyProcessor.epf',
        format,
        platform: 'win32',
      });

      assert.strictEqual(args.operation, 'dumpExternal');
      assert.deepStrictEqual(args.executionArgs, [
        'DESIGNER',
        '/DisableStartupDialogs',
        '/DisableStartupMessages',
        '/Out',
        'C:\\logs\\out.log',
        '/DumpExternalDataProcessorOrReportToFiles',
        'C:\\src\\epf_src',
        'C:\\files\\MyProcessor.epf',
        '-Format',
        format,
      ]);
      assert.deepStrictEqual(args.diagnosticArgs, args.executionArgs);
    });
  }

  test('load external emits root XML before destination and never emits Format', () => {
    const args = buildConfiguratorLoadExternalArgs({
      outputFilePath: 'C:\\logs\\out.log',
      rootXmlPath: 'C:\\src\\MyProcessor.xml',
      destinationPath: 'C:\\files\\MyProcessor.epf',
      platform: 'win32',
    });

    assert.strictEqual(args.operation, 'loadExternal');
    assert.deepStrictEqual(args.executionArgs, [
      'DESIGNER',
      '/DisableStartupDialogs',
      '/DisableStartupMessages',
      '/Out',
      'C:\\logs\\out.log',
      '/LoadExternalDataProcessorOrReportFromFiles',
      'C:\\src\\MyProcessor.xml',
      'C:\\files\\MyProcessor.epf',
    ]);
    assert.strictEqual(args.executionArgs.some((token) => token.toLocaleLowerCase() === '-format'), false);
  });

  test('file-infobase argv contains F and redacts credentials without changing execution argv', () => {
    const password = 'secret\\"value\r\ninjected';
    const args = buildConfiguratorDumpExternalArgs({
      target: { type: 'file', filePath: 'C:\\Bases\\Main Base' },
      credentials: { user: 'operator', password },
      outputFilePath: 'C:\\Logs\\dump.log',
      dumpDirectory: 'C:\\Temp\\stage',
      externalFilePath: 'C:\\files\\MyProcessor.epf',
      format: 'Plain',
      platform: 'win32',
    });

    assert.deepStrictEqual(args.executionArgs.slice(0, 3), [
      'DESIGNER',
      '/F',
      'C:\\Bases\\Main Base',
    ]);
    assert.strictEqual(args.executionArgs[args.executionArgs.indexOf('/P') + 1], password);
    assert.strictEqual(args.diagnosticArgs[args.diagnosticArgs.indexOf('/P') + 1], '<redacted>');
    assert.strictEqual(formatConfiguratorDiagnosticCommand('C:\\1C\\1cv8.exe', args).includes(password), false);
  });

  test('standalone argv rejects credentials instead of silently ignoring them', () => {
    assert.throws(
      () => buildConfiguratorLoadExternalArgs({
        credentials: { user: 'operator', password: 'secret' },
        outputFilePath: 'out.log',
        rootXmlPath: 'processor.xml',
        destinationPath: 'processor.epf',
      }),
      /credentials require an infobase execution context/iu,
    );
  });

  test('support partial apply and minimal dump require an explicit file-infobase target at runtime', () => {
    assert.throws(
      () => buildConfiguratorPartialApplyArgs({
        outputFilePath: 'out.log',
        stagingDirectory: 'stage',
        listFilePath: 'list.txt',
      } as never),
      /target is required/iu,
    );
    assert.throws(
      () => buildConfiguratorMinimalDumpArgs({
        outputFilePath: 'out.log',
        dumpDirectory: 'dump',
        listFilePath: 'list.txt',
      } as never),
      /target is required/iu,
    );
  });

  test('standalone external commands reject even an empty credentials object', () => {
    assert.throws(
      () => buildConfiguratorDumpExternalArgs({
        credentials: {},
        outputFilePath: 'out.log',
        dumpDirectory: 'dump',
        externalFilePath: 'processor.epf',
      }),
      /credentials require an infobase execution context/iu,
    );
  });

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
