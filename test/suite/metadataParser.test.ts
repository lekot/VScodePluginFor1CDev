import * as assert from 'assert';
import * as path from 'path';
import { MetadataParser } from '../../src/parsers/metadataParser';
import { MetadataType } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';

suite('MetadataParser', () => {
  test('should parse configuration', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const rootNode = await MetadataParser.parse(configPath);

    assert.ok(rootNode);
    assert.strictEqual(rootNode.name, 'Configuration');
    assert.strictEqual(rootNode.type, MetadataType.Configuration);
  });

  test('should throw error for invalid configuration path', async () => {
    const configPath = path.join(__dirname, '../fixtures/non-existent');

    try {
      await MetadataParser.parse(configPath);
      assert.fail('Should have thrown an error');
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  });

  test('should detect configuration format', async () => {
    const configPath = path.join(__dirname, '../fixtures/designer-config');
    const format = await MetadataParser.getFormat(configPath);

    assert.strictEqual(format, ConfigFormat.Designer);
  });

  test('should find configuration root in workspace', async () => {
    const workspacePath = path.join(__dirname, '../fixtures');
    const configRoot = await MetadataParser.findConfigurationRoot(workspacePath);

    assert.ok(configRoot);
    assert.ok(configRoot?.includes('designer-config'));
  });

  test('should parse configuration from workspace', async () => {
    const workspacePath = path.join(__dirname, '../fixtures');
    const rootNode = await MetadataParser.parseFromWorkspace(workspacePath);

    assert.ok(rootNode);
    assert.strictEqual(rootNode?.name, 'Configuration');
    assert.strictEqual(rootNode?.type, MetadataType.Configuration);
  });

  test('should return null if configuration not found in workspace', async () => {
    const workspacePath = path.join(__dirname, '../fixtures/non-existent');
    const rootNode = await MetadataParser.parseFromWorkspace(workspacePath);

    assert.strictEqual(rootNode, null);
  });
});
