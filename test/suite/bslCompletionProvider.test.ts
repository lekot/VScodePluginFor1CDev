import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import * as vscode from 'vscode';
import initSqlJs, { type Database as SqlDatabase } from 'sql.js';
import {
  BslCompletionProvider,
  loadBslCompletionIndex,
  registerBslCompletionProvider,
} from '../../src/providers/bslCompletionProvider';
import {
  buildBslCompletionIndex,
  isBslCompletionIndex,
  parseCompletionSections,
  type SyntaxHelpDatabaseNodeForIndex,
} from '../../src/providers/bslCompletionIndex';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

const TEST_HASH = '0'.repeat(64);

function extensionRoot(): string {
  return path.resolve(__dirname, '../../..');
}

function makeDocument(text: string): vscode.TextDocument {
  const lines = text.split(/\r?\n/);
  return {
    getText: () => { throw new Error('Completion provider must not read the whole document.'); },
    lineAt: (line: number) => ({ text: lines[line] }),
  } as unknown as vscode.TextDocument;
}

function positionAt(text: string, offset: number): vscode.Position {
  const prefix = text.slice(0, offset);
  const lines = prefix.split('\n');
  return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}

async function complete(
  provider: BslCompletionProvider,
  text: string,
  offset = text.length,
  canceled = false,
): Promise<vscode.CompletionItem[] | undefined> {
  return provider.provideCompletionItems(
    makeDocument(text),
    positionAt(text, offset),
    { isCancellationRequested: canceled } as vscode.CancellationToken,
    {} as vscode.CompletionContext,
  );
}

function labels(items: vscode.CompletionItem[] | undefined): string[] {
  return (items ?? []).map((item) => item.label as string);
}

function trackedDocument(lines: string[]): {
  document: vscode.TextDocument;
  getLineReads(): number;
} {
  let lineReads = 0;
  const document = {
    getText: () => { throw new Error('Completion provider must not read the whole document.'); },
    lineAt: (line: number) => {
      lineReads += 1;
      return { text: lines[line] };
    },
  } as unknown as vscode.TextDocument;
  return { document, getLineReads: () => lineReads };
}

async function readBundledSyntaxNodes(): Promise<{ database: SqlDatabase; nodes: SyntaxHelpDatabaseNodeForIndex[] }> {
  const bytes = await fs.promises.readFile(path.join(extensionRoot(), 'resources', 'help', 'shcntx_help.db'));
  const SQL = await initSqlJs({
    locateFile: () => path.join(extensionRoot(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  });
  const database = new SQL.Database(bytes);
  const table = database.exec('SELECT id, name, path, content FROM nodes ORDER BY id')[0];
  assert.ok(table);
  assert.strictEqual(table.columns.join(','), 'id,name,path,content');
  const nodes = table.values.map(([id, name, itemPath, content]) => ({
    id: id as number,
    name: name as string,
    path: (itemPath as string).replace(/\\/g, '/'),
    content: content as string,
  }));
  return { database, nodes };
}

suite('BSL platform completion', () => {
  setup(() => resetVscodeTestState());
  teardown(() => resetVscodeTestState());

  test('parses Russian and English section labels, CRLF, blank lines, aliases, and next headings', () => {
    const parsed = parseCompletionSections([
      'Свойства:\r\n',
      '\r\n',
      '<Имя>\r\n',
      'Имя (Name)\r\n',
      'Имя\r\n',
      'Methods:\r\n',
      'Выполнить (Execute)\r\n',
      'Описание:\r\n',
      'НеПодсказка\r\n',
      'Constructors:\r\n',
      'По умолчанию\r\n',
    ].join(''));

    assert.deepStrictEqual(parsed.properties, ['Имя', 'Name']);
    assert.deepStrictEqual(parsed.methods, ['Выполнить', 'Execute']);
    assert.strictEqual(parsed.hasConstructors, true);
  });

  test('indexes globals from id 1 and only constructor-bearing syntax articles as types', () => {
    const nodes: SyntaxHelpDatabaseNodeForIndex[] = [
      {
        id: 1,
        name: 'Глобальный контекст',
        path: 'Global context.html',
        content: 'Свойства:\nДокументы (Documents)\n\nМетоды:\nСообщить (Message)\nОписание:\nНеГлобальное',
      },
      {
        id: 2,
        name: 'ТаблицаЗначений (ValueTable)',
        path: 'ValueTable.html',
        content: 'Свойства:\nКолонки (Columns)\nМетоды:\nДобавить (Add)\nКонструкторы:\nПо умолчанию',
      },
      {
        id: 3,
        name: 'НеСоздаваемыйТип (NoConstructorType)',
        path: 'NoConstructorType.html',
        content: 'Методы:\nСделать (Make)\nОписание:\nКонструкторы: упомянуты в описании',
      },
    ];
    const index = buildBslCompletionIndex(nodes, TEST_HASH);
    const globalNames = [...index.global.properties, ...index.global.methods];
    const typeNames = index.types.flatMap(({ aliases }) => aliases);

    assert.ok(globalNames.includes('Documents'));
    assert.ok(globalNames.includes('Документы'));
    assert.ok(globalNames.includes('Message'));
    assert.ok(globalNames.includes('Сообщить'));
    assert.ok(typeNames.includes('ValueTable'));
    assert.ok(typeNames.includes('ТаблицаЗначений'));
    assert.strictEqual(typeNames.length, 2);
    assert.strictEqual(index.types.some(({ aliases }) => aliases.includes('NoConstructorType')), false);
  });

  test('tracked compact JSON exactly matches the bundled syntax database and its checksum', async () => {
    const indexPath = path.join(extensionRoot(), 'resources', 'help', 'bsl-completion-index.json');
    const databaseBytes = await fs.promises.readFile(path.join(extensionRoot(), 'resources', 'help', 'shcntx_help.db'));
    const expectedHash = crypto.createHash('sha256').update(databaseBytes).digest('hex');
    const bundledIndex = JSON.parse(await fs.promises.readFile(indexPath, 'utf8')) as unknown;
    assert.ok(isBslCompletionIndex(bundledIndex));
    assert.strictEqual(bundledIndex.sourceSha256, expectedHash);

    const { database, nodes } = await readBundledSyntaxNodes();
    try {
      const rebuilt = buildBslCompletionIndex(nodes, expectedHash);
      assert.strictEqual(
        `${JSON.stringify(rebuilt, null, 2)}\n`,
        await fs.promises.readFile(indexPath, 'utf8'),
        'Regenerate the static BSL completion index when the database or parser changes.',
      );
    } finally {
      database.close();
    }
  });

  test('memoizes the compact index by extension path', async () => {
    const first = await loadBslCompletionIndex(extensionRoot());
    const second = await loadBslCompletionIndex(extensionRoot());
    assert.strictEqual(first, second);
  });

  test('suggests global entries and constructor types from the bundled index', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const globals = labels(await complete(provider, 'Докум'));
    assert.ok(globals.includes('Документы'));
    assert.ok(labels(await complete(provider, 'Docum')).includes('Documents'));

    const types = labels(await complete(provider, 'Новый Табли'));
    assert.ok(types.includes('ТаблицаЗначений'));

    const englishTypes = labels(await complete(provider, 'New Val'));
    assert.ok(englishTypes.includes('ValueTable'));
  });

  test('suggests members for a locally assigned Новый receiver and preserves call syntax', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const text = [
      'Процедура ВыполнитьЗапрос()',
      '  Запрос = Новый Запрос("");',
      '  Запрос.Вып',
      'КонецПроцедуры',
    ].join('\n');
    const items = await complete(provider, text, text.indexOf('  Запрос.Вып') + '  Запрос.Вып'.length);
    const matches = labels(items);

    assert.ok(matches.includes('Выполнить'));
    assert.ok(matches.includes('ВыполнитьПакет'));
    assert.ok(items?.every((item) => !String(item.insertText).endsWith('()')));
    const method = items?.find((item) => item.label === 'Выполнить');
    assert.ok(method?.documentation?.toString().includes('syntax:2459'));
    assert.strictEqual(method?.detail, 'Метод платформы • Запрос (Query)');
  });

  test('supports direct Новый receiver member completion', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const items = labels(await complete(provider, 'Новый Запрос("Текст").Вып'));
    assert.ok(items.includes('Выполнить'));
  });

  test('does not infer members from missing, reassigned, or expression receivers', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const unsupported = [
      'Процедура Тест()\n  Запрос.Вып',
      'Процедура Тест()\n  Запрос = Новый Запрос();\n  Запрос = ПолучитьЗапрос();\n  Запрос.Вып',
      'Процедура Тест()\n  Запрос = Новый Запрос();\n  ПолучитьЗапрос().Вып',
      'Процедура Тест()\n  Запрос = Новый Запрос();\nКонецПроцедуры\n  Запрос.Вып',
    ];

    for (const text of unsupported) {
      assert.deepStrictEqual(labels(await complete(provider, text)), [], text);
    }
  });

  test('bounds procedure analysis and never reads the full large document', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const lines = Array.from({ length: 8_000 }, (_, index) => `// padding ${index}`);
    lines.push('Процедура Тест()', '  Запрос = Новый Запрос();', '  Запрос.Вып');
    const document = trackedDocument(lines);
    const items = await provider.provideCompletionItems(
      document.document,
      new vscode.Position(lines.length - 1, lines[lines.length - 1].length),
      { isCancellationRequested: false } as vscode.CancellationToken,
      {} as vscode.CompletionContext,
    );
    assert.ok(labels(items).includes('Выполнить'));
    assert.ok(document.getLineReads() <= 4);
  });

  test('stops local inference when the procedure declaration falls outside the bounded window', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const lines = ['Процедура Тест()', '  Запрос = Новый Запрос();'];
    lines.push(...Array.from({ length: 205 }, () => '  Переменная = 1;'));
    lines.push('  Запрос.Вып');
    const document = trackedDocument(lines);
    const items = await provider.provideCompletionItems(
      document.document,
      new vscode.Position(lines.length - 1, lines[lines.length - 1].length),
      { isCancellationRequested: false } as vscode.CancellationToken,
      {} as vscode.CompletionContext,
    );
    assert.deepStrictEqual(labels(items), []);
    assert.ok(document.getLineReads() <= 200);
  });

  test('suppresses completions in comments and strings and returns early for cancellation', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const comment = '// Документы';
    assert.strictEqual(await complete(provider, comment), undefined);
    const string = 'Текст = "Документы"';
    assert.strictEqual(await complete(provider, string, string.indexOf('Документы') + 3), undefined);
    assert.strictEqual(await complete(provider, 'Документы', undefined, true), undefined);
  });

  test('suppresses completions on BSL multiline string continuation lines', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const multilineString = 'Текст = "первая строка\n  |Документы продолжаются";';
    const cursorInsideText = multilineString.indexOf('Документы') + 4;
    assert.strictEqual(await complete(provider, multilineString, cursorInsideText), undefined);
  });

  test('registers and disposes the dot-triggered BSL provider without activating the extension for standalone BSL files', () => {
    const context = { subscriptions: [] as vscode.Disposable[] };
    const disposable = registerBslCompletionProvider(context as never, extensionRoot());
    const registration = vscodeTestState.registeredCompletionProviders[0];

    assert.strictEqual(vscodeTestState.registeredCompletionProviders.length, 1);
    assert.deepStrictEqual(registration.selector, { language: 'bsl' });
    assert.deepStrictEqual(registration.triggerCharacters, ['.']);
    assert.strictEqual(context.subscriptions[0], disposable);

    disposable.dispose();
    assert.strictEqual(registration.disposed, true);

    const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot(), 'package.json'), 'utf8')) as {
      activationEvents: string[];
    };
    assert.ok(!manifest.activationEvents.includes('onLanguage:bsl'));
    assert.ok(manifest.activationEvents.some((event) => event.startsWith('workspaceContains:')));
  });
});
