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
});
