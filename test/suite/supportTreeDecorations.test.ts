import * as assert from 'assert';
import * as path from 'path';
import {
  createMetadataUniverseIdentityIndex,
  type CachedSupportStatus,
} from '../../src/support/supportStateCache';
import {
  resolveSupportSyncHealth,
  resolveSupportTreeDecoration,
} from '../../src/support/supportTreeDecorations';
import { MetadataType, type TreeNode } from '../../src/models/treeNode';
import type { ConfigurationId } from '../../src/services/configurationSession/types';
import type {
  ConfigurationSupportMode,
  MetadataUniverseEntry,
  ObjectSupportMode,
  SupportRunSummary,
} from '../../src/support/supportTypes';

suite('Support tree decorations exact semantics', () => {
  const configurationId = 'cfg-tree' as ConfigurationId;
  const objectId = '11111111-1111-1111-1111-111111111111';

  test('configuration locked and mixed are aggregate states, never object lock icons', () => {
    const configRoot = path.resolve('support-tree-config');
    const root = configurationNode(configRoot);

    for (const mode of ['locked', 'mixed'] as const) {
      const decoration = resolveSupportTreeDecoration(
        root,
        cached(configRoot, objectId, 'notEditable', mode),
      );
      assert.strictEqual(decoration?.kind, 'configuration');
      if (decoration?.kind !== 'configuration') {
        continue;
      }
      assert.strictEqual(decoration.mode, mode);
      assert.ok(decoration.contextTokens.includes(`supportConfiguration.${mode}`));
      assert.strictEqual('iconIntent' in decoration, false);
    }
  });

  test('only an exact concrete universe member receives the object lock intent', () => {
    const configRoot = path.resolve('support-tree-exact');
    const root = configurationNode(configRoot);
    const object = catalogNode(root, configRoot, objectId);
    const status = cached(configRoot, objectId, 'notEditable', 'mixed');

    const decoration = resolveSupportTreeDecoration(object, status);

    assert.strictEqual(decoration?.kind, 'object');
    if (decoration?.kind !== 'object') {
      return;
    }
    assert.strictEqual(decoration.objectId, objectId);
    assert.strictEqual(decoration.locked, true);
    assert.strictEqual(decoration.iconIntent, 'lock');
    assert.ok(decoration.contextTokens.includes('supportObject.locked'));
  });

  test('editable concrete object keeps support context without a lock icon', () => {
    const configRoot = path.resolve('support-tree-editable');
    const root = configurationNode(configRoot);
    const object = catalogNode(root, configRoot, objectId);

    const decoration = resolveSupportTreeDecoration(
      object,
      cached(configRoot, objectId, 'editableWithSupport', 'editable'),
    );

    assert.strictEqual(decoration?.kind, 'object');
    if (decoration?.kind === 'object') {
      assert.strictEqual(decoration.locked, false);
      assert.strictEqual(decoration.iconIntent, undefined);
      assert.ok(decoration.contextTokens.includes('supportObject.editable'));
    }
  });

  test('virtual, module, subelement, wrong-root and non-indexed nodes never inherit an owner lock', () => {
    const configRoot = path.resolve('support-tree-rejections');
    const root = configurationNode(configRoot);
    const object = catalogNode(root, configRoot, objectId);
    const status = cached(configRoot, objectId, 'notEditable', 'locked');
    const virtualObject: TreeNode = {
      ...object,
      id: 'Catalog.Products.Virtual',
      properties: { ...object.properties, isVirtual: true },
    };
    const moduleNode: TreeNode = {
      id: 'Catalog.Products.ObjectModule',
      name: 'ObjectModule',
      type: MetadataType.Method,
      parent: object,
      parentFilePath: object.filePath,
      properties: { isModule: true },
    };
    const attributeNode: TreeNode = {
      id: 'Catalog.Products.Attribute.Code',
      name: 'Code',
      type: MetadataType.Attribute,
      parent: object,
      parentFilePath: object.filePath,
      properties: { uuid: '22222222-2222-2222-2222-222222222222' },
    };
    const wrongRoot = {
      ...status,
      configRoot: path.resolve('another-root'),
    };
    const nonIndexed = {
      ...status,
      metadataUniverseIdentityIndex: createMetadataUniverseIdentityIndex([]),
    } as CachedSupportStatus;

    assert.strictEqual(resolveSupportTreeDecoration(virtualObject, status), undefined);
    assert.strictEqual(resolveSupportTreeDecoration(moduleNode, status), undefined);
    assert.strictEqual(resolveSupportTreeDecoration(attributeNode, status), undefined);
    assert.strictEqual(resolveSupportTreeDecoration(object, wrongRoot), undefined);
    assert.strictEqual(resolveSupportTreeDecoration(object, nonIndexed), undefined);
  });

  test('replication health stays independent from configuration support aggregate', () => {
    const inDoubtRun = {
      state: 'partial',
      targets: [{ state: 'inDoubt' }],
    } as unknown as SupportRunSummary;
    const staleRun = {
      state: 'partial',
      targets: [{ state: 'stale' }],
    } as unknown as SupportRunSummary;

    assert.strictEqual(resolveSupportSyncHealth(undefined), undefined);
    assert.strictEqual(resolveSupportSyncHealth({ state: 'complete' } as SupportRunSummary), undefined);
    assert.strictEqual(resolveSupportSyncHealth(inDoubtRun)?.state, 'inDoubt');
    assert.strictEqual(resolveSupportSyncHealth(staleRun)?.state, 'stale');
    assert.strictEqual(
      resolveSupportSyncHealth({ state: 'obsolete' } as SupportRunSummary)?.state,
      'obsolete',
    );
  });

  function cached(
    configRoot: string,
    supportObjectId: string,
    mode: ObjectSupportMode,
    configurationMode: ConfigurationSupportMode,
  ): CachedSupportStatus {
    const entry: MetadataUniverseEntry = {
      relativeMetadataPath: 'Catalogs/Products.xml',
      objectUuid: supportObjectId,
      supportSubjectUuid: supportObjectId,
    };
    return {
      status: 'available',
      configRoot,
      configurationId,
      generationId: 'tree-generation',
      master: {
        kind: 'ready',
        snapshot: {
          configurationId,
          generationId: 'tree-generation',
          semanticDigest: 'a'.repeat(64),
          filePath: path.join(configRoot, 'Ext', 'ParentConfigurations.bin'),
          formatRevision: '6',
          globalEditability: 'enabled',
          configurationMode,
          objectModes: new Map([[
            supportObjectId,
            {
              objectId: supportObjectId,
              locked: mode === 'notEditable',
              effectiveMode: mode,
              sources: [],
            },
          ]]),
          supplierConfigurations: [],
        },
      },
      metadataUniverse: {
        configRoot,
        metadataUniverseGenerationId: 'tree-universe',
        entries: [entry],
      },
      metadataUniverseIdentityIndex: createMetadataUniverseIdentityIndex([entry]),
    };
  }
});

function configurationNode(configRoot: string): TreeNode {
  return {
    id: 'Configuration',
    name: 'Configuration',
    type: MetadataType.Configuration,
    properties: {},
    filePath: path.join(configRoot, 'Configuration.xml'),
  };
}

function catalogNode(
  root: TreeNode,
  configRoot: string,
  objectId: string,
): TreeNode {
  return {
    id: 'Catalog.Products',
    name: 'Products',
    type: MetadataType.Catalog,
    parent: root,
    properties: { uuid: objectId },
    filePath: path.join(configRoot, 'Catalogs', 'Products.xml'),
  };
}
