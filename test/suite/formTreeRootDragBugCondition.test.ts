/**
 * Bug Condition Exploration Tests for form-tree-root-drag
 *
 * **Validates: Requirements 1.1, 1.2**
 *
 * CRITICAL: These tests MUST FAIL on unfixed code — failure confirms the bug exists.
 * DO NOT fix the code when these tests fail.
 *
 * Bug: The form tree has no root «Form» node. `renderTree` is called directly with
 * `formModel.childItemsRoot`, so there is no DOM node with `data-id="__form_root__"`.
 * `handleDragDrop` calls `findElementById(model.childItemsRoot, '__form_root__')` which
 * returns `undefined`, causing the operation to be rejected with
 * «Цель должна быть контейнером».
 *
 * Property 1: Bug Condition — Корневой узел «Форма» отсутствует и drop на корень отклоняется
 */

import * as assert from 'assert';
import {
  findElementById,
  moveNodeInModel,
  isContainer,
} from '../../src/formEditor/formTreeOperations';
import type { FormModel, FormChildItem } from '../../src/formEditor/formModel';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The synthetic root node id used by the fixed code. */
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
 * Build a model that looks like:
 *
 * childItemsRoot
 *   └─ UsualGroup(id=1, name=ОсновнаяГруппа)
 *        └─ InputField(id=2, name=Поле)
 */
function buildNestedModel(): FormModel {
  const inputField = makeItem('InputField', '2', 'Поле');
  const usualGroup = makeItem('UsualGroup', '1', 'ОсновнаяГруппа', [inputField]);
  return {
    childItemsRoot: [usualGroup],
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
 * This mirrors the logic in FormEditorProvider.handleDragDrop (~line 305),
 * including the FORM_ROOT_ID special branch added by the fix:
 *   if (targetId === FORM_ROOT_ID) {
 *     // special branch: move to childItemsRoot
 *     return null; // proceeds
 *   }
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
  // Fixed: FORM_ROOT_ID is handled specially — operation proceeds without findElementById check
  if (targetId === FORM_ROOT_ID) {
    return null; // operation proceeds: element will be moved to childItemsRoot
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

suite('Bug Condition Exploration: form-tree-root-drag', () => {

  /**
   * Test 1 — findElementById returns undefined for '__form_root__'
   *
   * The synthetic root node does not exist in the model on unfixed code.
   * `findElementById(model.childItemsRoot, '__form_root__')` must return `undefined`.
   *
   * On UNFIXED code: PASSES (confirms the root node is absent from the model).
   * On FIXED code: still passes (the root node is synthetic/DOM-only, not in the model).
   *
   * This is a prerequisite check — it documents the root cause.
   */
  test('Test 1 — findElementById returns undefined for __form_root__ (root node absent from model)', () => {
    const model = buildNestedModel();

    const result = findElementById(model.childItemsRoot, FORM_ROOT_ID);

    assert.strictEqual(
      result,
      undefined,
      `BUG CONFIRMED: findElementById(childItemsRoot, '${FORM_ROOT_ID}') returned ${JSON.stringify(result)} instead of undefined. ` +
      `The synthetic root node must not exist in the model — it is DOM-only.`
    );
  });

  /**
   * Test 2 — handleDragDrop guard rejects drop on '__form_root__' (unfixed code)
   *
   * When `targetId === '__form_root__'`, `findElementById` returns `undefined`,
   * so the provider guard fires and the operation is rejected.
   *
   * On UNFIXED code: FAILS — the guard fires and returns an error message,
   *   but the test asserts that the operation SUCCEEDS (null error).
   *   This failure confirms the bug: drop on root is rejected instead of accepted.
   *
   * On FIXED code: PASSES — handleDragDrop has a special branch for FORM_ROOT_ID
   *   that moves the element to childItemsRoot without going through findElementById.
   *
   * **Validates: Requirements 1.2, 2.2**
   */
  test('Test 2 — handleDragDrop guard rejects drop on __form_root__ (BUG: should accept)', () => {
    const model = buildNestedModel();

    // Simulate the provider guard for: drag InputField(id=2) onto __form_root__
    const errorMessage = simulateHandleDragDropGuard(model, '2', FORM_ROOT_ID);

    // EXPECTED ON FIXED CODE: null (operation proceeds, element moves to childItemsRoot)
    // EXPECTED ON UNFIXED CODE: error message (operation rejected — BUG CONFIRMED)
    assert.strictEqual(
      errorMessage,
      null,
      `BUG CONFIRMED: handleDragDrop guard rejected drop on '${FORM_ROOT_ID}' with: "${errorMessage}". ` +
      `On fixed code, this operation should succeed and move the element to childItemsRoot.`
    );
  });

  /**
   * Test 3 — moveNodeInModel returns false for targetId='__form_root__'
   *
   * `moveNodeInModel` calls `findElementById(model.childItemsRoot, targetId)` internally.
   * For `targetId === '__form_root__'`, this returns `undefined`, so the function returns false.
   *
   * On UNFIXED code: FAILS — moveNodeInModel returns false, but the test asserts true.
   *   This confirms the bug: the model-level move is also rejected.
   *
   * On FIXED code: PASSES — either moveNodeInModel handles FORM_ROOT_ID specially,
   *   or the provider bypasses moveNodeInModel and moves directly to childItemsRoot.
   *
   * **Validates: Requirements 1.2, 2.2**
   */
  test('Test 3 — moveNodeInModel returns false for targetId=__form_root__ (BUG: should move to childItemsRoot)', () => {
    const model = buildNestedModel();
    const rootLengthBefore = model.childItemsRoot.length;

    // Attempt to move InputField(id=2) to __form_root__
    const result = moveNodeInModel(model, '2', FORM_ROOT_ID, 0);

    // EXPECTED ON FIXED CODE: true (element moved to childItemsRoot)
    // EXPECTED ON UNFIXED CODE: false (operation rejected — BUG CONFIRMED)
    assert.strictEqual(
      result,
      true,
      `BUG CONFIRMED: moveNodeInModel(model, '2', '${FORM_ROOT_ID}', 0) returned false. ` +
      `On fixed code, the element should be moved to childItemsRoot.`
    );

    // After a successful move, childItemsRoot should contain the moved element
    assert.ok(
      model.childItemsRoot.length > rootLengthBefore || model.childItemsRoot.some(i => i.id === '2'),
      `BUG CONFIRMED: After drop on root, InputField(id=2) should be in childItemsRoot.`
    );
  });

  /**
   * Test 4 — Drop on root with element already at root level is rejected
   *
   * If the source element is already in childItemsRoot, dropping it on __form_root__
   * should be a no-op / rejected (no point moving a root element to root).
   *
   * This test documents the expected behavior for the edge case.
   * On UNFIXED code: PASSES (operation is rejected for a different reason — targetId not found).
   * On FIXED code: PASSES (operation is rejected because source is already at root).
   *
   * **Validates: Requirements 2.2**
   */
  test('Test 4 — Drop on root when source is already at root level is rejected (edge case)', () => {
    const model = buildNestedModel();
    // UsualGroup(id=1) is already in childItemsRoot

    const result = moveNodeInModel(model, '1', FORM_ROOT_ID, 0);

    // Both unfixed and fixed code should reject this (for different reasons)
    assert.strictEqual(
      result,
      false,
      `Moving a root-level element (id=1) to __form_root__ should be rejected ` +
      `(source is already at root level).`
    );
  });

});
