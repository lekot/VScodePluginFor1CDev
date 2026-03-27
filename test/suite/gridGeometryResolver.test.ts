import * as assert from 'assert';
import { GridGeometryResolver } from '../../src/mxlPreview/gridGeometryResolver';

suite('GridGeometryResolver', () => {
  test('uses inferred row/col when no columns metadata and empty merge map', () => {
    const r = GridGeometryResolver.resolveDesignerTableGrid({
      inferredMaxRow: 3,
      inferredMaxCol: 5,
      mergeMap: new Map(),
      maxTableRows: 1000,
      maxTableCols: 1000,
    });
    assert.deepStrictEqual(r, { rowCount: 3, colCount: 5 });
  });

  test('columnsDeclaredSize expands colCount beyond sparse cells', () => {
    const r = GridGeometryResolver.resolveDesignerTableGrid({
      inferredMaxRow: 1,
      inferredMaxCol: 1,
      mergeMap: new Map(),
      columnsDeclaredSize: 18,
      maxTableRows: 1000,
      maxTableCols: 1000,
    });
    assert.strictEqual(r.colCount, 18);
    assert.strictEqual(r.rowCount, 1);
  });

  test('columnsMaxOneBasedIndex expands colCount when larger than inferred and declared size absent', () => {
    const r = GridGeometryResolver.resolveDesignerTableGrid({
      inferredMaxRow: 1,
      inferredMaxCol: 2,
      mergeMap: new Map(),
      columnsMaxOneBasedIndex: 24,
      maxTableRows: 1000,
      maxTableCols: 1000,
    });
    assert.strictEqual(r.colCount, 24);
  });

  test('columnsDeclaredSize and columnsMaxOneBasedIndex both contribute via Math.max', () => {
    const a = GridGeometryResolver.resolveDesignerTableGrid({
      inferredMaxRow: 1,
      inferredMaxCol: 1,
      mergeMap: new Map(),
      columnsDeclaredSize: 10,
      columnsMaxOneBasedIndex: 24,
      maxTableRows: 1000,
      maxTableCols: 1000,
    });
    assert.strictEqual(a.colCount, 24);

    const b = GridGeometryResolver.resolveDesignerTableGrid({
      inferredMaxRow: 1,
      inferredMaxCol: 1,
      mergeMap: new Map(),
      columnsDeclaredSize: 30,
      columnsMaxOneBasedIndex: 5,
      maxTableRows: 1000,
      maxTableCols: 1000,
    });
    assert.strictEqual(b.colCount, 30);
  });

  test('ignores non-positive columnsDeclaredSize', () => {
    const r = GridGeometryResolver.resolveDesignerTableGrid({
      inferredMaxRow: 1,
      inferredMaxCol: 4,
      mergeMap: new Map(),
      columnsDeclaredSize: 0,
      maxTableRows: 1000,
      maxTableCols: 1000,
    });
    assert.strictEqual(r.colCount, 4);
  });

  test('ignores non-positive columnsMaxOneBasedIndex', () => {
    const r = GridGeometryResolver.resolveDesignerTableGrid({
      inferredMaxRow: 1,
      inferredMaxCol: 4,
      mergeMap: new Map(),
      columnsMaxOneBasedIndex: 0,
      maxTableRows: 1000,
      maxTableCols: 1000,
    });
    assert.strictEqual(r.colCount, 4);
  });

  test('merge map extends rowCount and colCount from anchor plus span', () => {
    const mergeMap = new Map<string, { colspan: number; rowspan: number }>();
    mergeMap.set('1:2', { colspan: 3, rowspan: 2 });
    const r = GridGeometryResolver.resolveDesignerTableGrid({
      inferredMaxRow: 1,
      inferredMaxCol: 1,
      mergeMap,
      maxTableRows: 1000,
      maxTableCols: 1000,
    });
    assert.strictEqual(r.rowCount, 1 + 2);
    assert.strictEqual(r.colCount, 2 + 3);
  });

  test('skips merge entries with non-numeric row/col in key', () => {
    const mergeMap = new Map<string, { colspan: number; rowspan: number }>();
    mergeMap.set('x:y', { colspan: 99, rowspan: 99 });
    mergeMap.set('0:0', { colspan: 1, rowspan: 1 });
    const r = GridGeometryResolver.resolveDesignerTableGrid({
      inferredMaxRow: 1,
      inferredMaxCol: 1,
      mergeMap,
      maxTableRows: 1000,
      maxTableCols: 1000,
    });
    assert.strictEqual(r.colCount, 1);
    assert.strictEqual(r.rowCount, 1);
  });

  test('clamps rowCount and colCount to maxTableRows and maxTableCols', () => {
    const mergeMap = new Map<string, { colspan: number; rowspan: number }>();
    mergeMap.set('0:0', { colspan: 5000, rowspan: 5000 });
    const r = GridGeometryResolver.resolveDesignerTableGrid({
      inferredMaxRow: 1,
      inferredMaxCol: 1,
      mergeMap,
      maxTableRows: 128,
      maxTableCols: 256,
    });
    assert.strictEqual(r.rowCount, 128);
    assert.strictEqual(r.colCount, 256);
  });

  test('negative inferred values are clamped to zero then capped', () => {
    const r = GridGeometryResolver.resolveDesignerTableGrid({
      inferredMaxRow: -1,
      inferredMaxCol: -2,
      mergeMap: new Map(),
      maxTableRows: 100,
      maxTableCols: 100,
    });
    assert.deepStrictEqual(r, { rowCount: 0, colCount: 0 });
  });
});
