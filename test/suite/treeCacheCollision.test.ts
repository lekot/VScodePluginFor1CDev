import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { TreeCacheService } from '../../src/providers/treeCacheService';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { handleGotoHandlerMessage, type MessageHandlerContext } from '../../src/providers/propertiesMessageHandler';
import { resetVscodeTestState } from '../helpers/vscodeModuleStub';

suite('TreeCacheService and name search multi-root collision (#193)', () => {
  let cache: TreeCacheService;
  let rootA: TreeNode;
  let rootB: TreeNode;
  let nodeA: TreeNode;
  let nodeB: TreeNode;
  const pathA = path.resolve('workspace', 'Main');
  const pathB = path.resolve('workspace', 'Extension');

  setup(() => {
    resetVscodeTestState();
    cache = new TreeCacheService();

    nodeA = {
      id: 'CommonModules.Shared',
      name: 'Shared',
      type: MetadataType.CommonModule,
      filePath: path.join(pathA, 'CommonModules', 'Shared.xml'),
      properties: {},
    };
    nodeB = {
      id: 'CommonModules.Shared',
      name: 'Shared',
      type: MetadataType.CommonModule,
      filePath: path.join(pathB, 'CommonModules', 'Shared.xml'),
      properties: {},
    };

    rootA = {
      id: 'root-main',
      name: 'MainConfig',
      type: MetadataType.Configuration,
      filePath: path.join(pathA, 'Configuration.xml'),
      properties: {},
      children: [nodeA],
    };
    nodeA.parent = rootA;

    rootB = {
      id: 'root-ext',
      name: 'ExtConfig',
      type: MetadataType.Configuration,
      filePath: path.join(pathB, 'Configuration.xml'),
      properties: {},
      children: [nodeB],
    };
    nodeB.parent = rootB;

    cache.setLoadContexts(new Map([
      ['root-main', { configPath: pathA, format: ConfigFormat.Designer }],
      ['root-ext', { configPath: pathB, format: ConfigFormat.Designer }],
    ]));
  });

  function createMockHandlerContext(provider: MetadataTreeDataProvider, currentNode?: TreeNode): MessageHandlerContext {
    return {
      currentNode,
      currentFormSelection: null,
      currentFormSelectionRevision: 0,
      isSaving: false,
      treeDataProvider: provider,
      typeEditorProvider: {} as any,
      objectTypeEditorProvider: {} as any,
      postMessage: () => {},
      updateWebviewContent: () => {},
      setIsSaving: () => {},
    };
  }

  test('findByName returns distinct nodes from both configurations when IDs collide (#193)', () => {
    cache.buildCache(rootA);
    cache.buildCache(rootB);

    const results = cache.findByName('Shared');
    assert.strictEqual(results.length, 2, 'Must return both candidate nodes, not duplicate or drop');
    assert.ok(results.includes(nodeA), 'Must include node from Root A');
    assert.ok(results.includes(nodeB), 'Must include node from Root B');
    assert.notStrictEqual(results[0], results[1], 'Results must not be duplicate references of the same node');
  });

  test('searchByName returns distinct nodes from both configurations without duplication (#193)', () => {
    cache.buildCache(rootA);
    cache.buildCache(rootB);

    const results = cache.searchByName('share');
    assert.strictEqual(results.length, 2, 'Must return both nodes matching substring');
    assert.ok(results.includes(nodeA), 'Must include node from Root A');
    assert.ok(results.includes(nodeB), 'Must include node from Root B');
    assert.notStrictEqual(results[0], results[1], 'Results must not contain duplicate references');

    const searchContextA = cache.searchByName('share', nodeA);
    assert.strictEqual(searchContextA[0], nodeA, 'searchByName with contextNode prioritizes node from root A');

    const searchContextB = cache.searchByName('share', pathB);
    assert.strictEqual(searchContextB[0], nodeB, 'searchByName with rootPath string prioritizes node from root B');
  });

  test('findByName prioritizes node from matching configuration context (#193)', () => {
    cache.buildCache(rootA);
    cache.buildCache(rootB);

    // When querying with context node from Root A, nodeA must be first
    const resultsA = cache.findByName('Shared', nodeA);
    assert.strictEqual(resultsA[0], nodeA, 'Candidate from same configuration root must come first');

    // When querying with context node from Root B, nodeB must be first
    const resultsB = cache.findByName('Shared', nodeB);
    assert.strictEqual(resultsB[0], nodeB, 'Candidate from same configuration root must come first');

    // When querying with path string
    const resultsPathA = cache.findByName('Shared', pathA);
    assert.strictEqual(resultsPathA[0], nodeA);

    const resultsPathB = cache.findByName('Shared', pathB);
    assert.strictEqual(resultsPathB[0], nodeB);
  });

  test('handleGotoHandlerMessage resolves to the same configuration root as current node (#193)', async () => {
    const provider = new MetadataTreeDataProvider();
    provider.setRootNodes([rootA, rootB], new Map([
      ['root-main', { configPath: pathA, format: ConfigFormat.Designer }],
      ['root-ext', { configPath: pathB, format: ConfigFormat.Designer }],
    ]));

    const openedUris: vscode.Uri[] = [];
    const origOpen = vscode.workspace.openTextDocument;
    (vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
      openedUris.push(uri);
      return {
        lineCount: 1,
        lineAt: () => ({ text: '' }),
        getText: () => '',
      } as any;
    };
    const origShow = vscode.window.showTextDocument;
    (vscode.window as any).showTextDocument = async () => ({
      revealRange: () => {},
      selection: {},
    });

    try {
      // 1. Goto handler from Root A context
      await handleGotoHandlerMessage(
        { type: 'gotoHandler', handler: 'CommonModule.Shared.DoWork' },
        createMockHandlerContext(provider, nodeA)
      );
      assert.strictEqual(openedUris.length, 1);
      assert.ok(
        openedUris[0].fsPath.includes(pathA),
        `Must open module from Root A (${pathA}), but opened: ${openedUris[0].fsPath}`
      );

      // 2. Goto handler from Root B context
      await handleGotoHandlerMessage(
        { type: 'gotoHandler', handler: 'CommonModule.Shared.DoWork' },
        createMockHandlerContext(provider, nodeB)
      );
      assert.strictEqual(openedUris.length, 2);
      assert.ok(
        openedUris[1].fsPath.includes(pathB),
        `Must open module from Root B (${pathB}), but opened: ${openedUris[1].fsPath}`
      );
    } finally {
      (vscode.workspace as any).openTextDocument = origOpen;
      (vscode.window as any).showTextDocument = origShow;
    }
  });

  test('optimistic delete removes node from nameIndex and rollback restores single instance (#193 review)', () => {
    const provider = new MetadataTreeDataProvider();
    provider.setRootNodes([rootA, rootB], new Map([
      ['root-main', { configPath: pathA, format: ConfigFormat.Designer }],
      ['root-ext', { configPath: pathB, format: ConfigFormat.Designer }],
    ]));

    // 1. Before delete: search returns both nodes
    const beforeSearch = provider.findNodesByName('Shared');
    assert.strictEqual(beforeSearch.length, 2, 'Before delete: must return both nodes');
    assert.ok(beforeSearch.includes(nodeA));
    assert.ok(beforeSearch.includes(nodeB));

    // 2. Apply optimistic delete on nodeA
    const token = provider.applyOptimisticDelete(nodeA, 'op-delete-nodeA');
    assert.ok(token, 'Must return delete token');

    // 3. After delete: search must NOT return nodeA
    const afterDeleteSearch = provider.findNodesByName('Shared');
    assert.strictEqual(afterDeleteSearch.length, 1, 'After delete: must only return nodeB');
    assert.strictEqual(afterDeleteSearch[0], nodeB);
    assert.ok(!afterDeleteSearch.includes(nodeA), 'Must not contain deleted nodeA');

    const afterDeleteFuzzy = provider.searchByName('share');
    assert.strictEqual(afterDeleteFuzzy.length, 1, 'Fuzzy search must not contain deleted nodeA');
    assert.strictEqual(afterDeleteFuzzy[0], nodeB);

    // 4. Rollback optimistic delete
    const rolledBack = provider.rollbackOptimisticDelete(token!);
    assert.strictEqual(rolledBack, true, 'Rollback must succeed');

    // 5. After rollback: must contain restored node and nodeB, NO duplicate instances
    const afterRollbackSearch = provider.findNodesByName('Shared');
    assert.strictEqual(afterRollbackSearch.length, 2, 'After rollback: must return exactly 2 nodes');
    assert.ok(afterRollbackSearch.includes(nodeB), 'Must include nodeB');
    assert.ok(!afterRollbackSearch.includes(nodeA), 'Must not include stale deleted nodeA instance');
    const restoredNode = afterRollbackSearch.find((n) => n !== nodeB);
    assert.ok(restoredNode, 'Must have restored node');
    assert.strictEqual(restoredNode?.name, 'Shared');
    assert.notStrictEqual(restoredNode, nodeA, 'Restored node must be rehydrated instance, not old reference');

    const afterRollbackFuzzy = provider.searchByName('share');
    assert.strictEqual(afterRollbackFuzzy.length, 2, 'Fuzzy search must return exactly 2 nodes without duplicates');
  });

  test('optimistic delete recursively evicts child nodes from nameIndex and cache (#193 review)', () => {
    const childA: TreeNode = {
      id: 'CommonModules.Shared.ChildAttr',
      name: 'ChildAttr',
      type: MetadataType.Attribute,
      properties: {},
      parent: nodeA,
    };
    nodeA.children = [childA];

    const provider = new MetadataTreeDataProvider();
    provider.setRootNodes([rootA, rootB], new Map([
      ['root-main', { configPath: pathA, format: ConfigFormat.Designer }],
      ['root-ext', { configPath: pathB, format: ConfigFormat.Designer }],
    ]));

    assert.strictEqual(provider.findNodesByName('ChildAttr').length, 1);

    const token = provider.applyOptimisticDelete(nodeA, 'op-delete-parent');
    assert.ok(token);

    // Child must also be gone from search
    assert.strictEqual(provider.findNodesByName('ChildAttr').length, 0, 'Child must be removed from name index');
    assert.strictEqual(provider.searchByName('childattr').length, 0, 'Child must be removed from fuzzy search');

    // Rollback
    const rolledBack = provider.rollbackOptimisticDelete(token!);
    assert.strictEqual(rolledBack, true);

    const restoredChild = provider.findNodesByName('ChildAttr');
    assert.strictEqual(restoredChild.length, 1, 'Restored child must be searchable again');
    assert.notStrictEqual(restoredChild[0], childA, 'Restored child must be rehydrated instance');
  });

  test('TreeCacheService removeNode and replaceNode preserves other root candidates and cleans up descendants', () => {
    cache.buildCache(rootA);
    cache.buildCache(rootB);

    assert.strictEqual(cache.findByName('Shared').length, 2);
    assert.strictEqual(cache.findById('CommonModules.Shared'), nodeB, 'Initially points to last-built candidate nodeB');

    // Remove nodeB: nodeCache must fall back to remaining candidate nodeA
    cache.removeNode(nodeB);

    assert.strictEqual(cache.contains(nodeB), false, 'nodeB must not be contained in cache');
    assert.strictEqual(cache.contains(nodeA), true, 'nodeA must still be contained in cache');
    assert.strictEqual(cache.findById('CommonModules.Shared'), nodeA, 'findById must fall back to remaining candidate nodeA');
    assert.deepStrictEqual(cache.findByName('Shared'), [nodeA], 'findByName must only return nodeA');

    // Replace nodeA with updatedNodeA
    const updatedNodeA: TreeNode = {
      id: 'CommonModules.Shared',
      name: 'SharedRenamed',
      type: MetadataType.CommonModule,
      filePath: nodeA.filePath,
      properties: {},
      parent: rootA,
    };
    cache.replaceNode(nodeA, updatedNodeA);

    assert.strictEqual(cache.contains(nodeA), false);
    assert.strictEqual(cache.contains(updatedNodeA), true);
    assert.deepStrictEqual(cache.findByName('Shared'), []);
    assert.deepStrictEqual(cache.findByName('SharedRenamed'), [updatedNodeA]);
  });

  test('handleGotoHandlerMessage does not navigate to deleted node after optimistic delete', async () => {
    const provider = new MetadataTreeDataProvider();
    provider.setRootNodes([rootA, rootB], new Map([
      ['root-main', { configPath: pathA, format: ConfigFormat.Designer }],
      ['root-ext', { configPath: pathB, format: ConfigFormat.Designer }],
    ]));

    // Optimistically delete nodeA
    provider.applyOptimisticDelete(nodeA, 'op-delete-goto');

    const openedUris: vscode.Uri[] = [];
    const origOpen = vscode.workspace.openTextDocument;
    (vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
      openedUris.push(uri);
      return { lineCount: 1, lineAt: () => ({ text: '' }), getText: () => '' } as any;
    };
    const origShow = vscode.window.showTextDocument;
    (vscode.window as any).showTextDocument = async () => ({ revealRange: () => {}, selection: {} });

    try {
      await handleGotoHandlerMessage(
        { type: 'gotoHandler', handler: 'CommonModule.Shared.DoWork' },
        createMockHandlerContext(provider, nodeA)
      );
      // Because nodeA is deleted, if any URI is opened, it must NOT be from Root A
      for (const uri of openedUris) {
        assert.ok(!uri.fsPath.includes(pathA), `Must not open deleted node path (${pathA}), opened: ${uri.fsPath}`);
      }
    } finally {
      (vscode.workspace as any).openTextDocument = origOpen;
      (vscode.window as any).showTextDocument = origShow;
    }
  });

  test('invalidateLoadedChildren cleans up previous children so renamed/deleted nodes are not returned by findByName, searchByName, or gotoHandler', async () => {
    const provider = new MetadataTreeDataProvider();
    const folderA: TreeNode = {
      id: 'CommonModules-A',
      name: 'CommonModules',
      type: MetadataType.CommonModule,
      children: [nodeA],
      properties: { _indexLoaded: true } as any,
    };
    nodeA.parent = folderA;
    rootA.children = [folderA];
    folderA.parent = rootA;

    const folderB: TreeNode = {
      id: 'CommonModules-B',
      name: 'CommonModules',
      type: MetadataType.CommonModule,
      children: [nodeB],
      properties: { _indexLoaded: true } as any,
    };
    nodeB.parent = folderB;
    rootB.children = [folderB];
    folderB.parent = rootB;

    provider.setRootNodes([rootA, rootB], new Map([
      ['root-main', { configPath: pathA, format: ConfigFormat.Designer }],
      ['root-ext', { configPath: pathB, format: ConfigFormat.Designer }],
    ]));

    // Initially both nodeA and nodeB are in cache
    assert.strictEqual(provider.findNodesByName('Shared').length, 2);

    // Invalidate loaded children for folderA
    provider.invalidateLoadedChildren(folderA);

    // After invalidation, folderA.children was cleared. Old children must be removed from cache immediately!
    const nodesAfterInvalidate = provider.findNodesByName('Shared');
    assert.strictEqual(nodesAfterInvalidate.length, 1, 'nodeA must be purged from cache on invalidateLoadedChildren');
    assert.strictEqual(nodesAfterInvalidate[0], nodeB, 'nodeB from rootB must remain in cache');

    // Simulate reloading children where nodeA was renamed to SharedRenamed
    const nodeA2: TreeNode = {
      id: 'CommonModules.SharedRenamed',
      name: 'SharedRenamed',
      type: MetadataType.CommonModule,
      filePath: path.join(pathA, 'CommonModules', 'SharedRenamed.xml'),
      properties: {},
      parent: folderA,
    };
    folderA.children = [nodeA2];
    (provider as any).cache.buildCache(nodeA2);

    // Verify search results
    const sharedResults = provider.findNodesByName('Shared');
    assert.strictEqual(sharedResults.length, 1, 'Only nodeB must match Shared');
    assert.strictEqual(sharedResults[0], nodeB);

    const searchResults = provider.searchByName('shared');
    assert.strictEqual(searchResults.length, 2, 'Must match Shared (nodeB) and SharedRenamed (nodeA2)');
    assert.ok(searchResults.includes(nodeB));
    assert.ok(searchResults.includes(nodeA2));
    assert.ok(!searchResults.includes(nodeA), 'Stale nodeA must NOT appear in searchByName');

    // Test gotoHandler with context from rootA
    const openedUris: vscode.Uri[] = [];
    const origOpen = vscode.workspace.openTextDocument;
    (vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
      openedUris.push(uri);
      return { lineCount: 1, lineAt: () => ({ text: '' }), getText: () => '' } as any;
    };
    const origShow = vscode.window.showTextDocument;
    (vscode.window as any).showTextDocument = async () => ({ revealRange: () => {}, selection: {} });

    try {
      // gotoHandler for 'SharedRenamed' from rootA should navigate to nodeA2 in pathA
      await handleGotoHandlerMessage(
        { type: 'gotoHandler', handler: 'CommonModule.SharedRenamed.DoWork' },
        createMockHandlerContext(provider, nodeA2),
      );
      assert.strictEqual(openedUris.length, 1);
      assert.ok(openedUris[0].fsPath.includes(pathA), `Must open module from pathA, got: ${openedUris[0].fsPath}`);

      // gotoHandler for 'Shared' from rootA: nodeA is deleted, should NOT navigate to nodeA
      openedUris.length = 0;
      await handleGotoHandlerMessage(
        { type: 'gotoHandler', handler: 'CommonModule.Shared.DoWork' },
        createMockHandlerContext(provider, folderA),
      );
      for (const uri of openedUris) {
        assert.ok(!uri.fsPath.includes(path.join(pathA, 'CommonModules', 'Shared.xml')), `Must not open stale nodeA path, got: ${uri.fsPath}`);
      }
    } finally {
      (vscode.workspace as any).openTextDocument = origOpen;
      (vscode.window as any).showTextDocument = origShow;
    }
  });
});


