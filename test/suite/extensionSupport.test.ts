import * as assert from 'assert';
import { XmlParser } from '../../src/parsers/xmlParser';
import { extractExtensionProperties, extractObjectBelonging } from '../../src/extensionSupport/extensionXmlParser';
import { findInterceptDecorators } from '../../src/extensionSupport/codeInterceptNavigator';

// ---------------------------------------------------------------------------
// Helper: parse XML string via XmlParser and return the MetaDataObject level.
// Production callers (e.g. metadataParser) pass the MetaDataObject sub-tree
// to extractExtensionProperties / extractObjectBelonging, not the full
// document root (which also contains the "?xml" declaration key).
// ---------------------------------------------------------------------------
function parseXmlInner(xmlString: string): Record<string, unknown> {
  const doc = XmlParser.parseString(xmlString);
  const mdo = doc['MetaDataObject'];
  if (typeof mdo !== 'object' || mdo === null) {
    throw new Error('MetaDataObject not found in parsed XML');
  }
  return mdo as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. extensionXmlParser — extractExtensionProperties
// ---------------------------------------------------------------------------

suite('extensionXmlParser — extractExtensionProperties', () => {
  test('returns extensionPurpose and namePrefix when both fields are present', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Configuration uuid="11111111-1111-1111-1111-111111111111">
    <Properties>
      <ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose>
      <NamePrefix>Расш1_</NamePrefix>
    </Properties>
  </Configuration>
</MetaDataObject>`;
    const parsed = parseXmlInner(xml);
    const result = extractExtensionProperties(parsed);
    assert.strictEqual(result.extensionPurpose, 'Customization');
    assert.strictEqual(result.namePrefix, 'Расш1_');
  });

  test('returns extensionPurpose=Patch when purpose is Patch', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Configuration uuid="22222222-2222-2222-2222-222222222222">
    <Properties>
      <ConfigurationExtensionPurpose>Patch</ConfigurationExtensionPurpose>
      <NamePrefix>Ptch_</NamePrefix>
    </Properties>
  </Configuration>
</MetaDataObject>`;
    const parsed = parseXmlInner(xml);
    const result = extractExtensionProperties(parsed);
    assert.strictEqual(result.extensionPurpose, 'Patch');
    assert.strictEqual(result.namePrefix, 'Ptch_');
  });

  test('returns extensionPurpose=AddOn when purpose is AddOn', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Configuration uuid="33333333-3333-3333-3333-333333333333">
    <Properties>
      <ConfigurationExtensionPurpose>AddOn</ConfigurationExtensionPurpose>
    </Properties>
  </Configuration>
</MetaDataObject>`;
    const parsed = parseXmlInner(xml);
    const result = extractExtensionProperties(parsed);
    assert.strictEqual(result.extensionPurpose, 'AddOn');
    assert.strictEqual(result.namePrefix, undefined);
  });

  test('returns empty object when ConfigurationExtensionPurpose and NamePrefix are absent', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Configuration uuid="44444444-4444-4444-4444-444444444444">
    <Properties>
      <Name>МояКонфигурация</Name>
    </Properties>
  </Configuration>
</MetaDataObject>`;
    const parsed = parseXmlInner(xml);
    const result = extractExtensionProperties(parsed);
    assert.strictEqual(result.extensionPurpose, undefined);
    assert.strictEqual(result.namePrefix, undefined);
    assert.deepStrictEqual(result, {});
  });

  test('returns empty object when Properties element is missing', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Configuration uuid="55555555-5555-5555-5555-555555555555">
  </Configuration>
</MetaDataObject>`;
    const parsed = parseXmlInner(xml);
    const result = extractExtensionProperties(parsed);
    assert.deepStrictEqual(result, {});
  });

  test('ignores unknown ConfigurationExtensionPurpose values', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Configuration uuid="66666666-6666-6666-6666-666666666666">
    <Properties>
      <ConfigurationExtensionPurpose>UnknownValue</ConfigurationExtensionPurpose>
      <NamePrefix>X_</NamePrefix>
    </Properties>
  </Configuration>
</MetaDataObject>`;
    const parsed = parseXmlInner(xml);
    const result = extractExtensionProperties(parsed);
    // Unknown purpose is not stored
    assert.strictEqual(result.extensionPurpose, undefined);
    // But NamePrefix is still stored
    assert.strictEqual(result.namePrefix, 'X_');
  });
});

// ---------------------------------------------------------------------------
// 2. extensionXmlParser — extractObjectBelonging
// ---------------------------------------------------------------------------

suite('extensionXmlParser — extractObjectBelonging', () => {
  test('returns objectBelonging=Adopted and extendedConfigurationObject when both are present', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Catalog uuid="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa">
    <Properties>
      <ObjectBelonging>Adopted</ObjectBelonging>
      <ExtendedConfigurationObject>7aadbb67-0000-0000-0000-000000000000</ExtendedConfigurationObject>
    </Properties>
  </Catalog>
</MetaDataObject>`;
    const parsed = parseXmlInner(xml);
    const result = extractObjectBelonging(parsed);
    assert.strictEqual(result.objectBelonging, 'Adopted');
    assert.strictEqual(result.extendedConfigurationObject, '7aadbb67-0000-0000-0000-000000000000');
  });

  test('returns empty object when ObjectBelonging and ExtendedConfigurationObject are absent', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Catalog uuid="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb">
    <Properties>
      <Name>Валюты</Name>
    </Properties>
  </Catalog>
</MetaDataObject>`;
    const parsed = parseXmlInner(xml);
    const result = extractObjectBelonging(parsed);
    assert.strictEqual(result.objectBelonging, undefined);
    assert.strictEqual(result.extendedConfigurationObject, undefined);
    assert.deepStrictEqual(result, {});
  });

  test('returns empty object when Properties element is missing', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Document uuid="cccccccc-cccc-cccc-cccc-cccccccccccc">
  </Document>
</MetaDataObject>`;
    const parsed = parseXmlInner(xml);
    const result = extractObjectBelonging(parsed);
    assert.deepStrictEqual(result, {});
  });

  test('does not set objectBelonging for non-Adopted value', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject>
  <Catalog uuid="dddddddd-dddd-dddd-dddd-dddddddddddd">
    <Properties>
      <ObjectBelonging>Own</ObjectBelonging>
      <ExtendedConfigurationObject>7aadbb67-0000-0000-0000-000000000001</ExtendedConfigurationObject>
    </Properties>
  </Catalog>
</MetaDataObject>`;
    const parsed = parseXmlInner(xml);
    const result = extractObjectBelonging(parsed);
    // Only 'Adopted' is accepted
    assert.strictEqual(result.objectBelonging, undefined);
    // ExtendedConfigurationObject is still captured
    assert.strictEqual(result.extendedConfigurationObject, '7aadbb67-0000-0000-0000-000000000001');
  });
});

// ---------------------------------------------------------------------------
// 3. codeInterceptNavigator — findInterceptDecorators
// ---------------------------------------------------------------------------

suite('codeInterceptNavigator — findInterceptDecorators', () => {
  test('finds &Перед decorator with correct targetProcedure and line number', () => {
    const bsl = '&Перед("Процедура1")\nПроцедура ПередПроцедура1()\nКонецПроцедуры';
    const entries = findInterceptDecorators(bsl);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].decorator, 'Перед');
    assert.strictEqual(entries[0].targetProcedure, 'Процедура1');
    assert.strictEqual(entries[0].line, 1);
  });

  test('finds &После decorator', () => {
    const bsl = '\n&После("Процедура2")\nПроцедура ПослеПроцедура2()\nКонецПроцедуры';
    const entries = findInterceptDecorators(bsl);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].decorator, 'После');
    assert.strictEqual(entries[0].targetProcedure, 'Процедура2');
    assert.strictEqual(entries[0].line, 2);
  });

  test('finds &Вместо decorator', () => {
    const bsl = '&Вместо("Процедура3")\nПроцедура ВместоПроцедура3()\nКонецПроцедуры';
    const entries = findInterceptDecorators(bsl);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].decorator, 'Вместо');
    assert.strictEqual(entries[0].targetProcedure, 'Процедура3');
    assert.strictEqual(entries[0].line, 1);
  });

  test('finds &ИзменениеИКонтроль decorator', () => {
    const bsl = '&ИзменениеИКонтроль("Процедура4")\nПроцедура ПроцедураИК()\nКонецПроцедуры';
    const entries = findInterceptDecorators(bsl);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].decorator, 'ИзменениеИКонтроль');
    assert.strictEqual(entries[0].targetProcedure, 'Процедура4');
    assert.strictEqual(entries[0].line, 1);
  });

  test('finds multiple decorators across different lines', () => {
    const bsl = [
      '// Комментарий',
      '&Перед("ОбъектМодуль.МетодА")',
      'Процедура ПередМетодА()',
      'КонецПроцедуры',
      '',
      '&После("МетодБ")',
      'Процедура ПослеМетодБ()',
      'КонецПроцедуры',
      '&Вместо("МетодВ")',
      'Процедура ВместоМетодВ()',
      'КонецПроцедуры',
    ].join('\n');

    const entries = findInterceptDecorators(bsl);
    assert.strictEqual(entries.length, 3);

    assert.strictEqual(entries[0].decorator, 'Перед');
    assert.strictEqual(entries[0].targetProcedure, 'ОбъектМодуль.МетодА');
    assert.strictEqual(entries[0].line, 2);

    assert.strictEqual(entries[1].decorator, 'После');
    assert.strictEqual(entries[1].targetProcedure, 'МетодБ');
    assert.strictEqual(entries[1].line, 6);

    assert.strictEqual(entries[2].decorator, 'Вместо');
    assert.strictEqual(entries[2].targetProcedure, 'МетодВ');
    assert.strictEqual(entries[2].line, 9);
  });

  test('returns empty array when no decorators are present', () => {
    const bsl = [
      'Процедура ОбычнаяПроцедура()',
      '  // Обычный код',
      'КонецПроцедуры',
    ].join('\n');
    const entries = findInterceptDecorators(bsl);
    assert.strictEqual(entries.length, 0);
  });

  test('returns empty array for empty string', () => {
    const entries = findInterceptDecorators('');
    assert.strictEqual(entries.length, 0);
  });

  test('finds two decorators on same-line content (one decorator per line assumed)', () => {
    // Each decorator is on its own line in practice, but regex should handle
    // multiple matches within one line if they occur
    const bsl = '&Перед("МетодА") &После("МетодБ")';
    const entries = findInterceptDecorators(bsl);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].decorator, 'Перед');
    assert.strictEqual(entries[1].decorator, 'После');
    assert.strictEqual(entries[0].line, 1);
    assert.strictEqual(entries[1].line, 1);
  });

  test('line numbers are 1-based', () => {
    const bsl = 'line1\nline2\n&Перед("МетодА")\nline4';
    const entries = findInterceptDecorators(bsl);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].line, 3);
  });
});
