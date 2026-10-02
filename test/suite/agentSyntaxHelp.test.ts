import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

suite('AgentSyntaxHelpOperations', () => {
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
    } finally {
      resetVscodeTestState();
    }
  });

  test('searches syntax and standards case-insensitively and treats SQL wildcard characters literally', async () => {
    const crossSource = dataOf(await operations.execute({ query: 'МОДУЛ', source: 'all' })) as {
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
