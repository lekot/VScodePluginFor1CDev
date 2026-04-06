// test/suite/rules/xmlSnapshot.test.ts
// Snapshot-тесты для CommonModule и Subsystem rules.
import * as assert from 'assert';
import { MetadataConverter } from '../../../src/rules/MetadataConverter';
import { createDefaultConverterRegistry } from '../../../src/rules/converters/index';
import { commonModuleRules } from '../../../src/rules/metadata/commonModuleRules';
import { subsystemRules } from '../../../src/rules/metadata/subsystemRules';

function makeConverter(): MetadataConverter {
    return new MetadataConverter(createDefaultConverterRegistry());
}

suite('XML Snapshot: CommonModule', () => {
    test('createDefaultIR sets name and synonym from params', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(commonModuleRules, { name: 'ТестМодуль', uuid: 'test-uuid-1234' });
        assert.strictEqual(ir.properties['name'], 'ТестМодуль');
        assert.strictEqual(ir.properties['synonym'], 'ТестМодуль');
        assert.strictEqual(ir.properties['global'], false);
        assert.strictEqual(ir.properties['server'], false);
        assert.strictEqual(ir.properties['clientManagedApplication'], true);
        assert.strictEqual(ir.properties['returnValuesReuse'], 'DontUse');
    });

    test('irToXml generates correct root tag and namespaces', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(commonModuleRules, { name: 'ТестМодуль', uuid: 'test-uuid-1234' });
        const xml = converter.irToXml(ir, commonModuleRules);
        assert.ok(xml.includes('<CommonModule'), 'should have <CommonModule root tag');
        assert.ok(xml.includes('xmlns="http://v8.1c.ru/8.3/MDClasses"'), 'should have main namespace');
        assert.ok(xml.includes('xmlns:v8="http://v8.1c.ru/8.1/data/core"'), 'should have v8 namespace');
        assert.ok(!xml.includes('xmlns:xr='), 'CommonModule should NOT have xr namespace');
        assert.ok(!xml.includes('xmlns:xsi='), 'CommonModule should NOT have xsi namespace');
    });

    test('irToXml contains name and synonym', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(commonModuleRules, { name: 'ТестМодуль', uuid: 'test-uuid-1234' });
        const xml = converter.irToXml(ir, commonModuleRules);
        assert.ok(xml.includes('<Name>ТестМодуль</Name>'), 'should have Name tag with value');
        assert.ok(xml.includes('<Synonym>'), 'should have Synonym tag');
        assert.ok(xml.includes('<v8:content>ТестМодуль</v8:content>'), 'should have v8:content with synonym value');
    });

    test('irToXml does NOT generate ChildObjects', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(commonModuleRules, { name: 'ТестМодуль', uuid: 'test-uuid-1234' });
        const xml = converter.irToXml(ir, commonModuleRules);
        assert.ok(!xml.includes('ChildObjects'), 'CommonModule should NOT have ChildObjects');
    });

    test('irToXml properties in correct alphabetical order', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(commonModuleRules, { name: 'Mod', uuid: 'u1' });
        const xml = converter.irToXml(ir, commonModuleRules);
        const commentIdx = xml.indexOf('<Comment');
        const globalIdx = xml.indexOf('<Global>');
        const nameIdx = xml.indexOf('<Name>');
        // Comment < Global < Name (alphabetical order as in template)
        assert.ok(commentIdx < globalIdx, 'Comment should come before Global');
        assert.ok(globalIdx < nameIdx, 'Global should come before Name');
    });

    test('irToXml includes uuid', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(commonModuleRules, { name: 'X', uuid: 'test-uuid-1234' });
        const xml = converter.irToXml(ir, commonModuleRules);
        assert.ok(xml.includes('test-uuid-1234'), 'should include uuid');
    });
});

suite('XML Snapshot: Subsystem', () => {
    test('createDefaultIR sets name and synonym from params', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(subsystemRules, { name: 'ТестПодсистема', uuid: 'sub-uuid-5678' });
        assert.strictEqual(ir.properties['name'], 'ТестПодсистема');
        assert.strictEqual(ir.properties['synonym'], 'ТестПодсистема');
        assert.strictEqual(ir.properties['includeInCommandInterface'], true);
        assert.strictEqual(ir.properties['includeHelpInContents'], false);
        assert.strictEqual(ir.properties['useOneCommand'], false);
    });

    test('irToXml generates correct root tag and namespaces', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(subsystemRules, { name: 'ТестПодсистема', uuid: 'sub-uuid-5678' });
        const xml = converter.irToXml(ir, subsystemRules);
        assert.ok(xml.includes('<Subsystem'), 'should have <Subsystem root tag');
        assert.ok(xml.includes('xmlns="http://v8.1c.ru/8.3/MDClasses"'), 'should have main namespace');
        assert.ok(xml.includes('xmlns:v8="http://v8.1c.ru/8.1/data/core"'), 'should have v8 namespace');
        assert.ok(xml.includes('xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"'), 'should have xr namespace');
        assert.ok(xml.includes('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'), 'should have xsi namespace');
    });

    test('irToXml generates ChildObjects', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(subsystemRules, { name: 'ТестПодсистема', uuid: 'sub-uuid-5678' });
        const xml = converter.irToXml(ir, subsystemRules);
        assert.ok(xml.includes('ChildObjects'), 'Subsystem should have ChildObjects');
    });

    test('irToXml contains name and synonym', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(subsystemRules, { name: 'ТестПодсистема', uuid: 'sub-uuid-5678' });
        const xml = converter.irToXml(ir, subsystemRules);
        assert.ok(xml.includes('<Name>ТестПодсистема</Name>'), 'should have Name tag with value');
        assert.ok(xml.includes('<Synonym>'), 'should have Synonym tag');
        assert.ok(xml.includes('<v8:content>ТестПодсистема</v8:content>'), 'should have v8:content with synonym value');
    });

    test('irToXml properties in correct order', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(subsystemRules, { name: 'Sub', uuid: 'u2' });
        const xml = converter.irToXml(ir, subsystemRules);
        const commentIdx = xml.indexOf('<Comment');
        const nameIdx = xml.indexOf('<Name>');
        const synonymIdx = xml.indexOf('<Synonym>');
        // Comment < Name < Synonym
        assert.ok(commentIdx < nameIdx, 'Comment should come before Name');
        assert.ok(nameIdx < synonymIdx, 'Name should come before Synonym');
    });
});
