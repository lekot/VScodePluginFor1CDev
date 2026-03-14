/**
 * Preservation Property Tests for form-drag-clears-xml
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
 *
 * IMPORTANT: These tests MUST PASS on unfixed code — they document baseline behaviour
 * for non-buggy inputs (nested elements, invalid drags, etc.).
 *
 * Property 2: Preservation — for inputs where isBugCondition is false,
 * moveNodeInModel behaves correctly and countAll is preserved.
 *
 * Observation notes (unfixed code):
 * - moveNodeInModel does NOT check sourceId === targetId itself; that guard lives in
 *   the provider layer. The raw function will attempt the move and return true.
 * - Valid nested moves (source is NOT an ancestor of target) preserve countAll.
 * - Moving source into its own descendant corrupts the tree (ancestor→descendant case).
 *   Tests use only safe scenarios where source is not an ancestor of target.
 */

import * as assert from 'assert';
import { moveNodeInModel, countAll } from '../../src/formEditor/formTreeOperations';
import type { FormModel, FormChildItem } from '../../src/formEditor/formModel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(
  tag: string,
  id: string,
  name: string,
  children: FormChildItem[] = []
): FormChildItem {
  return { tag, id, name, properties: {}, childItems: children };
}

/**
 * Build a model that looks like:
 *
 * childItemsRoot
 *   └─ Pages(id=1)
 *        ├─ Page(id=3)
 *        │    └─ UsualGroup(id=7)
 *        └─ Page(id=5)
 *             └─ InputField(id=15)
 */
function buildModel(): FormModel {
  const usualGroup = makeItem('UsualGroup', '7', 'ОсновнаяГруппа');
  const inputField = makeItem('InputField', '15', 'Поле');
  const page3 = makeItem('Page', '3', 'СтраницаОсновная', [usualGroup]);
  const page5 = makeItem('Page', '5', 'СтраницаДополнительная', [inputField]);
  const pages = makeItem('Pages', '1', 'Страницы', [page3, page5]);
  return {
    childItemsRoot: [pages],
    attributes: [],
    commands: [],
    formEvents: [],
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Preservation: form-drag-clears-xml', () => {

  /**
   * Test 1 — Nested element drag (not a direct root child)
   *
   * Moving Page(id=3) into Page(id=5) — both are children of Pages, neither is an
   * ancestor of the other. Source is a child of Pages, not of childItemsRoot.
   * childItemsRoot must not be touched; operation must return true.
   */
  test('Test 1 — Moving nested element (Page→Page) does not touch childItemsRoot', () => {
    const model = buildModel();
    const rootLengthBefore = model.childItemsRoot.length;

    // Move Page(id=3) into Page(id=5) — valid: Page(id=3) is not an ancestor of Page(id=5)
    const result = moveNodeInModel(model, '3', '5', 0);

    assert.strictEqual(result, true, 'moveNodeInModel should return true for a valid nested move');
    assert.strictEqual(
      model.childItemsRoot.length,
      rootLengthBefore,
      'childItemsRoot.length must not change when moving a nested element'
    );
  });

  /**
   * Test 2 — Drag element into itself (sourceId === targetId)
   *
   * Observation: moveNodeInModel does NOT guard against self-drag internally —
   * that check is in the provider layer. The raw function moves the element into
   * its own childItems and returns true. This test documents that observed baseline.
   */
  test('Test 2 — Drag into itself (sourceId === targetId) — observed baseline behaviour', () => {
    const model = buildModel();

    // On unfixed code: moveNodeInModel does not reject self-drag; it returns true
    // and moves the element into its own childItems (degenerate but not a crash).
    const result = moveNodeInModel(model, '3', '3', 0);

    // Baseline: the function does not throw
    assert.ok(typeof result === 'boolean', 'moveNodeInModel must return a boolean for self-drag');
  });

  /**
   * Test 3 — Non-existent sourceId
   *
   * Must return false and leave the model unchanged.
   */
  test('Test 3 — Non-existent sourceId returns false, model unchanged', () => {
    const model = buildModel();
    const countBefore = countAll(model.childItemsRoot);

    const result = moveNodeInModel(model, 'nonexistent-id', '7', 0);

    assert.strictEqual(result, false, 'moveNodeInModel should return false for unknown sourceId');
    assert.strictEqual(
      countAll(model.childItemsRoot),
      countBefore,
      'countAll must not change when drag is rejected'
    );
  });

  /**
   * Test 4 — Non-container target (InputField)
   *
   * InputField is not a container — must return false and leave the model unchanged.
   */
  test('Test 4 — Non-container target (InputField) returns false, model unchanged', () => {
    const model = buildModel();
    const countBefore = countAll(model.childItemsRoot);

    // Try to move Page(id=3) into InputField(id=15) — InputField is not a container
    const result = moveNodeInModel(model, '3', '15', 0);

    assert.strictEqual(result, false, 'moveNodeInModel should return false when target is not a container');
    assert.strictEqual(
      countAll(model.childItemsRoot),
      countBefore,
      'countAll must not change when drag is rejected'
    );
  });

  /**
   * Test 5 — countAll is preserved after a valid nested move
   *
   * Moving InputField(id=15) into Page(id=3) — source is not an ancestor of target.
   * countAll must be identical before and after.
   */
  test('Test 5 — countAll is preserved before and after valid nested move', () => {
    const model = buildModel();
    const countBefore = countAll(model.childItemsRoot);

    // InputField(id=15) is in Page(id=5); moving it to Page(id=3) is a safe cross-sibling move
    const result = moveNodeInModel(model, '15', '3', 0);

    assert.strictEqual(result, true, 'moveNodeInModel should succeed');
    assert.strictEqual(
      countAll(model.childItemsRoot),
      countBefore,
      'countAll must be identical before and after a valid move (move, not delete)'
    );
  });

  // ---------------------------------------------------------------------------
  // Parametrised tests — multiple nested-element move scenarios
  // Safe scenarios: source is NOT an ancestor of target.
  // ---------------------------------------------------------------------------

  const nestedMoveScenarios: Array<{
    label: string;
    sourceId: string;
    targetId: string;
  }> = [
    // Page(id=3) → Page(id=5): siblings under Pages, neither is ancestor of the other
    { label: 'Page(id=3) → Page(id=5)', sourceId: '3', targetId: '5' },
    // InputField(id=15) → Page(id=3): cross-sibling move, source not ancestor of target
    { label: 'InputField(id=15) → Page(id=3)', sourceId: '15', targetId: '3' },
  ];

  for (const scenario of nestedMoveScenarios) {
    test(`Parametrised — countAll preserved: ${scenario.label}`, () => {
      const model = buildModel();
      const countBefore = countAll(model.childItemsRoot);

      const result = moveNodeInModel(model, scenario.sourceId, scenario.targetId, 0);

      assert.strictEqual(result, true, `moveNodeInModel should succeed for scenario: ${scenario.label}`);
      assert.strictEqual(
        countAll(model.childItemsRoot),
        countBefore,
        `countAll must be preserved for scenario: ${scenario.label}`
      );
    });
  }

});
