import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  getFormatRank,
  normalizeFormatVersion,
  detectFormatVersionFromXml,
  buildCanonicalMetaDataObjectOpenTag,
  hasLineNumberLength,
  hasTypeReductionMode,
  hasPalNamespace,
  DEFAULT_FORMAT_VERSION,
  requireProjectWriteFormatProfile,
  requireWriteFormatProfile,
} from '../../src/utils/format/formatRank';
import {
  normalizeMetaDataObjectRoot,
  profileGeneratedMetadataXml,
} from '../../src/utils/xml/metaDataObjectRootNormalizer';
import { buildDesignerDimensionBlock } from '../../src/utils/xml/childObjectsMutator';
import { MetadataType } from '../../src/models/treeNode';

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

  test('detectFormatVersionFromXml extracts a root format version and never invents one', () => {
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
    assert.strictEqual(infoNoVer.version, '');
    assert.strictEqual(infoNoVer.rank, 0);
    assert.strictEqual(infoNoVer.isVerified, false);

    const emptyInfo = detectFormatVersionFromXml('');
    assert.strictEqual(emptyInfo.version, '');
    assert.strictEqual(emptyInfo.isVerified, false);

    const innerOnly = '<MetaDataObject><Configuration version="2.21"/></MetaDataObject>';
    assert.strictEqual(detectFormatVersionFromXml(innerOnly).version, '');
    assert.throws(() => requireProjectWriteFormatProfile(innerOnly), /формат XML/);
    for (const version of ['', '2.16', '2.22', 'bad', '2.x']) {
      assert.throws(() => requireWriteFormatProfile(version), /формат XML/);
      const info = detectFormatVersionFromXml(`<MetaDataObject version="${version}"/>`);
      assert.strictEqual(info.isVerified, false, `${version} must not become a verified default`);
      assert.notStrictEqual(info.version, DEFAULT_FORMAT_VERSION, `${version} must not become 2.17`);
    }
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
    assert.ok(tag221.includes('xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette"'));
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
    assert.ok(normalized221.includes('xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette"'));
    assert.ok(normalized221.includes('<Name>Test</Name>'));
  });

  test('profiles generated template properties without rewriting unrelated XML', () => {
    const generated = '<MetaDataObject><Properties><TypeReductionMode>TransformValues</TypeReductionMode><xr:TypeReductionMode>TransformValues</xr:TypeReductionMode><LineNumberLength>12</LineNumberLength><xr:LineNumberLength>12</xr:LineNumberLength><Name>Keep</Name></Properties></MetaDataObject>';
    const v217 = profileGeneratedMetadataXml(generated, '2.17');
    assert.ok(!v217.includes('TypeReductionMode'));
    assert.ok(!v217.includes('LineNumberLength'));
    assert.ok(v217.includes('<Name>Keep</Name>'));

    const v218 = profileGeneratedMetadataXml(generated, '2.18');
    assert.ok(v218.includes('TypeReductionMode'));
    assert.ok(!v218.includes('LineNumberLength'));
  });

  test('profiles all known TypeReductionMode spellings out of a 2.17 Catalog template', async () => {
    const templatePath = path.resolve(
      __dirname,
      '../../../resources/designerTemplates/Designer/Catalog.xml'
    );
    const template = await fs.promises.readFile(templatePath, 'utf8');
    const profiled = profileGeneratedMetadataXml(template, '2.17');
    assert.ok(!/<(?:xr:)?TypeReductionMode\b/.test(profiled));
    assert.ok(!/<(?:xr:)?LineNumberLength\b/.test(profiled));
  });

  test('nested InformationRegister Dimension emits TypeReductionMode only from 2.18', () => {
    const v217 = JSON.stringify(
      buildDesignerDimensionBlock('Dimension217', MetadataType.InformationRegister, true, 217)
    );
    const v218 = JSON.stringify(
      buildDesignerDimensionBlock('Dimension218', MetadataType.InformationRegister, true, 218)
    );
    assert.ok(!v217.includes('TypeReductionMode'));
    assert.ok(v218.includes('TypeReductionMode'));
  });
});
