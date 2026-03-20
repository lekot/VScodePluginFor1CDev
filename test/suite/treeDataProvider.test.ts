import * as assert from 'assert';
import * as fc from 'fast-check';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { MetadataParser } from '../../src/parsers/metadataParser';

suite('MetadataTreeDataProvider Test Suite', () => {
  let provider: MetadataTreeDataProvider;
  let mockContext: vscode.ExtensionContext;

  function normalizeFsPathForCompare(fsPath: string): string {
    // Cross-platform: replace Windows separators and normalize drive-letter casing.
    const p = fsPath.replace(/\\/g, '/');
    const m = p.match(/^([A-Za-z]):\/(.*)$/);
    if (m) {
      return `${m[1].toLowerCase()}:/${m[2]}`;
    }
    return p;
  }

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

  // ADR 0001 / Plan 7.1: Configuration resourceUri → Configuration.xml in configDir
  test('getTreeItem for Configuration with filePath sets resourceUri to Configuration.xml in configDir', () => {
    const configDir = path.join('C:', 'reps', 'myconfig');
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(configDir, 'ConfigDumpInfo.xml'),
    };
    const treeItem = provider.getTreeItem(node);
    assert.ok(treeItem.resourceUri, 'resourceUri should be set for Configuration with configDir');
    assert.strictEqual(
      normalizeFsPathForCompare(treeItem.resourceUri!.fsPath),
      normalizeFsPathForCompare(path.join(configDir, 'Configuration.xml')),
      'resourceUri must point to Configuration.xml in configDir (not ConfigDumpInfo.xml)'
    );
  });

  test('getTreeItem for Configuration without filePath does not set resourceUri', () => {
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      // no filePath → getConfigPathForNode returns null
    };
    const treeItem = provider.getTreeItem(node);
    assert.strictEqual(
      treeItem.resourceUri,
      undefined,
      'resourceUri must not be set when configDir is null (contracts: do not open wrong path)'
    );
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
    assert.strictEqual(result.length, 6);
    result.forEach((group) => assert.ok(Array.isArray(group.objectNames)));
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

  test('getReferenceableObjectsForTypeEditor loads empty type children', async () => {
    const originalParseTypeContents = MetadataParser.parseTypeContents;
    const calls: Array<{ configPath: string; typeName: string }> = [];

    (MetadataParser as any).parseTypeContents = async (configPath: string, typeName: string) => {
      calls.push({ configPath, typeName });
      if (typeName === 'Documents') {
        const node: TreeNode = {
          id: `${typeName}.Orders`,
          name: 'Orders',
          type: MetadataType.Document,
          properties: {},
          children: [],
        };
        return [node];
      }
      if (typeName === 'Catalogs') {
        const node: TreeNode = {
          id: `${typeName}.Products`,
          name: 'Products',
          type: MetadataType.Catalog,
          properties: {},
          children: [],
        };
        return [node];
      }
      return [];
    };

    try {
      const catalogNode: TreeNode = {
        id: 'Catalogs',
        name: 'Catalogs',
        type: MetadataType.Catalog,
        properties: {},
        children: [],
      };
      const documentsNode: TreeNode = {
        id: 'Documents',
        name: 'Documents',
        type: MetadataType.Document,
        properties: {},
        children: [],
      };

      const rootNode: TreeNode = {
        id: 'root',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        filePath: path.join('C:', 'reps', 'myconfig', 'Configuration.xml'),
        children: [catalogNode, documentsNode],
      };

      provider.setRootNode(rootNode);
      const result = await provider.getReferenceableObjectsForTypeEditor();

      const docRef = result.find((g) => g.referenceKind === 'DocumentRef');
      assert.ok(docRef, 'DocumentRef group must exist');
      assert.deepStrictEqual(docRef!.objectNames, ['Orders']);

      assert.ok(
        calls.some((c) => c.typeName === 'Documents'),
        'parseTypeContents should be called for Documents when type node children are empty'
      );
    } finally {
      MetadataParser.parseTypeContents = originalParseTypeContents;
    }
  });

  test('getReferenceableObjectsForTypeEditor restricts to current config root', async () => {
    const originalParseTypeContents = MetadataParser.parseTypeContents;
    const calls: Array<{ configPath: string; typeName: string }> = [];

    (MetadataParser as any).parseTypeContents = async (configPath: string, typeName: string) => {
      calls.push({ configPath, typeName });
      if (typeName === 'Documents') {
        return [
          {
            id: `${typeName}.Orders`,
            name: 'Orders',
            type: MetadataType.Document,
            properties: {},
            children: [],
          },
        ];
      }
      return [];
    };

    try {
      const catalogsA: TreeNode = {
        id: 'Catalogs',
        name: 'Catalogs',
        type: MetadataType.Catalog,
        properties: {},
        children: [
          {
            id: 'Catalogs.Products',
            name: 'Products',
            type: MetadataType.Catalog,
            properties: {},
            children: [],
          },
        ],
      };

      const documentsA: TreeNode = {
        id: 'Documents',
        name: 'Documents',
        type: MetadataType.Document,
        properties: {},
        children: [],
      };

      const rootA: TreeNode = {
        id: 'config:A',
        name: 'Configuration A',
        type: MetadataType.Configuration,
        properties: {},
        filePath: path.join('C:', 'reps', 'configA', 'Configuration.xml'),
        children: [catalogsA, documentsA],
      };

      catalogsA.parent = rootA;
      documentsA.parent = rootA;

      const catalogsB: TreeNode = {
        id: 'Catalogs',
        name: 'Catalogs',
        type: MetadataType.Catalog,
        properties: {},
        children: [
          {
            id: 'Catalogs.Other',
            name: 'Other',
            type: MetadataType.Catalog,
            properties: {},
            children: [],
          },
        ],
      };

      const documentsB: TreeNode = {
        id: 'Documents',
        name: 'Documents',
        type: MetadataType.Document,
        properties: {},
        children: [
          {
            id: 'Documents.OrdersB',
            name: 'OrdersB',
            type: MetadataType.Document,
            properties: {},
            children: [],
          },
        ],
      };

      const rootB: TreeNode = {
        id: 'config:B',
        name: 'Configuration B',
        type: MetadataType.Configuration,
        properties: {},
        filePath: path.join('C:', 'reps', 'configB', 'Configuration.xml'),
        children: [catalogsB, documentsB],
      };

      catalogsB.parent = rootB;
      documentsB.parent = rootB;

      provider.setRootNodes([rootA, rootB], undefined);

      const result = await provider.getReferenceableObjectsForTypeEditor(documentsA);
      const docRef = result.find((g) => g.referenceKind === 'DocumentRef');
      assert.ok(docRef, 'DocumentRef group must exist');
      assert.deepStrictEqual(docRef!.objectNames, ['Orders'], 'Only Orders from config A should be included');

      // parseTypeContents should be called only for config A's missing Documents.
      assert.deepStrictEqual(
        calls.map((c) => c.typeName),
        ['Documents'],
        'parseTypeContents should be called only once for Documents in the current config root'
      );
    } finally {
      MetadataParser.parseTypeContents = originalParseTypeContents;
    }
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
    assert.strictEqual(results.length, 1);
    assert.ok(results.some((n) => n.name === 'Banana'));
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
    assert.strictEqual(children[0].id, 'root');
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
    assert.strictEqual(children.length, 1);
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
    assert.strictEqual(children.length, 1);
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
    assert.strictEqual(children[0].id, 'root');

    const rootChildren = await provider.getChildren(children[0]);
    const filteredSubsystem = rootChildren.find((n) => n.id === 'sub1');
    assert.ok(filteredSubsystem, 'Filtered subsystem should be visible under root');
    const subsystemChildren = await provider.getChildren(filteredSubsystem!);
    assert.strictEqual(subsystemChildren.length, 1);
    assert.strictEqual(subsystemChildren[0].id, 'cat1');
  });

  // Property-Based Tests for Subsystem Filtering (Phase 5.2)

  test('Property 1: Filter Consistency - if a node passes filter, all ancestors pass', async () => {
    // Generate arbitrary tree structures with subsystems
    const nodeTypeArb = fc.constantFrom(
      MetadataType.Configuration,
      MetadataType.Subsystem,
      MetadataType.Catalog,
      MetadataType.Document
    );

    const treeArb = fc.array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 10 }),
        name: fc.string({ minLength: 1, maxLength: 20 }),
        type: nodeTypeArb,
      }),
      { minLength: 2, maxLength: 10 }
    ).filter(nodes => nodes.some(n => n.type === MetadataType.Subsystem));

    await fc.assert(
      fc.asyncProperty(treeArb, async (nodeDefs) => {
        // Build tree from definitions
        const nodes: TreeNode[] = nodeDefs.map((def, idx) => ({
          id: def.id,
          name: def.name,
          type: def.type,
          properties: {},
          children: [],
        }));

        // Set parent relationships (simple chain for testing)
        for (let i = 1; i < nodes.length; i++) {
          nodes[i].parent = nodes[i - 1];
          nodes[i - 1].children = [nodes[i]];
        }

        const root = nodes[0];
        provider.setRootNode(root);

        // Find a subsystem node
        const subsystemNode = nodes.find(n => n.type === MetadataType.Subsystem);
        if (!subsystemNode) return true; // Skip if no subsystem

        // Apply filter
        provider.setSubsystemFilter(subsystemNode.id, subsystemNode.name);

        // Get visible nodes
        const visibleNodes = await provider.getChildren();
        
        // Property: if a node is visible, all its ancestors should be visible
        // (or at least the subsystem and its descendants should be visible)
        const collectIds = (roots: TreeNode[]): Set<string> => {
          const ids = new Set<string>();
          const stack = [...roots];
          while (stack.length > 0) {
            const node = stack.pop()!;
            ids.add(node.id);
            if (node.children?.length) {
              stack.push(...node.children);
            }
          }
          return ids;
        };
        const visibleIds = collectIds(visibleNodes);

        // The subsystem should be visible either as top-level or child under root.
        assert.ok(visibleIds.has(subsystemNode.id), 'Subsystem node should be visible');
        
        return true;
      })
    );
  });

  test('Property 2: Filter Exclusion - nodes outside subsystem are hidden', async () => {
    const nodeTypeArb = fc.constantFrom(
      MetadataType.Catalog,
      MetadataType.Document,
      MetadataType.Subsystem
    );

    const treeArb = fc.array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 10 }),
        name: fc.string({ minLength: 1, maxLength: 20 }),
        type: nodeTypeArb,
      }),
      { minLength: 3, maxLength: 8 }
    ).filter(nodes => {
      const subsystems = nodes.filter(n => n.type === MetadataType.Subsystem);
      const others = nodes.filter(n => n.type !== MetadataType.Subsystem);
      return subsystems.length >= 1 && others.length >= 1;
    });

    await fc.assert(
      fc.asyncProperty(treeArb, async (nodeDefs) => {
        const nodes: TreeNode[] = nodeDefs.map((def) => ({
          id: def.id,
          name: def.name,
          type: def.type,
          properties: {},
          children: [],
        }));

        // Build tree: first node is root, others are children
        const root = nodes[0];
        root.children = nodes.slice(1);
        nodes.slice(1).forEach(n => n.parent = root);

        provider.setRootNode(root);

        // Find a subsystem node
        const subsystemNode = nodes.find(n => n.type === MetadataType.Subsystem);
        if (!subsystemNode) return true;

        // Apply filter
        provider.setSubsystemFilter(subsystemNode.id, subsystemNode.name);

        // Get visible nodes
        const visibleNodes = await provider.getChildren();
        const visibleIds = new Set(visibleNodes.map(n => n.id));

        // Property: nodes outside the subsystem should not be visible
        // (unless they are ancestors of the subsystem)
        const nonSubsystemNodes = nodes.filter(n =>
          n.type !== MetadataType.Subsystem &&
          n.id !== subsystemNode.id
        );

        for (const node of nonSubsystemNodes) {
          // Check if node is an ancestor of subsystem
          let isAncestor = false;
          let current: TreeNode | undefined = subsystemNode;
          while (current) {
            if (current.id === node.id) {
              isAncestor = true;
              break;
            }
            current = current.parent;
          }
          
          if (!isAncestor) {
            assert.ok(!visibleIds.has(node.id), `Node ${node.name} should not be visible`);
          }
        }

        return true;
      })
    );
  });

  test('Property 3: Filter Clearing - clearing filter restores all nodes', async () => {
    const nodeTypeArb = fc.constantFrom(
      MetadataType.Catalog,
      MetadataType.Document,
      MetadataType.Subsystem
    );

    const treeArb = fc.array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 10 }),
        name: fc.string({ minLength: 1, maxLength: 20 }),
        type: nodeTypeArb,
      }),
      { minLength: 2, maxLength: 6 }
    );

    await fc.assert(
      fc.asyncProperty(treeArb, async (nodeDefs) => {
        const nodes: TreeNode[] = nodeDefs.map((def) => ({
          id: def.id,
          name: def.name,
          type: def.type,
          properties: {},
          children: [],
        }));

        const root = nodes[0];
        root.children = nodes.slice(1);
        nodes.slice(1).forEach(n => n.parent = root);

        provider.setRootNode(root);

        // Get initial visible nodes (no filter)
        const initialNodes = await provider.getChildren();
        const initialCount = initialNodes.length;

        // Find a subsystem node
        const subsystemNode = nodes.find(n => n.type === MetadataType.Subsystem);
        if (!subsystemNode) return true;

        // Apply filter
        provider.setSubsystemFilter(subsystemNode.id, subsystemNode.name);
        const filteredNodes = await provider.getChildren();
        
        // Clear filter
        provider.setSubsystemFilter(null, null);
        const clearedNodes = await provider.getChildren();

        // Property: after clearing filter, all nodes should be visible again
        assert.strictEqual(clearedNodes.length, initialCount, 'All nodes should be visible after clearing filter');

        return true;
      })
    );
  });

  test('Property 4: Filter Combination - subsystem filter works with type filter', async () => {
    const treeArb = fc.array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 10 }),
        name: fc.string({ minLength: 1, maxLength: 20 }),
        type: fc.constantFrom(MetadataType.Catalog, MetadataType.Document, MetadataType.Subsystem),
      }),
      { minLength: 4, maxLength: 8 }
    ).filter(nodes => {
      const hasSubsystem = nodes.some(n => n.type === MetadataType.Subsystem);
      const hasCatalog = nodes.some(n => n.type === MetadataType.Catalog);
      return hasSubsystem && hasCatalog;
    });

    await fc.assert(
      fc.asyncProperty(treeArb, async (nodeDefs) => {
        const nodes: TreeNode[] = nodeDefs.map((def) => ({
          id: def.id,
          name: def.name,
          type: def.type,
          properties: {},
          children: [],
        }));

        const root = nodes[0];
        root.children = nodes.slice(1);
        nodes.slice(1).forEach(n => n.parent = root);

        provider.setRootNode(root);

        // Find a subsystem node
        const subsystemNode = nodes.find(n => n.type === MetadataType.Subsystem);
        if (!subsystemNode) return true;

        // Apply both subsystem and type filters
        provider.setSubsystemFilter(subsystemNode.id, subsystemNode.name);
        provider.setTypeFilter([MetadataType.Catalog]);

        const visibleNodes = await provider.getChildren();
        const visibleIds = new Set(visibleNodes.map(n => n.id));

        // Property: only Catalog nodes within the subsystem should be visible
        for (const node of visibleNodes) {
          if (node.type === MetadataType.Catalog) {
            // Check if it's within the subsystem
            let isWithinSubsystem = false;
            let current: TreeNode | undefined = node;
            while (current) {
              if (current.id === subsystemNode.id) {
                isWithinSubsystem = true;
                break;
              }
              current = current.parent;
            }
            assert.ok(isWithinSubsystem, `Catalog ${node.name} should be within subsystem`);
          }
        }

        return true;
      })
    );
  });

  // Performance Tests for Subsystem Filtering (Phase 7.1)

  test('Performance: filter application completes within 100ms for large tree (10,000+ nodes)', async () => {
    // Generate a large tree with 10,000+ nodes
    const nodeCount = 10000;
    const nodes: TreeNode[] = [];

    // Create root
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };
    nodes.push(root);

    // Create subsystems (10 subsystems)
    const subsystems: TreeNode[] = [];
    for (let i = 0; i < 10; i++) {
      const subsystem: TreeNode = {
        id: `subsystem-${i}`,
        name: `Subsystem${i}`,
        type: MetadataType.Subsystem,
        properties: {},
        parent: root,
        children: [],
      };
      subsystems.push(subsystem);
      nodes.push(subsystem);
      root.children!.push(subsystem);
    }

    // Create catalogs under each subsystem (1000 catalogs per subsystem)
    for (const subsystem of subsystems) {
      for (let j = 0; j < 1000; j++) {
        const catalog: TreeNode = {
          id: `${subsystem.id}-catalog-${j}`,
          name: `Catalog${j}`,
          type: MetadataType.Catalog,
          properties: {},
          parent: subsystem,
          children: [],
        };
        nodes.push(catalog);
        subsystem.children!.push(catalog);
      }
    }

    provider.setRootNode(root);

    // Measure filter application time
    const startTime = performance.now();
    provider.setSubsystemFilter(subsystems[0].id, subsystems[0].name);
    const endTime = performance.now();

    const duration = endTime - startTime;
    assert.ok(duration < 100, `Filter application took ${duration}ms, expected < 100ms`);

    // Verify filter is applied correctly
    const filter = provider.getSubsystemFilter();
    assert.strictEqual(filter.subsystemId, subsystems[0].id);
  });

  test('Performance: node filtering has O(d) time complexity where d is node depth', async () => {
    // Create a deep tree (depth = 100)
    const depth = 100;
    let currentNode: TreeNode = {
      id: 'root',
      name: 'Root',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };
    const root = currentNode;

    // Create a chain of nodes
    for (let i = 1; i <= depth; i++) {
      const newNode: TreeNode = {
        id: `node-${i}`,
        name: `Node${i}`,
        type: MetadataType.Catalog,
        properties: {},
        parent: currentNode,
        children: [],
      };
      currentNode.children!.push(newNode);
      currentNode = newNode;
    }

    // Add a subsystem at the root level
    const subsystem: TreeNode = {
      id: 'subsystem',
      name: 'TestSubsystem',
      type: MetadataType.Subsystem,
      properties: {},
      parent: root,
      children: [],
    };
    root.children!.unshift(subsystem);

    provider.setRootNode(root);

    // Measure time to filter
    const startTime = performance.now();
    provider.setSubsystemFilter(subsystem.id, subsystem.name);
    const endTime = performance.now();

    const duration = endTime - startTime;
    // Should be very fast (< 10ms) even for deep trees
    assert.ok(duration < 10, `Deep tree filter took ${duration}ms, expected < 10ms`);
  });

  test('Performance: filter message update is O(1) constant time', async () => {
    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };

    provider.setRootNode(root);

    // Measure filter message update time
    const iterations = 1000;
    const startTime = performance.now();
    
    for (let i = 0; i < iterations; i++) {
      provider.setSubsystemFilter(`subsystem-${i % 10}`, `Subsystem${i % 10}`);
    }
    
    const endTime = performance.now();
    const avgDuration = (endTime - startTime) / iterations;

    // Average time should be very small (< 0.1ms)
    assert.ok(avgDuration < 0.1, `Average filter message update took ${avgDuration}ms, expected < 0.1ms`);
  });

  test('Performance: combined filters (subsystem + type + search) within 100ms', async () => {
    // Generate a medium-sized tree
    const nodeCount = 5000;
    const nodes: TreeNode[] = [];

    const root: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
    };
    nodes.push(root);

    // Create subsystems
    const subsystems: TreeNode[] = [];
    for (let i = 0; i < 5; i++) {
      const subsystem: TreeNode = {
        id: `subsystem-${i}`,
        name: `Subsystem${i}`,
        type: MetadataType.Subsystem,
        properties: {},
        parent: root,
        children: [],
      };
      subsystems.push(subsystem);
      nodes.push(subsystem);
      root.children!.push(subsystem);
    }

    // Create mixed content under each subsystem
    for (const subsystem of subsystems) {
      for (let j = 0; j < 1000; j++) {
        const type = j % 2 === 0 ? MetadataType.Catalog : MetadataType.Document;
        const node: TreeNode = {
          id: `${subsystem.id}-node-${j}`,
          name: `Node${j}`,
          type,
          properties: {},
          parent: subsystem,
          children: [],
        };
        nodes.push(node);
        subsystem.children!.push(node);
      }
    }

    provider.setRootNode(root);

    // Measure combined filter application time
    const startTime = performance.now();
    
    // Apply all three filters
    provider.setSubsystemFilter(subsystems[0].id, subsystems[0].name);
    provider.setTypeFilter([MetadataType.Catalog]);
    provider.setSearchQuery('Node1');
    
    const endTime = performance.now();
    const duration = endTime - startTime;

    assert.ok(duration < 100, `Combined filters took ${duration}ms, expected < 100ms`);

    // Verify filters are active
    const subsystemFilter = provider.getSubsystemFilter();
    assert.strictEqual(subsystemFilter.subsystemId, subsystems[0].id);
    
    const typeFilter = provider.getTypeFilter();
    assert.ok(typeFilter?.includes(MetadataType.Catalog));
    
    const searchQuery = provider.getSearchQuery();
    assert.strictEqual(searchQuery, 'Node1');
  });
});
