// test/suite/rules/rulesE2ePipeline.test.ts
// E2E тесты для полного rules-based pipeline: createDefaultIR → irToXml → injectInternalInfo → normalizeRoot → xmlToIr
import * as assert from 'assert';
import { rulesRegistry, metadataConverter } from '../../../src/rules/index';
import { injectInternalInfoIntoMetadataXml } from '../../../src/utils/xml/internalInfoGenerator';
import { normalizeMetaDataObjectRoot } from '../../../src/utils/xml/metaDataObjectRootNormalizer';

const TEST_NAME = 'ТестОбъект';
const TEST_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function runPipeline(rootTag: string): string {
    const rules = rulesRegistry.get(rootTag);
    if (!rules) {throw new Error(`No rules found for rootTag: ${rootTag}`);}
    const ir = metadataConverter.createDefaultIR(rules, { name: TEST_NAME, uuid: TEST_UUID });
    const xml = metadataConverter.irToXml(ir, rules);
    const withInternal = injectInternalInfoIntoMetadataXml(xml, rootTag, TEST_NAME);
    return normalizeMetaDataObjectRoot(withInternal);
}

suite('E2E Pipeline: CommonModule', () => {
    test('starts with xml declaration', () => {
        const xml = runPipeline('CommonModule');
        assert.ok(xml.startsWith('<?xml'), 'should start with <?xml');
    });

    test('contains MetaDataObject', () => {
        const xml = runPipeline('CommonModule');
        assert.ok(xml.includes('<MetaDataObject'), 'should contain <MetaDataObject');
    });

    test('contains root tag with uuid', () => {
        const xml = runPipeline('CommonModule');
        assert.ok(xml.includes('<CommonModule'), 'should contain <CommonModule');
        assert.ok(xml.includes(TEST_UUID), 'should contain uuid');
    });

    test('contains Name tag', () => {
        const xml = runPipeline('CommonModule');
        assert.ok(xml.includes(`<Name>${TEST_NAME}</Name>`), 'should contain <Name>ТестОбъект</Name>');
    });

    test('does NOT contain InternalInfo (CommonModule is excluded)', () => {
        const xml = runPipeline('CommonModule');
        // CommonModule is in ROOT_TAGS_WITHOUT_INTERNALINFO
        assert.ok(!xml.includes('<InternalInfo>'), 'CommonModule should NOT have InternalInfo');
    });

    test('does NOT contain placeholders', () => {
        const xml = runPipeline('CommonModule');
        assert.ok(!xml.includes('{Name}'), 'should not contain {Name} placeholder');
        assert.ok(!xml.includes('{uuid}'), 'should not contain {uuid} placeholder');
        assert.ok(!xml.includes('{Synonym_ru}'), 'should not contain {Synonym_ru} placeholder');
    });

    test('does NOT contain ChildObjects', () => {
        const xml = runPipeline('CommonModule');
        assert.ok(!xml.includes('<ChildObjects'), 'CommonModule should NOT have ChildObjects');
    });

    test('MetaDataObject has canonical namespaces after normalization', () => {
        const xml = runPipeline('CommonModule');
        assert.ok(xml.includes('version="2.20"'), 'should have canonical MetaDataObject with version="2.20"');
    });
});

suite('E2E Pipeline: Subsystem', () => {
    test('starts with xml declaration', () => {
        const xml = runPipeline('Subsystem');
        assert.ok(xml.startsWith('<?xml'), 'should start with <?xml');
    });

    test('contains MetaDataObject', () => {
        const xml = runPipeline('Subsystem');
        assert.ok(xml.includes('<MetaDataObject'), 'should contain <MetaDataObject');
    });

    test('contains root tag with uuid', () => {
        const xml = runPipeline('Subsystem');
        assert.ok(xml.includes('<Subsystem'), 'should contain <Subsystem');
        assert.ok(xml.includes(TEST_UUID), 'should contain uuid');
    });

    test('contains Name tag', () => {
        const xml = runPipeline('Subsystem');
        assert.ok(xml.includes(`<Name>${TEST_NAME}</Name>`), 'should contain <Name>ТестОбъект</Name>');
    });

    test('does NOT contain InternalInfo (Subsystem is excluded)', () => {
        const xml = runPipeline('Subsystem');
        assert.ok(!xml.includes('<InternalInfo>'), 'Subsystem should NOT have InternalInfo');
    });

    test('does NOT contain placeholders', () => {
        const xml = runPipeline('Subsystem');
        assert.ok(!xml.includes('{Name}'), 'should not contain {Name} placeholder');
        assert.ok(!xml.includes('{uuid}'), 'should not contain {uuid} placeholder');
        assert.ok(!xml.includes('{Synonym_ru}'), 'should not contain {Synonym_ru} placeholder');
    });

    test('contains ChildObjects', () => {
        const xml = runPipeline('Subsystem');
        assert.ok(xml.includes('<ChildObjects'), 'Subsystem should have ChildObjects');
    });
});

suite('E2E Pipeline: Enum', () => {
    test('starts with xml declaration', () => {
        const xml = runPipeline('Enum');
        assert.ok(xml.startsWith('<?xml'), 'should start with <?xml');
    });

    test('contains MetaDataObject', () => {
        const xml = runPipeline('Enum');
        assert.ok(xml.includes('<MetaDataObject'), 'should contain <MetaDataObject');
    });

    test('contains root tag with uuid', () => {
        const xml = runPipeline('Enum');
        assert.ok(xml.includes('<Enum'), 'should contain <Enum');
        assert.ok(xml.includes(TEST_UUID), 'should contain uuid');
    });

    test('contains Name tag', () => {
        const xml = runPipeline('Enum');
        assert.ok(xml.includes(`<Name>${TEST_NAME}</Name>`), 'should contain <Name>ТестОбъект</Name>');
    });

    test('contains InternalInfo', () => {
        const xml = runPipeline('Enum');
        assert.ok(xml.includes('<InternalInfo>'), 'Enum should have InternalInfo injected');
    });

    test('does NOT contain placeholders', () => {
        const xml = runPipeline('Enum');
        assert.ok(!xml.includes('{Name}'), 'should not contain {Name} placeholder');
        assert.ok(!xml.includes('{uuid}'), 'should not contain {uuid} placeholder');
        assert.ok(!xml.includes('{Synonym_ru}'), 'should not contain {Synonym_ru} placeholder');
    });

    test('contains ChildObjects', () => {
        const xml = runPipeline('Enum');
        assert.ok(xml.includes('<ChildObjects'), 'Enum should have ChildObjects');
    });
});

suite('E2E Pipeline: Catalog', () => {
    test('starts with xml declaration', () => {
        const xml = runPipeline('Catalog');
        assert.ok(xml.startsWith('<?xml'), 'should start with <?xml');
    });

    test('contains MetaDataObject', () => {
        const xml = runPipeline('Catalog');
        assert.ok(xml.includes('<MetaDataObject'), 'should contain <MetaDataObject');
    });

    test('contains root tag with uuid', () => {
        const xml = runPipeline('Catalog');
        assert.ok(xml.includes('<Catalog'), 'should contain <Catalog');
        assert.ok(xml.includes(TEST_UUID), 'should contain uuid');
    });

    test('contains Name tag', () => {
        const xml = runPipeline('Catalog');
        assert.ok(xml.includes(`<Name>${TEST_NAME}</Name>`), 'should contain <Name>ТестОбъект</Name>');
    });

    test('contains InternalInfo', () => {
        const xml = runPipeline('Catalog');
        assert.ok(xml.includes('<InternalInfo>'), 'Catalog should have InternalInfo injected');
    });

    test('does NOT contain placeholders', () => {
        const xml = runPipeline('Catalog');
        assert.ok(!xml.includes('{Name}'), 'should not contain {Name} placeholder');
        assert.ok(!xml.includes('{uuid}'), 'should not contain {uuid} placeholder');
        assert.ok(!xml.includes('{Synonym_ru}'), 'should not contain {Synonym_ru} placeholder');
    });

    test('InputByString contains Catalog.ТестОбъект.StandardAttribute.Description', () => {
        const xml = runPipeline('Catalog');
        assert.ok(
            xml.includes(`Catalog.${TEST_NAME}.StandardAttribute.Description`),
            'InputByString should reference Description standard attribute with substituted name'
        );
    });

    test('contains ChildObjects', () => {
        const xml = runPipeline('Catalog');
        assert.ok(xml.includes('<ChildObjects'), 'Catalog should have ChildObjects');
    });
});

suite('E2E Pipeline: Document', () => {
    test('starts with xml declaration', () => {
        const xml = runPipeline('Document');
        assert.ok(xml.startsWith('<?xml'), 'should start with <?xml');
    });

    test('contains MetaDataObject', () => {
        const xml = runPipeline('Document');
        assert.ok(xml.includes('<MetaDataObject'), 'should contain <MetaDataObject');
    });

    test('contains root tag with uuid', () => {
        const xml = runPipeline('Document');
        assert.ok(xml.includes('<Document'), 'should contain <Document');
        assert.ok(xml.includes(TEST_UUID), 'should contain uuid');
    });

    test('contains Name tag', () => {
        const xml = runPipeline('Document');
        assert.ok(xml.includes(`<Name>${TEST_NAME}</Name>`), 'should contain <Name>ТестОбъект</Name>');
    });

    test('contains InternalInfo', () => {
        const xml = runPipeline('Document');
        assert.ok(xml.includes('<InternalInfo>'), 'Document should have InternalInfo injected');
    });

    test('does NOT contain placeholders', () => {
        const xml = runPipeline('Document');
        assert.ok(!xml.includes('{Name}'), 'should not contain {Name} placeholder');
        assert.ok(!xml.includes('{uuid}'), 'should not contain {uuid} placeholder');
        assert.ok(!xml.includes('{Synonym_ru}'), 'should not contain {Synonym_ru} placeholder');
    });

    test('InputByString contains Document.ТестОбъект.StandardAttribute.Number', () => {
        const xml = runPipeline('Document');
        assert.ok(
            xml.includes(`Document.${TEST_NAME}.StandardAttribute.Number`),
            'InputByString should reference Number standard attribute with substituted name'
        );
    });

    test('contains ChildObjects', () => {
        const xml = runPipeline('Document');
        assert.ok(xml.includes('<ChildObjects'), 'Document should have ChildObjects');
    });
});

suite('E2E Round-trip: xmlToIr restores IR from generated XML', () => {
    const roundTripCases: Array<{ rootTag: string; checkProps: string[] }> = [
        { rootTag: 'CommonModule', checkProps: ['name', 'global', 'server', 'clientManagedApplication'] },
        { rootTag: 'Subsystem', checkProps: ['name', 'includeInCommandInterface', 'includeHelpInContents'] },
        { rootTag: 'Enum', checkProps: ['name', 'choiceHistoryOnInput', 'quickChoice', 'choiceMode'] },
        { rootTag: 'Catalog', checkProps: ['name', 'autonumbering', 'codeLength', 'descriptionLength'] },
        { rootTag: 'Document', checkProps: ['name', 'autonumbering', 'checkUnique', 'numberLength'] },
    ];

    for (const { rootTag, checkProps } of roundTripCases) {
        test(`round-trip ${rootTag}: xmlToIr restores key IR fields`, () => {
            const rules = rulesRegistry.get(rootTag);
            if (!rules) {throw new Error(`No rules for ${rootTag}`);}

            const irOriginal = metadataConverter.createDefaultIR(rules, { name: TEST_NAME, uuid: TEST_UUID });
            const xml = metadataConverter.irToXml(irOriginal, rules);
            const irRestored = metadataConverter.xmlToIr(xml, rules);

            assert.strictEqual(irRestored.objectType, rootTag, `objectType should be ${rootTag}`);
            assert.strictEqual(irRestored.uuid, TEST_UUID, 'uuid should be restored');
            assert.strictEqual(irRestored.name, TEST_NAME, 'name should be restored');

            for (const prop of checkProps) {
                assert.deepStrictEqual(
                    irRestored.properties[prop],
                    irOriginal.properties[prop],
                    `property '${prop}' should survive round-trip for ${rootTag}`
                );
            }
        });
    }
});
