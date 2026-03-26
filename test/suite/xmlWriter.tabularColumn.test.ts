import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { MetadataType } from '../../src/models/treeNode';
import { XMLWriter } from '../../src/utils/XMLWriter';
import { createTempDir, cleanupTempDir } from '../helpers/testHelpers';

function countColumnName(xml: string, columnName: string): number {
  const re = new RegExp(`<Name>${columnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</Name>`, 'g');
  return (xml.match(re) || []).length;
}

suite('XMLWriter tabular section columns', () => {
  let tmp: string;

  setup(async () => {
    tmp = await createTempDir('1c-tw-ts-');
  });

  teardown(async () => {
    await cleanupTempDir(tmp);
  });

  test('addAttributeToTabularSection inserts column in dedicated TS xml file', async () => {
    const src = path.join(
      __dirname,
      '../fixtures/designer-config/Catalogs/CatalogEmptyFolder/TabularSections/FolderEmpty/FolderEmpty.xml'
    );
    const dest = path.join(tmp, 'TS.xml');
    await fs.promises.copyFile(src, dest);
    await XMLWriter.addAttributeToTabularSection(dest, 'FolderEmpty', 'NewCol', MetadataType.Catalog, 'Cat');
    const xml = await fs.promises.readFile(dest, 'utf-8');
    assert.ok(xml.includes('<Name>NewCol</Name>'));
  });

  test('addAttributeToTabularSection inserts column in embedded Catalog ChildObjects', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogEmptyEmbedded.xml');
    const dest = path.join(tmp, 'Cat.xml');
    await fs.promises.copyFile(src, dest);
    await XMLWriter.addAttributeToTabularSection(
      dest,
      'EmbeddedEmpty',
      'ColA',
      MetadataType.Catalog,
      'CatalogEmptyEmbedded'
    );
    const xml = await fs.promises.readFile(dest, 'utf-8');
    assert.ok(xml.includes('<Name>ColA</Name>'));
  });

  test('removeAttributeFromTabularSection removes column from embedded tabular section', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogWithTabular.xml');
    const dest = path.join(tmp, 'WithCols.xml');
    await fs.promises.copyFile(src, dest);
    await XMLWriter.removeAttributeFromTabularSection(dest, 'Tabular1', 'Col1');
    const xml = await fs.promises.readFile(dest, 'utf-8');
    assert.ok(!xml.match(/<Name>Col1<\/Name>/));
    assert.ok(xml.includes('<Name>Col2</Name>'));
  });

  test('removeAttributeFromTabularSection throws when column is missing in embedded tabular section', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogWithTabular.xml');
    const dest = path.join(tmp, 'NoGhostCol.xml');
    await fs.promises.copyFile(src, dest);
    await assert.rejects(
      () => XMLWriter.removeAttributeFromTabularSection(dest, 'Tabular1', 'GhostCol'),
      /Колонка.*GhostCol.*не найдена/
    );
  });

  test('removeAttributeFromTabularSection does not touch another metadata XML with same ТЧ/column', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogTovaryNomenklatura.xml');
    const destA = path.join(tmp, 'NeighborA.xml');
    const destB = path.join(tmp, 'NeighborB.xml');
    await fs.promises.copyFile(src, destA);
    await fs.promises.copyFile(src, destB);
    const beforeB = await fs.promises.readFile(destB, 'utf-8');
    assert.strictEqual(countColumnName(beforeB, 'Номенклатура'), 1);

    await XMLWriter.removeAttributeFromTabularSection(destA, 'Товары', 'Номенклатура');

    const xmlA = await fs.promises.readFile(destA, 'utf-8');
    const xmlB = await fs.promises.readFile(destB, 'utf-8');
    assert.strictEqual(
      countColumnName(xmlA, 'Номенклатура'),
      0,
      'edited file: column removed from Товары'
    );
    assert.strictEqual(
      xmlB,
      beforeB,
      'sibling file on disk must be byte-identical (single-file scope)'
    );
  });

  test('removeAttributeFromTabularSection does not remove same-named column from another ТЧ in the same object', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogTovaryIZakazyNomenklatura.xml');
    const dest = path.join(tmp, 'TwoTsSameCol.xml');
    await fs.promises.copyFile(src, dest);
    const before = await fs.promises.readFile(dest, 'utf-8');
    assert.strictEqual(countColumnName(before, 'Номенклатура'), 2, 'Товары and Заказы each have Номенклатура');
    assert.ok(before.includes('<Name>Заказы</Name>') && before.includes('xs:decimal'), 'fixture: Заказы column is decimal');

    await XMLWriter.removeAttributeFromTabularSection(dest, 'Товары', 'Номенклатура');

    const xml = await fs.promises.readFile(dest, 'utf-8');
    assert.strictEqual(countColumnName(xml, 'Номенклатура'), 1, 'only Заказы keeps the column');
    assert.ok(xml.includes('<Name>Заказы</Name>'), 'Заказы section still present');
    assert.ok(
      xml.includes('xs:decimal'),
      'decimal type from Заказы Номенклатура must remain'
    );
    assert.ok(
      !xml.includes('c0000000-0000-0000-0000-000000000311'),
      'Товары attribute uuid removed'
    );
    assert.ok(
      xml.includes('c0000000-0000-0000-0000-000000000321'),
      'Заказы attribute uuid still present'
    );
  });

  test('duplicateAttributeInTabularSection clones Type and assigns new uuid', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogWithTabular.xml');
    const dest = path.join(tmp, 'DupCols.xml');
    await fs.promises.copyFile(src, dest);
    await XMLWriter.duplicateAttributeInTabularSection(dest, 'Tabular1', 'Col1', 'Col1Copy');
    const xml = await fs.promises.readFile(dest, 'utf-8');
    assert.ok(xml.includes('<Name>Col1</Name>'));
    assert.ok(xml.includes('<Name>Col1Copy</Name>'));
    assert.ok(xml.includes('<Name>Col2</Name>'));
    assert.strictEqual((xml.match(/xs:string/g) || []).length, 2, 'Col1 copy keeps string type; Col1 retained');
    assert.strictEqual((xml.match(/xs:decimal/g) || []).length, 1, 'Col2 decimal unchanged');
    const uuids = [...xml.matchAll(/<Attribute uuid="([^"]+)"/g)].map((m) => m[1]);
    assert.strictEqual(new Set(uuids).size, uuids.length, 'column Attribute uuids must be unique');
  });

  test('duplicateAttributeInTabularSection throws when target column name exists', async () => {
    const src = path.join(__dirname, '../fixtures/designer-config/Catalogs/CatalogWithTabular.xml');
    const dest = path.join(tmp, 'DupConflict.xml');
    await fs.promises.copyFile(src, dest);
    await assert.rejects(
      () => XMLWriter.duplicateAttributeInTabularSection(dest, 'Tabular1', 'Col1', 'Col2'),
      /уже существует/
    );
  });
});
