import * as assert from 'assert';
import * as path from 'path';
import {
  getConfigurationXmlPathForNode,
  getConfigRootFromNode,
  getFormatFromNode
} from '../../src/utils/configHelpers';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import { ConfigFormat } from '../../src/parsers/formatDetector';

/**
 * Unit tests for getConfigurationXmlPathForNode (ADR 0001, plan 7.2).
 * Contract: for Configuration returns path.join(configDir, 'Configuration.xml') when getConfigDir returns dir; null when getConfigDir returns null; for non-Configuration returns null.
 */
suite('configHelpers: getConfigurationXmlPathForNode', () => {
  test('Configuration + getConfigDir returns directory → path to Configuration.xml', () => {
    const configDir = path.join('C:', 'some', 'config');
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    const getConfigDir = (_n: TreeNode) => configDir;
    const result = getConfigurationXmlPathForNode(node, getConfigDir);
    assert.strictEqual(result, path.join(configDir, 'Configuration.xml'));
  });

  test('Configuration + getConfigDir returns null → null', () => {
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    const getConfigDir = (_n: TreeNode) => null;
    const result = getConfigurationXmlPathForNode(node, getConfigDir);
    assert.strictEqual(result, null);
  });

  test('non-Configuration node → null', () => {
    const configDir = path.join('C:', 'some', 'config');
    const node: TreeNode = {
      id: 'cat1',
      name: 'MyCatalog',
      type: MetadataType.Catalog,
      properties: {},
      filePath: path.join(configDir, 'Catalogs', 'MyCatalog.xml'),
    };
    const getConfigDir = (_n: TreeNode) => configDir;
    const result = getConfigurationXmlPathForNode(node, getConfigDir);
    assert.strictEqual(result, null);
  });
});

suite('configHelpers: getConfigRootFromNode', () => {
  test('returns Configuration.xml parent for Designer root file', () => {
    const node: TreeNode = {
      id: 'cat1',
      name: 'MyCatalog',
      type: MetadataType.Catalog,
      properties: {},
      parent: {
        id: 'root',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        filePath: path.join('C:', 'cfg', 'Configuration.xml')
      }
    };

    const result = getConfigRootFromNode(node);
    assert.strictEqual(result, path.join('C:', 'cfg'));
  });

  test('returns parent directory for EDT /src root', () => {
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join('C:', 'cfg', 'src')
    };

    const result = getConfigRootFromNode(node);
    assert.strictEqual(result, path.join('C:', 'cfg'));
  });

  test('returns null when root has no filePath', () => {
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {}
    };

    const result = getConfigRootFromNode(node);
    assert.strictEqual(result, null);
  });

  test('returns non-configuration root path as-is', () => {
    const rootPath = path.join('C:', 'workspace', 'custom-root');
    const node: TreeNode = {
      id: 'obj',
      name: 'Any',
      type: MetadataType.Document,
      properties: {},
      parent: {
        id: 'non-root',
        name: 'NotConfiguration',
        type: MetadataType.CommonModule,
        properties: {},
        filePath: rootPath
      }
    };

    const result = getConfigRootFromNode(node);
    assert.strictEqual(result, rootPath);
  });
});

suite('configHelpers: getFormatFromNode', () => {
  test('returns null when config root cannot be resolved', async () => {
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {}
    };

    const result = await getFormatFromNode(node);
    assert.strictEqual(result, null);
  });

  test('detects Designer format for fixture configuration root', async () => {
    const node: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      filePath: path.join(__dirname, '../fixtures/designer-config')
    };

    const result = await getFormatFromNode(node);
    assert.strictEqual(result, ConfigFormat.Designer);
  });
});
