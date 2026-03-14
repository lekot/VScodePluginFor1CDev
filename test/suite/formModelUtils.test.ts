/**
 * Tests for formModelUtils.ts
 *
 * **Validates: Requirements 8.2, 8.4, 8.6, 10.1**
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  generateNextId,
  generateNextAttributeId,
  generateNextCommandId,
  cloneWithNewIds,
  orderIdsForDeletion,
  getAttributeTypeString,
  requisiteTypeToTag,
  createIdGenerator,
} from '../../src/formEditor/formModelUtils';
import type { FormModel, FormChildItem, FormAttribute } from '../../src/formEditor/formModel';

// ---------------------------------------------------------------------------
// Helpers / Arbitraries
// ---------------------------------------------------------------------------

/** Build a minimal valid FormModel. */
function makeModel(overrides: Partial<FormModel> = {}): FormModel {
  return {
    childItemsRoot: [],
    attributes: [],
    commands: [],
    formEvents: [],
    ...overrides,
  };
}

/** Build a leaf FormChildItem. */
function makeItem(id: string, name: string, children: FormChildItem[] = []): FormChildItem {
  return { tag: 'InputField', id, name, properties: {}, childItems: children };
}

/** Collect all ids from a FormChildItem tree. */
function collectAllIds(item: FormChildItem): Set<string> {
  const ids = new Set<string>();
  const walk = (node: FormChildItem) => {
    if (node.id) ids.add(node.id);
    for (const child of node.childItems ?? []) walk(child);
  };
  walk(item);
  return ids;
}

/** Collect all ids from childItemsRoot. */
function collectModelIds(model: FormModel): Set<string> {
  const ids = new Set<string>();
  const walk = (items: FormChildItem[]) => {
    for (const item of items) {
      if (item.id) ids.add(item.id);
      if (item.childItems?.length) walk(item.childItems);
    }
  };
  walk(model.childItemsRoot);
  return ids;
}

// Build a flat FormChildItem (no children) for use in arbitraries
const arbLeafItem: fc.Arbitrary<FormChildItem> = fc.record({
  tag: fc.constantFrom('InputField', 'UsualGroup', 'Button'),
  id: fc.option(fc.nat({ max: 999 }).map(String), { nil: undefined }),
  name: fc.string({ minLength: 1, maxLength: 10 }),
  properties: fc.constant({}),
  childItems: fc.constant([]),
  events: fc.constant(undefined),
});

// A shallow tree: root with up to 3 leaf children (max depth 2, avoids stack overflow)
const arbItem: fc.Arbitrary<FormChildItem> = fc.record({
  tag: fc.constantFrom('InputField', 'UsualGroup', 'Button'),
  id: fc.option(fc.nat({ max: 999 }).map(String), { nil: undefined }),
  name: fc.string({ minLength: 1, maxLength: 10 }),
  properties: fc.constant({}),
  childItems: fc.array(arbLeafItem, { maxLength: 3 }),
  events: fc.constant(undefined),
});

const arbModel: fc.Arbitrary<FormModel> = fc.record({
  childItemsRoot: fc.array(arbItem, { maxLength: 5 }),
  attributes: fc.array(
    fc.record({
      name: fc.string({ minLength: 1, maxLength: 10 }),
      id: fc.option(fc.nat({ max: 99 }).map(String), { nil: undefined }),
      properties: fc.constant({}),
    }),
    { maxLength: 5 }
  ),
  commands: fc.array(
    fc.record({
      name: fc.string({ minLength: 1, maxLength: 10 }),
      id: fc.option(fc.nat({ max: 99 }).map(String), { nil: undefined }),
      properties: fc.constant({}),
    }),
    { maxLength: 5 }
  ),
  formEvents: fc.constant([]),
});

// ---------------------------------------------------------------------------
// Property 8: generateNextId returns a unique ID
// **Validates: Requirements 8.2**
// ---------------------------------------------------------------------------

suite('formModelUtils — Property 8: generateNextId returns unique ID', () => {
  test('generateNextId result is not present in existing model IDs', () => {
    fc.assert(
      fc.property(arbModel, (model) => {
        const existingIds = collectModelIds(model);
        const newId = generateNextId(model);
        assert.ok(
          !existingIds.has(newId),
          `generateNextId returned "${newId}" which already exists in model IDs: [${[...existingIds].join(', ')}]`
        );
      }),
      { numRuns: 200 }
    );
  });

  test('generateNextId on empty model returns "1"', () => {
    const model = makeModel();
    assert.strictEqual(generateNextId(model), '1');
  });

  test('generateNextId returns max+1 for sequential ids', () => {
    const model = makeModel({
      childItemsRoot: [makeItem('3', 'a'), makeItem('7', 'b')],
    });
    assert.strictEqual(generateNextId(model), '8');
  });
});

// ---------------------------------------------------------------------------
// Property 9: cloneWithNewIds contains no IDs from the original
// **Validates: Requirements 8.4**
// ---------------------------------------------------------------------------

suite('formModelUtils — Property 9: cloneWithNewIds contains no original IDs', () => {
  test('cloned item has no IDs from the original', () => {
    fc.assert(
      fc.property(arbItem, (item) => {
        const originalIds = collectAllIds(item);
        if (originalIds.size === 0) return; // nothing to check

        let counter = 1000; // start well above any original id
        const nextId = () => String(counter++);
        const cloned = cloneWithNewIds(item, nextId);
        const clonedIds = collectAllIds(cloned);

        for (const id of clonedIds) {
          assert.ok(
            !originalIds.has(id),
            `cloneWithNewIds produced id "${id}" that exists in the original`
          );
        }
      }),
      { numRuns: 200 }
    );
  });

  test('cloneWithNewIds preserves structure (tag, name, childItems length)', () => {
    const child = makeItem('2', 'child');
    const parent = makeItem('1', 'parent', [child]);
    let n = 100;
    const cloned = cloneWithNewIds(parent, () => String(n++));
    assert.strictEqual(cloned.tag, parent.tag);
    assert.strictEqual(cloned.name, parent.name);
    assert.strictEqual(cloned.childItems.length, 1);
    assert.strictEqual(cloned.childItems[0].name, child.name);
  });

  test('cloneWithNewIds deep-copies properties (no shared reference)', () => {
    const item = makeItem('1', 'x');
    item.properties = { Title: 'hello' };
    let n = 50;
    const cloned = cloneWithNewIds(item, () => String(n++));
    cloned.properties['Title'] = 'changed';
    assert.strictEqual(item.properties['Title'], 'hello');
  });
});

// ---------------------------------------------------------------------------
// Property 10: orderIdsForDeletion — descendants before ancestors
// **Validates: Requirements 8.6**
// ---------------------------------------------------------------------------

suite('formModelUtils — Property 10: orderIdsForDeletion descendants before ancestors', () => {
  test('descendant appears before ancestor in result', () => {
    // parent id=1, child id=2
    const child = makeItem('2', 'child');
    const parent = makeItem('1', 'parent', [child]);
    const model = makeModel({ childItemsRoot: [parent] });

    const ordered = orderIdsForDeletion(model, ['1', '2']);
    const idxParent = ordered.indexOf('1');
    const idxChild = ordered.indexOf('2');
    assert.ok(idxChild < idxParent, 'child (id=2) must come before parent (id=1)');
  });

  test('property: for any ancestor-descendant pair in ids, descendant comes first', () => {
    // Build a 3-level tree: root(1) → mid(2) → leaf(3)
    const leaf = makeItem('3', 'leaf');
    const mid = makeItem('2', 'mid', [leaf]);
    const root = makeItem('1', 'root', [mid]);
    const model = makeModel({ childItemsRoot: [root] });

    fc.assert(
      fc.property(
        fc.subarray(['1', '2', '3'], { minLength: 2 }),
        (ids) => {
          if (ids.length < 2) return;
          const ordered = orderIdsForDeletion(model, ids);
          // For each pair where one is ancestor of the other, descendant must come first
          const pairs: Array<[string, string]> = [['1', '2'], ['1', '3'], ['2', '3']];
          for (const [ancestor, descendant] of pairs) {
            if (ordered.includes(ancestor) && ordered.includes(descendant)) {
              const idxA = ordered.indexOf(ancestor);
              const idxD = ordered.indexOf(descendant);
              assert.ok(
                idxD < idxA,
                `descendant "${descendant}" (idx ${idxD}) must come before ancestor "${ancestor}" (idx ${idxA})`
              );
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  test('orderIdsForDeletion with flat siblings preserves all ids', () => {
    const model = makeModel({
      childItemsRoot: [makeItem('1', 'a'), makeItem('2', 'b'), makeItem('3', 'c')],
    });
    const ordered = orderIdsForDeletion(model, ['1', '2', '3']);
    assert.strictEqual(ordered.length, 3);
    assert.ok(ordered.includes('1'));
    assert.ok(ordered.includes('2'));
    assert.ok(ordered.includes('3'));
  });
});

// ---------------------------------------------------------------------------
// Unit tests 1.4: requisiteTypeToTag, getAttributeTypeString,
//                 generateNextAttributeId, generateNextCommandId
// **Validates: Requirements 10.1**
// ---------------------------------------------------------------------------

suite('formModelUtils — unit tests', () => {

  // getAttributeTypeString
  suite('getAttributeTypeString', () => {
    test('returns empty string for missing properties', () => {
      const attr: FormAttribute = { name: 'x', properties: {} };
      assert.strictEqual(getAttributeTypeString(attr), '');
    });

    test('returns Type string value', () => {
      const attr: FormAttribute = { name: 'x', properties: { Type: 'xs:boolean' } };
      assert.strictEqual(getAttributeTypeString(attr), 'xs:boolean');
    });

    test('returns Type from #text node', () => {
      const attr: FormAttribute = { name: 'x', properties: { Type: { '#text': 'xs:string' } } };
      assert.strictEqual(getAttributeTypeString(attr), 'xs:string');
    });

    test('returns Type from namespaced key (v8:Type)', () => {
      const attr: FormAttribute = { name: 'x', properties: { 'v8:Type': 'xs:decimal' } };
      assert.strictEqual(getAttributeTypeString(attr), 'xs:decimal');
    });

    test('trims whitespace', () => {
      const attr: FormAttribute = { name: 'x', properties: { Type: '  xs:boolean  ' } };
      assert.strictEqual(getAttributeTypeString(attr), 'xs:boolean');
    });
  });

  // requisiteTypeToTag
  suite('requisiteTypeToTag', () => {
    test('returns InputField for undefined', () => {
      assert.strictEqual(requisiteTypeToTag(undefined), 'InputField');
    });

    test('returns CheckBoxField for xs:boolean', () => {
      const attr: FormAttribute = { name: 'x', properties: { Type: 'xs:boolean' } };
      assert.strictEqual(requisiteTypeToTag(attr), 'CheckBoxField');
    });

    test('returns CheckBoxField for boolean (case-insensitive)', () => {
      const attr: FormAttribute = { name: 'x', properties: { Type: 'Boolean' } };
      assert.strictEqual(requisiteTypeToTag(attr), 'CheckBoxField');
    });

    test('returns InputField for string type', () => {
      const attr: FormAttribute = { name: 'x', properties: { Type: 'xs:string' } };
      assert.strictEqual(requisiteTypeToTag(attr), 'InputField');
    });

    test('returns InputField for empty type', () => {
      const attr: FormAttribute = { name: 'x', properties: {} };
      assert.strictEqual(requisiteTypeToTag(attr), 'InputField');
    });
  });

  // generateNextAttributeId
  suite('generateNextAttributeId', () => {
    test('returns "1" for model with no attributes', () => {
      assert.strictEqual(generateNextAttributeId(makeModel()), '1');
    });

    test('returns max+1', () => {
      const model = makeModel({
        attributes: [
          { name: 'a', id: '3', properties: {} },
          { name: 'b', id: '7', properties: {} },
        ],
      });
      assert.strictEqual(generateNextAttributeId(model), '8');
    });

    test('ignores attributes without id', () => {
      const model = makeModel({
        attributes: [{ name: 'a', properties: {} }],
      });
      assert.strictEqual(generateNextAttributeId(model), '1');
    });
  });

  // generateNextCommandId
  suite('generateNextCommandId', () => {
    test('returns "1" for model with no commands', () => {
      assert.strictEqual(generateNextCommandId(makeModel()), '1');
    });

    test('returns max+1', () => {
      const model = makeModel({
        commands: [
          { name: 'c1', id: '5', properties: {} },
          { name: 'c2', id: '2', properties: {} },
        ],
      });
      assert.strictEqual(generateNextCommandId(model), '6');
    });
  });

  // createIdGenerator
  suite('createIdGenerator', () => {
    test('generates sequential ids starting from max+1', () => {
      const model = makeModel({
        childItemsRoot: [makeItem('4', 'x')],
      });
      const gen = createIdGenerator(model);
      assert.strictEqual(gen(), '5');
      assert.strictEqual(gen(), '6');
      assert.strictEqual(gen(), '7');
    });

    test('starts from 1 on empty model', () => {
      const gen = createIdGenerator(makeModel());
      assert.strictEqual(gen(), '1');
    });
  });
});
