import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import fsPromises = require('fs/promises');
import * as os from 'os';
import * as path from 'path';

import { buildConfigurationInventory } from '../../../src/compareMerge/inventory/configurationInventory';
import { createArtifactUnit } from '../../../src/compareMerge/inventory/configurationArtifacts';
import type { MetadataIdentity } from '../../../src/compareMerge/domain/compareContracts';

suite('ConfigurationInventory', () => {
  test('scans overlapping selected object containers once and preserves selected artifact ownership', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-inventory-overlap-'));
    try {
      const parentDescriptor = path.join(tempRoot, 'Catalogs', 'Parent', 'Parent.xml');
      const childDescriptor = path.join(tempRoot, 'Catalogs', 'Parent', 'TabularSections', 'Items.xml');
      const siblingDescriptor = path.join(tempRoot, 'Catalogs', 'Parent', 'TabularSections', 'Other.xml');
      const parentBsl = path.join(tempRoot, 'Catalogs', 'Parent', 'Ext', 'ObjectModule.bsl');
      const childBsl = path.join(tempRoot, 'Catalogs', 'Parent', 'TabularSections', 'Items', 'Ext', 'Module.bsl');
      const siblingBsl = path.join(tempRoot, 'Catalogs', 'Parent', 'TabularSections', 'Other', 'Ext', 'Module.bsl');
      await writeFile(parentDescriptor, '<MetaDataObject><Catalog uuid="parent" /></MetaDataObject>');
      await writeFile(childDescriptor, '<MetaDataObject><TabularSection uuid="items" /></MetaDataObject>');
      await writeFile(siblingDescriptor, '<MetaDataObject><TabularSection uuid="other" /></MetaDataObject>');
      await writeFile(parentBsl, 'Procedure Parent()\nEndProcedure');
      await writeFile(childBsl, 'Procedure Child()\nEndProcedure');
      await writeFile(siblingBsl, 'Procedure Sibling()\nEndProcedure');

      const identities = [
        inventoryIdentity(tempRoot, 'Catalog', 'Catalog.Parent', parentDescriptor, 'parent'),
        inventoryIdentity(tempRoot, 'TabularSection', 'TabularSection.Items', childDescriptor, 'items'),
        inventoryIdentity(tempRoot, 'TabularSection', 'TabularSection.Other', siblingDescriptor, 'other'),
      ];
      const mutableFs = fsPromises;
      const originalReaddir = mutableFs.readdir;
      const readdirCounts = new Map<string, number>();
      let activeReaddirs = 0;
      let maximumActiveReaddirs = 0;
      const instrumentedReaddir = (async (...args: Parameters<typeof originalReaddir>) => {
        const requestedPath = args[0];
        if (typeof requestedPath === 'string') {
          const key = path.resolve(requestedPath).toLowerCase();
          readdirCounts.set(key, (readdirCounts.get(key) ?? 0) + 1);
        }
        activeReaddirs += 1;
        maximumActiveReaddirs = Math.max(maximumActiveReaddirs, activeReaddirs);
        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return await Reflect.apply(originalReaddir, mutableFs, args);
        } finally {
          activeReaddirs -= 1;
        }
      }) as typeof originalReaddir;
      Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: instrumentedReaddir });
      let inventory: Awaited<ReturnType<typeof buildConfigurationInventory>>;
      try {
        inventory = await buildConfigurationInventory(tempRoot, {
          identities,
          includeDescriptorPaths: new Set([parentDescriptor, childDescriptor]),
        });
      } finally {
        Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: originalReaddir });
      }

      assert.ok([...readdirCounts.values()].every((count) => count === 1), 'every overlapping physical directory should be enumerated once');
      assert.ok(maximumActiveReaddirs > 1, 'independent directory reads should run concurrently');
      assert.ok(maximumActiveReaddirs <= 8, 'directory reads must respect the bounded worker pool');
      const parentKey = path.resolve(path.dirname(parentDescriptor)).toLowerCase();
      const childSidecarKey = path.resolve(path.dirname(childBsl)).toLowerCase();
      assert.strictEqual(readdirCounts.get(parentKey), 1);
      assert.strictEqual(readdirCounts.get(childSidecarKey), 1);
      const parent = inventory.objects.find((object) => object.qualifiedName === 'Catalog.Parent');
      const child = inventory.objects.find((object) => object.qualifiedName === 'TabularSection.Items');
      assert.ok(parent);
      assert.ok(child);
      const ownedArtifacts = [...inventory.artifactsByObjectId.entries()].flatMap(([ownerId, artifacts]) =>
        artifacts.map((artifact) => [ownerId, path.relative(tempRoot, artifact.filePath).replace(/\\/gu, '/')]),
      );
      assert.deepStrictEqual(ownedArtifacts.sort((left, right) => String(left[1]).localeCompare(String(right[1]))), [
        [parent.objectId, 'Catalogs/Parent/Ext/ObjectModule.bsl'],
        [parent.objectId, 'Catalogs/Parent/Parent.xml'],
        [child.objectId, 'Catalogs/Parent/TabularSections/Items.xml'],
        [child.objectId, 'Catalogs/Parent/TabularSections/Items/Ext/Module.bsl'],
      ].sort((left, right) => String(left[1]).localeCompare(String(right[1]))));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('cancels selected-directory traversal without scheduling child reads or leaving reads active', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-inventory-cancel-dir-'));
    try {
      const descriptorPath = path.join(tempRoot, 'Catalogs', 'Parent', 'Parent.xml');
      await writeFile(descriptorPath, '<MetaDataObject><Catalog uuid="parent" /></MetaDataObject>');
      for (let index = 0; index < 20; index += 1) {
        await writeFile(path.join(tempRoot, 'Catalogs', 'Parent', `Nested${index}`, 'Ext', 'Module.bsl'), 'Procedure Test()\nEndProcedure');
      }
      const identity = inventoryIdentity(tempRoot, 'Catalog', 'Catalog.Parent', descriptorPath, 'parent');
      const mutableFs = fsPromises;
      const originalReaddir = mutableFs.readdir;
      let cancelled = false;
      let reads = 0;
      let activeReads = 0;
      const instrumentedReaddir = (async (...args: Parameters<typeof originalReaddir>) => {
        reads += 1;
        activeReads += 1;
        try {
          const entries = await Reflect.apply(originalReaddir, mutableFs, args);
          cancelled = true;
          return entries;
        } finally {
          activeReads -= 1;
        }
      }) as typeof originalReaddir;
      Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: instrumentedReaddir });
      try {
        await assert.rejects(
          buildConfigurationInventory(tempRoot, {
            identities: [identity],
            includeDescriptorPaths: new Set([descriptorPath]),
            cancellation: { get isCancellationRequested() { return cancelled; } },
          }),
          (error: unknown) => (error as { code?: string }).code === 'CONFIGURATION_COMPARE_CANCELLED',
        );
        assert.strictEqual(reads, 1, 'cancellation after the current directory read must prevent queueing its child directories');
        assert.strictEqual(activeReads, 0, 'the traversal must await the in-flight directory read before rejecting');
      } finally {
        Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: originalReaddir });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('drains in-flight artifact reads after cancellation and does not start more work', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-inventory-cancel-artifacts-'));
    try {
      const descriptorPath = path.join(tempRoot, 'Catalogs', 'Parent', 'Parent.xml');
      await writeFile(descriptorPath, '<MetaDataObject><Catalog uuid="parent" /></MetaDataObject>');
      for (let index = 0; index < 8; index += 1) {
        await writeFile(path.join(tempRoot, 'Catalogs', 'Parent', 'Ext', `Module${index}.bsl`), 'Procedure Test()\nEndProcedure');
      }
      const identity = inventoryIdentity(tempRoot, 'Catalog', 'Catalog.Parent', descriptorPath, 'parent');
      const mutableFs = fsPromises;
      const originalOpen = mutableFs.open;
      let cancelled = false;
      let openCount = 0;
      let activeOpenCalls = 0;
      let releaseBarrier: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => {releaseBarrier = resolve;});
      const instrumentedOpen = (async (...args: Parameters<typeof originalOpen>) => {
        const handle = await Reflect.apply(originalOpen, mutableFs, args);
        const callIndex = ++openCount;
        activeOpenCalls += 1;
        if (callIndex === 3) {
          cancelled = true;
          releaseBarrier?.();
        }
        await barrier;
        if (callIndex > 1) {await new Promise((resolve) => setTimeout(resolve, 75));}
        activeOpenCalls -= 1;
        return handle;
      }) as typeof originalOpen;
      Object.defineProperty(mutableFs, 'open', { configurable: true, value: instrumentedOpen });
      try {
        const build = buildConfigurationInventory(tempRoot, {
          identities: [identity],
          includeDescriptorPaths: new Set([descriptorPath]),
          artifactConcurrency: 3,
          cancellation: { get isCancellationRequested() { return cancelled; } },
        });
        await assert.rejects(build, (error: unknown) => (error as { code?: string }).code === 'CONFIGURATION_COMPARE_CANCELLED');
        const activeAtBuildRejection = activeOpenCalls;
        const waitForDrain = async (): Promise<void> => {
          while (activeOpenCalls > 0) {await new Promise((resolve) => setTimeout(resolve, 5));}
        };
        await waitForDrain();
        assert.strictEqual(activeAtBuildRejection, 0, 'the inventory promise must not reject before active artifact opens drain');
        assert.strictEqual(openCount, 3, 'cancellation must stop scheduling additional artifact reads');
      } finally {
        Object.defineProperty(mutableFs, 'open', { configurable: true, value: originalOpen });
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('preserves full-root ENOENT failures while ignoring a missing selected object container', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-inventory-missing-'));
    try {
      const descriptorPath = path.join(tempRoot, 'Catalogs', 'Parent.xml');
      await writeFile(descriptorPath, '<MetaDataObject><Catalog uuid="parent" /></MetaDataObject>');
      const identity = inventoryIdentity(tempRoot, 'Catalog', 'Catalog.Parent', descriptorPath, 'parent');
      const mutableFs = fsPromises;
      const originalReaddir = mutableFs.readdir;
      const missingDirectory = path.join(tempRoot, 'Catalogs');
      const missingError = Object.assign(new Error('simulated directory disappearance'), { code: 'ENOENT' });
      const instrumentedReaddir = (async (...args: Parameters<typeof originalReaddir>) => {
        if (typeof args[0] === 'string' && path.resolve(args[0]) === path.resolve(missingDirectory)) {throw missingError;}
        return Reflect.apply(originalReaddir, mutableFs, args);
      }) as typeof originalReaddir;
      Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: instrumentedReaddir });
      try {
        await assert.rejects(
          buildConfigurationInventory(tempRoot, { identities: [identity] }),
          (error: unknown) => error === missingError,
        );
      } finally {
        Object.defineProperty(mutableFs, 'readdir', { configurable: true, value: originalReaddir });
      }

      const selected = await buildConfigurationInventory(tempRoot, {
        identities: [identity],
        includeDescriptorPaths: new Set([descriptorPath]),
      });
      const object = selected.objects[0];
      assert.ok(object);
      assert.deepStrictEqual(
        (selected.artifactsByObjectId.get(object.objectId) ?? []).map((artifact) => artifact.relativePath),
        [path.relative(tempRoot, descriptorPath)],
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

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
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('classifies Rights and DCS Template XML only by the exact expanded root name', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-artifact-roots-'));
    try {
      const rightsPath = path.join(tempRoot, 'Roles', 'Admin', 'Ext', 'Rights.xml');
      const wrongRightsPath = path.join(tempRoot, 'Roles', 'Other', 'Ext', 'Rights.xml');
      const dcsPath = path.join(tempRoot, 'DataProcessors', 'Report', 'Templates', 'Main', 'Template.xml');
      const opaquePath = path.join(tempRoot, 'DataProcessors', 'Report', 'Templates', 'Spreadsheet', 'Template.xml');
      await writeFile(rightsPath,
        '<?xml version="1.0"?><!----><?generated by test?><Rights xmlns="http://v8.1c.ru/8.2/roles" />');
      await writeFile(wrongRightsPath, '<Rights xmlns="urn:foreign" />');
      await writeFile(dcsPath,
        '<cfg:DataCompositionSchema xmlns:cfg="http://v8.1c.ru/8.1/data-composition-system/schema" />');
      await writeFile(opaquePath,
        '<document xmlns="urn:spreadsheet"><![CDATA[This may be a large opaque workbook payload.]]></document>');

      const create = (filePath: string) => createArtifactUnit({ rootPath: tempRoot, filePath });
      const [rights, wrongRights, dcs, opaque] = await Promise.all([
        create(rightsPath), create(wrongRightsPath), create(dcsPath), create(opaquePath),
      ]);
      assert.strictEqual(rights.kind, 'roleRightsXml');
      assert.strictEqual(rights.mergeMode, 'xmlPatch');
      assert.strictEqual(wrongRights.kind, 'binaryOrOpaqueFile');
      assert.strictEqual(dcs.kind, 'dcsXml');
      assert.strictEqual(dcs.mergeMode, 'xmlPatch');
      assert.strictEqual(opaque.kind, 'binaryOrOpaqueFile');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test('hashes the full captured stream while probing only the bounded Template.xml root', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-artifact-stream-'));
    try {
      const templatePath = path.join(tempRoot, 'DataProcessors', 'Report', 'Templates', 'Spreadsheet', 'Template.xml');
      const content = Buffer.concat([
        Buffer.from('<document xmlns="urn:spreadsheet">', 'utf8'),
        Buffer.alloc(128 * 1024, 0x61),
        Buffer.from('</document>', 'utf8'),
      ]);
      await fs.mkdir(path.dirname(templatePath), { recursive: true });
      await fs.writeFile(templatePath, content);

      const artifact = await createArtifactUnit({ rootPath: tempRoot, filePath: templatePath });
      assert.strictEqual(artifact.kind, 'binaryOrOpaqueFile');
      assert.strictEqual(artifact.contentHash, `sha256:${createHash('sha256').update(content).digest('hex')}`);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

function inventoryIdentity(
  rootPath: string,
  metadataType: string,
  qualifiedName: string,
  filePath: string,
  uuid: string,
): MetadataIdentity {
  const normalizedPath = path.normalize(filePath);
  return {
    sourceId: 'inventory-test',
    side: 'left',
    metadataType,
    qualifiedName,
    uuid,
    filePath: normalizedPath,
    containerPath: path.dirname(normalizedPath),
    objectPath: path.relative(rootPath, normalizedPath),
    nameSource: 'fileName',
    uuidSource: 'xmlAttribute',
    confidence: 'strong',
  };
}
