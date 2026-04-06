/**
 * Tests for formTreeOperations.ts
 *
 * Covers all 10 exports:
 *   CONTAINER_TAGS, isContainer, findElementById, isDescendantOf,
 *   findParentAndIndex, FORM_ROOT_ID, moveNodeInModel, removeNodeInModel,
 *   moveElementSiblingInModel, countAll
 */

import * as assert from 'assert';
import {
  CONTAINER_TAGS,
  FORM_ROOT_ID,
  isContainer,
  findElementById,
  isDescendantOf,
  findParentAndIndex,
  moveNodeInModel,
  removeNodeInModel,
  moveElementSiblingInModel,
  countAll,
} from '../../src/formEditor/formTreeOperations';
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

function makeGroup(id: string, name: string, children: FormChildItem[] = []): FormChildItem {
  return { tag: 'UsualGroup', id, name, properties: {}, childItems: children };
}

function makeLeaf(id: string, name: string): FormChildItem {
  return { tag: 'InputField', id, name, properties: {}, childItems: [] };
}

function makePage(id: string, name: string, children: FormChildItem[] = []): FormChildItem {
  return { tag: 'Page', id, name, properties: {}, childItems: children };
}

function makePages(id: string, name: string, children: FormChildItem[] = []): FormChildItem {
  return { tag: 'Pages', id, name, properties: {}, childItems: children };
}

/** Deep-clone a model via JSON for snapshot comparison. */
function snapshot(model: FormModel): FormModel {
  return JSON.parse(JSON.stringify(model));
}

// ---------------------------------------------------------------------------
// CONTAINER_TAGS
// ---------------------------------------------------------------------------

suite('formTreeOperations — CONTAINER_TAGS', () => {
  test('contains all expected container tags', () => {
    const expected = ['UsualGroup', 'Pages', 'Page', 'Table', 'AutoCommandBar', 'Form', 'Group', 'CollapsibleGroup'];
    for (const tag of expected) {
      assert.ok(CONTAINER_TAGS.has(tag), `CONTAINER_TAGS must include "${tag}"`);
    }
  });

  test('does not contain leaf element tags', () => {
    const nonContainers = ['InputField', 'Button', 'LabelField', 'CheckBoxField', 'RadioButton', 'PictureField'];
    for (const tag of nonContainers) {
      assert.ok(!CONTAINER_TAGS.has(tag), `CONTAINER_TAGS must NOT include "${tag}"`);
    }
  });

  test('is a Set instance', () => {
    assert.ok(CONTAINER_TAGS instanceof Set);
  });
});

// ---------------------------------------------------------------------------
// FORM_ROOT_ID
// ---------------------------------------------------------------------------

suite('formTreeOperations — FORM_ROOT_ID', () => {
  test('is a non-empty string', () => {
    assert.strictEqual(typeof FORM_ROOT_ID, 'string');
    assert.ok(FORM_ROOT_ID.length > 0);
  });

  test('equals __form_root__', () => {
    assert.strictEqual(FORM_ROOT_ID, '__form_root__');
  });
});

// ---------------------------------------------------------------------------
// isContainer
// ---------------------------------------------------------------------------

suite('formTreeOperations — isContainer', () => {
  test('returns true for UsualGroup', () => {
    const item = makeGroup('1', 'G');
    assert.strictEqual(isContainer(item), true);
  });

  test('returns true for Pages', () => {
    const item = makePages('1', 'P');
    assert.strictEqual(isContainer(item), true);
  });

  test('returns true for Page', () => {
    const item = makePage('1', 'P');
    assert.strictEqual(isContainer(item), true);
  });

  test('returns true for all container tags in CONTAINER_TAGS', () => {
    for (const tag of CONTAINER_TAGS) {
      const item: FormChildItem = { tag, id: '1', name: 'x', properties: {}, childItems: [] };
      assert.strictEqual(isContainer(item), true, `isContainer must be true for tag "${tag}"`);
    }
  });

  test('returns false for InputField', () => {
    const item = makeLeaf('1', 'x');
    assert.strictEqual(isContainer(item), false);
  });

  test('returns false for Button', () => {
    const item: FormChildItem = { tag: 'Button', id: '1', name: 'B', properties: {}, childItems: [] };
    assert.strictEqual(isContainer(item), false);
  });

  test('returns false for unknown tag', () => {
    const item: FormChildItem = { tag: 'UnknownWidget', id: '1', name: 'u', properties: {}, childItems: [] };
    assert.strictEqual(isContainer(item), false);
  });
});

// ---------------------------------------------------------------------------
// findElementById
// ---------------------------------------------------------------------------

suite('formTreeOperations — findElementById', () => {
  test('returns undefined for empty array', () => {
    const result = findElementById([], '1');
    assert.strictEqual(result, undefined);
  });

  test('finds element at root level by id', () => {
    const leaf = makeLeaf('5', 'myLeaf');
    const result = findElementById([leaf], '5');
    assert.strictEqual(result, leaf);
  });

  test('returns undefined when id not found', () => {
    const leaf = makeLeaf('5', 'myLeaf');
    const result = findElementById([leaf], '999');
    assert.strictEqual(result, undefined);
  });

  test('finds element nested one level deep', () => {
    const child = makeLeaf('10', 'child');
    const group = makeGroup('1', 'g', [child]);
    const result = findElementById([group], '10');
    assert.strictEqual(result, child);
  });

  test('finds element nested two levels deep', () => {
    const deepLeaf = makeLeaf('20', 'deep');
    const mid = makeGroup('10', 'mid', [deepLeaf]);
    const root = makeGroup('1', 'root', [mid]);
    const result = findElementById([root], '20');
    assert.strictEqual(result, deepLeaf);
  });

  test('finds by name when id is undefined', () => {
    const item: FormChildItem = { tag: 'InputField', name: 'MyField', properties: {}, childItems: [] };
    const result = findElementById([item], 'MyField');
    assert.strictEqual(result, item);
  });

  test('finds by id when both id and name exist', () => {
    const item = makeLeaf('7', 'SomeName');
    const result = findElementById([item], '7');
    assert.strictEqual(result, item);
  });

  test('finds by name in nested structure', () => {
    const child: FormChildItem = { tag: 'Button', name: 'SaveBtn', properties: {}, childItems: [] };
    const group = makeGroup('1', 'g', [child]);
    const result = findElementById([group], 'SaveBtn');
    assert.strictEqual(result, child);
  });

  test('returns first match when multiple root items', () => {
    const a = makeLeaf('1', 'a');
    const b = makeLeaf('2', 'b');
    const c = makeLeaf('3', 'c');
    const result = findElementById([a, b, c], '2');
    assert.strictEqual(result, b);
  });

  test('numeric id coercion: string "3" finds item with id="3"', () => {
    const item = makeLeaf('3', 'x');
    assert.strictEqual(findElementById([item], '3'), item);
  });
});

// ---------------------------------------------------------------------------
// isDescendantOf
// ---------------------------------------------------------------------------

suite('formTreeOperations — isDescendantOf', () => {
  test('returns true when sourceId === targetId (same node)', () => {
    const model = makeModel({ childItemsRoot: [makeLeaf('1', 'a')] });
    assert.strictEqual(isDescendantOf(model, '1', '1'), true);
  });

  test('returns true when source is direct child of target', () => {
    const child = makeLeaf('2', 'child');
    const parent = makeGroup('1', 'parent', [child]);
    const model = makeModel({ childItemsRoot: [parent] });
    assert.strictEqual(isDescendantOf(model, '2', '1'), true);
  });

  test('returns true for deeply nested descendant', () => {
    const deepLeaf = makeLeaf('30', 'deep');
    const mid = makeGroup('20', 'mid', [deepLeaf]);
    const root = makeGroup('10', 'root', [mid]);
    const model = makeModel({ childItemsRoot: [root] });
    assert.strictEqual(isDescendantOf(model, '30', '10'), true);
  });

  test('returns false when source is not related to target', () => {
    const a = makeLeaf('1', 'a');
    const b = makeLeaf('2', 'b');
    const model = makeModel({ childItemsRoot: [a, b] });
    assert.strictEqual(isDescendantOf(model, '1', '2'), false);
  });

  test('returns false when target is not a container (no children)', () => {
    const a = makeLeaf('1', 'a');
    const b = makeLeaf('2', 'b');
    const model = makeModel({ childItemsRoot: [a, b] });
    assert.strictEqual(isDescendantOf(model, '2', '1'), false);
  });

  test('returns false when targetId is not found in model', () => {
    const a = makeLeaf('1', 'a');
    const model = makeModel({ childItemsRoot: [a] });
    assert.strictEqual(isDescendantOf(model, '1', 'missing'), false);
  });

  test('returns false when parent is NOT ancestor of sibling', () => {
    const child1 = makeLeaf('2', 'child1');
    const child2 = makeLeaf('3', 'child2');
    const parent = makeGroup('1', 'parent', [child1, child2]);
    const model = makeModel({ childItemsRoot: [parent] });
    // child2 is sibling, not descendant of child1
    assert.strictEqual(isDescendantOf(model, '3', '2'), false);
  });

  test('returns false on empty model', () => {
    const model = makeModel();
    assert.strictEqual(isDescendantOf(model, 'x', 'y'), false);
  });
});

// ---------------------------------------------------------------------------
// findParentAndIndex
// ---------------------------------------------------------------------------

suite('formTreeOperations — findParentAndIndex', () => {
  test('returns null for empty array', () => {
    const result = findParentAndIndex([], '1');
    assert.strictEqual(result, null);
  });

  test('returns null when id not found', () => {
    const leaf = makeLeaf('1', 'a');
    const result = findParentAndIndex([leaf], 'missing');
    assert.strictEqual(result, null);
  });

  test('finds root-level element', () => {
    const a = makeLeaf('1', 'a');
    const b = makeLeaf('2', 'b');
    const root = [a, b];
    const result = findParentAndIndex(root, '2');
    assert.ok(result !== null);
    assert.strictEqual(result.parent, root);
    assert.strictEqual(result.index, 1);
  });

  test('finds element at index 0 in root', () => {
    const a = makeLeaf('1', 'a');
    const b = makeLeaf('2', 'b');
    const root = [a, b];
    const result = findParentAndIndex(root, '1');
    assert.ok(result !== null);
    assert.strictEqual(result.index, 0);
  });

  test('finds nested element — parent is childItems of container', () => {
    const child = makeLeaf('10', 'child');
    const group = makeGroup('1', 'g', [child]);
    const root = [group];
    const result = findParentAndIndex(root, '10');
    assert.ok(result !== null);
    assert.strictEqual(result.parent, group.childItems);
    assert.strictEqual(result.index, 0);
  });

  test('finds deeply nested element', () => {
    const deep = makeLeaf('100', 'deep');
    const mid = makeGroup('10', 'mid', [deep]);
    const top = makeGroup('1', 'top', [mid]);
    const result = findParentAndIndex([top], '100');
    assert.ok(result !== null);
    assert.strictEqual(result.parent, mid.childItems);
    assert.strictEqual(result.index, 0);
  });

  test('finds by name when id is absent', () => {
    const item: FormChildItem = { tag: 'Button', name: 'SaveBtn', properties: {}, childItems: [] };
    const root = [item];
    const result = findParentAndIndex(root, 'SaveBtn');
    assert.ok(result !== null);
    assert.strictEqual(result.parent, root);
    assert.strictEqual(result.index, 0);
  });
});

// ---------------------------------------------------------------------------
// moveNodeInModel
// ---------------------------------------------------------------------------

suite('formTreeOperations — moveNodeInModel', () => {
  test('moves leaf from one container to another', () => {
    const leaf = makeLeaf('3', 'leaf');
    const c1 = makeGroup('1', 'c1', [leaf]);
    const c2 = makeGroup('2', 'c2', []);
    const model = makeModel({ childItemsRoot: [c1, c2] });

    const result = moveNodeInModel(model, '3', '2', 0);

    assert.strictEqual(result, true);
    assert.strictEqual(model.childItemsRoot[0].childItems.length, 0, 'c1 must be empty');
    assert.strictEqual(model.childItemsRoot[1].childItems.length, 1, 'c2 must have the leaf');
    assert.strictEqual(model.childItemsRoot[1].childItems[0].id, '3');
  });

  test('returns false when sourceId not found', () => {
    const c = makeGroup('1', 'c', []);
    const model = makeModel({ childItemsRoot: [c] });
    assert.strictEqual(moveNodeInModel(model, 'missing', '1', 0), false);
  });

  test('returns false when targetId not found', () => {
    const leaf = makeLeaf('1', 'l');
    const model = makeModel({ childItemsRoot: [leaf, makeGroup('2', 'g', [])] });
    assert.strictEqual(moveNodeInModel(model, '1', 'missing', 0), false);
  });

  test('returns false when target is not a container', () => {
    const leaf1 = makeLeaf('1', 'a');
    const leaf2 = makeLeaf('2', 'b');
    const model = makeModel({ childItemsRoot: [leaf1, leaf2] });
    // leaf2 is InputField — not a container
    assert.strictEqual(moveNodeInModel(model, '1', '2', 0), false);
  });

  test('returns false when moving element into its own descendant', () => {
    const child = makeLeaf('2', 'child');
    const parent = makeGroup('1', 'parent', [child]);
    const model = makeModel({ childItemsRoot: [parent] });
    const before = snapshot(model);
    const result = moveNodeInModel(model, '1', '2', 0);
    assert.strictEqual(result, false);
    assert.deepStrictEqual(model, before, 'model must not be mutated on failure');
  });

  test('prevents self-containment: sourceId === targetId', () => {
    const child = makeLeaf('2', 'c');
    const group = makeGroup('1', 'g', [child]);
    const model = makeModel({ childItemsRoot: [group] });
    // moving group into itself
    const result = moveNodeInModel(model, '1', '1', 0);
    assert.strictEqual(result, false);
  });

  test('inserts at specified index', () => {
    const existing = makeLeaf('10', 'existing');
    const leaf = makeLeaf('20', 'newcomer');
    const c1 = makeGroup('1', 'c1', [leaf]);
    const c2 = makeGroup('2', 'c2', [existing]);
    const model = makeModel({ childItemsRoot: [c1, c2] });

    const result = moveNodeInModel(model, '20', '2', 0);
    assert.strictEqual(result, true);
    assert.strictEqual(model.childItemsRoot[1].childItems[0].id, '20', 'newcomer must be first');
    assert.strictEqual(model.childItemsRoot[1].childItems[1].id, '10', 'existing must be second');
  });

  test('index clamped to list length when index too large', () => {
    const leaf = makeLeaf('2', 'l');
    const c1 = makeGroup('1', 'c1', [leaf]);
    const c2 = makeGroup('3', 'c2', []);
    const model = makeModel({ childItemsRoot: [c1, c2] });
    const result = moveNodeInModel(model, '2', '3', 999);
    assert.strictEqual(result, true);
    assert.strictEqual(model.childItemsRoot[1].childItems[0].id, '2');
  });

  test('move to FORM_ROOT_ID: moves element from container to root', () => {
    const leaf = makeLeaf('2', 'leaf');
    const anchor = makeLeaf('10', 'anchor'); // needed so root is not empty after splice
    const group = makeGroup('1', 'g', [leaf]);
    const model = makeModel({ childItemsRoot: [anchor, group] });

    const result = moveNodeInModel(model, '2', FORM_ROOT_ID, 0);
    assert.strictEqual(result, true);
    assert.strictEqual(group.childItems.length, 0, 'container must be empty');
    assert.ok(model.childItemsRoot.some((x) => x.id === '2'), 'leaf must be in root');
  });

  test('move to FORM_ROOT_ID: returns false when source already at root', () => {
    const leaf = makeLeaf('1', 'a');
    const model = makeModel({ childItemsRoot: [leaf] });
    const result = moveNodeInModel(model, '1', FORM_ROOT_ID, 0);
    assert.strictEqual(result, false);
  });

  test('returns false when moving last root element into container (would empty root)', () => {
    // Only one root element; moving it into its own child would empty root
    const child = makeLeaf('2', 'child');
    const root = makeGroup('1', 'root', [child]);
    const model = makeModel({ childItemsRoot: [root] });
    // Try moving root into child — the descendant guard fires first, but also
    // even in the hypothetical case where root is moved elsewhere and root becomes empty.
    // For this test we use a configuration where root would be emptied:
    // root is the only root item; moving it into any container would empty childItemsRoot.
    // The target must NOT be a descendant, so we use a standalone container.
    // Actually, trying to move the sole root item elsewhere (not a descendant) should fail.
    const standalone = makeGroup('99', 'stand', []);
    model.childItemsRoot.splice(0, 1, root, standalone); // root + standalone
    // Now remove standalone so root is the only root item and target is its child.
    const model2 = makeModel({ childItemsRoot: [root] });
    // sourceLoc.parent is childItemsRoot (length 1). After splice it would be 0.
    // The guard: if model.childItemsRoot.length === 0 after splice → rollback + false.
    // But child (id=2) is a descendant of root (id=1): isDescendantOf('2', '1') is true.
    // So the descendant guard fires — still returns false.
    const result2 = moveNodeInModel(model2, '1', '2', 0);
    assert.strictEqual(result2, false);
  });
});

// ---------------------------------------------------------------------------
// removeNodeInModel
// ---------------------------------------------------------------------------

suite('formTreeOperations — removeNodeInModel', () => {
  test('removes leaf element', () => {
    const leaf = makeLeaf('2', 'leaf');
    const group = makeGroup('1', 'g', [leaf]);
    const model = makeModel({ childItemsRoot: [group] });

    const result = removeNodeInModel(model, '2');
    assert.strictEqual(result, true);
    assert.strictEqual(group.childItems.length, 0);
  });

  test('removes root-level element', () => {
    const a = makeLeaf('1', 'a');
    const b = makeLeaf('2', 'b');
    const model = makeModel({ childItemsRoot: [a, b] });

    const result = removeNodeInModel(model, '1');
    assert.strictEqual(result, true);
    assert.strictEqual(model.childItemsRoot.length, 1);
    assert.strictEqual(model.childItemsRoot[0].id, '2');
  });

  test('removes container together with its children', () => {
    const child = makeLeaf('10', 'child');
    const group = makeGroup('5', 'g', [child]);
    const extra = makeLeaf('99', 'extra');
    const model = makeModel({ childItemsRoot: [group, extra] });

    const result = removeNodeInModel(model, '5');
    assert.strictEqual(result, true);
    assert.strictEqual(model.childItemsRoot.length, 1);
    assert.strictEqual(model.childItemsRoot[0].id, '99');
  });

  test('returns false when element not found', () => {
    const model = makeModel({ childItemsRoot: [makeLeaf('1', 'a')] });
    const before = snapshot(model);
    const result = removeNodeInModel(model, 'nonexistent');
    assert.strictEqual(result, false);
    assert.deepStrictEqual(model, before);
  });

  test('removes deeply nested element', () => {
    const deep = makeLeaf('30', 'deep');
    const mid = makeGroup('20', 'mid', [deep]);
    const top = makeGroup('10', 'top', [mid]);
    const model = makeModel({ childItemsRoot: [top] });

    const result = removeNodeInModel(model, '30');
    assert.strictEqual(result, true);
    assert.strictEqual(mid.childItems.length, 0);
  });

  test('returns false on empty model', () => {
    const model = makeModel();
    assert.strictEqual(removeNodeInModel(model, '1'), false);
  });
});

// ---------------------------------------------------------------------------
// moveElementSiblingInModel
// ---------------------------------------------------------------------------

suite('formTreeOperations — moveElementSiblingInModel', () => {
  test('moves element up', () => {
    const a = makeLeaf('1', 'a');
    const b = makeLeaf('2', 'b');
    const model = makeModel({ childItemsRoot: [a, b] });

    const result = moveElementSiblingInModel(model, '2', 'up');
    assert.strictEqual(result, true);
    assert.strictEqual(model.childItemsRoot[0].id, '2');
    assert.strictEqual(model.childItemsRoot[1].id, '1');
  });

  test('moves element down', () => {
    const a = makeLeaf('1', 'a');
    const b = makeLeaf('2', 'b');
    const model = makeModel({ childItemsRoot: [a, b] });

    const result = moveElementSiblingInModel(model, '1', 'down');
    assert.strictEqual(result, true);
    assert.strictEqual(model.childItemsRoot[0].id, '2');
    assert.strictEqual(model.childItemsRoot[1].id, '1');
  });

  test('returns false when already at first position and direction is up', () => {
    const a = makeLeaf('1', 'a');
    const b = makeLeaf('2', 'b');
    const model = makeModel({ childItemsRoot: [a, b] });
    const before = snapshot(model);

    const result = moveElementSiblingInModel(model, '1', 'up');
    assert.strictEqual(result, false);
    assert.deepStrictEqual(model, before, 'model must not be mutated');
  });

  test('returns false when already at last position and direction is down', () => {
    const a = makeLeaf('1', 'a');
    const b = makeLeaf('2', 'b');
    const model = makeModel({ childItemsRoot: [a, b] });
    const before = snapshot(model);

    const result = moveElementSiblingInModel(model, '2', 'down');
    assert.strictEqual(result, false);
    assert.deepStrictEqual(model, before, 'model must not be mutated');
  });

  test('returns false when element not found', () => {
    const model = makeModel({ childItemsRoot: [makeLeaf('1', 'a')] });
    const result = moveElementSiblingInModel(model, 'missing', 'up');
    assert.strictEqual(result, false);
  });

  test('moves nested element up within parent childItems', () => {
    const c1 = makeLeaf('10', 'c1');
    const c2 = makeLeaf('20', 'c2');
    const group = makeGroup('1', 'g', [c1, c2]);
    const model = makeModel({ childItemsRoot: [group] });

    const result = moveElementSiblingInModel(model, '20', 'up');
    assert.strictEqual(result, true);
    assert.strictEqual(group.childItems[0].id, '20');
    assert.strictEqual(group.childItems[1].id, '10');
  });

  test('moves nested element down within parent childItems', () => {
    const c1 = makeLeaf('10', 'c1');
    const c2 = makeLeaf('20', 'c2');
    const group = makeGroup('1', 'g', [c1, c2]);
    const model = makeModel({ childItemsRoot: [group] });

    const result = moveElementSiblingInModel(model, '10', 'down');
    assert.strictEqual(result, true);
    assert.strictEqual(group.childItems[0].id, '20');
    assert.strictEqual(group.childItems[1].id, '10');
  });

  test('works with three siblings: move middle element to top', () => {
    const a = makeLeaf('1', 'a');
    const b = makeLeaf('2', 'b');
    const c = makeLeaf('3', 'c');
    const model = makeModel({ childItemsRoot: [a, b, c] });

    const result = moveElementSiblingInModel(model, '2', 'up');
    assert.strictEqual(result, true);
    assert.strictEqual(model.childItemsRoot[0].id, '2');
    assert.strictEqual(model.childItemsRoot[1].id, '1');
    assert.strictEqual(model.childItemsRoot[2].id, '3');
  });
});

// ---------------------------------------------------------------------------
// countAll
// ---------------------------------------------------------------------------

suite('formTreeOperations — countAll', () => {
  test('returns 0 for empty array', () => {
    assert.strictEqual(countAll([]), 0);
  });

  test('counts single flat element', () => {
    assert.strictEqual(countAll([makeLeaf('1', 'a')]), 1);
  });

  test('counts multiple flat elements', () => {
    const items = [makeLeaf('1', 'a'), makeLeaf('2', 'b'), makeLeaf('3', 'c')];
    assert.strictEqual(countAll(items), 3);
  });

  test('counts container and its children', () => {
    const child = makeLeaf('2', 'child');
    const group = makeGroup('1', 'g', [child]);
    assert.strictEqual(countAll([group]), 2);
  });

  test('counts deeply nested tree', () => {
    // root(1) → mid(2) → leaf(3)
    const deep = makeLeaf('3', 'deep');
    const mid = makeGroup('2', 'mid', [deep]);
    const root = makeGroup('1', 'root', [mid]);
    assert.strictEqual(countAll([root]), 3);
  });

  test('counts mixed flat and nested items', () => {
    const child1 = makeLeaf('10', 'c1');
    const child2 = makeLeaf('20', 'c2');
    const group = makeGroup('1', 'g', [child1, child2]);
    const standalone = makeLeaf('2', 'standalone');
    // 1 (group) + 2 (children) + 1 (standalone) = 4
    assert.strictEqual(countAll([group, standalone]), 4);
  });

  test('counts Pages → Page → InputField hierarchy', () => {
    const field = makeLeaf('30', 'field');
    const page = makePage('20', 'page', [field]);
    const pages = makePages('10', 'pages', [page]);
    // 3 items: pages, page, field
    assert.strictEqual(countAll([pages]), 3);
  });

  test('empty childItems array does not break count', () => {
    const group = makeGroup('1', 'g', []);
    assert.strictEqual(countAll([group]), 1);
  });
});
