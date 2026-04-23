// test/suite/predefinedCharacteristicsParser.test.ts
// Unit tests for parsePredefinedCharacteristics

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parsePredefinedCharacteristics } from '../../src/parsers/predefinedCharacteristicsParser';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'predefinedCharacteristics');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

suite('parsePredefinedCharacteristics', () => {
  test('parses full.xml fixture: returns 3 entries', () => {
    const xml = readFixture('full.xml');
    const entries = parsePredefinedCharacteristics(xml);
    assert.strictEqual(entries.length, 3);
  });

  test('parses full.xml: first entry has correct name and type', () => {
    const xml = readFixture('full.xml');
    const entries = parsePredefinedCharacteristics(xml);
    const first = entries[0];
    assert.strictEqual(first.name, 'КатегорииЗакупок');
    assert.strictEqual(first.code, '000000010');
    assert.strictEqual(first.description, 'Категории закупок');
    assert.strictEqual(first.isFolder, false);
    assert.ok(first.type.length >= 1, 'type should have at least 1 entry');
    assert.ok(
      first.type[0].includes('CatalogRef.КатегорииЗакупок'),
      `type[0] should contain CatalogRef.КатегорииЗакупок, got: ${first.type[0]}`
    );
  });

  test('parses full.xml: normalizes d4p1: prefix to cfg:', () => {
    const xml = readFixture('full.xml');
    const entries = parsePredefinedCharacteristics(xml);
    for (const e of entries) {
      for (const t of e.type) {
        assert.ok(!t.startsWith('d4p1:'), `Type "${t}" should not have d4p1: prefix`);
        if (t.includes('CatalogRef')) {
          assert.ok(t.startsWith('cfg:'), `CatalogRef type "${t}" should start with cfg:`);
        }
      }
    }
  });

  test('parses full.xml: folder item has isFolder=true', () => {
    const xml = readFixture('full.xml');
    const entries = parsePredefinedCharacteristics(xml);
    const folder = entries.find((e) => e.name === 'ГруппаВидов');
    assert.ok(folder, 'ГруппаВидов should be found');
    assert.strictEqual(folder!.isFolder, true);
  });

  test('parses full.xml: all entries have non-empty id', () => {
    const xml = readFixture('full.xml');
    const entries = parsePredefinedCharacteristics(xml);
    for (const e of entries) {
      assert.ok(e.id.length > 0, `Entry "${e.name}" should have non-empty id`);
    }
  });

  test('parses empty.xml: returns empty array', () => {
    const xml = readFixture('empty.xml');
    const entries = parsePredefinedCharacteristics(xml);
    assert.strictEqual(entries.length, 0);
  });

  test('parses wrong-type.xml: returns empty array', () => {
    const xml = readFixture('wrong-type.xml');
    const entries = parsePredefinedCharacteristics(xml);
    assert.strictEqual(entries.length, 0);
  });

  test('handles completely empty string: returns empty array', () => {
    const entries = parsePredefinedCharacteristics('');
    assert.strictEqual(entries.length, 0);
  });

  test('handles malformed XML: returns empty array without throwing', () => {
    const entries = parsePredefinedCharacteristics('<broken xml><<<');
    assert.strictEqual(entries.length, 0);
  });

  test('parses real FormatSamples file: returns >=5 entries each with type', () => {
    const realPath = path.join(
      __dirname, '..', '..', 'FormatSamples', 'uh',
      'ChartsOfCharacteristicTypes', 'РеквизитыЗакупки', 'Ext', 'Predefined.xml'
    );
    if (!fs.existsSync(realPath)) {
      return; // skip if not present in CI
    }
    const xml = fs.readFileSync(realPath, 'utf-8');
    const entries = parsePredefinedCharacteristics(xml);
    assert.ok(entries.length >= 5, `Expected >=5 entries, got ${entries.length}`);
    for (const e of entries) {
      assert.ok(e.type.length >= 1, `Entry "${e.name}" should have at least 1 type`);
    }
  });
});
