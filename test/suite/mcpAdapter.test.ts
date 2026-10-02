import * as assert from 'assert';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentResult } from '../../src/agent/types';
import {
  MCP_OPERATION_CATALOG,
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
  test('registerMcpTools exposes exactly seven compact schemas and annotation objects by default', () => {
    const previous = process.env.CDT_MCP_LEGACY_TOOLS;
    delete process.env.CDT_MCP_LEGACY_TOOLS;
    try {
      const tools = captureRegisteredTools(async () => ({ success: true }));
      assert.strictEqual(tools.length, 7);
      assert.deepStrictEqual(
        tools.map(({ name, config }) => ({ name, annotations: config.annotations })),
        MCP_TOOL_CATALOG.map(({ name, annotations }) => ({ name, annotations })),
      );
      for (const [index, registered] of tools.entries()) {
        assert.strictEqual(registered.config.inputSchema, MCP_TOOL_CATALOG[index].inputSchema);
      }
    } finally {
      if (previous !== undefined) {
        process.env.CDT_MCP_LEGACY_TOOLS = previous;
      }
    }
  });

  test('legacy opt-in registers all 82 operations alongside the seven compact tools', () => {
    const previous = process.env.CDT_MCP_LEGACY_TOOLS;
    process.env.CDT_MCP_LEGACY_TOOLS = '1';
    try {
      const tools = captureRegisteredTools(async () => ({ success: true }));
      assert.strictEqual(tools.length, 89);
      assert.deepStrictEqual(
        tools.slice(0, MCP_TOOL_CATALOG.length).map(({ name }) => name),
        MCP_TOOL_CATALOG.map(({ name }) => name),
      );
      assert.deepStrictEqual(
        tools.slice(MCP_TOOL_CATALOG.length).map(({ name }) => name),
        MCP_OPERATION_CATALOG.map(({ name }) => name),
      );
      assert.ok(tools.some(({ name }) => name === 'cdt_roles_set_rights'));
    } finally {
      if (previous === undefined) {
        delete process.env.CDT_MCP_LEGACY_TOOLS;
      } else {
        process.env.CDT_MCP_LEGACY_TOOLS = previous;
      }
    }
  });

  test('cdt_catalog lists all operations and serializes all 82 input schemas', async () => {
    const tools = captureRegisteredTools(async () => {
      assert.fail('cdt_catalog must not dispatch Agent commands');
    });
    const catalog = tools.find(({ name }) => name === 'cdt_catalog')!;
    const list = await catalog.handler({}, { signal: signal() });
    const listed = list.structuredContent as unknown as {
      success: boolean;
      data: { operations: Array<{ name: string; profile: string }> };
    };
    assert.strictEqual(listed.success, true);
    assert.deepStrictEqual(
      listed.data.operations.map(({ name, profile }) => ({ name, profile })),
      MCP_OPERATION_CATALOG.map(({ name, profile }) => ({ name, profile })),
    );
    assert.strictEqual(listed.data.operations.length, 82);

    for (const operation of MCP_OPERATION_CATALOG) {
      const result = await catalog.handler({ operation: operation.name }, { signal: signal() });
      const described = result.structuredContent as unknown as {
        success: boolean;
        data?: { operation?: { name: string; inputSchema: Record<string, unknown> } };
      };
      assert.strictEqual(result.isError, undefined, `${operation.name}: serialization`);
      assert.strictEqual(described.success, true, `${operation.name}: catalog result`);
      assert.strictEqual(described.data?.operation?.name, operation.name);
      assert.strictEqual(described.data?.operation?.inputSchema.type, 'object');
      assert.ok(described.data?.operation?.inputSchema.properties, `${operation.name}: JSON Schema properties`);
    }

    const unknown = await catalog.handler({ operation: 'cdt_no_such_operation' }, { signal: signal() });
    assert.strictEqual(unknown.isError, true);
    assert.strictEqual(
      (unknown.structuredContent as unknown as { code: string }).code,
      'MCP_OPERATION_NOT_FOUND',
    );
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
    const cases: ReadonlyArray<readonly [string, string, Record<string, unknown>, string]> = [
      ['cdt_read', 'cdt_list_objects', { type: 'Catalog', query: 'good' }, '1c-metadata-tree.agent.listObjects'],
      ['cdt_write', 'cdt_form_edit', { formPath: 'CommonForms/Editor/Ext/Form.xml', operations: [{ type: 'setElementIdentity', element: { id: '1' }, name: 'Renamed' }], dryRun: true }, '1c-metadata-tree.agent.forms.edit'],
      ['cdt_read', 'cdt_cfe_list_projects', { configurationId: 'cfg' }, '1c-metadata-tree.agent.cfe.listProjects'],
      ['cdt_write_idempotent', 'cdt_cfe_borrow_object', { extensionConfigurationId: 'cfg', sourceDotPath: 'Catalog.Goods' }, '1c-metadata-tree.agent.cfe.borrowObject'],
      ['cdt_write', 'cdt_create_object', { type: 'Catalog', name: 'Goods' }, '1c-metadata-tree.agent.createObject'],
      ['cdt_write_live', 'cdt_debug_stop', { sessionId: 's1' }, '1c-metadata-tree.agent.debug.stop'],
      ['cdt_read_live', 'cdt_forms_status', {}, '1c-metadata-tree.agent.forms.status'],
      ['cdt_write_live', 'cdt_skd_validate', { templatePath: 'template.xml' }, '1c-metadata-tree.agent.skd.validate'],
      ['cdt_read', 'cdt_xdto_compare', { packageName: 'p', source: '<x/>' }, '1c-metadata-tree.agent.xdto.compare'],
      [
        'cdt_write_live',
        'cdt_dump_external_processor',
        {
          srcPath: 'C:/work/Processor.epf',
          format: 'Plain',
          context: { kind: 'standalone', acknowledgeTypeLoss: true },
        },
        '1c-metadata-tree.agent.dumpExternalProcessor',
      ],
      [
        'cdt_write_live',
        'cdt_build_external_processor',
        {
          rootXmlPath: 'C:/work/Report_src/Report.xml',
          context: { kind: 'infobase', infobasePath: 'C:/db' },
        },
        '1c-metadata-tree.agent.buildExternalProcessor',
      ],
    ];
    for (const [toolName, operation, args] of cases) {
      const target = tools.find((candidate) => candidate.name === toolName)!;
      const result = await target.handler({ operation, arguments: args }, { signal: signal() });
      assert.strictEqual(result.isError, undefined, operation);
    }

    assert.deepStrictEqual(calls, cases.map(([, , args, command]) => ({ command, args })));
  });

  test('invalid inner strict arguments fail before Agent dispatch', async () => {
    let dispatched = false;
    const tools = captureRegisteredTools(async () => {
      dispatched = true;
      return { success: true };
    });
    const write = tools.find(({ name }) => name === 'cdt_write')!;
    const result = await write.handler({
      operation: 'cdt_create_object',
      arguments: { type: 'Catalog', name: 'Goods', unexpected: true },
    }, { signal: signal() });

    assert.strictEqual(dispatched, false);
    assert.strictEqual(result.isError, true);
    assert.strictEqual(
      (result.structuredContent as unknown as { code: string }).code,
      'INVALID_ARGUMENTS',
    );
  });

  test('normalizes command exceptions without leaking a stack', async () => {
    const tools = captureRegisteredTools(async () => {
      const error = new Error('secret command failure details');
      error.stack = 'secret stack';
      throw error;
    });
    const result = await tools.find(({ name }) => name === 'cdt_read')!.handler({
      operation: 'cdt_list_configurations', arguments: {},
    }, { signal: signal() });
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
    const result = await tools.find(({ name }) => name === 'cdt_read')!.handler({
      operation: 'cdt_list_configurations', arguments: {},
    }, { signal: signal(true) });
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
    const invocation = tools.find(({ name }) => name === 'cdt_read')!.handler({
      operation: 'cdt_list_configurations', arguments: {},
    }, { signal: controller.signal });
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
