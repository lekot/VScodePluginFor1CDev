import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  openBindingDialogForConfigurationFromTree,
  resolveBindingTargetForConfigurationTreeNode,
  runDeployForConfigurationFromTree,
} from '../../src/bindings/bindingCommands';
import { bindingKey } from '../../src/bindings/bindingPathUtils';
import { BindingManager } from '../../src/bindings/bindingManager';
import type { ConfigurationBinding } from '../../src/bindings/models/configurationBinding';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import { InfobaseStorageService } from '../../src/infobases/infobaseStorageService';
import { sharedInfobaseConfigurationOperationQueue } from '../../src/infobases/infobaseConfigurationOperationQueue';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { createBindingCommandsContext } from '../../src/extension/extensionFeatureContexts';
import type { BindingCommandsContext } from '../../src/extension/extensionFeatureContexts';
import { createExtensionStateFixture, type ExtensionStateFixture } from '../helpers/extensionStateFixture';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import {
  getIbcmdService,
  resetIbcmdServiceSingletonForTests,
} from '../../src/services/ibcmd/ibcmdServiceSingleton';
import type {
  IbcmdStreamingRawOutcome,
  IbcmdStreamingRunnerOptions,
} from '../../src/services/ibcmd/IbcmdStreamingRunner';
import type { IbcmdService } from '../../src/services/ibcmd/IbcmdService';
import { ReloadCoordinatorService } from '../../src/services/reloadCoordinatorService';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import { createSupportServiceComposition } from '../../src/support/supportServiceComposition';
import { createSupportStateCacheFacade, SupportStateCache } from '../../src/support/supportStateCache';
import type { Memento, SecretStorage } from 'vscode';
import {
  resetVscodeTestState,
  restoreVscodeWorkspaceFoldersGetter,
  vscodeTestState,
} from '../helpers/vscodeModuleStub';

interface MutableIbcmdRunnerModule {
  runIbcmdStreaming(options: IbcmdStreamingRunnerOptions): Promise<IbcmdStreamingRawOutcome>;
}

interface MutableIbcmdServiceModule {
  getIbcmdService(): IbcmdService;
}

interface MutableIbcmdVersionSupportModule {
  getIbcmdYamlInfobaseConfigUnsupportedMessage(executablePath: string): Promise<string | undefined>;
}

const ibcmdRunnerModule = module.require('../../src/services/ibcmd/IbcmdStreamingRunner') as MutableIbcmdRunnerModule;
const ibcmdServiceModule = module.require('../../src/services/ibcmd/ibcmdServiceSingleton') as MutableIbcmdServiceModule;
const ibcmdVersionSupportModule = module.require('../../src/services/ibcmd/ibcmdVersionSupport') as MutableIbcmdVersionSupportModule;
const originalRunIbcmdStreaming = ibcmdRunnerModule.runIbcmdStreaming;
const originalGetIbcmdService = ibcmdServiceModule.getIbcmdService;
const originalGetYamlUnsupportedMessage = ibcmdVersionSupportModule.getIbcmdYamlInfobaseConfigUnsupportedMessage;

class TestMemento implements Memento {
  private readonly values = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    return Promise.resolve();
  }
}

class TestSecretStorage implements SecretStorage {
  private readonly values = new Map<string, string>();

  get onDidChange(): vscode.Event<{ key: string }> {
    return () => ({ dispose: () => undefined });
  }

  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  store(key: string, value: string): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  keys(): Thenable<string[]> {
    return Promise.resolve([...this.values.keys()]);
  }
}

interface BindingCommandsTestFixture {
  readonly stateFixture: ExtensionStateFixture;
  readonly bindingManager: BindingManager;
  readonly infobaseStorage: InfobaseStorageService;
  context(): BindingCommandsContext;
  setDeployData(data: {
    readonly binding?: ConfigurationBinding;
    readonly entries?: readonly InfobaseEntry[];
    readonly loadError?: Error;
  }): void;
  dispose(): Promise<void>;
}

function createBindingCommandsTestFixture(configurationRoot?: string): BindingCommandsTestFixture {
  const bindingManager = new BindingManager();
  const infobaseStorage = new InfobaseStorageService(new TestMemento(), new TestSecretStorage());
  let selectedBinding: ConfigurationBinding | undefined;
  let catalogEntries: readonly InfobaseEntry[] = [];
  let catalogError: Error | undefined;
  bindingManager.get = async () => selectedBinding;
  infobaseStorage.load = async () => {
    if (catalogError) {
      throw catalogError;
    }
    return [...catalogEntries];
  };

  const supportStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-commands-support-'));
  const supportComposition = createSupportServiceComposition({
    bindingManager,
    infobaseStorage,
    globalStorageRoot: supportStorageRoot,
    selector: (registration) => ({
      workspaceFolderName: registration.workspaceFolderName,
      configRelativePath: registration.configRelativePath,
    }),
    targetQueue: sharedInfobaseConfigurationOperationQueue,
    runExclusiveConfigurationOperation: async <T>(
      _resourcePath: string,
      _kind: string,
      operation: () => Promise<T>,
    ) => operation(),
  });
  const supportStateCache = new SupportStateCache(createSupportStateCacheFacade(supportComposition.facade));
  if (configurationRoot) {
    const configurationId = path.resolve(configurationRoot) as ConfigurationId;
    supportComposition.registry.registerConfiguration({
      configurationId,
      configRoot: configurationRoot,
      workspaceFolderName: 'MyWs',
      configRelativePath: 'Configuration.xml',
    });
    supportStateCache.register(configurationRoot, configurationId);
  }
  const reloadCoordinator = new ReloadCoordinatorService(async () => undefined, { defaultDebounceMs: 0 });
  const stateFixture = createExtensionStateFixture({
    bindingManager,
    infobaseStorage,
    reloadCoordinator,
    supportComposition,
    supportStateCache,
  });

  return {
    stateFixture,
    bindingManager,
    infobaseStorage,
    context: () => createBindingCommandsContext(stateFixture.state),
    setDeployData: ({ binding, entries = [], loadError }) => {
      selectedBinding = binding;
      catalogEntries = entries;
      catalogError = loadError;
    },
    dispose: async () => {
      await stateFixture.dispose();
      supportStateCache.clear();
      await supportComposition.dispose();
      await reloadCoordinator.dispose();
      infobaseStorage.dispose();
      fs.rmSync(supportStorageRoot, { recursive: true, force: true });
    },
  };
}

function bindingForDeploy(infobaseIds: string[], massDeployment = false): ConfigurationBinding {
  return {
    workspaceFolder: 'MyWs',
    configRelativePath: 'Configuration.xml',
    infobaseIds,
    massDeployment,
  };
}

function fileInfobase(id: string, name: string, filePath: string): InfobaseEntry {
  return {
    id,
    name,
    type: 'file',
    filePath,
    hasStoredPassword: false,
    createdAt: '2020-01-01T00:00:00.000Z',
  };
}

function rawOutcome(overrides: Partial<IbcmdStreamingRawOutcome> = {}): IbcmdStreamingRawOutcome {
  return {
    started: false,
    effectPossible: false,
    exitCode: 0,
    signal: null,
    combinedLog: '',
    logTruncated: false,
    cancelled: false,
    timedOut: false,
    ...overrides,
  };
}

suite('WOW §2C binding commands + Configuration tree (CDT 41)', () => {
  let mockContext: vscode.ExtensionContext;
  let tree: MetadataTreeDataProvider;
  let bindingFixture: BindingCommandsTestFixture;

  setup(() => {
    resetVscodeTestState();
    mockContext = {
      subscriptions: [],
      extensionPath: '',
      extensionUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
      globalState: {},
      workspaceState: {},
      secrets: {},
      storageUri: undefined,
      storagePath: undefined,
      globalStorageUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
      globalStoragePath: '',
      logUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
      logPath: '',
      extensionMode: vscode.ExtensionMode.Test,
      extension: {},
      environmentVariableCollection: {},
      languageModelAccessInformation: {},
      asAbsolutePath: (relativePath: string) => relativePath,
    } as unknown as vscode.ExtensionContext;
    tree = new MetadataTreeDataProvider();
    bindingFixture = createBindingCommandsTestFixture();
  });

  teardown(async () => {
    await bindingFixture.dispose();
    tree.dispose();
    resetVscodeTestState();
  });

  test('resolveBindingTargetForConfigurationTreeNode returns undefined for non-Configuration', () => {
    const node: TreeNode = {
      id: 'x',
      name: 'Catalog',
      type: MetadataType.Catalog,
      properties: {},
    };
    assert.strictEqual(resolveBindingTargetForConfigurationTreeNode(node, tree), undefined);
  });

  test('resolveBindingTargetForConfigurationTreeNode returns undefined without config path', () => {
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    assert.strictEqual(resolveBindingTargetForConfigurationTreeNode(node, tree), undefined);
  });

  test('resolveBindingTargetForConfigurationTreeNode returns undefined when URI is outside workspace folders', () => {
    const wsRoot = path.resolve('test-workspaces', 'ws-bind');
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) },
    ];
    const cfgDir = path.resolve('other-workspaces', 'cfg');
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(cfgDir, 'Configuration.xml'),
    };
    assert.strictEqual(resolveBindingTargetForConfigurationTreeNode(node, tree), undefined);
  });

  test('resolveBindingTargetForConfigurationTreeNode returns workspace name and normalized relative path', () => {
    const wsRoot = path.resolve('test-workspaces', 'ws-bind');
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) },
    ];
    const cfgDir = path.join(wsRoot, 'src', 'cfg');
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(cfgDir, 'Configuration.xml'),
    };
    const got = resolveBindingTargetForConfigurationTreeNode(node, tree);
    assert.ok(got);
    assert.strictEqual(got!.workspaceFolderName, 'MyWs');
    assert.strictEqual(got!.configRelativePath, 'src/cfg/Configuration.xml');
  });

  test('openBindingDialogForConfigurationFromTree shows error when tree argument is undefined', async () => {
    const panel = { show: async () => undefined };
    await openBindingDialogForConfigurationFromTree(undefined, bindingFixture.context(), panel, tree);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Выберите узел в дереве метаданных')));
  });

  test('binding commands context rejects a missing binding manager before registration', () => {
    bindingFixture.stateFixture.publish({ bindingManager: null });
    assert.throws(
      () => bindingFixture.context(),
      /Binding commands requires extension handle "bindingManager" before registration\./,
    );
  });

  test('binding commands context rejects missing infobase storage before registration', () => {
    bindingFixture.stateFixture.publish({ infobaseStorage: null });
    assert.throws(
      () => bindingFixture.context(),
      /Binding commands requires extension handle "infobaseStorage" before registration\./,
    );
  });

  test('openBindingDialogForConfigurationFromTree shows error when arg is undefined', async () => {
    const panel = { show: async () => undefined };
    await openBindingDialogForConfigurationFromTree(undefined, bindingFixture.context(), panel, tree);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Выберите узел в дереве метаданных')));
  });

  test('openBindingDialogForConfigurationFromTree shows error for wrong node type', async () => {
    let showCalls = 0;
    const panel = { show: async () => {
        showCalls++;
      } };
    const cat: TreeNode = {
      id: 'Catalogs.X',
      name: 'X',
      type: MetadataType.Catalog,
      properties: {},
    };
    await openBindingDialogForConfigurationFromTree(cat, bindingFixture.context(), panel, tree);
    assert.strictEqual(showCalls, 0);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Не удалось сопоставить выгрузку с workspace')));
  });

  test('openBindingDialogForConfigurationFromTree shows error when workspace mapping fails', async () => {
    let showCalls = 0;
    const panel = { show: async () => {
        showCalls++;
      } };
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(path.resolve('orphaned-workspaces', 'cfg'), 'Configuration.xml'),
    };
    await openBindingDialogForConfigurationFromTree(node, bindingFixture.context(), panel, tree);
    assert.strictEqual(showCalls, 0);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Не удалось сопоставить выгрузку с workspace')));
  });

  test('openBindingDialogForConfigurationFromTree calls panel.show with resolved target', async () => {
    const wsRoot = path.resolve('test-workspaces', 'ws-dialog');
    vscodeTestState.mockWorkspaceFolders = [{ name: 'W', index: 0, uri: vscode.Uri.file(wsRoot) }];
    const cfgDir = path.join(wsRoot, 'app');
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(cfgDir, 'Configuration.xml'),
    };
    const seen: string[] = [];
    const panel = {
      show: async (wf: string, rel: string) => {
        seen.push(wf, rel);
      },
    };
    await openBindingDialogForConfigurationFromTree(node, bindingFixture.context(), panel, tree);
    assert.deepStrictEqual(seen, ['W', 'app/Configuration.xml']);
    assert.strictEqual(vscodeTestState.errorLog.length, 0);
  });

  test('package.json: command bindings.openDialogForConfiguration and context menu for Configuration', () => {
    const root = path.join(__dirname, '..', '..', '..');
    const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as {
      contributes: { commands: { command: string; title: string }[]; menus: { [k: string]: unknown } };
    };
    const cmd = pkg.contributes.commands.find((c) => c.command === '1c-metadata-tree.bindings.openDialogForConfiguration');
    assert.ok(cmd, 'command 1c-metadata-tree.bindings.openDialogForConfiguration missing');
    assert.ok(cmd!.title.includes('Привязать'), 'command title should mention bind');
    const palette = pkg.contributes.menus['commandPalette'] as { command: string; when?: string }[];
    const hidden = palette.find((e) => e.command === '1c-metadata-tree.bindings.openDialogForConfiguration');
    assert.ok(hidden && hidden.when === 'false', 'command should be hidden from palette');
    const ctx = pkg.contributes.menus['view/item/context'] as { command: string; when?: string }[];
    const treeItem = ctx.find((e) => e.command === '1c-metadata-tree.bindings.openDialogForConfiguration');
    assert.ok(treeItem, 'context menu entry missing');
    assert.ok(treeItem!.when?.includes('Configuration'), 'when should target Configuration viewItem');
    assert.ok(treeItem!.when?.includes('1c-metadata-tree'), 'when should target metadata tree view');
  });

  test('getTreeItem Configuration: badge and binding tooltip when decorations map has entry', () => {
    const wsRoot = path.resolve('test-workspaces', 'ws-deco');
    vscodeTestState.mockWorkspaceFolders = [{ name: 'WF', index: 0, uri: vscode.Uri.file(wsRoot) }];
    const cfgDir = path.join(wsRoot, 'conf');
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: { synonym: 'Син' },
      filePath: path.join(cfgDir, 'Configuration.xml'),
    };
    const key = bindingKey('WF', 'conf/Configuration.xml');
    tree.setConfigurationBindingDecorations(
      new Map([
        [
          key,
          {
            boundCount: 3,
            namesPreview: 'A, B, C',
            massDeployment: true,
          },
        ],
      ]),
    );
    const item = tree.getTreeItem(node);
    assert.ok(String(item.description).includes('🔗3'), `expected badge in description, got ${item.description}`);
    const tip = String(item.tooltip);
    assert.ok(tip.includes('Привязка ИБ: 3'), tip);
    assert.ok(tip.includes('Массовая раскатка: да'), tip);
    assert.ok(tip.includes('A, B, C'), tip);
    assert.ok(item.resourceUri, 'resourceUri must still be set (getWorkspaceFolder stub)');
  });

  test('getTreeItem Configuration: boundCount 0 in map still shows «не настроена» (no badge)', () => {
    const wsRoot = path.resolve('test-workspaces', 'ws-zero');
    vscodeTestState.mockWorkspaceFolders = [{ name: 'WF', index: 0, uri: vscode.Uri.file(wsRoot) }];
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(wsRoot, 'Configuration.xml'),
    };
    const key = bindingKey('WF', 'Configuration.xml');
    tree.setConfigurationBindingDecorations(
      new Map([[key, { boundCount: 0, namesPreview: '', massDeployment: false }]]),
    );
    const item = tree.getTreeItem(node);
    assert.strictEqual(item.description, undefined);
    assert.ok(String(item.tooltip).includes('не настроена'));
  });

  test('getTreeItem Configuration: tooltip when no bindings suggests context menu', () => {
    const wsRoot = path.resolve('test-workspaces', 'ws-empty');
    vscodeTestState.mockWorkspaceFolders = [{ name: 'WF', index: 0, uri: vscode.Uri.file(wsRoot) }];
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(wsRoot, 'Configuration.xml'),
    };
    tree.setConfigurationBindingDecorations(new Map());
    const item = tree.getTreeItem(node);
    const tip = String(item.tooltip);
    assert.ok(tip.includes('не настроена'), tip);
    assert.ok(tip.includes('Привязать базы'), tip);
    assert.strictEqual(item.description, undefined, 'no badge when boundCount is 0');
  });

  test('getTreeItem Configuration with filePath sets resourceUri when workspace folder resolves (stub)', () => {
    const wsRoot = path.resolve('test-workspaces', 'myconfig');
    vscodeTestState.mockWorkspaceFolders = [{ name: 'X', index: 0, uri: vscode.Uri.file(wsRoot) }];
    const configDir = path.join(wsRoot, 'nested');
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(configDir, 'ConfigDumpInfo.xml'),
    };
    const item = tree.getTreeItem(node);
    assert.ok(item.resourceUri);
    assert.strictEqual(
      item.resourceUri!.fsPath.replace(/\\/g, '/').toLowerCase(),
      path.join(configDir, 'Configuration.xml').replace(/\\/g, '/').toLowerCase(),
    );
  });
});

function fixtureSmallMatrixRoot(): string {
  return path.resolve(__dirname, '../fixtures/matrix/small');
}

suite('WOW §2D runDeployForConfigurationFromTree', () => {
  let mockContext: vscode.ExtensionContext;
  let tree: MetadataTreeDataProvider;
  let bindingFixture: BindingCommandsTestFixture;
  const tempDirs: string[] = [];

  setup(() => {
    resetVscodeTestState();
    restoreVscodeWorkspaceFoldersGetter();
    resetIbcmdServiceSingletonForTests();
    mockContext = {
      subscriptions: [],
      extensionPath: '',
      extensionUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
      globalState: {},
      workspaceState: {},
      secrets: {},
      storageUri: undefined,
      storagePath: undefined,
      globalStorageUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
      globalStoragePath: '',
      logUri: vscode.Uri.file(path.resolve(__dirname, '..', '..')),
      logPath: '',
      extensionMode: vscode.ExtensionMode.Test,
      extension: {},
      environmentVariableCollection: {},
      languageModelAccessInformation: {},
      asAbsolutePath: (relativePath: string) => relativePath,
    } as unknown as vscode.ExtensionContext;
    tree = new MetadataTreeDataProvider();
    bindingFixture = createBindingCommandsTestFixture(fixtureSmallMatrixRoot());
  });

  teardown(async () => {
    for (const dir of tempDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
    ibcmdRunnerModule.runIbcmdStreaming = originalRunIbcmdStreaming;
    ibcmdServiceModule.getIbcmdService = originalGetIbcmdService;
    ibcmdVersionSupportModule.getIbcmdYamlInfobaseConfigUnsupportedMessage = originalGetYamlUnsupportedMessage;
    resetIbcmdServiceSingletonForTests();
    await bindingFixture.dispose();
    tree.dispose();
    resetVscodeTestState();
  });

  function configureIbcmdMocks(): void {
    ibcmdServiceModule.getIbcmdService = () => ({
      resolveExecutablePathAsync: async () => ({ kind: 'resolved', path: 'ibcmd-test' }),
      getTimeoutMs: () => 30_000,
    } as unknown as IbcmdService);
    ibcmdVersionSupportModule.getIbcmdYamlInfobaseConfigUnsupportedMessage = async () => undefined;
  }

  function configurationNode(wsRoot: string): TreeNode {
    return {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(wsRoot, 'Configuration.xml'),
    };
  }

  test('rejects a missing bindingManager before command registration', () => {
    const wsRoot = fixtureSmallMatrixRoot();
    vscodeTestState.mockWorkspaceFolders = [{ name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) }];
    bindingFixture.stateFixture.publish({ bindingManager: null });
    assert.throws(
      () => bindingFixture.context(),
      /Binding commands requires extension handle "bindingManager" before registration\./,
    );
  });

  test('shows warning when привязка без баз (пустой infobaseIds)', async () => {
    const wsRoot = fixtureSmallMatrixRoot();
    vscodeTestState.mockWorkspaceFolders = [{ name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) }];
    bindingFixture.setDeployData({ binding: bindingForDeploy([]) });
    await runDeployForConfigurationFromTree(configurationNode(wsRoot), bindingFixture.context(), tree);
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('нет привязанных баз')));
  });

  test('shows error when каталог ИБ не загрузился', async () => {
    const wsRoot = fixtureSmallMatrixRoot();
    vscodeTestState.mockWorkspaceFolders = [{ name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) }];
    bindingFixture.setDeployData({
      binding: bindingForDeploy(['x']),
      loadError: new Error('disk'),
    });
    await runDeployForConfigurationFromTree(configurationNode(wsRoot), bindingFixture.context(), tree);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Не удалось загрузить каталог')));
  });

  test('when ibcmd unresolved delegates discovery to DeployService and does not import', async () => {
    const wsRoot = fixtureSmallMatrixRoot();
    vscodeTestState.warningMessageReturnQueue = ['Продолжить'];
    let resolveCalls = 0;
    const ibcmd = getIbcmdService();
    ibcmd.resolveExecutablePathAsync = async () => {
      resolveCalls += 1;
      return { kind: 'notFound', hint: 'test not found' };
    };

    vscodeTestState.mockWorkspaceFolders = [{ name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) }];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-cmd-'));
    tempDirs.push(work);
    const ibPath = path.join(work, 'p.1cd');
    fs.writeFileSync(ibPath, '');
    bindingFixture.setDeployData({
      binding: bindingForDeploy(['ib1']),
      entries: [fileInfobase('ib1', 'N', ibPath)],
    });
    await runDeployForConfigurationFromTree(configurationNode(wsRoot), bindingFixture.context(), tree);
    assert.strictEqual(resolveCalls, 1);
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('1 с ошибками')));
    assert.ok(vscodeTestState.outputChannelLines.some((l) => l.includes('[раскатка] Итого:')));
  });

  test('confirm deploy dialog mentions copy mode (temporary snapshot)', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['deploy.mode'] = 'copy';
    resetIbcmdServiceSingletonForTests();

    const wsRoot = fixtureSmallMatrixRoot();
    vscodeTestState.mockWorkspaceFolders = [{ name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) }];
    vscodeTestState.warningMessageReturnQueue = [undefined];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-dlg-copy-'));
    tempDirs.push(work);
    const ibPath = path.join(work, 'p.1cd');
    fs.writeFileSync(ibPath, '');
    bindingFixture.setDeployData({
      binding: bindingForDeploy(['ib1']),
      entries: [fileInfobase('ib1', 'N', ibPath)],
    });
    await runDeployForConfigurationFromTree(configurationNode(wsRoot), bindingFixture.context(), tree);
    const msg = vscodeTestState.warningLog.find((m) => m.includes('ibcmd config import'));
    assert.ok(msg?.includes('deploy.mode = copy'), msg);
    assert.ok(msg?.includes('временной копии'), msg);
  });

  test('confirm deploy dialog describes block + readonly when VS Code 1.88+', async () => {
    vscodeTestState.vscodeVersion = '1.90.0';
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['deploy.mode'] = 'block';
    resetIbcmdServiceSingletonForTests();

    const wsRoot = fixtureSmallMatrixRoot();
    vscodeTestState.mockWorkspaceFolders = [{ name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) }];
    vscodeTestState.warningMessageReturnQueue = [undefined];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-dlg-block-'));
    tempDirs.push(work);
    const ibPath = path.join(work, 'p.1cd');
    fs.writeFileSync(ibPath, '');
    bindingFixture.setDeployData({
      binding: bindingForDeploy(['ib1']),
      entries: [fileInfobase('ib1', 'N', ibPath)],
    });
    await runDeployForConfigurationFromTree(configurationNode(wsRoot), bindingFixture.context(), tree);
    const msg = vscodeTestState.warningLog.find((m) => m.includes('ibcmd config import'));
    assert.ok(msg?.includes('deploy.mode = block'), msg);
    assert.ok(msg?.includes('только просмотр'), msg);
  });

  test('confirm deploy dialog warns on block mode without VS Code 1.88+', async () => {
    vscodeTestState.vscodeVersion = '1.87.0';
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['deploy.mode'] = 'block';
    resetIbcmdServiceSingletonForTests();

    const wsRoot = fixtureSmallMatrixRoot();
    vscodeTestState.mockWorkspaceFolders = [{ name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) }];
    vscodeTestState.warningMessageReturnQueue = [undefined];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-dlg-blockold-'));
    tempDirs.push(work);
    const ibPath = path.join(work, 'p.1cd');
    fs.writeFileSync(ibPath, '');
    bindingFixture.setDeployData({
      binding: bindingForDeploy(['ib1']),
      entries: [fileInfobase('ib1', 'N', ibPath)],
    });
    await runDeployForConfigurationFromTree(configurationNode(wsRoot), bindingFixture.context(), tree);
    const msg = vscodeTestState.warningLog.find((m) => m.includes('ibcmd config import'));
    assert.ok(msg?.includes('1.88+'), msg);
    assert.ok(msg?.includes('без readonly'), msg);
  });

  test('отмена подтверждения не запускает раскатку', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    resetIbcmdServiceSingletonForTests();

    const wsRoot = fixtureSmallMatrixRoot();
    vscodeTestState.mockWorkspaceFolders = [{ name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) }];
    vscodeTestState.warningMessageReturnQueue = [undefined];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-dismiss-'));
    tempDirs.push(work);
    const ibPath = path.join(work, 'p.1cd');
    fs.writeFileSync(ibPath, '');
    bindingFixture.setDeployData({
      binding: bindingForDeploy(['ib1']),
      entries: [fileInfobase('ib1', 'N', ibPath)],
    });
    await runDeployForConfigurationFromTree(configurationNode(wsRoot), bindingFixture.context(), tree);
    assert.ok(vscodeTestState.warningLog.some((m) => m.includes('ibcmd config import')));
    assert.ok(!vscodeTestState.outputChannelLines.some((l) => l.includes('[раскатка] Итого:')));
  });

  test('после «Продолжить» выполняется deployBinding и пишется итог в Output', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = process.execPath;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.autoDetect'] = false;
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 8000;
    resetIbcmdServiceSingletonForTests();

    const wsRoot = fixtureSmallMatrixRoot();
    vscodeTestState.mockWorkspaceFolders = [{ name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) }];
    vscodeTestState.warningMessageReturnQueue = ['Продолжить'];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-go-'));
    tempDirs.push(work);
    const ibPath = path.join(work, 'p.1cd');
    fs.writeFileSync(ibPath, '');
    bindingFixture.setDeployData({
      binding: bindingForDeploy(['ib1']),
      entries: [fileInfobase('ib1', 'N', ibPath)],
    });
    await runDeployForConfigurationFromTree(configurationNode(wsRoot), bindingFixture.context(), tree);
    assert.strictEqual(
      vscodeTestState.errorLog.length,
      0,
      `unexpected errors: ${JSON.stringify(vscodeTestState.errorLog)}`,
    );
    assert.ok(
      vscodeTestState.outputChannelLines.some((l) => l.includes('[раскатка] Итого:')),
      'expected deploy summary line in ibcmd output channel',
    );
    const dialogCount = vscodeTestState.warningLog.length + vscodeTestState.informationLog.length;
    assert.ok(
      dialogCount >= 2,
      `expected confirm + completion toasts, warningLog=${vscodeTestState.warningLog.length} informationLog=${vscodeTestState.informationLog.length}`,
    );
  });

  test('inDoubt deploy projection warns separately from confirmed errors', async () => {
    const { DeployService } = await import('../../src/bindings/deployService');
    const original = DeployService.prototype.deployBinding;
    const termination = {
      terminated: false,
      hardKillUsed: true,
      survivingPids: [7124],
      errors: ['taskkill /T did not confirm exit'],
    };
    const summary = {
      results: [
        { infobaseId: 'ib1', name: 'Alpha', status: 'success', message: 'applied' },
        {
          infobaseId: 'ib2',
          name: 'Beta',
          status: 'inDoubt',
          message: 'Импорт мог примениться; итог неопределён.',
          errorCode: 'DEPLOY_OPERATION_IN_DOUBT',
          effectPossible: true,
          termination,
        },
      ],
      successCount: 1,
      errorCount: 0,
      inDoubtCount: 1,
      skippedCount: 0,
      hasPartial: false,
      cancelledMidChain: false,
    };
    DeployService.prototype.deployBinding = async () => summary as never;
    try {
      const wsRoot = fixtureSmallMatrixRoot();
      vscodeTestState.mockWorkspaceFolders = [{ name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) }];
      vscodeTestState.warningMessageReturnQueue = ['Продолжить'];
      const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-indoubt-toast-'));
      tempDirs.push(work);
      bindingFixture.setDeployData({
        binding: bindingForDeploy(['ib1', 'ib2'], true),
        entries: ['Alpha', 'Beta'].map((name, index) =>
          fileInfobase(`ib${index + 1}`, name, path.join(work, `${name}.1cd`)),
        ),
      });

      await runDeployForConfigurationFromTree(configurationNode(wsRoot), bindingFixture.context(), tree);

      const completionWarning = vscodeTestState.warningLog.find((message) =>
        message.includes('Раскатка завершена:'),
      );
      assert.ok(completionWarning?.includes('1 с неопределённым результатом'), completionWarning);
      assert.ok(!completionWarning?.includes('с ошибками'), completionWarning);
      assert.ok(
        !vscodeTestState.informationLog.some((message) => message.includes('Раскатка завершена:')),
        'an inDoubt result must use the warning projection even when another base succeeded',
      );
    } finally {
      DeployService.prototype.deployBinding = original;
    }
  });

  test('real process inDoubt reaches the multi-base deploy UI summary without starting apply', async () => {
    configureIbcmdMocks();
    vscodeTestState.workspaceConfig['deploy.precheckXmlBeforeImport'] = false;
    vscodeTestState.warningMessageReturnQueue = ['Продолжить'];
    const wsRoot = fixtureSmallMatrixRoot();
    vscodeTestState.mockWorkspaceFolders = [{ name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) }];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-deploy-ui-process-indoubt-'));
    tempDirs.push(work);
    for (const name of ['Alpha', 'Beta']) {
      fs.writeFileSync(path.join(work, `${name}.1cd`), '');
    }
    const termination = {
      terminated: false,
      hardKillUsed: true,
      survivingPids: [9812],
      errors: ['tree stop not confirmed'],
    };
    let runnerCalls = 0;
    ibcmdRunnerModule.runIbcmdStreaming = async () => {
      runnerCalls += 1;
      return rawOutcome({
        started: true,
        effectPossible: true,
        exitCode: null,
        signal: 'SIGTERM',
        cancelled: true,
        termination,
      });
    };
    bindingFixture.setDeployData({
      binding: bindingForDeploy(['ib1', 'ib2'], true),
      entries: ['Alpha', 'Beta'].map((name, index) =>
        fileInfobase(`ib${index + 1}`, name, path.join(work, `${name}.1cd`)),
      ),
    });

    await runDeployForConfigurationFromTree(configurationNode(wsRoot), bindingFixture.context(), tree);

    assert.strictEqual(runnerCalls, 1, 'uncertain import must prevent apply and the next base');
    assert.strictEqual(vscodeTestState.errorLog.length, 0);
    const completionWarning = vscodeTestState.warningLog.find((message) =>
      message.includes('Раскатка завершена:'),
    );
    assert.ok(completionWarning?.includes('1 с неопределённым результатом'), completionWarning);
    assert.ok(completionWarning?.includes('1 пропущено'), completionWarning);
    assert.ok(!completionWarning?.includes('с ошибками'), completionWarning);
    assert.ok(
      !vscodeTestState.informationLog.some((message) => message.includes('Раскатка завершена:')),
      'an uncertain process receipt must be shown as a warning',
    );
  });

  test('package.json: команды config.deploy / deployMultiple и контекстное меню', () => {
    const root = path.join(__dirname, '..', '..', '..');
    const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as {
      contributes: { commands: { command: string; title: string }[]; menus: { [k: string]: unknown } };
    };
    const one = pkg.contributes.commands.find((c) => c.command === '1c-metadata-tree.config.deploy');
    const many = pkg.contributes.commands.find((c) => c.command === '1c-metadata-tree.config.deployMultiple');
    assert.ok(one?.title.includes('Раскатать'), 'deploy title');
    assert.ok(many?.title.includes('Раскатать'), 'deployMultiple title');
    const palette = pkg.contributes.menus['commandPalette'] as { command: string; when?: string }[];
    assert.ok(palette.some((e) => e.command === '1c-metadata-tree.config.deploy' && e.when === 'false'));
    assert.ok(palette.some((e) => e.command === '1c-metadata-tree.config.deployMultiple' && e.when === 'false'));
    const ctx = pkg.contributes.menus['view/item/context'] as { command: string; when?: string }[];
    const d1 = ctx.find((e) => e.command === '1c-metadata-tree.config.deploy');
    const d2 = ctx.find((e) => e.command === '1c-metadata-tree.config.deployMultiple');
    assert.ok(d1?.when?.includes('deployOne'));
    assert.ok(d2?.when?.includes('deployMany'));
  });
});

suite('binding command ibcmd discovery contract', () => {
  function commandSource(name: string): string {
    const root = path.join(__dirname, '..', '..', '..');
    const source = fs.readFileSync(
      path.join(root, 'src', 'bindings', 'bindingCommands.ts'),
      'utf8',
    );
    const marker = `export async function ${name}(`;
    const start = source.indexOf(marker);
    assert.notStrictEqual(start, -1, `command source not found: ${name}`);
    const next = source.indexOf('\nexport async function ', start + marker.length);
    return source.slice(start, next === -1 ? source.length : next);
  }

  test('full deploy delegates ibcmd discovery to DeployService after support context resolution', () => {
    const source = commandSource('runDeployForConfigurationFromTree');
    const supportContext = source.indexOf('resolveDeploySupportContext(');
    const deploy = source.indexOf('deployService.deployBinding(');

    assert.ok(supportContext >= 0, 'full deploy must resolve its exact support context');
    assert.ok(deploy > supportContext, 'full deploy must pass support context into DeployService');
    assert.ok(
      !source.includes('resolveExecutablePathAsync'),
      'UI full deploy must not discover ibcmd before DeployService support preflight',
    );
    assert.ok(
      !source.includes('showIbcmdNotFoundDialog'),
      'UI full deploy must not intercept support rejection with the ibcmd dialog',
    );
  });

  test('non-full binding commands retain their explicit ibcmd discovery guards', () => {
    const guardedCommands = [
      'runDeploySelectedObjectsFromTree',
      'runPullSelectedObjectsFromTree',
      'runDeployChangedFilesFromTree',
      'runConfigExportStatusFromTree',
    ];

    for (const name of guardedCommands) {
      const source = commandSource(name);
      assert.ok(
        source.includes('resolveExecutablePathAsync'),
        `${name} must retain explicit ibcmd discovery`,
      );
      assert.ok(
        source.includes('showIbcmdNotFoundDialog'),
        `${name} must retain its ibcmd-not-found dialog`,
      );
    }
  });
});
