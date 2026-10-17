import * as assert from 'assert';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import type { ConfigurationId } from '../../src/services/configurationSession/types';

function createConfigRoot(
  id: string,
  name: string,
  filePath: string,
  children: TreeNode[] = [],
): TreeNode {
  const rootChildren: TreeNode[] = [];
  const root: TreeNode = {
    id,
    name,
    type: MetadataType.Configuration,
    filePath,
    properties: {},
    children: rootChildren,
  };
  for (const child of children) {
    child.parent = root;
    rootChildren.push(child);
  }
  return root;
}

function createNode(
  id: string,
  name: string,
  type: MetadataType,
  options: {
    synonym?: string;
    comment?: string;
    filePath?: string;
    content?: unknown;
    children?: TreeNode[];
  } = {},
): TreeNode {
  const children: TreeNode[] = [];
  const node: TreeNode = {
    id,
    name,
    type,
    filePath: options.filePath,
    properties: {
      synonym: options.synonym,
      comment: options.comment,
      Content: options.content,
    },
    children,
  };
  for (const child of options.children ?? []) {
    child.parent = node;
    children.push(child);
  }
  return node;
}

suite('Tree Filter Collision Safety (#244)', () => {
  let provider: MetadataTreeDataProvider;

  teardown(() => {
    provider?.dispose();
  });

  test('1. Visibility of CommonModules.Shared in Root A does not leak to Root B in search filter', async () => {
    provider = new MetadataTreeDataProvider('linux');

    const modA = createNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, {
      synonym: 'SpecialAlpha',
      filePath: '/workspace/projectA/CommonModules/Shared.xml',
    });
    const folderA = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
      children: [modA],
    });
    const rootA = createConfigRoot('rootA', 'ProjectA', '/workspace/projectA/Configuration.xml', [folderA]);

    const modB = createNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, {
      synonym: 'OtherBeta',
      filePath: '/workspace/projectB/CommonModules/Shared.xml',
    });
    const folderB = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
      children: [modB],
    });
    const rootB = createConfigRoot('rootB', 'ProjectB', '/workspace/projectB/Configuration.xml', [folderB]);

    provider.setRootNodes([rootA, rootB]);

    // Search by synonym 'SpecialAlpha'
    provider.setSearchOptions({ bySynonymComment: true });
    provider.setSearchQuery('SpecialAlpha');

    const childrenA = await provider.getChildren(folderA);
    assert.strictEqual(childrenA.length, 1, 'modA must be visible under folderA');
    assert.strictEqual(childrenA[0], modA);

    const childrenB = await provider.getChildren(folderB);
    assert.strictEqual(childrenB.length, 0, 'modB must NOT be visible under folderB because it does not match SpecialAlpha');

    const visibleNodes = provider.getVisibleNodesInOrder();
    assert.ok(visibleNodes.includes(modA), 'modA must be in visible nodes');
    assert.ok(!visibleNodes.includes(modB), 'modB must NOT be in visible nodes');
  });

  test('2. Type filter isolates colliding node IDs across configurations', async () => {
    provider = new MetadataTreeDataProvider('linux');

    const catA = createNode('Custom.Item', 'Item', MetadataType.Catalog, {
      filePath: '/workspace/projectA/Catalogs/Item.xml',
    });
    const folderA = createNode('Catalogs', 'Справочники', MetadataType.Catalog, {
      children: [catA],
    });
    const rootA = createConfigRoot('rootA', 'ProjectA', '/workspace/projectA/Configuration.xml', [folderA]);

    const docB = createNode('Custom.Item', 'Item', MetadataType.Document, {
      filePath: '/workspace/projectB/Documents/Item.xml',
    });
    const folderB = createNode('Documents', 'Документы', MetadataType.Document, {
      children: [docB],
    });
    const rootB = createConfigRoot('rootB', 'ProjectB', '/workspace/projectB/Configuration.xml', [folderB]);

    provider.setRootNodes([rootA, rootB]);

    // Filter by Catalog only
    provider.setTypeFilter([MetadataType.Catalog]);

    const childrenA = await provider.getChildren(folderA);
    assert.strictEqual(childrenA.length, 1, 'catA must be visible under folderA');
    assert.strictEqual(childrenA[0], catA);

    const childrenB = await provider.getChildren(folderB);
    assert.strictEqual(childrenB.length, 0, 'docB must NOT be visible under folderB when filtered by Catalog');

    const visibleNodes = provider.getVisibleNodesInOrder();
    assert.ok(visibleNodes.includes(catA), 'catA must be visible');
    assert.ok(!visibleNodes.includes(docB), 'docB must NOT be visible');
  });

  test('3. Subsystem filter in Root A uses Content of Subsystem A only and does not leak to Root B', async () => {
    provider = new MetadataTreeDataProvider('linux');

    const sharedModA = createNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, {
      filePath: '/workspace/projectA/CommonModules/Shared.xml',
    });
    const otherModA = createNode('CommonModules.Other', 'Other', MetadataType.CommonModule, {
      filePath: '/workspace/projectA/CommonModules/Other.xml',
    });
    const folderA = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
      children: [sharedModA, otherModA],
    });
    const subA = createNode('Subsystems.Main', 'Main', MetadataType.Subsystem, {
      filePath: '/workspace/projectA/Subsystems/Main.xml',
      content: {
        'xr:Item': [{ '#text': 'CommonModule.Shared' }],
      },
    });
    const subFolderA = createNode('Subsystems', 'Подсистемы', MetadataType.Subsystem, {
      children: [subA],
    });
    const rootA = createConfigRoot('rootA', 'ProjectA', '/workspace/projectA/Configuration.xml', [folderA, subFolderA]);

    const sharedModB = createNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, {
      filePath: '/workspace/projectB/CommonModules/Shared.xml',
    });
    const otherModB = createNode('CommonModules.Other', 'Other', MetadataType.CommonModule, {
      filePath: '/workspace/projectB/CommonModules/Other.xml',
    });
    const folderB = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
      children: [sharedModB, otherModB],
    });
    const subB = createNode('Subsystems.Main', 'Main', MetadataType.Subsystem, {
      filePath: '/workspace/projectB/Subsystems/Main.xml',
      content: {
        'xr:Item': [{ '#text': 'CommonModule.Other' }],
      },
    });
    const subFolderB = createNode('Subsystems', 'Подсистемы', MetadataType.Subsystem, {
      children: [subB],
    });
    const rootB = createConfigRoot('rootB', 'ProjectB', '/workspace/projectB/Configuration.xml', [folderB, subFolderB]);

    provider.setRootNodes([rootA, rootB]);

    // Apply subsystem filter targeting subA from rootA
    await provider.setSubsystemFilter(subA.id, subA.name, subA);

    // Root A check: sharedModA is in subA Content -> visible; otherModA -> hidden
    const childrenA = await provider.getChildren(folderA);
    assert.strictEqual(childrenA.length, 1, 'Only sharedModA should be visible under folderA');
    assert.strictEqual(childrenA[0], sharedModA);

    // Root B check: rootB is NOT the filtered configuration -> nothing in rootB should pass subA's filter
    const childrenB = await provider.getChildren(folderB);
    assert.strictEqual(childrenB.length, 0, 'No module in folderB should be visible under rootA subsystem filter');

    const visibleRoots = await provider.getChildren();
    assert.ok(visibleRoots.includes(rootA), 'rootA must be visible');
    assert.ok(!visibleRoots.includes(rootB), 'rootB must NOT be visible under rootA subsystem filter');
  });

  test('4. getVisibleNodesInOrder preserves both collision nodes with correct root identities', async () => {
    provider = new MetadataTreeDataProvider('linux');

    const modA = createNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, {
      filePath: '/workspace/projectA/CommonModules/Shared.xml',
    });
    const folderA = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
      children: [modA],
    });
    const rootA = createConfigRoot('rootA', 'ProjectA', '/workspace/projectA/Configuration.xml', [folderA]);

    const modB = createNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, {
      filePath: '/workspace/projectB/CommonModules/Shared.xml',
    });
    const folderB = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
      children: [modB],
    });
    const rootB = createConfigRoot('rootB', 'ProjectB', '/workspace/projectB/Configuration.xml', [folderB]);

    provider.setRootNodes([rootA, rootB]);

    // Both match query 'Shared'
    provider.setSearchQuery('Shared');

    const visibleNodes = provider.getVisibleNodesInOrder();
    const commonModulesInOrder = visibleNodes.filter((n) => n.id === 'CommonModules.Shared');

    assert.strictEqual(commonModulesInOrder.length, 2, 'Both collision nodes must be present in visible nodes');
    assert.strictEqual(commonModulesInOrder[0], modA, 'First node must be modA from rootA');
    assert.strictEqual(commonModulesInOrder[1], modB, 'Second node must be modB from rootB');
  });

  test('5. Results are invariant to root registration order ([A, B] vs [B, A])', async () => {
    async function runWithOrder(firstIsA: boolean) {
      const p = new MetadataTreeDataProvider('linux');
      try {
        const modA = createNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, {
          synonym: 'SpecialAlpha',
          filePath: '/workspace/projectA/CommonModules/Shared.xml',
        });
        const folderA = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
          children: [modA],
        });
        const rootA = createConfigRoot('rootA', 'ProjectA', '/workspace/projectA/Configuration.xml', [folderA]);

        const modB = createNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, {
          synonym: 'OtherBeta',
          filePath: '/workspace/projectB/CommonModules/Shared.xml',
        });
        const folderB = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
          children: [modB],
        });
        const rootB = createConfigRoot('rootB', 'ProjectB', '/workspace/projectB/Configuration.xml', [folderB]);

        if (firstIsA) {
          p.setRootNodes([rootA, rootB]);
        } else {
          p.setRootNodes([rootB, rootA]);
        }

        p.setSearchOptions({ bySynonymComment: true });
        p.setSearchQuery('SpecialAlpha');

        const childrenA = await p.getChildren(folderA);
        assert.strictEqual(childrenA.length, 1, `Order firstIsA=${firstIsA}: modA must be visible under folderA`);
        assert.strictEqual(childrenA[0], modA);

        const childrenB = await p.getChildren(folderB);
        assert.strictEqual(childrenB.length, 0, `Order firstIsA=${firstIsA}: modB must NOT be visible under folderB`);
      } finally {
        p.dispose();
      }
    }

    await runWithOrder(true);
    await runWithOrder(false);
  });

  test('6. POSIX case-sensitive roots (/tmp/Config vs /tmp/config) filter independently without collision', async () => {
    provider = new MetadataTreeDataProvider('linux');

    const modUpper = createNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, {
      synonym: 'UpperOnly',
      filePath: '/tmp/Config/CommonModules/Shared.xml',
    });
    const folderUpper = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
      children: [modUpper],
    });
    const rootUpper = createConfigRoot('rootUpper', 'Upper', '/tmp/Config/Configuration.xml', [folderUpper]);

    const modLower = createNode('CommonModules.Shared', 'Shared', MetadataType.CommonModule, {
      synonym: 'LowerOnly',
      filePath: '/tmp/config/CommonModules/Shared.xml',
    });
    const folderLower = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
      children: [modLower],
    });
    const rootLower = createConfigRoot('rootLower', 'Lower', '/tmp/config/Configuration.xml', [folderLower]);

    provider.setRootNodes([rootUpper, rootLower]);

    provider.setSearchOptions({ bySynonymComment: true });
    provider.setSearchQuery('UpperOnly');

    const childrenUpper = await provider.getChildren(folderUpper);
    assert.strictEqual(childrenUpper.length, 1, 'modUpper must be visible');
    assert.strictEqual(childrenUpper[0], modUpper);

    const childrenLower = await provider.getChildren(folderLower);
    assert.strictEqual(childrenLower.length, 0, 'modLower must NOT be visible under rootLower when searching UpperOnly');
  });

  test('7. Subsystem filter rebinds to new node on root reload so Content updates are reflected', async () => {
    provider = new MetadataTreeDataProvider('linux');

    const modOld = createNode('CommonModules.OldMod', 'OldMod', MetadataType.CommonModule, {
      filePath: '/workspace/projectA/CommonModules/OldMod.xml',
    });
    const modNew = createNode('CommonModules.NewMod', 'NewMod', MetadataType.CommonModule, {
      filePath: '/workspace/projectA/CommonModules/NewMod.xml',
    });
    const folderA = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
      children: [modOld, modNew],
    });
    const subA = createNode('Subsystems.Main', 'Main', MetadataType.Subsystem, {
      filePath: '/workspace/projectA/Subsystems/Main.xml',
      content: {
        'xr:Item': [{ '#text': 'CommonModule.OldMod' }],
      },
    });
    const subFolderA = createNode('Subsystems', 'Подсистемы', MetadataType.Subsystem, {
      children: [subA],
    });
    const rootA = createConfigRoot('rootA', 'ProjectA', '/workspace/projectA/Configuration.xml', [folderA, subFolderA]);

    provider.setRootNodes([rootA]);
    await provider.setSubsystemFilter(subA.id, subA.name, subA);

    // Initial check: OldMod visible, NewMod hidden
    const initialChildren = await provider.getChildren(folderA);
    assert.strictEqual(initialChildren.length, 1);
    assert.strictEqual(initialChildren[0], modOld);

    // Now reload root with updated Subsystem Content pointing to NewMod instead of OldMod
    const modOld2 = createNode('CommonModules.OldMod', 'OldMod', MetadataType.CommonModule, {
      filePath: '/workspace/projectA/CommonModules/OldMod.xml',
    });
    const modNew2 = createNode('CommonModules.NewMod', 'NewMod', MetadataType.CommonModule, {
      filePath: '/workspace/projectA/CommonModules/NewMod.xml',
    });
    const folderA2 = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
      children: [modOld2, modNew2],
    });
    const subA2 = createNode('Subsystems.Main', 'Main', MetadataType.Subsystem, {
      filePath: '/workspace/projectA/Subsystems/Main.xml',
      content: {
        'xr:Item': [{ '#text': 'CommonModule.NewMod' }],
      },
    });
    const subFolderA2 = createNode('Subsystems', 'Подсистемы', MetadataType.Subsystem, {
      children: [subA2],
    });
    const rootA2 = createConfigRoot('rootA', 'ProjectA', '/workspace/projectA/Configuration.xml', [folderA2, subFolderA2]);

    provider.setRootNodes([rootA2]);

    // Check after reload: NewMod must be visible, OldMod must NOT be visible
    const reloadedChildren = await provider.getChildren(folderA2);
    assert.strictEqual(reloadedChildren.length, 1, 'Only NewMod should be visible after subsystem content update');
    assert.strictEqual(reloadedChildren[0], modNew2, 'modNew2 must be visible');

    // Test subsystem removal on reload: if Subsystem is deleted in root, old content does not pass
    const folderA3 = createNode('CommonModules', 'Общие модули', MetadataType.CommonModule, {
      children: [modOld2, modNew2],
    });
    const rootA3 = createConfigRoot('rootA', 'ProjectA', '/workspace/projectA/Configuration.xml', [folderA3]);
    provider.setRootNodes([rootA3]);

    const childrenAfterDelete = await provider.getChildren(folderA3);
    assert.strictEqual(childrenAfterDelete.length, 0, 'No module should pass when filtered subsystem was deleted');
  });
});

