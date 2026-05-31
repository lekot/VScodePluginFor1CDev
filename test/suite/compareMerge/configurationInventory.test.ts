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

  test('indexes representative metadata object types and owns their merge artifacts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-inventory-'));
    try {
      for (const fixture of representativeMetadataFixtures()) {
        await writeDescriptor(tempRoot, fixture.relativePath, fixture.metadataType, fixture.name, fixture.uuid);
      }
      await writeFile(path.join(tempRoot, 'CommonForms', 'Chooser', 'Ext', 'Form.xml'), '<Form />');
      await writeFile(
        path.join(tempRoot, 'ChartsOfCharacteristicTypes', 'Properties', 'Ext', 'Predefined.xml'),
        '<PredefinedData />'
      );

      const inventory = await buildConfigurationInventory(tempRoot);
      const objectsByName = new Map(inventory.objects.map((object) => [object.qualifiedName, object]));

      for (const fixture of representativeMetadataFixtures()) {
        const object = objectsByName.get(fixture.qualifiedName);
        assert.ok(object, `Expected ${fixture.qualifiedName} to be indexed.`);
        assert.strictEqual(object.metadataType, fixture.metadataType);
        assert.strictEqual(object.uuid, fixture.uuid);
      }

      const commonForm = objectsByName.get('CommonForm.Chooser');
      assert.ok(commonForm);
      assert.ok(
        (inventory.artifactsByObjectId.get(commonForm.objectId) ?? []).some(
          (artifact) =>
            artifact.kind === 'formXml' &&
            artifact.mergeMode === 'xmlPatch' &&
            artifact.relativePath === path.join('CommonForms', 'Chooser', 'Ext', 'Form.xml')
        )
      );

      const chart = objectsByName.get('ChartOfCharacteristicTypes.Properties');
      assert.ok(chart);
      assert.ok(
        (inventory.artifactsByObjectId.get(chart.objectId) ?? []).some(
          (artifact) =>
            artifact.kind === 'predefinedXml' &&
            artifact.mergeMode === 'xmlPatch' &&
            artifact.relativePath === path.join(
              'ChartsOfCharacteristicTypes',
              'Properties',
              'Ext',
              'Predefined.xml'
            )
        )
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

interface MetadataFixture {
  qualifiedName: string;
  relativePath: string;
  metadataType: string;
  name: string;
  uuid: string;
}

function representativeMetadataFixtures(): MetadataFixture[] {
  return [
    {
      qualifiedName: 'Document.Order',
      relativePath: path.join('Documents', 'Order', 'Order.xml'),
      metadataType: 'Document',
      name: 'Order',
      uuid: 'document-order',
    },
    {
      qualifiedName: 'Enum.Status',
      relativePath: path.join('Enums', 'Status', 'Status.xml'),
      metadataType: 'Enum',
      name: 'Status',
      uuid: 'enum-status',
    },
    {
      qualifiedName: 'Role.Admin',
      relativePath: path.join('Roles', 'Admin', 'Admin.xml'),
      metadataType: 'Role',
      name: 'Admin',
      uuid: 'role-admin',
    },
    {
      qualifiedName: 'CommonForm.Chooser',
      relativePath: path.join('CommonForms', 'Chooser', 'Chooser.xml'),
      metadataType: 'CommonForm',
      name: 'Chooser',
      uuid: 'common-form-chooser',
    },
    {
      qualifiedName: 'InformationRegister.Stock.Dimension.Warehouse',
      relativePath: path.join('InformationRegisters', 'Stock', 'Dimensions', 'Warehouse.xml'),
      metadataType: 'Dimension',
      name: 'Warehouse',
      uuid: 'dimension-warehouse',
    },
    {
      qualifiedName: 'Document.Order.TabularSection.Goods',
      relativePath: path.join('Documents', 'Order', 'TabularSections', 'Goods.xml'),
      metadataType: 'TabularSection',
      name: 'Goods',
      uuid: 'tabular-section-goods',
    },
    {
      qualifiedName: 'ChartOfCharacteristicTypes.Properties',
      relativePath: path.join('ChartsOfCharacteristicTypes', 'Properties', 'Properties.xml'),
      metadataType: 'ChartOfCharacteristicTypes',
      name: 'Properties',
      uuid: 'cct-properties',
    },
  ];
}

async function writeDescriptor(
  root: string,
  relativePath: string,
  metadataType: string,
  name: string,
  uuid: string
): Promise<void> {
  await writeFile(
    path.join(root, relativePath),
    `<MetaDataObject><${metadataType} uuid="${uuid}"><Properties><Name>${name}</Name></Properties></${metadataType}></MetaDataObject>`
  );
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}
