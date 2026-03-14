/**
 * Preservation Property Tests for form-tree-root-drag
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 *
 * IMPORTANT: These tests MUST PASS on unfixed code — they document baseline behaviour
 * for all drag-drop operations where targetId !== '__form_root__'.
 *
 * Property 2: Preservation — Поведение для не-корневых операций не изменяется.
 * For any dragDrop input where targetId !== '__form_root__', the result is identical
 * to the original (unfixed) behavior.
 *
 * Observation notes (unfixed code):
 * - moveNodeInModel({sourceId: 'Page1', targetId: 'Pages'}) moves Page1 into Pages — works correctly.
 * - Reorder within UsualGroup changes element order correctly.
 * - Non-container targets are rejected (return false), model unchanged.
 * - countAll is preserved for all valid moves.
 */

import * as assert from 'assert';
import {
  moveNodeInModel,
  findElementById,
  isContainer,
  countAll,
} from '../../src/formEditor/formTreeOperations';
import type { FormModel, FormChildItem } from '../../src/formEditor/formModel';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORM_ROOT_ID = '__form_root__';

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
 * Build a model:
 *
 * childItemsRoot
 *   ├─ Pages(id=10, name=Страницы)
 *   │    ├─ Page(id=11, name=Страница1)
 *   │    │    └─ InputField(id=12, name=Поле1)
 *   │    └─ Page(id=13, name=Страница2)
 *   │         └─ InputField(id=14, name=Поле2)
 *   └─ UsualGroup(id=20, name=ОсновнаяГруппа)
 *        ├─ InputField(id=21, name=ПолеА)
 *        └─ InputField(id=22, name=ПолеБ)
 */
function buildModel(): FormModel {
  const field1 = makeItem('InputField', '12', 'Поле1');
  const field2 = makeItem('InputField', '14', 'Поле2');
  const page1 = makeItem('Page', '11', 'Страница1', [field1]);
  const page2 = makeItem('Page', '13', 'Страница2', [field2]);
  const pages = makeItem('Pages', '10', 'Страницы', [page1, page2]);
  const fieldA = makeItem('InputField', '21', 'ПолеА');
  const fieldB = makeItem('InputField', '22', 'ПолеБ');
  const usualGroup = makeItem('UsualGroup', '20', 'ОсновнаяГруппа', [fieldA, fieldB]);
  return {
    childItemsRoot: [pages, usualGroup],
    attributes: [],
    commands: [],
    formEvents: [],
  };
}

/**
 * Simulate the provider-layer guard that handleDragDrop applies before calling
 * moveNodeInModel. Returns the error message that would be sent to the webview,
 * or null if the operation would proceed.
 *
 * This mirrors the logic in FormEditorProvider.handleDragDrop (~line 305):
 *   const targetEl = findElementById(model.childItemsRoot, targetId);
 *   if (!targetEl || !isContainer(targetEl)) {
 *     postMessage({ type: 'error', message: 'Цель должна быть контейнером...' });
 *     return;
 *   }
 */
function simulateHandleDragDropGuard(
  model: FormModel,
  sourceId: string,
  targetId: string
): string | null {
  const sourceLoc = findElementById(model.childItemsRoot, sourceId);
  if (!sourceLoc) {
    return 'Элемент-источник не найден.';
  }
  const targetEl = findElementById(model.childItemsRoot, targetId);
  if (!targetEl || !isContainer(targetEl)) {
    return 'Цель должна быть контейнером (группа, страница, таблица и т.д.).';
  }
  return null; // would proceed
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Preservation: form-tree-root-drag', () => {

  // -------------------------------------------------------------------------
  // Observation tests — document baseline behavior on unfixed code
  // -------------------------------------------------------------------------

  /**
   * Observation 1 — moveNodeInModel moves Page1 into Pages container
   *
   * Requirement 3.1: nested container drag must continue to work.
   * Moving Page(id=11) into Pages(id=10) — Page is already a child of Pages,
   * but we move it back in at index 0 to confirm the operation succeeds.
   * More usefully: move Page(id=11) into Page(id=13) — cross-sibling move.
   */
  test('Observation 1 — moveNodeInModel moves Page(id=11) into Page(id=13) (nested container drag)', () => {
    const model = buildModel();
    const countBefore = countAll(model.childItemsRoot);

    // Move Page(id=11) into Page(id=13) — both are children of Pages, neither is ancestor of the other
    const result = moveNodeInModel(model, '11', '13', 0);

    assert.strictEqual(result, true, 'moveNodeInModel should return true for valid nested container drag');
    assert.strictEqual(
      countAll(model.childItemsRoot),
      countBefore,
      'countAll must be preserved after nested container drag'
    );
    // Page(id=11) should now be inside Page(id=13)
    const page13 = findElementById(model.childItemsRoot, '13');
    assert.ok(
      page13?.childItems?.some(c => c.id === '11'),
      'Page(id=11) should be inside Page(id=13) after the move'
    );
  });

  /**
   * Observation 2 — Reorder within UsualGroup changes element order correctly
   *
   * Requirement 3.2: sibling reorder must continue to work.
   * Move ПолеА(id=21) into UsualGroup(id=20) at index 1 — effectively moves it after ПолеБ.
   */
  test('Observation 2 — Reorder within UsualGroup changes element order correctly', () => {
    const model = buildModel();
    const countBefore = countAll(model.childItemsRoot);

    // Move ПолеА(id=21) into UsualGroup(id=20) at index 1 (after ПолеБ)
    const result = moveNodeInModel(model, '21', '20', 1);

    assert.strictEqual(result, true, 'moveNodeInModel should return true for sibling reorder');
    assert.strictEqual(
      countAll(model.childItemsRoot),
      countBefore,
      'countAll must be preserved after sibling reorder'
    );
    const group = findElementById(model.childItemsRoot, '20');
    assert.ok(group?.childItems, 'UsualGroup should have childItems');
    // After moving id=21 to index 1, ПолеБ(id=22) should be first, ПолеА(id=21) second
    assert.strictEqual(
      group!.childItems![0].id,
      '22',
      'ПолеБ(id=22) should be first after reorder'
    );
    assert.strictEqual(
      group!.childItems![1].id,
      '21',
      'ПолеА(id=21) should be second after reorder'
    );
  });

  // -------------------------------------------------------------------------
  // Property tests — non-root targetId behavior is preserved
  // -------------------------------------------------------------------------

  /**
   * Test 3 — Provider guard accepts valid container targets (not __form_root__)
   *
   * Requirement 3.1: for any targetId !== FORM_ROOT_ID that is a valid container,
   * the provider guard returns null (operation proceeds).
   */
  test('Test 3 — Provider guard accepts valid container target (Pages)', () => {
    const model = buildModel();

    // Move InputField(id=12) into Pages(id=10) — Pages is a container
    const error = simulateHandleDragDropGuard(model, '12', '10');

    assert.strictEqual(
      error,
      null,
      'Provider guard should accept a valid container target (Pages)'
    );
  });

  /**
   * Test 4 — Provider guard rejects non-container target (InputField)
   *
   * Requirement 3.1: non-container targets must still be rejected.
   */
  test('Test 4 — Provider guard rejects non-container target (InputField)', () => {
    const model = buildModel();

    // Try to move Page(id=11) into InputField(id=12) — InputField is not a container
    const error = simulateHandleDragDropGuard(model, '11', '12');

    assert.ok(
      error !== null,
      'Provider guard should reject a non-container target (InputField)'
    );
  });

  /**
   * Test 5 — countAll preserved after cross-container move (not involving root)
   *
   * Requirement 3.1: moving an element between nested containers preserves countAll.
   */
  test('Test 5 — countAll preserved after cross-container move (Page→UsualGroup)', () => {
    const model = buildModel();
    const countBefore = countAll(model.childItemsRoot);

    // Move InputField(id=12) from Page(id=11) into UsualGroup(id=20)
    const result = moveNodeInModel(model, '12', '20', 0);

    assert.strictEqual(result, true, 'moveNodeInModel should succeed for cross-container move');
    assert.strictEqual(
      countAll(model.childItemsRoot),
      countBefore,
      'countAll must be preserved after cross-container move'
    );
  });

  /**
   * Test 6 — Non-existent sourceId returns false, model unchanged
   *
   * Requirement 3.1: invalid drags must still be rejected cleanly.
   */
  test('Test 6 — Non-existent sourceId returns false, model unchanged', () => {
    const model = buildModel();
    const countBefore = countAll(model.childItemsRoot);

    const result = moveNodeInModel(model, 'nonexistent', '20', 0);

    assert.strictEqual(result, false, 'moveNodeInModel should return false for unknown sourceId');
    assert.strictEqual(countAll(model.childItemsRoot), countBefore, 'countAll must not change');
  });

  /**
   * Test 7 — Parametrised: multiple non-root moves all preserve countAll
   *
   * Property 2: for all dragDrop where targetId !== FORM_ROOT_ID,
   * valid moves preserve countAll and return true.
   */
  const nonRootMoveScenarios: Array<{ label: string; sourceId: string; targetId: string }> = [
    { label: 'InputField(12) → Page(13)',     sourceId: '12', targetId: '13' },
    { label: 'InputField(14) → UsualGroup(20)', sourceId: '14', targetId: '20' },
    { label: 'Page(11) → Page(13)',            sourceId: '11', targetId: '13' },
    { label: 'InputField(12) → UsualGroup(20)', sourceId: '12', targetId: '20' },
  ];

  for (const s of nonRootMoveScenarios) {
    test(`Parametrised — countAll preserved, targetId !== root: ${s.label}`, () => {
      const model = buildModel();
      const countBefore = countAll(model.childItemsRoot);

      // Confirm targetId is not FORM_ROOT_ID
      assert.notStrictEqual(s.targetId, FORM_ROOT_ID, 'targetId must not be FORM_ROOT_ID in preservation tests');

      const result = moveNodeInModel(model, s.sourceId, s.targetId, 0);

      assert.strictEqual(result, true, `moveNodeInModel should succeed for: ${s.label}`);
      assert.strictEqual(
        countAll(model.childItemsRoot),
        countBefore,
        `countAll must be preserved for: ${s.label}`
      );
    });
  }

  /**
   * Test 8 — Element lands in correct target container after move
   *
   * Requirement 3.1: after a valid move, the element is found inside the target container.
   */
  test('Test 8 — Element is found in target container after move', () => {
    const model = buildModel();

    // Move InputField(id=14) from Page(id=13) into UsualGroup(id=20)
    const result = moveNodeInModel(model, '14', '20', 0);

    assert.strictEqual(result, true, 'moveNodeInModel should succeed');
    const group = findElementById(model.childItemsRoot, '20');
    assert.ok(
      group?.childItems?.some(c => c.id === '14'),
      'InputField(id=14) should be inside UsualGroup(id=20) after the move'
    );
    // Must no longer be in Page(id=13)
    const page13 = findElementById(model.childItemsRoot, '13');
    assert.ok(
      !page13?.childItems?.some(c => c.id === '14'),
      'InputField(id=14) must not remain in Page(id=13) after the move'
    );
  });

  /**
   * Test 9 — isContainer returns true for all known container tags
   *
   * Preservation: the container detection logic must not be broken by the fix.
   */
  test('Test 9 — isContainer returns true for known container tags', () => {
    const containerTags = ['UsualGroup', 'Pages', 'Page', 'Table', 'Form', 'Group', 'CollapsibleGroup'];
    for (const tag of containerTags) {
      const item = makeItem(tag, '99', 'Test');
      assert.strictEqual(isContainer(item), true, `isContainer should return true for tag: ${tag}`);
    }
  });

  /**
   * Test 10 — isContainer returns false for leaf element tags
   *
   * Preservation: non-container detection must remain correct.
   */
  test('Test 10 — isContainer returns false for leaf element tags', () => {
    const leafTags = ['InputField', 'Button', 'Label', 'CheckBox'];
    for (const tag of leafTags) {
      const item = makeItem(tag, '99', 'Test');
      assert.strictEqual(isContainer(item), false, `isContainer should return false for tag: ${tag}`);
    }
  });

});
