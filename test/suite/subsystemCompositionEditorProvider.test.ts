/**
 * Tests for the diff logic used by SubsystemCompositionEditorProvider.
 *
 * The provider keeps two Sets: `initialChecked` (state on open) and
 * `currentChecked` (state after user interactions).  On save it derives:
 *   toAdd    = currentChecked \ initialChecked
 *   toRemove = initialChecked \ currentChecked
 *
 * We test that logic via a local simulateDiff helper that mirrors the
 * implementation exactly, and also verify the toggle / selectAll / deselectAll
 * mutations in isolation.
 */
import * as assert from 'assert';

// ── diff simulator ────────────────────────────────────────────────────────────

/**
 * Mirrors the diff computation from SubsystemCompositionEditorProvider.handleSave.
 */
function computeDiff(
  initialChecked: ReadonlySet<string>,
  currentChecked: ReadonlySet<string>,
): { toAdd: string[]; toRemove: string[] } {
  const toAdd = [...currentChecked].filter((r) => !initialChecked.has(r));
  const toRemove = [...initialChecked].filter((r) => !currentChecked.has(r));
  return { toAdd, toRemove };
}

/**
 * Simulates a sequence of toggle operations starting from `initialChecked`.
 */
function simulateDiff(
  initialChecked: Set<string>,
  toggles: Array<{ ref: string; checked: boolean }>,
): { toAdd: string[]; toRemove: string[] } {
  const currentChecked = new Set(initialChecked);
  for (const { ref, checked } of toggles) {
    if (checked) {
      currentChecked.add(ref);
    } else {
      currentChecked.delete(ref);
    }
  }
  return computeDiff(initialChecked, currentChecked);
}

// ── suite ─────────────────────────────────────────────────────────────────────

suite('subsystemCompositionEditorProvider — diff logic', () => {
  // 1 ─────────────────────────────────────────────────────────────────────────
  test('toggle add: checking an unchecked ref appears in toAdd', () => {
    const initial = new Set<string>(['Catalog.Existing']);
    const { toAdd, toRemove } = simulateDiff(initial, [
      { ref: 'Document.NewDoc', checked: true },
    ]);

    assert.ok(toAdd.includes('Document.NewDoc'), 'newly toggled ref must be in toAdd');
    assert.deepStrictEqual(toRemove, [], 'toRemove must be empty');
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test('toggle remove: unchecking an initially-checked ref appears in toRemove', () => {
    const initial = new Set<string>(['Catalog.Items', 'Document.Order']);
    const { toAdd, toRemove } = simulateDiff(initial, [
      { ref: 'Catalog.Items', checked: false },
    ]);

    assert.deepStrictEqual(toAdd, [], 'toAdd must be empty');
    assert.ok(toRemove.includes('Catalog.Items'), 'unchecked ref must be in toRemove');
    assert.ok(!toRemove.includes('Document.Order'), 'untouched ref must not be in toRemove');
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test('toggle back (net-zero): checking then unchecking yields empty diff', () => {
    const initial = new Set<string>(['Catalog.Items']);
    const { toAdd, toRemove } = simulateDiff(initial, [
      { ref: 'Document.NewDoc', checked: true },
      { ref: 'Document.NewDoc', checked: false },
    ]);

    assert.deepStrictEqual(toAdd, [], 'net-zero add must yield empty toAdd');
    assert.deepStrictEqual(toRemove, [], 'net-zero remove must yield empty toRemove');
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test('multiple toggles: correct toAdd and toRemove', () => {
    const initial = new Set<string>(['Catalog.A', 'Catalog.B', 'Document.X']);
    const { toAdd, toRemove } = simulateDiff(initial, [
      { ref: 'Catalog.B', checked: false },      // remove
      { ref: 'Document.X', checked: false },     // remove
      { ref: 'Subsystem.Admin', checked: true }, // add
      { ref: 'Catalog.New', checked: true },     // add
    ]);

    assert.deepStrictEqual(toAdd.sort(), ['Catalog.New', 'Subsystem.Admin']);
    assert.deepStrictEqual(toRemove.sort(), ['Catalog.B', 'Document.X']);
    assert.ok(!toAdd.includes('Catalog.A'), 'untouched ref must not appear in toAdd');
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  test('selectAll: all provided refs are added to currentChecked', () => {
    const initial = new Set<string>(['Catalog.A']);
    const allRefs = ['Catalog.A', 'Document.X', 'Document.Y'];

    // Simulate the 'selectAll' handler
    const currentChecked = new Set(initial);
    for (const ref of allRefs) {
      currentChecked.add(ref);
    }
    const { toAdd, toRemove } = computeDiff(initial, currentChecked);

    assert.deepStrictEqual(toAdd.sort(), ['Document.X', 'Document.Y']);
    assert.deepStrictEqual(toRemove, [], 'selectAll must not remove anything');
  });

  // 6 ─────────────────────────────────────────────────────────────────────────
  test('deselectAll: all provided refs are removed from currentChecked', () => {
    const initial = new Set<string>(['Catalog.A', 'Document.X', 'Document.Y']);
    const allRefs = ['Catalog.A', 'Document.X', 'Document.Y'];

    // Simulate the 'deselectAll' handler
    const currentChecked = new Set(initial);
    for (const ref of allRefs) {
      currentChecked.delete(ref);
    }
    const { toAdd, toRemove } = computeDiff(initial, currentChecked);

    assert.deepStrictEqual(toAdd, [], 'deselectAll must not add anything');
    assert.deepStrictEqual(toRemove.sort(), ['Catalog.A', 'Document.X', 'Document.Y']);
  });
});
