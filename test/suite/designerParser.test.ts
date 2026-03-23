import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DesignerParser } from '../../src/parsers/designerParser';
import { MetadataType, TreeNode } from '../../src/models/treeNode';
import {
  ensureTabularSectionColumnsPlaceholder,
  isTabularSectionColumnsContainer,
  tabularSectionColumnsContainerId,
} from '../../src/utils/treeNormalization';

suite('DesignerParser', () => {
  test('should detect Designer format', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const isDesigner = await DesignerParser.isDesignerFormat(configPath);

    assert.strictEqual(isDesigner, true);
  });

  test('should return false for non-Designer format', async () => {
    const configPath = path.join(__dirname, '../fixtures/non-existent');
    const isDesigner = await DesignerParser.isDesignerFormat(configPath);

    assert.strictEqual(isDesigner, false);
  });

  test('should parse Designer format configuration', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const rootNode = await DesignerParser.parse(configPath);

    assert.ok(rootNode);
    assert.strictEqual(rootNode.name, 'Configuration');
    assert.strictEqual(rootNode.type, MetadataType.Configuration);
    assert.ok(Array.isArray(rootNode.children));
  });

  test('should throw error for invalid configuration path', async () => {
    const configPath = path.join(__dirname, '../fixtures/non-existent');

    try {
      await DesignerParser.parse(configPath);
      assert.fail('Should have thrown an error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  test('should parse metadata types', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const rootNode = await DesignerParser.parse(configPath);

    // Check if children exist
    assert.ok(rootNode.children);
    assert.ok(rootNode.children.length >= 0);

    // If there are children, check their structure
    if (rootNode.children.length > 0) {
      const firstChild = rootNode.children[0];
      assert.ok(firstChild.name);
      assert.ok(firstChild.type);
      assert.ok(firstChild.properties);
    }
  });

  test('should load tabular sections and their attributes from XML', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const children = await DesignerParser.loadChildrenForElement(
      configPath,
      'Catalogs',
      'CatalogWithTabular'
    );

    const tabularNode = children.find((c) => c.id === 'TabularSections');
    assert.ok(tabularNode, 'TabularSections node should exist');
    assert.strictEqual(tabularNode!.type, MetadataType.TabularSection);
    assert.ok(tabularNode!.children);
    assert.strictEqual(tabularNode!.children!.length, 1, 'one tabular section');

    const section = tabularNode!.children![0];
    assert.strictEqual(section.name, 'Tabular1');
    assert.strictEqual(section.type, MetadataType.TabularSection);
    ensureTabularSectionColumnsPlaceholder(section);
    assert.ok(section.children);
    assert.strictEqual(section.children!.length, 1, 'columns container under section');
    const colContainer = section.children![0];
    assert.strictEqual(colContainer.id, tabularSectionColumnsContainerId(section.id));
    assert.ok(isTabularSectionColumnsContainer(colContainer));
    assert.ok(colContainer.children);
    assert.strictEqual(colContainer.children!.length, 2, 'two attributes in tabular section');

    const attrNames = colContainer.children!.map((a) => a.name).sort();
    assert.deepStrictEqual(attrNames, ['Col1', 'Col2']);
    assert.strictEqual(colContainer.children![0].type, MetadataType.Attribute);
    assert.strictEqual(colContainer.children![1].type, MetadataType.Attribute);
  });

  test('should load tabular section attributes from filesystem folder structure', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const children = await DesignerParser.loadChildrenForElement(
      configPath,
      'Catalogs',
      'CatalogWithTabular'
    );

    const tabularNode = children.find((c) => c.id === 'TabularSections');
    assert.ok(tabularNode, 'TabularSections node should exist');

    const section = tabularNode!.children!.find((c) => c.name === 'Tabular1');
    assert.ok(section, 'Tabular1 section should exist');
    ensureTabularSectionColumnsPlaceholder(section!);
    const colContainer = section!.children!.find((c) => isTabularSectionColumnsContainer(c));
    assert.ok(colContainer && colContainer.children && colContainer.children.length > 0);

    for (const attr of colContainer!.children!) {
      assert.notStrictEqual(attr.name, 'Tabular1', `Attribute name should not be the TS name, got: ${attr.name}`);
      assert.ok(attr.name === 'Col1' || attr.name === 'Col2', `Expected Col1 or Col2, got: ${attr.name}`);
      assert.strictEqual(attr.type, MetadataType.Attribute);
    }
  });

  test('empty tabular section (embedded) gets columns placeholder with lazy flag', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const children = await DesignerParser.loadChildrenForElement(
      configPath,
      'Catalogs',
      'CatalogEmptyEmbedded'
    );
    const tabularNode = children.find((c) => c.id === 'TabularSections');
    assert.ok(tabularNode?.children?.length === 1);
    const section = tabularNode!.children![0];
    assert.strictEqual(section.name, 'EmbeddedEmpty');
    ensureTabularSectionColumnsPlaceholder(section);
    assert.strictEqual(section.children!.length, 1);
    const ph = section.children![0];
    assert.strictEqual(ph.id, 'TabularSections.EmbeddedEmpty.Attributes');
    assert.strictEqual((ph.properties as { _lazy?: boolean })._lazy, true);
    assert.ok(!ph.children || ph.children.length === 0);
  });

  test('empty tabular section (folder file) gets columns placeholder with lazy flag', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const children = await DesignerParser.loadChildrenForElement(
      configPath,
      'Catalogs',
      'CatalogEmptyFolder'
    );
    const tabularNode = children.find((c) => c.id === 'TabularSections');
    assert.ok(tabularNode?.children?.some((c) => c.name === 'FolderEmpty'));
    const section = tabularNode!.children!.find((c) => c.name === 'FolderEmpty');
    assert.ok(section);
    ensureTabularSectionColumnsPlaceholder(section!);
    const ph = section!.children!.find((c) => isTabularSectionColumnsContainer(c));
    assert.ok(ph);
    assert.strictEqual((ph!.properties as { _lazy?: boolean })._lazy, true);
  });

  test('loadTabularSectionColumnChildren reads columns from embedded object xml', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const xmlPath = path.join(configPath, 'Catalogs', 'CatalogWithTabular.xml');
    const section: TreeNode = {
      id: 'TabularSections.Tabular1',
      name: 'Tabular1',
      type: MetadataType.TabularSection,
      parentFilePath: xmlPath,
      properties: {},
    };
    const cols = await DesignerParser.loadTabularSectionColumnChildren(section);
    assert.strictEqual(cols.length, 2);
    assert.ok(cols.some((c) => c.name === 'Col1'));
  });

  test('parseTypeContents loads flat Catalogs/*.xml when there are no per-object subfolders', async function () {
    const projectRoot = path.resolve(__dirname, '../../..');
    const emptyConf = path.join(projectRoot, 'FormatSamples', 'empty_conf');
    if (!fs.existsSync(emptyConf)) {
      this.skip();
    }
    const children = await DesignerParser.parseTypeContents(emptyConf, 'Catalogs');
    const names = children.map((c) => c.name);
    assert.ok(names.includes('Справочник55'), 'flat xml Справочник55.xml');
    assert.ok(names.includes('СтарееСтарых'), 'flat xml СтарееСтарых.xml');
    assert.ok(names.includes('табатаба'), 'flat xml табатаба.xml');
  });

  test('should parse extensions_samples if present (configuration extension with Ext)', async function () {
    const projectRoot = path.resolve(__dirname, '../../..');
    const extensionsSamplesPath = path.join(projectRoot, 'FormatSamples', 'extensions_samples');
    if (!fs.existsSync(extensionsSamplesPath)) {
      this.skip();
    }
    const rootNode = await DesignerParser.parse(extensionsSamplesPath);
    assert.ok(rootNode);
    assert.strictEqual(rootNode.name, 'Configuration');
    assert.strictEqual(rootNode.type, MetadataType.Configuration);
    assert.ok(Array.isArray(rootNode.children));
    const catalogs = rootNode.children?.find((c) => c.name === 'Catalogs');
    assert.ok(catalogs, 'Catalogs type node should exist');
  });

  test('CommonModule Ext lists nested Module/Module.bsl with fileType bsl', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const children = await DesignerParser.loadChildrenForElement(
      configPath,
      'CommonModules',
      'NestedModule'
    );
    const ext = children.find((c) => c.id === 'CommonModules.NestedModule.Ext');
    assert.ok(ext, 'Ext container');
    const moduleDir = ext?.children?.find((c) => c.name === 'Module');
    assert.ok(moduleDir?.children?.length);
    const leaf = moduleDir!.children!.find((x) => x.name === 'Module.bsl');
    assert.ok(leaf);
    assert.strictEqual(leaf!.type, MetadataType.Method);
    assert.strictEqual((leaf!.properties as { fileType?: string }).fileType, 'bsl');
    assert.ok(leaf!.filePath && leaf!.filePath.toLowerCase().endsWith('module.bsl'));
  });

  test('CommonModule flat xml only: no Ext in tree without object directory on disk', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const children = await DesignerParser.loadChildrenForElement(
      configPath,
      'CommonModules',
      'FlatOnlyModule'
    );
    assert.ok(!children.some((c) => c.type === MetadataType.Extension));
  });
});
