import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DesignerParser } from '../../src/parsers/designerParser';
import { MetadataType } from '../../src/models/treeNode';

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
    assert.ok(section.children);
    assert.strictEqual(section.children!.length, 2, 'two attributes in tabular section');

    const attrNames = section.children!.map((a) => a.name).sort();
    assert.deepStrictEqual(attrNames, ['Col1', 'Col2']);
    assert.strictEqual(section.children![0].type, MetadataType.Attribute);
    assert.strictEqual(section.children![1].type, MetadataType.Attribute);
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
    assert.ok(section!.children && section!.children.length > 0, 'Tabular1 should have attribute children');

    for (const attr of section!.children!) {
      assert.notStrictEqual(attr.name, 'Tabular1', `Attribute name should not be the TS name, got: ${attr.name}`);
      assert.ok(attr.name === 'Col1' || attr.name === 'Col2', `Expected Col1 or Col2, got: ${attr.name}`);
      assert.strictEqual(attr.type, MetadataType.Attribute);
    }
  });

  test('should parse extensions_samples if present (configuration extension with Ext)', async function () {
    const projectRoot = path.resolve(__dirname, '../../..');
    const extensionsSamplesPath = path.join(projectRoot, 'extensions_samples');
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
});
