import * as assert from 'assert';
import { TypeFormatter } from '../../src/utils/typeFormatter';
import { createDefaultFilterState } from '../../src/rolesEditor/models/filterState';

suite('TypeFormatter and FilterState', () => {
  suite('TypeFormatter.formatTypeDisplay', () => {
    test('returns "Not set" for empty or invalid definitions', () => {
      assert.strictEqual(TypeFormatter.formatTypeDisplay(undefined as any), 'Not set');
      assert.strictEqual(TypeFormatter.formatTypeDisplay({ types: [] } as any), 'Not set');
    });

    test('formats all supported type entries and unknown fallback', () => {
      const result = TypeFormatter.formatTypeDisplay({
        category: 'composite',
        types: [
          { kind: 'string', qualifiers: { length: 10, allowedLength: 'Variable' } },
          { kind: 'number', qualifiers: { digits: 12, fractionDigits: 3, allowedSign: 'Any' } },
          { kind: 'boolean' },
          { kind: 'date', qualifiers: { dateFractions: 'DateTime' } },
          { kind: 'reference', referenceType: { referenceKind: 'CatalogRef', objectName: 'Products' } },
          { kind: 'custom-unknown' as any },
        ],
      } as any);

      assert.strictEqual(
        result,
        'String(10) | Number(12,3) | Boolean | DateTime | CatalogRef.Products | Unknown'
      );
    });

    test('uses default strings when qualifiers/reference are absent', () => {
      const result = TypeFormatter.formatTypeDisplay({
        category: 'composite',
        types: [
          { kind: 'string' },
          { kind: 'number' },
          { kind: 'date' },
          { kind: 'reference' },
        ],
      } as any);

      assert.strictEqual(result, 'String | Number | Date | Reference');
    });
  });

  suite('createDefaultFilterState', () => {
    test('returns contract defaults for roles filter', () => {
      const state = createDefaultFilterState();
      assert.deepStrictEqual(state, {
        showAll: false,
        searchQuery: '',
        typeFilter: [],
      });
    });

    test('returns a new independent state object per call', () => {
      const first = createDefaultFilterState();
      const second = createDefaultFilterState();

      first.typeFilter.push('Catalog' as any);

      assert.notStrictEqual(first, second);
      assert.strictEqual(second.typeFilter.length, 0);
    });
  });
});
