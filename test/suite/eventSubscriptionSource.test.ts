import * as assert from 'assert';
import { ObjectTypeParser } from '../../src/parsers/objectTypeParser';
import { ObjectTypeSerializer } from '../../src/serializers/objectTypeSerializer';
import type { ObjectTypeDefinition, ObjectableGroup } from '../../src/types/objectTypeDefinitions';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const EVENT_SUBSCRIPTION_SOURCE_XML_2 = `<Source>
  <v8:Type>cfg:DocumentObject.АвансовыйОтчет</v8:Type>
  <v8:Type>cfg:CatalogObject.Контрагенты</v8:Type>
</Source>`;

const EVENT_SUBSCRIPTION_SOURCE_XML_3 = `<Source>
  <v8:Type>cfg:DocumentObject.АвансовыйОтчет</v8:Type>
  <v8:Type>cfg:CatalogObject.Контрагенты</v8:Type>
  <v8:Type>cfg:InformationRegisterRecordSet.ЦеныНоменклатуры</v8:Type>
</Source>`;

// Source with a catalog that does not exist in the project
const EVENT_SUBSCRIPTION_SOURCE_XML_VIRTUAL = `<Source>
  <v8:Type>cfg:CatalogObject.УдалённыйСправочник</v8:Type>
</Source>`;

// ─── Scenario 1: Parse Source from EventSubscription XML ─────────────────────

suite('EventSubscription Source — parse', () => {
  test('2 Object-types parsed correctly', () => {
    const def = ObjectTypeParser.parse(EVENT_SUBSCRIPTION_SOURCE_XML_2);
    assert.strictEqual(def.types.length, 2);
    assert.strictEqual(def.types[0].objectKind, 'DocumentObject');
    assert.strictEqual(def.types[0].objectName, 'АвансовыйОтчет');
    assert.strictEqual(def.types[1].objectKind, 'CatalogObject');
    assert.strictEqual(def.types[1].objectName, 'Контрагенты');
  });

  test('3 Object-types parsed correctly (including RecordSet)', () => {
    const def = ObjectTypeParser.parse(EVENT_SUBSCRIPTION_SOURCE_XML_3);
    assert.strictEqual(def.types.length, 3);
    assert.strictEqual(def.types[2].objectKind, 'InformationRegisterRecordSet');
    assert.strictEqual(def.types[2].objectName, 'ЦеныНоменклатуры');
  });

  test('parseFromObject with Source wrapper (as stored in node.properties)', () => {
    // Simulates the object that fast-xml-parser produces when reading EventSubscription XML
    const obj: Record<string, unknown> = {
      Source: { 'v8:Type': ['cfg:DocumentObject.АвансовыйОтчет', 'cfg:CatalogObject.Контрагенты'] },
    };
    const def = ObjectTypeParser.parseFromObject(obj);
    assert.strictEqual(def.types.length, 2);
    assert.strictEqual(def.types[0].objectKind, 'DocumentObject');
    assert.strictEqual(def.types[1].objectKind, 'CatalogObject');
  });

  test('parseFromObject with single v8:Type (not array)', () => {
    const obj: Record<string, unknown> = {
      Source: { 'v8:Type': 'cfg:CatalogObject.Контрагенты' },
    };
    const def = ObjectTypeParser.parseFromObject(obj);
    assert.strictEqual(def.types.length, 1);
    assert.strictEqual(def.types[0].objectName, 'Контрагенты');
  });
});

// ─── Scenario 2: handleEditSourceMessage logic (mocked) ──────────────────────

suite('EventSubscription Source — editor integration (pure logic)', () => {
  /** Simulates what handleEditSourceMessage does to build sourceXML from node.properties['Source'] */
  function buildSourceXMLFromNodeProperty(rawSource: unknown): string {
    if (typeof rawSource === 'object' && rawSource !== null && !Array.isArray(rawSource)) {
      const def = ObjectTypeParser.parseFromObject(rawSource as Record<string, unknown>);
      return ObjectTypeSerializer.serialize(def);
    } else if (typeof rawSource === 'string' && rawSource.includes('<')) {
      return rawSource;
    }
    return '';
  }

  /** Simulates what ObjectTypeEditorProvider.show() returns when user saves */
  function simulateEditorSave(selectedIds: string[]): ObjectTypeDefinition {
    const types = selectedIds
      .map((id) => {
        const colonIdx = id.indexOf(':');
        if (colonIdx === -1) { return null; }
        return { objectKind: id.slice(0, colonIdx), objectName: id.slice(colonIdx + 1) };
      })
      .filter((t): t is { objectKind: string; objectName: string } => t !== null);
    return { types } as ObjectTypeDefinition;
  }

  test('object node property converted to correct sourceXML', () => {
    const rawSource = { 'v8:Type': ['cfg:DocumentObject.АвансовыйОтчет', 'cfg:CatalogObject.Контрагенты'] };
    const xml = buildSourceXMLFromNodeProperty(rawSource);
    assert.ok(xml.includes('cfg:DocumentObject.АвансовыйОтчет'));
    assert.ok(xml.includes('cfg:CatalogObject.Контрагенты'));
    assert.ok(xml.startsWith('<Source'));
  });

  test('XML string node property passed as-is', () => {
    const rawSource = EVENT_SUBSCRIPTION_SOURCE_XML_2;
    const xml = buildSourceXMLFromNodeProperty(rawSource);
    assert.strictEqual(xml, EVENT_SUBSCRIPTION_SOURCE_XML_2);
  });

  test('empty/missing rawSource produces empty string', () => {
    assert.strictEqual(buildSourceXMLFromNodeProperty(null), '');
    assert.strictEqual(buildSourceXMLFromNodeProperty(undefined), '');
    assert.strictEqual(buildSourceXMLFromNodeProperty(''), '');
  });

  test('objectableGroups contain only Object-kinds (not Ref-kinds)', () => {
    // Verifies that the groups passed to editor only contain valid Object-kinds
    const groups: ObjectableGroup[] = [
      { objectKind: 'CatalogObject', objectNames: ['Контрагенты', 'Номенклатура'] },
      { objectKind: 'DocumentObject', objectNames: ['АвансовыйОтчет'] },
      { objectKind: 'InformationRegisterRecordSet', objectNames: ['ЦеныНоменклатуры'] },
    ];
    const VALID_OBJECT_KINDS = new Set([
      'CatalogObject', 'DocumentObject', 'BusinessProcessObject', 'TaskObject',
      'ChartOfCharacteristicTypesObject', 'ChartOfAccountsObject', 'ChartOfCalculationTypesObject',
      'ExchangePlanObject', 'InformationRegisterRecordSet', 'AccumulationRegisterRecordSet',
      'AccountingRegisterRecordSet', 'CalculationRegisterRecordSet',
    ]);
    for (const g of groups) {
      assert.ok(VALID_OBJECT_KINDS.has(g.objectKind), `${g.objectKind} must be a valid Object-kind`);
    }
  });

  test('editor save produces correct updatedSourceXML', () => {
    const selectedIds = ['CatalogObject:Контрагенты', 'DocumentObject:АвансовыйОтчет'];
    const def = simulateEditorSave(selectedIds);
    const xml = ObjectTypeSerializer.serialize(def);
    assert.ok(xml.includes('cfg:CatalogObject.Контрагенты'));
    assert.ok(xml.includes('cfg:DocumentObject.АвансовыйОтчет'));
    assert.ok(xml.startsWith('<Source'));
  });
});

// ─── Scenario 3: Round-trip ───────────────────────────────────────────────────

suite('EventSubscription Source — round-trip', () => {
  test('parse → serialize → parse preserves type set (2 types)', () => {
    const def1 = ObjectTypeParser.parse(EVENT_SUBSCRIPTION_SOURCE_XML_2);
    const serialized = ObjectTypeSerializer.serialize(def1);
    const def2 = ObjectTypeParser.parse(serialized);
    assert.deepStrictEqual(def2.types.length, def1.types.length);
    for (let i = 0; i < def1.types.length; i++) {
      assert.strictEqual(def2.types[i].objectKind, def1.types[i].objectKind);
      assert.strictEqual(def2.types[i].objectName, def1.types[i].objectName);
    }
  });

  test('parse → serialize → parse preserves type set (3 types including RecordSet)', () => {
    const def1 = ObjectTypeParser.parse(EVENT_SUBSCRIPTION_SOURCE_XML_3);
    const serialized = ObjectTypeSerializer.serialize(def1);
    const def2 = ObjectTypeParser.parse(serialized);
    assert.deepStrictEqual(def2, def1);
  });

  test('editor save → serialize → re-parse produces same types', () => {
    // Simulate: user opens editor, 2 types selected, saves
    const original = ObjectTypeParser.parse(EVENT_SUBSCRIPTION_SOURCE_XML_2);
    const ids = original.types.map(t => `${t.objectKind}:${t.objectName}`);
    const saved: ObjectTypeDefinition = { types: ids.map((id) => {
      const colonIdx = id.indexOf(':');
      return { objectKind: id.slice(0, colonIdx), objectName: id.slice(colonIdx + 1) } as { objectKind: string; objectName: string };
    }) } as ObjectTypeDefinition;
    const serialized = ObjectTypeSerializer.serialize(saved);
    const reparsed = ObjectTypeParser.parse(serialized);
    assert.deepStrictEqual(reparsed, original);
  });
});

// ─── Scenario 4: Virtual entries (object absent from project) ─────────────────

suite('EventSubscription Source — virtual entries', () => {
  test('unknown catalog not in objectableGroups is preserved as virtual', () => {
    const def = ObjectTypeParser.parse(EVENT_SUBSCRIPTION_SOURCE_XML_VIRTUAL);
    assert.strictEqual(def.types.length, 1);
    assert.strictEqual(def.types[0].objectKind, 'CatalogObject');
    assert.strictEqual(def.types[0].objectName, 'УдалённыйСправочник');

    const groups: ObjectableGroup[] = [
      { objectKind: 'CatalogObject', objectNames: ['Контрагенты'] },
    ];
    // Virtual = in def.types but not in groups
    const groupMap = new Map(groups.map(g => [g.objectKind, new Set(g.objectNames)]));
    const virtual = def.types.filter(t => !groupMap.get(t.objectKind)?.has(t.objectName));
    assert.strictEqual(virtual.length, 1);
    assert.strictEqual(virtual[0].objectName, 'УдалённыйСправочник');
  });

  test('save with virtual id retained — serializes and re-parses correctly', () => {
    const selectedIds = ['CatalogObject:УдалённыйСправочник', 'CatalogObject:Контрагенты'];
    const types = selectedIds.map((id) => {
      const colonIdx = id.indexOf(':');
      return { objectKind: id.slice(0, colonIdx), objectName: id.slice(colonIdx + 1) } as { objectKind: string; objectName: string };
    });
    const def: ObjectTypeDefinition = { types } as ObjectTypeDefinition;
    const serialized = ObjectTypeSerializer.serialize(def);
    const reparsed = ObjectTypeParser.parse(serialized);
    assert.strictEqual(reparsed.types.length, 2);
    const names = reparsed.types.map(t => t.objectName);
    assert.ok(names.includes('УдалённыйСправочник'), 'virtual entry must be preserved');
    assert.ok(names.includes('Контрагенты'));
  });

  test('source with mixed known and unknown objects — all preserved after round-trip', () => {
    const xml = `<Source>
  <v8:Type>cfg:CatalogObject.Контрагенты</v8:Type>
  <v8:Type>cfg:CatalogObject.НесуществующийСправочник</v8:Type>
  <v8:Type>cfg:InformationRegisterRecordSet.УдалённыйРегистр</v8:Type>
</Source>`;
    const def = ObjectTypeParser.parse(xml);
    assert.strictEqual(def.types.length, 3);
    const serialized = ObjectTypeSerializer.serialize(def);
    const reparsed = ObjectTypeParser.parse(serialized);
    assert.deepStrictEqual(reparsed, def);
  });
});
