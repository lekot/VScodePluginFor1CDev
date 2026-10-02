import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import * as vscode from 'vscode';
import {
  BslSignatureHelpProvider,
  registerBslSignatureHelpProvider,
  type BslSignatureRoutineSource,
} from '../../src/providers/bslSignatureHelpProvider';
import { BslLocalCompletionIndex } from '../../src/providers/bslLocalCompletionIndex';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

function makeDocument(text: string): vscode.TextDocument {
  const lines = text.split(/\r?\n/u);
  return {
    uri: vscode.Uri.file('C:\\work\\CommonModules\\Module\\Ext\\Module.bsl'),
    version: 1,
    lineCount: lines.length,
    getText: () => text,
    offsetAt: (position: vscode.Position) => {
      const before = lines.slice(0, position.line).reduce((length, line) => length + line.length + 1, 0);
      return before + Math.min(position.character, (lines[position.line] ?? '').length);
    },
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
  } as unknown as vscode.TextDocument;
}

function positionAt(text: string, offset = text.length): vscode.Position {
  const before = text.slice(0, offset);
  const lines = before.split(/\r?\n/u);
  return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}

async function getHelp(
  provider: BslSignatureHelpProvider,
  text: string,
  offset = text.length,
): Promise<vscode.SignatureHelp | undefined> {
  return provider.provideSignatureHelp(
    makeDocument(text),
    positionAt(text, offset),
    { isCancellationRequested: false } as vscode.CancellationToken,
    {
      triggerKind: vscode.SignatureHelpTriggerKind.Invoke,
      triggerCharacter: undefined,
      isRetrigger: false,
      activeSignatureHelp: undefined,
    },
  ) as Promise<vscode.SignatureHelp | undefined>;
}

suite('BSL Signature Help', () => {
  setup(() => resetVscodeTestState());
  teardown(() => resetVscodeTestState());

  test('registers the BSL provider for opening parentheses and commas', () => {
    const context = { subscriptions: [] as vscode.Disposable[] };
    const disposable = registerBslSignatureHelpProvider(context as never);
    const registration = vscodeTestState.registeredSignatureHelpProviders[0];

    assert.strictEqual(vscodeTestState.registeredSignatureHelpProviders.length, 1);
    assert.deepStrictEqual(registration.selector, { language: 'bsl' });
    assert.deepStrictEqual(registration.triggerCharacters, ['(', ',']);
    assert.strictEqual(context.subscriptions[0], disposable);
    disposable.dispose();
    assert.strictEqual(registration.disposed, true);
  });

  test('shows Structure overloads and marks repeated values after a top-level comma', async () => {
    const provider = new BslSignatureHelpProvider();
    const empty = await getHelp(provider, 'Новый Структура(');
    assert.ok(empty);
    assert.deepStrictEqual(empty?.signatures.map(({ label }) => label), [
      'Структура(Ключи, Значение1, …)',
      'Структура(ФиксированнаяСтруктура)',
    ]);
    assert.strictEqual(empty?.activeSignature, 0);
    assert.strictEqual(empty?.activeParameter, 0);

    const values = await getHelp(provider, 'Новый Structure("A, ""B"", C", Новый Массив(1, 2),');
    assert.strictEqual(values?.activeSignature, 0);
    assert.strictEqual(values?.activeParameter, 1);
  });

  test('shows current-module parameters with Знач, defaults, and nested comma expressions', async () => {
    const source = [
      'Функция Рассчитать(Знач Первый = 7, Второй = Новый Структура("A,B", 1, Новый Массив(2, 3)))',
      'Возврат Первый;',
      'КонецФункции',
      'Рассчитать(1,',
    ].join('\n');
    const provider = new BslSignatureHelpProvider(new BslLocalCompletionIndex());
    const help = await getHelp(provider, source);

    assert.ok(help);
    assert.strictEqual(help?.signatures[0].label, 'Рассчитать(Знач Первый = 7, Второй = Новый Структура("A,B", 1, Новый Массив(2, 3)))');
    assert.strictEqual(help?.signatures[0].parameters.length, 2);
    assert.strictEqual(help?.signatures[0].parameters[0].label, 'Знач Первый = 7');
    assert.strictEqual(help?.signatures[0].parameters[1].label, 'Второй = Новый Структура("A,B", 1, Новый Массив(2, 3))');
    assert.strictEqual(help?.activeParameter, 1);
  });

  test('uses exported routines from an exactly resolved common module', async () => {
    const localIndex: BslSignatureRoutineSource = {
      getCurrentDocumentRoutines: () => [],
      getCommonModuleRoutines: async (_document, moduleName) => moduleName === 'Вычисления'
        ? [{ name: 'Посчитать', kind: 'function', exported: true, parameterText: 'Знач Число = 1' }]
        : [],
    } as BslSignatureRoutineSource;
    const provider = new BslSignatureHelpProvider(localIndex);
    const help = await getHelp(provider, 'Вычисления.Посчитать(1,');

    assert.ok(help);
    assert.strictEqual(help?.signatures[0].label, 'Посчитать(Знач Число = 1)');
    const privateRoutineSource: BslSignatureRoutineSource = {
      getCurrentDocumentRoutines: () => [],
      getCommonModuleRoutines: async () => [
        { name: 'Посчитать', kind: 'function', exported: false, parameterText: 'Число' },
      ],
    } as BslSignatureRoutineSource;
    assert.strictEqual(
      await getHelp(new BslSignatureHelpProvider(privateRoutineSource), 'Вычисления.Посчитать('),
      undefined,
    );
  });

  test('counts only argument-level commas across nested expressions, strings, comments, and lines', async () => {
    const localIndex: BslSignatureRoutineSource = {
      getCurrentDocumentRoutines: () => [
        { name: 'Вызов', kind: 'procedure', exported: false, parameterText: 'Первый, Второй, Третий, Четвёртый, Пятый' },
      ],
      getCommonModuleRoutines: async () => [],
    } as BslSignatureRoutineSource;
    const provider = new BslSignatureHelpProvider(localIndex);
    const help = await getHelp(provider, 'Вызов("A, ""B"", C", Значение[0, 1], // запятая,\n  3,');

    assert.strictEqual(help?.activeParameter, 3);
    assert.strictEqual(await getHelp(provider, 'Текст = "первая строка\n|Новый Структура("'), undefined);
  });

  test('suppresses help in strings, comments, and unknown calls', async () => {
    const provider = new BslSignatureHelpProvider();
    assert.strictEqual(await getHelp(provider, 'Текст = "Структура('), undefined);
    assert.strictEqual(await getHelp(provider, '// Новый Структура('), undefined);
    assert.strictEqual(await getHelp(provider, 'Новый Структура(НеизвестныйВызов('), undefined);
  });
});
