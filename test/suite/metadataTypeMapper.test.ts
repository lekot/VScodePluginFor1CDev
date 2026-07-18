import * as assert from 'assert';
import { MetadataType } from '../../src/models/treeNode';
import { MetadataTypeMapper } from '../../src/utils/metadataTypeMapper';
import {
  getMetadataTypeDescriptorByFolder,
  METADATA_TYPE_DESCRIPTORS,
} from '../../src/constants/metadataTypeDescriptors';

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
});
