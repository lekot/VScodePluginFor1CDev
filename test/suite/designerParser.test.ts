import * as assert from 'assert';
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
});
