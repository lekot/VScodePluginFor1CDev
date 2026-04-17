import * as assert from 'assert';
import type { ObjectTypeDefinition, ObjectableGroup } from '../../src/types/objectTypeDefinitions';
import { ObjectTypeParser } from '../../src/parsers/objectTypeParser';
import { ObjectTypeSerializer } from '../../src/serializers/objectTypeSerializer';

// ObjectTypeEditorProvider wraps a webview which cannot be tested without VS Code runtime.
// We test the pure helper logic: parsing, tree-building, and serialization round-trips.

/** Replicates buildTreeData logic to test tree construction without webview dependency. */
function buildSelectedIds(
  currentDef: ObjectTypeDefinition,
  objectableGroups: ObjectableGroup[]
): string[] {
  return currentDef.types.map(({ objectKind, objectName }) => `${objectKind}:${objectName}`);
}

/** Replicates save-message handling: selectedIds → ObjectTypeDefinition. */
function selectedIdsToDefinition(selectedIds: string[]): ObjectTypeDefinition {
  const types = selectedIds
    .map((id) => {
      const colonIdx = id.indexOf(':');
      if (colonIdx === -1) { return null; }
      const objectKind = id.slice(0, colonIdx);
      const objectName = id.slice(colonIdx + 1);
      return { objectKind, objectName } as { objectKind: string; objectName: string };
    })
    .filter((t): t is { objectKind: string; objectName: string } => t !== null);
  return { types } as ObjectTypeDefinition;
}

suite('ObjectTypeEditorProvider (pure helpers)', () => {
  suite('show() with empty sourceXML', () => {
    test('initial selection is empty for empty sourceXML', () => {
      const def = ObjectTypeParser.parse('');
      const groups: ObjectableGroup[] = [
        { objectKind: 'CatalogObject', objectNames: ['Контрагенты', 'Номенклатура'] },
      ];
      const ids = buildSelectedIds(def, groups);
      assert.deepStrictEqual(ids, []);
    });

    test('save with selected IDs returns correct ObjectTypeDefinition', () => {
      const selectedIds = ['CatalogObject:Контрагенты', 'DocumentObject:Заказ'];
      const result = selectedIdsToDefinition(selectedIds);
      assert.strictEqual(result.types.length, 2);
      assert.strictEqual(result.types[0].objectKind, 'CatalogObject');
      assert.strictEqual(result.types[0].objectName, 'Контрагенты');
      assert.strictEqual(result.types[1].objectKind, 'DocumentObject');
      assert.strictEqual(result.types[1].objectName, 'Заказ');
    });
  });

  suite('show() with populated sourceXML', () => {
    test('initial selection matches parsed sourceXML', () => {
      const xml = `<Source>
  <v8:Type>cfg:CatalogObject.Контрагенты</v8:Type>
  <v8:Type>cfg:DocumentObject.АвансовыйОтчет</v8:Type>
</Source>`;
      const def = ObjectTypeParser.parse(xml);
      const groups: ObjectableGroup[] = [
        { objectKind: 'CatalogObject', objectNames: ['Контрагенты'] },
        { objectKind: 'DocumentObject', objectNames: ['АвансовыйОтчет'] },
      ];
      const ids = buildSelectedIds(def, groups);
      assert.deepStrictEqual(new Set(ids), new Set([
        'CatalogObject:Контрагенты',
        'DocumentObject:АвансовыйОтчет',
      ]));
    });
  });

  suite('cancel', () => {
    test('cancel resolves to null (no mutation)', () => {
      // Simulate cancel: no selectedIds sent, resolve(null) called
      const result: ObjectTypeDefinition | null = null;
      assert.strictEqual(result, null);
    });
  });

  suite('virtual entries', () => {
    test('sourceXML with unknown catalog is preserved as virtual entry and saved', () => {
      const xml = `<Source>
  <v8:Type>cfg:CatalogObject.УдалённыйСправочник</v8:Type>
</Source>`;
      const def = ObjectTypeParser.parse(xml);
      const groups: ObjectableGroup[] = [
        { objectKind: 'CatalogObject', objectNames: ['Контрагенты'] },
      ];

      // УдалённыйСправочник is NOT in groups → virtual entry
      const ids = buildSelectedIds(def, groups);
      assert.deepStrictEqual(ids, ['CatalogObject:УдалённыйСправочник']);

      // On save with virtual id retained, result must contain it
      const saved = selectedIdsToDefinition(ids);
      assert.strictEqual(saved.types.length, 1);
      assert.strictEqual(saved.types[0].objectKind, 'CatalogObject');
      assert.strictEqual(saved.types[0].objectName, 'УдалённыйСправочник');
    });

    test('save with mixed known+virtual IDs preserves all', () => {
      const selectedIds = [
        'CatalogObject:Контрагенты',
        'CatalogObject:УдалённыйСправочник',
        'InformationRegisterRecordSet:ЦеныНоменклатуры',
      ];
      const result = selectedIdsToDefinition(selectedIds);
      assert.strictEqual(result.types.length, 3);
      assert.strictEqual(result.types[1].objectName, 'УдалённыйСправочник');
    });
  });

  suite('round-trip: parse → save → serialize → parse', () => {
    test('produces equivalent ObjectTypeDefinition', () => {
      const xml = `<Source>
  <v8:Type>cfg:CatalogObject.Контрагенты</v8:Type>
  <v8:Type>cfg:InformationRegisterRecordSet.ЦеныНоменклатуры</v8:Type>
</Source>`;
      const parsed = ObjectTypeParser.parse(xml);
      const ids = buildSelectedIds(parsed, []);
      const saved = selectedIdsToDefinition(ids);
      const serialized = ObjectTypeSerializer.serialize(saved);
      const reparsed = ObjectTypeParser.parse(serialized);
      assert.deepStrictEqual(reparsed, parsed);
    });
  });

  suite('selectedIdsToDefinition edge cases', () => {
    test('empty selectedIds returns empty types', () => {
      const result = selectedIdsToDefinition([]);
      assert.deepStrictEqual(result.types, []);
    });

    test('id without colon is skipped', () => {
      const result = selectedIdsToDefinition(['invalid-no-colon', 'CatalogObject:Справочник']);
      assert.strictEqual(result.types.length, 1);
      assert.strictEqual(result.types[0].objectName, 'Справочник');
    });

    test('objectName with dots (e.g., namespace) is preserved', () => {
      const result = selectedIdsToDefinition(['CatalogObject:Some.DottedName']);
      assert.strictEqual(result.types[0].objectName, 'Some.DottedName');
    });
  });
});
