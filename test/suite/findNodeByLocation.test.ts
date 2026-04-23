/**
 * Unit tests for MetadataTreeDataProvider.findNodeByLocation (issue #88).
 *
 * Uses a hand-crafted fake tree — no real filesystem access.
 * getChildren() on fake nodes with pre-filled `children` returns them immediately;
 * lazy-loading paths are not exercised here (those need real parser fixtures).
 */
import * as assert from 'assert';
import * as path from 'path';
import { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import type { MetadataLocation } from '../../src/services/metadataFileLocator';

// ---------------------------------------------------------------------------
// Fake-tree helpers
// ---------------------------------------------------------------------------

const CONFIG_ROOT = path.resolve('C:/fake/cfg');

/** Create a minimal TreeNode. Children array, if provided, has parent links set automatically. */
function node(
  id: string,
  name: string,
  type: MetadataType,
  children?: TreeNode[],
  filePath?: string
): TreeNode {
  const n: TreeNode = { id, name, type, properties: {}, children: children ?? [], filePath };
  for (const c of n.children ?? []) {
    c.parent = n;
  }
  return n;
}

/** Create Ext node (MetadataType.Extension) containing module .bsl nodes. */
function extNode(idPrefix: string, moduleFiles: string[]): TreeNode {
  const modules = moduleFiles.map((f) =>
    node(`${idPrefix}Ext.${f}`, f, MetadataType.Method)
  );
  return node(`${idPrefix}Ext`, 'Extensions', MetadataType.Extension, modules);
}

// ---------------------------------------------------------------------------
// Build the fake tree
// ---------------------------------------------------------------------------

/**
 * Returns a fresh provider + fake configRoot for each test.
 *
 * Tree layout:
 *   Configuration (root)
 *   ├── CommonModules
 *   │   └── ОбщийМодуль1
 *   │       └── Ext  (CommonModules.ОбщийМодуль1.Ext)
 *   │           └── Module.bsl
 *   ├── Catalogs
 *   │   └── Товары
 *   │       ├── Ext  (Ext) → ObjectModule.bsl, ManagerModule.bsl
 *   │       ├── Forms
 *   │       │   └── ФормаЭлемента
 *   │       │       └── Ext → Module.bsl
 *   │       ├── Commands
 *   │       │   └── МояКоманда
 *   │       │       └── Ext → CommandModule.bsl
 *   │       └── Templates
 *   │           └── МакетПечати
 *   ├── Roles
 *   │   └── АдминРоль
 *   └── Subsystems
 *       └── Продажи   (depth 1)
 *           └── Заказы  (depth 2)
 *               └── Детали  (depth 3)
 */
function buildFakeTree(): { provider: MetadataTreeDataProvider; configRoot: TreeNode } {
  // CommonModule
  const commonModuleExt = extNode('CommonModules.ОбщийМодуль1.', ['Module.bsl']);
  const commonModuleNode = node(
    'CommonModules.ОбщийМодуль1',
    'ОбщийМодуль1',
    MetadataType.CommonModule,
    [commonModuleExt]
  );
  const commonModulesFolder = node('CommonModules', 'CommonModules', MetadataType.CommonModule, [
    commonModuleNode,
  ]);

  // Catalog Товары
  const catalogExt = extNode('', ['ObjectModule.bsl', 'ManagerModule.bsl']);
  catalogExt.id = 'Ext';

  const formModuleExt = extNode('Forms.ФормаЭлемента.', ['Module.bsl']);
  const formNode = node(
    'Forms.ФормаЭлемента',
    'ФормаЭлемента',
    MetadataType.Form,
    [formModuleExt]
  );
  const formsFolder = node('Forms', 'Forms', MetadataType.Unknown, [formNode]);

  const commandModuleExt = extNode('Commands.МояКоманда.', ['CommandModule.bsl']);
  const commandNode = node(
    'Commands.МояКоманда',
    'МояКоманда',
    MetadataType.CommandSubElement,
    [commandModuleExt]
  );
  const commandsFolder = node('Commands', 'Commands', MetadataType.Unknown, [commandNode]);

  const templateNode = node('Templates.МакетПечати', 'МакетПечати', MetadataType.Template);
  const templatesFolder = node('Templates', 'Templates', MetadataType.Unknown, [templateNode]);

  const catalogNode = node(
    'Catalogs.Товары',
    'Товары',
    MetadataType.Catalog,
    [catalogExt, formsFolder, commandsFolder, templatesFolder]
  );
  const catalogsFolder = node('Catalogs', 'Catalogs', MetadataType.Catalog, [catalogNode]);

  // Role
  const roleNode = node('Roles.АдминРоль', 'АдминРоль', MetadataType.Role);
  const rolesFolder = node('Roles', 'Roles', MetadataType.Role, [roleNode]);

  // Subsystems hierarchy: Продажи → Заказы → Детали
  const детали = node('Subsystems.Продажи.Заказы.Детали', 'Детали', MetadataType.Subsystem);
  const заказы = node('Subsystems.Продажи.Заказы', 'Заказы', MetadataType.Subsystem, [детали]);
  const продажи = node('Subsystems.Продажи', 'Продажи', MetadataType.Subsystem, [заказы]);
  const subsystemsFolder = node('Subsystems', 'Subsystems', MetadataType.Subsystem, [продажи]);

  const configRoot = node(
    'Configuration',
    'Configuration',
    MetadataType.Configuration,
    [commonModulesFolder, catalogsFolder, rolesFolder, subsystemsFolder],
    path.join(CONFIG_ROOT, 'Configuration.xml')
  );

  const provider = new MetadataTreeDataProvider();
  provider.setRootNodes([configRoot], new Map([
    [
      configRoot.id,
      { configPath: CONFIG_ROOT, format: ConfigFormat.Designer },
    ],
  ]));

  return { provider, configRoot };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('MetadataTreeDataProvider.findNodeByLocation (issue #88)', () => {
  let provider: MetadataTreeDataProvider;

  setup(() => {
    ({ provider } = buildFakeTree());
  });

  // Case 1: CommonModule object found
  test('1. CommonModule → найден', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'CommonModules',
      objectName: 'ОбщийМодуль1',
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected a node but got null');
    assert.strictEqual(result!.name, 'ОбщийМодуль1');
  });

  // Case 2: Catalog flat object found
  test('2. Catalog.Товары → объект найден', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Catalogs',
      objectName: 'Товары',
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected a node but got null');
    assert.strictEqual(result!.name, 'Товары');
    assert.strictEqual(result!.type, MetadataType.Catalog);
  });

  // Case 3: Catalog + ObjectModule
  test('3. Catalog.Товары + objectModule → модуль найден', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Catalogs',
      objectName: 'Товары',
      subPath: { kind: 'objectModule' },
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected a node but got null');
    assert.strictEqual(result!.name, 'ObjectModule.bsl');
  });

  // Case 4: Catalog + Form container
  test('4. Catalog.Товары + Form "ФормаЭлемента" container → узел Form', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Catalogs',
      objectName: 'Товары',
      subPath: { kind: 'form', name: 'ФормаЭлемента', subFile: 'container' },
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected a node but got null');
    assert.strictEqual(result!.name, 'ФормаЭлемента');
    assert.strictEqual(result!.type, MetadataType.Form);
  });

  // Case 5: Catalog + Form + Module
  test('5. Catalog.Товары + Form "ФормаЭлемента" + module → модуль формы', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Catalogs',
      objectName: 'Товары',
      subPath: { kind: 'form', name: 'ФормаЭлемента', subFile: 'module' },
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected a node but got null');
    assert.strictEqual(result!.name, 'Module.bsl');
  });

  // Case 6: Role found
  test('6. Role → найден', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Roles',
      objectName: 'АдминРоль',
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected a node but got null');
    assert.strictEqual(result!.name, 'АдминРоль');
    assert.strictEqual(result!.type, MetadataType.Role);
  });

  // Case 7: Subsystems hierarchy depth 2
  test('7. Subsystems hierarchy глубины 2 → Заказы', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Subsystems',
      objectName: 'Продажи',
      hierarchy: ['Продажи', 'Заказы'],
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected a node but got null');
    assert.strictEqual(result!.name, 'Заказы');
    assert.strictEqual(result!.type, MetadataType.Subsystem);
  });

  // Case 8: Subsystems hierarchy depth 3
  test('8. Subsystems hierarchy глубины 3 → Детали', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Subsystems',
      objectName: 'Продажи',
      hierarchy: ['Продажи', 'Заказы', 'Детали'],
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected a node but got null');
    assert.strictEqual(result!.name, 'Детали');
  });

  // Case 9: configRoot mismatch → null
  test('9. configRoot не совпадает → null', async () => {
    const loc: MetadataLocation = {
      configRoot: path.resolve('C:/other/cfg'),
      objectType: 'Catalogs',
      objectName: 'Товары',
    };
    const result = await provider.findNodeByLocation(loc);
    assert.strictEqual(result, null);
  });

  // Case 10: object not found → null
  test('10. Объект не существует → null', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Catalogs',
      objectName: 'НесуществующийСправочник',
    };
    const result = await provider.findNodeByLocation(loc);
    assert.strictEqual(result, null);
  });

  // Case 11: Role + rights subPath → role node itself
  test('11. Role + rights → сам узел роли', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Roles',
      objectName: 'АдминРоль',
      subPath: { kind: 'rights' },
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected a node but got null');
    assert.strictEqual(result!.name, 'АдминРоль');
  });

  // Case 12: Command + xml subFile
  test('12. Catalog.Товары + Command xml → узел команды', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Catalogs',
      objectName: 'Товары',
      subPath: { kind: 'command', name: 'МояКоманда', subFile: 'xml' },
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected a node but got null');
    assert.strictEqual(result!.name, 'МояКоманда');
  });

  // Case 13: Template found
  test('13. Catalog.Товары + template → узел шаблона', async () => {
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Catalogs',
      objectName: 'Товары',
      subPath: { kind: 'template', name: 'МакетПечати' },
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected a node but got null');
    assert.strictEqual(result!.name, 'МакетПечати');
  });
});

// ---------------------------------------------------------------------------
// Extension root lookup tests
// ---------------------------------------------------------------------------

const EXT_NAME = 'Базовое';
const EXT_CONFIG_ROOT = path.resolve(CONFIG_ROOT, 'ConfigurationExtensions', EXT_NAME);

/**
 * Builds a provider with two root nodes:
 *   - main config root (no extensionPurpose)
 *   - extension root (extensionPurpose = 'Patch') with a Catalog
 */
function buildFakeTreeWithExtension(): MetadataTreeDataProvider {
  // Main config root — empty, just needs to be reachable by configRoot path
  const mainRoot = node(
    'config:main',
    'Configuration',
    MetadataType.Configuration,
    [],
    path.join(CONFIG_ROOT, 'Configuration.xml')
  );

  // Extension catalog
  const extCatalogNode = node('ext.Catalogs.Товары', 'Товары', MetadataType.Catalog, []);
  const extCatalogsFolder = node('ext.Catalogs', 'Catalogs', MetadataType.Catalog, [extCatalogNode]);

  const extRoot = node(
    'config:ext',
    'Configuration',
    MetadataType.Configuration,
    [extCatalogsFolder],
    path.join(EXT_CONFIG_ROOT, 'Configuration.xml')
  );
  // Mark as extension
  extRoot.properties.extensionPurpose = 'Patch';

  const provider = new MetadataTreeDataProvider();
  provider.setRootNodes(
    [mainRoot, extRoot],
    new Map([
      ['config:main', { configPath: CONFIG_ROOT, format: ConfigFormat.Designer }],
      ['config:ext', { configPath: EXT_CONFIG_ROOT, format: ConfigFormat.Designer }],
    ])
  );
  return provider;
}

suite('MetadataTreeDataProvider.findNodeByLocation — extension root (issue #88)', () => {
  // Case 14: extension root lookup finds catalog in extension
  test('14. extensionName=Базовое → узел каталога в extension root', async () => {
    const provider = buildFakeTreeWithExtension();
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Catalogs',
      objectName: 'Товары',
      extensionName: EXT_NAME,
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected extension catalog node but got null');
    assert.strictEqual(result!.name, 'Товары');
    assert.strictEqual(result!.type, MetadataType.Catalog);
  });

  // Case 15: extensionName set but extension root not loaded → null (not false-positive in main)
  test('15. extensionName задан, extension root не загружен → null', async () => {
    const provider = buildFakeTreeWithExtension();
    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Catalogs',
      objectName: 'Товары',
      extensionName: 'НесуществующееРасширение',
    };
    const result = await provider.findNodeByLocation(loc);
    assert.strictEqual(result, null, 'Should return null when extension root is not loaded');
  });
});

// ---------------------------------------------------------------------------
// Subsystem name-collision test
// ---------------------------------------------------------------------------

suite('MetadataTreeDataProvider.findNodeByLocation — subsystem type guard (issue #88)', () => {
  // Case 16: non-subsystem child with same name as next subsystem is ignored
  test('16. non-subsystem child с тем же именем не перехватывает subsystem walk', async () => {
    // Build tree: Subsystems → Продажи (Subsystem) which has:
    //   - child with name='Заказы' and type=Unknown (CommandInterface-like)
    //   - child with name='Заказы' and type=Subsystem (the real subsystem)
    const realЗаказы = node('Subsystems.Продажи.Заказы', 'Заказы', MetadataType.Subsystem, []);
    const fakeЗаказы = node(
      'Subsystems.Продажи.Заказы.CI',
      'Заказы',
      MetadataType.Unknown,
      []
    );
    // fakeЗаказы comes BEFORE realЗаказы in children to test that type-guard skips it
    const продажи = node('Subsystems.Продажи', 'Продажи', MetadataType.Subsystem, [fakeЗаказы, realЗаказы]);
    const subsystemsFolder = node('Subsystems', 'Subsystems', MetadataType.Subsystem, [продажи]);

    const configRoot = node(
      'Configuration',
      'Configuration',
      MetadataType.Configuration,
      [subsystemsFolder],
      path.join(CONFIG_ROOT, 'Configuration.xml')
    );

    const provider = new MetadataTreeDataProvider();
    provider.setRootNodes(
      [configRoot],
      new Map([['Configuration', { configPath: CONFIG_ROOT, format: ConfigFormat.Designer }]])
    );

    const loc: MetadataLocation = {
      configRoot: CONFIG_ROOT,
      objectType: 'Subsystems',
      objectName: 'Продажи',
      hierarchy: ['Продажи', 'Заказы'],
    };
    const result = await provider.findNodeByLocation(loc);
    assert.ok(result, 'Expected Заказы subsystem node but got null');
    assert.strictEqual(result!.name, 'Заказы');
    assert.strictEqual(result!.type, MetadataType.Subsystem, 'Must return Subsystem-typed node, not Unknown');
  });
});
