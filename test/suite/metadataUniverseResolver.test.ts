import * as assert from 'assert';
import { createHash } from 'crypto';
import * as path from 'path';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import {
  MetadataUniverseResolver,
  resolveMetadataUniverseEntry,
} from '../../src/support/metadataUniverseResolver';
import { SUPPORT_UUIDS } from './supportTestFixtures';

suite('MetadataUniverseResolver', () => {
  const configRoot = path.resolve('synthetic-universe-root');

  test('resolves exact object, own-child, owner-fallback and synthetic identities', async () => {
    const tree = completeTree(configRoot);
    const catalog = tree.children![0]!.children![0]!;
    const group = catalog.children![0]!;
    const ownAttribute = group.children![0]!;
    const inheritedAttribute = group.children![1]!;
    const module = catalog.children![1]!;
    const relativeCatalog = relative(configRoot, catalog.filePath!);
    const relativeModule = relative(configRoot, module.filePath!);

    assert.deepStrictEqual(resolveMetadataUniverseEntry(configRoot, catalog), {
      relativeMetadataPath: relativeCatalog,
      objectUuid: SUPPORT_UUIDS.objectA,
      supportSubjectUuid: SUPPORT_UUIDS.objectA,
    });
    assert.deepStrictEqual(resolveMetadataUniverseEntry(configRoot, ownAttribute), {
      relativeMetadataPath: `${relativeCatalog}#Attribute.Own`,
      objectUuid: SUPPORT_UUIDS.objectB,
      supportSubjectUuid: SUPPORT_UUIDS.objectB,
    });
    assert.deepStrictEqual(resolveMetadataUniverseEntry(configRoot, inheritedAttribute), {
      relativeMetadataPath: `${relativeCatalog}#Attribute.Inherited`,
      objectUuid: SUPPORT_UUIDS.objectA,
      supportSubjectUuid: SUPPORT_UUIDS.objectA,
    });
    assert.deepStrictEqual(resolveMetadataUniverseEntry(configRoot, module), {
      relativeMetadataPath: `${relativeModule}#ObjectModule`,
      objectUuid: SUPPORT_UUIDS.objectA,
      supportSubjectUuid: SUPPORT_UUIDS.objectA,
    });

    const snapshot = await new MetadataUniverseResolver({
      loadTree: async () => tree,
    }).resolve(configRoot);
    assert.deepStrictEqual(snapshot.entries, [
      {
        relativeMetadataPath: `${relativeCatalog}#Attribute.Inherited`,
        objectUuid: SUPPORT_UUIDS.objectA,
        supportSubjectUuid: SUPPORT_UUIDS.objectA,
      },
      {
        relativeMetadataPath: `${relativeCatalog}#Attribute.Own`,
        objectUuid: SUPPORT_UUIDS.objectB,
        supportSubjectUuid: SUPPORT_UUIDS.objectB,
      },
      {
        relativeMetadataPath: relativeCatalog,
        objectUuid: SUPPORT_UUIDS.objectA,
        supportSubjectUuid: SUPPORT_UUIDS.objectA,
      },
      {
        relativeMetadataPath: `${relativeModule}#ObjectModule`,
        objectUuid: SUPPORT_UUIDS.objectA,
        supportSubjectUuid: SUPPORT_UUIDS.objectA,
      },
    ].sort(compareEntries));
  });

  test('generation is SHA-256 of sorted exact triples and independent of traversal order', async () => {
    const firstTree = completeTree(configRoot);
    const secondTree = completeTree(configRoot);
    secondTree.children!.reverse();
    secondTree.children![0]!.children!.reverse();
    const resolverA = new MetadataUniverseResolver({ loadTree: async () => firstTree });
    const resolverB = new MetadataUniverseResolver({ loadTree: async () => secondTree });

    const first = await resolverA.resolve(configRoot);
    const second = await resolverB.resolve(configRoot);
    const canonical = first.entries
      .map((entry) =>
        `${entry.relativeMetadataPath}\0${entry.objectUuid}\0${entry.supportSubjectUuid}`)
      .join('\n');

    assert.strictEqual(
      first.metadataUniverseGenerationId,
      createHash('sha256').update(canonical, 'utf8').digest('hex'),
    );
    assert.strictEqual(second.metadataUniverseGenerationId, first.metadataUniverseGenerationId);
    assert.deepStrictEqual(second.entries, first.entries);
  });

  test('generation changes when an exact UUID or metadata path changes', async () => {
    const baseline = await new MetadataUniverseResolver({
      loadTree: async () => completeTree(configRoot),
    }).resolve(configRoot);
    const changedUuidTree = completeTree(configRoot);
    changedUuidTree.children![0]!.children![0]!.properties.uuid = SUPPORT_UUIDS.objectC;
    const changedPathTree = completeTree(configRoot);
    changedPathTree.children![0]!.children![0]!.filePath =
      path.join(configRoot, 'Catalogs', 'Renamed.xml');
    for (const child of changedPathTree.children![0]!.children![0]!.children ?? []) {
      for (const nested of child.children ?? []) {
        nested.parentFilePath = changedPathTree.children![0]!.children![0]!.filePath;
      }
    }
    const changedUuid = await new MetadataUniverseResolver({
      loadTree: async () => changedUuidTree,
    }).resolve(configRoot);
    const changedPath = await new MetadataUniverseResolver({
      loadTree: async () => changedPathTree,
    }).resolve(configRoot);

    assert.notStrictEqual(changedUuid.metadataUniverseGenerationId, baseline.metadataUniverseGenerationId);
    assert.notStrictEqual(changedPath.metadataUniverseGenerationId, baseline.metadataUniverseGenerationId);
  });

  test('rejects wrong root, empty universe, lazy tree and concrete objects without valid UUID', async () => {
    const wrongRoot: TreeNode = {
      id: 'Catalog',
      name: 'Catalog',
      type: MetadataType.Catalog,
      properties: { uuid: SUPPORT_UUIDS.objectA },
      filePath: path.join(configRoot, 'Catalogs', 'A.xml'),
    };
    const emptyRoot = configurationRoot();
    const lazyRoot = completeTree(configRoot);
    lazyRoot.children![0]!.properties._lazy = true;
    const missingUuid = completeTree(configRoot);
    delete missingUuid.children![0]!.children![0]!.properties.uuid;

    await assert.rejects(resolveTree(configRoot, wrongRoot), /root is not a configuration/);
    await assert.rejects(resolveTree(configRoot, emptyRoot), /no concrete metadata nodes/);
    await assert.rejects(resolveTree(configRoot, lazyRoot), /lazy node/);
    await assert.rejects(resolveTree(configRoot, missingUuid), /concrete node .* has no valid UUID/);
  });

  test('rejects outside/missing paths and inconsistent parent links', async () => {
    const outside = completeTree(configRoot);
    outside.children![0]!.children![0]!.filePath = path.resolve(configRoot, '..', 'Outside.xml');
    const missingPath = completeTree(configRoot);
    delete missingPath.children![0]!.children![0]!.filePath;
    const inconsistent = completeTree(configRoot);
    inconsistent.children![0]!.children![0]!.parent = configurationRoot();

    await assert.rejects(resolveTree(configRoot, outside), /outside the configuration root/);
    await assert.rejects(resolveTree(configRoot, missingPath), /has no metadata path/);
    await assert.rejects(resolveTree(configRoot, inconsistent), /inconsistent parent/);
  });

  test('rejects duplicate own object UUIDs and duplicate fallback node identities', async () => {
    const duplicateUuid = completeTree(configRoot);
    const folder = duplicateUuid.children![0]!;
    const secondCatalog: TreeNode = {
      id: 'Catalog.Second',
      name: 'Second',
      type: MetadataType.Catalog,
      parent: folder,
      properties: { uuid: SUPPORT_UUIDS.objectA },
      filePath: path.join(configRoot, 'Catalogs', 'Second.xml'),
    };
    folder.children!.push(secondCatalog);

    const duplicateFallback = completeTree(configRoot);
    const attributeGroup = duplicateFallback.children![0]!.children![0]!.children![0]!;
    const original = attributeGroup.children![1]!;
    attributeGroup.children!.push({
      ...original,
      parent: attributeGroup,
      properties: {},
    });

    await assert.rejects(resolveTree(configRoot, duplicateUuid), /duplicate object UUID/i);
    await assert.rejects(resolveTree(configRoot, duplicateFallback), /duplicate node identity/i);
  });

  test('rejects unsupported UUID-owning and ambiguous synthetic nodes', async () => {
    const unsupported = completeTree(configRoot);
    const owner = unsupported.children![0]!.children![0]!;
    owner.children!.push({
      id: 'UnknownNode',
      name: 'UnknownNode',
      type: MetadataType.ConfigurationPackage,
      parent: owner,
      properties: { uuid: SUPPORT_UUIDS.objectC },
      filePath: path.join(configRoot, 'Unknown.xml'),
    });
    const syntheticWithUuid = completeTree(configRoot);
    syntheticWithUuid.children![0]!.children![0]!.children![1]!.properties.uuid =
      SUPPORT_UUIDS.objectC;

    await assert.rejects(resolveTree(configRoot, unsupported), /unsupported node type/);
    await assert.rejects(resolveTree(configRoot, syntheticWithUuid), /synthetic node .* owns UUID/);
  });
});

function completeTree(configRoot: string): TreeNode {
  const root = configurationRoot();
  const folder: TreeNode = {
    id: 'Catalogs',
    name: 'Catalogs',
    type: MetadataType.Catalog,
    parent: root,
    properties: { type: 'Catalogs' },
    children: [],
  };
  const catalogPath = path.join(configRoot, 'Catalogs', 'Products.xml');
  const catalog: TreeNode = {
    id: 'Catalog.Products',
    name: 'Products',
    type: MetadataType.Catalog,
    parent: folder,
    properties: { uuid: SUPPORT_UUIDS.objectA },
    filePath: catalogPath,
    children: [],
  };
  const attributes: TreeNode = {
    id: 'Attributes',
    name: 'Attributes',
    type: MetadataType.Attribute,
    parent: catalog,
    properties: {},
    children: [],
  };
  const ownAttribute: TreeNode = {
    id: 'Attribute.Own',
    name: 'Own',
    type: MetadataType.Attribute,
    parent: attributes,
    properties: { uuid: SUPPORT_UUIDS.objectB },
    parentFilePath: catalogPath,
  };
  const inheritedAttribute: TreeNode = {
    id: 'Attribute.Inherited',
    name: 'Inherited',
    type: MetadataType.Attribute,
    parent: attributes,
    properties: {},
    parentFilePath: catalogPath,
  };
  const module: TreeNode = {
    id: 'ObjectModule',
    name: 'ObjectModule',
    type: MetadataType.Method,
    parent: catalog,
    properties: { isModule: true },
    filePath: path.join(configRoot, 'Catalogs', 'Products', 'Ext', 'ObjectModule.bsl'),
  };
  attributes.children = [ownAttribute, inheritedAttribute];
  catalog.children = [attributes, module];
  folder.children = [catalog];
  root.children = [folder];
  return root;
}

function configurationRoot(): TreeNode {
  return {
    id: 'Configuration',
    name: 'Configuration',
    type: MetadataType.Configuration,
    properties: {},
    children: [],
  };
}

function resolveTree(configRoot: string, tree: TreeNode) {
  return new MetadataUniverseResolver({ loadTree: async () => tree }).resolve(configRoot);
}

function relative(configRoot: string, filePath: string): string {
  return path.relative(configRoot, filePath).replace(/\\/g, '/');
}

function compareEntries(
  left: { relativeMetadataPath: string; objectUuid: string; supportSubjectUuid: string },
  right: { relativeMetadataPath: string; objectUuid: string; supportSubjectUuid: string },
): number {
  return left.relativeMetadataPath.localeCompare(right.relativeMetadataPath)
    || left.objectUuid.localeCompare(right.objectUuid)
    || left.supportSubjectUuid.localeCompare(right.supportSubjectUuid);
}
