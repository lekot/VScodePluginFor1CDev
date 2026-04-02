import * as assert from 'assert';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import { collectCompositionEligibleObjects } from '../../src/subsystemCompositionEditor/compositionObjectCollector';

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
 * Build a small but representative tree under a single config path.
 *
 * Structure:
 *   root (Configuration)
 *     Catalogs (type-folder)
 *       Items (Catalog)
 *     Documents (type-folder)
 *       Order (Document)
 *     Subsystems (type-folder)
 *       Parent (Subsystem)
 *         Child (Subsystem)   ← this is returned as `subsystem`
 */
function makeTree(configPath: string): { root: TreeNode; subsystem: TreeNode } {
  const cat1 = makeNode(
    'Catalogs.Items',
    'Items',
    MetadataType.Catalog,
    undefined,
    `${configPath}/Catalogs/Items.xml`,
  );
  const doc1 = makeNode(
    'Documents.Order',
    'Order',
    MetadataType.Document,
    undefined,
    `${configPath}/Documents/Order.xml`,
  );
  const catalogsFolder = makeNode('Catalogs', 'Catalogs', MetadataType.Catalog, [cat1]);
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
  const subsystemsFolder = makeNode('Subsystems', 'Subsystems', MetadataType.Subsystem, [
    parentSub,
  ]);

  const root = makeNode(
    'root',
    'Configuration',
    MetadataType.Configuration,
    [catalogsFolder, documentsFolder, subsystemsFolder],
    `${configPath}/Configuration.xml`,
  );

  return { root, subsystem: childSub };
}

// ── suite ─────────────────────────────────────────────────────────────────────

suite('compositionObjectCollector', () => {
  // 1 ─────────────────────────────────────────────────────────────────────────
  test('collects objects from a simple tree', () => {
    const configPath = 'C:/cfg/main';
    const { root, subsystem } = makeTree(configPath);

    const result = collectCompositionEligibleObjects([root], subsystem, configPath);

    const refs = result.map((e) => e.ref);
    assert.ok(refs.includes('Catalog.Items'), 'should include Catalog.Items');
    assert.ok(refs.includes('Document.Order'), 'should include Document.Order');
    assert.ok(result.length >= 2);
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test('excludes ancestor subsystems', () => {
    const configPath = 'C:/cfg/main';
    const { root, subsystem } = makeTree(configPath);

    const result = collectCompositionEligibleObjects([root], subsystem, configPath);

    // `Parent` is an ancestor of `Child` — must not appear
    const refs = result.map((e) => e.ref);
    assert.ok(!refs.includes('Subsystem.Parent'), 'Parent is an ancestor — must be excluded');
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test('includes child subsystems of an ancestor', () => {
    const configPath = 'C:/cfg/main';

    // Build: root → Subsystems folder → GrandParent → Parent (ancestor of target) → Target → Child
    const child = makeNode(
      'Subsystems.GrandParent.Parent.Target.Child',
      'Child',
      MetadataType.Subsystem,
      [],
      `${configPath}/Subsystems/GrandParent/Subsystems/Parent/Subsystems/Target/Subsystems/Child.xml`,
    );
    const target = makeNode(
      'Subsystems.GrandParent.Parent.Target',
      'Target',
      MetadataType.Subsystem,
      [child],
      `${configPath}/Subsystems/GrandParent/Subsystems/Parent/Subsystems/Target.xml`,
    );
    const parent = makeNode(
      'Subsystems.GrandParent.Parent',
      'Parent',
      MetadataType.Subsystem,
      [target],
      `${configPath}/Subsystems/GrandParent/Subsystems/Parent.xml`,
    );
    const grandParent = makeNode(
      'Subsystems.GrandParent',
      'GrandParent',
      MetadataType.Subsystem,
      [parent],
      `${configPath}/Subsystems/GrandParent.xml`,
    );
    const subsystemsFolder = makeNode('Subsystems', 'Subsystems', MetadataType.Subsystem, [
      grandParent,
    ]);
    const root = makeNode(
      'root',
      'Configuration',
      MetadataType.Configuration,
      [subsystemsFolder],
      `${configPath}/Configuration.xml`,
    );

    // target's ancestors: Parent, GrandParent
    const result = collectCompositionEligibleObjects([root], target, configPath);
    const refs = result.map((e) => e.ref);

    // Child of Target must appear
    assert.ok(refs.includes('Subsystem.Child'), 'Child subsystem must be included');
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test('includes the current subsystem itself (it is not its own ancestor)', () => {
    const configPath = 'C:/cfg/main';
    const { root, subsystem } = makeTree(configPath);

    const result = collectCompositionEligibleObjects([root], subsystem, configPath);

    const refs = result.map((e) => e.ref);
    // `Child` subsystem is the current subsystem — it is not in the ancestor set,
    // so it SHOULD appear in the result (that is the real behaviour).
    assert.ok(refs.includes('Subsystem.Child'), 'current subsystem should appear in result');
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  test('returns empty array for configuration with no children', () => {
    const configPath = 'C:/cfg/main';
    const emptyRoot = makeNode(
      'root',
      'Configuration',
      MetadataType.Configuration,
      [],
      `${configPath}/Configuration.xml`,
    );
    const orphanSub = makeNode(
      'Subsystems.Alone',
      'Alone',
      MetadataType.Subsystem,
      [],
      `${configPath}/Subsystems/Alone.xml`,
    );

    const result = collectCompositionEligibleObjects([emptyRoot], orphanSub, configPath);
    assert.deepStrictEqual(result, []);
  });

  // 6 ─────────────────────────────────────────────────────────────────────────
  test('extension subsystem sees objects from main config', () => {
    const mainPath = 'C:/cfg/main';
    const extPath = 'C:/cfg/ext';

    const mainCat = makeNode(
      'Catalogs.MainCat',
      'MainCat',
      MetadataType.Catalog,
      undefined,
      `${mainPath}/Catalogs/MainCat.xml`,
    );
    const mainCatFolder = makeNode('Catalogs', 'Catalogs', MetadataType.Catalog, [mainCat]);
    const mainRoot = makeNode(
      'root',
      'Configuration',
      MetadataType.Configuration,
      [mainCatFolder],
      `${mainPath}/Configuration.xml`,
    );

    const extSub = makeNode(
      'Subsystems.ExtSub',
      'ExtSub',
      MetadataType.Subsystem,
      [],
      `${extPath}/Subsystems/ExtSub.xml`,
    );
    const extSubsFolder = makeNode('Subsystems', 'Subsystems', MetadataType.Subsystem, [extSub]);
    const extRoot = makeNode(
      'root',
      'Extension',
      MetadataType.Configuration,
      [extSubsFolder],
      `${extPath}/Configuration.xml`,
    );

    // extSub belongs to extension (extPath ≠ mainPath → not main config)
    const result = collectCompositionEligibleObjects([mainRoot, extRoot], extSub, extPath);
    const refs = result.map((e) => e.ref);

    assert.ok(refs.includes('Catalog.MainCat'), 'extension should see main config objects');
  });

  // 7 ─────────────────────────────────────────────────────────────────────────
  test('main config subsystem does NOT see extension objects', () => {
    const mainPath = 'C:/cfg/main';
    const extPath = 'C:/cfg/ext';

    const mainSub = makeNode(
      'Subsystems.MainSub',
      'MainSub',
      MetadataType.Subsystem,
      [],
      `${mainPath}/Subsystems/MainSub.xml`,
    );
    const mainSubsFolder = makeNode('Subsystems', 'Subsystems', MetadataType.Subsystem, [mainSub]);
    const mainRoot = makeNode(
      'root',
      'Configuration',
      MetadataType.Configuration,
      [mainSubsFolder],
      `${mainPath}/Configuration.xml`,
    );

    const extCat = makeNode(
      'Catalogs.ExtCat',
      'ExtCat',
      MetadataType.Catalog,
      undefined,
      `${extPath}/Catalogs/ExtCat.xml`,
    );
    const extCatFolder = makeNode('Catalogs', 'Catalogs', MetadataType.Catalog, [extCat]);
    const extRoot = makeNode(
      'root',
      'Extension',
      MetadataType.Configuration,
      [extCatFolder],
      `${extPath}/Configuration.xml`,
    );

    // mainSub belongs to main config
    const result = collectCompositionEligibleObjects([mainRoot, extRoot], mainSub, mainPath);
    const refs = result.map((e) => e.ref);

    assert.ok(!refs.includes('Catalog.ExtCat'), 'main config must NOT see extension objects');
  });
});
