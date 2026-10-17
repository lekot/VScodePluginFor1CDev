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

  // ─── 5. Review Findings: Nested Config Isolation & Empty Git Diff No-Op ─────

  test('prepareDeploy with allowFuzzyMatch does not fall back to parent binding when separate configuration boundary is detected', async () => {
    // Structure:
    // tempDir/Configuration.xml -> has binding to RootBase
    // tempDir/Independent/Configuration.xml -> UNBOUND nested configuration
    // tempDir/Independent/Catalogs/Goods.xml -> file inside unbound nested configuration
    // tempDir/CustomExt/Configuration.xml -> UNBOUND extension configuration
    const rootConfigXml = path.join(tempDir, 'Configuration.xml');
    fs.writeFileSync(rootConfigXml, '<Configuration/>', 'utf8');

    const independentDir = path.join(tempDir, 'Independent');
    const independentConfigXml = path.join(independentDir, 'Configuration.xml');
    fs.mkdirSync(independentDir, { recursive: true });
    fs.writeFileSync(independentConfigXml, '<Configuration/>', 'utf8');

    const nestedItemFile = path.join(independentDir, 'Catalogs', 'Goods.xml');
    fs.mkdirSync(path.dirname(nestedItemFile), { recursive: true });
    fs.writeFileSync(nestedItemFile, '<Catalog/>', 'utf8');

    const customExtDir = path.join(tempDir, 'CustomExt');
    fs.mkdirSync(customExtDir, { recursive: true });
    fs.writeFileSync(path.join(customExtDir, 'Configuration.xml'), '<Configuration/>', 'utf8');

    const rootBinding: ConfigurationBinding = {
      workspaceFolder: 'test-ws',
      configRelativePath: 'Configuration.xml',
      infobaseIds: ['ib-1'],
      massDeployment: false,
    };

    const localBindingManager: any = {
      listAll: async () => [rootBinding],
      get: async (ws: string, rel: string) => (rel === 'Configuration.xml' ? rootBinding : undefined),
    };

    const service = new DeployApplicationService({
      bindingManager: localBindingManager,
      infobaseStorage: mockStorage,
    });

    // 1. Direct directory of independent configuration with allowFuzzyMatch: true
    const prepDir = await service.prepareDeploy({
      kind: 'path',
      path: independentDir,
      allowFuzzyMatch: true,
    });
    assert.strictEqual(prepDir.ok, false, 'Nested configuration must not fall back to parent root binding');
    if (!prepDir.ok) {
      assert.strictEqual(prepDir.code, 'NO_BINDING');
    }

    // 2. File inside independent configuration with allowFuzzyMatch: true
    const prepFile = await service.prepareDeploy({
      kind: 'path',
      path: nestedItemFile,
      allowFuzzyMatch: true,
    });
    assert.strictEqual(prepFile.ok, false, 'File in nested configuration must not fall back to parent root binding');
    if (!prepFile.ok) {
      assert.strictEqual(prepFile.code, 'NO_BINDING');
    }

    // 3. Custom extension folder with allowFuzzyMatch: true
    const prepExt = await service.prepareDeploy({
      kind: 'path',
      path: customExtDir,
      allowFuzzyMatch: true,
    });
    assert.strictEqual(prepExt.ok, false, 'Unbound extension must not fall back to parent root binding');
    if (!prepExt.ok) {
      assert.strictEqual(prepExt.code, 'NO_BINDING');
    }
  });

  test('executeDeployChangedFiles and deployChanged return successful no-op outcome when no files changed', async () => {
    let deployCalled = false;
    const mockDeployService: any = {
      deployChangedFiles: async () => {
        deployCalled = true;
        throw new Error('deployService must not be called when there are no changed files');
      },
    };

    const emptyGitDeps: IncrementalChangeDetectorDeps = {
      getGitRepository: () =>
        ({
          rootUri: vscode.Uri.file(tempDir),
          state: {
            workingTreeChanges: [],
            indexChanges: [],
            mergeChanges: [],
          },
        }) as unknown as GitRepository,
    };

    const service = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      deployService: mockDeployService,
      gitDeps: emptyGitDeps,
    });

    // 1. Direct call to executeDeployChangedFiles with empty array
    const prepared = await service.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(prepared.ok, true);
    if (!prepared.ok) return;

    const outcomeExecute = await service.executeDeployChangedFiles(prepared.context, []);
    assert.strictEqual(outcomeExecute.success, true, 'Empty changed files must be successful no-op');
    assert.strictEqual(outcomeExecute.status, 'success');
    assert.strictEqual(outcomeExecute.error, undefined, 'Must not set overrideError');
    assert.ok(outcomeExecute.message?.includes('Нет изменённых файлов'));
    assert.strictEqual(deployCalled, false);

    // 2. High-level facade deployChanged with empty git changes
    const outcomeFacade = await service.deployChanged({ kind: 'path', path: configXmlPath });
    assert.strictEqual(outcomeFacade.success, true, 'Facade deployChanged with empty diff must be successful no-op');
    assert.strictEqual(outcomeFacade.status, 'success');
    assert.strictEqual(outcomeFacade.error, undefined);
    assert.ok(outcomeFacade.message?.includes('Нет изменённых файлов'));
    assert.strictEqual(deployCalled, false);
  });

  test('prepareDeploy with allowFuzzyMatch isolates same-named extensions belonging to different configurations', async () => {
    // Config A and Config B both have an extension named "Shared"
    const dirA = path.join(tempDir, 'A');
    const extDirA = path.join(dirA, 'ConfigurationExtensions', 'Shared');
    fs.mkdirSync(extDirA, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'Configuration.xml'), '<Configuration/>', 'utf8');
    fs.writeFileSync(path.join(extDirA, 'Configuration.xml'), '<Configuration/>', 'utf8');

    const dirB = path.join(tempDir, 'B');
    const extDirB = path.join(dirB, 'ConfigurationExtensions', 'Shared');
    const goodsFileB = path.join(extDirB, 'Catalogs', 'Goods.xml');
    fs.mkdirSync(path.dirname(goodsFileB), { recursive: true });
    fs.writeFileSync(path.join(dirB, 'Configuration.xml'), '<Configuration/>', 'utf8');
    fs.writeFileSync(path.join(extDirB, 'Configuration.xml'), '<Configuration/>', 'utf8');
    fs.writeFileSync(goodsFileB, '<Catalog/>', 'utf8');

    const bindingA: ConfigurationBinding = {
      workspaceFolder: 'test-ws',
      configRelativePath: 'A/ConfigurationExtensions/Shared/Configuration.xml',
      ibcmdExtensionName: 'Shared',
      infobaseIds: ['ib-base-a'],
      massDeployment: false,
    };

    const localBindingManager: any = {
      listAll: async () => [bindingA],
      get: async (ws: string, rel: string) =>
        rel === bindingA.configRelativePath ? bindingA : undefined,
    };

    const service = new DeployApplicationService({
      bindingManager: localBindingManager,
      infobaseStorage: mockStorage,
    });

    // Deploying B's extension directory MUST NOT match A's extension binding
    const prepDir = await service.prepareDeploy({
      kind: 'path',
      path: extDirB,
      allowFuzzyMatch: true,
    });
    assert.strictEqual(prepDir.ok, false, 'Unbound extension B must not match binding of extension A');
    if (!prepDir.ok) {
      assert.strictEqual(prepDir.code, 'NO_BINDING');
    }

    // Deploying a file in B's extension MUST NOT match A's extension binding
    const prepFile = await service.prepareDeploy({
      kind: 'path',
      path: goodsFileB,
      allowFuzzyMatch: true,
    });
    assert.strictEqual(prepFile.ok, false, 'File inside unbound extension B must not match binding of extension A');
    if (!prepFile.ok) {
      assert.strictEqual(prepFile.code, 'NO_BINDING');
    }

    // 2. Both extensions are bound to different infobases:
    const bindingB: ConfigurationBinding = {
      workspaceFolder: 'test-ws',
      configRelativePath: 'B/ConfigurationExtensions/Shared/Configuration.xml',
      ibcmdExtensionName: 'Shared',
      infobaseIds: ['ib-1'], // ib-1 exists in mockStorage
      massDeployment: false,
    };

    // Test reverse order: bindingB before bindingA
    const dualBindingManagerReverse: any = {
      listAll: async () => [bindingB, bindingA],
      get: async (ws: string, rel: string) => {
        if (rel === bindingB.configRelativePath) return bindingB;
        if (rel === bindingA.configRelativePath) return bindingA;
        return undefined;
      },
    };

    const serviceDual = new DeployApplicationService({
      bindingManager: dualBindingManagerReverse,
      infobaseStorage: mockStorage,
    });

    const prepDualB = await serviceDual.prepareDeploy({
      kind: 'path',
      path: goodsFileB,
      allowFuzzyMatch: true,
    });
    assert.strictEqual(prepDualB.ok, true);
    if (prepDualB.ok) {
      assert.strictEqual(prepDualB.context.binding.configRelativePath, bindingB.configRelativePath);
      assert.strictEqual(prepDualB.context.deployTargets[0].id, 'ib-1');
    }

    // 3. Agent operations entrance
    const { AgentDeployOperations } = await import('../../src/agent/agentDeployOperations');
    const agentOps = new AgentDeployOperations({
      bindingManager: localBindingManager,
      infobaseStorage: mockStorage,
      getConfigPath: () => null,
    });
    Reflect.set(agentOps, 'appService', service);
    const agentRes = await agentOps.deploy({ configPath: goodsFileB });
    assert.strictEqual(agentRes.success, false);
    assert.ok(agentRes.error?.includes('не найдена привязка базы'));
  });
});
