import * as assert from 'assert';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentResult } from '../../src/agent/types';
import {
  MCP_TOOL_CATALOG,
  mapAgentResult,
  registerMcpTools,
} from '../../src/agent/mcpAdapter/toolCatalog';

type ToolHandler = (
  args: Record<string, unknown>,
  extra: { signal: AbortSignal },
) => Promise<CallToolResult>;

interface RegisteredTool {
  readonly name: string;
  readonly config: {
    readonly inputSchema: { safeParse(value: unknown): { success: boolean } };
    readonly annotations?: { readonly readOnlyHint?: boolean };
  };
  readonly handler: ToolHandler;
}

function captureRegisteredTools(
  executeCommand: (command: string, args: Record<string, unknown>) => Promise<unknown>,
): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const server = {
    registerTool(name: string, config: RegisteredTool['config'], handler: ToolHandler): void {
      tools.push({ name, config, handler });
    },
  } as unknown as McpServer;
  registerMcpTools(server, executeCommand);
  return tools;
}

function signal(aborted = false): AbortSignal {
  const controller = new AbortController();
  if (aborted) {
    controller.abort();
  }
  return controller.signal;
}

suite('MCP adapter: tool contract', () => {
  test('publishes exactly the six specified tools in stable order', () => {
    assert.deepStrictEqual(
      MCP_TOOL_CATALOG.map(({ name, command }) => ({ name, command })),
      [
        { name: 'cdt_list_configurations', command: '1c-metadata-tree.agent.listConfigurations' },
        { name: 'cdt_list_objects', command: '1c-metadata-tree.agent.listObjects' },
        { name: 'cdt_get_yaml', command: '1c-metadata-tree.agent.getYaml' },
        { name: 'cdt_get_properties', command: '1c-metadata-tree.agent.getProperties' },
        { name: 'cdt_list_bindings', command: '1c-metadata-tree.agent.listBindings' },
        { name: 'cdt_export_status', command: '1c-metadata-tree.agent.exportStatus' },
      ],
    );
  });

  test('input schemas accept only the documented fields and reject additional properties', () => {
    const byName = new Map(MCP_TOOL_CATALOG.map((tool) => [tool.name, tool.inputSchema]));
    const accepts = (name: string, value: unknown): boolean => byName.get(name)!.safeParse(value).success;

    assert.strictEqual(accepts('cdt_list_configurations', {}), true);
    assert.strictEqual(accepts('cdt_list_configurations', { extra: true }), false);
    assert.strictEqual(accepts('cdt_list_bindings', {}), true);
    assert.strictEqual(accepts('cdt_list_bindings', { configurationId: 'x' }), false);

    assert.strictEqual(accepts('cdt_list_objects', {}), true);
    assert.strictEqual(accepts('cdt_list_objects', { configurationId: 'a', type: 'Catalog', query: 'goods' }), true);
    assert.strictEqual(accepts('cdt_list_objects', { query: '', extra: 1 }), false);
    assert.strictEqual(accepts('cdt_list_objects', { type: '' }), false);

    for (const name of ['cdt_get_yaml', 'cdt_get_properties']) {
      assert.strictEqual(accepts(name, { path: 'Catalog.Goods' }), true, name);
      assert.strictEqual(accepts(name, {}), false, name);
      assert.strictEqual(accepts(name, { path: '', configurationId: 'a' }), false, name);
      assert.strictEqual(accepts(name, { path: 'Catalog.Goods', unknown: true }), false, name);
    }

    assert.strictEqual(accepts('cdt_export_status', {}), true);
    assert.strictEqual(accepts('cdt_export_status', { configurationId: 'a', configPath: 'C:\\cfg' }), true);
    assert.strictEqual(accepts('cdt_export_status', { configPath: '', extra: true }), false);
  });

  test('all registered tools are marked read-only', () => {
    const tools = captureRegisteredTools(async () => ({ success: true }));
    assert.strictEqual(tools.length, 6);
    assert.ok(tools.every((tool) => tool.config.annotations?.readOnlyHint === true));
  });
});

suite('MCP adapter: AgentResult mapping and dispatch', () => {
  test('maps success without changing structured content and emits its JSON copy', () => {
    const source = { success: true, data: { objects: [{ name: 'Goods' }] } };
    const mapped = mapAgentResult(source as unknown as AgentResult);
    assert.deepStrictEqual(mapped.structuredContent, source);
    assert.strictEqual(mapped.isError, undefined);
    assert.deepStrictEqual(JSON.parse(mapped.content[0].type === 'text' ? mapped.content[0].text : ''), source);
  });

  test('maps Agent API errors to isError while preserving the envelope', () => {
    const source = { success: false, code: 'NOT_FOUND', error: 'No object' };
    const mapped = mapAgentResult(source);
    assert.strictEqual(mapped.isError, true);
    assert.deepStrictEqual(mapped.structuredContent, source);
  });

  test('valid invocation dispatches exactly one matching Agent command', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const tools = captureRegisteredTools(async (command, args) => {
      calls.push({ command, args });
      return { success: true, data: { ok: true } };
    });
    const target = tools.find((tool) => tool.name === 'cdt_list_objects')!;
    const result = await target.handler({ type: 'Catalog', query: 'good' }, { signal: signal() });

    assert.deepStrictEqual(calls, [{
      command: '1c-metadata-tree.agent.listObjects',
      args: { type: 'Catalog', query: 'good' },
    }]);
    assert.strictEqual(result.isError, undefined);
  });

  test('normalizes command exceptions without leaking a stack', async () => {
    const tools = captureRegisteredTools(async () => {
      const error = new Error('secret command failure details');
      error.stack = 'secret stack';
      throw error;
    });
    const result = await tools[0].handler({}, { signal: signal() });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(result.structuredContent, {
      success: false,
      code: 'AGENT_COMMAND_FAILED',
      error: 'Agent command failed',
    });
    assert.ok(!JSON.stringify(result).includes('secret command failure details'));
    assert.ok(!JSON.stringify(result).includes('secret stack'));
  });

  test('cancellation before dispatch returns REQUEST_CANCELLED and does not execute', async () => {
    let dispatched = false;
    const tools = captureRegisteredTools(async () => {
      dispatched = true;
      return { success: true };
    });
    const result = await tools[0].handler({}, { signal: signal(true) });
    assert.strictEqual(dispatched, false);
    assert.deepStrictEqual(result.structuredContent, {
      success: false,
      code: 'REQUEST_CANCELLED',
      error: 'MCP request was cancelled',
    });
    assert.strictEqual(result.isError, true);
  });

  test('cancellation during dispatch waits for command and discards its result', async () => {
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { finish = resolve; });
    const tools = captureRegisteredTools(async () => pending);
    const invocation = tools[0].handler({}, { signal: controller.signal });
    controller.abort();
    finish({ success: true, data: { mustNotEscape: true } });
    const result = await invocation;
    assert.deepStrictEqual(result.structuredContent, {
      success: false,
      code: 'REQUEST_CANCELLED',
      error: 'MCP request was cancelled',
    });
    assert.strictEqual(result.isError, true);
  });
});
