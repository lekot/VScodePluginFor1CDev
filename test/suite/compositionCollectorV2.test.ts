import * as assert from 'assert';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import {
  collectTypeFolders,
  collectObjectsForType,
  buildAncestorIds,
  SUBSYSTEM_ELIGIBLE_TYPES,
} from '../../src/compositionEditor/compositionObjectCollector';
import type { CompositionObjectEntry } from '../../src/compositionEditor/compositionContracts';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeNode(
  id: string,
  name: string,
  type: MetadataType,
  children?: TreeNode[],
  filePath?: string,
): TreeNode {
  const node: TreeNode = { id, name, type, properties: {}, children, filePath };
  if (children) {
    for (const c of children) {
      c.parent = node;
    }
  }
  return node;
}

/**
 * Build a simple tree under one config path.
 *
 * Structure:
 *   root (Configuration)
 *     Catalogs (type-folder, Catalog)
 *       Cat1 (Catalog)
 *       Cat2 (Catalog)
 *     Documents (type-folder, Document)
 *       Doc1 (Document)
 *     Subsystems (type-folder, Subsystem)
 *       Parent (Subsystem)
 *         Child (Subsystem)
 */
function makeMainTree(configPath: string): {
  root: TreeNode;
  catalogsFolder: TreeNode;
  documentsFolder: TreeNode;
  subsystemsFolder: TreeNode;
  parentSub: TreeNode;
  childSub: TreeNode;
} {
  const cat1 = makeNode('Catalogs.Cat1', 'Cat1', MetadataType.Catalog, undefined, `${configPath}/Catalogs/Cat1.xml`);
  const cat2 = makeNode('Catalogs.Cat2', 'Cat2', MetadataType.Catalog, undefined, `${configPath}/Catalogs/Cat2.xml`);
  const catalogsFolder = makeNode('Catalogs', 'Catalogs', MetadataType.Catalog, [cat1, cat2]);

  const doc1 = makeNode('Documents.Doc1', 'Doc1', MetadataType.Document, undefined, `${configPath}/Documents/Doc1.xml`);
  const documentsFolder = makeNode('Documents', 'Documents', MetadataType.Document, [doc1]);

  const childSub = makeNode(
    'Subsystems.Parent.Child',
    'Child',
    MetadataType.Subsystem,
    [],
    `${configPath}/Subsystems/Parent/Subsystems/Child.xml`,
  );
  const parentSub = makeNode(
    'Subsystems.Parent',
    'Parent',
    MetadataType.Subsystem,
    [childSub],
    `${configPath}/Subsystems/Parent.xml`,
  );
  const subsystemsFolder = makeNode('Subsystems', 'Subsystems', MetadataType.Subsystem, [parentSub]);

  const root = makeNode(
    'root',
    'Configuration',
    MetadataType.Configuration,
    [catalogsFolder, documentsFolder, subsystemsFolder],
    `${configPath}/Configuration.xml`,
  );

  return { root, catalogsFolder, documentsFolder, subsystemsFolder, parentSub, childSub };
}

// ── suite: collectTypeFolders ─────────────────────────────────────────────────

suite('compositionCollectorV2 — collectTypeFolders', () => {
  // 1 ─────────────────────────────────────────────────────────────────────────
  test('empty roots returns []', () => {
    const dummySub = makeNode('Subsystems.X', 'X', MetadataType.Subsystem, []);
    const result = collectTypeFolders([], dummySub, null, new Set(), SUBSYSTEM_ELIGIBLE_TYPES, true);
    assert.deepStrictEqual(result, []);
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test('TypeFolder without children → objectCount: null', () => {
    const configPath = 'C:/cfg/main';
    // No children on catalogsFolder (undefined, not [])
    const catalogsFolder = makeNode('Catalogs', 'Catalogs', MetadataType.Catalog, undefined);
    const root = makeNode(
      'root',
      'Configuration',
      MetadataType.Configuration,
      [catalogsFolder],
      `${configPath}/Configuration.xml`,
    );
    const sub = makeNode('Subsystems.S', 'S', MetadataType.Subsystem, []);

    const result = collectTypeFolders([root], sub, configPath, new Set(), SUBSYSTEM_ELIGIBLE_TYPES, true);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].objectCount, null);
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test('TypeFolder with children → objectCount === children.length', () => {
    const configPath = 'C:/cfg/main';
    const { root, childSub } = makeMainTree(configPath);

    const result = collectTypeFolders([root], childSub, configPath, new Set(), SUBSYSTEM_ELIGIBLE_TYPES, true);

    const catalogsContainer = result.find(c => c.displayName === 'Catalogs');
    assert.ok(catalogsContainer, 'Catalogs container must exist');
    assert.strictEqual(catalogsContainer!.objectCount, 2); // cat1 + cat2

    const documentsContainer = result.find(c => c.displayName === 'Documents');
    assert.ok(documentsContainer, 'Documents container must exist');
    assert.strictEqual(documentsContainer!.objectCount, 1); // doc1
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test('checkedCount — counts refs matching metadataType prefix', () => {
    const configPath = 'C:/cfg/main';
    const { root, childSub } = makeMainTree(configPath);

    const checkedRefs = new Set([
      'Catalog.Cat1',
      'Catalog.Cat2',
      'Document.Doc1',
      'Subsystem.Child',
    ]);

    const result = collectTypeFolders([root], childSub, configPath, checkedRefs, SUBSYSTEM_ELIGIBLE_TYPES, true);

    const catalogsContainer = result.find(c => c.displayName === 'Catalogs');
    assert.strictEqual(catalogsContainer!.checkedCount, 2, 'Two catalogs checked');

    const documentsContainer = result.find(c => c.displayName === 'Documents');
    assert.strictEqual(documentsContainer!.checkedCount, 1, 'One document checked');

    const subsystemsContainer = result.find(c => c.displayName === 'Subsystems');
    assert.strictEqual(subsystemsContainer!.checkedCount, 1, 'One subsystem checked');
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  test('subsystem in main config — sees only its own root', () => {
    const mainPath = 'C:/cfg/main';
    const extPath = 'C:/cfg/ext';

    const { root: mainRoot, childSub: mainSub } = makeMainTree(mainPath);

    const extCat = makeNode('Catalogs.ExtCat', 'ExtCat', MetadataType.Catalog, undefined, `${extPath}/Catalogs/ExtCat.xml`);
    const extCatFolder = makeNode('Catalogs', 'ExtCatalogs', MetadataType.Catalog, [extCat]);
    const extRoot = makeNode(
      'extroot',
      'Extension',
      MetadataType.Configuration,
      [extCatFolder],
      `${extPath}/Configuration.xml`,
    );

    // mainSub belongs to main config → configPath === mainPath
    const result = collectTypeFolders([mainRoot, extRoot], mainSub, mainPath, new Set(), SUBSYSTEM_ELIGIBLE_TYPES, true);

    const displayNames = result.map(c => c.displayName);
    assert.ok(!displayNames.includes('ExtCatalogs'), 'Main config subsystem must NOT see extension folders');
    assert.ok(displayNames.includes('Catalogs'), 'Main config subsystem must see own folders');
  });

  // 6 ─────────────────────────────────────────────────────────────────────────
  test('subsystem in extension — sees all roots', () => {
    const mainPath = 'C:/cfg/main';
    const extPath = 'C:/cfg/ext';

    const mainCat = makeNode('Catalogs.MainCat', 'MainCat', MetadataType.Catalog, undefined, `${mainPath}/Catalogs/MainCat.xml`);
    const mainCatFolder = makeNode('Catalogs', 'MainCatalogs', MetadataType.Catalog, [mainCat]);
    const mainRoot = makeNode(
      'mainroot',
      'Configuration',
      MetadataType.Configuration,
      [mainCatFolder],
      `${mainPath}/Configuration.xml`,
    );

    const extSub = makeNode('Subsystems.ExtSub', 'ExtSub', MetadataType.Subsystem, [], `${extPath}/Subsystems/ExtSub.xml`);
    const extSubsFolder = makeNode('Subsystems', 'Subsystems', MetadataType.Subsystem, [extSub]);
    const extCat = makeNode('Catalogs.ExtCat', 'ExtCat', MetadataType.Catalog, undefined, `${extPath}/Catalogs/ExtCat.xml`);
    const extCatFolder = makeNode('ExtCatalogs', 'ExtCatalogs', MetadataType.Catalog, [extCat]);
    const extRoot = makeNode(
      'extroot',
      'Extension',
      MetadataType.Configuration,
      [extSubsFolder, extCatFolder],
      `${extPath}/Configuration.xml`,
    );

    // extSub belongs to extension (extPath ≠ mainPath)
    const result = collectTypeFolders([mainRoot, extRoot], extSub, extPath, new Set(), SUBSYSTEM_ELIGIBLE_TYPES, true);

    const displayNames = result.map(c => c.displayName);
    assert.ok(displayNames.includes('MainCatalogs'), 'Extension subsystem must see main config folders');
    assert.ok(displayNames.includes('ExtCatalogs'), 'Extension subsystem must see own folders');
  });

  // 7 ─────────────────────────────────────────────────────────────────────────
  test('non-eligible type folder — not included in result', () => {
    const configPath = 'C:/cfg/main';

    // Interface is NOT in SUBSYSTEM_ELIGIBLE_TYPES
    const ifaceChild = makeNode('Interfaces.Iface1', 'Iface1', MetadataType.Interface, undefined);
    const ifaceFolder = makeNode('Interfaces', 'Interfaces', MetadataType.Interface, [ifaceChild]);
    const catChild = makeNode('Catalogs.Cat1', 'Cat1', MetadataType.Catalog, undefined);
    const catFolder = makeNode('Catalogs', 'Catalogs', MetadataType.Catalog, [catChild]);
    const root = makeNode(
      'root',
      'Configuration',
      MetadataType.Configuration,
      [ifaceFolder, catFolder],
      `${configPath}/Configuration.xml`,
    );
    const sub = makeNode('Subsystems.S', 'S', MetadataType.Subsystem, []);

    const result = collectTypeFolders([root], sub, configPath, new Set(), SUBSYSTEM_ELIGIBLE_TYPES, true);

    const displayNames = result.map(c => c.displayName);
    assert.ok(!displayNames.includes('Interfaces'), 'Interface folder must be excluded');
    assert.ok(displayNames.includes('Catalogs'), 'Catalogs folder must be included');
  });
});

// ── suite: collectObjectsForType ──────────────────────────────────────────────

suite('compositionCollectorV2 — collectObjectsForType', () => {
  // 1 ─────────────────────────────────────────────────────────────────────────
  test('typeFolderId not found → []', () => {
    const configPath = 'C:/cfg/main';
    const { root } = makeMainTree(configPath);

    const result = collectObjectsForType([root], configPath, 'NonExistent.Folder', new Set<string>(), SUBSYSTEM_ELIGIBLE_TYPES, true);
    assert.deepStrictEqual(result, []);
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test('TypeFolder.children undefined → []', () => {
    const configPath = 'C:/cfg/main';

    // Folder with no children (undefined)
    const folderNoChildren = makeNode('Catalogs', 'Catalogs', MetadataType.Catalog, undefined);
    const root = makeNode(
      'root',
      'Configuration',
      MetadataType.Configuration,
      [folderNoChildren],
      `${configPath}/Configuration.xml`,
    );

    const result = collectObjectsForType([root], configPath, 'Catalogs', new Set<string>(), SUBSYSTEM_ELIGIBLE_TYPES, true);
    assert.deepStrictEqual(result, []);
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test('regular type — returns correct CompositionObjectEntry[]', () => {
    const configPath = 'C:/cfg/main';
    const { root } = makeMainTree(configPath);

    const result = collectObjectsForType([root], configPath, 'Catalogs', new Set<string>(), SUBSYSTEM_ELIGIBLE_TYPES, true);

    assert.strictEqual(result.length, 2);
    const refs = result.map(e => e.ref);
    assert.ok(refs.includes('Catalog.Cat1'));
    assert.ok(refs.includes('Catalog.Cat2'));
    // All entries have correct type
    for (const entry of result) {
      assert.strictEqual(entry.type, MetadataType.Catalog);
    }
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test('ancestor subsystems are excluded from results', () => {
    const configPath = 'C:/cfg/main';
    const { root, childSub } = makeMainTree(configPath);

    // Build excludedIds as SubsystemStrategy does: ancestors only (not the node itself)
    const excludedIds = buildAncestorIds(childSub);

    const result = collectObjectsForType([root], configPath, 'Subsystems', excludedIds, SUBSYSTEM_ELIGIBLE_TYPES, true);

    const refs = result.map(e => e.ref);
    assert.ok(!refs.includes('Subsystem.Parent'), 'Parent (ancestor) must be excluded');
    // Child itself is not an ancestor and must appear
    assert.ok(refs.includes('Subsystem.Child'), 'Child (current subsystem, not ancestor) must be included');
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  test('Subsystem type folder — recursive collection', () => {
    const configPath = 'C:/cfg/main';

    // Build: root → Subsystems → A → A1, A2; B
    const a1 = makeNode('Subsystems.A.A1', 'A1', MetadataType.Subsystem, [], `${configPath}/Subsystems/A/Subsystems/A1.xml`);
    const a2 = makeNode('Subsystems.A.A2', 'A2', MetadataType.Subsystem, [], `${configPath}/Subsystems/A/Subsystems/A2.xml`);
    const a = makeNode('Subsystems.A', 'A', MetadataType.Subsystem, [a1, a2], `${configPath}/Subsystems/A.xml`);
    const b = makeNode('Subsystems.B', 'B', MetadataType.Subsystem, [], `${configPath}/Subsystems/B.xml`);
    const subsystemsFolder = makeNode('Subsystems', 'Subsystems', MetadataType.Subsystem, [a, b]);
    const root = makeNode(
      'root',
      'Configuration',
      MetadataType.Configuration,
      [subsystemsFolder],
      `${configPath}/Configuration.xml`,
    );

    // Use a fresh subsystem with no ancestors — no exclusions needed
    const result = collectObjectsForType([root], configPath, 'Subsystems', new Set<string>(), SUBSYSTEM_ELIGIBLE_TYPES, true);

    const refs = result.map(e => e.ref);
    // Top-level subsystems A and B
    assert.ok(refs.includes('Subsystem.A'), 'A must be included');
    assert.ok(refs.includes('Subsystem.B'), 'B must be included');
    // Nested subsystems A1, A2 (recursive)
    assert.ok(refs.includes('Subsystem.A1'), 'A1 must be included (recursive)');
    assert.ok(refs.includes('Subsystem.A2'), 'A2 must be included (recursive)');
  });
});
