import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import '../helpers/vscodeStubRegister';
import { AgentSyntaxHelpOperations } from '../../src/agent/agentSyntaxHelp';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { registerMcpTools } from '../../src/agent/mcpAdapter/toolCatalog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resetVscodeTestState, setExecuteCommandHandler, vscodeTestState } from '../helpers/vscodeModuleStub';

function extensionRoot(): string {
  return path.resolve(__dirname, '../../..');
}

function dataOf<T>(result: { success: boolean; data?: T; code?: string }): T {
  assert.strictEqual(result.success, true, result.code ?? 'expected successful syntax-help result');
  return result.data as T;
}

interface FixtureArticle {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly renderedContent?: string;
}

async function createSyntaxHelpFixture(articles: readonly FixtureArticle[] = []): Promise<{
  readonly extensionPath: string;
  readonly operations: AgentSyntaxHelpOperations;
  readonly articleIds: readonly string[];
  dispose(): Promise<void>;
}> {
  const extensionPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'syntax-help-articles-'));
  try {
    const helpPath = path.join(extensionPath, 'resources', 'help');
    const standardsPath = path.join(extensionPath, 'resources', 'standards');
    const wasmPath = path.join(extensionPath, 'node_modules', 'sql.js', 'dist');
    await fs.promises.mkdir(helpPath, { recursive: true });
    await fs.promises.mkdir(standardsPath, { recursive: true });
    await fs.promises.mkdir(wasmPath, { recursive: true });
    await fs.promises.copyFile(
      path.join(extensionRoot(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      path.join(wasmPath, 'sql-wasm.wasm'),
    );
    await fs.promises.writeFile(path.join(standardsPath, 'manifest.json'), JSON.stringify({
      version: 1,
      entries: [{ slug: 'fixture-standard', name: 'Fixture standard', path: 'fixture.md', summary: 'Fixture content.' }],
    }));

    const databasePath = path.join(helpPath, 'shcntx_help.db');
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(extensionRoot(), 'node_modules', 'sql.js', 'dist', file),
    });
    const database = new SQL.Database();
    database.run('CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL)');
    database.run('CREATE TABLE article_markdown (node_id INTEGER PRIMARY KEY, markdown TEXT NOT NULL)');
    database.run(
      'INSERT INTO nodes (id, parent_id, name, path, content) VALUES (1, NULL, ?, ?, ?)',
      [
        'Глобальный контекст',
        'Global context.html',
        'Глобальный контекст\n\nМетоды:\nТекущаяДата (CurrentDate)\nВвестиДатуАсинх (InputDateAsync)\n\nСобытия:\nПередЗаписью (BeforeWrite)',
      ],
    );
    const maxId = database.exec('SELECT MAX(id) FROM nodes')[0]?.values[0]?.[0];
    assert.strictEqual(typeof maxId, 'number');
    const articleIds: string[] = [];
    articles.forEach((article, index) => {
      const id = (maxId as number) + index + 1;
      database.run(
        'INSERT INTO nodes (id, parent_id, name, path, content) VALUES (?, 1, ?, ?, ?)',
        [id, article.name, article.path, article.content],
      );
      if (article.renderedContent !== undefined) {
        database.run('INSERT INTO article_markdown (node_id, markdown) VALUES (?, ?)', [id, article.renderedContent]);
      }
      articleIds.push(`syntax:${id}`);
    });
    await fs.promises.writeFile(databasePath, Buffer.from(database.export()));
    database.close();

    return {
      extensionPath,
      operations: new AgentSyntaxHelpOperations(extensionPath),
      articleIds,
      dispose: () => fs.promises.rm(extensionPath, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.promises.rm(extensionPath, { recursive: true, force: true });
    throw error;
  }
}

suite('AgentSyntaxHelpOperations', function () {
  this.timeout(15000);
  const operations = new AgentSyntaxHelpOperations(extensionRoot());

  test('MCP dispatcher reaches the registered Agent command and reads the bundled SQLite database', async () => {
    type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<CallToolResult>;
    const registeredTools: Array<{ name: string; handler: Handler }> = [];
    const server = {
      registerTool(name: string, _config: unknown, handler: Handler): void {
        registeredTools.push({ name, handler });
      },
    } as unknown as McpServer;

    resetVscodeTestState();
    try {
      const context = { extensionPath: extensionRoot(), subscriptions: [] as Array<{ dispose(): void }> };
      registerAgentCommands(context as never, () => null, async () => null, new DebugSessionRegistry());
      assert.ok(vscodeTestState.registeredCommandIds.includes('1c-metadata-tree.agent.syntaxHelp'));
      setExecuteCommandHandler(async (command, args) => {
        const handler = vscodeTestState.registeredCommandHandlers.get(command);
        assert.strictEqual(typeof handler, 'function', `Command not registered: ${command}`);
        return handler!(args);
      });
      registerMcpTools(server);

      const result = await registeredTools.find(({ name }) => name === 'cdt_read')!.handler({
        operation: 'cdt_syntax_help',
        arguments: { query: 'Глобальный контекст', source: 'syntax', limit: 1 },
      }, { signal: new AbortController().signal });
      const agentResult = result.structuredContent as unknown as {
        success: boolean;
        data?: { items: Array<{ id: string; source: string; name: string }> };
      };

      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(agentResult.success, true);
      assert.strictEqual(agentResult.data?.items[0]?.id, 'syntax:1');
      assert.strictEqual(agentResult.data?.items[0]?.source, 'syntax');
      assert.strictEqual(agentResult.data?.items[0]?.name, 'Глобальный контекст');
      assert.ok(vscodeTestState.executeCommandHistory.some(({ name }) => name === '1c-metadata-tree.agent.syntaxHelp'));

      const line = 'Результат = Новый Структура("Форма", Обработка.Данные.Получить()); // Справочники';
      const lineResult = await registeredTools.find(({ name }) => name === 'cdt_read')!.handler({
        operation: 'cdt_syntax_help',
        arguments: {
          action: 'searchLine',
          line,
          cursorColumn: line.indexOf('Получить'),
          source: 'syntax',
          limit: 5,
        },
      }, { signal: new AbortController().signal });
      const lineAgentResult = lineResult.structuredContent as unknown as {
        success: boolean;
        data?: { line: string; terms: string[]; items: Array<{ id: string }> };
      };
      assert.strictEqual(lineAgentResult.success, true);
      assert.strictEqual(lineAgentResult.data?.line, line);
      assert.strictEqual(lineAgentResult.data?.terms[0], 'Получить');
      assert.ok(!lineAgentResult.data?.terms.includes('Форма'), 'Quoted text must not become a search term.');
      assert.ok(!lineAgentResult.data?.terms.includes('Справочники'), 'Comment text must not become a search term.');
      assert.ok(lineAgentResult.data?.items.length);
    } finally {
      resetVscodeTestState();
    }
  });

  test('searches syntax and standards case-insensitively and treats SQL wildcard characters literally', async () => {
    const crossSource = dataOf(await operations.execute({ query: 'МОДУЛ', source: 'all', limit: 50 })) as {
      items: Array<{ source: string }>;
    };
    assert.ok(crossSource.items.some((item) => item.source === 'syntax'));
    assert.ok(crossSource.items.some((item) => item.source === 'standards'));

    const wildcard = dataOf(await operations.execute({ query: '%_%%%NO_RESULT_123', source: 'syntax' })) as {
      total: number;
      items: unknown[];
    };
    assert.deepStrictEqual(wildcard, {
      query: '%_%%%NO_RESULT_123', source: 'syntax', total: 0, limit: 10, hasMore: false, items: [],
    });
  });

  test('ranks exact names first and bounds result count to the default limit of ten', async () => {
    const exact = dataOf(await operations.execute({
      query: 'Транзакции и блокировки',
      source: 'standards',
    })) as { items: Array<{ id: string; name: string }>; total: number; limit: number; hasMore: boolean };
    assert.strictEqual(exact.items[0].id, 'standards:transactions-and-locks');
    assert.strictEqual(exact.items[0].name, 'Транзакции и блокировки');

    const roots = dataOf(await operations.execute({ action: 'children', source: 'all', parentId: null })) as {
      items: unknown[];
      total: number;
      limit: number;
      hasMore: boolean;
    };
    assert.strictEqual(roots.limit, 10);
    assert.strictEqual(roots.items.length, 10);
    assert.ok(roots.total > roots.limit);
    assert.strictEqual(roots.hasMore, true);
  });

  test('gets by numeric ID, exact relative path and exact name, preserving syntax text after a Markdown heading', async () => {
    const byId = dataOf(await operations.execute({ action: 'get', source: 'syntax', id: 1 })) as {
      id: string;
      name: string;
      path: string;
      markdown: string;
    };
    assert.strictEqual(byId.id, 'syntax:1');
    assert.strictEqual(byId.path, 'Global context.html');
    assert.ok(byId.markdown.startsWith('# Глобальный контекст\n\n'));
    assert.ok(byId.markdown.includes('<Имя общего модуля>'), 'Angle-bracket syntax placeholders must be preserved.');
    assert.ok(!byId.markdown.startsWith('\uFEFF'));

    const byPath = dataOf(await operations.execute({ action: 'get', source: 'syntax', query: 'Global context.html' })) as {
      id: string;
    };
    assert.strictEqual(byPath.id, byId.id);

    const byName = dataOf(await operations.execute({ action: 'get', source: 'standards', query: 'Транзакции и блокировки' })) as {
      id: string;
      markdown: string;
      sourceUrl?: string;
    };
    assert.strictEqual(byName.id, 'standards:transactions-and-locks');
    assert.ok(byName.markdown.startsWith('# Транзакции и блокировки\n'));
    assert.strictEqual(byName.markdown.match(/^# Транзакции и блокировки$/gm)?.length, 1);
    assert.match(byName.sourceUrl ?? '', /^https:\/\/its\.1c\.ru\//);
  });

  test('matches bilingual standalone articles in search, get, searchLine, and children', async () => {
    const fixture = await createSyntaxHelpFixture([
      {
        name: 'ТекущаяДата (CurrentDate)',
        path: 'Global context/methods/catalog4840/CurrentDate956.html',
        content: 'ТекущаяДата()\n\nВозвращаемое значение: Дата.\n\nОписание:\nВозвращает текущую дату сервера.',
      },
      {
        name: 'ТестовыйМетод (SharedAlias)',
        path: 'Global context/methods/catalog9999/TestMethod1.html',
        content: 'ТестовыйМетод()\n\nПервый тестовый метод.',
      },
      {
        name: 'ДругойМетод (SharedAlias)',
        path: 'Global context/methods/catalog9999/OtherMethod2.html',
        content: 'ДругойМетод()\n\nВторой тестовый метод.',
      },
    ]);
    try {
      const currentDateId = fixture.articleIds[0];
      for (const query of ['ТекущаяДата', 'CurrentDate']) {
        const search = dataOf(await fixture.operations.execute({
          action: 'search', query, source: 'syntax', limit: 10,
        })) as { items: Array<{ id: string; name: string; snippet: string }> };
        assert.strictEqual(search.items[0]?.id, currentDateId, `The ${query} alias should rank as an exact article name.`);
        assert.ok(search.items.every(({ id }) => id !== 'syntax:1'), 'The parent Global context article is redundant for an exact standalone article.');
        assert.ok(search.items.every(({ id }) => id === currentDateId), 'Content-only matches should be suppressed for an exact standalone article.');
        assert.match(search.items[0].snippet, /ТекущаяДата\(\)/);
        assert.match(search.items[0].snippet, /Возвращает текущую дату сервера/);
        assert.ok(!search.items[0].snippet.includes('ДругойМетод'), 'The snippet should come from the detailed article only.');

        const article = dataOf(await fixture.operations.execute({ action: 'get', query, source: 'syntax' })) as {
          id: string;
          markdown: string;
        };
        assert.strictEqual(article.id, currentDateId);
        assert.match(article.markdown, /ТекущаяДата\(\)/);
        assert.match(article.markdown, /Возвращает текущую дату сервера/);
      }

      for (const [line, identifier] of [
        ['ТекущаяДата();', 'ТекущаяДата'],
        ['CurrentDate();', 'CurrentDate'],
      ]) {
        const result = dataOf(await fixture.operations.execute({
          action: 'searchLine', line, cursorColumn: line.indexOf(identifier) + 2, source: 'syntax', limit: 10,
        })) as { items: Array<{ id: string; name: string; snippet: string }> };
        assert.strictEqual(result.items[0]?.id, currentDateId, JSON.stringify(result.items));
        assert.ok(result.items.every(({ id }) => id !== 'syntax:1'), 'The parent member-line pseudo-hit should be hidden.');
        assert.ok(result.items.every(({ name }) => name === 'ТекущаяДата (CurrentDate)'), `Only exact member/article matches should remain ahead of broad content noise: ${JSON.stringify(result.items)}`);
        assert.match(result.items[0].snippet, /Возвращает текущую дату сервера/);
      }

      const children = dataOf(await fixture.operations.execute({
        action: 'children', source: 'syntax', parentId: 1, limit: 50,
      })) as { items: Array<{ id: string; name: string; hasChildren: boolean }> };
      const currentDateChild = children.items.find(({ id }) => id === currentDateId);
      assert.strictEqual(currentDateChild?.name, 'ТекущаяДата (CurrentDate)');
      assert.strictEqual(currentDateChild?.hasChildren, false);

      const ambiguousAlias = await fixture.operations.execute({ action: 'get', source: 'syntax', query: 'SharedAlias' });
      assert.strictEqual(ambiguousAlias.code, 'KNOWLEDGE_ITEM_AMBIGUOUS');
      assert.strictEqual((ambiguousAlias.data as { candidates: unknown[] }).candidates.length, 2);
    } finally {
      await fixture.dispose();
    }
  });

  test('uses linked display content for get while search keeps the original content', async () => {
    const fixture = await createSyntaxHelpFixture([
      {
        name: 'Первый метод', path: 'Global context/methods/First.html',
        content: 'SearchOnlyTerm()', renderedContent: 'Read [Второй метод](bsl-help:syntax:3).',
      },
      { name: 'Второй метод', path: 'Global context/methods/Second.html', content: 'Target.' },
    ]);
    try {
      const search = dataOf(await fixture.operations.execute({
        action: 'search', query: 'SearchOnlyTerm', source: 'syntax', limit: 10,
      })) as { items: Array<{ id: string; snippet: string }> };
      assert.strictEqual(search.items[0]?.id, 'syntax:2');
      assert.match(search.items[0]?.snippet ?? '', /SearchOnlyTerm/);
      const article = dataOf(await fixture.operations.execute({
        action: 'get', id: 'syntax:2', source: 'syntax',
      })) as { markdown: string };
      assert.match(article.markdown, /Read \[Второй метод\]\(bsl-help:syntax:3\)\./);
      assert.doesNotMatch(article.markdown, /SearchOnlyTerm/);
    } finally {
      await fixture.dispose();
    }
  });

  test('uses the bundled CurrentDate method for calls and keeps non-unique alias lookup ambiguous', async () => {
    const methodPath = 'Global context/methods/catalog4840/CurrentDate956.html';
    const method = dataOf(await operations.execute({ action: 'get', source: 'syntax', query: methodPath })) as {
      id: string;
      path: string;
      markdown: string;
    };
    assert.strictEqual(method.id, 'syntax:2986');
    assert.strictEqual(method.path, methodPath);
    assert.match(method.markdown, /ТекущаяДата\(\)/);
    assert.match(method.markdown, /Возвращаемое значение/);

    for (const query of ['ТекущаяДата', 'CurrentDate']) {
      const search = dataOf(await operations.execute({ action: 'search', source: 'syntax', query, limit: 5 })) as {
        items: Array<{ id: string; path: string }>;
      };
      assert.strictEqual(search.items[0]?.id, method.id);
      assert.ok(search.items.every(({ id }) => id !== 'syntax:1'), 'The parent Global context article should be suppressed.');

      const line = `${query}   ( );`;
      const call = dataOf(await operations.execute({
        action: 'searchLine', line, cursorColumn: line.indexOf(query) + 2, source: 'syntax', limit: 10,
      })) as { items: Array<{ id: string; path: string; snippet: string }> };
      assert.strictEqual(call.items[0]?.id, method.id, 'A method call should rank the global method article first.');
      assert.ok(call.items.every(({ id }) => id !== 'syntax:1'), 'The parent Global context pseudo-hit should be suppressed.');
      assert.match(call.items[0].snippet, /Возвращаемое значение/);
    }

    const propertyLine = 'ПолеКалендаря.ТекущаяДата';
    const propertyContext = dataOf(await operations.execute({
      action: 'searchLine', line: propertyLine, cursorColumn: propertyLine.indexOf('ТекущаяДата') + 2, source: 'syntax', limit: 10,
    })) as { items: Array<{ id: string; path: string }> };
    assert.ok(propertyContext.items.some(({ id, path }) => id === 'syntax:12809' && path.includes('/properties/')));
    assert.ok(propertyContext.items.some(({ id }) => id === method.id));

    for (const query of ['ТекущаяДата', 'CurrentDate']) {
      const ambiguous = await operations.execute({ action: 'get', source: 'syntax', query });
      assert.strictEqual(ambiguous.code, 'KNOWLEDGE_ITEM_AMBIGUOUS');
      const candidateIds = (ambiguous.data as { candidates: Array<{ id: string }> }).candidates.map(({ id }) => id);
      assert.ok(candidateIds.includes(method.id));
      assert.ok(candidateIds.includes('syntax:12809'));
    }
  });

  test('children stay inside their selected source and search bounds snippets and results', async () => {
    const children = dataOf(await operations.execute({
      action: 'children', source: 'syntax', parentId: 2, limit: 1,
    })) as { items: Array<{ id: string; source: string }>; total: number; limit: number; hasMore: boolean };
    assert.strictEqual(children.items.length, 1);
    assert.strictEqual(children.items[0].source, 'syntax');
    assert.strictEqual(children.limit, 1);
    assert.strictEqual(children.hasMore, true);

    const crossSourceParent = await operations.execute({
      action: 'children', source: 'syntax', parentId: 'standards:code-placement',
    });
    assert.strictEqual(crossSourceParent.success, false);
    assert.strictEqual(crossSourceParent.code, 'KNOWLEDGE_PARENT_NOT_FOUND');

    const bounded = dataOf(await operations.execute({
      query: 'Форма', source: 'syntax', limit: 1, snippetLength: 40,
    })) as { items: Array<{ snippet: string }>; total: number; limit: number; hasMore: boolean };
    assert.strictEqual(bounded.items.length, 1);
    assert.ok(bounded.items[0].snippet.length <= 40);
    assert.ok(bounded.total > bounded.limit);
    assert.strictEqual(bounded.hasMore, true);
  });

  test('searches identifiers from the current BSL line while excluding keywords, quoted literals, and comments', async () => {
    const line = 'Результат = Новый Структура("ОткрытьФорму", Обработка.Данные.Получить()); // СправочникОбъект';
    const result = dataOf(await operations.execute({
      action: 'searchLine',
      line,
      cursorColumn: line.indexOf('Получить'),
      source: 'syntax',
      limit: 5,
    })) as { line: string; terms: string[]; source: string; total: number; items: Array<{ id: string }> };

    assert.strictEqual(result.line, line);
    assert.strictEqual(result.source, 'syntax');
    assert.strictEqual(result.terms[0], 'Получить');
    assert.ok(!result.terms.includes('Новый'), 'BSL syntax keywords must not dominate contextual searches.');
    assert.ok(!result.terms.includes('ОткрытьФорму'), 'Identifiers inside quoted literals must be ignored.');
    assert.ok(!result.terms.includes('СправочникОбъект'), 'Identifiers inside comments must be ignored.');
    assert.ok(result.items.length > 0);
    assert.ok(result.items.length <= 5);

    const exactFirst = dataOf(await operations.execute({
      action: 'searchLine',
      line: 'Значение = Форма;',
      cursorColumn: 'Значение = Форма;'.indexOf('Форма') + 2,
      source: 'syntax',
      limit: 5,
    })) as { terms: string[]; items: Array<{ name: string }> };
    assert.match(exactFirst.items[0].name, /^Форма(?: \(Form\))?$/, 'An exact API entry under the cursor must lead generic content matches.');

    const inString = await operations.execute({
      action: 'searchLine',
      line: "Сообщить('СправочникОбъект');",
      cursorColumn: 14,
      source: 'syntax',
    });
    const stringData = dataOf(inString) as { terms: string[]; total: number; items: unknown[] };
    assert.deepStrictEqual(stringData.terms, ['Сообщить']);
    assert.ok(stringData.total > 0);

    const commentOnly = await operations.execute({
      action: 'searchLine', line: '// СправочникОбъект', cursorColumn: 10,
    });
    assert.deepStrictEqual(dataOf(commentOnly), {
      line: '// СправочникОбъект', terms: [], source: 'all', total: 0, limit: 10, hasMore: false, items: [],
    });
  });

  test('searchLine preserves parent member fallback when no standalone article exists', async () => {
    const fixture = await createSyntaxHelpFixture();
    try {
      const line = 'ВвестиДатуАсинх;';
      const exact = dataOf(await fixture.operations.execute({
        action: 'searchLine', line, cursorColumn: line.indexOf('ВвестиДатуАсинх') + 3, source: 'syntax',
      })) as { items: Array<{ id: string; name: string; path: string; snippet: string }> };
      const member = exact.items.find(({ id }) => id === 'syntax:1');

      assert.ok(member, 'The parent platform article should be returned for a member without a standalone article.');
      assert.strictEqual(member.path, 'Global context.html');
      assert.match(member.name, /ВвестиДатуАсинх/);
      assert.match(member.name, /InputDateAsync/);
      assert.match(member.snippet, /ВвестиДатуАсинх \(InputDateAsync\)/);
      assert.ok(exact.items.every(({ name }) => name === member.name), 'Broad content-only hits should be hidden after an exact member hit.');

      const fallbackLine = 'Окружение = Контекст;';
      const fallback = dataOf(await fixture.operations.execute({
        action: 'searchLine', line: fallbackLine, cursorColumn: fallbackLine.indexOf('Контекст') + 2, source: 'syntax',
      })) as { items: Array<{ name: string; snippet: string }> };
      assert.ok(fallback.items.length > 0, 'Broad content matches should remain when the nearest term has no exact hit.');

      const eventLine = 'Объект.ПередЗаписью;';
      const eventResults = dataOf(await fixture.operations.execute({
        action: 'searchLine', line: eventLine, cursorColumn: eventLine.indexOf('ПередЗаписью') + 4, source: 'syntax',
      })) as { items: Array<{ name: string; snippet: string }> };
      assert.ok(eventResults.items.length > 0, 'An event with no standalone article should use broad content fallback.');
      assert.ok(eventResults.items.every(({ name }) => name !== 'ПередЗаписью (BeforeWrite)'));
    } finally {
      await fixture.dispose();
    }
  });

  test('searchLine validates its line context and refuses unrelated search arguments', async () => {
    for (const invalid of [
      { action: 'searchLine' },
      { action: 'searchLine', line: '' },
      { action: 'searchLine', line: 'Сообщить(1);', cursorColumn: -1 },
      { action: 'searchLine', line: 'Сообщить(1);', cursorColumn: 99 },
      { action: 'searchLine', line: 'Сообщить(1);', cursorColumn: 1.5 },
      { action: 'searchLine', line: 'a'.repeat(2001) },
      { action: 'searchLine', line: 'Сообщить(1);', query: 'Сообщить' },
      { action: 'searchLine', line: 'Сообщить(1);', id: 'syntax:1' },
      { action: 'searchLine', line: 'Сообщить(1);', parentId: null },
    ]) {
      const result = await operations.execute(invalid);
      assert.strictEqual(result.success, false, JSON.stringify(invalid));
      assert.strictEqual(result.code, 'INVALID_ARGUMENTS', JSON.stringify(invalid));
    }
  });

  test('reports ambiguous exact names and rejects conflicting direct Agent arguments', async () => {
    const ambiguous = await operations.execute({ action: 'get', source: 'syntax', query: 'Почта' });
    assert.strictEqual(ambiguous.code, 'KNOWLEDGE_ITEM_AMBIGUOUS');
    assert.strictEqual((ambiguous.data as { candidates: unknown[] }).candidates.length, 3);

    const conflicting = await operations.execute({ action: 'get', id: 1, query: 'different item' });
    assert.strictEqual(conflicting.success, false);
    assert.strictEqual(conflicting.code, 'INVALID_ARGUMENTS');

    for (const invalid of [
      { action: 'search' },
      { action: 'search', query: '   ' },
      { action: 'get', id: 1, query: 'other' },
      { query: 'term', source: 'unknown' },
      { query: 'term', limit: 0 },
      { query: 'term', snippetLength: 39 },
      { query: 'term', unexpected: true },
    ]) {
      const result = await operations.execute(invalid);
      assert.strictEqual(result.success, false, JSON.stringify(invalid));
      assert.strictEqual(result.code, 'INVALID_ARGUMENTS', JSON.stringify(invalid));
    }
  });

  test('bundled standards manifest contains thirteen original articles with official ITS sources', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(extensionRoot(), 'resources', 'standards', 'manifest.json'),
      'utf8',
    )) as { entries: Array<{ contentPath?: string; sourceUrl?: string }> };
    const articles = manifest.entries.filter((entry) => entry.contentPath !== undefined);
    assert.strictEqual(articles.length, 13);
    assert.ok(articles.every((entry) => /^https:\/\/its\.1c\.ru\//.test(entry.sourceUrl ?? '')));
  });

  test('reports malformed SQLite resource with a typed error and without exposing local paths', async () => {
    const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'syntax-help-invalid-'));
    try {
      const databaseDirectory = path.join(temporaryRoot, 'resources', 'help');
      const wasmDirectory = path.join(temporaryRoot, 'node_modules', 'sql.js', 'dist');
      await fs.promises.mkdir(databaseDirectory, { recursive: true });
      await fs.promises.mkdir(wasmDirectory, { recursive: true });
      await fs.promises.copyFile(
        path.join(extensionRoot(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        path.join(wasmDirectory, 'sql-wasm.wasm'),
      );
      await fs.promises.writeFile(path.join(databaseDirectory, 'shcntx_help.db'), 'not sqlite');

      const result = await new AgentSyntaxHelpOperations(temporaryRoot).execute({ query: 'Форма' });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.code, 'KNOWLEDGE_RESOURCE_INVALID');
      assert.ok(!JSON.stringify(result).includes(temporaryRoot));
    } finally {
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
