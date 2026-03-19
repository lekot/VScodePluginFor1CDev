import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createElement,
  deleteElement,
} from '../../src/services/elementOperations';
import { XMLWriter } from '../../src/utils/XMLWriter';
import { TreeNode, MetadataType } from '../../src/models/treeNode';
import {
  createTempDir,
  cleanupTempDir,
  createConfigNode,
  fileExists,
  dirExists,
  readFileContent,
} from '../helpers/testHelpers';

/**
 * Tests for elementOperations that verify Configuration.xml after operations.
 * Validates: createElement adds to Configuration.xml, deleteElement removes from it.
 *
 * Would have caught:
 * - Configuration.xml not updated after createElement (BUG from this session)
 * - Configuration.xml not updated after deleteElement (BUG from this session)
 */

function createTypeNode(type: MetadataType, parentNode: TreeNode, filePath: string): TreeNode {
  return {
    id: `type-${String(type)}`,
    name: String(type),
    type,
    properties: {},
    filePath,
    parent: parentNode,
  };
}

function createElementNode(name: string, type: MetadataType, parentNode: TreeNode, filePath: string): TreeNode {
  return {
    id: `el-${name}`,
    name,
    type,
    properties: {},
    filePath,
    parent: parentNode,
  };
}

suite('elementOperations Configuration.xml integration', () => {
  let tmpDir: string;
  let configNode: TreeNode;
  const configXmlPath = () => path.join(tmpDir, 'Configuration.xml');

  const BASE_CONFIG_XML = (childObjects: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Configuration uuid="42bff091-dd0b-4592-a67f-70c38db7993f">
    <Properties><Name>TestConfig</Name></Properties>
    <ChildObjects>
${childObjects}
    </ChildObjects>
  </Configuration>
</MetaDataObject>`;

  setup(async () => {
    tmpDir = await createTempDir('1cviewer-elcfg-');
    configNode = createConfigNode();
  });

  teardown(async () => {
    await cleanupTempDir(tmpDir);
  });

  // --- createElement updates Configuration.xml ---

  test('createElement adds <Catalog> entry to Configuration.xml', async () => {
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });
    fs.writeFileSync(configXmlPath(), BASE_CONFIG_XML(''), 'utf-8');

    const typeNode = createTypeNode(MetadataType.Catalog, configNode, catalogsPath);
    await createElement(typeNode, 'NewCatalog');

    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(configXml.includes('<Catalog>NewCatalog</Catalog>'),
      'Configuration.xml must contain the new Catalog entry');
  });

  test('createElement adds <Document> entry to Configuration.xml', async () => {
    const docsPath = path.join(tmpDir, 'Documents');
    await fs.promises.mkdir(docsPath, { recursive: true });
    fs.writeFileSync(configXmlPath(), BASE_CONFIG_XML(''), 'utf-8');

    const typeNode = createTypeNode(MetadataType.Document, configNode, docsPath);
    await createElement(typeNode, 'NewDocument');

    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(configXml.includes('<Document>NewDocument</Document>'),
      'Configuration.xml must contain the new Document entry');
  });

  test('createElement preserves existing entries in Configuration.xml', async () => {
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });

    const existingCatalog = path.join(catalogsPath, 'ExistingCatalog.xml');
    await XMLWriter.createMinimalElementFile(existingCatalog, 'Catalog', 'ExistingCatalog');

    fs.writeFileSync(configXmlPath(), BASE_CONFIG_XML('      <Catalog>ExistingCatalog</Catalog>'), 'utf-8');

    const typeNode = createTypeNode(MetadataType.Catalog, configNode, catalogsPath);
    await createElement(typeNode, 'AnotherCatalog');

    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(configXml.includes('<Catalog>ExistingCatalog</Catalog>'),
      'Existing entry must remain');
    assert.ok(configXml.includes('<Catalog>AnotherCatalog</Catalog>'),
      'New entry must be added');
  });

  // --- deleteElement removes from Configuration.xml ---

  test('deleteElement removes <Catalog> entry from Configuration.xml', async () => {
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });

    const catalogPath = path.join(catalogsPath, 'TestCatalog.xml');
    await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'TestCatalog');

    fs.writeFileSync(configXmlPath(), BASE_CONFIG_XML('      <Catalog>TestCatalog</Catalog>'), 'utf-8');

    const typeNode = createTypeNode(MetadataType.Catalog, configNode, catalogsPath);
    const catalogNode = createElementNode('TestCatalog', MetadataType.Catalog, typeNode, catalogPath);

    await deleteElement(catalogNode);

    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(!configXml.includes('<Catalog>TestCatalog</Catalog>'),
      'Deleted catalog entry must be removed from Configuration.xml');
  });

  test('deleteElement removes only the deleted entry, preserves others', async () => {
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });

    const catalogPath = path.join(catalogsPath, 'TestCatalog.xml');
    await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'TestCatalog');

    fs.writeFileSync(
      configXmlPath(),
      BASE_CONFIG_XML('      <Catalog>KeepCatalog</Catalog>\n      <Catalog>TestCatalog</Catalog>\n      <Language>Русский</Language>'),
      'utf-8'
    );

    const typeNode = createTypeNode(MetadataType.Catalog, configNode, catalogsPath);
    const catalogNode = createElementNode('TestCatalog', MetadataType.Catalog, typeNode, catalogPath);

    await deleteElement(catalogNode);

    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(!configXml.includes('<Catalog>TestCatalog</Catalog>'),
      'Deleted entry must be removed');
    assert.ok(configXml.includes('<Catalog>KeepCatalog</Catalog>'),
      'Other catalog entry must remain');
    assert.ok(configXml.includes('<Language>Русский</Language>'),
      'Language entry must remain');
  });

  // --- deleteElement for nested elements does NOT touch Configuration.xml ---

  test('deleteElement for Attribute does not modify Configuration.xml', async () => {
    const catalogsPath = path.join(tmpDir, 'Catalogs');
    await fs.promises.mkdir(catalogsPath, { recursive: true });

    const catalogPath = path.join(catalogsPath, 'CatWithAttr.xml');
    await XMLWriter.createMinimalElementFile(catalogPath, 'Catalog', 'CatWithAttr');
    await XMLWriter.addNestedElement(catalogPath, 'Attribute', 'TestAttr');

    fs.writeFileSync(configXmlPath(), BASE_CONFIG_XML('      <Catalog>CatWithAttr</Catalog>'), 'utf-8');

    // Create attribute node with parentFilePath
    const typeNode = createTypeNode(MetadataType.Catalog, configNode, catalogsPath);
    const catalogNode = createElementNode('CatWithAttr', MetadataType.Catalog, typeNode, catalogPath);
    const attrNode: TreeNode = {
      id: 'attr-TestAttr',
      name: 'TestAttr',
      type: MetadataType.Attribute,
      properties: {},
      parent: catalogNode,
      parentFilePath: catalogPath,
    };

    await deleteElement(attrNode);

    // Config.xml must be unchanged
    const configXml = fs.readFileSync(configXmlPath(), 'utf-8');
    assert.ok(configXml.includes('<Catalog>CatWithAttr</Catalog>'),
      'Configuration.xml must not be modified when deleting nested element');

    // But attribute should be removed from the XML file
    const catalogXml = fs.readFileSync(catalogPath, 'utf-8');
    assert.ok(!catalogXml.includes('<Name>TestAttr</Name>'),
      'Attribute should be removed from parent XML');
  });
});
