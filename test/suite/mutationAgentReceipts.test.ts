import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AgentOperations } from '../../src/agent/agentOperations';
import { registerMcpTools } from '../../src/agent/mcpAdapter/toolCatalog';
import type { AgentResult, CreateObjectParams } from '../../src/agent/types';
import {
  ConfigurationMutationEngine,
  getConfigurationMutationEngine,
  setConfigurationMutationEngine,
  type MutationOutcomeStatus,
  type MutationReceipt,
  type SingleFileMutationIntent,
  type SingleFileTransform,
} from '../../src/services/configurationSession/ConfigurationMutationEngine';
import {
  MutationReceiptError,
  projectMutationFailure,
  type MutationFailureProjection,
} from '../../src/services/configurationSession/mutationReceiptError';
import {
  MutationPlanError,
  MutationPlanExecutor,
  type MutationPlan,
} from '../../src/services/configurationSession/mutationPlan';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';
import { installMutationPlanPublicationInterception } from '../helpers/mutationPlanPublicationInterception';
import { XMLWriter, XmlReadError, XmlWriteError } from '../../src/utils/XMLWriter';
import { xmlBuilder } from '../../src/utils/xml/xmlCore';

const MINIMAL_CONFIG_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<MetaDataObject version="2.20" xmlns="http://v8.1c.ru/8.3/MDClasses">',
  '  <Configuration uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee">',
  '    <Properties><Name>TestConfig</Name></Properties>',
  '    <ChildObjects/>',
  '  </Configuration>',
  '</MetaDataObject>',
].join('\n');

const EFFECT_WARNING =
  'Изменения могли сохраниться; требуется проверка состояния и при необходимости восстановление конфигурации.';

type AgentResultWithMutationFailure = AgentResult<unknown> & {
  mutationFailure?: MutationFailureProjection;
};

type CapturedToolHandler = (
  args: Record<string, unknown>,
  extra: { signal: AbortSignal },
) => Promise<CallToolResult>;

function createReceipt(
  status: MutationOutcomeStatus,
  target: string,
  code: string,
  message: string,
): MutationReceipt<unknown> {
  return { status, kind: 'test.receipt', resourcePath: target, code, message };
}

function addCause(error: Error, cause: Error): void {
  Object.defineProperty(error, 'cause', { configurable: true, value: cause, writable: true });
}

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

function assertMutationFailure(
  result: AgentResult<unknown>,
  expected: {
    status: MutationFailureProjection['status'];
    code: string;
    effectPossible: boolean;
  },
): void {
  const agentResult = result as AgentResultWithMutationFailure;
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, expected.code);
  assert.ok(agentResult.mutationFailure, 'Agent result must retain the mutation projection');
  assert.deepStrictEqual(agentResult.mutationFailure, {
    status: expected.status,
    code: expected.code,
    effectPossible: expected.effectPossible,
    message: agentResult.mutationFailure.message,
  });
  assert.strictEqual(result.error, agentResult.mutationFailure.message);
  if (expected.effectPossible) {
    assert.strictEqual(agentResult.mutationFailure.message.split(EFFECT_WARNING).length - 1, 1);
  } else {
    assert.ok(!agentResult.mutationFailure.message.includes(EFFECT_WARNING));
  }
}

async function withConfigurationCommitFailure<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const rootIdentity = await fs.promises.realpath(root);
  const promiseFs = fs.promises as unknown as {
    rename: (source: string, destination: string) => Promise<void>;
  };
  const originalRename = promiseFs.rename;
  let injected = false;
  promiseFs.rename = async (source, destination) => {
    const destinationParent = await fs.promises.realpath(path.dirname(String(destination))).catch(() => '');
    if (
      !injected &&
      path.basename(String(destination)).toLowerCase() === 'configuration.xml' &&
      destinationParent.toLowerCase() === rootIdentity.toLowerCase()
    ) {
      injected = true;
      throw new Error('Simulated Configuration.xml atomic commit failure');
    }
    return originalRename.call(fs.promises, source, destination);
  };
  try {
    const result = await action();
    assert.strictEqual(injected, true, 'The Configuration.xml fault must be injected');
    return result;
  } finally {
    promiseFs.rename = originalRename;
  }
}

suite('Mutation receipts through XMLWriter, Agent CRUD and MCP (#296)', () => {
  let tempDir: string;
  let originalEngine: ConfigurationMutationEngine;

  setup(async () => {
    tempDir = await createTempDir('mutation-agent-receipts-');
    fs.writeFileSync(path.join(tempDir, 'Configuration.xml'), MINIMAL_CONFIG_XML, 'utf8');
    originalEngine = getConfigurationMutationEngine();
  });

  teardown(async () => {
    setConfigurationMutationEngine(originalEngine);
    await cleanupTempDir(tempDir);
  });

  test('MutationPlanError codes project to typed outcomes through wrappers and cyclic causes', () => {
    const cases: ReadonlyArray<{
      code: ConstructorParameters<typeof MutationPlanError>[0];
      status: MutationFailureProjection['status'];
      effectPossible: boolean;
    }> = [
      { code: 'PLAN_CONFLICT', status: 'conflict', effectPossible: false },
      { code: 'PLAN_FAILED', status: 'rolledBack', effectPossible: false },
      { code: 'RECOVERY_REQUIRED', status: 'recoveryRequired', effectPossible: true },
    ];

    for (const item of cases) {
      const planError = new MutationPlanError(item.code, 'plan ' + item.code);
      const outerError = new XmlWriteError('XML writer context: ' + planError.message);
      addCause(outerError, planError);

      const projection = projectMutationFailure(outerError);
      assert.ok(projection, item.code + ' must project through an Error cause');
      assert.strictEqual(projection.status, item.status);
      assert.strictEqual(projection.code, item.code);
      assert.strictEqual(projection.effectPossible, item.effectPossible);
      assert.ok(projection.message.startsWith('XML writer context:'));
      assert.strictEqual(Object.prototype.hasOwnProperty.call(projection, 'receipt'), false);
      if (item.effectPossible) {
        assert.strictEqual(projection.message.split(EFFECT_WARNING).length - 1, 1);
      } else {
        assert.ok(!projection.message.includes(EFFECT_WARNING));
      }
    }

    const ordinary = new Error('ordinary serializer failure') as Error & { code?: string };
    ordinary.code = 'RECOVERY_REQUIRED';
    const ordinaryWrapper = new XmlWriteError('ordinary wrapper');
    addCause(ordinaryWrapper, ordinary);
    assert.strictEqual(projectMutationFailure(ordinaryWrapper), undefined);

    const cycleA = new Error('cause A');
    const cycleB = new Error('cause B');
    addCause(cycleA, cycleB);
    addCause(cycleB, cycleA);
    assert.strictEqual(projectMutationFailure(cycleA), undefined);

    const receiptError = new MutationReceiptError(
      (createReceipt('recoveryRequired', path.join(tempDir, 'x.xml'), 'RESTORE_REQUIRED', 'receipt detail') as ConstructorParameters<typeof MutationReceiptError>[0]),
      'inner mutation context',
    );
    const cyclicWrapper = new XmlWriteError('outer XML context: ' + receiptError.message);
    addCause(cyclicWrapper, receiptError);
    addCause(receiptError, cyclicWrapper);

    const cyclicProjection = projectMutationFailure(cyclicWrapper);
    assert.ok(cyclicProjection, 'Cause traversal must find a typed mutation error before stopping at a cycle');
    assert.strictEqual(cyclicProjection.status, 'recoveryRequired');
    assert.strictEqual(cyclicProjection.code, 'RESTORE_REQUIRED');
    assert.strictEqual(cyclicProjection.message, cyclicWrapper.message);
    assert.strictEqual(cyclicProjection.message.split(EFFECT_WARNING).length - 1, 1);
  });

  test('XMLWriter keeps legacy error classes and messages while exposing every noncommitted receipt', async () => {
    const target = path.join(tempDir, 'Catalogs', 'Goods.xml');
    const cases: ReadonlyArray<{
      status: Exclude<MutationOutcomeStatus, 'committed'>;
      code: string;
      message: string;
      legacyPrefix?: string;
      effectPossible: boolean;
    }> = [
      {
        status: 'conflict',
        code: 'STALE_TARGET_REVISION',
        message: 'stale revision',
        legacyPrefix: 'Concurrent modification detected: ' + target + '.',
        effectPossible: false,
      },
      {
        status: 'rolledBack',
        code: 'WRITE_FAILED',
        message: 'write failed',
        legacyPrefix: 'Unable to write to file. Check file permissions and disk space.',
        effectPossible: false,
      },
      {
        status: 'recoveryRequired',
        code: 'RESTORE_REQUIRED',
        message: 'rollback incomplete',
        effectPossible: true,
      },
      {
        status: 'inDoubt',
        code: 'OUTCOME_UNKNOWN',
        message: 'result unconfirmed',
        effectPossible: true,
      },
    ];

    for (const item of cases) {
      const engine = new ConfigurationMutationEngine();
      const receipt = createReceipt(item.status, target, item.code, item.message);
      engine.transformFile = async <T>(
        _filePath: string,
        _intent: SingleFileMutationIntent,
        _transform: SingleFileTransform<T>,
      ): Promise<MutationReceipt<T>> => receipt as MutationReceipt<T>;
      setConfigurationMutationEngine(engine);

      let captured: XmlWriteError | undefined;
      await assert.rejects(
        XMLWriter.writeProperties(target, { Comment: 'updated' }),
        (error: unknown) => {
          assert.ok(error instanceof XmlWriteError);
          captured = error;
          return true;
        },
      );

      assert.ok(captured);
      assert.strictEqual(captured.name, 'XmlWriteError');
      if (item.legacyPrefix) {
        assert.ok(captured.message.startsWith(item.legacyPrefix));
      }
      const cause = (captured as XmlWriteError & { cause?: unknown }).cause;
      assert.ok(cause instanceof MutationReceiptError, 'XMLWriter must keep the typed receipt as its cause');
      assert.strictEqual(cause.status, item.status);
      assert.strictEqual(cause.code, item.code);

      const projection = projectMutationFailure(captured);
      assert.ok(projection);
      assert.strictEqual(projection.status, item.status);
      assert.strictEqual(projection.code, item.code);
      assert.strictEqual(projection.effectPossible, item.effectPossible);
      assert.strictEqual(projection.message, captured.message);
      assert.strictEqual(projection.message.split(EFFECT_WARNING).length - 1, item.effectPossible ? 1 : 0);
    }

    const fallbackEngine = new ConfigurationMutationEngine();
    fallbackEngine.transformFile = async <T>(
      _filePath: string,
      _intent: SingleFileMutationIntent,
      _transform: SingleFileTransform<T>,
    ): Promise<MutationReceipt<T>> => ({
      ...createReceipt('rolledBack', target, 'WRITE_FAILED', 'unused detail'),
      message: undefined,
    } as MutationReceipt<T>);
    setConfigurationMutationEngine(fallbackEngine);
    await assert.rejects(
      XMLWriter.writeProperties(target, { Comment: 'updated' }),
      (error: unknown) => {
        assert.ok(error instanceof XmlWriteError);
        assert.ok(error.message.includes("Mutation failed with status 'rolledBack'."));
        return true;
      },
    );
  });

  test('generic XML read and serializer failures retain their legacy errors without a mutation outcome', async () => {
    const missingFile = path.join(tempDir, 'missing.xml');
    await assert.rejects(
      XMLWriter.readProperties(missingFile),
      (error: unknown) => {
        assert.ok(error instanceof XmlReadError);
        assert.strictEqual(projectMutationFailure(error), undefined);
        return true;
      },
    );

    let serializerError: unknown;
    const builder = xmlBuilder as unknown as { build: (data: unknown) => string };
    const originalBuild = builder.build;
    try {
      builder.build = () => { throw new Error('Simulated generic XML serializer failure'); };
      XMLWriter.buildUpdatedPropertiesXml(
        '<Configuration><Properties><Name>Config</Name></Properties></Configuration>',
        { Name: 'UpdatedConfig' },
      );
    } catch (error) {
      serializerError = error;
    } finally {
      builder.build = originalBuild;
    }
    assert.ok(serializerError instanceof Error, 'The serializer fault must be observed');
    assert.strictEqual(serializerError.message, 'Simulated generic XML serializer failure');
    assert.strictEqual(projectMutationFailure(serializerError), undefined);
  });

  test('XMLWriter retains typed engine failures through its legacy write wrapper', async () => {
    const target = path.join(tempDir, 'Configuration.xml');
    const engine = new ConfigurationMutationEngine();
    const planFailure = new MutationPlanError('RECOVERY_REQUIRED', 'engine recovery detail');
    engine.transformFile = async () => { throw planFailure; };
    setConfigurationMutationEngine(engine);

    await assert.rejects(
      XMLWriter.writeProperties(target, { Comment: 'updated' }),
      (error: unknown) => {
        assert.ok(error instanceof XmlWriteError);
        assert.strictEqual(error.name, 'XmlWriteError');
        assert.match(error.message, /^Unable to write file:/);
        assert.match(error.message, /engine recovery detail/);
        assert.strictEqual((error as XmlWriteError & { cause?: unknown }).cause, planFailure);
        const projection = projectMutationFailure(error);
        assert.ok(projection);
        assert.strictEqual(projection.status, 'recoveryRequired');
        assert.strictEqual(projection.code, 'RECOVERY_REQUIRED');
        assert.strictEqual(projection.message.split(EFFECT_WARNING).length - 1, 1);
        return true;
      },
    );
  });

  test('real Agent create/delete/rename/duplicate preserve plan failures and stale CAS stays untyped', async () => {
    const operations = new AgentOperations(tempDir);
    const stale = await operations.createObject({
      type: 'Catalog',
      name: 'StaleCreate',
      ifRev: 'f'.repeat(64),
    });
    assert.strictEqual(stale.success, false);
    assert.strictEqual(stale.code, 'CONCURRENT_MODIFICATION_ERROR');
    assert.strictEqual(
      (stale as AgentResultWithMutationFailure).mutationFailure,
      undefined,
      'A stale Agent ifRev rejection has no MutationPlanError and must not invent an outcome',
    );

    const configurationPath = path.join(tempDir, 'Configuration.xml');
    const executorPrototype = MutationPlanExecutor.prototype as unknown as {
      execute<T>(plan: MutationPlan<T>, operationId?: string): Promise<T>;
    };
    const originalExecute = executorPrototype.execute;
    executorPrototype.execute = async function<T>(
      this: MutationPlanExecutor,
      plan: MutationPlan<T>,
      operationId?: string,
    ): Promise<T> {
      await fs.promises.appendFile(configurationPath, '\n<!-- external concurrent edit -->', 'utf8');
      return await originalExecute.call(this, plan, operationId) as T;
    };

    const tools = captureRegisteredTools(async (command, args) => {
      assert.strictEqual(command, '1c-metadata-tree.agent.createObject');
      return operations.createObject(args as unknown as CreateObjectParams);
    });
    try {
      const writer = tools.find((tool) => tool.name === 'cdt_write');
      assert.ok(writer);
      const result = await writer.handler({
        operation: 'cdt_create_object',
        arguments: { type: 'Catalog', name: 'PlanConflict', ifRev: '0'.repeat(64) },
      }, { signal: new AbortController().signal });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.content[0]?.type, 'text');
      const json = JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}') as AgentResultWithMutationFailure;
      const structured = result.structuredContent as unknown as AgentResultWithMutationFailure;
      assert.deepStrictEqual(json, structured);
      assertMutationFailure(json, { status: 'conflict', code: 'PLAN_CONFLICT', effectPossible: false });
    } finally {
      executorPrototype.execute = originalExecute;
    }

    const base = await operations.createObject({ type: 'Catalog', name: 'Goods' });
    assert.strictEqual(base.success, true, base.error);

    const createFailure = await withConfigurationCommitFailure(
      tempDir,
      () => operations.createObject({ type: 'Catalog', name: 'RollbackCreate' }),
    );
    assertMutationFailure(createFailure, { status: 'rolledBack', code: 'PLAN_FAILED', effectPossible: false });
    assert.strictEqual(fs.existsSync(path.join(tempDir, 'Catalogs', 'RollbackCreate.xml')), false);

    const deleteFailure = await withConfigurationCommitFailure(
      tempDir,
      () => operations.deleteObject({ path: 'Catalog.Goods' }),
    );
    assertMutationFailure(deleteFailure, { status: 'rolledBack', code: 'PLAN_FAILED', effectPossible: false });
    assert.strictEqual(fs.existsSync(path.join(tempDir, 'Catalogs', 'Goods.xml')), true);

    const renameFailure = await withConfigurationCommitFailure(
      tempDir,
      () => operations.renameObject({ path: 'Catalog.Goods', newName: 'GoodsRenamed' }),
    );
    assertMutationFailure(renameFailure, { status: 'rolledBack', code: 'PLAN_FAILED', effectPossible: false });
    assert.strictEqual(fs.existsSync(path.join(tempDir, 'Catalogs', 'Goods.xml')), true);
    assert.strictEqual(fs.existsSync(path.join(tempDir, 'Catalogs', 'GoodsRenamed.xml')), false);

    const duplicateFailure = await withConfigurationCommitFailure(
      tempDir,
      () => operations.duplicateObject({ path: 'Catalog.Goods', newName: 'GoodsCopy' }),
    );
    assertMutationFailure(duplicateFailure, { status: 'rolledBack', code: 'PLAN_FAILED', effectPossible: false });
    assert.strictEqual(fs.existsSync(path.join(tempDir, 'Catalogs', 'GoodsCopy.xml')), false);
  });

  test('real Agent create keeps an external write on recoveryRequired and warns exactly once', async () => {
    const operations = new AgentOperations(tempDir);
    const externalDirectory = path.join(tempDir, 'Catalogs');
    const externalTarget = path.join(externalDirectory, 'ExternalCatalog.xml');
    const externalFilePath = path.join(externalDirectory, 'external.txt');
    const externalContent = '<External>preserve this write</External>';
    const executorPrototype = MutationPlanExecutor.prototype as unknown as {
      execute<T>(plan: MutationPlan<T>, operationId?: string): Promise<T>;
    };
    const originalExecute = executorPrototype.execute;
    let externalWriteCompleted = false;
    let configCommitFailed = false;
    let rawPlanFailure: unknown;

    executorPrototype.execute = async function<T>(
      this: MutationPlanExecutor,
      plan: MutationPlan<T>,
      operationId?: string,
    ): Promise<T> {
      try {
        return await originalExecute.call(this, plan, operationId) as T;
      } catch (error) {
        rawPlanFailure = error;
        throw error;
      }
    };

    const publication = installMutationPlanPublicationInterception([
      {
        targetPath: externalTarget,
        after: async () => {
          externalWriteCompleted = true;
          await fs.promises.writeFile(externalFilePath, externalContent, 'utf8');
        },
      },
      {
        targetPath: path.join(tempDir, 'Configuration.xml'),
        before: async () => {
          configCommitFailed = true;
          throw new Error('Simulated late configuration commit failure');
        },
      },
    ]);

    let result: AgentResult<unknown> | undefined;
    try {
      result = await operations.createObject({ type: 'Catalog', name: 'ExternalCatalog' });
    } finally {
      publication.restore();
      executorPrototype.execute = originalExecute;
    }

    assert.strictEqual(externalWriteCompleted, true, 'The external mutation hook must run');
    assert.strictEqual(configCommitFailed, true, 'The Configuration.xml fault must be injected');
    assert.ok(rawPlanFailure instanceof MutationPlanError, 'The real executor must report a typed plan failure');
    assert.strictEqual(rawPlanFailure.code, 'RECOVERY_REQUIRED');
    assert.ok(result);
    assertMutationFailure(result, {
      status: 'recoveryRequired',
      code: 'RECOVERY_REQUIRED',
      effectPossible: true,
    });
    assert.strictEqual(await fs.promises.readFile(externalFilePath, 'utf8'), externalContent);
  });
});
