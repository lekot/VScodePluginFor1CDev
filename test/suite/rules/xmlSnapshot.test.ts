// test/suite/rules/xmlSnapshot.test.ts
// Snapshot-тесты для CommonModule, Subsystem, Enum, Catalog и Document rules.
import * as assert from 'assert';
import { MetadataConverter } from '../../../src/rules/MetadataConverter';
import { createDefaultConverterRegistry } from '../../../src/rules/converters/index';
import { catalogRules } from '../../../src/rules/metadata/catalogRules';
import { commonModuleRules } from '../../../src/rules/metadata/commonModuleRules';
import { documentRules } from '../../../src/rules/metadata/documentRules';
import { enumRules } from '../../../src/rules/metadata/enumRules';
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

suite('XML Snapshot: Enum', () => {
    test('createDefaultIR sets name and synonym from params', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(enumRules, { name: 'ТестПеречисление', uuid: 'enum-uuid-9999' });
        assert.strictEqual(ir.properties['name'], 'ТестПеречисление');
        assert.strictEqual(ir.properties['synonym'], 'ТестПеречисление');
        assert.strictEqual(ir.properties['choiceHistoryOnInput'], 'Auto');
        assert.strictEqual(ir.properties['choiceMode'], 'BothWays');
        assert.strictEqual(ir.properties['quickChoice'], true);
        assert.strictEqual(ir.properties['useStandardCommands'], false);
    });

    test('irToXml generates correct root tag with uuid', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(enumRules, { name: 'ТестПеречисление', uuid: 'enum-uuid-9999' });
        const xml = converter.irToXml(ir, enumRules);
        assert.ok(xml.includes('<Enum uuid='), 'should have <Enum uuid= root tag');
        assert.ok(xml.includes('enum-uuid-9999'), 'should include uuid');
    });

    test('irToXml has correct namespaces including xr and xsi', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(enumRules, { name: 'ТестПеречисление', uuid: 'enum-uuid-9999' });
        const xml = converter.irToXml(ir, enumRules);
        assert.ok(xml.includes('xmlns="http://v8.1c.ru/8.3/MDClasses"'), 'should have main namespace');
        assert.ok(xml.includes('xmlns:v8="http://v8.1c.ru/8.1/data/core"'), 'should have v8 namespace');
        assert.ok(xml.includes('xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"'), 'should have xr namespace');
        assert.ok(xml.includes('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'), 'should have xsi namespace');
    });

    test('irToXml contains ChoiceHistoryOnInput and QuickChoice with correct values', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(enumRules, { name: 'ТестПеречисление', uuid: 'enum-uuid-9999' });
        const xml = converter.irToXml(ir, enumRules);
        assert.ok(xml.includes('<ChoiceHistoryOnInput>Auto</ChoiceHistoryOnInput>'), 'should have ChoiceHistoryOnInput=Auto');
        assert.ok(xml.includes('<QuickChoice>true</QuickChoice>'), 'should have QuickChoice=true');
    });

    test('irToXml generates ChildObjects', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(enumRules, { name: 'ТестПеречисление', uuid: 'enum-uuid-9999' });
        const xml = converter.irToXml(ir, enumRules);
        assert.ok(xml.includes('ChildObjects'), 'Enum should have ChildObjects');
    });

    test('irToXml contains name and synonym', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(enumRules, { name: 'ТестПеречисление', uuid: 'enum-uuid-9999' });
        const xml = converter.irToXml(ir, enumRules);
        assert.ok(xml.includes('<Name>ТестПеречисление</Name>'), 'should have Name tag with value');
        assert.ok(xml.includes('<Synonym>'), 'should have Synonym tag');
        assert.ok(xml.includes('<v8:content>ТестПеречисление</v8:content>'), 'should have v8:content with synonym value');
    });

    test('irToXml properties in correct order: ChoiceMode before Comment before Name', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(enumRules, { name: 'Enum', uuid: 'u3' });
        const xml = converter.irToXml(ir, enumRules);
        const choiceModeIdx = xml.indexOf('<ChoiceMode>');
        const commentIdx = xml.indexOf('<Comment');
        const nameIdx = xml.indexOf('<Name>');
        assert.ok(choiceModeIdx < commentIdx, 'ChoiceMode should come before Comment');
        assert.ok(commentIdx < nameIdx, 'Comment should come before Name');
    });
});

suite('XML Snapshot: Catalog', () => {
    test('createDefaultIR sets name and synonym from params', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(catalogRules, { name: 'ТестСправочник', uuid: 'cat-uuid-1111' });
        assert.strictEqual(ir.properties['name'], 'ТестСправочник');
        assert.strictEqual(ir.properties['synonym'], 'ТестСправочник');
        assert.strictEqual(ir.properties['autonumbering'], false);
        assert.strictEqual(ir.properties['codeLength'], 0);
        assert.strictEqual(ir.properties['descriptionLength'], 100);
        assert.strictEqual(ir.properties['choiceMode'], 'BothWays');
        assert.strictEqual(ir.properties['foldersOnTop'], true);
        assert.strictEqual(ir.properties['quickChoice'], true);
        assert.strictEqual(ir.properties['useStandardCommands'], false);
    });

    test('irToXml generates correct root tag with uuid', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(catalogRules, { name: 'ТестСправочник', uuid: 'cat-uuid-1111' });
        const xml = converter.irToXml(ir, catalogRules);
        assert.ok(xml.includes('<Catalog uuid='), 'should have <Catalog uuid= root tag');
        assert.ok(xml.includes('cat-uuid-1111'), 'should include uuid');
    });

    test('irToXml has correct namespaces including xs', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(catalogRules, { name: 'ТестСправочник', uuid: 'cat-uuid-1111' });
        const xml = converter.irToXml(ir, catalogRules);
        assert.ok(xml.includes('xmlns="http://v8.1c.ru/8.3/MDClasses"'), 'should have main namespace');
        assert.ok(xml.includes('xmlns:v8="http://v8.1c.ru/8.1/data/core"'), 'should have v8 namespace');
        assert.ok(xml.includes('xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"'), 'should have xr namespace');
        assert.ok(xml.includes('xmlns:xs="http://www.w3.org/2001/XMLSchema"'), 'should have xs namespace');
        assert.ok(xml.includes('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'), 'should have xsi namespace');
    });

    test('irToXml contains Autonumbering and CodeLength with correct values', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(catalogRules, { name: 'ТестСправочник', uuid: 'cat-uuid-1111' });
        const xml = converter.irToXml(ir, catalogRules);
        assert.ok(xml.includes('<Autonumbering>false</Autonumbering>'), 'should have Autonumbering=false');
        assert.ok(xml.includes('<CodeLength>0</CodeLength>'), 'should have CodeLength=0');
        assert.ok(xml.includes('<DescriptionLength>100</DescriptionLength>'), 'should have DescriptionLength=100');
        assert.ok(xml.includes('<ChoiceMode>BothWays</ChoiceMode>'), 'should have ChoiceMode=BothWays');
    });

    test('irToXml InputByString contains substituted name', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(catalogRules, { name: 'ТестСправочник', uuid: 'cat-uuid-1111' });
        const xml = converter.irToXml(ir, catalogRules);
        assert.ok(
            xml.includes('Catalog.ТестСправочник.StandardAttribute.Description'),
            'InputByString should contain substituted name'
        );
        assert.ok(!xml.includes('{Name}'), 'should not contain {Name} placeholder');
    });

    test('irToXml ExtendedListPresentation contains synonym value', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(catalogRules, { name: 'ТестСправочник', uuid: 'cat-uuid-1111' });
        const xml = converter.irToXml(ir, catalogRules);
        assert.ok(xml.includes('<ExtendedListPresentation>'), 'should have ExtendedListPresentation tag');
        assert.ok(xml.includes('ТестСправочник'), 'ExtendedListPresentation should contain synonym value');
        assert.ok(!xml.includes('{Synonym_ru}'), 'should not contain {Synonym_ru} placeholder');
    });

    test('irToXml generates ChildObjects', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(catalogRules, { name: 'ТестСправочник', uuid: 'cat-uuid-1111' });
        const xml = converter.irToXml(ir, catalogRules);
        assert.ok(xml.includes('ChildObjects'), 'Catalog should have ChildObjects');
    });

    test('irToXml properties in correct order: Autonumbering < BasedOn < Comment < Name < Synonym', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(catalogRules, { name: 'ТестСправочник', uuid: 'cat-uuid-1111' });
        const xml = converter.irToXml(ir, catalogRules);
        // Use partial tag names without closing > to handle both self-closing and open tags
        const autonumberingIdx = xml.indexOf('<Autonumbering');
        const basedOnIdx = xml.indexOf('<BasedOn');
        const commentIdx = xml.indexOf('<Comment');
        const nameIdx = xml.indexOf('<Name>');
        const synonymIdx = xml.indexOf('<Synonym>');
        assert.ok(autonumberingIdx < basedOnIdx, 'Autonumbering should come before BasedOn');
        assert.ok(basedOnIdx < commentIdx, 'BasedOn should come before Comment');
        assert.ok(commentIdx < nameIdx, 'Comment should come before Name');
        assert.ok(nameIdx < synonymIdx, 'Name should come before Synonym');
    });
});

suite('XML Snapshot: Document', () => {
    test('createDefaultIR sets name, synonym and correct defaults', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(documentRules, { name: 'ТестДокумент', uuid: 'doc-uuid-2222' });
        assert.strictEqual(ir.properties['name'], 'ТестДокумент');
        assert.strictEqual(ir.properties['synonym'], 'ТестДокумент');
        assert.strictEqual(ir.properties['autonumbering'], true);
        assert.strictEqual(ir.properties['checkUnique'], true);
        assert.strictEqual(ir.properties['dataLockControlMode'], 'Managed');
        assert.strictEqual(ir.properties['numberLength'], 11);
        assert.strictEqual(ir.properties['posting'], 'Allow');
        assert.strictEqual(ir.properties['useStandardCommands'], false);
    });

    test('irToXml generates correct root tag with uuid', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(documentRules, { name: 'ТестДокумент', uuid: 'doc-uuid-2222' });
        const xml = converter.irToXml(ir, documentRules);
        assert.ok(xml.includes('<Document uuid='), 'should have <Document uuid= root tag');
        assert.ok(xml.includes('doc-uuid-2222'), 'should include uuid');
    });

    test('irToXml has correct namespaces including xs', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(documentRules, { name: 'ТестДокумент', uuid: 'doc-uuid-2222' });
        const xml = converter.irToXml(ir, documentRules);
        assert.ok(xml.includes('xmlns="http://v8.1c.ru/8.3/MDClasses"'), 'should have main namespace');
        assert.ok(xml.includes('xmlns:v8="http://v8.1c.ru/8.1/data/core"'), 'should have v8 namespace');
        assert.ok(xml.includes('xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"'), 'should have xr namespace');
        assert.ok(xml.includes('xmlns:xs="http://www.w3.org/2001/XMLSchema"'), 'should have xs namespace');
        assert.ok(xml.includes('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'), 'should have xsi namespace');
    });

    test('irToXml contains Autonumbering=true and CheckUnique=true', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(documentRules, { name: 'ТестДокумент', uuid: 'doc-uuid-2222' });
        const xml = converter.irToXml(ir, documentRules);
        assert.ok(xml.includes('<Autonumbering>true</Autonumbering>'), 'should have Autonumbering=true');
        assert.ok(xml.includes('<CheckUnique>true</CheckUnique>'), 'should have CheckUnique=true');
    });

    test('irToXml contains DataLockControlMode=Managed and NumberLength=11', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(documentRules, { name: 'ТестДокумент', uuid: 'doc-uuid-2222' });
        const xml = converter.irToXml(ir, documentRules);
        assert.ok(xml.includes('<DataLockControlMode>Managed</DataLockControlMode>'), 'should have DataLockControlMode=Managed');
        assert.ok(xml.includes('<NumberLength>11</NumberLength>'), 'should have NumberLength=11');
        assert.ok(xml.includes('<Posting>Allow</Posting>'), 'should have Posting=Allow');
    });

    test('irToXml InputByString contains substituted document name', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(documentRules, { name: 'ТестДокумент', uuid: 'doc-uuid-2222' });
        const xml = converter.irToXml(ir, documentRules);
        assert.ok(
            xml.includes('Document.ТестДокумент.StandardAttribute.Number'),
            'InputByString should contain substituted name with Number attribute'
        );
        assert.ok(!xml.includes('{Name}'), 'should not contain {Name} placeholder');
    });

    test('irToXml ListPresentation contains synonym value', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(documentRules, { name: 'ТестДокумент', uuid: 'doc-uuid-2222' });
        const xml = converter.irToXml(ir, documentRules);
        assert.ok(xml.includes('<ListPresentation>'), 'should have ListPresentation tag');
        assert.ok(xml.includes('ТестДокумент'), 'ListPresentation should contain synonym value');
        assert.ok(!xml.includes('{Synonym_ru}'), 'should not contain {Synonym_ru} placeholder');
    });

    test('irToXml generates ChildObjects', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(documentRules, { name: 'ТестДокумент', uuid: 'doc-uuid-2222' });
        const xml = converter.irToXml(ir, documentRules);
        assert.ok(xml.includes('ChildObjects'), 'Document should have ChildObjects');
    });

    test('irToXml properties in correct order: Autonumbering < Comment < Name < NumberLength < Synonym', () => {
        const converter = makeConverter();
        const ir = converter.createDefaultIR(documentRules, { name: 'ТестДокумент', uuid: 'doc-uuid-2222' });
        const xml = converter.irToXml(ir, documentRules);
        const autonumberingIdx = xml.indexOf('<Autonumbering');
        const commentIdx = xml.indexOf('<Comment');
        const nameIdx = xml.indexOf('<Name>');
        const numberLengthIdx = xml.indexOf('<NumberLength>');
        const synonymIdx = xml.indexOf('<Synonym>');
        assert.ok(autonumberingIdx < commentIdx, 'Autonumbering should come before Comment');
        assert.ok(commentIdx < nameIdx, 'Comment should come before Name');
        assert.ok(nameIdx < numberLengthIdx, 'Name should come before NumberLength');
        assert.ok(numberLengthIdx < synonymIdx, 'NumberLength should come before Synonym');
    });
});
