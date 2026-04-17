import * as assert from 'assert';
import { ObjectTypeSerializer } from '../../src/serializers/objectTypeSerializer';
import type { ObjectTypeDefinition } from '../../src/types/objectTypeDefinitions';

suite('ObjectTypeSerializer', () => {
  test('empty definition serializes to self-closing Source tag', () => {
    const def: ObjectTypeDefinition = { types: [] };
    const result = ObjectTypeSerializer.serialize(def);
    assert.strictEqual(result, '<Source/>');
  });

  test('single type serializes correctly', () => {
    const def: ObjectTypeDefinition = {
      types: [{ objectKind: 'CatalogObject', objectName: 'Контрагенты' }],
    };
    const result = ObjectTypeSerializer.serialize(def);
    assert.strictEqual(result, '<Source>\n  <v8:Type>cfg:CatalogObject.Контрагенты</v8:Type>\n</Source>');
  });

  test('multiple types serialized in order', () => {
    const def: ObjectTypeDefinition = {
      types: [
        { objectKind: 'DocumentObject', objectName: 'АвансовыйОтчет' },
        { objectKind: 'CatalogObject', objectName: 'Контрагенты' },
      ],
    };
    const result = ObjectTypeSerializer.serialize(def);
    const expected =
      '<Source>\n' +
      '  <v8:Type>cfg:DocumentObject.АвансовыйОтчет</v8:Type>\n' +
      '  <v8:Type>cfg:CatalogObject.Контрагенты</v8:Type>\n' +
      '</Source>';
    assert.strictEqual(result, expected);
  });

  test('InformationRegisterRecordSet serializes with correct suffix', () => {
    const def: ObjectTypeDefinition = {
      types: [{ objectKind: 'InformationRegisterRecordSet', objectName: 'ЦеныНоменклатуры' }],
    };
    const result = ObjectTypeSerializer.serialize(def);
    assert.ok(result.includes('cfg:InformationRegisterRecordSet.ЦеныНоменклатуры'));
  });

  test('root tag is Source, not Type', () => {
    const def: ObjectTypeDefinition = {
      types: [{ objectKind: 'CatalogObject', objectName: 'X' }],
    };
    const result = ObjectTypeSerializer.serialize(def);
    assert.ok(result.startsWith('<Source>'));
    assert.ok(!result.startsWith('<Type>'));
  });

  test('order of types preserved as given', () => {
    const kinds = ['AccumulationRegisterRecordSet', 'CatalogObject', 'ExchangePlanObject'] as const;
    const def: ObjectTypeDefinition = {
      types: kinds.map((k) => ({ objectKind: k, objectName: 'Obj' })),
    };
    const result = ObjectTypeSerializer.serialize(def);
    const positions = kinds.map((k) => result.indexOf(`cfg:${k}.Obj`));
    assert.ok(positions[0] < positions[1], 'first kind should appear before second');
    assert.ok(positions[1] < positions[2], 'second kind should appear before third');
  });

  test('Manager kind with empty objectName serializes without dot', () => {
    const def: ObjectTypeDefinition = {
      types: [{ objectKind: 'CatalogManager', objectName: '' }],
    };
    const result = ObjectTypeSerializer.serialize(def);
    assert.ok(result.includes('<v8:Type>cfg:CatalogManager</v8:Type>'), 'no dot after Manager kind');
    assert.ok(!result.includes('cfg:CatalogManager.'), 'no spurious dot');
  });

  test('DocumentManager serializes as cfg:DocumentManager', () => {
    const def: ObjectTypeDefinition = {
      types: [{ objectKind: 'DocumentManager', objectName: '' }],
    };
    const result = ObjectTypeSerializer.serialize(def);
    assert.strictEqual(result, '<Source>\n  <v8:Type>cfg:DocumentManager</v8:Type>\n</Source>');
  });

  test('DefinedType with name serializes with dot', () => {
    const def: ObjectTypeDefinition = {
      types: [{ objectKind: 'DefinedType', objectName: 'СсылкаНаОбъектПодразделения' }],
    };
    const result = ObjectTypeSerializer.serialize(def);
    assert.ok(result.includes('<v8:Type>cfg:DefinedType.СсылкаНаОбъектПодразделения</v8:Type>'));
  });

  test('mixed: CatalogObject + DocumentManager + DefinedType', () => {
    const def: ObjectTypeDefinition = {
      types: [
        { objectKind: 'CatalogObject', objectName: 'Номенклатура' },
        { objectKind: 'DocumentManager', objectName: '' },
        { objectKind: 'DefinedType', objectName: 'СсылкаНаОбъектПодразделения' },
      ],
    };
    const result = ObjectTypeSerializer.serialize(def);
    assert.ok(result.includes('<v8:Type>cfg:CatalogObject.Номенклатура</v8:Type>'));
    assert.ok(result.includes('<v8:Type>cfg:DocumentManager</v8:Type>'));
    assert.ok(!result.includes('cfg:DocumentManager.'));
    assert.ok(result.includes('<v8:Type>cfg:DefinedType.СсылкаНаОбъектПодразделения</v8:Type>'));
  });
});
