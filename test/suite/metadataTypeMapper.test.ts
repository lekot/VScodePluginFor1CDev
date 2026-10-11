import * as assert from 'assert';
import { MetadataType } from '../../src/models/treeNode';
import { MetadataTypeMapper } from '../../src/utils/metadataTypeMapper';
import {
  getMetadataTypeDescriptorByFolder,
  METADATA_TYPE_DESCRIPTORS,
} from '../../src/constants/metadataTypeDescriptors';
import { TOP_LEVEL_TYPES, isRootObjectCreateInTypeFolder } from '../../src/services/elementOperations';
import { TOP_LEVEL_TYPES as XML_TOP_LEVEL_TYPES } from '../../src/utils/xml/xmlChildObjectsConstants';
import { TreeNode } from '../../src/models/treeNode';

suite('metadataTypeMapper', () => {
  test('maps known directory names to MetadataType enum', () => {
    assert.strictEqual(MetadataTypeMapper.map('Catalogs'), MetadataType.Catalog);
    assert.strictEqual(MetadataTypeMapper.map('Documents'), MetadataType.Document);
    assert.strictEqual(MetadataTypeMapper.map('Subsystems'), MetadataType.Subsystem);
    assert.strictEqual(MetadataTypeMapper.map('Sequences'), MetadataType.Sequence);
  });

  test('returns Unknown for unsupported type name', () => {
    assert.strictEqual(MetadataTypeMapper.map('DefinitelyUnknownType'), MetadataType.Unknown);
  });

  test('returns list of metadata type directory names', () => {
    const types = MetadataTypeMapper.getMetadataTypes();
    assert.ok(types.length > 0);
    assert.ok(types.includes('Catalogs'));
    assert.ok(types.includes('CommonPictures'));
  });

  test('validates type names via map table', () => {
    assert.strictEqual(MetadataTypeMapper.isValidType('Catalogs'), true);
    assert.strictEqual(MetadataTypeMapper.isValidType('Languages'), true);
    assert.strictEqual(MetadataTypeMapper.isValidType('NopeType'), false);
  });

  test('getDesignerFolderIdForMetadataType returns Designer folder id', () => {
    assert.strictEqual(MetadataTypeMapper.getDesignerFolderIdForMetadataType(MetadataType.Catalog), 'Catalogs');
    assert.strictEqual(MetadataTypeMapper.getDesignerFolderIdForMetadataType(MetadataType.Role), 'Roles');
    assert.strictEqual(MetadataTypeMapper.getDesignerFolderIdForMetadataType(MetadataType.Sequence), 'Sequences');
    assert.strictEqual(MetadataTypeMapper.getDesignerFolderIdForMetadataType(MetadataType.Unknown), undefined);
  });

  test('descriptor registry has unique cross-format identities and Sequence.mdo mapping', () => {
    assert.strictEqual(new Set(METADATA_TYPE_DESCRIPTORS.map((item) => item.type)).size, METADATA_TYPE_DESCRIPTORS.length);
    assert.strictEqual(new Set(METADATA_TYPE_DESCRIPTORS.map((item) => item.designerFolder)).size, METADATA_TYPE_DESCRIPTORS.length);

    const sequence = getMetadataTypeDescriptorByFolder('Sequences');
    assert.strictEqual(sequence?.designerRootTag, 'Sequence');
    assert.strictEqual(sequence?.edtFileName, 'Sequence.mdo');
    assert.ok(sequence?.moduleCapabilities.includes('debug-path'));
  });

  test('every root descriptor declares structure and CRUD separately, with both structural projections derived', () => {
    assert.strictEqual(TOP_LEVEL_TYPES, XML_TOP_LEVEL_TYPES);
    for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
      assert.strictEqual(descriptor.structure.designerRootObject, true, `${descriptor.type} should own a Designer root XML`);
      assert.deepStrictEqual(
        Object.keys(descriptor.crud).sort(),
        ['create', 'delete', 'duplicate', 'rename'],
        `${descriptor.type} must declare each CRUD capability`,
      );
      assert.strictEqual(TOP_LEVEL_TYPES.has(descriptor.type), true);
    }
  });

  test('Sequence is an explicit root CRUD type for UI and Agent plans', () => {
    const sequence = getMetadataTypeDescriptorByFolder('Sequences') as unknown as {
      structure?: { designerRootObject?: boolean };
      crud?: Record<string, { supported?: boolean; reason?: string }>;
    } | undefined;

    assert.strictEqual(sequence?.structure?.designerRootObject, true);
    assert.deepStrictEqual(sequence?.crud, {
      create: { supported: true },
      rename: { supported: true },
      duplicate: { supported: true },
      delete: { supported: true },
    });
    assert.strictEqual(TOP_LEVEL_TYPES.has(MetadataType.Sequence), true);

    const configurationNode: TreeNode = {
      id: 'Configuration',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
    };
    const sequencesNode: TreeNode = {
      id: 'Sequences',
      name: 'Sequences',
      type: MetadataType.Sequence,
      properties: {},
      parent: configurationNode,
    };
    assert.strictEqual(isRootObjectCreateInTypeFolder(sequencesNode), true);
  });
});
