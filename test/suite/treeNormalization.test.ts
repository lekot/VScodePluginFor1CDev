import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { normalizeEmptyPlaceholderTree } from '../../src/utils/treeNormalization';

suite('treeNormalization Test Suite', () => {
  function createMockContext(): vscode.ExtensionContext {
    return {
      subscriptions: [],
      extensionPath: '',
      extensionUri: vscode.Uri.file(''),
      globalState: {} as any,
      workspaceState: {} as any,
      secrets: {} as any,
      storageUri: undefined,
      storagePath: undefined,
      globalStorageUri: vscode.Uri.file(''),
      globalStoragePath: '',
      logUri: vscode.Uri.file(''),
      logPath: '',
      extensionMode: vscode.ExtensionMode.Test,
      extension: {} as any,
      environmentVariableCollection: {} as any,
      languageModelAccessInformation: {} as any,
      asAbsolutePath: (relativePath: string) => relativePath,
    };
  }

  test('normalizeEmptyPlaceholderTree inserts R4 placeholders for Designer (Catalogs/Documents)', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [], // missing type nodes (folders absent)
    };

    const configPath = path.join('C:', 'reps', 'myconfig');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    const catalogs = normalized.children!.find((c) => c.id === 'Catalogs');
    const documents = normalized.children!.find((c) => c.id === 'Documents');

    assert.ok(catalogs, 'Catalogs placeholder must exist');
    assert.ok(documents, 'Documents placeholder must exist');

    assert.strictEqual(catalogs!.type, MetadataType.Catalog);
    assert.strictEqual(documents!.type, MetadataType.Document);
    assert.deepStrictEqual(catalogs!.children, []);
    assert.deepStrictEqual(documents!.children, []);
    assert.strictEqual((catalogs!.properties as any).type, 'Catalogs');
    assert.strictEqual((documents!.properties as any).type, 'Documents');

    assert.strictEqual(catalogs!.filePath, path.join(configPath, 'Catalogs'));
    assert.strictEqual(documents!.filePath, path.join(configPath, 'Documents'));

    // Parent pointers must point to configuration root for provider traversal.
    assert.strictEqual(catalogs!.parent, normalized);
    assert.strictEqual(documents!.parent, normalized);
  });

  test('normalizeEmptyPlaceholderTree inserts Catalogs/Documents for EDT (filePath under src)', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [], // missing type nodes
    };

    const configPath = path.join('D:', 'configs', 'edt1c');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.EDT });

    const catalogs = normalized.children!.find((c) => c.id === 'Catalogs')!;
    const documents = normalized.children!.find((c) => c.id === 'Documents')!;

    assert.strictEqual(catalogs.type, MetadataType.Catalog);
    assert.strictEqual(documents.type, MetadataType.Document);

    assert.strictEqual(catalogs.filePath, path.join(configPath, 'src', 'Catalogs'));
    assert.strictEqual(documents.filePath, path.join(configPath, 'src', 'Documents'));
  });

  test('normalizeEmptyPlaceholderTree enforces R4 order and R5 "Общие" children order (Designer)', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };

    const configPath = path.join('C:', 'reps', 'myconfig');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    const expectedR4Order = [
      'Common',
      'Constants',
      'Catalogs',
      'Documents',
      'DocumentJournals',
      'Enums',
      'Reports',
      'DataProcessors',
      'ChartsOfCharacteristicTypes',
      'ChartsOfAccounts',
      'ChartsOfCalculationTypes',
      'InformationRegisters',
      'AccumulationRegisters',
      'AccountingRegisters',
      'CalculationRegisters',
      'BusinessProcesses',
      'Tasks',
      'ExternalDataSources',
    ];

    const actualR4Order = (normalized.children ?? []).map((c) => c.id);
    assert.deepStrictEqual(actualR4Order, expectedR4Order);

    const common = normalized.children!.find((c) => c.id === 'Common')!;
    assert.strictEqual(common.name, 'Общие');
    assert.strictEqual(common.type, MetadataType.Unknown);

    const expectedCommonOrder = [
      'Subsystems',
      'CommonModules',
      'SessionParameters',
      'Roles',
      'FilterCriteria',
      'EventSubscriptions',
      'ScheduledJobs',
      'Bots',
      'FunctionalOptions',
      'FunctionalOptionsParameters',
      'DefinableTypes',
      'SettingsStorages',
      'CommonCommands',
      'CommandGroups',
      'CommonForms',
      'CommonLayouts',
      'CommonPictures',
      'XDTO',
      'WebServices',
      'HTTPServices',
      'WSLinks',
      'WebSocketClients',
      'IntegrationServices',
      'StyleElements',
      'Styles',
      'Languages',
    ];

    const actualCommonOrder = (common.children ?? []).map((c) => c.id);
    assert.deepStrictEqual(actualCommonOrder, expectedCommonOrder);
  });

  test('normalizeEmptyPlaceholderTree sets filePath for file-backed placeholder type-nodes (EDT)', () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };

    const configPath = path.join('D:', 'configs', 'edt1c');
    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.EDT });

    const catalogs = normalized.children!.find((c) => c.id === 'Catalogs')!;
    const common = normalized.children!.find((c) => c.id === 'Common')!;
    const webServices = common.children!.find((c) => c.id === 'WebServices')!;

    assert.strictEqual(catalogs.filePath, path.join(configPath, 'src', 'Catalogs'));
    assert.strictEqual(webServices.filePath, path.join(configPath, 'src', 'WebServices'));
  });

  test('provider expanding placeholder type nodes does not throw and returns []', async () => {
    // We intentionally use a non-existing configPath: parsers should swallow readdir errors and return [].
    const configPath = path.join('C:', 'this-folder-should-not-exist-123');

    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(configPath, 'Configuration.xml'), // for tooltip/resourceUri safety
      children: [],
    };

    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });

    const provider = new MetadataTreeDataProvider(createMockContext());
    provider.setRootNode(normalized);

    const catalogs = normalized.children!.find((c) => c.id === 'Catalogs')!;
    const children = await provider.getChildren(catalogs);

    assert.deepStrictEqual(children, []);
  });

  test('provider expanding UI-only placeholder group does not throw and returns []', async () => {
    const configPath = path.join('C:', 'this-folder-should-not-exist-123');

    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(configPath, 'Configuration.xml'),
      children: [],
    };

    const normalized = normalizeEmptyPlaceholderTree(root, { configPath, format: ConfigFormat.Designer });
    const provider = new MetadataTreeDataProvider(createMockContext());
    provider.setRootNode(normalized);

    const commonGroup = normalized.children!.find((c) => c.id === 'Common')!;
    const children = await provider.getChildren(commonGroup);
    assert.deepStrictEqual(children, []);
  });
});

