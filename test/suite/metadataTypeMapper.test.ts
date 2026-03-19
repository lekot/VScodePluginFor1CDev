import * as assert from 'assert';
import { MetadataType } from '../../src/models/treeNode';
import { MetadataTypeMapper } from '../../src/utils/metadataTypeMapper';

suite('metadataTypeMapper', () => {
  test('maps known directory names to MetadataType enum', () => {
    assert.strictEqual(MetadataTypeMapper.map('Catalogs'), MetadataType.Catalog);
    assert.strictEqual(MetadataTypeMapper.map('Documents'), MetadataType.Document);
    assert.strictEqual(MetadataTypeMapper.map('Subsystems'), MetadataType.Subsystem);
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
});
