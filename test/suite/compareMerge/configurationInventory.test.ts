import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { buildConfigurationInventory } from '../../../src/compareMerge/inventory/configurationInventory';

suite('ConfigurationInventory', () => {
  test('indexes metadata descriptor with Ext XML, BSL module and opaque artifacts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-inventory-'));
    const catalogRoot = path.join(tempRoot, 'Catalogs', 'Products');
    const descriptorPath = path.join(catalogRoot, 'Products.xml');
    await writeFile(
      descriptorPath,
      '<MetaDataObject><Catalog uuid="catalog-products"><Properties><Name>Products</Name></Properties></Catalog></MetaDataObject>'
    );
    await writeFile(path.join(catalogRoot, 'Ext', 'Form.xml'), '<Form><Attributes /></Form>');
    await writeFile(path.join(catalogRoot, 'Ext', 'ObjectModule.bsl'), 'Procedure Test()\nEndProcedure');
    await writeFile(path.join(catalogRoot, 'Ext', 'logo.bin'), 'opaque');

    const inventory = await buildConfigurationInventory(tempRoot);
    const object = inventory.objects.find((candidate) => candidate.qualifiedName === 'Catalog.Products');

    assert.ok(object);
    assert.strictEqual(object.metadataType, 'Catalog');
    assert.strictEqual(object.uuid, 'catalog-products');
    assert.strictEqual(object.descriptorPath, descriptorPath);
    assert.strictEqual(object.containerPath, catalogRoot);

    const artifacts = inventory.artifactsByObjectId.get(object.objectId) ?? [];
    assert.deepStrictEqual(
      artifacts.map((artifact) => [artifact.kind, artifact.mergeMode, artifact.relativePath]).sort(),
      [
        ['binaryOrOpaqueFile', 'fileOperation', path.join('Catalogs', 'Products', 'Ext', 'logo.bin')],
        ['bslModule', 'bslRoutine', path.join('Catalogs', 'Products', 'Ext', 'ObjectModule.bsl')],
        ['formXml', 'xmlPatch', path.join('Catalogs', 'Products', 'Ext', 'Form.xml')],
        ['metadataXml', 'xmlPatch', path.join('Catalogs', 'Products', 'Products.xml')],
      ]
    );
    assert.ok(artifacts.every((artifact) => artifact.ownerObjectId === object.objectId));
    assert.ok(artifacts.every((artifact) => artifact.contentHash.startsWith('sha256:')));
  });
});

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}
