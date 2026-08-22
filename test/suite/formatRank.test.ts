import * as assert from 'assert';
import {
  getFormatRank,
  normalizeFormatVersion,
  detectFormatVersionFromXml,
  buildCanonicalMetaDataObjectOpenTag,
  hasLineNumberLength,
  hasTypeReductionMode,
  hasPalNamespace,
  DEFAULT_FORMAT_VERSION,
  DEFAULT_FORMAT_RANK,
} from '../../src/utils/format/formatRank';
import { normalizeMetaDataObjectRoot } from '../../src/utils/xml/metaDataObjectRootNormalizer';

suite('FormatRank and Version Detection Tests', () => {
  test('getFormatRank calculates correct monotonic integer rank', () => {
    assert.strictEqual(getFormatRank('2.13'), 213);
    assert.strictEqual(getFormatRank('2.16'), 216);
    assert.strictEqual(getFormatRank('2.17'), 217);
    assert.strictEqual(getFormatRank('2.18'), 218);
    assert.strictEqual(getFormatRank('2.19'), 219);
    assert.strictEqual(getFormatRank('2.20'), 220);
    assert.strictEqual(getFormatRank('2.21'), 221);
    assert.strictEqual(getFormatRank(''), 0);
    assert.strictEqual(getFormatRank(undefined), 0);
    assert.strictEqual(getFormatRank(null), 0);
    assert.strictEqual(getFormatRank('2.20.1'), 220);
    assert.strictEqual(getFormatRank('2.17.5'), 217);
    assert.strictEqual(getFormatRank('invalid'), 0);
  });

  test('normalizeFormatVersion falls back to default on invalid input', () => {
    assert.strictEqual(normalizeFormatVersion('2.20'), '2.20');
    assert.strictEqual(normalizeFormatVersion('2.17'), '2.17');
    assert.strictEqual(normalizeFormatVersion(''), DEFAULT_FORMAT_VERSION);
    assert.strictEqual(normalizeFormatVersion(undefined), DEFAULT_FORMAT_VERSION);
    assert.strictEqual(normalizeFormatVersion('bad'), DEFAULT_FORMAT_VERSION);
  });

  test('detectFormatVersionFromXml extracts format version and rank', () => {
    const xml217 = '<?xml version="1.0"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.17"><Catalog/></MetaDataObject>';
    const info217 = detectFormatVersionFromXml(xml217);
    assert.strictEqual(info217.version, '2.17');
    assert.strictEqual(info217.rank, 217);
    assert.strictEqual(info217.isVerified, true);

    const xml221 = '<?xml version="1.0"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.21"><Catalog/></MetaDataObject>';
    const info221 = detectFormatVersionFromXml(xml221);
    assert.strictEqual(info221.version, '2.21');
    assert.strictEqual(info221.rank, 221);
    assert.strictEqual(info221.isVerified, true);

    const xmlNoVer = '<?xml version="1.0"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Catalog/></MetaDataObject>';
    const infoNoVer = detectFormatVersionFromXml(xmlNoVer);
    assert.strictEqual(infoNoVer.version, DEFAULT_FORMAT_VERSION);
    assert.strictEqual(infoNoVer.rank, DEFAULT_FORMAT_RANK);

    const emptyInfo = detectFormatVersionFromXml('');
    assert.strictEqual(emptyInfo.version, DEFAULT_FORMAT_VERSION);
  });

  test('buildCanonicalMetaDataObjectOpenTag generates canonical header for given version', () => {
    const tag217 = buildCanonicalMetaDataObjectOpenTag('2.17');
    assert.ok(tag217.startsWith('<MetaDataObject'));
    assert.ok(tag217.includes('version="2.17"'));
    assert.ok(!tag217.includes('xmlns:pal'));

    const tag220 = buildCanonicalMetaDataObjectOpenTag('2.20');
    assert.ok(tag220.includes('version="2.20"'));
    assert.ok(!tag220.includes('xmlns:pal'));

    const tag221 = buildCanonicalMetaDataObjectOpenTag('2.21');
    assert.ok(tag221.includes('version="2.21"'));
    assert.ok(tag221.includes('xmlns:pal="http://v8.1c.ru/8.5/data/ui/palette"'));
  });

  test('feature gate helpers correctly check format rank', () => {
    assert.strictEqual(hasLineNumberLength(217), false);
    assert.strictEqual(hasLineNumberLength(218), false);
    assert.strictEqual(hasLineNumberLength(220), true);
    assert.strictEqual(hasLineNumberLength(221), true);

    assert.strictEqual(hasTypeReductionMode(217), false);
    assert.strictEqual(hasTypeReductionMode(218), true);
    assert.strictEqual(hasTypeReductionMode(220), true);

    assert.strictEqual(hasPalNamespace(217), false);
    assert.strictEqual(hasPalNamespace(220), false);
    assert.strictEqual(hasPalNamespace(221), true);
  });

  test('normalizeMetaDataObjectRoot injects requested format version dynamically', () => {
    const rawXml = '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses"><Catalog uuid="123"><Properties><Name>Test</Name></Properties></Catalog></MetaDataObject>';

    const normalized217 = normalizeMetaDataObjectRoot(rawXml, '2.17');
    assert.ok(normalized217.includes('version="2.17"'));
    assert.ok(!normalized217.includes('xmlns:pal'));
    assert.ok(normalized217.includes('<Name>Test</Name>'));

    const normalized221 = normalizeMetaDataObjectRoot(rawXml, '2.21');
    assert.ok(normalized221.includes('version="2.21"'));
    assert.ok(normalized221.includes('xmlns:pal="http://v8.1c.ru/8.5/data/ui/palette"'));
    assert.ok(normalized221.includes('<Name>Test</Name>'));
  });
});
