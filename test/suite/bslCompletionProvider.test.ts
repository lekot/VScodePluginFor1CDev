import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
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
import { BslLocalCompletionIndex } from '../../src/providers/bslLocalCompletionIndex';
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

function localDocument(fsPath: string, source: string, version = 1): vscode.TextDocument {
  const lines = source.split(/\r?\n/);
  return {
    uri: vscode.Uri.file(fsPath),
    version,
    getText: () => source,
    lineCount: lines.length,
    offsetAt: () => source.length,
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
  } as unknown as vscode.TextDocument;
}

async function completeWithLocalDocument(
  provider: BslCompletionProvider,
  document: vscode.TextDocument,
  text: string,
  offset = text.length,
): Promise<vscode.CompletionItem[] | undefined> {
  return provider.provideCompletionItems(
    document,
    positionAt(text, offset),
    { isCancellationRequested: false } as vscode.CancellationToken,
    {} as vscode.CompletionContext,
  );
}

async function createConfigurationRoot(root: string, extension = false): Promise<void> {
  await fs.promises.mkdir(root, { recursive: true });
  const belonging = extension ? '<ObjectBelonging>Adopted</ObjectBelonging>' : '';
  await fs.promises.writeFile(
    path.join(root, 'Configuration.xml'),
    `<MetaDataObject><Configuration><Properties><Name>${path.basename(root)}</Name>${belonging}</Properties></Configuration></MetaDataObject>`,
  );
}

async function writeCommonModule(root: string, moduleName: string, source: string, edt = false): Promise<string> {
  const modulePath = edt
    ? path.join(root, 'src', 'CommonModules', moduleName, 'Module.bsl')
    : path.join(root, 'CommonModules', moduleName, 'Ext', 'Module.bsl');
  await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
  await fs.promises.writeFile(modulePath, source, 'utf8');
  return modulePath;
}

function setWorkspaceRoots(...roots: string[]): void {
  vscodeTestState.mockWorkspaceFolders = roots.map((root, index) => ({
    name: path.basename(root),
    index,
    uri: vscode.Uri.file(root),
  }));
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

  test('suggests current unsaved module routines in global completion context', async () => {
    const text = [
      'Процедура ЛокальнаяФункция() Экспорт',
      'КонецПроцедуры',
      'Локал',
    ].join('\n');
    const document = localDocument(path.join(os.tmpdir(), 'UnsavedCurrentModule.bsl'), text);
    const provider = new BslCompletionProvider(extensionRoot());

    assert.ok(labels(await completeWithLocalDocument(provider, document, text)).includes('ЛокальнаяФункция'));
  });

  test('skips huge current documents before getText while retaining platform completions', async () => {
    let getTextCalls = 0;
    let offsetAtCalls = 0;
    const provider = new BslCompletionProvider(extensionRoot());
    const documents: Array<{ lineCount?: number; offsetAt?: () => number }> = [
      {
        lineCount: 50_001,
        offsetAt: () => { offsetAtCalls += 1; return 20_000_000; },
      },
      {
        lineCount: 1,
        offsetAt: () => { offsetAtCalls += 1; return 20_000_000; },
      },
      {
        offsetAt: () => { offsetAtCalls += 1; return 20_000_000; },
      },
      {
        offsetAt: () => { offsetAtCalls += 1; throw new Error('disposed document'); },
      },
      {},
    ];

    for (const [index, { lineCount, offsetAt }] of documents.entries()) {
      const text = 'Докум';
      const document = {
        uri: vscode.Uri.file(path.join(os.tmpdir(), `HugeCurrentDocument${index}.bsl`)),
        version: 1,
        ...(lineCount === undefined ? {} : { lineCount }),
        ...(offsetAt === undefined ? {} : { offsetAt }),
        lineAt: () => ({ text }),
        getText: () => { getTextCalls += 1; throw new Error('oversized document should be skipped before getText'); },
      } as unknown as vscode.TextDocument;
      const items = await provider.provideCompletionItems(
        document,
        new vscode.Position(0, text.length),
        { isCancellationRequested: false } as vscode.CancellationToken,
        {} as vscode.CompletionContext,
      );
      assert.ok(labels(items).includes('Документы'));
    }

    assert.strictEqual(getTextCalls, 0);
    assert.strictEqual(offsetAtCalls, 3, 'known huge line count skips offsetAt; missing line counts are measured when possible');
  });

  test('suggests only exported methods from an exact local CommonModule file', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-provider-local-module-'));
    try {
      await createConfigurationRoot(root);
      await writeCommonModule(root, 'Library', [
        'Procedure ExternalMethod() Экспорт',
        'EndProcedure',
        'Procedure PrivateMethod()',
        'EndProcedure',
      ].join('\n'));
      setWorkspaceRoots(root);
      const text = [
        'Процедура ВызывающийМодуль()',
        '  Library.Ex',
        'КонецПроцедуры',
      ].join('\n');
      const document = localDocument(path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'), text);
      const provider = new BslCompletionProvider(extensionRoot());
      const items = labels(await completeWithLocalDocument(
        provider,
        document,
        text,
        text.indexOf('Library.Ex') + 'Library.Ex'.length,
      ));

      assert.ok(items.includes('ExternalMethod'));
      assert.ok(!items.includes('PrivateMethod'));
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('does not resolve a same-named CommonModule when the receiver is assigned locally', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-provider-shadowed-module-'));
    try {
      await createConfigurationRoot(root);
      await writeCommonModule(root, 'Library', 'Procedure ExternalMethod() Экспорт\nEndProcedure');
      setWorkspaceRoots(root);
      const text = [
        'Процедура ВызывающийМодуль()',
        '  Library = ПолучитьБиблиотеку();',
        '  Library.Ext',
        'КонецПроцедуры',
      ].join('\n');
      const document = localDocument(path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'), text);
      const provider = new BslCompletionProvider(extensionRoot());

      assert.deepStrictEqual(
        labels(await completeWithLocalDocument(
          provider,
          document,
          text,
          text.indexOf('Library.Ext') + 'Library.Ext'.length,
        )),
        [],
        'a local assignment shadows a CommonModule of the same name',
      );
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('completes metadata collection names from the current loaded tree cache by Russian and English aliases', async () => {
    const calls: Array<{ resourcePath: string; folderId: string }> = [];
    const reader = {
      getLoadedTypeObjectsForResource: (resourcePath: string, folderId: string) => {
        calls.push({ resourcePath, folderId });
        const names = folderId === 'InformationRegisters'
          ? ['Sales', 'SaleLines', 'Purchase']
          : folderId === 'Documents'
            ? ['Invoice', 'InvoiceCorrection']
            : ['Customers', 'Goods'];
        return { status: 'loaded' as const, names };
      },
    };
    const provider = new BslCompletionProvider(extensionRoot(), () => reader);
    const cases = [
      { source: 'РегистрыСведений.Sal', folderId: 'InformationRegisters', expected: ['Sales', 'SaleLines'] },
      { source: 'Documents.Inv', folderId: 'Documents', expected: ['Invoice', 'InvoiceCorrection'] },
      { source: 'Справочники.Goo', folderId: 'Catalogs', expected: ['Goods'] },
    ];

    for (const { source, folderId, expected } of cases) {
      const document = localDocument(path.join(os.tmpdir(), 'MetadataCompletion.bsl'), source);
      const items = labels(await completeWithLocalDocument(provider, document, source));
      assert.deepStrictEqual(items, expected);
      assert.strictEqual(calls[calls.length - 1]?.folderId, folderId);
      assert.strictEqual(calls[calls.length - 1]?.resourcePath, document.uri.fsPath);
    }
  });

  test('metadata collection completion does not force a lazy tree index to load', async () => {
    let calls = 0;
    const provider = new BslCompletionProvider(extensionRoot(), () => ({
      getLoadedTypeObjectsForResource: () => {
        calls += 1;
        return { status: 'notLoaded' };
      },
    }));
    const text = 'Документы.Inv';
    const document = localDocument(path.join(os.tmpdir(), 'ColdMetadataCompletion.bsl'), text);

    assert.deepStrictEqual(labels(await completeWithLocalDocument(provider, document, text)), []);
    assert.strictEqual(calls, 1);
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

suite('BSL local completion index', () => {
  setup(() => resetVscodeTestState());
  teardown(() => resetVscodeTestState());

  test('returns current unsaved routines and throttles document version refreshes', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-local-document-'));
    try {
      let source = [
        'Процедура ЛокальнаяПроцедура() Экспорт',
        'КонецПроцедуры',
        'Function LocalFunction(Value) Export',
        'EndFunction',
      ].join('\n');
      let version = 1;
      let reads = 0;
      let currentTime = 1_000;
      const document = {
        uri: vscode.Uri.file(path.join(root, 'Unsaved.bsl')),
        get version() { return version; },
        get lineCount() { return source.split(/\r?\n/).length; },
        offsetAt: () => source.length,
        getText: () => { reads += 1; return source; },
      } as unknown as vscode.TextDocument;
      const index = new BslLocalCompletionIndex({
        getWorkspaceRoots: () => [root],
        now: () => currentTime,
      });

      assert.deepStrictEqual(index.getCurrentDocumentRoutines(document).map(({ name }) => name), [
        'ЛокальнаяПроцедура', 'LocalFunction',
      ]);
      assert.strictEqual(reads, 1);
      assert.strictEqual(index.getCurrentDocumentRoutines(document).length, 2);
      assert.strictEqual(reads, 1, 'same document version should use the cached parse');

      source = 'Процедура Обновленная()\nКонецПроцедуры';
      version = 2;
      currentTime += 250;
      assert.deepStrictEqual(index.getCurrentDocumentRoutines(document).map(({ name }) => name), [
        'ЛокальнаяПроцедура', 'LocalFunction',
      ]);
      assert.strictEqual(reads, 1, 'a newer version inside the throttle window should reuse the snapshot');

      currentTime += 250;
      assert.deepStrictEqual(index.getCurrentDocumentRoutines(document).map(({ name }) => name), ['Обновленная']);
      assert.strictEqual(reads, 2);

      source = 'x'.repeat(1_048_577);
      version = 3;
      currentTime += 500;
      assert.deepStrictEqual(index.getCurrentDocumentRoutines(document), []);
      assert.strictEqual(reads, 2, 'oversize current documents are skipped before retrieving their full text');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('returns only exported procedures and functions from one exact Designer module file', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-local-designer-'));
    try {
      await createConfigurationRoot(root);
      await writeCommonModule(root, 'Library', [
        'Procedure PublicProcedure(Value) Экспорт',
        'EndProcedure',
        'Procedure PrivateProcedure()',
        'EndProcedure',
        'Function PublicFunction(',
        '  Value',
        ') Export',
        'EndFunction',
      ].join('\n'));
      setWorkspaceRoots(root);
      const document = localDocument(
        path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'),
        'Procedure Caller()\nEndProcedure',
      );
      const index = new BslLocalCompletionIndex();
      const routines = await index.getCommonModuleRoutines(document, 'Library');

      assert.deepStrictEqual(routines.map(({ name }) => name), ['PublicProcedure', 'PublicFunction']);
      assert.ok(routines.every(({ exported }) => exported));
      assert.strictEqual((await index.getCommonModuleRoutines(document, '../Library')).length, 0);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('reads a Designer CommonModule from nested Ext/Module/Module.bsl layout', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-local-nested-designer-'));
    try {
      await createConfigurationRoot(root);
      const nestedModulePath = path.join(root, 'CommonModules', 'NestedLibrary', 'Ext', 'Module', 'Module.bsl');
      await fs.promises.mkdir(path.dirname(nestedModulePath), { recursive: true });
      await fs.promises.writeFile(nestedModulePath, 'Function NestedMethod() Экспорт\nEndFunction', 'utf8');
      setWorkspaceRoots(root);
      const document = localDocument(
        path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'),
        'Procedure Caller()\nEndProcedure',
      );
      const index = new BslLocalCompletionIndex();

      assert.deepStrictEqual(
        (await index.getCommonModuleRoutines(document, 'NestedLibrary')).map(({ name }) => name),
        ['NestedMethod'],
      );
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('prefers an extension module with the same name as a base configuration module', async () => {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-local-extension-'));
    const mainRoot = path.join(workspace, 'main');
    const extensionRoot = path.join(workspace, 'extension');
    try {
      await createConfigurationRoot(mainRoot);
      await createConfigurationRoot(extensionRoot, true);
      await writeCommonModule(mainRoot, 'Shared', 'Procedure BaseMethod() Экспорт\nEndProcedure');
      await writeCommonModule(extensionRoot, 'Shared', 'Procedure ExtensionMethod() Экспорт\nEndProcedure');
      setWorkspaceRoots(mainRoot, extensionRoot);
      const document = localDocument(
        path.join(mainRoot, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'),
        'Procedure Caller()\nEndProcedure',
      );
      const index = new BslLocalCompletionIndex();

      assert.deepStrictEqual(
        (await index.getCommonModuleRoutines(document, 'Shared')).map(({ name }) => name),
        ['ExtensionMethod'],
      );
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });

  test('reads an EDT module from src/CommonModules/<Name>/Module.bsl', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-local-edt-'));
    try {
      await createConfigurationRoot(root);
      await writeCommonModule(root, 'EdtLibrary', 'Function ЕДТМетод() Экспорт\nEndFunction', true);
      setWorkspaceRoots(root);
      const document = localDocument(
        path.join(root, 'src', 'CommonModules', 'Caller', 'Module.bsl'),
        'Procedure Caller()\nEndProcedure',
      );
      const index = new BslLocalCompletionIndex();

      assert.deepStrictEqual(
        (await index.getCommonModuleRoutines(document, 'EdtLibrary')).map(({ name }) => name),
        ['ЕДТМетод'],
      );
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('bounds exact candidate checks to eight paths and skips missing or oversized files', async () => {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-local-bounds-'));
    const roots = Array.from({ length: 4 }, (_, index) => path.join(workspace, `root-${index}`));
    try {
      for (const root of roots) {
        await createConfigurationRoot(root);
      }
      const checkedPaths: string[] = [];
      const readPaths: string[] = [];
      const index = new BslLocalCompletionIndex({
        getWorkspaceRoots: () => roots,
        statFile: async (filePath) => {
          checkedPaths.push(filePath);
          try {
            const stat = await fs.promises.stat(filePath);
            return { isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs };
          } catch {
            return undefined;
          }
        },
        readFile: async (filePath) => {
          readPaths.push(filePath);
          return fs.promises.readFile(filePath, 'utf8');
        },
      });
      const document = localDocument(
        path.join(roots[0], 'CommonModules', 'Caller', 'Ext', 'Module.bsl'),
        'Procedure Caller()\nEndProcedure',
      );

      assert.deepStrictEqual(await index.getCommonModuleRoutines(document, 'Missing'), []);
      assert.strictEqual(checkedPaths.length, 8, 'exact checks are capped across three layouts and four bounded roots');
      assert.strictEqual(readPaths.length, 0);
      assert.ok(checkedPaths.every((filePath) => filePath.includes(`${path.sep}CommonModules${path.sep}Missing${path.sep}`)));

      const largePath = await writeCommonModule(roots[0], 'Large', 'Procedure Big() Экспорт\nКонецПроцедуры');
      await fs.promises.writeFile(largePath, 'x'.repeat(1_048_577), 'utf8');
      checkedPaths.length = 0;
      readPaths.length = 0;
      assert.deepStrictEqual(await index.getCommonModuleRoutines(document, 'Large'), []);
      assert.strictEqual(readPaths.length, 0, 'stat rejects oversized module files before reading');
      assert.ok(checkedPaths.length <= 8);
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });

  test('cancellation prevents local module file checks', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-local-cancel-'));
    try {
      let statCalls = 0;
      const index = new BslLocalCompletionIndex({
        getWorkspaceRoots: () => [root],
        statFile: async () => { statCalls += 1; return undefined; },
      });
      const document = localDocument(
        path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'),
        'Procedure Caller()\nEndProcedure',
      );

      assert.deepStrictEqual(
        await index.getCommonModuleRoutines(document, 'Library', { isCancellationRequested: true } as vscode.CancellationToken),
        [],
      );
      assert.strictEqual(statCalls, 0);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('revalidates the cached module source by mtime and size', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-local-cache-'));
    try {
      await createConfigurationRoot(root);
      const modulePath = await writeCommonModule(root, 'Library', 'Procedure First() Экспорт\nEndProcedure');
      setWorkspaceRoots(root);
      const document = localDocument(
        path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'),
        'Procedure Caller()\nEndProcedure',
      );
      let reads = 0;
      const index = new BslLocalCompletionIndex({
        readFile: async (filePath) => {
          reads += 1;
          return fs.promises.readFile(filePath, 'utf8');
        },
      });

      assert.deepStrictEqual(
        (await index.getCommonModuleRoutines(document, 'Library')).map(({ name }) => name),
        ['First'],
      );
      assert.deepStrictEqual(
        (await index.getCommonModuleRoutines(document, 'Library')).map(({ name }) => name),
        ['First'],
      );
      assert.strictEqual(reads, 1);

      await fs.promises.writeFile(modulePath, 'Procedure UpdatedRoutine() Экспорт\nКонецПроцедуры', 'utf8');
      assert.deepStrictEqual(
        (await index.getCommonModuleRoutines(document, 'Library')).map(({ name }) => name),
        ['UpdatedRoutine'],
      );
      assert.strictEqual(reads, 2);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
