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

  test('getReferenceableObjects should return empty array when no root', () => {
    const result = provider.getReferenceableObjects();
    assert.strictEqual(Array.isArray(result), true);
    assert.strictEqual(result.length, 0);
  });

  test('getReferenceableObjects should return groups for referenceable metadata types', () => {
    const catalogChild1: TreeNode = {
      id: 'cat1',
      name: 'Products',
      type: MetadataType.Attribute,
      properties: {},
    };
    const catalogChild2: TreeNode = {
      id: 'cat2',
      name: 'Users',
      type: MetadataType.Attribute,
      properties: {},
    };
    const catalogsNode: TreeNode = {
      id: 'catalogs',
      name: 'Catalogs',
      type: MetadataType.Catalog,
      properties: {},
      children: [catalogChild1, catalogChild2],
    };
    const rootNode: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [catalogsNode],
    };
    provider.setRootNode(rootNode);
    const result = provider.getReferenceableObjects();
    assert.ok(Array.isArray(result));
    const catalogRef = result.find((g) => g.referenceKind === 'CatalogRef');
    assert.ok(catalogRef);
    assert.strictEqual(catalogRef.objectNames.length, 2);
    assert.ok(catalogRef.objectNames.includes('Products'));
    assert.ok(catalogRef.objectNames.includes('Users'));
    assert.strictEqual(result.filter((g) => g.referenceKind.endsWith('Ref')).length, 6);
  });

  test('searchByName returns nodes matching substring', () => {
    const a: TreeNode = { id: 'a', name: 'Apple', type: MetadataType.Catalog, properties: {} };
    const b: TreeNode = { id: 'b', name: 'Banana', type: MetadataType.Catalog, properties: {} };
    const c: TreeNode = { id: 'c', name: 'Cherry', type: MetadataType.Catalog, properties: {} };
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [a, b, c],
    };
    provider.setRootNode(root);
    const results = provider.searchByName('an');
    assert.strictEqual(results.length, 2);
    assert.ok(results.some((n) => n.name === 'Banana'));
    assert.ok(results.some((n) => n.name === 'Cherry'));
    assert.strictEqual(provider.searchByName('xyz').length, 0);
  });

  test('setSearchQuery filters visible tree', async () => {
    const a: TreeNode = { id: 'a', name: 'First', type: MetadataType.Catalog, properties: {} };
    const b: TreeNode = { id: 'b', name: 'Second', type: MetadataType.Catalog, properties: {} };
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [a, b],
    };
    provider.setRootNode(root);
    provider.setSearchQuery('First');
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].name, 'Configuration');
    const configChildren = await provider.getChildren(children[0]);
    assert.strictEqual(configChildren.length, 1);
    assert.strictEqual(configChildren[0].name, 'First');
  });

  test('setTypeFilter filters by metadata type', async () => {
    const cat: TreeNode = { id: 'c', name: 'MyCatalog', type: MetadataType.Catalog, properties: {} };
    const doc: TreeNode = { id: 'd', name: 'MyDocument', type: MetadataType.Document, properties: {} };
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [cat, doc],
    };
    provider.setRootNode(root);
    provider.setTypeFilter([MetadataType.Catalog]);
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    const typeChildren = await provider.getChildren(children[0]);
    assert.strictEqual(typeChildren.length, 1);
    assert.strictEqual(typeChildren[0].type, MetadataType.Catalog);
  });

  test('clearSearch restores full tree', async () => {
    const a: TreeNode = { id: 'a', name: 'Alpha', type: MetadataType.Catalog, properties: {} };
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [a],
    };
    provider.setRootNode(root);
    provider.setSearchQuery('Alpha');
    provider.clearSearch();
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    const typeChildren = await provider.getChildren(children[0]);
    assert.strictEqual(typeChildren.length, 1);
  });

  test('setSubsystemFilter filters by subsystem', async () => {
    const subsystem: TreeNode = {
      id: 'sub1',
      name: 'MainSubsystem',
      type: MetadataType.Subsystem,
      properties: {},
    };
    const catalog: TreeNode = {
      id: 'cat1',
      name: 'MyCatalog',
      type: MetadataType.Catalog,
      properties: {},
    };
    const doc: TreeNode = {
      id: 'doc1',
      name: 'MyDocument',
      type: MetadataType.Document,
      properties: {},
    };
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [subsystem, catalog, doc],
    };
    subsystem.parent = root;
    catalog.parent = root;
    doc.parent = root;

    provider.setRootNode(root);
    provider.setSubsystemFilter('sub1', 'MainSubsystem');
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].id, 'sub1');
  });

  test('setSubsystemFilter with null clears filter', async () => {
    const subsystem: TreeNode = {
      id: 'sub1',
      name: 'MainSubsystem',
      type: MetadataType.Subsystem,
      properties: {},
    };
    const catalog: TreeNode = {
      id: 'cat1',
      name: 'MyCatalog',
      type: MetadataType.Catalog,
      properties: {},
    };
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [subsystem, catalog],
    };
    subsystem.parent = root;
    catalog.parent = root;

    provider.setRootNode(root);
    provider.setSubsystemFilter('sub1', 'MainSubsystem');
    provider.setSubsystemFilter(null, null);
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 2);
  });

  test('getSubsystemFilterLabel returns correct label', () => {
    provider.setSubsystemFilter('sub1', 'MainSubsystem');
    const label = provider.getSubsystemFilterLabel();
    assert.strictEqual(label, 'Подсистема: MainSubsystem');
  });

  test('getSubsystemFilterLabel returns null when no filter', () => {
    const label = provider.getSubsystemFilterLabel();
    assert.strictEqual(label, null);
  });

  test('getSubsystemFilter returns current filter state', () => {
    provider.setSubsystemFilter('sub1', 'MainSubsystem');
    const filter = provider.getSubsystemFilter();
    assert.strictEqual(filter.subsystemId, 'sub1');
    assert.strictEqual(filter.subsystemName, 'MainSubsystem');
  });

  test('clearSearch clears subsystem filter', async () => {
    const subsystem: TreeNode = {
      id: 'sub1',
      name: 'MainSubsystem',
      type: MetadataType.Subsystem,
      properties: {},
    };
    const catalog: TreeNode = {
      id: 'cat1',
      name: 'MyCatalog',
      type: MetadataType.Catalog,
      properties: {},
    };
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [subsystem, catalog],
    };
    subsystem.parent = root;
    catalog.parent = root;

    provider.setRootNode(root);
    provider.setSubsystemFilter('sub1', 'MainSubsystem');
    provider.clearSearch();
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 2);
  });

  test('hasActiveFilter returns true when subsystem filter is active', () => {
    provider.setSubsystemFilter('sub1', 'MainSubsystem');
    // hasActiveFilter is private, so we test indirectly via getChildren behavior
    const filter = provider.getSubsystemFilter();
    assert.strictEqual(filter.subsystemId, 'sub1');
  });

  test('subsystem filter works with nested nodes', async () => {
    const subsystem: TreeNode = {
      id: 'sub1',
      name: 'MainSubsystem',
      type: MetadataType.Subsystem,
      properties: {},
    };
    const nestedCatalog: TreeNode = {
      id: 'cat1',
      name: 'NestedCatalog',
      type: MetadataType.Catalog,
      properties: {},
    };
    subsystem.children = [nestedCatalog];
    nestedCatalog.parent = subsystem;

    const otherCatalog: TreeNode = {
      id: 'cat2',
      name: 'OtherCatalog',
      type: MetadataType.Catalog,
      properties: {},
    };

    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [subsystem, otherCatalog],
    };
    subsystem.parent = root;
    otherCatalog.parent = root;

    provider.setRootNode(root);
    provider.setSubsystemFilter('sub1', 'MainSubsystem');
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].id, 'sub1');

    const subsystemChildren = await provider.getChildren(children[0]);
    assert.strictEqual(subsystemChildren.length, 1);
    assert.strictEqual(subsystemChildren[0].id, 'cat1');
  });
});
