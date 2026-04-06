// test/suite/rules/yamlRoundTrip.test.ts
// YAML snapshot, default-filtering и round-trip тесты для 5 pilot-типов.
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

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: YAML Snapshot — для каждого из 5 типов
// ─────────────────────────────────────────────────────────────────────────────

suite('YAML Snapshot: CommonModule', () => {
    test('YAML contains Тип and rootTag', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(commonModuleRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, commonModuleRules);
        assert.ok(yamlStr.includes('Тип:'), 'should have Тип: key');
        assert.ok(yamlStr.includes('CommonModule'), 'should contain rootTag CommonModule');
    });

    test('YAML contains Имя and Синоним', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(commonModuleRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, commonModuleRules);
        assert.ok(yamlStr.includes('Имя: ТестYAML'), 'should have Имя: ТестYAML');
        assert.ok(yamlStr.includes('Синоним: ТестYAML'), 'should have Синоним: ТестYAML');
    });

    test('YAML does not contain empty default string properties', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(commonModuleRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, commonModuleRules);
        assert.ok(!yamlStr.includes('Комментарий:'), 'empty comment should be filtered');
    });

    test('КлиентУправляемоеПриложение is NOT in YAML (default=true filtered out)', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(commonModuleRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, commonModuleRules);
        // clientManagedApplication defaultValueXML=true, toYaml returns undefined
        assert.ok(!yamlStr.includes('КлиентУправляемоеПриложение:'), 'default true should be filtered');
    });

    test('non-default boolean appears in YAML', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(commonModuleRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const ir2 = c.mergeProperties(ir, { global: true });
        const yamlStr = c.irToYaml(ir2, commonModuleRules);
        assert.ok(yamlStr.includes('Глобальный: true'), 'non-default global=true should appear');
    });
});

suite('YAML Snapshot: Subsystem', () => {
    test('YAML contains Тип: Subsystem', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(subsystemRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, subsystemRules);
        assert.ok(yamlStr.includes('Тип:'), 'should have Тип: key');
        assert.ok(yamlStr.includes('Subsystem'), 'should contain rootTag Subsystem');
    });

    test('YAML contains Имя and Синоним', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(subsystemRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, subsystemRules);
        assert.ok(yamlStr.includes('Имя: ТестYAML'), 'should have Имя: ТестYAML');
        assert.ok(yamlStr.includes('Синоним: ТестYAML'), 'should have Синоним: ТестYAML');
    });

    test('ВключатьВКомандныйИнтерфейс not in YAML (default=true)', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(subsystemRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, subsystemRules);
        assert.ok(!yamlStr.includes('ВключатьВКомандныйИнтерфейс:'), 'default includeInCommandInterface should be filtered');
    });
});

suite('YAML Snapshot: Enum', () => {
    test('YAML contains Тип: Enum', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(enumRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, enumRules);
        assert.ok(yamlStr.includes('Тип:'), 'should have Тип: key');
        assert.ok(yamlStr.includes('Enum'), 'should contain rootTag Enum');
    });

    test('YAML contains Имя and Синоним', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(enumRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, enumRules);
        assert.ok(yamlStr.includes('Имя: ТестYAML'), 'should have Имя: ТестYAML');
        assert.ok(yamlStr.includes('Синоним: ТестYAML'), 'should have Синоним: ТестYAML');
    });

    test('default РежимВыбора not in YAML', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(enumRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, enumRules);
        // choiceMode default=BothWays, quickChoice default=true — both filtered
        assert.ok(!yamlStr.includes('РежимВыбора:'), 'default choiceMode should be filtered');
        assert.ok(!yamlStr.includes('БыстрыйВыбор:'), 'default quickChoice=true should be filtered');
    });
});

suite('YAML Snapshot: Catalog', () => {
    test('YAML contains Тип: Catalog', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(catalogRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, catalogRules);
        assert.ok(yamlStr.includes('Тип:'), 'should have Тип: key');
        assert.ok(yamlStr.includes('Catalog'), 'should contain rootTag Catalog');
    });

    test('YAML contains Имя and Синоним', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(catalogRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, catalogRules);
        assert.ok(yamlStr.includes('Имя: ТестYAML'), 'should have Имя: ТестYAML');
        assert.ok(yamlStr.includes('Синоним: ТестYAML'), 'should have Синоним: ТестYAML');
    });

    test('non-default hierarchical appears in YAML', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(catalogRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const ir2 = c.mergeProperties(ir, { hierarchical: true });
        const yamlStr = c.irToYaml(ir2, catalogRules);
        assert.ok(yamlStr.includes('Иерархический: true'), 'non-default hierarchical=true should appear');
    });
});

suite('YAML Snapshot: Document', () => {
    test('YAML contains Тип: Document', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(documentRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, documentRules);
        assert.ok(yamlStr.includes('Тип:'), 'should have Тип: key');
        assert.ok(yamlStr.includes('Document'), 'should contain rootTag Document');
    });

    test('YAML contains Имя and Синоним', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(documentRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, documentRules);
        assert.ok(yamlStr.includes('Имя: ТестYAML'), 'should have Имя: ТестYAML');
        assert.ok(yamlStr.includes('Синоним: ТестYAML'), 'should have Синоним: ТестYAML');
    });

    test('non-default numberLength=15 appears in YAML', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(documentRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const ir2 = c.mergeProperties(ir, { numberLength: 15 });
        const yamlStr = c.irToYaml(ir2, documentRules);
        assert.ok(yamlStr.includes('ДлинаНомера: 15'), 'non-default numberLength=15 should appear');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Default filtering
// ─────────────────────────────────────────────────────────────────────────────

suite('YAML Default Filtering: Catalog', () => {
    test('default IR YAML contains only Тип, Имя, Синоним', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(catalogRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const yamlStr = c.irToYaml(ir, catalogRules);
        // Only these three keys should appear (all others are defaults → filtered)
        const lines = yamlStr.split('\n').filter(l => l.trim() !== '' && !l.startsWith('#'));
        const keys = lines.map(l => l.split(':')[0].trim());
        assert.ok(keys.includes('Тип'), 'Тип should be present');
        assert.ok(keys.includes('Имя'), 'Имя should be present');
        assert.ok(keys.includes('Синоним'), 'Синоним should be present');
        // No yaml-mapped properties with non-default values
        assert.ok(!yamlStr.includes('Автонумерация:'), 'autonumbering default=false filtered');
        assert.ok(!yamlStr.includes('ДлинаКода:'), 'codeLength default=0 filtered');
        assert.ok(!yamlStr.includes('Иерархический:'), 'hierarchical default=false filtered');
    });

    test('merging hierarchical=true and codeLength=11 adds them to YAML', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(catalogRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const ir2 = c.mergeProperties(ir, { hierarchical: true, codeLength: 11 });
        const yamlStr = c.irToYaml(ir2, catalogRules);
        assert.ok(yamlStr.includes('Иерархический: true'), 'hierarchical=true should appear after merge');
        assert.ok(yamlStr.includes('ДлинаКода: 11'), 'codeLength=11 should appear after merge');
    });

    test('merging codeLength back to 0 removes it from YAML', () => {
        const c = makeConverter();
        const ir = c.createDefaultIR(catalogRules, { name: 'ТестYAML', uuid: 'yaml-test-uuid' });
        const ir2 = c.mergeProperties(ir, { codeLength: 11 });
        const ir3 = c.mergeProperties(ir2, { codeLength: 0 });
        const yamlStr = c.irToYaml(ir3, catalogRules);
        assert.ok(!yamlStr.includes('ДлинаКода:'), 'codeLength back to default=0 should be filtered');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: YAML Round-trip
// ─────────────────────────────────────────────────────────────────────────────

suite('YAML Round-trip: CommonModule', () => {
    test('objectType and name survive round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(commonModuleRules, { name: 'МодульТест', uuid: 'rt-uuid-1' });
        const ir1mod = c.mergeProperties(ir1, { global: true, server: true });
        const yamlStr = c.irToYaml(ir1mod, commonModuleRules);
        const ir2 = c.yamlToIr(yamlStr, commonModuleRules);
        assert.strictEqual(ir2.objectType, ir1mod.objectType, 'objectType should survive round-trip');
        assert.strictEqual(ir2.name, ir1mod.name, 'name should survive round-trip');
    });

    test('modified properties survive round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(commonModuleRules, { name: 'МодульТест', uuid: 'rt-uuid-1' });
        const ir1mod = c.mergeProperties(ir1, { global: true, server: true });
        const yamlStr = c.irToYaml(ir1mod, commonModuleRules);
        const ir2 = c.yamlToIr(yamlStr, commonModuleRules);
        assert.strictEqual(ir2.properties['global'], true, 'global=true should survive');
        assert.strictEqual(ir2.properties['server'], true, 'server=true should survive');
    });

    test('default properties are restored after round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(commonModuleRules, { name: 'МодульТест', uuid: 'rt-uuid-1' });
        const yamlStr = c.irToYaml(ir1, commonModuleRules);
        const ir2 = c.yamlToIr(yamlStr, commonModuleRules);
        // clientManagedApplication filtered from YAML, but yamlToIr restores default=true
        assert.strictEqual(ir2.properties['clientManagedApplication'], true, 'clientManagedApplication default restored');
        assert.strictEqual(ir2.properties['global'], false, 'global default=false restored');
    });
});

suite('YAML Round-trip: Catalog', () => {
    test('objectType and name survive round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(catalogRules, { name: 'СправочникТест', uuid: 'rt-uuid-2' });
        const ir1mod = c.mergeProperties(ir1, { hierarchical: true, codeLength: 10 });
        const yamlStr = c.irToYaml(ir1mod, catalogRules);
        const ir2 = c.yamlToIr(yamlStr, catalogRules);
        assert.strictEqual(ir2.objectType, ir1mod.objectType, 'objectType should survive');
        assert.strictEqual(ir2.name, ir1mod.name, 'name should survive');
    });

    test('hierarchical=true and codeLength=10 survive round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(catalogRules, { name: 'СправочникТест', uuid: 'rt-uuid-2' });
        const ir1mod = c.mergeProperties(ir1, { hierarchical: true, codeLength: 10 });
        const yamlStr = c.irToYaml(ir1mod, catalogRules);
        const ir2 = c.yamlToIr(yamlStr, catalogRules);
        assert.strictEqual(ir2.properties['hierarchical'], true, 'hierarchical=true should survive');
        assert.strictEqual(ir2.properties['codeLength'], 10, 'codeLength=10 should survive');
    });

    test('default properties are restored after round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(catalogRules, { name: 'СправочникТест', uuid: 'rt-uuid-2' });
        const ir1mod = c.mergeProperties(ir1, { hierarchical: true });
        const yamlStr = c.irToYaml(ir1mod, catalogRules);
        const ir2 = c.yamlToIr(yamlStr, catalogRules);
        // codeLength was not in YAML (default=0), should be restored
        assert.strictEqual(ir2.properties['codeLength'], 0, 'codeLength default=0 restored');
        assert.strictEqual(ir2.properties['autonumbering'], false, 'autonumbering default=false restored');
    });
});

suite('YAML Round-trip: Document', () => {
    test('numberLength=20 survives round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(documentRules, { name: 'ДокументТест', uuid: 'rt-uuid-3' });
        const ir1mod = c.mergeProperties(ir1, { numberLength: 20 });
        const yamlStr = c.irToYaml(ir1mod, documentRules);
        const ir2 = c.yamlToIr(yamlStr, documentRules);
        assert.strictEqual(ir2.properties['numberLength'], 20, 'numberLength=20 should survive');
        assert.strictEqual(ir2.objectType, 'Document', 'objectType should be Document');
    });

    test('default numberLength=11 is restored after round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(documentRules, { name: 'ДокументТест', uuid: 'rt-uuid-3' });
        const yamlStr = c.irToYaml(ir1, documentRules);
        const ir2 = c.yamlToIr(yamlStr, documentRules);
        assert.strictEqual(ir2.properties['numberLength'], 11, 'default numberLength=11 restored');
    });
});

suite('YAML Round-trip: Subsystem', () => {
    test('name and objectType survive round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(subsystemRules, { name: 'ПодсистемаТест', uuid: 'rt-uuid-4' });
        const yamlStr = c.irToYaml(ir1, subsystemRules);
        const ir2 = c.yamlToIr(yamlStr, subsystemRules);
        assert.strictEqual(ir2.objectType, 'Subsystem', 'objectType should be Subsystem');
        assert.strictEqual(ir2.name, 'ПодсистемаТест', 'name should survive');
    });

    test('includeInCommandInterface default=true restored after round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(subsystemRules, { name: 'ПодсистемаТест', uuid: 'rt-uuid-4' });
        const yamlStr = c.irToYaml(ir1, subsystemRules);
        const ir2 = c.yamlToIr(yamlStr, subsystemRules);
        assert.strictEqual(ir2.properties['includeInCommandInterface'], true, 'default true restored');
    });
});

suite('YAML Round-trip: Enum', () => {
    test('name and objectType survive round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(enumRules, { name: 'ПеречислениеТест', uuid: 'rt-uuid-5' });
        const ir1mod = c.mergeProperties(ir1, { choiceMode: 'FromForm' });
        const yamlStr = c.irToYaml(ir1mod, enumRules);
        const ir2 = c.yamlToIr(yamlStr, enumRules);
        assert.strictEqual(ir2.objectType, 'Enum', 'objectType should be Enum');
        assert.strictEqual(ir2.name, 'ПеречислениеТест', 'name should survive');
    });

    test('non-default choiceMode=FromForm survives round-trip', () => {
        const c = makeConverter();
        const ir1 = c.createDefaultIR(enumRules, { name: 'ПеречислениеТест', uuid: 'rt-uuid-5' });
        const ir1mod = c.mergeProperties(ir1, { choiceMode: 'FromForm' });
        const yamlStr = c.irToYaml(ir1mod, enumRules);
        const ir2 = c.yamlToIr(yamlStr, enumRules);
        assert.strictEqual(ir2.properties['choiceMode'], 'FromForm', 'choiceMode=FromForm should survive');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: YAML fromYaml edge cases
// ─────────────────────────────────────────────────────────────────────────────

suite('YAML fromYaml edge cases', () => {
    test('empty YAML (only Тип and Имя) — all properties get defaults', () => {
        const c = makeConverter();
        const minimalYaml = 'Тип: Catalog\nИмя: МинимальныйТест\n';
        const ir = c.yamlToIr(minimalYaml, catalogRules);
        assert.strictEqual(ir.name, 'МинимальныйТест', 'name from YAML');
        assert.strictEqual(ir.objectType, 'Catalog', 'objectType from YAML');
        assert.strictEqual(ir.properties['codeLength'], 0, 'codeLength default=0');
        assert.strictEqual(ir.properties['hierarchical'], false, 'hierarchical default=false');
        assert.strictEqual(ir.properties['autonumbering'], false, 'autonumbering default=false');
        assert.strictEqual(ir.properties['descriptionLength'], 100, 'descriptionLength default=100');
    });

    test('YAML with unknown keys — ignored gracefully', () => {
        const c = makeConverter();
        const yamlWithUnknown = 'Тип: CommonModule\nИмя: ТестМодуль\nНесуществующийКлюч: значение\n';
        // Should not throw
        let ir: ReturnType<typeof c.yamlToIr> | undefined;
        assert.doesNotThrow(() => {
            ir = c.yamlToIr(yamlWithUnknown, commonModuleRules);
        }, 'unknown keys should be ignored');
        assert.ok(ir !== undefined, 'ir should be defined');
        assert.strictEqual(ir!.name, 'ТестМодуль', 'name should be parsed');
        assert.strictEqual(ir!.properties['global'], false, 'known defaults still set');
    });

    test('empty YAML for Document — numberLength gets default 11', () => {
        const c = makeConverter();
        const minimalYaml = 'Тип: Document\nИмя: ДокМин\n';
        const ir = c.yamlToIr(minimalYaml, documentRules);
        assert.strictEqual(ir.properties['numberLength'], 11, 'numberLength default=11 restored');
        assert.strictEqual(ir.properties['autonumbering'], true, 'autonumbering default=true restored');
    });
});
