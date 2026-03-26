import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { MxlDiagnostic, MxlRenderCell, MxlRenderModel, MxlRenderTable } from './mxlRenderModel';

const XML_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  trimValues: true,
  ignoreDeclaration: true,
};

const TABLE_NODE_NAMES = new Set(['table', 'tabledocument', 'tabulardocument', 'табличныйдокумент']);
const ROW_NODE_NAMES = new Set(['row', 'строка']);
const CELL_NODE_NAMES = new Set(['cell', 'ячейка']);
const STYLE_NODE_NAMES = new Set(['style', 'format', 'стиль', 'оформление']);

const ROW_INDEX_KEYS = ['@_row', '@_rowindex', 'row', 'rowindex', 'НомерСтроки'];
const COL_INDEX_KEYS = ['@_col', '@_colindex', 'col', 'colindex', 'НомерКолонки'];
const ROWSPAN_KEYS = ['@_rowspan', 'rowspan', 'RowSpan', 'ВысотаОбъединения'];
const COLSPAN_KEYS = ['@_colspan', 'colspan', 'ColSpan', 'ШиринаОбъединения'];

const MAX_DIAGNOSTICS = 200;
const MAX_TABLE_ROWS = 1000;
const MAX_TABLE_COLS = 1000;
const MAX_CELL_SPAN = 128;
const MAX_TOTAL_CELLS_PER_TABLE = 20000;
const MAX_TABLES_PER_DOCUMENT = 200;
const MAX_TOTAL_CELLS_PER_DOCUMENT = 100000;

export class MxlParser {
  private readonly parser = new XMLParser(XML_PARSER_OPTIONS);

  parse(xml: string): MxlRenderModel {
    const diagnostics: MxlDiagnostic[] = [];
    if (typeof xml !== 'string' || xml.trim() === '') {
      return {
        version: 'v1',
        tables: [],
        diagnostics: [{ level: 'error', code: 'MXL_EMPTY_INPUT', message: 'Empty MXL XML input.' }],
      };
    }

    let root: unknown;
    const validation = XMLValidator.validate(xml);
    if (validation !== true) {
      return {
        version: 'v1',
        tables: [],
        diagnostics: [
          {
            level: 'error',
            code: 'MXL_XML_PARSE_ERROR',
            message: `Failed to parse XML: ${validation.err.msg}`,
          },
        ],
      };
    }
    try {
      root = this.parser.parse(xml);
    } catch (err) {
      return {
        version: 'v1',
        tables: [],
        diagnostics: [
          {
            level: 'error',
            code: 'MXL_XML_PARSE_ERROR',
            message: `Failed to parse XML: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }

    if (this.isDesignerXmlRoot(root)) {
      return this.parseDesignerXml(root as Record<string, unknown>, diagnostics);
    }

    const tableNodes = this.findNodesByName(root, TABLE_NODE_NAMES);
    if (tableNodes.length === 0) {
      this.warn(diagnostics, 'MXL_TABLE_NOT_FOUND', 'No supported table node found in MXL document.');
      return { version: 'v1', tables: [], diagnostics };
    }

    const tables: MxlRenderTable[] = [];
    const tablesToParse = Math.min(tableNodes.length, MAX_TABLES_PER_DOCUMENT);
    let remainingDocumentCellBudget = MAX_TOTAL_CELLS_PER_DOCUMENT;
    for (let index = 0; index < tablesToParse; index += 1) {
      const tableNode = tableNodes[index];
      const parsed = this.parseTable(tableNode.node, diagnostics, `${tableNode.path}[${index}]`, remainingDocumentCellBudget);
      tables.push(parsed.table);
      remainingDocumentCellBudget = Math.max(0, remainingDocumentCellBudget - parsed.cellCount);
      if (parsed.exceededDocumentCellBudget) {
        break;
      }
    }
    if (tableNodes.length > MAX_TABLES_PER_DOCUMENT) {
      this.warn(
        diagnostics,
        'MXL_DOCUMENT_TABLE_LIMIT_EXCEEDED',
        `Document table count exceeds safe limit (${MAX_TABLES_PER_DOCUMENT}). Preview is truncated.`
      );
    }
    return {
      version: 'v1',
      tables,
      diagnostics,
    };
  }

  private parseTable(
    input: unknown,
    diagnostics: MxlDiagnostic[],
    path: string,
    remainingDocumentCellBudget: number
  ): { table: MxlRenderTable; cellCount: number; exceededDocumentCellBudget: boolean } {
    const rowNodes = this.getNamedChildren(input, ROW_NODE_NAMES);
    const cells: MxlRenderCell[] = [];
    let inferredMaxRow = 0;
    let inferredMaxCol = 0;
    const occupiedByRow = new Map<number, Set<number>>();
    let droppedCellsByLimit = false;

    const tableCellLimit = Math.min(MAX_TOTAL_CELLS_PER_TABLE, Math.max(0, remainingDocumentCellBudget));
    const exceedsTableLimit = (): boolean => cells.length >= tableCellLimit;
    if (rowNodes.length > 0) {
      rowNodes.forEach((rowNode, rowIndex) => {
        if (exceedsTableLimit()) {
          droppedCellsByLimit = true;
          return;
        }
        const explicitRow = this.getFirstNumber(rowNode.node, ROW_INDEX_KEYS);
        const row = this.clampIndex(explicitRow ?? rowIndex, MAX_TABLE_ROWS - 1);
        if (typeof explicitRow === 'number' && explicitRow !== row) {
          this.warn(
            diagnostics,
            'MXL_CELL_INDEX_LIMIT_EXCEEDED',
            `Row index exceeds safe limit (${MAX_TABLE_ROWS - 1}). Index is clamped for preview.`,
            rowNode.path
          );
        }
        const cellNodes = this.getNamedChildren(rowNode.node, CELL_NODE_NAMES);
        let nextColCursor = this.findNextFreeCol(occupiedByRow, row, 0);
        cellNodes.forEach((cellNode) => {
          if (exceedsTableLimit()) {
            droppedCellsByLimit = true;
            return;
          }
          const explicitCol = this.getFirstNumber(cellNode.node, COL_INDEX_KEYS);
          const fallbackCol = this.clampIndex(explicitCol ?? nextColCursor, MAX_TABLE_COLS - 1);
          if (typeof explicitCol === 'number' && explicitCol !== fallbackCol) {
            this.warn(
              diagnostics,
              'MXL_CELL_INDEX_LIMIT_EXCEEDED',
              `Column index exceeds safe limit (${MAX_TABLE_COLS - 1}). Index is clamped for preview.`,
              `${rowNode.path}.${cellNode.key}`
            );
          }
          const cell = this.parseCell(cellNode.node, row, fallbackCol, diagnostics, `${rowNode.path}.${cellNode.key}`);
          cells.push(cell);
          this.markOccupied(occupiedByRow, cell.row, cell.col, cell.rowspan, cell.colspan);
          nextColCursor = this.findNextFreeCol(occupiedByRow, row, cell.col + Math.max(cell.colspan, 1));
          inferredMaxRow = Math.max(inferredMaxRow, cell.row + Math.max(cell.rowspan, 1));
          inferredMaxCol = Math.max(inferredMaxCol, cell.col + Math.max(cell.colspan, 1));
        });

        this.warnUnknownKeys(
          rowNode.node,
          new Set([...CELL_NODE_NAMES, ...ROW_INDEX_KEYS]),
          diagnostics,
          rowNode.path,
          ['#text']
        );
      });
    } else {
      const flatCells = this.getNamedChildren(input, CELL_NODE_NAMES);
      flatCells.forEach((cellNode) => {
        if (exceedsTableLimit()) {
          droppedCellsByLimit = true;
          return;
        }
        const row = this.clampIndex(this.getFirstNumber(cellNode.node, ROW_INDEX_KEYS) ?? 0, MAX_TABLE_ROWS - 1);
        const explicitCol = this.getFirstNumber(cellNode.node, COL_INDEX_KEYS);
        const col = this.clampIndex(
          explicitCol ?? this.findNextFreeCol(occupiedByRow, row, 0),
          MAX_TABLE_COLS - 1
        );
        if (typeof explicitCol === 'number' && explicitCol !== col) {
          this.warn(
            diagnostics,
            'MXL_CELL_INDEX_LIMIT_EXCEEDED',
            `Column index exceeds safe limit (${MAX_TABLE_COLS - 1}). Index is clamped for preview.`,
            cellNode.path
          );
        }
        const cell = this.parseCell(cellNode.node, row, col, diagnostics, cellNode.path);
        cells.push(cell);
        this.markOccupied(occupiedByRow, cell.row, cell.col, cell.rowspan, cell.colspan);
        inferredMaxRow = Math.max(inferredMaxRow, cell.row + Math.max(cell.rowspan, 1));
        inferredMaxCol = Math.max(inferredMaxCol, cell.col + Math.max(cell.colspan, 1));
      });
    }

    if (droppedCellsByLimit && tableCellLimit < MAX_TOTAL_CELLS_PER_TABLE) {
      this.warn(
        diagnostics,
        'MXL_DOCUMENT_CELL_LIMIT_EXCEEDED',
        `Document cell count exceeds safe limit (${MAX_TOTAL_CELLS_PER_DOCUMENT}). Preview is truncated.`,
        path
      );
    } else if (droppedCellsByLimit) {
      this.warn(
        diagnostics,
        'MXL_TABLE_CELL_LIMIT_EXCEEDED',
        `Table cell count exceeds safe limit (${MAX_TOTAL_CELLS_PER_TABLE}). Preview is truncated.`,
        path
      );
    }

    if (inferredMaxRow > MAX_TABLE_ROWS || inferredMaxCol > MAX_TABLE_COLS) {
      this.warn(
        diagnostics,
        'MXL_TABLE_DIMENSION_LIMIT_EXCEEDED',
        `Table dimensions exceed safe limit (${MAX_TABLE_ROWS}x${MAX_TABLE_COLS}). Preview is clamped.`,
        path
      );
    }

    this.warnUnknownKeys(input, new Set([...ROW_NODE_NAMES, ...CELL_NODE_NAMES]), diagnostics, path, ['#text']);

    return {
      table: {
        rowCount: Math.min(inferredMaxRow, MAX_TABLE_ROWS),
        colCount: Math.min(inferredMaxCol, MAX_TABLE_COLS),
        cells,
      },
      cellCount: cells.length,
      exceededDocumentCellBudget: droppedCellsByLimit && tableCellLimit < MAX_TOTAL_CELLS_PER_TABLE,
    };
  }

  private parseCell(
    input: unknown,
    fallbackRow: number,
    fallbackCol: number,
    diagnostics: MxlDiagnostic[],
    path: string
  ): MxlRenderCell {
    const row = this.clampIndex(this.getFirstNumber(input, ROW_INDEX_KEYS) ?? fallbackRow, MAX_TABLE_ROWS - 1);
    const col = this.clampIndex(this.getFirstNumber(input, COL_INDEX_KEYS) ?? fallbackCol, MAX_TABLE_COLS - 1);
    const rawRowspan = this.getFirstNumber(input, ROWSPAN_KEYS) ?? 1;
    const rawColspan = this.getFirstNumber(input, COLSPAN_KEYS) ?? 1;
    const rowspan = this.clampSpan(rawRowspan);
    const colspan = this.clampSpan(rawColspan);
    if (rawRowspan !== rowspan || rawColspan !== colspan) {
      this.warn(
        diagnostics,
        'MXL_CELL_SPAN_LIMIT_EXCEEDED',
        `Cell span exceeds safe limit (${MAX_CELL_SPAN}). Span is clamped for preview.`,
        path
      );
    }

    const styleNode = this.getNamedChildren(input, STYLE_NODE_NAMES)[0]?.node;
    const style = styleNode ? this.parseStyle(styleNode) : undefined;
    const text = this.readTextValue(input);

    this.warnUnknownKeys(
      input,
      new Set([
        ...STYLE_NODE_NAMES,
        ...ROWSPAN_KEYS,
        ...COLSPAN_KEYS,
        ...ROW_INDEX_KEYS,
        ...COL_INDEX_KEYS,
        'text',
        'value',
        'presentation',
        'Текст',
        'Значение',
        '#text',
      ]),
      diagnostics,
      path
    );

    return { row, col, text, rowspan, colspan, style };
  }

  private parseStyle(input: unknown): MxlRenderCell['style'] {
    const record = this.asRecord(input);
    if (!record) {
      return undefined;
    }

    return {
      fontFamily: this.getFirstString(record, ['FontName', 'fontName', 'Шрифт', '@_fontFamily']),
      fontSizePt: this.getFirstNumber(record, ['FontSize', 'fontSize', 'РазмерШрифта', '@_fontSize']),
      bold: this.getFirstBoolean(record, ['Bold', 'bold', 'Жирный', '@_bold']),
      italic: this.getFirstBoolean(record, ['Italic', 'italic', 'Курсив', '@_italic']),
      horizontalAlign: this.getFirstString(record, [
        'HorizontalAlign',
        'horizontalAlign',
        'ВыравниваниеГоризонтальное',
        '@_horizontalAlign',
      ]),
      verticalAlign: this.getFirstString(record, [
        'VerticalAlign',
        'verticalAlign',
        'ВыравниваниеВертикальное',
        '@_verticalAlign',
      ]),
      backgroundColor: this.getFirstString(record, ['Background', 'background', 'Фон', '@_background']),
      border: this.getFirstString(record, ['Border', 'border', 'Граница', '@_border']),
    };
  }

  private readTextValue(input: unknown): string {
    const record = this.asRecord(input);
    if (!record) {
      if (typeof input === 'string') {
        return input;
      }
      return '';
    }

    const direct = this.getFirstString(record, ['#text', 'text', 'Text', 'value', 'Value', 'Текст', 'Значение']);
    if (direct) {
      return direct;
    }

    const nestedText = this.findFirstStringDeep(record, new Set([...STYLE_NODE_NAMES]));
    return nestedText ?? '';
  }

  private findFirstStringDeep(input: unknown, excludedKeys: Set<string>): string | undefined {
    if (typeof input === 'string') {
      const trimmed = input.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (Array.isArray(input)) {
      for (const item of input) {
        const text = this.findFirstStringDeep(item, excludedKeys);
        if (text) {
          return text;
        }
      }
      return undefined;
    }

    const record = this.asRecord(input);
    if (!record) {
      return undefined;
    }

    for (const [key, value] of Object.entries(record)) {
      if (excludedKeys.has(this.localName(key)) || key.startsWith('@_')) {
        continue;
      }
      const text = this.findFirstStringDeep(value, excludedKeys);
      if (text) {
        return text;
      }
    }
    return undefined;
  }

  private findNodesByName(
    input: unknown,
    names: Set<string>,
    path = '$'
  ): Array<{ key: string; node: unknown; path: string }> {
    const found: Array<{ key: string; node: unknown; path: string }> = [];
    this.walk(input, path, (key, value, nodePath) => {
      if (names.has(this.localName(key))) {
        if (Array.isArray(value)) {
          value.forEach((item, index) => found.push({ key, node: item, path: `${nodePath}[${index}]` }));
        } else {
          found.push({ key, node: value, path: nodePath });
        }
      }
    });
    return found;
  }

  private getNamedChildren(input: unknown, names: Set<string>): Array<{ key: string; node: unknown; path: string }> {
    const record = this.asRecord(input);
    if (!record) {
      return [];
    }

    const result: Array<{ key: string; node: unknown; path: string }> = [];
    for (const [key, value] of Object.entries(record)) {
      if (!names.has(this.localName(key))) {
        continue;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => result.push({ key, node: item, path: `${key}[${index}]` }));
      } else {
        result.push({ key, node: value, path: key });
      }
    }
    return result;
  }

  private warnUnknownKeys(
    input: unknown,
    supportedNames: Set<string>,
    diagnostics: MxlDiagnostic[],
    path: string,
    extraAllowedKeys: string[] = []
  ): void {
    const record = this.asRecord(input);
    if (!record) {
      return;
    }

    const normalizedSupported = this.toLocalNameSet(supportedNames);
    const allowed = new Set(extraAllowedKeys.map((k) => this.localName(k)));
    for (const key of Object.keys(record)) {
      if (key.startsWith('@_')) {
        continue;
      }
      const keyLocalName = this.localName(key);
      if (normalizedSupported.has(keyLocalName) || allowed.has(keyLocalName)) {
        continue;
      }
      this.warn(
        diagnostics,
        'MXL_UNSUPPORTED_NODE',
        `Unsupported node "${key}" is ignored by parser v1.`,
        `${path}.${key}`
      );
    }
  }

  private walk(
    input: unknown,
    path: string,
    onNode: (key: string, value: unknown, nodePath: string) => void
  ): void {
    if (Array.isArray(input)) {
      input.forEach((item, index) => this.walk(item, `${path}[${index}]`, onNode));
      return;
    }
    const record = this.asRecord(input);
    if (!record) {
      return;
    }
    for (const [key, value] of Object.entries(record)) {
      const nextPath = `${path}.${key}`;
      onNode(key, value, nextPath);
      this.walk(value, nextPath, onNode);
    }
  }

  private getFirstString(input: unknown, keys: string[]): string | undefined {
    const record = this.asRecord(input);
    if (!record) {
      return undefined;
    }
    const normalizedRecord = this.toLocalNameMap(record);
    for (const key of keys) {
      const value = record[key] ?? normalizedRecord.get(this.localName(key));
      if (typeof value === 'string') {
        return value;
      }
      if (this.asRecord(value) && typeof (value as Record<string, unknown>)['#text'] === 'string') {
        return (value as Record<string, unknown>)['#text'] as string;
      }
    }
    return undefined;
  }

  private getFirstNumber(input: unknown, keys: string[]): number | undefined {
    const record = this.asRecord(input);
    if (!record) {
      return undefined;
    }
    const normalizedRecord = this.toLocalNameMap(record);
    for (const key of keys) {
      const value = record[key] ?? normalizedRecord.get(this.localName(key));
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return undefined;
  }

  private getFirstBoolean(input: unknown, keys: string[]): boolean | undefined {
    const raw = this.getFirstString(input, keys);
    if (!raw) {
      return undefined;
    }
    if (raw === '1' || raw.toLowerCase() === 'true') {
      return true;
    }
    if (raw === '0' || raw.toLowerCase() === 'false') {
      return false;
    }
    return undefined;
  }

  private localName(name: string): string {
    const idx = name.indexOf(':');
    const value = idx >= 0 ? name.slice(idx + 1) : name;
    return value.toLowerCase();
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private clampIndex(value: number, max: number): number {
    return Math.max(0, Math.min(max, value));
  }

  private clampSpan(value: number): number {
    return Math.max(1, Math.min(MAX_CELL_SPAN, value));
  }

  private toLocalNameSet(source: Set<string>): Set<string> {
    return new Set(Array.from(source).map((name) => this.localName(name)));
  }

  private toLocalNameMap(record: Record<string, unknown>): Map<string, unknown> {
    const normalized = new Map<string, unknown>();
    for (const [key, value] of Object.entries(record)) {
      const local = this.localName(key);
      if (!normalized.has(local)) {
        normalized.set(local, value);
      }
    }
    return normalized;
  }

  private warn(diagnostics: MxlDiagnostic[], code: string, message: string, path?: string): void {
    if (diagnostics.length >= MAX_DIAGNOSTICS) {
      return;
    }
    diagnostics.push({ level: 'warning', code, message, path });
  }

  private markOccupied(
    occupiedByRow: Map<number, Set<number>>,
    row: number,
    col: number,
    rowspan: number,
    colspan: number
  ): void {
    const normalizedRow = Math.max(0, row);
    const normalizedCol = Math.max(0, col);
    const safeRowspan = Math.max(1, rowspan);
    const safeColspan = Math.max(1, colspan);
    for (let r = normalizedRow; r < normalizedRow + safeRowspan; r += 1) {
      const rowCells = occupiedByRow.get(r) ?? new Set<number>();
      for (let c = normalizedCol; c < normalizedCol + safeColspan; c += 1) {
        rowCells.add(c);
      }
      occupiedByRow.set(r, rowCells);
    }
  }

  private findNextFreeCol(occupiedByRow: Map<number, Set<number>>, row: number, colStart: number): number {
    const occupiedCols = occupiedByRow.get(Math.max(0, row));
    if (!occupiedCols || occupiedCols.size === 0) {
      return Math.max(0, colStart);
    }
    let col = Math.max(0, colStart);
    while (occupiedCols.has(col)) {
      col += 1;
    }
    return col;
  }

  private isDesignerXmlRoot(root: unknown): boolean {
    const record = this.asRecord(root);
    if (!record) {
      return false;
    }
    const docNode = this.asRecord(record['document']);
    if (!docNode) {
      return false;
    }
    return docNode['@_xmlns'] === 'http://v8.1c.ru/8.2/data/spreadsheet';
  }

  private parseDesignerXml(root: Record<string, unknown>, diagnostics: MxlDiagnostic[]): MxlRenderModel {
    const docNode = this.asRecord(root['document']);
    if (!docNode) {
      this.warn(diagnostics, 'MXL_TABLE_NOT_FOUND', 'Designer XML: missing document node.');
      return { version: 'v1', tables: [], diagnostics };
    }

    const rawRowsItem = docNode['rowsItem'];
    const rowsItems: unknown[] = Array.isArray(rawRowsItem)
      ? rawRowsItem
      : rawRowsItem !== undefined && rawRowsItem !== null
        ? [rawRowsItem]
        : [];

    if (rowsItems.length > MAX_TABLE_ROWS) {
      this.warn(
        diagnostics,
        'MXL_TABLE_ROW_LIMIT_EXCEEDED',
        `Row count exceeds safe limit (${MAX_TABLE_ROWS}). Preview is truncated.`
      );
    }
    const rowsItemsToProcess = rowsItems.length > MAX_TABLE_ROWS ? rowsItems.slice(0, MAX_TABLE_ROWS) : rowsItems;

    const cells: MxlRenderCell[] = [];
    let inferredMaxRow = 0;
    let inferredMaxCol = 0;
    let totalCells = 0;
    let truncated = false;

    for (const rowsItem of rowsItemsToProcess) {
      if (totalCells >= MAX_TOTAL_CELLS_PER_TABLE) {
        truncated = true;
        break;
      }
      const rowCells = this.parseDesignerXmlRow(rowsItem, diagnostics);
      for (const cell of rowCells) {
        if (totalCells >= MAX_TOTAL_CELLS_PER_TABLE) {
          truncated = true;
          break;
        }
        cells.push(cell);
        totalCells += 1;
        inferredMaxRow = Math.max(inferredMaxRow, cell.row + 1);
        inferredMaxCol = Math.max(inferredMaxCol, cell.col + Math.max(cell.colspan, 1));
      }
    }

    if (truncated) {
      this.warn(
        diagnostics,
        'MXL_TABLE_CELL_LIMIT_EXCEEDED',
        `Table cell count exceeds safe limit (${MAX_TOTAL_CELLS_PER_TABLE}). Preview is truncated.`
      );
    }

    const table: MxlRenderTable = {
      rowCount: Math.min(inferredMaxRow, MAX_TABLE_ROWS),
      colCount: Math.min(inferredMaxCol, MAX_TABLE_COLS),
      cells,
    };

    return { version: 'v1', tables: [table], diagnostics };
  }

  private parseDesignerXmlRow(rowsItemNode: unknown, diagnostics: MxlDiagnostic[]): MxlRenderCell[] {
    const record = this.asRecord(rowsItemNode);
    if (!record) {
      return [];
    }

    const rawIndex = record['index'];
    const rowIndex =
      typeof rawIndex === 'number' && Number.isFinite(rawIndex)
        ? rawIndex
        : typeof rawIndex === 'string'
          ? Number.parseInt(rawIndex, 10)
          : 0;
    const row = this.clampIndex(Number.isFinite(rowIndex) ? rowIndex : 0, MAX_TABLE_ROWS - 1);

    const rowNode = this.asRecord(record['row']);
    if (!rowNode) {
      return [];
    }

    const rawC = rowNode['c'];
    const outerCells: unknown[] = Array.isArray(rawC)
      ? rawC
      : rawC !== undefined && rawC !== null
        ? [rawC]
        : [];

    const cells: MxlRenderCell[] = [];
    let colCursor = 0;

    for (const outerC of outerCells) {
      if (colCursor >= MAX_TABLE_COLS) {
        this.warn(diagnostics, 'MXL_CELL_INDEX_LIMIT_EXCEEDED', `Column index exceeds safe limit (${MAX_TABLE_COLS - 1}). Remaining cells skipped.`);
        break;
      }
      const result = this.parseDesignerXmlCell(outerC, row, colCursor, diagnostics);
      cells.push(result.cell);
      colCursor = result.nextCursor;
    }

    return cells;
  }

  private parseDesignerXmlCell(
    outerC: unknown,
    row: number,
    colCursor: number,
    diagnostics: MxlDiagnostic[]
  ): { cell: MxlRenderCell; nextCursor: number } {
    const record = this.asRecord(outerC);

    let colspan = 1;
    let innerC: unknown = undefined;

    if (record) {
      const rawI = record['i'];
      if (rawI !== undefined && rawI !== null) {
        const iVal =
          typeof rawI === 'number' && Number.isFinite(rawI)
            ? rawI
            : typeof rawI === 'string'
              ? Number.parseInt(rawI, 10)
              : NaN;
        if (Number.isFinite(iVal) && iVal >= 0) {
          colspan = iVal + 1;
        }
      }
      innerC = record['c'];
    }

    const col = this.clampIndex(colCursor, MAX_TABLE_COLS - 1);
    const text = this.extractDesignerXmlText(innerC);

    const cell: MxlRenderCell = { row, col, text, rowspan: 1, colspan, style: undefined };
    return { cell, nextCursor: colCursor + colspan };
  }

  private extractDesignerXmlText(innerC: unknown): string {
    const record = this.asRecord(innerC);
    if (!record) {
      return '';
    }

    const tl = this.asRecord(record['tl']);
    if (tl) {
      const rawItems = tl['v8:item'];
      const items: unknown[] = Array.isArray(rawItems)
        ? rawItems
        : rawItems !== undefined && rawItems !== null
          ? [rawItems]
          : [];

      let firstContent: string | undefined;
      for (const item of items) {
        const itemRecord = this.asRecord(item);
        if (!itemRecord) {
          continue;
        }
        const lang = itemRecord['v8:lang'];
        const content = itemRecord['v8:content'];
        const contentStr = typeof content === 'string' ? content : typeof content === 'number' ? String(content) : undefined;
        if (contentStr !== undefined && firstContent === undefined) {
          firstContent = contentStr;
        }
        if (lang === 'ru' && contentStr !== undefined) {
          return contentStr;
        }
      }
      if (firstContent !== undefined) {
        return firstContent;
      }
    }

    const parameter = record['parameter'];
    if (typeof parameter === 'string') {
      return parameter;
    }
    if (typeof parameter === 'number') {
      return String(parameter);
    }

    return '';
  }
}
