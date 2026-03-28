import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  openBindingDialogForConfigurationFromTree,
  resolveBindingTargetForConfigurationTreeNode,
} from '../../src/bindings/bindingCommands';
import { bindingKey } from '../../src/bindings/bindingPathUtils';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import type { ExtensionState } from '../../src/state/extensionState';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

suite('WOW §2C binding commands + Configuration tree (CDT 41)', () => {
  let mockContext: vscode.ExtensionContext;
  let tree: MetadataTreeDataProvider;

  setup(() => {
    resetVscodeTestState();
    mockContext = {
      subscriptions: [],
      extensionPath: '',
      extensionUri: vscode.Uri.file(''),
      globalState: {},
      workspaceState: {},
      secrets: {},
      storageUri: undefined,
      storagePath: undefined,
      globalStorageUri: vscode.Uri.file(''),
      globalStoragePath: '',
      logUri: vscode.Uri.file(''),
      logPath: '',
      extensionMode: vscode.ExtensionMode.Test,
      extension: {},
      environmentVariableCollection: {},
      languageModelAccessInformation: {},
      asAbsolutePath: (relativePath: string) => relativePath,
    } as unknown as vscode.ExtensionContext;
    tree = new MetadataTreeDataProvider(mockContext);
  });

  teardown(() => {
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
    const wsRoot = path.join('C:', 'reps', 'ws-bind');
    vscodeTestState.mockWorkspaceFolders = [
      { name: 'MyWs', index: 0, uri: vscode.Uri.file(wsRoot) },
    ];
    const cfgDir = path.join('D:', 'other', 'cfg');
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
    const wsRoot = path.join('C:', 'reps', 'ws-bind');
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
    const state = {
      bindingManager: {},
      infobaseStorage: {},
    } as unknown as ExtensionState;
    const panel = { show: async () => undefined };
    await openBindingDialogForConfigurationFromTree(undefined, state, panel, tree);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Конфигурация')));
  });

  test('openBindingDialogForConfigurationFromTree shows error when bindingManager is missing', async () => {
    const state = {
      bindingManager: null,
      infobaseStorage: {},
    } as unknown as ExtensionState;
    const panel = { show: async () => undefined };
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    await openBindingDialogForConfigurationFromTree(node, state, panel, tree);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Привязки недоступны')));
  });

  test('openBindingDialogForConfigurationFromTree shows error when infobaseStorage is missing', async () => {
    const state = {
      bindingManager: {},
      infobaseStorage: null,
    } as unknown as ExtensionState;
    const panel = { show: async () => undefined };
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    await openBindingDialogForConfigurationFromTree(node, state, panel, tree);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Привязки недоступны')));
  });

  test('openBindingDialogForConfigurationFromTree shows error when arg is undefined', async () => {
    const state = {
      bindingManager: {},
      infobaseStorage: {},
    } as unknown as ExtensionState;
    const panel = { show: async () => undefined };
    await openBindingDialogForConfigurationFromTree(undefined, state, panel, tree);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Конфигурация')));
  });

  test('openBindingDialogForConfigurationFromTree shows error for wrong node type', async () => {
    const state = {
      bindingManager: {},
      infobaseStorage: {},
    } as unknown as ExtensionState;
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
    await openBindingDialogForConfigurationFromTree(cat, state, panel, tree);
    assert.strictEqual(showCalls, 0);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('Конфигурация')));
  });

  test('openBindingDialogForConfigurationFromTree shows error when workspace mapping fails', async () => {
    const state = {
      bindingManager: {},
      infobaseStorage: {},
    } as unknown as ExtensionState;
    let showCalls = 0;
    const panel = { show: async () => {
        showCalls++;
      } };
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join('D:', 'orphan', 'Configuration.xml'),
    };
    await openBindingDialogForConfigurationFromTree(node, state, panel, tree);
    assert.strictEqual(showCalls, 0);
    assert.ok(vscodeTestState.errorLog.some((m) => m.includes('многокорневого workspace')));
  });

  test('openBindingDialogForConfigurationFromTree calls panel.show with resolved target', async () => {
    const wsRoot = path.join('C:', 'reps', 'ws-dialog');
    vscodeTestState.mockWorkspaceFolders = [{ name: 'W', index: 0, uri: vscode.Uri.file(wsRoot) }];
    const cfgDir = path.join(wsRoot, 'app');
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(cfgDir, 'Configuration.xml'),
    };
    const state = {
      bindingManager: {},
      infobaseStorage: {},
    } as unknown as ExtensionState;
    const seen: string[] = [];
    const panel = {
      show: async (wf: string, rel: string) => {
        seen.push(wf, rel);
      },
    };
    await openBindingDialogForConfigurationFromTree(node, state, panel, tree);
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
    const wsRoot = path.join('C:', 'reps', 'ws-deco');
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
    const wsRoot = path.join('C:', 'reps', 'ws-zero');
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
    const wsRoot = path.join('C:', 'reps', 'ws-empty');
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
    const wsRoot = path.join('C:', 'reps', 'myconfig');
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
