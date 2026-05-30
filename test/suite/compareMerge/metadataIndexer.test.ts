import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { indexMetadataFile, indexMetadataFolder } from '../../../src/compareMerge/metadata/metadataIndexer';

suite('MetadataIndexer', () => {
  test('extracts qualified name and uuid from Designer XML Properties', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const filePath = path.join(tempRoot, 'Catalogs', 'Products.xml');
    await writeFile(
      filePath,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject uuid="catalog-root-uuid">
  <Catalog uuid="catalog-object-uuid">
    <Properties>
      <Name>Products</Name>
    </Properties>
  </Catalog>
</MetaDataObject>`
    );

    const identity = await indexMetadataFile({
      sourceId: 'left-source',
      side: 'left',
      filePath,
      metadataType: 'Catalog',
    });

    assert.strictEqual(identity.sourceId, 'left-source');
    assert.strictEqual(identity.side, 'left');
    assert.strictEqual(identity.metadataType, 'Catalog');
    assert.strictEqual(identity.qualifiedName, 'Catalog.Products');
    assert.strictEqual(identity.uuid, 'catalog-object-uuid');
    assert.strictEqual(identity.filePath, filePath);
    assert.strictEqual(identity.containerPath, path.dirname(filePath));
    assert.strictEqual(identity.objectPath, 'Catalog.Products');
    assert.strictEqual(identity.nameSource, 'xmlPropertiesName');
    assert.strictEqual(identity.uuidSource, 'xmlAttribute');
    assert.strictEqual(identity.confidence, 'strong');
  });

  test('falls back to path name and folder type when XML omits identity fields', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const filePath = path.join(tempRoot, 'Documents', 'SalesOrder.xml');
    await writeFile(
      filePath,
      `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Document>
    <Properties>
      <Synonym>Sales order</Synonym>
    </Properties>
  </Document>
</MetaDataObject>`
    );

    const identity = await indexMetadataFile({
      sourceId: 'right-source',
      side: 'right',
      filePath,
    });

    assert.strictEqual(identity.metadataType, 'Document');
    assert.strictEqual(identity.qualifiedName, 'Document.SalesOrder');
    assert.strictEqual(identity.uuid, undefined);
    assert.strictEqual(identity.nameSource, 'fileName');
    assert.strictEqual(identity.uuidSource, 'missing');
    assert.strictEqual(identity.confidence, 'nameOnly');
  });

  test('indexes XML files in a metadata type folder', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const catalogsPath = path.join(tempRoot, 'Catalogs');
    await writeFile(
      path.join(catalogsPath, 'Products.xml'),
      '<MetaDataObject><Catalog uuid="uuid-products"><Properties><Name>Products</Name></Properties></Catalog></MetaDataObject>'
    );
    await writeFile(
      path.join(catalogsPath, 'Services.xml'),
      '<MetaDataObject><Catalog><Properties><Name>Services</Name></Properties></Catalog></MetaDataObject>'
    );
    await writeFile(path.join(catalogsPath, 'ObjectModule.bsl'), 'procedure Test()');

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: catalogsPath,
    });

    assert.deepStrictEqual(
      identities.map((identity) => identity.qualifiedName).sort(),
      ['Catalog.Products', 'Catalog.Services']
    );
    assert.deepStrictEqual(
      identities.map((identity) => identity.metadataType),
      ['Catalog', 'Catalog']
    );
  });

  test('indexes Designer folder-style top-level metadata without duplicating object name', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const catalogsPath = path.join(tempRoot, 'Catalogs');
    await writeFile(
      path.join(catalogsPath, 'Products', 'Products.xml'),
      '<MetaDataObject><Catalog uuid="uuid-products"><Properties><Name>Products</Name></Properties></Catalog></MetaDataObject>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: catalogsPath,
    });

    assert.deepStrictEqual(
      identities.map((identity) => identity.qualifiedName),
      ['Catalog.Products']
    );
    assert.deepStrictEqual(
      identities.map((identity) => identity.objectPath),
      ['Catalog.Products']
    );
  });

  test('skips service XML files when indexing a configuration root', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    await writeFile(
      path.join(tempRoot, 'Configuration.xml'),
      '<MetaDataObject><Configuration uuid="configuration-uuid"><Properties><Name>MainConfiguration</Name></Properties></Configuration></MetaDataObject>'
    );
    await writeFile(
      path.join(tempRoot, 'ConfigDumpInfo.xml'),
      '<ConfigDumpInfo><Format>1</Format></ConfigDumpInfo>'
    );
    await writeFile(
      path.join(tempRoot, 'Catalogs', 'Products', 'Products.xml'),
      '<MetaDataObject><Catalog uuid="uuid-products"><Properties><Name>Products</Name></Properties></Catalog></MetaDataObject>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: tempRoot,
    });

    assert.deepStrictEqual(
      identities.map((identity) => identity.qualifiedName),
      ['Catalog.Products']
    );
  });

  test('includes owner context for same-name nested metadata objects', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const documentsPath = path.join(tempRoot, 'Documents');
    await writeFile(
      path.join(documentsPath, 'SalesOrder', 'SalesOrder.xml'),
      '<MetaDataObject><Document><Properties><Name>SalesOrder</Name></Properties></Document></MetaDataObject>'
    );
    await writeFile(
      path.join(documentsPath, 'ReturnOrder', 'ReturnOrder.xml'),
      '<MetaDataObject><Document><Properties><Name>ReturnOrder</Name></Properties></Document></MetaDataObject>'
    );
    await writeFile(
      path.join(documentsPath, 'SalesOrder', 'Forms', 'MainForm', 'MainForm.xml'),
      '<MetaDataObject><Form uuid="sales-main-form"><Properties><Name>MainForm</Name></Properties></Form></MetaDataObject>'
    );
    await writeFile(
      path.join(documentsPath, 'ReturnOrder', 'Forms', 'MainForm', 'MainForm.xml'),
      '<MetaDataObject><Form uuid="return-main-form"><Properties><Name>MainForm</Name></Properties></Form></MetaDataObject>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: documentsPath,
    });
    const formIdentities = identities
      .filter((identity) => identity.metadataType === 'Form')
      .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));

    assert.deepStrictEqual(
      formIdentities.map((identity) => identity.qualifiedName),
      ['Document.ReturnOrder.Form.MainForm', 'Document.SalesOrder.Form.MainForm']
    );
    assert.strictEqual(new Set(formIdentities.map((identity) => identity.qualifiedName)).size, 2);
  });

  test('indexes Designer form descriptor but skips Ext form structure XML', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    await writeFile(
      path.join(tempRoot, 'Documents', 'SalesOrder', 'SalesOrder.xml'),
      '<MetaDataObject><Document><Properties><Name>SalesOrder</Name></Properties></Document></MetaDataObject>'
    );
    await writeFile(
      path.join(tempRoot, 'Documents', 'SalesOrder', 'Forms', 'MainForm.xml'),
      '<MetaDataObject><Form uuid="sales-main-form"><Properties><Name>MainForm</Name></Properties></Form></MetaDataObject>'
    );
    await writeFile(
      path.join(tempRoot, 'Documents', 'SalesOrder', 'Forms', 'MainForm', 'Ext', 'Form.xml'),
      '<Form><AutoCommandBar name="FormCommandBar"/></Form>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: tempRoot,
    });
    const formIdentities = identities.filter((identity) => identity.metadataType === 'Form');

    assert.deepStrictEqual(
      formIdentities.map((identity) => identity.qualifiedName),
      ['Document.SalesOrder.Form.MainForm']
    );
    assert.strictEqual(formIdentities[0]?.filePath, path.join(tempRoot, 'Documents', 'SalesOrder', 'Forms', 'MainForm.xml'));
  });

  test('indexes InformationRegisters from configuration root', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    await writeFile(
      path.join(tempRoot, 'InformationRegisters', 'Prices.xml'),
      '<MetaDataObject><InformationRegister><Properties><Name>Prices</Name></Properties></InformationRegister></MetaDataObject>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: tempRoot,
    });

    assert.deepStrictEqual(
      identities.map((identity) => identity.qualifiedName),
      ['InformationRegister.Prices']
    );
    assert.deepStrictEqual(
      identities.map((identity) => identity.metadataType),
      ['InformationRegister']
    );
  });

  test('indexes InformationRegisters folder directly', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-indexer-'));
    const registersPath = path.join(tempRoot, 'InformationRegisters');
    await writeFile(
      path.join(registersPath, 'Prices.xml'),
      '<MetaDataObject><InformationRegister><Properties><Name>Prices</Name></Properties></InformationRegister></MetaDataObject>'
    );

    const identities = await indexMetadataFolder({
      sourceId: 'left-source',
      side: 'left',
      folderPath: registersPath,
    });

    assert.deepStrictEqual(
      identities.map((identity) => identity.qualifiedName),
      ['InformationRegister.Prices']
    );
    assert.deepStrictEqual(
      identities.map((identity) => identity.metadataType),
      ['InformationRegister']
    );
  });
});

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}
