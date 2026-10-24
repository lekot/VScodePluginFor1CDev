import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import '../helpers/vscodeStubRegister';
import type { AgentResult } from '../../src/agent/types';
import { registerMcpTools } from '../../src/agent/mcpAdapter/toolCatalog';
import {
  ConfigurationMutationEngine,
  getConfigurationMutationEngine,
  setConfigurationMutationEngine,
  type MutationOutcomeStatus,
  type MutationReceipt,
  type SingleFileMutationIntent,
  type SingleFileTransform,
} from '../../src/services/configurationSession/ConfigurationMutationEngine';
import type { ResourceLike } from '../../src/services/configurationSession/ConfigurationContextResolver';
import type { ConfigurationContext } from '../../src/services/configurationSession/types';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { registerAgentCommands } from '../helpers/agentCommandRegistration';
import { cleanupTempDir, createTempDir } from '../helpers/testHelpers';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

const CREATE_COMMAND = '1c-metadata-tree.agent.createObject';
const SET_PROPERTIES_COMMAND = '1c-metadata-tree.agent.setProperties';
const EFFECT_WARNING = 'Изменения могли сохраниться; требуется проверка состояния и при необходимости восстановление конфигурации.';

type RegisteredHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type CapturedToolHandler = (
  args: Record<string, unknown>,
  extra: { signal: AbortSignal },
) => Promise<CallToolResult>;

interface MutationFailure {
  readonly status: 'rolledBack' | 'recoveryRequired' | 'inDoubt' | 'conflict';
  readonly code: string;
  readonly effectPossible: boolean;
  readonly message: string;
}

type ControlledOutcome = 'committed' | 'rolledBack' | 'inDoubt';

type AgentResultWithFailure = AgentResult<unknown> & { readonly mutationFailure?: MutationFailure };

function captureRegisteredTools(
  executeCommand: (command: string, args: Record<string, unknown>) => Promise<unknown>,
): Array<{ name: string; handler: CapturedToolHandler }> {
  const captured: Array<{ name: string; handler: CapturedToolHandler }> = [];
  const server = {
    registerTool(name: string, _config: unknown, handler: CapturedToolHandler): void {
      captured.push({ name, handler });
    },
  } as unknown as McpServer;
  registerMcpTools(server, (command, args) => executeCommand(command, args));
  return captured;
}

function createRootMutationEngine(
  status: ControlledOutcome,
  observed: Array<{ status: MutationOutcomeStatus; resourcePath: string; kind: string }>,
): ConfigurationMutationEngine {
  const engine = new ConfigurationMutationEngine();
  const perform = engine.transformFile.bind(engine);
  engine.transformFile = async <T>(
    target: ResourceLike | ConfigurationContext,
    intent: SingleFileMutationIntent,
    transform: SingleFileTransform<T>,
  ): Promise<MutationReceipt<T>> => {
    if (status === 'committed') {
      const receipt = await perform(target, intent, transform);
      observed.push({ status: receipt.status, resourcePath: intent.resourcePath, kind: intent.kind });
      return receipt;
    }

    // Inject the engine's typed receipt directly. In particular, inDoubt here is not a disk-crash simulation.
    observed.push({ status, resourcePath: intent.resourcePath, kind: intent.kind });
    const failures: Record<'rolledBack' | 'inDoubt', { code: string; message: string }> = {
      rolledBack: { code: 'BOUNDARY_WRITE_ROLLED_BACK', message: 'Boundary matrix rollback receipt.' },
      inDoubt: { code: 'BOUNDARY_WRITE_IN_DOUBT', message: 'Boundary matrix in-doubt receipt.' },
    };
    const failure = failures[status];
    return {
      status,
      kind: intent.kind,
      resourcePath: intent.resourcePath,
      code: failure.code,
      message: failure.message,
    } as MutationReceipt<T>;
  };
  return engine;
}

function assertFailure(
  result: AgentResultWithFailure,
  expected: { status: 'rolledBack' | 'inDoubt'; code: string; effectPossible: boolean },
): void {
  assert.strictEqual(result.success, false, 'A noncommitted receipt must never become Agent success.');
  assert.strictEqual(result.code, expected.code);
  assert.ok(result.error);
  assert.ok(result.mutationFailure);
  assert.deepStrictEqual(
    {
      status: result.mutationFailure.status,
      code: result.mutationFailure.code,
      effectPossible: result.mutationFailure.effectPossible,
    },
    expected,
  );
  assert.strictEqual(result.error, result.mutationFailure.message);
  if (expected.effectPossible) {
    assert.strictEqual(result.error.split(EFFECT_WARNING).length - 1, 1);
  } else {
    assert.ok(!result.error.includes(EFFECT_WARNING));
  }
}

suite('Architecture outcome boundary matrix', () => {
  let tempDir: string;
  let registry: import('../../src/services/configurationSession/WorkspaceRegistry').WorkspaceRegistry;
  let originalEngine: ConfigurationMutationEngine;
  let commandSubscriptions: Array<{ dispose(): void }>;

  setup(async () => {
    resetVscodeTestState();
    tempDir = await createTempDir('architecture-outcome-boundary-');
    await fs.promises.writeFile(
      path.join(tempDir, 'Configuration.xml'),
      '<MetaDataObject version="2.20"><Configuration uuid="c1a5f43b-1a92-4469-b2d9-8c19c1cb1b38"><ChildObjects/></Configuration></MetaDataObject>',
      'utf8',
    );
    const { WorkspaceRegistry } = await import('../../src/services/configurationSession/WorkspaceRegistry');
    registry = new WorkspaceRegistry();
    await registry.refresh([{ configPath: tempDir }]);
    originalEngine = getConfigurationMutationEngine();
    commandSubscriptions = [];
    registerAgentCommands(
      { subscriptions: commandSubscriptions } as never,
      () => null,
      async () => registry,
      new DebugSessionRegistry(),
    );
  });

  teardown(async () => {
    for (const subscription of commandSubscriptions) {
      subscription.dispose();
    }
    setConfigurationMutationEngine(originalEngine);
    await registry.dispose();
    await cleanupTempDir(tempDir);
    resetVscodeTestState();
  });

  test('committed, rolledBack and inDoubt receipts retain their boundary semantics through Agent and MCP handlers', async () => {
    const configurationId = registry.list()[0]!.configurationId;
    const handlerFor = (command: string): RegisteredHandler => {
      const handler = vscodeTestState.registeredCommandHandlers.get(command);
      assert.ok(handler, `Expected production Agent command registration for ${command}`);
      return handler as RegisteredHandler;
    };
    const create = handlerFor(CREATE_COMMAND);
    const created = await create({ configurationId, type: 'Catalog', name: 'BoundaryCatalog' }) as AgentResult;
    assert.strictEqual(created.success, true, created.error);
    const objectPath = path.join(tempDir, 'Catalogs', 'BoundaryCatalog.xml');

    const tools = captureRegisteredTools(async (command, args) => {
      const handler = handlerFor(command);
      return await handler(args);
    });
    const writer = tools.find((tool) => tool.name === 'cdt_write');
    assert.ok(writer, 'Production MCP write tool must be registered');

    const cases: ReadonlyArray<{
      readonly status: ControlledOutcome;
      readonly via: 'agent' | 'mcp';
      readonly synonym: string;
    }> = [
      { status: 'committed', via: 'agent', synonym: 'Committed through Agent' },
      { status: 'committed', via: 'mcp', synonym: 'Committed through MCP' },
      { status: 'rolledBack', via: 'agent', synonym: 'Must not persist after rollback' },
      { status: 'rolledBack', via: 'mcp', synonym: 'Must not persist after MCP rollback' },
      { status: 'inDoubt', via: 'agent', synonym: 'Must not claim success while in doubt' },
      { status: 'inDoubt', via: 'mcp', synonym: 'Must not claim MCP success while in doubt' },
    ];

    for (const item of cases) {
      const observed: Array<{ status: MutationOutcomeStatus; resourcePath: string; kind: string }> = [];
      setConfigurationMutationEngine(createRootMutationEngine(item.status, observed));
      const args = {
        configurationId,
        path: 'Catalog.BoundaryCatalog',
        properties: { Synonym: item.synonym },
      };
      const objectBefore = await fs.promises.readFile(objectPath, 'utf8');

      let result: AgentResultWithFailure;
      if (item.via === 'agent') {
        result = await handlerFor(SET_PROPERTIES_COMMAND)(args) as AgentResultWithFailure;
      } else {
        const response = await writer.handler({
          operation: 'cdt_set_properties',
          arguments: args,
        }, { signal: new AbortController().signal });
        assert.strictEqual(response.isError, item.status === 'committed' ? undefined : true);
        assert.strictEqual(response.content[0]?.type, 'text');
        const json = JSON.parse(response.content[0].type === 'text' ? response.content[0].text : '{}') as AgentResultWithFailure;
        const structured = response.structuredContent as unknown as AgentResultWithFailure;
        assert.deepStrictEqual(json, structured, 'MCP text and structuredContent must project the same Agent receipt.');
        result = structured;
      }

      assert.strictEqual(observed.length, 1, 'Each Agent boundary action must call the configured mutation engine once.');
      assert.strictEqual(observed[0]!.status, item.status);
      assert.strictEqual(
        await fs.promises.realpath(observed[0]!.resourcePath),
        await fs.promises.realpath(objectPath),
      );
      assert.strictEqual(observed[0]!.kind, 'properties.save');

      if (item.status === 'committed') {
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.mutationFailure, undefined);
        assert.ok(result.operationId);
        assert.ok(typeof result.snapshotVersion === 'number');
        assert.ok((await fs.promises.readFile(objectPath, 'utf8')).includes(item.synonym));
      } else {
        const expected = item.status === 'rolledBack'
          ? { status: 'rolledBack' as const, code: 'BOUNDARY_WRITE_ROLLED_BACK', effectPossible: false }
          : { status: 'inDoubt' as const, code: 'BOUNDARY_WRITE_IN_DOUBT', effectPossible: true };
        assertFailure(result, expected);
        if (item.status === 'rolledBack') {
          assert.strictEqual(await fs.promises.readFile(objectPath, 'utf8'), objectBefore);
        }
      }
    }

  });
});
