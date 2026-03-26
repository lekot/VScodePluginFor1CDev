import { XMLParser } from 'fast-xml-parser';
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

    const tableNodes = this.findNodesByName(root, TABLE_NODE_NAMES);
    if (tableNodes.length === 0) {
      this.warn(diagnostics, 'MXL_TABLE_NOT_FOUND', 'No supported table node found in MXL document.');
      return { version: 'v1', tables: [], diagnostics };
    }

    const tables = tableNodes.map((tableNode, index) =>
      this.parseTable(tableNode.node, diagnostics, `${tableNode.path}[${index}]`)
    );

    return {
      version: 'v1',
      tables,
      diagnostics,
    };
  }

  private parseTable(input: unknown, diagnostics: MxlDiagnostic[], path: string): MxlRenderTable {
    const rowNodes = this.getNamedChildren(input, ROW_NODE_NAMES);
    const cells: MxlRenderCell[] = [];
    let inferredMaxRow = 0;
    let inferredMaxCol = 0;
    const occupiedByRow = new Map<number, Set<number>>();

    if (rowNodes.length > 0) {
      rowNodes.forEach((rowNode, rowIndex) => {
        const explicitRow = this.getFirstNumber(rowNode.node, ROW_INDEX_KEYS);
        const row = explicitRow ?? rowIndex;
        const cellNodes = this.getNamedChildren(rowNode.node, CELL_NODE_NAMES);
        let nextColCursor = this.findNextFreeCol(occupiedByRow, row, 0);
        cellNodes.forEach((cellNode) => {
          const explicitCol = this.getFirstNumber(cellNode.node, COL_INDEX_KEYS);
          const fallbackCol = explicitCol ?? nextColCursor;
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
      flatCells.forEach((cellNode, index) => {
        const row = this.getFirstNumber(cellNode.node, ROW_INDEX_KEYS) ?? 0;
        const col = this.getFirstNumber(cellNode.node, COL_INDEX_KEYS) ?? index;
        const cell = this.parseCell(cellNode.node, row, col, diagnostics, cellNode.path);
        cells.push(cell);
        inferredMaxRow = Math.max(inferredMaxRow, cell.row + Math.max(cell.rowspan, 1));
        inferredMaxCol = Math.max(inferredMaxCol, cell.col + Math.max(cell.colspan, 1));
      });
    }

    this.warnUnknownKeys(input, new Set([...ROW_NODE_NAMES, ...CELL_NODE_NAMES]), diagnostics, path, ['#text']);

    return {
      rowCount: inferredMaxRow,
      colCount: inferredMaxCol,
      cells,
    };
  }

  private parseCell(
    input: unknown,
    fallbackRow: number,
    fallbackCol: number,
    diagnostics: MxlDiagnostic[],
    path: string
  ): MxlRenderCell {
    const row = this.getFirstNumber(input, ROW_INDEX_KEYS) ?? fallbackRow;
    const col = this.getFirstNumber(input, COL_INDEX_KEYS) ?? fallbackCol;
    const rowspan = Math.max(1, this.getFirstNumber(input, ROWSPAN_KEYS) ?? 1);
    const colspan = Math.max(1, this.getFirstNumber(input, COLSPAN_KEYS) ?? 1);

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
        found.push({ key, node: value, path: nodePath });
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

    const allowed = new Set(extraAllowedKeys.map((k) => this.localName(k)));
    for (const key of Object.keys(record)) {
      if (key.startsWith('@_')) {
        continue;
      }
      const keyLocalName = this.localName(key);
      if (supportedNames.has(keyLocalName) || allowed.has(keyLocalName)) {
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
    for (const key of keys) {
      const value = record[key];
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
    for (const key of keys) {
      const value = record[key];
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
}
