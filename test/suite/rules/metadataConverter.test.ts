import * as assert from 'assert';
import { MetadataConverter } from '../../../src/rules/MetadataConverter';
import { MetadataRulesRegistry } from '../../../src/rules/MetadataRulesRegistry';
import { PropertyConverterRegistry } from '../../../src/rules/converters/PropertyConverterRegistry';
import { stringConverter, booleanConverter } from '../../../src/rules/converters/primitiveConverters';
import { i8nTextConverter } from '../../../src/rules/converters/i8nTextConverter';
import { MetadataObjectRules, MetadataIR } from '../../../src/rules/types';

function makeRegistry(): PropertyConverterRegistry {
    const reg = new PropertyConverterRegistry();
    reg.register('string', stringConverter);
    reg.register('boolean', booleanConverter);
    reg.register('I8nText', i8nTextConverter);
    return reg;
}

const simpleRules: MetadataObjectRules = {
    rootTag: 'Catalog',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    properties: {
        name: { type: 'string', order: 1 },
        comment: { type: 'string', order: 2 },
        useStandardCommands: { type: 'boolean', order: 3 },
    },
};

const richRules: MetadataObjectRules = {
    rootTag: 'Catalog',
    namespaces: {
        'xmlns': 'http://v8.1c.ru/8.3/MDClasses',
        'xmlns:v8': 'http://v8.1c.ru/8.1/data/core',
    },
    properties: {
        name: { type: 'string', order: 1, xml: 'Name' },
        synonym: { type: 'I8nText', order: 2, xml: 'Synonym' },
        comment: { type: 'string', order: 3, xml: 'Comment' },
    },
};

suite('MetadataRulesRegistry', () => {
    test('register and get', () => {
        const registry = new MetadataRulesRegistry();
        registry.register(simpleRules);
        const got = registry.get('Catalog');
        assert.strictEqual(got, simpleRules);
    });

    test('get returns undefined for unknown', () => {
        const registry = new MetadataRulesRegistry();
        assert.strictEqual(registry.get('Document'), undefined);
    });

    test('allRootTags returns registered tags', () => {
        const registry = new MetadataRulesRegistry();
        registry.register(simpleRules);
        const tags = registry.allRootTags();
        assert.ok(tags.includes('Catalog'));
        assert.strictEqual(tags.length, 1);
    });
});

suite('MetadataConverter', () => {
    suite('createDefaultIR', () => {
        test('fills string and boolean defaults', () => {
            const converter = new MetadataConverter(makeRegistry());
            const ir = converter.createDefaultIR(simpleRules, { name: 'MyCatalog', uuid: 'test-uuid' });
            assert.strictEqual(ir.objectType, 'Catalog');
            assert.strictEqual(ir.name, 'MyCatalog');
            assert.strictEqual(ir.uuid, 'test-uuid');
            assert.strictEqual(ir.properties['name'], '');
            assert.strictEqual(ir.properties['comment'], '');
            assert.strictEqual(ir.properties['useStandardCommands'], false);
            assert.deepStrictEqual(ir.children, {});
        });

        test('skips forReferenceOnly properties', () => {
            const rulesWithRef: MetadataObjectRules = {
                rootTag: 'Catalog',
                namespaces: { 'xmlns': 'http://v8.1c.ru/8.3/MDClasses', 'xmlns:v8': 'http://v8.1c.ru/8.1/data/core' },
                properties: {
                    name: { type: 'string', order: 1 },
                    refOnly: { type: 'string', order: 2, forReferenceOnly: true },
                },
            };
            const converter = new MetadataConverter(makeRegistry());
            const ir = converter.createDefaultIR(rulesWithRef, { name: 'X', uuid: 'u1' });
            assert.ok(!('refOnly' in ir.properties));
        });

        test('uses defaultValueXML if provided', () => {
            const rulesWithDefault: MetadataObjectRules = {
                rootTag: 'Catalog',
                namespaces: { 'xmlns': 'http://v8.1c.ru/8.3/MDClasses', 'xmlns:v8': 'http://v8.1c.ru/8.1/data/core' },
                properties: {
                    name: { type: 'string', order: 1, defaultValueXML: 'DefaultName' },
                },
            };
            const converter = new MetadataConverter(makeRegistry());
            const ir = converter.createDefaultIR(rulesWithDefault, { name: 'X', uuid: 'u1' });
            assert.strictEqual(ir.properties['name'], 'DefaultName');
        });

        test('I8nText with xml:Synonym defaults to params.name', () => {
            const converter = new MetadataConverter(makeRegistry());
            const ir = converter.createDefaultIR(richRules, { name: 'X', uuid: 'u1' });
            // When a property has xml: 'Synonym', createDefaultIR uses params.name as default
            assert.strictEqual(ir.properties['synonym'], 'X');
        });
    });

    suite('mergeProperties', () => {
        test('overrides replace existing', () => {
            const converter = new MetadataConverter(makeRegistry());
            const ir = converter.createDefaultIR(simpleRules, { name: 'X', uuid: 'u1' });
            const merged = converter.mergeProperties(ir, { name: 'NewName', useStandardCommands: true });
            assert.strictEqual(merged.properties['name'], 'NewName');
            assert.strictEqual(merged.properties['useStandardCommands'], true);
            assert.strictEqual(merged.properties['comment'], '');
        });

        test('original IR is not mutated', () => {
            const converter = new MetadataConverter(makeRegistry());
            const ir = converter.createDefaultIR(simpleRules, { name: 'X', uuid: 'u1' });
            converter.mergeProperties(ir, { name: 'Changed' });
            assert.strictEqual(ir.properties['name'], '');
        });
    });

    suite('irToXml', () => {
        test('contains required XML structure', () => {
            const converter = new MetadataConverter(makeRegistry());
            const ir: MetadataIR = {
                objectType: 'Catalog',
                name: 'Goods',
                uuid: 'abc-123',
                properties: {
                    name: 'Goods',
                    synonym: 'Товары',
                    comment: '',
                },
                children: {},
            };
            const xml = converter.irToXml(ir, richRules);
            assert.ok(xml.includes('<?xml'), 'should have XML declaration');
            assert.ok(xml.includes('<MetaDataObject'), 'should have MetaDataObject');
            assert.ok(xml.includes('<Properties>'), 'should have Properties');
            assert.ok(xml.includes('<Name>'), 'should have Name');
            assert.ok(xml.includes('<Synonym>'), 'should have Synonym');
            assert.ok(xml.includes('abc-123'), 'should include uuid');
            assert.ok(xml.includes('http://v8.1c.ru/8.3/MDClasses'), 'should include main namespace');
        });

        test('properties sorted by order', () => {
            const converter = new MetadataConverter(makeRegistry());
            const ir: MetadataIR = {
                objectType: 'Catalog',
                name: 'X',
                uuid: 'u1',
                properties: { name: 'X', synonym: 'Синоним', comment: 'c' },
                children: {},
            };
            const xml = converter.irToXml(ir, richRules);
            const nameIdx = xml.indexOf('<Name>');
            const synonymIdx = xml.indexOf('<Synonym>');
            const commentIdx = xml.indexOf('<Comment>');
            assert.ok(nameIdx < synonymIdx, 'Name should come before Synonym');
            assert.ok(synonymIdx < commentIdx, 'Synonym should come before Comment');
        });
    });

    suite('xmlToIr', () => {
        test('parses xml to IR', () => {
            const converter = new MetadataConverter(makeRegistry());
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Catalog uuid="abc-123">
    <Properties>
      <Name>Goods</Name>
      <Synonym>
        <v8:item>
          <v8:lang>ru</v8:lang>
          <v8:content>Товары</v8:content>
        </v8:item>
      </Synonym>
      <Comment>Some comment</Comment>
    </Properties>
    <ChildObjects/>
  </Catalog>
</MetaDataObject>`;
            const ir = converter.xmlToIr(xml, richRules);
            assert.strictEqual(ir.objectType, 'Catalog');
            assert.strictEqual(ir.uuid, 'abc-123');
            assert.strictEqual(ir.properties['name'], 'Goods');
            assert.strictEqual(ir.properties['synonym'], 'Товары');
            assert.strictEqual(ir.properties['comment'], 'Some comment');
        });

        test('round-trip irToXml → xmlToIr', () => {
            const converter = new MetadataConverter(makeRegistry());
            const originalIr: MetadataIR = {
                objectType: 'Catalog',
                name: 'Products',
                uuid: 'round-trip-uuid',
                properties: {
                    name: 'Products',
                    synonym: 'Продукты',
                    comment: 'Test comment',
                },
                children: {},
            };
            const xml = converter.irToXml(originalIr, richRules);
            const parsedIr = converter.xmlToIr(xml, richRules);
            assert.strictEqual(parsedIr.uuid, originalIr.uuid);
            assert.strictEqual(parsedIr.properties['name'], originalIr.properties['name']);
            assert.strictEqual(parsedIr.properties['synonym'], originalIr.properties['synonym']);
            assert.strictEqual(parsedIr.properties['comment'], originalIr.properties['comment']);
        });

        test('_unknown round-trip: unknown tags preserved through xmlToIr → irToXml', () => {
            const converter = new MetadataConverter(makeRegistry());
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core">
  <Catalog uuid="unknown-uuid">
    <Properties>
      <Name>TestObj</Name>
      <Synonym/>
      <Comment/>
      <CustomTag>CustomValue</CustomTag>
    </Properties>
  </Catalog>
</MetaDataObject>`;
            const ir = converter.xmlToIr(xml, richRules);
            assert.ok(ir._unknown, 'IR should have _unknown field');
            assert.strictEqual((ir._unknown as Record<string, unknown>)['CustomTag'], 'CustomValue', '_unknown should contain CustomTag');

            const rebuilt = converter.irToXml(ir, richRules);
            assert.ok(rebuilt.includes('<CustomTag>CustomValue</CustomTag>'), 'rebuilt XML should contain CustomTag');
        });
    });

    suite('YAML', () => {
        const yamlRules: MetadataObjectRules = {
            rootTag: 'Catalog',
            namespaces: { 'xmlns': 'http://v8.1c.ru/8.3/MDClasses', 'xmlns:v8': 'http://v8.1c.ru/8.1/data/core' },
            properties: {
                name: { type: 'string', order: 1, xml: 'Name', yaml: 'Имя' },
                comment: { type: 'string', order: 2, xml: 'Comment', yaml: 'Комментарий', defaultValueXML: '' },
                synonym: { type: 'I8nText', order: 3, xml: 'Synonym', yaml: 'Синоним' },
            },
        };

        test('irToYaml produces valid YAML with meta fields', () => {
            const converter = new MetadataConverter(makeRegistry());
            const ir: MetadataIR = {
                objectType: 'Catalog',
                name: 'МойСправочник',
                uuid: 'u1',
                properties: { name: 'МойСправочник', comment: '', synonym: 'Мой справочник' },
                children: {},
            };
            const result = converter.irToYaml(ir, yamlRules);
            assert.ok(result.includes('Тип:'), 'should have Тип field');
            assert.ok(result.includes('Имя:'), 'should have Имя field');
            assert.ok(result.includes('МойСправочник'), 'should contain object name');
            assert.ok(result.includes('Синоним:'), 'should have Синоним');
            assert.ok(!result.includes('Комментарий:'), 'empty comment should be omitted (default)');
        });

        test('irToYaml omits properties without yaml key', () => {
            const rulesNoYaml: MetadataObjectRules = {
                rootTag: 'Catalog',
                namespaces: {},
                properties: {
                    name: { type: 'string', order: 1, xml: 'Name', yaml: 'Имя' },
                    internalData: { type: 'string', order: 2, xml: 'InternalData' },
                },
            };
            const converter = new MetadataConverter(makeRegistry());
            const ir: MetadataIR = {
                objectType: 'Catalog', name: 'X', uuid: 'u1',
                properties: { name: 'X', internalData: 'secret' }, children: {},
            };
            const result = converter.irToYaml(ir, rulesNoYaml);
            assert.ok(!result.includes('secret'), 'property without yaml key should not appear');
        });

        test('yamlToIr parses name and properties', () => {
            const converter = new MetadataConverter(makeRegistry());
            const yamlContent = 'Тип: Catalog\nИмя: ТестовыйСправочник\nСиноним: Тестовый справочник\n';
            const ir = converter.yamlToIr(yamlContent, yamlRules);
            assert.strictEqual(ir.name, 'ТестовыйСправочник');
            assert.strictEqual(ir.objectType, 'Catalog');
            assert.strictEqual(ir.properties['synonym'], 'Тестовый справочник');
        });

        test('yamlToIr uses default for missing properties', () => {
            const converter = new MetadataConverter(makeRegistry());
            const yamlContent = 'Тип: Catalog\nИмя: X\n';
            const ir = converter.yamlToIr(yamlContent, yamlRules);
            assert.strictEqual(ir.properties['comment'], '');
        });
    });
});
