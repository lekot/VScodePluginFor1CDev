import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { TreeCacheService } from '../../src/providers/treeCacheService';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import type { TreeLoadContext } from '../../src/types/treeLoadContext';

import type { ConfigurationId } from '../../src/services/configurationSession/types';

function createConfigRoot(
  id: string,
  name: string,
  filePath: string,
  children: TreeNode[] = [],
  configurationId?: string,
): TreeNode {
  const rootChildren: TreeNode[] = [];
  const root: TreeNode = {
    id,
    name,
    type: MetadataType.Configuration,
    filePath,
    configurationId: configurationId as ConfigurationId | undefined,
    properties: {},
    children: rootChildren,
  };
  for (const child of children) {
    child.parent = root;
    rootChildren.push(child);
  }
  return root;
}

function createItemNode(
  id: string,
  name: string,
  type: MetadataType,
  filePath?: string,
  children: TreeNode[] = [],
): TreeNode {
  const nodeChildren: TreeNode[] = [];
  const node: TreeNode = {
    id,
    name,
    type,
    filePath,
    properties: {},
    children: nodeChildren,
  };
  for (const child of children) {
    child.parent = node;
    nodeChildren.push(child);
  }
  return node;
}

suite('Tree POSIX Root Identity (#243)', () => {
  test('1. On Linux/POSIX, roots differing only by case have distinct tree root identities', () => {
    const cacheLinux = new TreeCacheService('linux');
    const upperRoot = createConfigRoot('root-upper', 'Upper', '/tmp/Config/Configuration.xml');
    const lowerRoot = createConfigRoot('root-lower', 'Lower', '/tmp/config/Configuration.xml');

    const upperIdentity = cacheLinux.getNodeRootIdentity(upperRoot);
    const lowerIdentity = cacheLinux.getNodeRootIdentity(lowerRoot);

    assert.notStrictEqual(
      upperIdentity,
      lowerIdentity,
      'POSIX synthetic roots with different case must produce distinct identities',
    );
    assert.strictEqual(upperIdentity, 'path:/tmp/Config');
    assert.strictEqual(lowerIdentity, 'path:/tmp/config');

    // Also verify when filePath is directory itself
    const upperDirRoot = createConfigRoot('root-dir-upper', 'Upper', '/tmp/Config');
    const lowerDirRoot = createConfigRoot('root-dir-lower', 'Lower', '/tmp/config');
    assert.notStrictEqual(
      cacheLinux.getNodeRootIdentity(upperDirRoot),
      cacheLinux.getNodeRootIdentity(lowerDirRoot),
    );
    assert.strictEqual(cacheLinux.getNodeRootIdentity(upperDirRoot), 'path:/tmp/Config');
    assert.strictEqual(cacheLinux.getNodeRootIdentity(lowerDirRoot), 'path:/tmp/config');
  });

  test('2. On Windows, case aliases of the same path resolve to the identical root identity', () => {
    const cacheWin = new TreeCacheService('win32');
    const upperRoot = createConfigRoot('root-win-upper', 'Upper', 'C:\\Workspace\\Config\\Configuration.xml');
    const lowerRoot = createConfigRoot('root-win-lower', 'Lower', 'c:\\workspace\\config\\Configuration.xml');

    const upperIdentity = cacheWin.getNodeRootIdentity(upperRoot);
    const lowerIdentity = cacheWin.getNodeRootIdentity(lowerRoot);

    assert.strictEqual(
      upperIdentity,
      lowerIdentity,
      'Windows case aliases must resolve to identical root identity',
    );
    assert.strictEqual(upperIdentity, 'path:c:\\workspace\\config');
  });

  test('3. findByName and searchByName with context prioritize matching POSIX root on collision', () => {
    const cacheLinux = new TreeCacheService('linux');
    const upperNode = createItemNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, '/tmp/Config/CommonModules/Shared.xml');
    const lowerNode = createItemNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, '/tmp/config/CommonModules/Shared.xml');

    const upperRoot = createConfigRoot('root-upper', 'Upper', '/tmp/Config/Configuration.xml', [upperNode]);
    const lowerRoot = createConfigRoot('root-lower', 'Lower', '/tmp/config/Configuration.xml', [lowerNode]);

    cacheLinux.buildCache(upperRoot);
    cacheLinux.buildCache(lowerRoot);

    // Context by TreeNode
    const foundByLowerNode = cacheLinux.findByName('Shared', lowerNode);
    assert.strictEqual(foundByLowerNode[0], lowerNode, 'lowerNode must be first when queried with lowerNode context');

    const foundByUpperNode = cacheLinux.findByName('Shared', upperNode);
    assert.strictEqual(foundByUpperNode[0], upperNode, 'upperNode must be first when queried with upperNode context');

    // Context by path string
    const foundByLowerPath = cacheLinux.findByName('Shared', '/tmp/config');
    assert.strictEqual(foundByLowerPath[0], lowerNode, 'lowerNode must be first when queried with /tmp/config path context');

    const foundByUpperPath = cacheLinux.findByName('Shared', '/tmp/Config');
    assert.strictEqual(foundByUpperPath[0], upperNode, 'upperNode must be first when queried with /tmp/Config path context');

    // searchByName
    const searchedByLowerPath = cacheLinux.searchByName('share', '/tmp/config');
    assert.strictEqual(searchedByLowerPath[0], lowerNode, 'searchByName with /tmp/config path context must prioritize lowerNode');

    const searchedByUpperPath = cacheLinux.searchByName('share', '/tmp/Config');
    assert.strictEqual(searchedByUpperPath[0], upperNode, 'searchByName with /tmp/Config path context must prioritize upperNode');
  });

  test('4. rollbackOptimisticDelete restores node only into originating root when parentId collides', () => {
    const provider = new MetadataTreeDataProvider('linux');

    const upperParent = createItemNode('Catalogs', 'Справочники', MetadataType.Catalog);
    const upperChild = createItemNode('Catalogs.ItemA', 'ItemA', MetadataType.Catalog);
    upperParent.children = [upperChild];
    upperChild.parent = upperParent;

    const lowerParent = createItemNode('Catalogs', 'Справочники', MetadataType.Catalog);
    const lowerChild = createItemNode('Catalogs.ItemB', 'ItemB', MetadataType.Catalog);
    lowerParent.children = [lowerChild];
    lowerChild.parent = lowerParent;

    const upperRoot = createConfigRoot('root-upper', 'Upper', '/tmp/Config/Configuration.xml', [upperParent]);
    const lowerRoot = createConfigRoot('root-lower', 'Lower', '/tmp/config/Configuration.xml', [lowerParent]);

    provider.setRootNodes([upperRoot, lowerRoot]);

    // Delete item from lower root
    const token = provider.applyOptimisticDelete(lowerChild, 'op-delete-lower');
    assert.ok(token, 'Optimistic delete token must be generated');
    assert.strictEqual(token.configRootId, 'path:/tmp/config');
    assert.deepStrictEqual((lowerParent.children ?? []).map((c) => c.id), []);
    assert.deepStrictEqual((upperParent.children ?? []).map((c) => c.id), ['Catalogs.ItemA']);

    // Rollback
    const rolledBack = provider.rollbackOptimisticDelete(token);
    assert.strictEqual(rolledBack, true, 'Rollback must succeed');
    assert.deepStrictEqual(
      (lowerParent.children ?? []).map((c) => c.id),
      ['Catalogs.ItemB'],
      'Restored node must be in lower parent',
    );
    assert.deepStrictEqual(
      (upperParent.children ?? []).map((c) => c.id),
      ['Catalogs.ItemA'],
      'Upper parent children must remain unchanged',
    );
    provider.dispose();
  });

  test('5. Results are invariant to root insertion order (A then B vs B then A)', () => {
    function testOrder(firstIsUpper: boolean) {
      const cache = new TreeCacheService('linux');
      const upperNode = createItemNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, '/tmp/Config/CommonModules/Shared.xml');
      const lowerNode = createItemNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, '/tmp/config/CommonModules/Shared.xml');
      const upperRoot = createConfigRoot('root-upper', 'Upper', '/tmp/Config/Configuration.xml', [upperNode]);
      const lowerRoot = createConfigRoot('root-lower', 'Lower', '/tmp/config/Configuration.xml', [lowerNode]);

      if (firstIsUpper) {
        cache.buildCache(upperRoot);
        cache.buildCache(lowerRoot);
      } else {
        cache.buildCache(lowerRoot);
        cache.buildCache(upperRoot);
      }

      const queryLower = cache.findByName('Shared', '/tmp/config');
      assert.strictEqual(queryLower[0], lowerNode, `Order firstIsUpper=${firstIsUpper}: lowerNode must come first for /tmp/config`);

      const queryUpper = cache.findByName('Shared', '/tmp/Config');
      assert.strictEqual(queryUpper[0], upperNode, `Order firstIsUpper=${firstIsUpper}: upperNode must come first for /tmp/Config`);
    }

    testOrder(true);
    testOrder(false);
  });

  test('6. Architecture regression guard: prohibits local .toLowerCase() for root identity and enforces configurationPathKey', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const treeCacheFile = path.join(repoRoot, 'src', 'providers', 'treeCacheService.ts');
    const treeProviderFile = path.join(repoRoot, 'src', 'providers', 'treeDataProvider.ts');

    const cacheSource = fs.readFileSync(treeCacheFile, 'utf8');
    const providerSource = fs.readFileSync(treeProviderFile, 'utf8');

    // Neither file should have .toLowerCase() used on paths or identities
    // Check that normalizeIdentityPath does not do .toLowerCase()
    assert.ok(
      !cacheSource.includes('.replace(/\\\\/g, \'/\').toLowerCase()'),
      'treeCacheService.ts must not unconditionally lowercase paths',
    );
    assert.ok(
      !providerSource.includes('.replace(/\\\\/g, \'/\').toLowerCase()'),
      'treeDataProvider.ts must not unconditionally lowercase paths',
    );

    // Verify both files use configurationPathKey
    assert.ok(
      cacheSource.includes('configurationPathKey('),
      'treeCacheService.ts must delegate path normalization to configurationPathKey',
    );
    assert.ok(
      providerSource.includes('configurationPathKey(') || providerSource.includes('this.cache.getNodeRootIdentity('),
      'treeDataProvider.ts must delegate root identity to cache or configurationPathKey',
    );
  });

  test('7. Edge cases: synthetic root without path, explicit configurationId, and deep descendants', () => {
    const cache = new TreeCacheService('linux');
    const syntheticRoot = createConfigRoot('synthetic-root-id', 'Synthetic', '');
    delete (syntheticRoot as any).filePath;

    assert.strictEqual(
      cache.getNodeRootIdentity(syntheticRoot),
      'node:synthetic-root-id',
      'Synthetic root without path or context must preserve node.id without path normalization',
    );

    const configuredRoot = createConfigRoot('cfg-root', 'Configured', '/tmp/any', [], 'cfg-explicit-id');
    assert.strictEqual(
      cache.getNodeRootIdentity(configuredRoot),
      'configuration:cfg-explicit-id',
      'Root with explicit configurationId must use configuration: prefix',
    );

    // Deep descendant
    const leaf = createItemNode('Attr.Item', 'Item', MetadataType.Attribute);
    const group = createItemNode('Catalogs.Parent', 'Parent', MetadataType.Catalog, undefined, [leaf]);
    const root = createConfigRoot('root-posix', 'Posix', '/tmp/MyProject/Configuration.xml', [group]);
    cache.buildCache(root);

    assert.strictEqual(
      cache.getNodeRootIdentity(leaf),
      'path:/tmp/MyProject',
      'Leaf node must inherit root identity from top configuration root',
    );
  });
});
