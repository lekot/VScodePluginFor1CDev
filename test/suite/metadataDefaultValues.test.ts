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

  test('omits extended props for ChartOfCharacteristicTypes Attribute', () => {
    const result = getDefaultPropertiesForNestedElement('Attribute', MetadataType.ChartOfCharacteristicTypes) as Record<string, unknown>;
    assert.strictEqual(result.Indexing, undefined);
    assert.strictEqual(result.FullTextSearch, undefined);
    assert.strictEqual(result.DataHistory, undefined);
    assert.strictEqual(result.FillFromFillingValue, undefined);
    assert.strictEqual(result.FillValue, undefined);
    assert.strictEqual(result.PasswordMode, false, 'common props preserved');
  });

  test('omits extended props for CommonAttribute Attribute', () => {
    const result = getDefaultPropertiesForNestedElement('Attribute', MetadataType.CommonAttribute) as Record<string, unknown>;
    assert.strictEqual(result.Indexing, undefined);
    assert.strictEqual(result.FillFromFillingValue, undefined);
  });

  test('omits extended props for Subsystem Attribute', () => {
    const result = getDefaultPropertiesForNestedElement('Attribute', MetadataType.Subsystem) as Record<string, unknown>;
    assert.strictEqual(result.Indexing, undefined);
    assert.strictEqual(result.FillFromFillingValue, undefined);
  });

  test('retains extended props for Catalog and Document Attribute', () => {
    const catalog = getDefaultPropertiesForNestedElement('Attribute', MetadataType.Catalog) as Record<string, unknown>;
    const doc = getDefaultPropertiesForNestedElement('Attribute', MetadataType.Document) as Record<string, unknown>;
    assert.strictEqual(catalog.Indexing, 'DontIndex');
    assert.strictEqual(catalog.FillFromFillingValue, true);
    assert.strictEqual(doc.FullTextSearch, 'Use');
  });

  test('omits only unsupported defaults for AccumulationRegister Attribute', () => {
    const accumulationRegister = getDefaultPropertiesForNestedElement(
      'Attribute',
      MetadataType.AccumulationRegister
    ) as Record<string, unknown>;
    const informationRegister = getDefaultPropertiesForNestedElement(
      'Attribute',
      MetadataType.InformationRegister
    ) as Record<string, unknown>;
    const catalog = getDefaultPropertiesForNestedElement('Attribute', MetadataType.Catalog) as Record<string, unknown>;
    const document = getDefaultPropertiesForNestedElement('Attribute', MetadataType.Document) as Record<string, unknown>;
    const tabularSection = getDefaultPropertiesForNestedElement('TabularSection', MetadataType.AccumulationRegister);

    for (const unsupported of ['DataHistory', 'FillValue', 'FillFromFillingValue']) {
      assert.strictEqual(accumulationRegister[unsupported], undefined, `${unsupported} is unsupported for AccumulationRegister.Attribute`);
      assert.notStrictEqual(informationRegister[unsupported], undefined, `${unsupported} remains unchanged for InformationRegister.Attribute`);
      assert.notStrictEqual(catalog[unsupported], undefined, `${unsupported} remains available for Catalog.Attribute`);
      assert.notStrictEqual(document[unsupported], undefined, `${unsupported} remains available for Document.Attribute`);
    }
    assert.strictEqual(accumulationRegister.Indexing, 'DontIndex');
    assert.strictEqual(accumulationRegister.FullTextSearch, 'Use');
    assert.strictEqual(accumulationRegister.PasswordMode, false, 'common attribute defaults are preserved');
    assert.deepStrictEqual(tabularSection, {}, 'TabularSection defaults remain empty');
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
