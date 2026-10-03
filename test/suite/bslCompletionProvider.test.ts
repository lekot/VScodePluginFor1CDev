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
  type BslCompletionMetadataCollection,
  type SyntaxHelpDatabaseNodeForIndex,
} from '../../src/providers/bslCompletionIndex';
import { BslLocalCompletionIndex } from '../../src/providers/bslLocalCompletionIndex';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

const TEST_HASH = '0'.repeat(64);

const EXPECTED_METADATA_COLLECTION_FOLDERS = [
  'AccumulationRegisters',
  'AccountingRegisters',
  'BusinessProcesses',
  'CalculationRegisters',
  'Catalogs',
  'ChartsOfAccounts',
  'ChartsOfCalculationTypes',
  'ChartsOfCharacteristicTypes',
  'Constants',
  'DataProcessors',
  'DocumentJournals',
  'Documents',
  'Enums',
  'ExchangePlans',
  'ExternalDataSources',
  'FilterCriteria',
  'IntegrationServices',
  'InformationRegisters',
  'Reports',
  'ScheduledJobs',
  'Sequences',
  'SessionParameters',
  'SettingsStorages',
  'Tasks',
  'WSReferences',
];

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

function insertedText(item: vscode.CompletionItem | undefined): string | undefined {
  const insertText = item?.insertText;
  if (typeof insertText === 'string') {
    return insertText;
  }
  return insertText && typeof insertText === 'object' && 'value' in insertText
    ? String((insertText as { value: unknown }).value)
    : undefined;
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

async function writeCatalogModule(
  root: string,
  catalogName: string,
  moduleName: 'ManagerModule' | 'ObjectModule',
  source: string,
  edt = false,
): Promise<string> {
  const modulePath = edt
    ? path.join(root, 'src', 'Catalogs', catalogName, `${moduleName}.bsl`)
    : path.join(root, 'Catalogs', catalogName, 'Ext', `${moduleName}.bsl`);
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

async function readBundledMetadataCollections(): Promise<readonly BslCompletionMetadataCollection[]> {
  const { database, nodes } = await readBundledSyntaxNodes();
  try {
    const index = buildBslCompletionIndex(nodes, TEST_HASH);
    return index.metadataCollections;
  } finally {
    database.close();
  }
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

  test('indexes global zero-argument methods and Catalog manager/object article members', () => {
    const nodes: SyntaxHelpDatabaseNodeForIndex[] = [
      {
        id: 1,
        name: 'Глобальный контекст',
        path: 'Global context.html',
        content: 'Свойства:\nРабочаяДата (WorkingDate)\nМетоды:\nТекущаяДата (CurrentDate)\nСообщить (Message)',
      },
      {
        id: 1647,
        name: 'СправочникМенеджер.&lt;Имя справочника&gt; (CatalogManager.&lt;Catalog name&gt;)',
        path: 'catalog125/catalog126/object128.html',
        content: 'Свойства:\nПредопределенныйЭлемент (PredefinedItem)\nМетоды:\nСоздатьЭлемент (CreateItem)\nСоздатьГруппу (CreateFolder)',
      },
      {
        id: 1648,
        name: 'СправочникОбъект.&lt;Имя справочника&gt; (CatalogObject.&lt;Catalog name&gt;)',
        path: 'catalog125/catalog126/object130.html',
        content: 'Свойства:\nКод (Code)\nМетоды:\nЗаписать (Write)\nУдалить (Delete)',
      },
    ];
    const index = buildBslCompletionIndex(nodes, TEST_HASH) as typeof buildBslCompletionIndex extends (...args: never[]) => infer T
      ? T & {
        global: { zeroArgumentMethods?: readonly string[] };
        catalogApi?: {
          folderId: string;
          manager: { article: { id: number; path: string }; methods: readonly string[] };
          object: { article: { id: number; path: string }; methods: readonly string[] };
        };
      }
      : never;

    assert.deepStrictEqual(index.global.zeroArgumentMethods, ['CurrentDate', 'ТекущаяДата']);
    assert.strictEqual(index.catalogApi?.folderId, 'Catalogs');
    assert.strictEqual(index.catalogApi?.manager.article.id, 1647);
    assert.strictEqual(index.catalogApi?.manager.article.path, 'catalog125/catalog126/object128.html');
    assert.deepStrictEqual(index.catalogApi?.manager.methods, ['CreateFolder', 'CreateItem', 'СоздатьГруппу', 'СоздатьЭлемент']);
    assert.strictEqual(index.catalogApi?.object.article.id, 1648);
    assert.strictEqual(index.catalogApi?.object.article.path, 'catalog125/catalog126/object130.html');
    assert.deepStrictEqual(index.catalogApi?.object.methods, ['Delete', 'Write', 'Записать', 'Удалить']);
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

  test('derives every supported metadata collection from global context properties', async () => {
    const metadataCollections = await readBundledMetadataCollections();
    const byFolder = new Map(metadataCollections.map(({ folderId, aliases }) => [folderId, aliases]));

    assert.deepStrictEqual(
      [...byFolder.keys()].sort(),
      [...EXPECTED_METADATA_COLLECTION_FOLDERS].sort(),
    );
    assert.deepStrictEqual(byFolder.get('AccumulationRegisters'), ['РегистрыНакопления', 'AccumulationRegisters']);
    assert.deepStrictEqual(byFolder.get('CalculationRegisters'), ['РегистрыРасчета', 'CalculationRegisters']);
    assert.deepStrictEqual(byFolder.get('Enums'), ['Перечисления', 'Enums']);
    assert.deepStrictEqual(byFolder.get('IntegrationServices'), ['СервисыИнтеграции', 'IntegrationServices']);
    assert.deepStrictEqual(byFolder.get('WSReferences'), ['WSСсылки', 'WSReferences']);

    const aliases = new Set(metadataCollections.flatMap(({ aliases: names }) => names));
    assert.strictEqual(aliases.has('ExternalDataProcessors'), false);
    assert.strictEqual(aliases.has('ExternalReports'), false);
    assert.strictEqual(aliases.has('CommonModules'), false);
  });

  test('rejects malformed or ambiguous metadata collection aliases', async () => {
    const indexPath = path.join(extensionRoot(), 'resources', 'help', 'bsl-completion-index.json');
    const base = JSON.parse(await fs.promises.readFile(indexPath, 'utf8')) as Record<string, unknown>;
    const invalidCollections: BslCompletionMetadataCollection[][] = [
      [],
      [{ aliases: [], folderId: 'Documents' }],
      [{ aliases: ['Catalogs', 'catalogs'], folderId: 'Catalogs' }],
      [{ aliases: ['Catalogs'], folderId: 'UnknownFolder' }],
      [
        { aliases: ['Documents', 'SharedAlias'], folderId: 'Documents' },
        { aliases: ['Catalogs', 'sharedalias'], folderId: 'Catalogs' },
      ],
    ];

    for (const metadataCollections of invalidCollections) {
      assert.strictEqual(
        isBslCompletionIndex({ ...base, metadataCollections }),
        false,
        JSON.stringify(metadataCollections),
      );
    }
  });

  test('rejects invalid zero-argument lists and mismatched Catalog syntax article references', async () => {
    const indexPath = path.join(extensionRoot(), 'resources', 'help', 'bsl-completion-index.json');
    const base = JSON.parse(await fs.promises.readFile(indexPath, 'utf8')) as Record<string, unknown>;
    const global = base.global as Record<string, unknown>;
    const catalogApi = base.catalogApi as Record<string, unknown>;
    const manager = catalogApi.manager as Record<string, unknown>;

    assert.strictEqual(
      isBslCompletionIndex({ ...base, global: { ...global, zeroArgumentMethods: ['UnknownZeroMethod'] } }),
      false,
    );
    assert.strictEqual(
      isBslCompletionIndex({
        ...base,
        catalogApi: { ...catalogApi, manager: { ...manager, article: { ...(manager.article as object), id: 99 } } },
      }),
      false,
    );
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

  test('suggests BSL keywords by Russian and English prefixes with keyword priority', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const russianLoopEnd = await complete(provider, 'КонецЦ');
    const loopEnd = russianLoopEnd?.find(({ label }) => label === 'КонецЦикла');
    assert.ok(loopEnd, 'КонецЦ should suggest КонецЦикла');
    assert.strictEqual(loopEnd?.kind, vscode.CompletionItemKind.Keyword);
    assert.strictEqual(loopEnd?.insertText, 'КонецЦикла');
    assert.ok(loopEnd?.sortText?.startsWith('0_'), 'keyword items sort ahead of platform globals');

    const englishLoopEnd = await complete(provider, 'endd');
    assert.ok(labels(englishLoopEnd).includes('EndDo'), 'English keywords match case-insensitively');

    const exceptionItems = await complete(provider, 'Исключ');
    assert.strictEqual(labels(exceptionItems)[0], 'Исключение');
    assert.strictEqual(
      exceptionItems?.find(({ label }) => label === 'Исключение')?.kind,
      vscode.CompletionItemKind.Keyword,
    );
    assert.ok(
      exceptionItems?.find(({ label }) => label === 'Исключение')?.sortText?.startsWith('0_'),
      'the exact exception keyword should sort ahead of similarly named platform globals',
    );

    for (const [prefix, expected] of [
      ['КонецЕсли', 'КонецЕсли'],
      ['КонецПоп', 'КонецПопытки'],
      ['КонецПроц', 'КонецПроцедуры'],
      ['EndIf', 'EndIf'],
      ['EndTry', 'EndTry'],
      ['EndProcedure', 'EndProcedure'],
      ['EndFunction', 'EndFunction'],
    ]) {
      assert.ok(labels(await complete(provider, prefix)).includes(expected), `${prefix} should suggest ${expected}`);
    }
    assert.ok(labels(await complete(provider, 'КонецП')).includes('КонецПроцедуры'));

    for (const keyword of [
      'Если', 'Иначе', 'ИначеЕсли', 'Попытка', 'Исключение', 'Для', 'Каждого', 'While', 'Break', 'Return', 'Var',
      'Новый', 'New', 'И', 'And', 'Или', 'Or', 'Не', 'Not', 'Истина', 'True', 'Ложь', 'False', 'Неопределено', 'Undefined', 'Null',
    ]) {
      assert.ok(labels(await complete(provider, keyword)).includes(keyword), `${keyword} should be suggested`);
    }
  });

  test('suppresses keyword completions in comments, strings, and after a member dot', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const comment = '// КонецЦ';
    const string = 'Текст = "КонецЦ"';
    assert.strictEqual(await complete(provider, comment), undefined);
    assert.strictEqual(await complete(provider, string, string.indexOf('КонецЦ') + 'КонецЦ'.length), undefined);

    const member = 'Новый Запрос("").КонецЦ';
    const memberItems = await complete(provider, member);
    assert.ok(!labels(memberItems).includes('КонецЦикла'));
  });

  test('does not suggest loop terminators that are absent from the BSL grammar', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const russian = labels(await complete(provider, 'КонецПо'));
    const english = labels(await complete(provider, 'EndWh'));
    assert.ok(!russian.includes('КонецПока'));
    assert.ok(!english.includes('EndWhile'));
  });

  test('suggests static BSL keywords when the bundled help index is unavailable', async () => {
    const missingIndexRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-provider-empty-extension-'));
    try {
      const provider = new BslCompletionProvider(missingIndexRoot);
      assert.ok(labels(await complete(provider, 'КонецЦ')).includes('КонецЦикла'));
    } finally {
      await fs.promises.rm(missingIndexRoot, { recursive: true, force: true });
    }
  });

  test('deduplicates a keyword against platform and local routine completions', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const providerWithIndexes = provider as unknown as {
      loadedIndex: Promise<unknown> | undefined;
      localIndex: { getCurrentDocumentRoutines(document: vscode.TextDocument): readonly {
        name: string;
        kind: 'procedure';
        exported: boolean;
        parameterText: string;
      }[] };
    };
    const platformDuplicate = {
      name: 'Исключение',
      kind: 'global',
      article: { id: 1, name: 'Global context', path: 'Global context.html' },
    };
    providerWithIndexes.loadedIndex = Promise.resolve({
      globalCandidates: [platformDuplicate],
      globalCandidatesByFirstCharacter: new Map([['и', [platformDuplicate]]]),
    });
    providerWithIndexes.localIndex = {
      getCurrentDocumentRoutines: () => [{ name: 'Исключение', kind: 'procedure', exported: false, parameterText: '' }],
    };

    const items = await complete(provider, 'Исключ');
    assert.strictEqual(labels(items).filter((name) => name === 'Исключение').length, 1);
    assert.strictEqual(items?.find(({ label }) => label === 'Исключение')?.kind, vscode.CompletionItemKind.Keyword);
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
    assert.strictEqual(insertedText(items?.find((item) => item.label === 'Выполнить')), 'Выполнить($0)');
    assert.strictEqual(insertedText(items?.find((item) => item.label === 'ВыполнитьПакет')), 'ВыполнитьПакет($0)');
    const method = items?.find((item) => item.label === 'Выполнить');
    assert.ok(method?.documentation?.toString().includes('syntax:2459'));
    assert.strictEqual(method?.detail, 'Метод платформы • Запрос (Query)');
  });

  test('inserts callable platform and local completions with parentheses and avoids an existing opening parenthesis', async () => {
    const provider = new BslCompletionProvider(extensionRoot());
    const globalItems = await complete(provider, 'ТекущаяД');
    assert.strictEqual(insertedText(globalItems?.find((item) => item.label === 'ТекущаяДата')), 'ТекущаяДата()$0');
    assert.strictEqual(globalItems?.find((item) => item.label === 'ТекущаяДата')?.kind, vscode.CompletionItemKind.Method);
    assert.strictEqual(labels(await complete(provider, 'РабочаяД')).includes('РабочаяДата'), true);
    const englishItems = await complete(provider, 'CurrentD');
    assert.strictEqual(insertedText(englishItems?.find((item) => item.label === 'CurrentDate')), 'CurrentDate()$0');
    const messageItems = await complete(provider, 'Сообщ');
    assert.strictEqual(insertedText(messageItems?.find((item) => item.label === 'Сообщить')), 'Сообщить($0)');

    const existingParenText = 'ТекущаяДата(';
    const existingParenItems = await complete(provider, existingParenText, 'ТекущаяДата'.length);
    assert.strictEqual(insertedText(existingParenItems?.find((item) => item.label === 'ТекущаяДата')), 'ТекущаяДата');

    const localText = [
      'Процедура LocalZero() Экспорт',
      'КонецПроцедуры',
      'Функция LocalWithArgument(Value) Экспорт',
      'КонецФункции',
      '  Local',
    ].join('\n');
    const document = localDocument(path.join(os.tmpdir(), 'LocalCalls.bsl'), localText);
    const localItems = await completeWithLocalDocument(provider, document, localText);
    assert.strictEqual(insertedText(localItems?.find((item) => item.label === 'LocalZero')), 'LocalZero()$0');
    assert.strictEqual(insertedText(localItems?.find((item) => item.label === 'LocalWithArgument')), 'LocalWithArgument($0)');

    const localExistingParen = localText.replace('  Local', '  LocalZero(');
    const localExistingDocument = localDocument(path.join(os.tmpdir(), 'LocalCallsExistingParen.bsl'), localExistingParen);
    const localExistingItems = await completeWithLocalDocument(
      provider,
      localExistingDocument,
      localExistingParen,
      localExistingParen.indexOf('LocalZero(') + 'LocalZero'.length,
    );
    assert.strictEqual(insertedText(localExistingItems?.find((item) => item.label === 'LocalZero')), 'LocalZero');
  });

  test('completes Catalog manager and object platform methods plus exported routines from exact modules', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-catalog-members-'));
    const catalogName = 'Справочник55';
    try {
      await createConfigurationRoot(root);
      await writeCatalogModule(root, catalogName, 'ManagerModule', [
        'Процедура ОткрытьФормуМенеджера(FormName) Экспорт',
        'КонецПроцедуры',
        'Процедура ПриватнаяФункцияМенеджера()',
        'КонецПроцедуры',
      ].join('\n'));
      await writeCatalogModule(root, catalogName, 'ObjectModule', [
        'Функция ЭкспортнаяФункцияОбъекта(Value) Экспорт',
        'КонецФункции',
        'Процедура ПриватнаяФункцияОбъекта()',
        'КонецПроцедуры',
      ].join('\n'));
      setWorkspaceRoots(root);
      const reader = () => ({
        getLoadedTypeObjectsForResource: (_resourcePath: string, folderId: string) => folderId === 'Catalogs'
          ? { status: 'loaded' as const, names: [catalogName] }
          : { status: 'notLoaded' as const },
      });
      const provider = new BslCompletionProvider(extensionRoot(), reader);

      const managerText = [
        'Процедура ВызватьМенеджер()',
        `  Справочники.${catalogName}.`,
        'КонецПроцедуры',
      ].join('\n');
      const managerDocument = localDocument(path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'), managerText);
      const managerItems = await completeWithLocalDocument(provider, managerDocument, managerText, managerText.indexOf(`Справочники.${catalogName}.`) + `Справочники.${catalogName}.`.length);
      const managerNames = labels(managerItems);
      assert.ok(managerNames.includes('СоздатьЭлемент'));
      assert.ok(managerNames.includes('СоздатьГруппу'));
      assert.ok(managerNames.includes('ОткрытьФормуМенеджера'));
      assert.ok(!managerNames.includes('ПриватнаяФункцияМенеджера'));

      const assignedManagerText = [
        'Процедура ВызватьМенеджер()',
        `  Объект = Справочники.${catalogName}.Создать`,
        'КонецПроцедуры',
      ].join('\n');
      const assignedManagerDocument = localDocument(path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'), assignedManagerText);
      const assignedManagerItems = await completeWithLocalDocument(
        provider,
        assignedManagerDocument,
        assignedManagerText,
        assignedManagerText.indexOf(`Справочники.${catalogName}.Создать`) + `Справочники.${catalogName}.Создать`.length,
      );
      assert.ok(labels(assignedManagerItems).includes('СоздатьЭлемент'), 'completion follows the Catalog manager tail after an assignment equals sign');

      const longChainText = `Объект = Вызов.Справочники.${catalogName}.Создать`;
      const longChainItems = await completeWithLocalDocument(
        provider,
        localDocument(path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'), longChainText),
        longChainText,
      );
      assert.ok(!labels(longChainItems).includes('СоздатьЭлемент'), 'a Catalog-like pair nested in a longer receiver chain is not assumed to be a global collection');

      const invalidManagerText = `Справочники.ДругойСправочник.`;
      const invalidManagerItems = await completeWithLocalDocument(
        provider,
        localDocument(path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'), invalidManagerText),
        invalidManagerText,
      );
      assert.deepStrictEqual(labels(invalidManagerItems), [], 'a loaded Catalogs tree rejects names absent from its index');

      const objectText = [
        'Процедура ВызватьОбъект()',
        `  Obj = Справочники.${catalogName}.СоздатьЭлемент();`,
        '  Obj.',
        'КонецПроцедуры',
      ].join('\n');
      const objectDocument = localDocument(path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'), objectText);
      const objectItems = await completeWithLocalDocument(provider, objectDocument, objectText, objectText.indexOf('  Obj.') + '  Obj.'.length);
      const objectNames = labels(objectItems);
      assert.ok(objectNames.includes('Записать'));
      assert.ok(objectNames.includes('ЭкспортнаяФункцияОбъекта'));
      assert.ok(!objectNames.includes('ПриватнаяФункцияОбъекта'));
      assert.ok(!objectNames.includes('ОткрытьФормуМенеджера'));

      const objectLookupText = [
        'Процедура ВызватьОбъект()',
        `  Obj = Справочники.${catalogName}.НайтиПоКоду("code").ПолучитьОбъект();`,
        '  Obj.',
        'КонецПроцедуры',
      ].join('\n');
      const objectLookupDocument = localDocument(path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'), objectLookupText);
      const objectLookupItems = await completeWithLocalDocument(
        provider,
        objectLookupDocument,
        objectLookupText,
        objectLookupText.indexOf('  Obj.') + '  Obj.'.length,
      );
      assert.ok(labels(objectLookupItems).includes('Записать'), 'a CatalogManager reference followed by ПолучитьОбъект proves the CatalogObject role');

      const thisObjectText = [
        'Функция ЭкспортнаяФункцияОбъекта(Value) Экспорт',
        'КонецФункции',
        'Процедура ВызватьОбъект()',
        '  ЭтотОбъект.',
        'КонецПроцедуры',
      ].join('\n');
      const thisObjectPath = path.join(root, 'Catalogs', catalogName, 'Ext', 'ObjectModule.bsl');
      await fs.promises.mkdir(path.dirname(thisObjectPath), { recursive: true });
      await fs.promises.writeFile(thisObjectPath, thisObjectText, 'utf8');
      const thisObjectDocument = localDocument(thisObjectPath, thisObjectText);
      const thisObjectItems = await completeWithLocalDocument(provider, thisObjectDocument, thisObjectText, thisObjectText.indexOf('  ЭтотОбъект.') + '  ЭтотОбъект.'.length);
      assert.ok(labels(thisObjectItems).includes('Записать'));
      assert.ok(labels(thisObjectItems).includes('ЭкспортнаяФункцияОбъекта'));

      const englishThisObjectText = thisObjectText.replace('ЭтотОбъект.', 'ThisObject.');
      const englishThisObjectDocument = localDocument(thisObjectPath, englishThisObjectText);
      const englishThisObjectItems = await completeWithLocalDocument(
        provider,
        englishThisObjectDocument,
        englishThisObjectText,
        englishThisObjectText.indexOf('  ThisObject.') + '  ThisObject.'.length,
      );
      assert.ok(labels(englishThisObjectItems).includes('Записать'));

      const invalidSources = [
        `Процедура ЛожныйТип()\n  // Obj = Справочники.${catalogName}.СоздатьЭлемент()\n  Obj.\nКонецПроцедуры`,
        `Процедура ЛожныйТип()\n  Obj = "Справочники.${catalogName}.СоздатьЭлемент()"\n  Obj.\nКонецПроцедуры`,
        `Процедура ЛожныйТип()\n  Obj = Обёртка(Справочники.${catalogName}.СоздатьЭлемент())\n  Obj.\nКонецПроцедуры`,
        `Процедура ЛожныйТип()\n  Obj = Справочники.${catalogName}.НайтиПоКоду("code")\n  Obj.\nКонецПроцедуры`,
      ];
      for (const [index, invalidSource] of invalidSources.entries()) {
        const invalidDocument = localDocument(path.join(root, 'CommonModules', 'Caller', 'Ext', `Invalid${index}.bsl`), invalidSource);
        const invalidItems = await completeWithLocalDocument(
          provider,
          invalidDocument,
          invalidSource,
          invalidSource.indexOf('  Obj.') + '  Obj.'.length,
        );
        assert.ok(!labels(invalidItems).includes('Записать'), 'comments, strings, and nested arbitrary expressions do not infer CatalogObject');
      }
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
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

  test('suggests only loaded CommonModule names for bare identifiers and deduplicates other globals', async () => {
    const configRoot = path.resolve(os.tmpdir(), `bsl-completion-tree-${process.pid}-${Date.now()}`);
    const commonModules: TreeNode = {
      id: 'CommonModules',
      name: 'Общие модули',
      type: MetadataType.CommonModule,
      properties: { _indexLoaded: true } as TreeNode['properties'],
      children: [
        ...['мойМодульэ', 'МОЙМОДУЛЬЭ', 'мойМодульЕщё', 'Документы', 'Если', 'ЛокальнаяПроцедура']
          .map((name) => ({ id: `CommonModules.${name}`, name, type: MetadataType.CommonModule, properties: {} })),
      ],
    };
    const root: TreeNode = {
      id: 'completion-tree-root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [commonModules],
    };
    const tree = new MetadataTreeDataProvider();
    tree.setRootNode(root, { configPath: configRoot, format: ConfigFormat.Designer });
    const provider = new BslCompletionProvider(extensionRoot(), () => tree);
    const documentPath = path.join(configRoot, 'CommonModules', 'Caller', 'Ext', 'Module.bsl');
    const source = 'Процедура ЛокальнаяПроцедура()\nКонецПроцедуры\nмойМодул';
    const document = localDocument(documentPath, source);
    const typedItems = await completeWithLocalDocument(provider, document, source);
    const typedLabels = labels(typedItems);

    assert.ok(typedLabels.includes('мойМодульэ'), 'loaded CommonModules should match a partial Cyrillic prefix');
    assert.ok(typedLabels.includes('мойМодульЕщё'), 'matching should use a case-folded prefix');
    assert.strictEqual(typedLabels.filter((name) => name.toLocaleLowerCase('ru-RU') === 'моймодульэ').length, 1);
    const commonModuleItem = typedItems?.find(({ label }) => label === 'мойМодульэ');
    assert.strictEqual(commonModuleItem?.kind, vscode.CompletionItemKind.Module);
    assert.strictEqual(commonModuleItem?.detail, 'Общий модуль метаданных');
    assert.ok(!typedLabels.includes('Документы'), 'unrelated module names should be filtered by prefix');

    const allItems = await completeWithLocalDocument(provider, document, source, source.indexOf('мойМодул'));
    for (const name of ['Если', 'Документы', 'ЛокальнаяПроцедура']) {
      assert.strictEqual(labels(allItems).filter((item) => item === name).length, 1, `${name} should be deduplicated`);
    }
    assert.strictEqual(allItems?.find(({ label }) => label === 'Если')?.kind, vscode.CompletionItemKind.Keyword);
    assert.strictEqual(allItems?.find(({ label }) => label === 'Документы')?.kind, vscode.CompletionItemKind.Property);

    const unrelatedDocument = localDocument(
      path.join(path.dirname(configRoot), 'UnrelatedWorkspace', 'CommonModules', 'Caller', 'Module.bsl'),
      'мойМодул',
    );
    assert.ok(
      !labels(await completeWithLocalDocument(provider, unrelatedDocument, 'мойМодул')).includes('мойМодульэ'),
      'a resource outside the loaded configuration must not see its CommonModules',
    );

    const coldTree = new MetadataTreeDataProvider();
    coldTree.setRootNode({ ...root, id: 'cold-completion-tree-root', children: [{ ...commonModules, properties: {} }] }, {
      configPath: configRoot,
      format: ConfigFormat.Designer,
    });
    const coldProvider = new BslCompletionProvider(extensionRoot(), () => coldTree);
    assert.ok(
      !labels(await completeWithLocalDocument(coldProvider, document, 'мойМодул')).includes('мойМодульэ'),
      'an unloaded CommonModules folder must not be loaded as a side effect or suggested',
    );
  });

  test('keeps global completions available when the loaded metadata reader throws', async () => {
    const provider = new BslCompletionProvider(extensionRoot(), () => ({
      getLoadedTypeObjectsForResource: () => { throw new Error('tree disposed'); },
    }));
    const text = 'Докум';
    const document = localDocument(path.join(os.tmpdir(), 'ThrowingMetadataReader.bsl'), text);

    assert.ok(labels(await completeWithLocalDocument(provider, document, text)).includes('Документы'));
  });

  test('completes Модуль.Метод without inserting global CommonModule names in member context', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-provider-cyrillic-module-member-'));
    let treeLookups = 0;
    try {
      await createConfigurationRoot(root);
      await writeCommonModule(root, 'Модуль', [
        'Процедура МетодПроверки() Экспорт',
        'КонецПроцедуры',
      ].join('\n'));
      setWorkspaceRoots(root);
      const reader = {
        getLoadedTypeObjectsForResource: () => {
          treeLookups += 1;
          return { status: 'loaded' as const, names: ['Модуль'] };
        },
      };
      const provider = new BslCompletionProvider(extensionRoot(), () => reader);
      const text = 'Модуль.Мет';
      const document = localDocument(path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'), text);

      assert.deepStrictEqual(labels(await completeWithLocalDocument(provider, document, text)), ['МетодПроверки']);
      assert.strictEqual(treeLookups, 0, 'member completion must not query global CommonModule names');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('suggests loaded CommonModule names when the platform help index is unavailable', async () => {
    const missingIndexRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-provider-no-index-common-modules-'));
    try {
      const provider = new BslCompletionProvider(missingIndexRoot, () => ({
        getLoadedTypeObjectsForResource: () => ({ status: 'loaded', names: ['мойМодульэ'] }),
      }));
      const text = 'мойМодул';
      const document = localDocument(path.join(os.tmpdir(), 'LoadedCommonModuleWithoutHelp.bsl'), text);

      assert.ok(labels(await completeWithLocalDocument(provider, document, text)).includes('мойМодульэ'));
    } finally {
      await fs.promises.rm(missingIndexRoot, { recursive: true, force: true });
    }
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

  test('completes exact CommonModule methods when the platform index resource is missing', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-provider-module-without-index-'));
    const extensionRootWithoutIndex = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-provider-empty-extension-'));
    try {
      await createConfigurationRoot(root);
      await writeCommonModule(root, 'Library', 'Procedure MethodFromModule() Экспорт\nКонецПроцедуры');
      setWorkspaceRoots(root);
      const source = 'Library.Met';
      const document = localDocument(path.join(root, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'), source);
      const provider = new BslCompletionProvider(extensionRootWithoutIndex);

      assert.deepStrictEqual(
        labels(await completeWithLocalDocument(provider, document, source)),
        ['MethodFromModule'],
      );
    } finally {
      await fs.promises.rm(extensionRootWithoutIndex, { recursive: true, force: true });
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('completes every metadata collection through the loaded tree cache by Russian and English aliases', async () => {
    const calls: Array<{ resourcePath: string; folderId: string }> = [];
    const metadataCollections = await readBundledMetadataCollections();
    const reader = {
      getLoadedTypeObjectsForResource: (resourcePath: string, folderId: string) => {
        calls.push({ resourcePath, folderId });
        return { status: 'loaded' as const, names: [`${folderId}Object`] };
      },
    };
    const provider = new BslCompletionProvider(extensionRoot(), () => reader);

    for (const { aliases, folderId } of metadataCollections) {
      for (const alias of aliases) {
        const source = `${alias}.`;
        const document = localDocument(path.join(os.tmpdir(), 'MetadataCompletion.bsl'), source);
        const items = labels(await completeWithLocalDocument(provider, document, source));
        assert.deepStrictEqual(items, [`${folderId}Object`], `${alias} should resolve to ${folderId}`);
        assert.strictEqual(calls[calls.length - 1]?.folderId, folderId);
        assert.strictEqual(calls[calls.length - 1]?.resourcePath, document.uri.fsPath);
      }
    }
  });

  test('checks cancellation after platform index lookup before local module fallback', async () => {
    await loadBslCompletionIndex(extensionRoot());
    let tokenChecks = 0;
    let localFallbackCalls = 0;
    const provider = new BslCompletionProvider(extensionRoot());
    const providerWithTestLocalIndex = provider as unknown as {
      localIndex: {
        getCommonModuleRoutines(
          document: vscode.TextDocument,
          receiver: string,
          token: vscode.CancellationToken,
        ): Promise<readonly never[]>;
      };
    };
    providerWithTestLocalIndex.localIndex = {
      getCommonModuleRoutines: async () => {
        localFallbackCalls += 1;
        return [];
      },
    };
    const text = 'Library.Met';
    const document = localDocument(path.join(os.tmpdir(), 'CancelledMetadataCompletion.bsl'), text);
    const token = {
      get isCancellationRequested() {
        tokenChecks += 1;
        return tokenChecks > 1;
      },
    } as vscode.CancellationToken;
    const items = await provider.provideCompletionItems(
      document,
      new vscode.Position(0, text.length),
      token,
      {} as vscode.CompletionContext,
    );

    assert.strictEqual(items, undefined);
    assert.strictEqual(localFallbackCalls, 0);
  });

  test('metadata collection completion does not force any unloaded lazy tree index to load', async () => {
    let calls = 0;
    const provider = new BslCompletionProvider(extensionRoot(), () => ({
      getLoadedTypeObjectsForResource: () => {
        calls += 1;
        return { status: 'notLoaded' };
      },
    }));
    const text = 'РегистрыНакопления.';
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

  test('reads CatalogManager from Designer and CatalogObject from an exact EDT path', async () => {
    const designerRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-catalog-designer-'));
    const edtRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-catalog-edt-'));
    try {
      await createConfigurationRoot(designerRoot);
      await createConfigurationRoot(edtRoot);
      await writeCatalogModule(designerRoot, 'Goods', 'ManagerModule', [
        'Procedure DesignerManagerExport() Экспорт',
        'EndProcedure',
        'Procedure DesignerManagerPrivate()',
        'EndProcedure',
      ].join('\n'));
      await writeCatalogModule(edtRoot, 'Goods', 'ObjectModule', [
        'Function EdtObjectExport() Экспорт',
        'EndFunction',
        'Function EdtObjectPrivate()',
        'EndFunction',
      ].join('\n'), true);
      setWorkspaceRoots(designerRoot, edtRoot);
      const index = new BslLocalCompletionIndex();
      const designerDocument = localDocument(
        path.join(designerRoot, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'),
        'Procedure Caller()\nEndProcedure',
      );
      const edtDocument = localDocument(
        path.join(edtRoot, 'src', 'Catalogs', 'Caller', 'ObjectModule.bsl'),
        'Procedure Caller()\nEndProcedure',
      );

      assert.deepStrictEqual(
        (await index.getCatalogModuleRoutines(designerDocument, 'Goods', 'ManagerModule')).map(({ name }) => name),
        ['DesignerManagerExport'],
      );
      assert.deepStrictEqual(
        (await index.getCatalogModuleRoutines(edtDocument, 'Goods', 'ObjectModule')).map(({ name }) => name),
        ['EdtObjectExport'],
      );
    } finally {
      await fs.promises.rm(designerRoot, { recursive: true, force: true });
      await fs.promises.rm(edtRoot, { recursive: true, force: true });
    }
  });

  test('prefers an extension Catalog module with the same object name as the base configuration', async () => {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bsl-catalog-extension-'));
    const mainRoot = path.join(workspace, 'main');
    const extensionRoot = path.join(workspace, 'extension');
    try {
      await createConfigurationRoot(mainRoot);
      await createConfigurationRoot(extensionRoot, true);
      await writeCatalogModule(mainRoot, 'Goods', 'ManagerModule', 'Procedure BaseManager() Экспорт\nEndProcedure');
      await writeCatalogModule(extensionRoot, 'Goods', 'ManagerModule', 'Procedure ExtensionManager() Экспорт\nEndProcedure');
      setWorkspaceRoots(mainRoot, extensionRoot);
      const document = localDocument(
        path.join(mainRoot, 'CommonModules', 'Caller', 'Ext', 'Module.bsl'),
        'Procedure Caller()\nEndProcedure',
      );
      const index = new BslLocalCompletionIndex();

      assert.deepStrictEqual(
        (await index.getCatalogModuleRoutines(document, 'Goods', 'ManagerModule')).map(({ name }) => name),
        ['ExtensionManager'],
      );
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true });
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
