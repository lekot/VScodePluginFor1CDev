import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import '../helpers/vscodeStubRegister';
import {
  DeployApplicationService,
  type DeployApplicationServiceDeps,
  type DeployOutcome,
} from '../../src/bindings/deployApplicationService';
import { DeployService, type DeployRunSummary } from '../../src/bindings/deployService';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { AgentDeployOperations } from '../../src/agent/agentDeployOperations';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import type { GitRepository, IncrementalChangeDetectorDeps } from '../../src/services/ibcmd/incrementalChangeDetector';

suite('DeployApplicationService (#255)', () => {
  let tempDir: string;
  let configDir: string;
  let configXmlPath: string;
  let workspaceFolder: vscode.WorkspaceFolder;
  let mockBinding: ConfigurationBinding;
  let mockCatalog: InfobaseEntry[];
  let mockStorage: any;
  let mockBindingManager: any;

  setup(() => {
    resetVscodeTestState();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-deploy-app-test-'));
    configDir = path.join(tempDir, 'src', 'Configuration');
    fs.mkdirSync(configDir, { recursive: true });
    configXmlPath = path.join(configDir, 'Configuration.xml');
    fs.writeFileSync(configXmlPath, '<Configuration/>', 'utf8');

    workspaceFolder = {
      uri: vscode.Uri.file(tempDir),
      name: 'test-ws',
      index: 0,
    };
    vscodeTestState.mockWorkspaceFolders = [workspaceFolder];

    mockBinding = {
      workspaceFolder: 'test-ws',
      configRelativePath: 'src/Configuration/Configuration.xml',
      infobaseIds: ['ib-1'],
      massDeployment: false,
    };

    mockCatalog = [
      {
        id: 'ib-1',
        name: 'TargetBase',
        type: 'file',
        filePath: path.join(tempDir, 'ib'),
        hasStoredPassword: false,
        createdAt: new Date().toISOString(),
      },
    ];

    mockStorage = {
      load: async () => mockCatalog,
      readPasswordSecret: async () => undefined,
    };

    mockBindingManager = {
      get: async (ws: string, rel: string) => {
        if (ws === mockBinding.workspaceFolder && rel === mockBinding.configRelativePath) {
          return mockBinding;
        }
        return undefined;
      },
      listAll: async () => [mockBinding],
    };
  });

  teardown(() => {
    resetVscodeTestState();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  });

  // ─── 1. Target and Context Resolution ─────────────────────────────────────

  test('resolves deploy context from path (exact and directory)', async () => {
    const service = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      getConfigPath: () => configDir,
    });

    const resXml = await service.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(resXml.ok, true);
    if (!resXml.ok) return;

    assert.strictEqual(resXml.context.configRoot.toLowerCase(), configDir.toLowerCase());
    assert.strictEqual(resXml.context.workspaceFolder.name, 'test-ws');
    assert.strictEqual(resXml.context.deployTargets.length, 1);
    assert.strictEqual(resXml.context.deployTargets[0].id, 'ib-1');

    const resDir = await service.prepareDeploy({ kind: 'path', path: configDir });
    assert.strictEqual(resDir.ok, true);
    if (!resDir.ok) return;
    assert.strictEqual(resDir.context.configRoot.toLowerCase(), configDir.toLowerCase());
  });

  test('resolves deploy context from coordinates', async () => {
    const service = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
    });

    const res = await service.prepareDeploy({
      kind: 'coords',
      workspaceFolderName: 'test-ws',
      configRelativePath: 'src/Configuration/Configuration.xml',
    });
    assert.strictEqual(res.ok, true);
    if (!res.ok) return;
    assert.strictEqual(res.context.configRoot.toLowerCase(), configDir.toLowerCase());
    assert.strictEqual(res.context.previewLabels.length, 1);
    assert.ok(res.context.previewLabels[0].includes('TargetBase'));
  });

  test('resolves deploy context from TreeNode and ancestor nodes', async () => {
    const service = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
    });

    const configNode: TreeNode = {
      id: 'cfg',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: configXmlPath,
    };

    const mockTreeDataProvider: any = {
      resolveNodeForUi: (n: TreeNode) => n,
      getConfigPathForNode: (n: TreeNode) => (n.type === MetadataType.Configuration ? configDir : undefined),
    };

    const resConfig = await service.prepareDeploy({
      kind: 'node',
      node: configNode,
      treeDataProvider: mockTreeDataProvider,
    });
    assert.strictEqual(resConfig.ok, true);
    if (!resConfig.ok) return;
    assert.strictEqual(resConfig.context.configRoot.toLowerCase(), configDir.toLowerCase());

    // Sub-node with parent pointing to configuration
    const childNode: TreeNode = {
      id: 'cat-1',
      name: 'Справочник1',
      type: MetadataType.Catalog,
      properties: {},
      parent: configNode,
    };
    const resChild = await service.prepareDeploy({
      kind: 'node',
      node: childNode,
      treeDataProvider: mockTreeDataProvider,
    });
    assert.strictEqual(resChild.ok, true);
  });

  test('fails closed with typed error codes when binding or targets are missing', async () => {
    const emptyBindingManager: any = {
      get: async () => undefined,
      listAll: async () => [],
    };
    const service = new DeployApplicationService({
      bindingManager: emptyBindingManager,
      infobaseStorage: mockStorage,
    });

    const noBinding = await service.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(noBinding.ok, false);
    if (noBinding.ok) return;
    assert.strictEqual(noBinding.code, 'NO_BINDING');

    const emptyTargetsBindingManager: any = {
      get: async () => ({ ...mockBinding, infobaseIds: [] }),
      listAll: async () => [{ ...mockBinding, infobaseIds: [] }],
    };
    const service2 = new DeployApplicationService({
      bindingManager: emptyTargetsBindingManager,
      infobaseStorage: mockStorage,
    });
    const noTargets = await service2.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(noTargets.ok, false);
    if (noTargets.ok) return;
    assert.strictEqual(noTargets.code, 'NO_TARGET_INFOBASE');
  });

  // ─── 2. Git Resolution Policy ─────────────────────────────────────────────

  test('Git repository resolution: strictly respects configuration boundary without arbitrary fallback', async () => {
    let queried = false;
    const repoInside: GitRepository = {
      rootUri: { fsPath: tempDir },
      state: { workingTreeChanges: [], indexChanges: [], mergeChanges: [] },
    };

    const customGitDeps: IncrementalChangeDetectorDeps = {
      getGitRepository: () => {
        queried = true;
        return repoInside;
      },
    };

    const service = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      gitDeps: customGitDeps,
    });

    const plan = await service.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(plan.ok, true);
    if (!plan.ok) return;

    const changes = await service.detectChangedFiles(plan.context);
    assert.strictEqual(queried, true);
    assert.strictEqual(changes.ok, true);
    if (!changes.ok) return;
    assert.strictEqual(changes.relativePaths.length, 0);

    // When Git repository is not found, both UI and Agent must get identical failure result
    const noRepoGitDeps: IncrementalChangeDetectorDeps = {
      getGitRepository: () => undefined,
    };
    const serviceNoRepo = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      gitDeps: noRepoGitDeps,
    });
    const changesNoRepo = await serviceNoRepo.detectChangedFiles(plan.context);
    assert.strictEqual(changesNoRepo.ok, false);
    if (changesNoRepo.ok) return;
    assert.ok(/git/i.test(changesNoRepo.error));
  });

  // ─── 3. Unified Execution & Outcome Mapping ───────────────────────────────

  test('deployBinding returns canonical DeployOutcome with typed statuses', async () => {
    const mockDeployService: any = {
      deployBinding: async () =>
        ({
          successCount: 1,
          errorCount: 0,
          inDoubtCount: 0,
          skippedCount: 0,
          hasPartial: false,
          cancelledMidChain: false,
          results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'success', message: 'Ok' }],
        }) as DeployRunSummary,
    };

    const service = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      deployService: mockDeployService,
    });

    const outcome = await service.deploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(outcome.success, true);
    assert.strictEqual(outcome.status, 'success');
    assert.strictEqual(outcome.summary.successCount, 1);
    assert.strictEqual(outcome.data.summary.success, 1);
    assert.ok(outcome.message.includes('1 успешно'));
  });

  test('deployChangedFiles rejects path traversal before execution', async () => {
    const service = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
    });

    const outcome = await service.deployFiles(
      { kind: 'path', path: configXmlPath },
      ['../outside/evil.xml'],
    );
    assert.strictEqual(outcome.success, false);
    assert.strictEqual(outcome.status, 'error');
    assert.ok(/родительский|outside|границы|traversal/i.test(outcome.error ?? ''));
  });

  // ─── 4. Surface Parity: UI & Agent Converge on DeployApplicationService ───

  test('AgentDeployOperations delegates to DeployApplicationService and produces matching outcome', async () => {
    const mockDeployService: any = {
      deployBinding: async () =>
        ({
          successCount: 1,
          errorCount: 0,
          inDoubtCount: 0,
          skippedCount: 0,
          hasPartial: false,
          cancelledMidChain: false,
          results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'success', message: 'Ok' }],
        }) as DeployRunSummary,
    };

    const appService = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      getConfigPath: () => configDir,
      deployService: mockDeployService,
    });

    const agentOps = new AgentDeployOperations({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      getConfigPath: () => configDir,
    });
    // Inject appService
    Reflect.set(agentOps, 'appService', appService);

    const agentResult = await agentOps.deploy({});
    assert.strictEqual(agentResult.success, true);
    assert.strictEqual(agentResult.data?.summary.success, 1);
    assert.strictEqual(agentResult.data?.results[0].infobase, 'TargetBase');
    assert.strictEqual(agentResult.data?.results[0].status, 'success');
  });
});
