import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import '../helpers/vscodeStubRegister';
import type * as vscode from 'vscode';
import { AgentRepositoryOperations } from '../../src/agent/agentRepositoryOperations';
import { AgentTaskManager } from '../../src/agent/agentTaskManager';
import type { AgentTaskReceipt } from '../../src/agent/agentTaskManager';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { resolveRepositoryTarget } from '../../src/services/configurationRepository/repositoryObjectResolver';
import type { ConfigurationRepositoryService } from '../../src/services/configurationRepository/configurationRepositoryService';
import type { RepositoryServiceResult, RepositoryTarget } from '../../src/services/configurationRepository/types';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';

interface RepositoryHarness {
  readonly operations: AgentRepositoryOperations;
  readonly registry: WorkspaceRegistry;
  readonly ids: Readonly<Record<'A' | 'B' | 'C', string>>;
  readonly calls: Array<{ operation: string; target: RepositoryTarget; node?: TreeNode; token: vscode.CancellationToken; comment?: string }>;
  readonly taskManager: AgentTaskManager;
  setOutcome(outcome: RepositoryServiceResult): void;
  setConnectError(error?: Error): void;
  dispose(): Promise<void>;
}

function serviceResult(status: RepositoryServiceResult['status']): RepositoryServiceResult {
  return {
    status,
    message: `service ${status}`,
    target: { configRoot: 'C:/placeholder', configKind: 'cf', key: 'cf:C:/placeholder' },
    affectedFullNames: ['Справочник.Goods'],
    synchronizedFiles: ['Catalogs/Goods.xml'],
  };
}

async function createHarness(): Promise<RepositoryHarness> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cdt-agent-repository-'));
  const configPaths = {
    A: path.join(temp, 'Config-A'),
    B: path.join(temp, 'Config-B'),
    C: path.join(temp, 'ConfigurationExtensions', 'Feature'),
  };
  for (const [name, configPath] of Object.entries(configPaths)) {
    await fs.mkdir(configPath, { recursive: true });
    await fs.writeFile(path.join(configPath, 'Configuration.xml'), `<Configuration uuid="${name}-uuid"/>`, 'utf8');
  }

  const registry = new WorkspaceRegistry();
  await registry.refresh([
    { configPath: configPaths.A, format: ConfigFormat.Designer },
    { configPath: configPaths.B, format: ConfigFormat.Designer },
    { configPath: configPaths.C, format: ConfigFormat.Designer },
  ]);
  const descriptors = registry.list();
  const ids = {
    A: descriptors.find((entry) => entry.label === 'Config-A')!.configurationId,
    B: descriptors.find((entry) => entry.label === 'Config-B')!.configurationId,
    C: descriptors.find((entry) => entry.label === 'Feature')!.configurationId,
  };
  const roots = new Map<string, TreeNode>();
  const targets = new Map<string, RepositoryTarget>();
  for (const name of ['A', 'B', 'C'] as const) {
    const identity = registry.require(ids[name]).identity;
    const object: TreeNode = {
      id: `catalog:${name}:Goods`, name: 'Goods', type: MetadataType.Catalog, properties: {},
    };
    const folder: TreeNode = {
      id: 'Catalogs', name: 'Справочники', type: MetadataType.Configuration, properties: {}, children: [object],
    };
    const root: TreeNode = {
      id: `root:${name}`,
      name: `Config-${name}`,
      type: name === 'C' ? MetadataType.Extension : MetadataType.Configuration,
      properties: name === 'C' ? { isExtension: true } : {},
      filePath: path.join(identity.rootPath, 'Configuration.xml'),
      children: [folder],
    };
    object.parent = folder;
    folder.parent = root;
    const target = resolveRepositoryTarget(root)!;
    roots.set(name, root);
    targets.set(root.id, target);
  }

  let nextOutcome = serviceResult('acknowledged');
  let connectError: Error | undefined;
  const calls: RepositoryHarness['calls'] = [];
  const serviceStub = {
    targetForNode: (node: TreeNode) => resolveRepositoryTarget(node),
    objectForNode: (node: TreeNode, target: RepositoryTarget) => node.type === MetadataType.Catalog
      ? { target, ownerNode: node, repositoryFullName: `Справочник.${node.name}`, ibcmdFullName: `Catalog.${node.name}`, relativeFiles: [] }
      : undefined,
    getBinding: async () => ({ repositoryPath: 'C:/repo', repositoryUser: 'operator', executionInfobaseId: 'ib-main' }),
    getObservedState: async () => ({ connection: 'connected', locks: {}, source: 'configuratorAcknowledgement' }),
    commit: async (node: TreeNode, token: vscode.CancellationToken, options: { comment: string }) => {
      const target = targets.get(node.parent?.parent?.id ?? '')!;
      calls.push({ operation: 'commit', target, node, token, comment: options.comment });
      return { ...nextOutcome, target };
    },
    connect: async (target: RepositoryTarget, _infobase: unknown, binding: { repositoryPassword?: string }, token: vscode.CancellationToken) => {
      calls.push({ operation: 'connect', target, token });
      assert.strictEqual(binding.repositoryPassword, 'top-secret-repository-password');
      if (connectError) { throw connectError; }
      return { ...nextOutcome, target };
    },
  } as unknown as ConfigurationRepositoryService;
  const tree = {
    getRootNodes: () => [...roots.values()],
    getChildren: async (node: TreeNode) => node.children ?? [],
  };
  const taskManager = new AgentTaskManager();
  const operations = new AgentRepositoryOperations({
    getService: () => serviceStub,
    getTreeProvider: () => tree as never,
    getConfigurationRegistry: async () => registry,
    infobaseStorage: {
      getById: async (id: string) => id === 'ib-main' ? { id, type: 'file', name: 'Main', path: 'C:/db' } : undefined,
    } as never,
    taskManager,
  });
  return {
    operations,
    registry,
    ids,
    calls,
    taskManager,
    setOutcome: (outcome) => { nextOutcome = outcome; },
    setConnectError: (error) => { connectError = error; },
    async dispose() {
      taskManager.dispose();
      await registry.dispose();
      await fs.rm(temp, { recursive: true, force: true });
    },
  };
}

const neverCancelled: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

async function settleTasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

suite('AgentRepositoryOperations', () => {
  test('resolves the exact configuration and lazily finds its exact root object without UI selection', async () => {
    const harness = await createHarness();
    try {
      const result = await harness.operations.commit({
        configurationId: harness.ids.B,
        path: 'Catalog.Goods',
        comment: '  Release  ',
        background: false,
      }, neverCancelled);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data?.status, 'acknowledged');
      assert.strictEqual(harness.calls.length, 1);
      assert.strictEqual(harness.calls[0]!.target.configRoot, harness.registry.require(harness.ids.B).identity.rootPath);
      assert.strictEqual(harness.calls[0]!.node?.id, 'catalog:B:Goods');
      assert.strictEqual(harness.calls[0]!.comment, 'Release');
      assert.strictEqual(harness.calls[0]!.token, neverCancelled);
    } finally {
      await harness.dispose();
    }
  });

  test('resolves a CFE repository root and preserves its extension target identity', async () => {
    const harness = await createHarness();
    try {
      const result = await harness.operations.commit({
        configurationId: harness.ids.C,
        path: 'Catalog.Goods',
        comment: 'Extension change',
        background: false,
      }, neverCancelled);
      assert.strictEqual(result.success, true);
      assert.strictEqual(harness.calls[0]!.target.configKind, 'cfe');
      assert.strictEqual(harness.calls[0]!.target.extensionName, 'Feature');
      assert.strictEqual(
        harness.calls[0]!.target.configRoot,
        harness.registry.require(harness.ids.C).identity.rootPath,
      );
    } finally {
      await harness.dispose();
    }
  });

  test('preserves each service outcome and only acknowledges acknowledged', async () => {
    const harness = await createHarness();
    try {
      for (const status of ['acknowledged', 'failed', 'inDoubt', 'cancelled'] as const) {
        harness.setOutcome(serviceResult(status));
        const result = await harness.operations.commit({
          configurationId: harness.ids.A,
          path: 'Catalog.Goods',
          comment: 'Release',
          background: false,
        }, neverCancelled);
        assert.strictEqual(result.success, status === 'acknowledged', status);
        assert.strictEqual(result.data?.status, status, status);
        assert.deepStrictEqual(result.data?.affectedFullNames, ['Справочник.Goods']);
      }
    } finally {
      await harness.dispose();
    }
  });

  test('rejects a blank commit comment before registry, tree, queue, or service access', async () => {
    let resolvedRegistry = false;
    const taskManager = new AgentTaskManager();
    const operations = new AgentRepositoryOperations({
      getService: () => { throw new Error('service must not be used'); },
      getTreeProvider: () => { throw new Error('tree must not be used'); },
      getConfigurationRegistry: async () => { resolvedRegistry = true; throw new Error('registry must not be used'); },
      infobaseStorage: null,
      taskManager,
    });
    try {
      const result = await operations.commit({ configurationId: 'missing', path: 'Catalog.Goods', comment: ' \t ' });
      assert.strictEqual(result.code, 'INVALID_ARGUMENTS');
      assert.strictEqual(resolvedRegistry, false);
    } finally {
      taskManager.dispose();
    }
  });

  test('defaults repository mutations to background and never exposes the connection password in task data', async () => {
    const harness = await createHarness();
    try {
      harness.setOutcome(serviceResult('acknowledged'));
      const started = await harness.operations.connect({
        configurationId: harness.ids.A,
        executionInfobaseId: 'ib-main',
        repositoryPath: 'C:/repo',
        repositoryUser: 'operator',
        repositoryPassword: 'top-secret-repository-password',
      });
      assert.strictEqual(started.success, true);
      assert.strictEqual(started.data?.status, 'working');
      const taskId = started.data!.taskId;
      await settleTasks();
      const taskResult = harness.taskManager.result(taskId);
      assert.strictEqual(taskResult.data?.status, 'completed');
      assert.ok(!JSON.stringify(taskResult).includes('top-secret-repository-password'));
      assert.strictEqual(harness.calls[0]?.operation, 'connect');

      const observed = await harness.operations.getStatus({ configurationId: harness.ids.A });
      assert.strictEqual(observed.data?.live, false);
      assert.ok(!JSON.stringify(observed).includes('top-secret-repository-password'));
    } finally {
      await harness.dispose();
    }
  });

  test('redacts a bare repository password from connect exceptions and typed result messages', async () => {
    const harness = await createHarness();
    const password = 'top-secret-repository-password';
    try {
      harness.setConnectError(new Error(password));
      const rejected = await harness.operations.connect({
        configurationId: harness.ids.A,
        executionInfobaseId: 'ib-main',
        repositoryPath: 'C:/repo',
        repositoryUser: 'operator',
        repositoryPassword: password,
      });
      assert.strictEqual(rejected.success, true);
      assert.ok(rejected.data && 'taskId' in rejected.data);
      const rejectedTaskId = (rejected.data as AgentTaskReceipt).taskId;
      await settleTasks();
      const rejectedTask = harness.taskManager.result(rejectedTaskId);
      assert.strictEqual(rejectedTask.data?.result?.error, '<redacted>');
      assert.ok(!JSON.stringify(rejectedTask).includes(password));

      harness.setConnectError(undefined);
      harness.setOutcome({
        ...serviceResult('failed'),
        message: `Repository rejected ${password}`,
      });
      const failed = await harness.operations.connect({
        configurationId: harness.ids.A,
        executionInfobaseId: 'ib-main',
        repositoryPath: 'C:/repo',
        repositoryUser: 'operator',
        repositoryPassword: password,
      });
      assert.ok(failed.data && 'taskId' in failed.data);
      const failedTaskId = (failed.data as AgentTaskReceipt).taskId;
      await settleTasks();
      const failedTask = harness.taskManager.result(failedTaskId);
      const failedOutcome = failedTask.data?.result?.data as RepositoryServiceResult | undefined;
      assert.strictEqual(failedOutcome?.status, 'failed');
      assert.strictEqual(failedOutcome?.message, 'Repository rejected <redacted>');
      assert.deepStrictEqual(failedOutcome?.affectedFullNames, ['Справочник.Goods']);
      assert.ok(!JSON.stringify(failedTask).includes(password));
    } finally {
      await harness.dispose();
    }
  });
});
