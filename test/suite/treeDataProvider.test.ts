import * as assert from 'assert';
import * as vscode from 'vscode';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';

suite('MetadataTreeDataProvider Test Suite', () => {
  let provider: MetadataTreeDataProvider;
  let mockContext: vscode.ExtensionContext;

  setup(() => {
    // Create mock context
    mockContext = {
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

    provider = new MetadataTreeDataProvider(mockContext);
  });

  test('Provider should be initialized', () => {
    assert.ok(provider);
  });

  test('getChildren should return empty array when no root node', async () => {
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 0);
  });

  test('getChildren should return root node when set', async () => {
    const rootNode: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };

    provider.setRootNode(rootNode);
    const children = await provider.getChildren();

    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].name, 'Configuration');
  });

  test('getChildren should return children of a node', async () => {
    const childNode: TreeNode = {
      id: 'child1',
      name: 'Catalog1',
      type: MetadataType.Catalog,
      properties: {},
    };

    const rootNode: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [childNode],
    };

    provider.setRootNode(rootNode);
    const children = await provider.getChildren(rootNode);

    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].name, 'Catalog1');
  });

  test('getTreeItem should return correct tree item', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestNode',
      type: MetadataType.Catalog,
      properties: { synonym: 'Test Synonym' },
    };

    const treeItem = provider.getTreeItem(node);

    assert.strictEqual(treeItem.label, 'TestNode');
    assert.strictEqual(treeItem.contextValue, MetadataType.Catalog);
    assert.strictEqual(treeItem.description, 'Test Synonym');
  });

  test('getTreeItem should set collapsible state for nodes with children', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestNode',
      type: MetadataType.Catalog,
      properties: {},
      children: [
        {
          id: 'child',
          name: 'Child',
          type: MetadataType.Attribute,
          properties: {},
        },
      ],
    };

    const treeItem = provider.getTreeItem(node);

    assert.strictEqual(
      treeItem.collapsibleState,
      vscode.TreeItemCollapsibleState.Collapsed
    );
  });

  test('getTreeItem should set none collapsible state for nodes without children', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestNode',
      type: MetadataType.Catalog,
      properties: {},
    };

    const treeItem = provider.getTreeItem(node);

    assert.strictEqual(
      treeItem.collapsibleState,
      vscode.TreeItemCollapsibleState.None
    );
  });

  test('getParent should return parent node', () => {
    const parentNode: TreeNode = {
      id: 'parent',
      name: 'Parent',
      type: MetadataType.Configuration,
      properties: {},
    };

    const childNode: TreeNode = {
      id: 'child',
      name: 'Child',
      type: MetadataType.Catalog,
      properties: {},
      parent: parentNode,
    };

    const parent = provider.getParent(childNode);

    assert.strictEqual(parent, parentNode);
  });

  test('findNodeById should find node by id', () => {
    const childNode: TreeNode = {
      id: 'child1',
      name: 'Catalog1',
      type: MetadataType.Catalog,
      properties: {},
    };

    const rootNode: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [childNode],
    };

    provider.setRootNode(rootNode);
    const found = provider.findNodeById('child1');

    assert.ok(found);
    assert.strictEqual(found!.name, 'Catalog1');
  });

  test('findNodeById should return null for non-existent id', () => {
    const rootNode: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };

    provider.setRootNode(rootNode);
    const found = provider.findNodeById('non-existent');

    assert.strictEqual(found, null);
  });

  test('expandNode should set isExpanded to true', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestNode',
      type: MetadataType.Catalog,
      properties: {},
      isExpanded: false,
    };

    provider.expandNode(node);

    assert.strictEqual(node.isExpanded, true);
  });

  test('collapseNode should set isExpanded to false', () => {
    const node: TreeNode = {
      id: 'test',
      name: 'TestNode',
      type: MetadataType.Catalog,
      properties: {},
      isExpanded: true,
    };

    provider.collapseNode(node);

    assert.strictEqual(node.isExpanded, false);
  });
});
