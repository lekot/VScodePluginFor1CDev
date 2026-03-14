/**
 * Tests for formModelCommands.ts
 *
 * **Validates: Requirements 7.1–7.9, 10.2**
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  applyDragDrop,
  applyAddElement,
  applyDeleteElements,
  applyMoveElementSibling,
  applyPasteElements,
  applyAddElementFromRequisite,
  applyAddAttribute,
  applyDeleteAttribute,
  applyAddCommand,
  applyDeleteCommand,
  applyPropertyChange,
} from '../../src/formEditor/formModelCommands';
import type { FormModel, FormChildItem } from '../../src/formEditor/formModel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<FormModel> = {}): FormModel {
  return {
    childItemsRoot: [],
    attributes: [],
    commands: [],
    formEvents: [],
    ...overrides,
  };
}

function makeItem(id: string, name: string, children: FormChildItem[] = []): FormChildItem {
  return { tag: 'UsualGroup', id, name, properties: {}, childItems: children };
}

function makeLeaf(id: string, name: string): FormChildItem {
  return { tag: 'InputField', id, name, properties: {}, childItems: [] };
}

/** Deep-clone a model via JSON for snapshot comparison. */
function snapshot(model: FormModel): FormModel {
  return JSON.parse(JSON.stringify(model));
}

/** Collect all ids from childItemsRoot recursively. */
function collectAllIds(items: FormChildItem[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: FormChildItem[]) => {
    for (const item of list) {
      if (item.id) ids.add(item.id);
      if (item.childItems?.length) walk(item.childItems);
    }
  };
  walk(items);
  return ids;
}

// ---------------------------------------------------------------------------
// Arbitraries for property tests
// ---------------------------------------------------------------------------

const arbLeaf: fc.Arbitrary<FormChildItem> = fc.record({
  tag: fc.constantFrom('InputField', 'Button'),
  id: fc.nat({ max: 99 }).map((n) => String(n + 1)),
  name: fc.string({ minLength: 1, maxLength: 8 }),
  properties: fc.constant({}),
  childItems: fc.constant([]),
  events: fc.constant(undefined),
});

// Container with up to 3 leaf children
const arbContainer: fc.Arbitrary<FormChildItem> = fc.record({
  tag: fc.constantFrom('UsualGroup', 'Page', 'Group'),
  id: fc.nat({ max: 99 }).map((n) => String(n + 100)),
  name: fc.string({ minLength: 1, maxLength: 8 }),
  properties: fc.constant({}),
  childItems: fc.array(arbLeaf, { minLength: 1, maxLength: 3 }),
  events: fc.constant(undefined),
});

// Model with a container that has children — good for drag-drop tests
const arbModelWithContainer: fc.Arbitrary<{
  model: FormModel;
  containerId: string;
  leafId: string;
}> = fc
  .tuple(
    fc.nat({ max: 99 }).map((n) => String(n + 200)), // containerId
    fc.nat({ max: 99 }).map((n) => String(n + 300))  // leafId
  )
  .map(([containerId, leafId]) => {
    const leaf = makeLeaf(leafId, 'leaf');
    const container = makeItem(containerId, 'container', [leaf]);
    const model = makeModel({ childItemsRoot: [container] });
    return { model, containerId, leafId };
  });

// ---------------------------------------------------------------------------
// Property 4: applyDragDrop rejects descendant target
// **Validates: Requirements 7.3**
// ---------------------------------------------------------------------------

suite('formModelCommands — Property 4: applyDragDrop rejects descendant target', () => {
  test('returns {ok:false} when targetId is a descendant of sourceId', () => {
    fc.assert(
      fc.property(arbModelWithContainer, ({ model, containerId, leafId }) => {
        const before = snapshot(model);
        const result = applyDragDrop(model, containerId, leafId, 0);
        assert.strictEqual(result.ok, false, 'should reject moving into own descendant');
        // Model must not be mutated
        assert.deepStrictEqual(model, before, 'model must not be mutated on failure');
      }),
      { numRuns: 100 }
    );
  });

  test('returns {ok:false} when sourceId === targetId', () => {
    const leaf = makeLeaf('1', 'a');
    const container = makeItem('2', 'c', [leaf]);
    const model = makeModel({ childItemsRoot: [container] });
    const result = applyDragDrop(model, '2', '2', 0);
    assert.strictEqual(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Property 5: applyDragDrop moves element correctly
// **Validates: Requirements 7.4**
// ---------------------------------------------------------------------------

suite('formModelCommands — Property 5: applyDragDrop moves element correctly', () => {
  test('element ends up in target children after successful move', () => {
    // Two sibling containers; move leaf from container1 into container2
    fc.assert(
      fc.property(
        fc.nat({ max: 50 }).map((n) => ({
          c1Id: String(n * 4 + 1),
          c2Id: String(n * 4 + 2),
          leafId: String(n * 4 + 3),
        })),
        ({ c1Id, c2Id, leafId }) => {
          const leaf = makeLeaf(leafId, 'leaf');
          const c1 = makeItem(c1Id, 'c1', [leaf]);
          const c2 = makeItem(c2Id, 'c2', []);
          const model = makeModel({ childItemsRoot: [c1, c2] });

          const result = applyDragDrop(model, leafId, c2Id, 0);
          assert.strictEqual(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);

          // leaf must now be in c2's children
          const c2After = model.childItemsRoot.find((x) => x.id === c2Id)!;
          assert.ok(c2After.childItems.some((x) => x.id === leafId), 'leaf must be in c2 after move');

          // leaf must no longer be in c1's children
          const c1After = model.childItemsRoot.find((x) => x.id === c1Id)!;
          assert.ok(!c1After.childItems.some((x) => x.id === leafId), 'leaf must not remain in c1');
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: applyDeleteElements handles ancestor+descendant
// **Validates: Requirements 7.6**
// ---------------------------------------------------------------------------

suite('formModelCommands — Property 6: applyDeleteElements handles ancestor+descendant', () => {
  test('deletes both ancestor and descendant without error', () => {
    fc.assert(
      fc.property(arbModelWithContainer, ({ model, containerId, leafId }) => {
        // Add a second root container so sole-root guard doesn't trigger
        const extra = makeItem('999', 'extra', []);
        model.childItemsRoot.push(extra);

        const result = applyDeleteElements(model, [containerId, leafId]);
        assert.strictEqual(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);

        // Neither id should remain in the model
        const remaining = collectAllIds(model.childItemsRoot);
        assert.ok(!remaining.has(containerId), 'container must be deleted');
        assert.ok(!remaining.has(leafId), 'leaf must be deleted');
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: applyXxx with invalid params doesn't mutate model
// **Validates: Requirements 7.9**
// ---------------------------------------------------------------------------

suite('formModelCommands — Property 7: invalid params return {ok:false} without mutation', () => {
  test('applyDragDrop with non-existent sourceId returns {ok:false} and no mutation', () => {
    fc.assert(
      fc.property(arbModelWithContainer, ({ model, containerId }) => {
        const before = snapshot(model);
        const result = applyDragDrop(model, 'nonexistent-99999', containerId, 0);
        assert.strictEqual(result.ok, false);
        assert.deepStrictEqual(model, before);
      }),
      { numRuns: 50 }
    );
  });

  test('applyDeleteElements with empty ids returns {ok:false} and no mutation', () => {
    const model = makeModel({ childItemsRoot: [makeLeaf('1', 'a')] });
    const before = snapshot(model);
    const result = applyDeleteElements(model, []);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(model, before);
  });

  test('applyDeleteElements with non-existent id returns {ok:false} and no mutation', () => {
    const model = makeModel({ childItemsRoot: [makeLeaf('1', 'a')] });
    const before = snapshot(model);
    const result = applyDeleteElements(model, ['nonexistent-99999']);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(model, before);
  });

  test('applyMoveElementSibling with invalid direction returns {ok:false}', () => {
    const model = makeModel({ childItemsRoot: [makeLeaf('1', 'a')] });
    const before = snapshot(model);
    // @ts-expect-error intentionally invalid direction
    const result = applyMoveElementSibling(model, '1', 'sideways');
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(model, before);
  });

  test('applyDeleteAttribute with non-existent key returns {ok:false}', () => {
    const model = makeModel();
    const before = snapshot(model);
    const result = applyDeleteAttribute(model, 'nonexistent');
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(model, before);
  });

  test('applyDeleteCommand with non-existent key returns {ok:false}', () => {
    const model = makeModel();
    const before = snapshot(model);
    const result = applyDeleteCommand(model, 'nonexistent');
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(model, before);
  });
});

// ---------------------------------------------------------------------------
// Unit tests 2.5: each applyXxx happy path + edge cases
// **Validates: Requirements 7.2, 7.7, 10.2**
// ---------------------------------------------------------------------------

suite('formModelCommands — unit tests', () => {

  // applyDragDrop
  suite('applyDragDrop', () => {
    test('sourceId === targetId returns {ok:false}', () => {
      const model = makeModel({ childItemsRoot: [makeItem('1', 'c', [makeLeaf('2', 'l')])] });
      const result = applyDragDrop(model, '1', '1', 0);
      assert.strictEqual(result.ok, false);
    });

    test('moves leaf into sibling container', () => {
      const leaf = makeLeaf('3', 'leaf');
      const c1 = makeItem('1', 'c1', [leaf]);
      const c2 = makeItem('2', 'c2', []);
      const model = makeModel({ childItemsRoot: [c1, c2] });
      const result = applyDragDrop(model, '3', '2', 0);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.childItemsRoot[0].childItems.length, 0);
      assert.strictEqual(model.childItemsRoot[1].childItems[0].id, '3');
    });

    test('returns {ok:false} when target is not a container', () => {
      const leaf1 = makeLeaf('1', 'a');
      const leaf2 = makeLeaf('2', 'b');
      const model = makeModel({ childItemsRoot: [leaf1, leaf2] });
      const result = applyDragDrop(model, '1', '2', 0);
      assert.strictEqual(result.ok, false);
    });

    test('returns {ok:false} when source not found', () => {
      const model = makeModel({ childItemsRoot: [makeItem('1', 'c', [])] });
      const result = applyDragDrop(model, 'missing', '1', 0);
      assert.strictEqual(result.ok, false);
    });
  });

  // applyAddElement
  suite('applyAddElement', () => {
    test('adds element to root when parentId is undefined', () => {
      const model = makeModel();
      const result = applyAddElement(model, undefined, 'InputField', 'NewItem');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.childItemsRoot.length, 1);
      assert.strictEqual(model.childItemsRoot[0].tag, 'InputField');
      assert.strictEqual(model.childItemsRoot[0].name, 'NewItem');
    });

    test('adds element inside container', () => {
      const container = makeItem('1', 'c', []);
      const model = makeModel({ childItemsRoot: [container] });
      const result = applyAddElement(model, '1', 'Button', 'Btn', 0);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.childItemsRoot[0].childItems.length, 1);
      assert.strictEqual(model.childItemsRoot[0].childItems[0].tag, 'Button');
    });

    test('returns {ok:false} when parent is not a container', () => {
      const leaf = makeLeaf('1', 'a');
      const model = makeModel({ childItemsRoot: [leaf] });
      const result = applyAddElement(model, '1', 'Button', 'Btn');
      assert.strictEqual(result.ok, false);
    });

    test('inserts at specified index', () => {
      const existing = makeLeaf('2', 'existing');
      const container = makeItem('1', 'c', [existing]);
      const model = makeModel({ childItemsRoot: [container] });
      applyAddElement(model, '1', 'Button', 'First', 0);
      assert.strictEqual(model.childItemsRoot[0].childItems[0].name, 'First');
      assert.strictEqual(model.childItemsRoot[0].childItems[1].id, '2');
    });
  });

  // applyDeleteElements
  suite('applyDeleteElements', () => {
    test('deletes a single element', () => {
      const leaf = makeLeaf('2', 'leaf');
      const container = makeItem('1', 'c', [leaf]);
      const model = makeModel({ childItemsRoot: [container] });
      const result = applyDeleteElements(model, ['2']);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.childItemsRoot[0].childItems.length, 0);
    });

    test('does not delete sole root element — returns {ok:false}', () => {
      const root = makeItem('1', 'root', []);
      const model = makeModel({ childItemsRoot: [root] });
      const result = applyDeleteElements(model, ['1']);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(model.childItemsRoot.length, 1, 'root must remain');
    });

    test('deletes multiple elements in descendant-first order', () => {
      const leaf = makeLeaf('3', 'leaf');
      const mid = makeItem('2', 'mid', [leaf]);
      const root = makeItem('1', 'root', [mid]);
      const extra = makeItem('4', 'extra', []);
      const model = makeModel({ childItemsRoot: [root, extra] });
      const result = applyDeleteElements(model, ['1', '2', '3']);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.childItemsRoot.length, 1);
      assert.strictEqual(model.childItemsRoot[0].id, '4');
    });
  });

  // applyMoveElementSibling
  suite('applyMoveElementSibling', () => {
    test('moves element up', () => {
      const a = makeLeaf('1', 'a');
      const b = makeLeaf('2', 'b');
      const model = makeModel({ childItemsRoot: [a, b] });
      const result = applyMoveElementSibling(model, '2', 'up');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.childItemsRoot[0].id, '2');
      assert.strictEqual(model.childItemsRoot[1].id, '1');
    });

    test('moves element down', () => {
      const a = makeLeaf('1', 'a');
      const b = makeLeaf('2', 'b');
      const model = makeModel({ childItemsRoot: [a, b] });
      const result = applyMoveElementSibling(model, '1', 'down');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.childItemsRoot[0].id, '2');
    });

    test('returns {ok:false} when already at top', () => {
      const model = makeModel({ childItemsRoot: [makeLeaf('1', 'a'), makeLeaf('2', 'b')] });
      const result = applyMoveElementSibling(model, '1', 'up');
      assert.strictEqual(result.ok, false);
    });

    test('returns {ok:false} for invalid direction', () => {
      const model = makeModel({ childItemsRoot: [makeLeaf('1', 'a')] });
      // @ts-expect-error intentionally invalid
      const result = applyMoveElementSibling(model, '1', 'left');
      assert.strictEqual(result.ok, false);
    });
  });

  // applyPasteElements
  suite('applyPasteElements', () => {
    test('pastes cloned item into target', () => {
      const container = makeItem('1', 'c', []);
      const model = makeModel({ childItemsRoot: [container] });
      const clipboard = makeLeaf('99', 'copied');
      const result = applyPasteElements(model, '1', [clipboard]);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.childItemsRoot[0].childItems.length, 1);
      // id must be reassigned (not 99)
      assert.notStrictEqual(model.childItemsRoot[0].childItems[0].id, '99');
      assert.strictEqual(model.childItemsRoot[0].childItems[0].name, 'copied');
    });

    test('returns {ok:false} when target is not a container', () => {
      const leaf = makeLeaf('1', 'a');
      const model = makeModel({ childItemsRoot: [leaf] });
      const result = applyPasteElements(model, '1', [makeLeaf('2', 'b')]);
      assert.strictEqual(result.ok, false);
    });

    test('returns {ok:false} when clipboard is empty', () => {
      const container = makeItem('1', 'c', []);
      const model = makeModel({ childItemsRoot: [container] });
      const result = applyPasteElements(model, '1', []);
      assert.strictEqual(result.ok, false);
    });
  });

  // applyAddElementFromRequisite
  suite('applyAddElementFromRequisite', () => {
    test('adds InputField for string attribute', () => {
      const container = makeItem('1', 'c', []);
      const model = makeModel({
        childItemsRoot: [container],
        attributes: [{ name: 'MyAttr', id: '1', properties: { Type: 'xs:string' } }],
      });
      const result = applyAddElementFromRequisite(model, 'MyAttr', 'MyAttr', '1', 0);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.childItemsRoot[0].childItems[0].tag, 'InputField');
      assert.strictEqual(model.childItemsRoot[0].childItems[0].name, 'MyAttr');
    });

    test('adds CheckBoxField for boolean attribute', () => {
      const container = makeItem('1', 'c', []);
      const model = makeModel({
        childItemsRoot: [container],
        attributes: [{ name: 'Flag', id: '1', properties: { Type: 'xs:boolean' } }],
      });
      const result = applyAddElementFromRequisite(model, 'Flag', 'Flag', '1', 0);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.childItemsRoot[0].childItems[0].tag, 'CheckBoxField');
    });

    test('returns {ok:false} when target is not a container', () => {
      const leaf = makeLeaf('1', 'a');
      const model = makeModel({ childItemsRoot: [leaf] });
      const result = applyAddElementFromRequisite(model, 'Attr', 'Attr', '1', 0);
      assert.strictEqual(result.ok, false);
    });
  });

  // applyAddAttribute
  suite('applyAddAttribute', () => {
    test('adds a new attribute with default name', () => {
      const model = makeModel();
      const result = applyAddAttribute(model);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.attributes.length, 1);
      assert.strictEqual(model.attributes[0].name, 'NewAttribute');
      assert.strictEqual(model.attributes[0].properties['Type'], 'xs:string');
    });

    test('assigns unique id', () => {
      const model = makeModel({ attributes: [{ name: 'Existing', id: '5', properties: {} }] });
      applyAddAttribute(model);
      assert.strictEqual(model.attributes[1].id, '6');
    });
  });

  // applyDeleteAttribute
  suite('applyDeleteAttribute', () => {
    test('deletes attribute by name', () => {
      const model = makeModel({ attributes: [{ name: 'MyAttr', id: '1', properties: {} }] });
      const result = applyDeleteAttribute(model, 'MyAttr');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.attributes.length, 0);
    });

    test('deletes attribute by id', () => {
      const model = makeModel({ attributes: [{ name: 'MyAttr', id: '42', properties: {} }] });
      const result = applyDeleteAttribute(model, '42');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.attributes.length, 0);
    });

    test('returns {ok:false} when not found', () => {
      const model = makeModel();
      const result = applyDeleteAttribute(model, 'ghost');
      assert.strictEqual(result.ok, false);
    });
  });

  // applyAddCommand
  suite('applyAddCommand', () => {
    test('adds a new command with default name', () => {
      const model = makeModel();
      const result = applyAddCommand(model);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.commands.length, 1);
      assert.strictEqual(model.commands[0].name, 'NewCommand');
    });

    test('assigns unique id', () => {
      const model = makeModel({ commands: [{ name: 'Cmd', id: '3', properties: {} }] });
      applyAddCommand(model);
      assert.strictEqual(model.commands[1].id, '4');
    });
  });

  // applyDeleteCommand
  suite('applyDeleteCommand', () => {
    test('deletes command by name', () => {
      const model = makeModel({ commands: [{ name: 'MyCmd', id: '1', properties: {} }] });
      const result = applyDeleteCommand(model, 'MyCmd');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.commands.length, 0);
    });

    test('deletes command by id', () => {
      const model = makeModel({ commands: [{ name: 'MyCmd', id: '7', properties: {} }] });
      const result = applyDeleteCommand(model, '7');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(model.commands.length, 0);
    });

    test('returns {ok:false} when not found', () => {
      const model = makeModel();
      const result = applyDeleteCommand(model, 'ghost');
      assert.strictEqual(result.ok, false);
    });
  });

  // applyPropertyChange
  suite('applyPropertyChange', () => {
    test('updates element property', () => {
      const leaf = makeLeaf('1', 'a');
      const model = makeModel({ childItemsRoot: [leaf] });
      applyPropertyChange(model, { elementId: '1', key: 'Title', value: 'Hello' });
      assert.strictEqual(model.childItemsRoot[0].properties['Title'], 'Hello');
    });

    test('updates element name via key=name', () => {
      const leaf = makeLeaf('1', 'a');
      const model = makeModel({ childItemsRoot: [leaf] });
      applyPropertyChange(model, { elementId: '1', key: 'name', value: 'renamed' });
      assert.strictEqual(model.childItemsRoot[0].name, 'renamed');
    });

    test('updates attribute property via section=attributes', () => {
      const model = makeModel({ attributes: [{ name: 'Attr', id: '1', properties: {} }] });
      applyPropertyChange(model, { elementId: 'Attr', section: 'attributes', key: 'Type', value: 'xs:boolean' });
      assert.strictEqual(model.attributes[0].properties['Type'], 'xs:boolean');
    });

    test('updates command property via section=commands', () => {
      const model = makeModel({ commands: [{ name: 'Cmd', id: '1', properties: {} }] });
      applyPropertyChange(model, { elementId: 'Cmd', section: 'commands', key: 'Action', value: 'DoSomething' });
      assert.strictEqual(model.commands[0].properties['Action'], 'DoSomething');
    });
  });
});
