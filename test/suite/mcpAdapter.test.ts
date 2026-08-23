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
    readonly annotations?: {
      readonly readOnlyHint?: boolean;
      readonly destructiveHint?: boolean;
      readonly idempotentHint?: boolean;
      readonly openWorldHint?: boolean;
    };
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
  test('registerMcpTools preserves every catalog schema and annotation object', () => {
    const tools = captureRegisteredTools(async () => ({ success: true }));
    assert.strictEqual(tools.length, 73);
    assert.deepStrictEqual(
      tools.map(({ name, config }) => ({ name, annotations: config.annotations })),
      MCP_TOOL_CATALOG.map(({ name, annotations }) => ({ name, annotations })),
    );
    for (const [index, registered] of tools.entries()) {
      assert.strictEqual(registered.config.inputSchema, MCP_TOOL_CATALOG[index].inputSchema);
    }
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

  test('representative tools including both external processor commands dispatch generically', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const tools = captureRegisteredTools(async (command, args) => {
      calls.push({ command, args });
      return { success: true, data: { ok: true } };
    });
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
      ['cdt_list_objects', { type: 'Catalog', query: 'good' }, '1c-metadata-tree.agent.listObjects'],
      ['cdt_cfe_list_projects', { configurationId: 'cfg' }, '1c-metadata-tree.agent.cfe.listProjects'],
      ['cdt_create_object', { type: 'Catalog', name: 'Goods' }, '1c-metadata-tree.agent.createObject'],
      ['cdt_debug_stop', { sessionId: 's1' }, '1c-metadata-tree.agent.debug.stop'],
      ['cdt_forms_status', {}, '1c-metadata-tree.agent.forms.status'],
      ['cdt_skd_validate', { templatePath: 'template.xml' }, '1c-metadata-tree.agent.skd.validate'],
      ['cdt_xdto_compare', { packageName: 'p', source: '<x/>' }, '1c-metadata-tree.agent.xdto.compare'],
      [
        'cdt_dump_external_processor',
        {
          srcPath: 'C:/work/Processor.epf',
          format: 'Plain',
          context: { kind: 'standalone', acknowledgeTypeLoss: true },
        },
        '1c-metadata-tree.agent.dumpExternalProcessor',
      ],
      [
        'cdt_build_external_processor',
        {
          rootXmlPath: 'C:/work/Report_src/Report.xml',
          context: { kind: 'infobase', infobasePath: 'C:/db' },
        },
        '1c-metadata-tree.agent.buildExternalProcessor',
      ],
    ];
    for (const [name, args] of cases) {
      const target = tools.find((candidate) => candidate.name === name)!;
      const result = await target.handler(args, { signal: signal() });
      assert.strictEqual(result.isError, undefined, name);
    }

    assert.deepStrictEqual(calls, cases.map(([, args, command]) => ({ command, args })));
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
