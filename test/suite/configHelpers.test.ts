import * as assert from 'assert';
import * as path from 'path';
import { getConfigurationXmlPathForNode } from '../../src/utils/configHelpers';
import { TreeNode, MetadataType } from '../../src/models/treeNode';

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
