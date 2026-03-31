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
  getContainerLayoutPreviewMeta,
  layoutPreviewFlexBox,
  layoutSpacingToPx,
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

/** Minimal child item for layout-preview meta (fixtures aligned with form property aliases). */
function makeLayoutItem(tag: string, properties: Record<string, unknown> = {}): FormChildItem {
  return { tag, id: '1', name: 'fixture', properties, childItems: [] };
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

  // getContainerLayoutPreviewMeta — preview layout metadata (1CVIEWER-36 Block 1)
  suite('getContainerLayoutPreviewMeta', () => {
    test('undefined item: vertical, no indent, base container hints only', () => {
      const meta = getContainerLayoutPreviewMeta(undefined);
      assert.strictEqual(meta.orientation, 'vertical');
      assert.strictEqual(meta.shouldIndentChildren, false);
      assert.deepStrictEqual(meta.containerClassHints, ['container', 'container-vertical']);
    });

    test('plain InputField: vertical, no indent, tag hint', () => {
      const meta = getContainerLayoutPreviewMeta(makeLayoutItem('InputField'));
      assert.strictEqual(meta.orientation, 'vertical');
      assert.strictEqual(meta.shouldIndentChildren, false);
      assert.ok(meta.containerClassHints.includes('container-inputfield'));
      assert.ok(meta.containerClassHints.includes('container-vertical'));
      assert.ok(!meta.containerClassHints.includes('container-indent'));
    });

    test('Group + Group horizontal → horizontal orientation', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', { Group: 'HorizontalIfPossible' })
      );
      assert.strictEqual(meta.orientation, 'horizontal');
    });

    test('LayoutOrientation alias (namespaced key)', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', { 'v8:LayoutOrientation': 'Vertical' })
      );
      assert.strictEqual(meta.orientation, 'vertical');
    });

    test('ChildrenLayout row → horizontal', () => {
      const meta = getContainerLayoutPreviewMeta(makeLayoutItem('Group', { ChildrenLayout: 'row' }));
      assert.strictEqual(meta.orientation, 'horizontal');
    });

    test('Russian orientation alias: Ориентация vertical', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', { Ориентация: 'Вертикальная' })
      );
      assert.strictEqual(meta.orientation, 'vertical');
    });

    test('Russian horizontal: слеванаправо', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', { Расположение: 'СлеваНаправо' })
      );
      assert.strictEqual(meta.orientation, 'horizontal');
    });

    test('unknown orientation string falls back to vertical', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', { Orientation: 'MagicValue' })
      );
      assert.strictEqual(meta.orientation, 'vertical');
    });

    test('UsualGroup defaults to indent children', () => {
      const meta = getContainerLayoutPreviewMeta(makeLayoutItem('UsualGroup'));
      assert.strictEqual(meta.shouldIndentChildren, true);
      assert.ok(meta.containerClassHints.includes('container-indent'));
    });

    test('Page defaults to indent + container-page hint', () => {
      const meta = getContainerLayoutPreviewMeta(makeLayoutItem('Page'));
      assert.strictEqual(meta.shouldIndentChildren, true);
      assert.ok(meta.containerClassHints.includes('container-page'));
    });

    test('Pages gets container-page but not default indent (tag not in baseIndent list)', () => {
      const meta = getContainerLayoutPreviewMeta(makeLayoutItem('Pages'));
      assert.strictEqual(meta.shouldIndentChildren, false);
      assert.ok(meta.containerClassHints.includes('container-page'));
    });

    test('explicit IndentChildren false overrides Page default', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('Page', { IndentChildren: 'false' })
      );
      assert.strictEqual(meta.shouldIndentChildren, false);
      assert.ok(!meta.containerClassHints.includes('container-indent'));
    });

    test('explicit ShouldIndentChildren yes on InputField', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('InputField', { ShouldIndentChildren: 'Да' })
      );
      assert.strictEqual(meta.shouldIndentChildren, true);
      assert.ok(meta.containerClassHints.includes('container-indent'));
    });

    test('Russian indent off: Вложенность нет', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', { Вложенность: 'нет' })
      );
      assert.strictEqual(meta.shouldIndentChildren, false);
    });

    test('AutoCommandBar adds container-buttons', () => {
      const meta = getContainerLayoutPreviewMeta(makeLayoutItem('AutoCommandBar'));
      assert.ok(meta.containerClassHints.includes('container-buttons'));
    });

    test('property value nested #text (scalar extraction)', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('Group', { Group: { '#text': 'horizontal' } })
      );
      assert.strictEqual(meta.orientation, 'horizontal');
    });

    test('empty properties object same as missing keys', () => {
      const a = getContainerLayoutPreviewMeta(makeLayoutItem('Button', {}));
      const b = getContainerLayoutPreviewMeta(makeLayoutItem('Button'));
      assert.deepStrictEqual(a, b);
    });

    test('CollapsibleGroup defaults indent like Group family', () => {
      const meta = getContainerLayoutPreviewMeta(makeLayoutItem('CollapsibleGroup'));
      assert.strictEqual(meta.shouldIndentChildren, true);
    });

    // --- 1CVIEWER-36 Block 3 phase B: spacing, align, ChildItemsWidth, ThroughAlign ---

    test('horizontal group: Half / Double spacing + RU alias for horizontal', () => {
      const half = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', { Group: 'HorizontalIfPossible', VerticalSpacing: 'Half' })
      );
      assert.strictEqual(half.horizontalSpacing, '');
      assert.strictEqual(half.verticalSpacing, 'half');
      const dbl = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', {
          Group: 'HorizontalIfPossible',
          HorizontalSpacing: 'Double',
          'ИнтервалВертикальный': 'Single',
        })
      );
      assert.strictEqual(dbl.horizontalSpacing, 'double');
      assert.strictEqual(dbl.verticalSpacing, 'single');
    });

    test('spacing: unknown extra words still map to single', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('Group', { HorizontalSpacing: 'SomethingSingleExtra' })
      );
      assert.strictEqual(meta.horizontalSpacing, 'single');
    });

    test('ChildItemsWidth: Equal / LeftWidest / RightWidest + ciwidth hints', () => {
      const eq = getContainerLayoutPreviewMeta(makeLayoutItem('UsualGroup', { ChildItemsWidth: 'Equal' }));
      assert.strictEqual(eq.childItemsWidth, 'equal');
      assert.ok(eq.containerClassHints.includes('ciwidth-equal'));
      const lw = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', { 'ШиринаДочернихЭлементов': 'LeftWidest' })
      );
      assert.strictEqual(lw.childItemsWidth, 'leftwidest');
      assert.ok(lw.containerClassHints.includes('ciwidth-leftwidest'));
      const rw = getContainerLayoutPreviewMeta(makeLayoutItem('Group', { childItemsWidth: 'RightWidest' }));
      assert.strictEqual(rw.childItemsWidth, 'rightwidest');
      assert.ok(rw.containerClassHints.includes('ciwidth-rightwidest'));
    });

    test('ChildItemsWidth: unrecognized value stays empty', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', { ChildItemsWidth: 'Magic' })
      );
      assert.strictEqual(meta.childItemsWidth, '');
      assert.ok(!meta.containerClassHints.some((h) => h.startsWith('ciwidth-')));
    });

    test('ThroughAlign: Use / DontUse + throughalign-use hint; RU не использовать', () => {
      const use = getContainerLayoutPreviewMeta(makeLayoutItem('UsualGroup', { ThroughAlign: 'Use' }));
      assert.strictEqual(use.throughAlign, 'use');
      assert.ok(use.containerClassHints.includes('throughalign-use'));
      const dont = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', { 'СквозноеВыравнивание': 'НеИспользовать' })
      );
      assert.strictEqual(dont.throughAlign, 'dontuse');
      assert.ok(!dont.containerClassHints.includes('throughalign-use'));
    });

    test('group align maps to flex (horizontal container): center + bottom', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', {
          Group: 'HorizontalIfPossible',
          GroupHorizontalAlign: 'Center',
          GroupVerticalAlign: 'Bottom',
        })
      );
      assert.strictEqual(meta.flexJustifyContent, 'center');
      assert.strictEqual(meta.flexAlignItems, 'flex-end');
    });

    test('group align maps to flex (vertical container): swaps justify vs align', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', {
          Group: 'Vertical',
          GroupHorizontalAlign: 'Right',
          GroupVerticalAlign: 'Center',
        })
      );
      assert.strictEqual(meta.flexJustifyContent, 'center');
      assert.strictEqual(meta.flexAlignItems, 'flex-end');
    });

    test('ThroughAlign Use forces align-items stretch in flex meta', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', {
          Group: 'HorizontalIfPossible',
          GroupHorizontalAlign: 'Left',
          GroupVerticalAlign: 'Top',
          ThroughAlign: 'Use',
        })
      );
      assert.strictEqual(meta.flexAlignItems, 'stretch');
    });

    test('Pages root: vertical shell — ignore Group, spacing, width, ThroughAlign, group align', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('Pages', {
          Group: 'HorizontalIfPossible',
          HorizontalSpacing: 'Double',
          VerticalSpacing: 'Half',
          ChildItemsWidth: 'Equal',
          ThroughAlign: 'Use',
          GroupHorizontalAlign: 'Center',
          GroupVerticalAlign: 'Bottom',
        })
      );
      assert.strictEqual(meta.tag, 'Pages');
      assert.strictEqual(meta.orientation, 'vertical');
      assert.strictEqual(meta.horizontalSpacing, '');
      assert.strictEqual(meta.verticalSpacing, '');
      assert.strictEqual(meta.childItemsWidth, '');
      assert.strictEqual(meta.throughAlign, '');
      assert.strictEqual(meta.flexJustifyContent, '');
      assert.strictEqual(meta.flexAlignItems, '');
      assert.ok(meta.containerClassHints.includes('container-pages-root'));
      assert.ok(!meta.containerClassHints.includes('ciwidth-equal'));
      assert.ok(!meta.containerClassHints.includes('throughalign-use'));
    });

    test('namespaced layout property keys still resolve (v8:)', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', {
          'v8:HorizontalSpacing': 'Half',
          'v8:ThroughAlign': { '#text': 'DontUse' },
        })
      );
      assert.strictEqual(meta.horizontalSpacing, 'half');
      assert.strictEqual(meta.throughAlign, 'dontuse');
    });

    test('invalid object values do not crash and normalize to empty kinds', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', {
          ThroughAlign: { Unknown: 'x' },
          ChildItemsWidth: { Unknown: 'y' },
          HorizontalSpacing: { Unknown: 'z' },
        })
      );
      assert.strictEqual(meta.throughAlign, '');
      assert.strictEqual(meta.childItemsWidth, '');
      assert.strictEqual(meta.horizontalSpacing, '');
      assert.ok(!meta.containerClassHints.includes('throughalign-use'));
      assert.ok(!meta.containerClassHints.some((h) => h.startsWith('ciwidth-')));
    });

    test('ThroughAlign: DontUse token has priority over nested use-substring', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', { ThroughAlign: 'DontUse' })
      );
      assert.strictEqual(meta.throughAlign, 'dontuse');
      assert.ok(!meta.containerClassHints.includes('throughalign-use'));
    });

    test('spacing and through-align aliases accept non-string scalar values', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('UsualGroup', {
          HorizontalSpacing: true,
          VerticalSpacing: 0,
          ThroughAlign: true,
        })
      );
      // Unknown scalar tokens must normalize safely without exceptions.
      assert.strictEqual(meta.horizontalSpacing, 'single');
      assert.strictEqual(meta.verticalSpacing, 'single');
      assert.strictEqual(meta.throughAlign, '');
      assert.ok(!meta.containerClassHints.includes('throughalign-use'));
    });

    test('Pages root still allows explicit indent override while keeping layout props ignored', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('Pages', {
          IndentChildren: 'true',
          ThroughAlign: 'Use',
          ChildItemsWidth: 'Equal',
        })
      );
      assert.strictEqual(meta.shouldIndentChildren, true);
      assert.strictEqual(meta.throughAlign, '');
      assert.strictEqual(meta.childItemsWidth, '');
      assert.ok(meta.containerClassHints.includes('container-indent'));
      assert.ok(!meta.containerClassHints.includes('throughalign-use'));
      assert.ok(!meta.containerClassHints.includes('ciwidth-equal'));
    });

    test('generic HorizontalAlign/VerticalAlign aliases are used for flex mapping', () => {
      const meta = getContainerLayoutPreviewMeta(
        makeLayoutItem('Group', {
          Group: 'HorizontalIfPossible',
          HorizontalAlign: 'Right',
          VerticalAlign: 'Top',
        })
      );
      assert.strictEqual(meta.flexJustifyContent, 'flex-end');
      assert.strictEqual(meta.flexAlignItems, 'flex-start');
    });
  });

  suite('layoutPreviewFlexBox (parity with webview)', () => {
    test('empty align strings yield empty flex values', () => {
      const r = layoutPreviewFlexBox('horizontal', '', '', '');
      assert.strictEqual(r.flexJustifyContent, '');
      assert.strictEqual(r.flexAlignItems, '');
    });

    test('throughAlign use alone still sets stretch', () => {
      const r = layoutPreviewFlexBox('vertical', '', '', 'use');
      assert.strictEqual(r.flexAlignItems, 'stretch');
    });

    test('RU tokens: центр по горизонтали / низ', () => {
      const r = layoutPreviewFlexBox('horizontal', 'Центр', 'Низ', '');
      assert.strictEqual(r.flexJustifyContent, 'center');
      assert.strictEqual(r.flexAlignItems, 'flex-end');
    });
  });

  suite('layoutSpacingToPx', () => {
    test('empty kind → null', () => {
      assert.strictEqual(layoutSpacingToPx(''), null);
    });

    test('half / single / double', () => {
      assert.strictEqual(layoutSpacingToPx('half'), 4);
      assert.strictEqual(layoutSpacingToPx('single'), 8);
      assert.strictEqual(layoutSpacingToPx('double'), 16);
    });
  });
});
