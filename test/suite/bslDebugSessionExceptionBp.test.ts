/**
 * Unit tests for dapToExceptionState — the pure transformation helper that converts
 * DAP setExceptionBreakpoints arguments into RdbgExceptionBreakpointState.
 *
 * Exported from bslDebugSession.ts for isolated testing without VS Code / debug session setup.
 */

import * as assert from 'assert';
import { dapToExceptionState } from '../../src/debug/bslDebugSession';

suite('bslDebugSession — dapToExceptionState', () => {

  test('empty filterOptions + empty legacyFilters → stopOnErrors: false', () => {
    const state = dapToExceptionState([], []);
    assert.strictEqual(state.stopOnErrors, false);
    assert.strictEqual(state.analyzeErrorStr, undefined);
    assert.strictEqual(state.filters, undefined);
  });

  test('undefined filterOptions + undefined legacyFilters → stopOnErrors: false', () => {
    const state = dapToExceptionState(undefined, undefined);
    assert.strictEqual(state.stopOnErrors, false);
    assert.strictEqual(state.analyzeErrorStr, undefined);
    assert.strictEqual(state.filters, undefined);
  });

  test('legacyFilters: [\'all\'] → stopOnErrors: true, no filters', () => {
    const state = dapToExceptionState([], ['all']);
    assert.strictEqual(state.stopOnErrors, true);
    assert.strictEqual(state.analyzeErrorStr, undefined, 'analyzeErrorStr must be absent when no conditions');
    assert.strictEqual(state.filters, undefined, 'no substring filters when only legacy filter id set');
  });

  test('filterOptions: [{ filterId: \'all\' }] without condition → stopOnErrors: true, no filters', () => {
    const state = dapToExceptionState([{ filterId: 'all' }], []);
    assert.strictEqual(state.stopOnErrors, true);
    assert.strictEqual(state.analyzeErrorStr, undefined);
    assert.strictEqual(state.filters, undefined);
  });

  test('filterOptions with condition → stopOnErrors: true, analyzeErrorStr: true, one filter', () => {
    const state = dapToExceptionState([{ filterId: 'all', condition: 'Деление' }], []);
    assert.strictEqual(state.stopOnErrors, true);
    assert.strictEqual(state.analyzeErrorStr, true);
    assert.ok(Array.isArray(state.filters), 'filters must be an array');
    assert.strictEqual(state.filters!.length, 1);
    assert.strictEqual(state.filters![0].include, true);
    assert.strictEqual(state.filters![0].text, 'Деление');
  });

  test('two filterOptions with conditions → two filters, analyzeErrorStr: true', () => {
    const state = dapToExceptionState([
      { filterId: 'all', condition: 'Деление на ноль' },
      { filterId: 'all', condition: 'Индекс за пределами' },
    ], []);
    assert.strictEqual(state.stopOnErrors, true);
    assert.strictEqual(state.analyzeErrorStr, true);
    assert.strictEqual(state.filters!.length, 2);
    assert.strictEqual(state.filters![0].text, 'Деление на ноль');
    assert.strictEqual(state.filters![1].text, 'Индекс за пределами');
  });

  test('filterOption with empty string condition → filter entry ignored', () => {
    const state = dapToExceptionState([
      { filterId: 'all', condition: 'Деление' },
      { filterId: 'all', condition: '' },
    ], []);
    assert.strictEqual(state.stopOnErrors, true);
    assert.strictEqual(state.filters!.length, 1, 'empty condition must be ignored');
    assert.strictEqual(state.filters![0].text, 'Деление');
  });

  test('filterOption with whitespace-only condition → filter entry ignored', () => {
    const state = dapToExceptionState([{ filterId: 'all', condition: '   ' }], []);
    assert.strictEqual(state.stopOnErrors, true);
    assert.strictEqual(state.analyzeErrorStr, undefined, 'whitespace-only condition must be treated as empty');
    assert.strictEqual(state.filters, undefined);
  });

});
