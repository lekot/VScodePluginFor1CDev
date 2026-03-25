import * as assert from 'assert';
import {
  extractAttributes,
  extractChildSubsystems,
  extractSubsystemCompositionRefs,
  extractTabularSections,
  findChildObjects,
  flattenAttributeProperties,
  validateSubsystemCompositionRef,
} from '../../src/parsers/xmlChildObjects';

suite('xmlChildObjects', () => {
  test('findChildObjects returns null for non-object input', () => {
    assert.strictEqual(findChildObjects(null as unknown as Record<string, unknown>), null);
    assert.strictEqual(findChildObjects('text' as unknown as Record<string, unknown>), null);
  });

  test('findChildObjects finds nested ChildObjects recursively', () => {
    const xml = {
      Root: {
        One: {
          ChildObjects: { Attribute: { Name: 'A' } },
        },
      },
    } as Record<string, unknown>;

    assert.deepStrictEqual(findChildObjects(xml), { Attribute: { Name: 'A' } });
  });

  test('extractAttributes handles single, array and malformed structures', () => {
    assert.deepStrictEqual(extractAttributes({ Attribute: { Name: 'A' } }), [{ Name: 'A' }]);
    assert.deepStrictEqual(extractAttributes({ Attribute: [{ Name: 'A' }, { Name: 'B' }] }), [{ Name: 'A' }, { Name: 'B' }]);
    assert.deepStrictEqual(extractAttributes({}), []);
    assert.deepStrictEqual(extractAttributes(undefined), []);
  });

  test('extractTabularSections handles single, array and malformed structures', () => {
    assert.deepStrictEqual(extractTabularSections({ TabularSection: { Name: 'Rows' } }), [{ Name: 'Rows' }]);
    assert.deepStrictEqual(
      extractTabularSections({ TabularSection: [{ Name: 'Rows1' }, { Name: 'Rows2' }] }),
      [{ Name: 'Rows1' }, { Name: 'Rows2' }]
    );
    assert.deepStrictEqual(extractTabularSections({}), []);
    assert.deepStrictEqual(extractTabularSections(null), []);
  });

  test('extractChildSubsystems extracts string and #text values only', () => {
    const result = extractChildSubsystems({
      Subsystem: [
        'A',
        { '#text': 'B' },
        { '#text': 42 },
        null,
        7,
      ],
    });
    assert.deepStrictEqual(result, ['A', 'B']);
  });

  test('extractChildSubsystems returns empty for no Subsystem key', () => {
    assert.deepStrictEqual(extractChildSubsystems({ Other: 'x' }), []);
    assert.deepStrictEqual(extractChildSubsystems(undefined), []);
  });

  test('flattenAttributeProperties skips xml attrs and converts v8:item first content', () => {
    const result = flattenAttributeProperties({
      uuid: 'u-1',
      Properties: {
        '@_xmlns': 'x',
        '#comment': 'skip',
        PasswordMode: 'false',
        MarkNegatives: 'true',
        PlainString: 'value',
        NumberValue: 123,
        BoolValue: true,
        ComplexList: {
          'v8:item': [{ 'v8:content': 'String' }],
        },
        ComplexType: {
          'v8:Type': 'SomeType',
          other: 1,
        },
        OtherObject: {
          nested: 'ok',
        },
      },
    });

    assert.deepStrictEqual(result, {
      uuid: 'u-1',
      PasswordMode: false,
      MarkNegatives: true,
      PlainString: 'value',
      NumberValue: 123,
      BoolValue: true,
      ComplexList: 'String',
      ComplexType: { 'v8:Type': 'SomeType', other: 1 },
      OtherObject: { nested: 'ok' },
    });
  });

  test('flattenAttributeProperties handles malformed and missing Properties', () => {
    assert.deepStrictEqual(flattenAttributeProperties(undefined as unknown as Record<string, unknown>), {});
    assert.deepStrictEqual(flattenAttributeProperties({ Name: 'A' }), {});
    assert.deepStrictEqual(flattenAttributeProperties({ Properties: 'bad' as unknown as Record<string, unknown> }), {});
  });

  test('extractSubsystemCompositionRefs reads xr:Item list and bare Item', () => {
    assert.deepStrictEqual(extractSubsystemCompositionRefs(undefined), []);
    assert.deepStrictEqual(extractSubsystemCompositionRefs(''), []);
    assert.deepStrictEqual(extractSubsystemCompositionRefs('  Catalog.X  '), ['Catalog.X']);
    assert.deepStrictEqual(
      extractSubsystemCompositionRefs({
        'xr:Item': [{ '#text': 'Catalog.A' }, { '#text': 'Document.B' }],
      }),
      ['Catalog.A', 'Document.B']
    );
    assert.deepStrictEqual(
      extractSubsystemCompositionRefs({
        Item: 'CommonModule.C',
      }),
      ['CommonModule.C']
    );
  });

  test('validateSubsystemCompositionRef accepts Type.Name and rejects bad shapes', () => {
    assert.strictEqual(validateSubsystemCompositionRef('Catalog.Товары'), null);
    assert.strictEqual(validateSubsystemCompositionRef('  Catalog.X  '), null);
    assert.strictEqual(validateSubsystemCompositionRef(''), 'empty reference');
    assert.strictEqual(validateSubsystemCompositionRef('Catalog'), 'expected format MetadataType.ObjectName');
    assert.strictEqual(validateSubsystemCompositionRef('Catalog.'), 'expected format MetadataType.ObjectName');
    assert.strictEqual(
      validateSubsystemCompositionRef('Catalog.A.B'),
      'expected a single dot between metadata type and object name'
    );
    assert.strictEqual(validateSubsystemCompositionRef('Catalog .X'), 'reference must not contain whitespace');
    assert.strictEqual(validateSubsystemCompositionRef('.X'), 'expected format MetadataType.ObjectName');
  });
});
