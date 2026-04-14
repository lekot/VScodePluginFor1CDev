import * as assert from 'assert';
import { MetadataType } from '../../src/models/treeNode';
import { getDefaultPropertiesForNestedElement, getDefaultPropertiesForRootTag } from '../../src/constants/metadataDefaultValues';

suite('metadataDefaultValues', () => {
  test('returns defaults for known root tags and empty for unknown', () => {
    const catalog = getDefaultPropertiesForRootTag('Catalog');
    const doc = getDefaultPropertiesForRootTag('Document');
    const unknown = getDefaultPropertiesForRootTag('NopeTag');

    assert.deepStrictEqual(catalog, {
      Hierarchical: false,
      CodeLength: 9,
      DescriptionLength: 25,
      CodeType: 'String',
    });
    assert.deepStrictEqual(doc, {
      NumberType: 'String',
      NumberLength: 9,
    });
    assert.deepStrictEqual(unknown, {});
  });

  test('returns Form root defaults including FormType for ibcmd', () => {
    const form = getDefaultPropertiesForRootTag('Form');
    assert.deepStrictEqual(form, { FormType: 'Managed' });
  });

  test('returns cloned object for root defaults', () => {
    const a = getDefaultPropertiesForRootTag('Catalog');
    const b = getDefaultPropertiesForRootTag('Catalog');
    (a as Record<string, unknown>).CodeLength = 1;
    assert.strictEqual((b as Record<string, unknown>).CodeLength, 9);
  });

  test('returns attribute defaults and dataprocessor-specific omissions', () => {
    const normal = getDefaultPropertiesForNestedElement('Attribute');
    const dataProcessor = getDefaultPropertiesForNestedElement('Attribute', MetadataType.DataProcessor);

    assert.strictEqual((normal as Record<string, unknown>).PasswordMode, false);
    assert.strictEqual((normal as Record<string, unknown>).FillFromFillingValue, true);
    assert.strictEqual((dataProcessor as Record<string, unknown>).Indexing, undefined);
    assert.strictEqual((dataProcessor as Record<string, unknown>).FullTextSearch, undefined);
    assert.strictEqual((dataProcessor as Record<string, unknown>).DataHistory, undefined);
    assert.strictEqual((dataProcessor as Record<string, unknown>).FillValue, undefined);
    assert.strictEqual((dataProcessor as Record<string, unknown>).FillFromFillingValue, undefined);
  });

  test('returns tabular section defaults and clones nested defaults', () => {
    const ts = getDefaultPropertiesForNestedElement('TabularSection');
    assert.deepStrictEqual(ts, {});

    const a = getDefaultPropertiesForNestedElement('Attribute');
    const b = getDefaultPropertiesForNestedElement('Attribute');
    (a as Record<string, unknown>).Mask = 'X';
    assert.strictEqual((b as Record<string, unknown>).Mask, '');
  });
});
