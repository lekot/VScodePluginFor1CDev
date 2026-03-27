/**
 * Resolves table row/column extent for Designer spreadsheet XML preview.
 * Cells alone are not enough: <columns><size> and merge rectangles can require
 * a wider/taller grid than inferred from sparse row data (common templates).
 */
export interface DesignerMergeSpan {
  colspan: number;
  rowspan: number;
}

export class GridGeometryResolver {
  /**
   * @param inferredMaxRow Exclusive end row (1 + max row index or max row + rowspan).
   * @param inferredMaxCol Exclusive end column (same convention as MxlParser).
   */
  static resolveDesignerTableGrid(params: {
    inferredMaxRow: number;
    inferredMaxCol: number;
    mergeMap: Map<string, DesignerMergeSpan>;
    /** From <columns><size>N</size> — total column count in the spreadsheet. */
    columnsDeclaredSize?: number;
    /** Greatest 1-based column index listed in the picked <columns> section. */
    columnsMaxOneBasedIndex?: number;
    maxTableRows: number;
    maxTableCols: number;
  }): { rowCount: number; colCount: number } {
    let colCount = Math.max(0, params.inferredMaxCol);
    let rowCount = Math.max(0, params.inferredMaxRow);

    if (params.columnsDeclaredSize !== undefined && params.columnsDeclaredSize > 0) {
      colCount = Math.max(colCount, params.columnsDeclaredSize);
    }
    if (params.columnsMaxOneBasedIndex !== undefined && params.columnsMaxOneBasedIndex > 0) {
      colCount = Math.max(colCount, params.columnsMaxOneBasedIndex);
    }

    for (const [key, span] of params.mergeMap.entries()) {
      const parts = key.split(':');
      const r = Number(parts[0]);
      const c = Number(parts[1]);
      if (!Number.isFinite(r) || !Number.isFinite(c)) {
        continue;
      }
      rowCount = Math.max(rowCount, r + span.rowspan);
      colCount = Math.max(colCount, c + span.colspan);
    }

    return {
      rowCount: Math.min(Math.max(rowCount, 0), params.maxTableRows),
      colCount: Math.min(Math.max(colCount, 0), params.maxTableCols),
    };
  }
}
