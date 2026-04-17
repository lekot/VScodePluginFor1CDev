import * as assert from 'assert';
import { ObjectTypeParser } from '../../src/parsers/objectTypeParser';
import { ObjectTypeSerializer } from '../../src/serializers/objectTypeSerializer';
import type { ObjectTypeDefinition } from '../../src/types/objectTypeDefinitions';

suite('ObjectTypeParser', () => {
  suite('parse', () => {
    test('empty string returns empty types', () => {
      const result = ObjectTypeParser.parse('');
      assert.deepStrictEqual(result, { types: [] });
    });

    test('empty Source element returns empty types', () => {
      const result = ObjectTypeParser.parse('<Source/>');
      assert.deepStrictEqual(result, { types: [] });
    });

    test('single CatalogObject type', () => {
      const xml = `<Source>
  <v8:Type>cfg:CatalogObject.Контрагенты</v8:Type>
</Source>`;
      const result = ObjectTypeParser.parse(xml);
      assert.strictEqual(result.types.length, 1);
      assert.strictEqual(result.types[0].objectKind, 'CatalogObject');
      assert.strictEqual(result.types[0].objectName, 'Контрагенты');
    });

    test('multiple types preserved in order', () => {
      const xml = `<Source>
  <v8:Type>cfg:DocumentObject.АвансовыйОтчет</v8:Type>
  <v8:Type>cfg:CatalogObject.Контрагенты</v8:Type>
  <v8:Type>cfg:InformationRegisterRecordSet.ЦеныНоменклатуры</v8:Type>
</Source>`;
      const result = ObjectTypeParser.parse(xml);
      assert.strictEqual(result.types.length, 3);
      assert.strictEqual(result.types[0].objectKind, 'DocumentObject');
      assert.strictEqual(result.types[0].objectName, 'АвансовыйОтчет');
      assert.strictEqual(result.types[1].objectKind, 'CatalogObject');
      assert.strictEqual(result.types[1].objectName, 'Контрагенты');
      assert.strictEqual(result.types[2].objectKind, 'InformationRegisterRecordSet');
      assert.strictEqual(result.types[2].objectName, 'ЦеныНоменклатуры');
    });

    test('invalid kind is skipped (no throw)', () => {
      const xml = `<Source>
  <v8:Type>cfg:CatalogRef.Контрагенты</v8:Type>
  <v8:Type>cfg:CatalogObject.Номенклатура</v8:Type>
</Source>`;
      const result = ObjectTypeParser.parse(xml);
      assert.strictEqual(result.types.length, 1);
      assert.strictEqual(result.types[0].objectKind, 'CatalogObject');
      assert.strictEqual(result.types[0].objectName, 'Номенклатура');
    });

    test('xs:string type is skipped (no throw)', () => {
      const xml = `<Source>
  <v8:Type>xs:string</v8:Type>
  <v8:Type>cfg:DocumentObject.ЗаказПокупателя</v8:Type>
</Source>`;
      const result = ObjectTypeParser.parse(xml);
      assert.strictEqual(result.types.length, 1);
      assert.strictEqual(result.types[0].objectKind, 'DocumentObject');
    });

    test('all 12 valid object kinds are accepted', () => {
      const kinds = [
        'CatalogObject', 'DocumentObject', 'BusinessProcessObject', 'TaskObject',
        'ChartOfCharacteristicTypesObject', 'ChartOfAccountsObject', 'ChartOfCalculationTypesObject',
        'ExchangePlanObject', 'InformationRegisterRecordSet', 'AccumulationRegisterRecordSet',
        'AccountingRegisterRecordSet', 'CalculationRegisterRecordSet',
      ];
      const xml = `<Source>\n${kinds.map((k) => `  <v8:Type>cfg:${k}.TestObj</v8:Type>`).join('\n')}\n</Source>`;
      const result = ObjectTypeParser.parse(xml);
      assert.strictEqual(result.types.length, 12);
      for (let i = 0; i < kinds.length; i++) {
        assert.strictEqual(result.types[i].objectKind, kinds[i]);
        assert.strictEqual(result.types[i].objectName, 'TestObj');
      }
    });
  });

  suite('parseFromObject', () => {
    test('parses object with Source wrapper', () => {
      const obj = { Source: { 'v8:Type': 'cfg:CatalogObject.Клиенты' } };
      const result = ObjectTypeParser.parseFromObject(obj);
      assert.strictEqual(result.types.length, 1);
      assert.strictEqual(result.types[0].objectKind, 'CatalogObject');
      assert.strictEqual(result.types[0].objectName, 'Клиенты');
    });

    test('parses object without Source wrapper (direct v8:Type)', () => {
      const obj = { 'v8:Type': 'cfg:DocumentObject.Реализация' };
      const result = ObjectTypeParser.parseFromObject(obj);
      assert.strictEqual(result.types.length, 1);
      assert.strictEqual(result.types[0].objectKind, 'DocumentObject');
      assert.strictEqual(result.types[0].objectName, 'Реализация');
    });

    test('returns empty for empty object', () => {
      const result = ObjectTypeParser.parseFromObject({});
      assert.deepStrictEqual(result, { types: [] });
    });
  });

  suite('round-trip', () => {
    test('parse → serialize → parse produces equivalent definition', () => {
      const xml = `<Source>
  <v8:Type>cfg:CatalogObject.Контрагенты</v8:Type>
  <v8:Type>cfg:DocumentObject.АвансовыйОтчет</v8:Type>
  <v8:Type>cfg:InformationRegisterRecordSet.ЦеныНоменклатуры</v8:Type>
</Source>`;
      const first = ObjectTypeParser.parse(xml);
      const serialized = ObjectTypeSerializer.serialize(first);
      const second = ObjectTypeParser.parse(serialized);
      assert.deepStrictEqual(second, first);
    });

    test('round-trip preserves empty definition', () => {
      const def: ObjectTypeDefinition = { types: [] };
      const serialized = ObjectTypeSerializer.serialize(def);
      const reparsed = ObjectTypeParser.parse(serialized);
      assert.deepStrictEqual(reparsed, def);
    });
  });
});
