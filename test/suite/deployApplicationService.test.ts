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
import { createBindingCommandsContext } from '../../src/extension/extensionFeatureContexts';
import { runPullSelectedObjectsFromTree } from '../../src/bindings/bindingCommands';
import { BindingManager } from '../../src/bindings/bindingManager';
import { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import type { GitRepository, IncrementalChangeDetectorDeps } from '../../src/services/ibcmd/incrementalChangeDetector';
import { createExtensionStateFixture } from '../helpers/extensionStateFixture';
import { createFakeExtensionContext } from '../helpers/rightsEditorTestHarness';
import { ReloadCoordinatorService } from '../../src/services/reloadCoordinatorService';
import { InfobaseConfigurationOperationQueue } from '../../src/infobases/infobaseConfigurationOperationQueue';
import { createSupportServiceComposition } from '../../src/support/supportServiceComposition';
import { SupportStateCache, createSupportStateCacheFacade } from '../../src/support/supportStateCache';

interface MutableIbcmdServiceModule {
  getIbcmdService(): { resolveExecutablePathAsync: () => Promise<{ kind: string; path?: string }>; getTimeoutMs: () => number };
}
const ibcmdServiceModule = module.require('../../src/services/ibcmd/ibcmdServiceSingleton') as MutableIbcmdServiceModule;

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
      deployService: mockDeployService,
    });

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

  // ─── 6. Comprehensive Coverage: Edge Cases, Execution & High-Level Facades ──

  test('prepareDeploy fails closed when binding references non-existent infobase', async () => {
    const invalidBinding: ConfigurationBinding = {
      ...mockBinding,
      infobaseIds: ['non-existent-id'],
    };
    const bm: any = {
      get: async () => invalidBinding,
      listAll: async () => [invalidBinding],
    };
    const svc = new DeployApplicationService({
      bindingManager: bm,
      infobaseStorage: mockStorage,
      getConfigPath: () => configDir,
    });
    const res = await svc.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(res.ok, false);
    if (!res.ok) {
      assert.strictEqual(res.code, 'ALL_TARGETS_SKIPPED');
      assert.ok(res.error.includes('все пропущены'));
    }

    // Catalog load threw an error
    const throwingStorage: any = {
      load: async () => { throw new Error('disk read error'); },
    };
    const svcCatalogFail = new DeployApplicationService({
      bindingManager: bm,
      infobaseStorage: throwingStorage,
      getConfigPath: () => configDir,
    });
    const resCat = await svcCatalogFail.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(resCat.ok, false);
    if (!resCat.ok) {
      assert.strictEqual(resCat.code, 'CATALOG_LOAD_FAILED');
    }

    // Binding has empty infobaseIds -> NO_TARGET_INFOBASE
    const emptyIdsBinding: ConfigurationBinding = {
      ...mockBinding,
      infobaseIds: [],
    };
    const bmEmpty: any = {
      get: async () => emptyIdsBinding,
    };
    const svcEmpty = new DeployApplicationService({
      bindingManager: bmEmpty,
      infobaseStorage: mockStorage,
      getConfigPath: () => configDir,
    });
    const resEmpty = await svcEmpty.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(resEmpty.ok, false);
    if (!resEmpty.ok) {
      assert.strictEqual(resEmpty.code, 'NO_TARGET_INFOBASE');
    }
  });

  test('prepareDeploy fails closed when workspace folder is missing or configRelativePath is empty', async () => {
    const svc = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
    });

    const resUnknownWs = await svc.prepareDeploy({
      kind: 'coords',
      workspaceFolderName: 'unknown-ws',
      configRelativePath: 'src/Configuration/Configuration.xml',
    });
    assert.strictEqual(resUnknownWs.ok, false);
    if (!resUnknownWs.ok) {
      assert.strictEqual(resUnknownWs.code, 'WORKSPACE_NOT_FOUND');
    }

    const resEmptyRel = await svc.prepareDeploy({
      kind: 'coords',
      workspaceFolderName: 'test-ws',
      configRelativePath: '',
    });
    assert.strictEqual(resEmptyRel.ok, false);
    if (!resEmptyRel.ok) {
      assert.strictEqual(resEmptyRel.code, 'NO_CONFIG_PATH');
    }
  });

  test('prepareDeploy falls back to listAll when bindingManager.get is not a function', async () => {
    const bmOnlyList: any = {
      listAll: async () => [mockBinding],
    };
    const svc = new DeployApplicationService({
      bindingManager: bmOnlyList,
      infobaseStorage: mockStorage,
      getConfigPath: () => configDir,
    });
    const res = await svc.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(res.ok, true);
    if (res.ok) {
      assert.strictEqual(res.context.binding.configRelativePath, mockBinding.configRelativePath);
    }
  });

  test('prepareDeploy resolves Extension TreeNode with isExtension=true', async () => {
    const extDir = path.join(tempDir, 'Extensions', 'Ext1');
    fs.mkdirSync(extDir, { recursive: true });
    const extXml = path.join(extDir, 'Configuration.xml');
    fs.writeFileSync(extXml, '<Configuration/>', 'utf8');

    const extBinding: ConfigurationBinding = {
      workspaceFolder: 'test-ws',
      configRelativePath: 'Extensions/Ext1/Configuration.xml',
      ibcmdExtensionName: 'Ext1',
      infobaseIds: ['ib-1'],
      massDeployment: false,
    };

    const bm: any = {
      get: async (ws: string, rel: string) => {
        if (rel === extBinding.configRelativePath) return extBinding;
        return undefined;
      },
      listAll: async () => [extBinding],
    };

    const svc = new DeployApplicationService({
      bindingManager: bm,
      infobaseStorage: mockStorage,
    });

    const extNode: TreeNode = {
      id: 'ext-node-1',
      name: 'Ext1',
      type: MetadataType.Extension,
      filePath: extDir,
      properties: { isExtension: true },
    };

    const mockTree: any = {
      getConfigPathForNode: () => extDir,
    };

    const res = await svc.prepareDeploy({
      kind: 'node',
      node: extNode,
      treeDataProvider: mockTree,
    });
    assert.strictEqual(res.ok, true);
    if (res.ok) {
      assert.strictEqual(res.context.binding.configRelativePath, extBinding.configRelativePath);
      assert.strictEqual(res.context.binding.ibcmdExtensionName, 'Ext1');
    }

    // When node has no filePath or properties.isExtension is missing -> TARGET_NOT_RESOLVED
    const invalidExtNode: TreeNode = {
      id: 'ext-invalid',
      name: 'BadExt',
      type: MetadataType.Extension,
      properties: {},
    };
    const resBad = await svc.prepareDeploy({
      kind: 'node',
      node: invalidExtNode,
      treeDataProvider: mockTree,
    });
    assert.strictEqual(resBad.ok, false);
    if (!resBad.ok) {
      assert.strictEqual(resBad.code, 'TARGET_NOT_RESOLVED');
    }

    // Extension with isExtension=true but filePath does not contain Configuration.xml
    const nonExistentXmlDir = path.join(tempDir, 'Extensions', 'MissingXml');
    fs.mkdirSync(nonExistentXmlDir, { recursive: true });
    const noXmlExtNode: TreeNode = {
      id: 'ext-no-xml',
      name: 'MissingXml',
      type: MetadataType.Extension,
      filePath: nonExistentXmlDir,
      properties: { isExtension: true },
    };
    const resNoXml = await svc.prepareDeploy({
      kind: 'node',
      node: noXmlExtNode,
      treeDataProvider: mockTree,
    });
    assert.strictEqual(resNoXml.ok, false);
    if (!resNoXml.ok) {
      assert.strictEqual(resNoXml.code, 'TARGET_NOT_RESOLVED');
    }
  });

  test('deployBinding maps cancelledMidChain, inDoubtCount, and errorCount to matching outcomes', async () => {
    let mockSummary: DeployRunSummary = {
      successCount: 0,
      errorCount: 0,
      inDoubtCount: 0,
      skippedCount: 1,
      hasPartial: false,
      cancelledMidChain: true,
      results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'skipped', message: 'User abort' }],
    };

    const mockDeployService: any = {
      deployBinding: async () => mockSummary,
      deployChangedFiles: async () => mockSummary,
      deploySelectedObjects: async () => mockSummary,
      pullSelectedObjects: async () => mockSummary,
    };

    const svc = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      deployService: mockDeployService,
    });

    // 1. Cancelled outcome
    const prep = await svc.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(prep.ok, true);
    if (!prep.ok) return;

    const outCancel = await svc.executeDeployBinding(prep.context);
    assert.strictEqual(outCancel.status, 'cancelled');
    assert.strictEqual(outCancel.success, false);

    // 2. In-doubt outcome
    mockSummary = {
      successCount: 0,
      errorCount: 0,
      inDoubtCount: 1,
      skippedCount: 0,
      hasPartial: false,
      cancelledMidChain: false,
      results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'inDoubt', message: 'Timeout' }],
    };
    const outDoubt = await svc.executeDeployBinding(prep.context);
    assert.strictEqual(outDoubt.status, 'inDoubt');
    assert.strictEqual(outDoubt.success, false);

    // 3. Error outcome
    mockSummary = {
      successCount: 0,
      errorCount: 1,
      inDoubtCount: 0,
      skippedCount: 0,
      hasPartial: false,
      cancelledMidChain: false,
      results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'error', message: 'Fail' }],
    };
    const outError = await svc.executeDeployBinding(prep.context);
    assert.strictEqual(outError.status, 'error');
    assert.strictEqual(outError.success, false);
  });

  test('deployFiles and executeDeployChangedFiles execute through deployService with support and output reporting', async () => {
    let capturedParams: any;
    const stages: string[] = [];
    const outputLines: string[] = [];

    const mockDeployService: any = {
      deployChangedFiles: async (params: any) => {
        capturedParams = params;
        params.onOutput?.('Process line 1');
        return {
          successCount: 1,
          errorCount: 0,
          inDoubtCount: 0,
          skippedCount: 0,
          hasPartial: false,
          cancelledMidChain: false,
          results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'success', message: 'Done' }],
        };
      },
    };

    const mockSupport = { isSupportEnabled: () => true };
    const svc = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      deployService: mockDeployService,
      resolveSupportContext: async () => mockSupport as any,
    });

    const prep = await svc.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(prep.ok, true);
    if (!prep.ok) return;

    const outcome = await svc.executeDeployChangedFiles(prep.context, ['Catalogs/Items.xml'], {
      reportStage: (msg) => stages.push(msg),
      onOutput: (line) => outputLines.push(line),
    });

    assert.strictEqual(outcome.success, true);
    assert.strictEqual(outcome.status, 'success');
    assert.deepStrictEqual(capturedParams.relativeFiles, ['Catalogs/Items.xml']);
    assert.strictEqual(capturedParams.support, mockSupport);
    assert.strictEqual(outputLines.includes('Process line 1'), true);

    // Also via high-level deployFiles
    const highOutcome = await svc.deployFiles(
      { kind: 'path', path: configXmlPath },
      ['Catalogs/Items.xml'],
    );
    assert.strictEqual(highOutcome.success, true);
  });

  test('executeDeploySelectedObjects executes correctly', async () => {
    let selectedPassed: any;
    const mockDeployService: any = {
      deploySelectedObjects: async (params: any) => {
        selectedPassed = params.selectedNodes;
        return {
          successCount: 1,
          errorCount: 0,
          inDoubtCount: 0,
          skippedCount: 0,
          hasPartial: false,
          cancelledMidChain: false,
          results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'success', message: 'Done' }],
        };
      },
    };

    const svc = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      deployService: mockDeployService,
    });

    const nodes: TreeNode[] = [
      { id: 'Catalog.Items', name: 'Items', type: MetadataType.Catalog, properties: {} },
    ];

    const prep = await svc.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(prep.ok, true);
    if (!prep.ok) return;

    const outcome = await svc.executeDeploySelectedObjects(prep.context, nodes);
    assert.strictEqual(outcome.success, true);
    assert.strictEqual(selectedPassed, nodes);
  });

  test('pullObjects and executePullSelectedObjects validate arguments and delegate to deployService', async () => {
    let pulledParams: any;
    const mockDeployService: any = {
      pullSelectedObjects: async (params: any) => {
        pulledParams = params;
        return {
          successCount: 1,
          errorCount: 0,
          inDoubtCount: 0,
          skippedCount: 0,
          hasPartial: false,
          cancelledMidChain: false,
          results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'success', message: 'Pulled' }],
        };
      },
    };

    const svc = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      deployService: mockDeployService,
    });

    // 1. Empty objectIds -> VALIDATION_FAILED
    const outEmpty = await svc.pullObjects({ kind: 'path', path: configXmlPath }, []);
    assert.strictEqual(outEmpty.success, false);
    assert.strictEqual(outEmpty.code, 'VALIDATION_FAILED');
    assert.strictEqual(outEmpty.status, 'error');

    // 2. Unknown infobaseName -> VALIDATION_FAILED
    const outBadName = await svc.pullObjects(
      { kind: 'path', path: configXmlPath },
      ['Catalog.Items'],
      { infobaseName: 'NonExistent' },
    );
    assert.strictEqual(outBadName.success, false);
    assert.strictEqual(outBadName.code, 'VALIDATION_FAILED');

    // 3. Successful pull with matching infobaseName
    const outGood = await svc.pullObjects(
      { kind: 'path', path: configXmlPath },
      ['Catalog.Items'],
      { infobaseName: 'TargetBase' },
    );
    assert.strictEqual(outGood.success, true);
    assert.strictEqual(pulledParams.entry.name, 'TargetBase');
    assert.strictEqual(pulledParams.selectedNodes[0].name, 'Items');
    assert.strictEqual(pulledParams.selectedNodes[0].type, 'Catalog');

    // 4. executePullSelectedObjects with empty deployTargets
    const prep = await svc.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(prep.ok, true);
    if (!prep.ok) return;

    const emptyContext = { ...prep.context, deployTargets: [] };
    const outNoTargets = await svc.executePullSelectedObjects(emptyContext, []);
    assert.strictEqual(outNoTargets.success, false);
    assert.strictEqual(outNoTargets.code, 'VALIDATION_FAILED');
  });

  test('reconciles a committed pull after its mutation returns and keeps reload failure separate from write success', async () => {
    const successfulSummary: DeployRunSummary = {
      successCount: 1,
      errorCount: 0,
      inDoubtCount: 0,
      skippedCount: 0,
      hasPartial: false,
      cancelledMidChain: false,
      results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'success', message: 'Pulled' }],
    };
    let currentSummary = successfulSummary;
    let mutationReturned = false;
    let mutationHadReturnedAtReload = false;
    const reloadCalls: Array<{ configPath: string; reason: string }> = [];
    const reloadError = Object.assign(new Error('tree reload failed'), { code: 'AUDIT_RELOAD_FAILURE' });
    const mockDeployService = {
      pullSelectedObjects: async (params: {
        runConfigurationMutation?: <T>(resourcePath: string, kind: string, operation: () => Promise<T>) => Promise<T>;
      }) => {
        assert.ok(params.runConfigurationMutation, 'application facade must pass the mutation runner to DeployService');
        return params.runConfigurationMutation('/config', 'infobase.pullSelectedObjects', async () => currentSummary);
      },
    };
    const service = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      deployService: mockDeployService as unknown as DeployService,
      runConfigurationMutation: async (_resourcePath, _kind, operation) => {
        const result = await operation();
        mutationReturned = true;
        return result;
      },
      requestConfigurationReload: async (configPath, reason) => {
        reloadCalls.push({ configPath, reason });
        mutationHadReturnedAtReload = mutationReturned;
        throw reloadError;
      },
    });
    const prepared = await service.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(prepared.ok, true);
    if (!prepared.ok) return;
    const nodes: TreeNode[] = [{ id: 'Catalog.Items', name: 'Items', type: MetadataType.Catalog, properties: {} }];

    const outcome = await service.executePullSelectedObjects(prepared.context, nodes);
    assert.strictEqual(outcome.success, true);
    assert.strictEqual(outcome.status, 'success');
    assert.strictEqual(outcome.summary, successfulSummary);
    assert.strictEqual(mutationHadReturnedAtReload, true);
    assert.deepStrictEqual(reloadCalls, [{ configPath: configDir, reason: 'pull-objects' }]);
    assert.deepStrictEqual(outcome.reconciliation, {
      status: 'failed',
      code: 'AUDIT_RELOAD_FAILURE',
      message: 'tree reload failed',
    });

    currentSummary = {
      successCount: 0,
      errorCount: 0,
      inDoubtCount: 0,
      skippedCount: 1,
      hasPartial: false,
      cancelledMidChain: true,
      results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'skipped', message: 'Cancelled' }],
    };
    const cancelled = await service.executePullSelectedObjects(prepared.context, nodes);
    assert.strictEqual(cancelled.success, false);
    assert.strictEqual(cancelled.reconciliation, undefined);
    assert.strictEqual(reloadCalls.length, 1, 'cancelled pull must not request reload');

    currentSummary = {
      successCount: 0,
      errorCount: 0,
      inDoubtCount: 0,
      skippedCount: 1,
      hasPartial: false,
      cancelledMidChain: false,
      results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'skipped', message: 'No export' }],
    };
    const noOp = await service.executePullSelectedObjects(prepared.context, nodes);
    assert.strictEqual(noOp.reconciliation, undefined);
    assert.strictEqual(reloadCalls.length, 1, 'skipped/no-op pull must not request reload');

    currentSummary = {
      successCount: 0,
      errorCount: 1,
      inDoubtCount: 0,
      skippedCount: 0,
      hasPartial: false,
      cancelledMidChain: false,
      results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'error', message: 'export failed' }],
    };
    const failed = await service.executePullSelectedObjects(prepared.context, nodes);
    assert.strictEqual(failed.success, false);
    assert.strictEqual(failed.reconciliation, undefined);
    assert.strictEqual(reloadCalls.length, 1, 'failed pull must not request reload');

    currentSummary = {
      successCount: 0,
      errorCount: 0,
      inDoubtCount: 1,
      skippedCount: 0,
      hasPartial: false,
      cancelledMidChain: false,
      results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'inDoubt', message: 'effect uncertain' }],
    };
    const inDoubt = await service.executePullSelectedObjects(prepared.context, nodes);
    assert.strictEqual(inDoubt.success, false);
    assert.strictEqual(inDoubt.reconciliation, undefined);
    assert.strictEqual(reloadCalls.length, 1, 'in-doubt pull must not request reload');

    currentSummary = successfulSummary;
    const deferred = await service.executePullSelectedObjects(prepared.context, nodes, {
      reconciliationMode: 'defer-to-caller',
    });
    assert.strictEqual(deferred.success, true);
    assert.strictEqual(deferred.reconciliation, undefined);
    assert.strictEqual(reloadCalls.length, 1, 'deferred reconciliation remains owned by its caller');
  });

  test('direct AgentDeployOperations keeps application-owned pull reconciliation', async () => {
    let reloadCount = 0;
    const summary: DeployRunSummary = {
      successCount: 1,
      errorCount: 0,
      inDoubtCount: 0,
      skippedCount: 0,
      hasPartial: false,
      cancelledMidChain: false,
      results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'success', message: 'Pulled' }],
    };
    const deployService = {
      pullSelectedObjects: async (params: {
        runConfigurationMutation?: <T>(resourcePath: string, kind: string, operation: () => Promise<T>) => Promise<T>;
      }) => params.runConfigurationMutation
        ? params.runConfigurationMutation(configDir, 'infobase.pullSelectedObjects', async () => summary)
        : summary,
    };
    const operations = new AgentDeployOperations({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      getConfigPath: () => configDir,
      deployService: deployService as unknown as DeployService,
      runConfigurationMutation: async (_resourcePath, _kind, operation) => operation(),
      requestConfigurationReload: async () => { reloadCount += 1; },
    });

    const result = await operations.pullSelectedObjects({ configPath: configDir, objectIds: ['Catalog.Items'] });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data?.summary.success, 1);
    assert.deepStrictEqual(result.reconciliation, { status: 'succeeded' });
    assert.strictEqual(reloadCount, 1, 'direct facade call defaults to application-owned reconciliation');
  });

  test('pull command warns that the write succeeded when tree reconciliation failed', async () => {
    const reloadCoordinator = new ReloadCoordinatorService(async () => undefined, { defaultDebounceMs: 0 });
    const testContext = createFakeExtensionContext();
    const featureStorage = new InfobaseStorageService(testContext.globalState, testContext.secrets);
    featureStorage.load = async () => mockCatalog;
    const featureBindingManager = new BindingManager();
    featureBindingManager.get = async () => mockBinding;
    const supportComposition = createSupportServiceComposition({
      bindingManager: featureBindingManager,
      infobaseStorage: featureStorage,
      globalStorageRoot: path.join(tempDir, 'support-state'),
      selector: (registration) => ({
        workspaceFolderName: registration.workspaceFolderName,
        configRelativePath: registration.configRelativePath,
      }),
      targetQueue: new InfobaseConfigurationOperationQueue(),
      runExclusiveConfigurationOperation: async <T>(
        _resourcePath: string,
        _kind: string,
        operation: () => Promise<T>,
      ) => operation(),
    });
    const supportStateCache = new SupportStateCache(createSupportStateCacheFacade(supportComposition.facade));
    const fixture = createExtensionStateFixture({
      bindingManager: featureBindingManager,
      infobaseStorage: featureStorage,
      reloadCoordinator,
      supportComposition,
      supportStateCache,
    });
    const state = createBindingCommandsContext(fixture.state);
    const originalGetIbcmdService = ibcmdServiceModule.getIbcmdService;
    const originalPull = DeployApplicationService.prototype.executePullSelectedObjects;
    try {
      ibcmdServiceModule.getIbcmdService = () => ({
        resolveExecutablePathAsync: async () => ({ kind: 'resolved', path: 'ibcmd-test' }),
        getTimeoutMs: () => 30_000,
      });
      DeployApplicationService.prototype.executePullSelectedObjects = async () => ({
        success: true,
        status: 'success',
        message: 'Выгрузка завершена: 1 успешно.',
        summary: {
          successCount: 1,
          errorCount: 0,
          inDoubtCount: 0,
          skippedCount: 0,
          hasPartial: false,
          cancelledMidChain: false,
          results: [],
        },
        data: { summary: { success: 1, error: 0, inDoubt: 0, skipped: 0, hasPartial: false }, results: [] },
        reconciliation: { status: 'failed', code: 'AUDIT_RELOAD_FAILURE', message: 'tree reload failed' },
      });

      const tree = {
        resolveNodeForUi: (node: TreeNode) => node,
        getConfigPathForNode: () => configDir,
      } as never;
      const node: TreeNode = {
        id: 'Configuration',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
      };
      vscodeTestState.warningMessageReturnQueue.push('Выгрузить');
      await runPullSelectedObjectsFromTree(node, [], state, tree);
      assert.ok(
        vscodeTestState.warningLog.some((message) =>
          message.includes('Запись выполнена успешно') && message.includes('дерево метаданных не обновилось') && message.includes('tree reload failed')),
        `expected a success-with-reload-failure warning; got ${JSON.stringify(vscodeTestState.warningLog)}`,
      );
      assert.strictEqual(vscodeTestState.informationLog.length, 0, 'a failed reconciliation must not be presented as fully successful');
    } finally {
      DeployApplicationService.prototype.executePullSelectedObjects = originalPull;
      ibcmdServiceModule.getIbcmdService = originalGetIbcmdService;
      await fixture.dispose();
      await reloadCoordinator.dispose();
      await supportComposition.dispose();
      featureStorage.dispose();
    }
  });

  test('exportStatus and executeExportStatus handle missing dump info and target infobase', async () => {
    const svc = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
    });

    // 1. Target resolution failure
    const outBadTarget = await svc.exportStatus({
      kind: 'path',
      path: path.join(tempDir, 'NonExistent', 'Config.xml'),
    });
    assert.strictEqual(outBadTarget.success, false);
    assert.strictEqual(outBadTarget.status, 'error');

    // 2. Missing ConfigDumpInfo.xml
    const prep = await svc.prepareDeploy({ kind: 'path', path: configXmlPath });
    assert.strictEqual(prep.ok, true);
    if (!prep.ok) return;

    const outNoDump = await svc.executeExportStatus(prep.context);
    assert.strictEqual(outNoDump.success, false);
    assert.strictEqual(outNoDump.code, 'CONFIG_DUMP_INFO_MISSING');

    // 3. Missing deploy targets (with ConfigDumpInfo.xml present)
    const dumpInfoPath = path.join(prep.context.configRoot, 'ConfigDumpInfo.xml');
    fs.writeFileSync(dumpInfoPath, '<ConfigDumpInfo/>', 'utf8');
    try {
      const outNoTargets = await svc.executeExportStatus({
        ...prep.context,
        deployTargets: [],
      });
      assert.strictEqual(outNoTargets.success, false);
      assert.strictEqual(outNoTargets.code, 'NO_TARGET_INFOBASE');
    } finally {
      if (fs.existsSync(dumpInfoPath)) {
        fs.unlinkSync(dumpInfoPath);
      }
    }
  });

  test('deployChanged delegates to executeDeployChangedFiles with detected changes', async () => {
    let deployedRelativeFiles: string[] | undefined;
    const mockDeployService: any = {
      deployChangedFiles: async (params: any) => {
        deployedRelativeFiles = params.relativeFiles;
        return {
          successCount: 1,
          errorCount: 0,
          inDoubtCount: 0,
          skippedCount: 0,
          hasPartial: false,
          cancelledMidChain: false,
          results: [{ infobaseId: 'ib-1', name: 'TargetBase', status: 'success', message: 'Ok' }],
        };
      },
    };

    const mockGitRepo: GitRepository = {
      rootUri: vscode.Uri.file(tempDir),
      state: {
        workingTreeChanges: [{ uri: vscode.Uri.file(path.join(configDir, 'Catalogs', 'Goods.xml')) }],
        indexChanges: [],
        mergeChanges: [],
      },
    };

    const svc = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      deployService: mockDeployService,
      gitDeps: {
        getGitRepository: () => mockGitRepo,
      },
    });

    const outcome = await svc.deployChanged(
      { kind: 'path', path: configXmlPath },
    );
    assert.strictEqual(outcome.success, true);
    assert.deepStrictEqual(deployedRelativeFiles, ['Catalogs/Goods.xml']);

    // When git repo returns error -> validation failed outcome
    const svcNoGit = new DeployApplicationService({
      bindingManager: mockBindingManager,
      infobaseStorage: mockStorage,
      deployService: mockDeployService,
      gitDeps: {
        getGitRepository: () => undefined,
      },
    });
    const outcomeNoGit = await svcNoGit.deployChanged({ kind: 'path', path: configXmlPath });
    assert.strictEqual(outcomeNoGit.success, false);
    assert.strictEqual(outcomeNoGit.code, 'VALIDATION_FAILED');
  });
});
