import * as assert from 'assert';
import { MxlParser } from '../../src/mxlPreview/mxlParser';

suite('MxlParser', () => {
  test('parses happy-path table with text/style and span', () => {
    const parser = new MxlParser();
    const xml = `
      <TableDocument>
        <Row>
          <Cell col="0">
            <text>A1</text>
            <Style>
              <FontName>Consolas</FontName>
              <Bold>true</Bold>
            </Style>
          </Cell>
          <Cell col="1" colspan="2">B1</Cell>
        </Row>
      </TableDocument>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.version, 'v1');
    assert.strictEqual(model.diagnostics.length, 0);
    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].rowCount, 1);
    assert.strictEqual(model.tables[0].colCount, 3);
    assert.strictEqual(model.tables[0].cells.length, 2);
    assert.deepStrictEqual(model.tables[0].cells[0], {
      row: 0,
      col: 0,
      text: 'A1',
      rowspan: 1,
      colspan: 1,
      style: {
        fontFamily: 'Consolas',
        fontSizePt: undefined,
        bold: true,
        italic: undefined,
        horizontalAlign: undefined,
        verticalAlign: undefined,
        backgroundColor: undefined,
        border: undefined,
      },
    });
    assert.strictEqual(model.tables[0].cells[1].text, 'B1');
    assert.strictEqual(model.tables[0].cells[1].colspan, 2);
  });

  test('places next cell after merged region', () => {
    const parser = new MxlParser();
    const xml = `
      <Table>
        <Row>
          <Cell colspan="2">Merged</Cell>
          <Cell>AfterMerge</Cell>
        </Row>
      </Table>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells.length, 2);
    assert.strictEqual(model.tables[0].cells[0].col, 0);
    assert.strictEqual(model.tables[0].cells[0].colspan, 2);
    assert.strictEqual(model.tables[0].cells[1].col, 2);
    assert.strictEqual(model.tables[0].cells[1].text, 'AfterMerge');
    assert.strictEqual(model.tables[0].colCount, 3);
  });

  test('reports warning for unknown nodes', () => {
    const parser = new MxlParser();
    const xml = `
      <TableDocument>
        <Row>
          <Cell>ok</Cell>
          <Unexpected>skip</Unexpected>
        </Row>
      </TableDocument>
    `;

    const model = parser.parse(xml);

    assert.ok(model.diagnostics.length >= 1);
    const unsupported = model.diagnostics.find((diag) => diag.code === 'MXL_UNSUPPORTED_NODE');
    assert.ok(unsupported);
    assert.ok(unsupported?.message.includes('Unexpected'));
    assert.strictEqual(unsupported?.level, 'warning');
  });

  test('does not emit unsupported warning for known keys with mixed case', () => {
    const parser = new MxlParser();
    const xml = `
      <TableDocument>
        <Row>
          <Cell RowSpan="2" ColSpan="2">ok</Cell>
        </Row>
      </TableDocument>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells[0].rowspan, 2);
    assert.strictEqual(model.tables[0].cells[0].colspan, 2);
    assert.strictEqual(model.diagnostics.some((diag) => diag.code === 'MXL_UNSUPPORTED_NODE'), false);
  });

  test('places flat cells with spans using occupancy, not source index', () => {
    const parser = new MxlParser();
    const xml = `
      <Table>
        <Cell row="0" col="0" colspan="2">A</Cell>
        <Cell row="0">B</Cell>
      </Table>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells.length, 2);
    assert.strictEqual(model.tables[0].cells[0].col, 0);
    assert.strictEqual(model.tables[0].cells[0].colspan, 2);
    assert.strictEqual(model.tables[0].cells[1].col, 2);
    assert.strictEqual(model.tables[0].colCount, 3);
  });

  test('clamps oversized spans and table dimensions with diagnostics', () => {
    const parser = new MxlParser();
    const xml = `
      <Table>
        <Cell row="0" col="0" rowspan="9999" colspan="9999">A</Cell>
      </Table>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells[0].rowspan, 128);
    assert.strictEqual(model.tables[0].cells[0].colspan, 128);
    assert.ok(model.diagnostics.some((diag) => diag.code === 'MXL_CELL_SPAN_LIMIT_EXCEEDED'));
  });

  test('clamps oversized row/col indexes with diagnostics', () => {
    const parser = new MxlParser();
    const xml = `
      <Table>
        <Cell row="5000" col="5000">A</Cell>
      </Table>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells[0].row, 999);
    assert.strictEqual(model.tables[0].cells[0].col, 999);
    assert.ok(model.diagnostics.some((diag) => diag.code === 'MXL_CELL_INDEX_LIMIT_EXCEEDED'));
  });

  test('applies total cell cap with truncation diagnostic', () => {
    const parser = new MxlParser();
    const cells = Array.from({ length: 20050 })
      .map((_, i) => `<Cell>${i}</Cell>`)
      .join('');
    const xml = `<Table><Row>${cells}</Row></Table>`;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells.length, 20000);
    assert.ok(model.diagnostics.some((diag) => diag.code === 'MXL_TABLE_CELL_LIMIT_EXCEEDED'));
  });

  test('truncates document by table count limit', () => {
    const parser = new MxlParser();
    const manyTables = Array.from({ length: 205 })
      .map((_, i) => `<Table><Cell>${i}</Cell></Table>`)
      .join('');
    const xml = `<Root>${manyTables}</Root>`;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 200);
    assert.ok(model.diagnostics.some((diag) => diag.code === 'MXL_DOCUMENT_TABLE_LIMIT_EXCEEDED'));
  });

  test('truncates document by total cell budget across tables', () => {
    const parser = new MxlParser();
    const tableXml = (tableIndex: number): string =>
      `<Table><Row>${Array.from({ length: 10000 })
        .map((_, i) => `<Cell>${tableIndex}:${i}</Cell>`)
        .join('')}</Row></Table>`;
    const xml = `<Root>${Array.from({ length: 11 })
      .map((_, index) => tableXml(index))
      .join('')}</Root>`;

    const model = parser.parse(xml);

    assert.ok(model.tables.length >= 10);
    assert.strictEqual(model.tables.slice(0, 10).reduce((sum, table) => sum + table.cells.length, 0), 100000);
    assert.strictEqual(model.tables[10]?.cells.length ?? 0, 0);
    assert.ok(model.diagnostics.some((diag) => diag.code === 'MXL_DOCUMENT_CELL_LIMIT_EXCEEDED'));
  });

  test('returns parse error diagnostic for broken XML', () => {
    const parser = new MxlParser();
    const model = parser.parse('<Table><Row><Cell>bad');

    assert.strictEqual(model.tables.length, 0);
    assert.strictEqual(model.diagnostics.length, 1);
    assert.strictEqual(model.diagnostics[0].code, 'MXL_XML_PARSE_ERROR');
    assert.strictEqual(model.diagnostics[0].level, 'error');
  });
});

suite('MxlParser — Designer XML format', () => {
  const XMLNS = 'http://v8.1c.ru/8.2/data/spreadsheet';

  test('minimal document with one cell with tl text', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c>
              <c>
                <f>1</f>
                <tl>
                  <v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core">
                    <v8:lang>ru</v8:lang>
                    <v8:content>Привет</v8:content>
                  </v8:item>
                </tl>
              </c>
            </c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.version, 'v1');
    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells.length, 1);
    assert.strictEqual(model.tables[0].cells[0].text, 'Привет');
    assert.strictEqual(model.tables[0].cells[0].row, 0);
    assert.strictEqual(model.tables[0].cells[0].col, 0);
    assert.strictEqual(model.tables[0].cells[0].rowspan, 1);
    assert.strictEqual(model.tables[0].cells[0].colspan, 1);
  });

  test('multiple cells without <i> get sequential columns', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c>
            <c><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>B</v8:content></v8:item></tl></c></c>
            <c><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>C</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables[0].cells.length, 3);
    assert.strictEqual(model.tables[0].cells[0].col, 0);
    assert.strictEqual(model.tables[0].cells[1].col, 1);
    assert.strictEqual(model.tables[0].cells[2].col, 2);
  });

  test('cell with <i>2</i> is placed at column index 2; next cell continues sequentially', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c>
              <i>2</i>
              <c><f>1</f></c>
            </c>
            <c>
              <c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Next</v8:content></v8:item></tl></c>
            </c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables[0].cells.length, 2);
    assert.strictEqual(model.tables[0].cells[0].col, 2);
    assert.strictEqual(model.tables[0].cells[0].colspan, 1);
    assert.strictEqual(model.tables[0].cells[1].col, 3);
    assert.strictEqual(model.tables[0].cells[1].text, 'Next');
  });

  test('cell with <parameter> gets parameter value as text', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c>
              <c>
                <f>5</f>
                <parameter>ИмяПараметра</parameter>
              </c>
            </c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables[0].cells.length, 1);
    assert.strictEqual(model.tables[0].cells[0].text, 'ИмяПараметра');
  });

  test('cell with only <f> (no text) gets empty text and is present', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c>
              <c>
                <f>3</f>
              </c>
            </c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables[0].cells.length, 1);
    assert.strictEqual(model.tables[0].cells[0].text, '');
  });

  test('rowsItem without <row> produces 0 cells', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells.length, 0);
  });

  test('cell with <i>0</i> is at column 0; next cell is at col=1', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c>
              <i>0</i>
              <c><f>1</f></c>
            </c>
            <c>
              <c>
                <f>2</f>
                <tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>B</v8:content></v8:item></tl>
              </c>
            </c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables[0].cells.length, 2);
    assert.strictEqual(model.tables[0].cells[0].col, 0);
    assert.strictEqual(model.tables[0].cells[0].colspan, 1);
    assert.strictEqual(model.tables[0].cells[1].col, 1);
  });

  test('Designer XML: <i> is absolute column (Итого row pattern)', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>13</index>
          <row>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Итого</v8:content></v8:item></tl></c></c>
            <c><i>11</i><c><f>1</f><parameter>ВсегоПокупок</parameter></c></c>
            <c><c><f>1</f><parameter>СуммаБезНДС18</parameter></c></c>
            <c><c><f>1</f><parameter>НДС18</parameter></c></c>
          </row>
        </rowsItem>
      </document>
    `;
    const model = parser.parse(xml);
    const byText = (t: string) => model.tables[0].cells.find((c) => c.text === t);
    assert.strictEqual(byText('Итого')!.col, 0);
    assert.strictEqual(byText('ВсегоПокупок')!.col, 11);
    assert.strictEqual(byText('СуммаБезНДС18')!.col, 12);
    assert.strictEqual(byText('НДС18')!.col, 13);
  });

  test('two rowsItem elements produce cells with correct row indices', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Row0</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <rowsItem>
          <index>1</index>
          <row>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Row1</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables[0].cells.length, 2);
    assert.strictEqual(model.tables[0].cells[0].row, 0);
    assert.strictEqual(model.tables[0].cells[0].text, 'Row0');
    assert.strictEqual(model.tables[0].cells[1].row, 1);
    assert.strictEqual(model.tables[0].cells[1].text, 'Row1');
  });

  test('parses column widths from columns/format sections', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <size>18</size>
          <columnsItem>
            <index>1</index>
            <column>
              <formatIndex>1</formatIndex>
            </column>
          </columnsItem>
          <columnsItem>
            <index>2</index>
            <column>
              <formatIndex>2</formatIndex>
            </column>
          </columnsItem>
        </columns>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f></c></c>
            <c><c><f>2</f></c></c>
          </row>
        </rowsItem>
        <format><width>130</width></format>
        <format><width>103</width></format>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const table = model.tables[0];
    assert.strictEqual(table.colCount, 18, '<columns><size> should set grid width for sparse rows (common templates)');
    assert.ok(table.colWidthsPx, 'colWidthsPx should be defined');
    assert.strictEqual(table.colWidthsPx!.length, 18);
    assert.strictEqual(table.colWidthsPx![0], Math.round(130 * 96 / 175));
    assert.strictEqual(table.colWidthsPx![1], Math.round(103 * 96 / 175));
    assert.strictEqual(table.colWidthsPx![0], 71);
    assert.strictEqual(table.colWidthsPx![1], 57);
  });

  test('Designer XML: inner <c> colspan attribute is honored', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c colspan="3"><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Wide</v8:content></v8:item></tl></c></c>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>After</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;
    const model = parser.parse(xml);
    assert.strictEqual(model.tables[0].cells.length, 2);
    const wide = model.tables[0].cells.find((c) => c.text === 'Wide');
    assert.ok(wide);
    assert.strictEqual(wide!.col, 0);
    assert.strictEqual(wide!.colspan, 3);
    const after = model.tables[0].cells.find((c) => c.text === 'After');
    assert.ok(after);
    assert.strictEqual(after!.col, 3);
  });

  test('parses column widths from legacy 1-based columns/format indexes', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <columnsItem>
            <index>1</index>
            <column><formatIndex>1</formatIndex></column>
          </columnsItem>
        </columns>
        <rowsItem>
          <index>0</index>
          <row><c><c><f>1</f></c></c></row>
        </rowsItem>
        <format><width>130</width></format>
      </document>
    `;

    const model = parser.parse(xml);
    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].colWidthsPx?.[0], Math.round(130 * 96 / 175));
  });

  test('parses column widths when columns section uses <base>1 with 0-based index/formatIndex', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <base>1</base>
          <columnsItem>
            <index>0</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>1</index>
            <column><formatIndex>1</formatIndex></column>
          </columnsItem>
        </columns>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f></c></c>
            <c><c><f>1</f></c></c>
          </row>
        </rowsItem>
        <format><width>130</width></format>
        <format><width>103</width></format>
      </document>
    `;

    const model = parser.parse(xml);
    assert.strictEqual(model.tables.length, 1);
    const table = model.tables[0];
    assert.ok(table.colWidthsPx, 'colWidthsPx should be defined');
    assert.strictEqual(table.colWidthsPx![0], Math.round(130 * 96 / 175));
    assert.strictEqual(table.colWidthsPx![1], Math.round(103 * 96 / 175));
  });

  test('invalid columns base falls back to legacy 1-based indexes', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <base>oops</base>
          <columnsItem>
            <index>1</index>
            <column><formatIndex>1</formatIndex></column>
          </columnsItem>
        </columns>
        <rowsItem>
          <index>0</index>
          <row><c><c><f>1</f></c></c></row>
        </rowsItem>
        <format><width>130</width></format>
      </document>
    `;

    const model = parser.parse(xml);
    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].colWidthsPx?.[0], Math.round(130 * 96 / 175));
  });

  test('colWidthsPx is undefined when no columns section present', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f><tl><v8:item><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;
    const model = parser.parse(xml);
    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].colWidthsPx, undefined);
  });

  test('Designer XML: merge without cell at top-left gets synthetic empty anchor', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row><c><c><f>0</f><tl><v8:item><v8:lang>ru</v8:lang><v8:content>Left</v8:content></v8:item></tl></c></c></row>
        </rowsItem>
        <merge><r>0</r><c>5</c><w>1</w></merge>
      </document>
    `;
    const model = parser.parse(xml);
    const table = model.tables[0];
    const at = (r: number, c: number) => table.cells.find((cell) => cell.row === r && cell.col === c);
    assert.ok(at(0, 0));
    assert.strictEqual(at(0, 0)!.text, 'Left');
    const syn = at(0, 5);
    assert.ok(syn, 'synthetic anchor at merge top-left');
    assert.strictEqual(syn!.text, '');
    assert.strictEqual(syn!.colspan, 2);
    assert.strictEqual(syn!.rowspan, 1);
  });

  test('Designer XML: inner cells inside merge fold text into anchor', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row><c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Top</v8:content></v8:item></tl></c></c></row>
        </rowsItem>
        <rowsItem>
          <index>1</index>
          <row><c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Bottom</v8:content></v8:item></tl></c></c></row>
        </rowsItem>
        <merge><r>0</r><c>0</c><h>1</h></merge>
      </document>
    `;
    const model = parser.parse(xml);
    assert.strictEqual(model.tables[0].cells.length, 1);
    assert.strictEqual(model.tables[0].cells[0].row, 0);
    assert.strictEqual(model.tables[0].cells[0].col, 0);
    assert.strictEqual(model.tables[0].cells[0].rowspan, 2);
    assert.strictEqual(model.tables[0].cells[0].text, 'Top\nBottom');
  });

  test('Designer XML: merge section sets colspan and rowspan', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row><c><c><tl><v8:item><v8:lang>ru</v8:lang><v8:content>Title</v8:content></v8:item></tl></c></c></row>
        </rowsItem>
        <rowsItem>
          <index>1</index>
          <row><c><c><tl><v8:item><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c></row>
        </rowsItem>
        <merge><r>0</r><c>0</c><w>2</w></merge>
        <merge><r>1</r><c>0</c><h>1</h></merge>
      </document>
    `;
    const model = parser.parse(xml);
    assert.strictEqual(model.tables.length, 1);
    const cells = model.tables[0].cells;
    const title = cells.find(c => c.text === 'Title');
    assert.ok(title, 'Title cell found');
    assert.strictEqual(title!.colspan, 3);
    assert.strictEqual(title!.rowspan, 1);
    const a = cells.find(c => c.text === 'A');
    assert.ok(a, 'A cell found');
    assert.strictEqual(a!.rowspan, 2);
    assert.strictEqual(a!.colspan, 1);
  });

  test('Designer XML: formatClass set from f-index', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <font faceName="Arial" height="8.3" bold="true" italic="false"/>
        <format><font>0</font><horizontalAlignment>Center</horizontalAlignment><textPlacement>Wrap</textPlacement></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Hello</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const table = model.tables[0];
    assert.ok(table.formatCss, 'formatCss should be defined');
    assert.ok(
      table.formatCss!.includes('table.mxl-table td.mxl-f0{'),
      'formatCss should use td-specific selector for placement/alignment'
    );
    assert.ok(table.formatCss!.includes('overflow-wrap:break-word'), 'Wrap should enable break-word');
    assert.ok(!table.formatCss!.includes('overflow-wrap:normal'), 'Wrap should not use normal (text overflows)');
    assert.ok(table.formatCss!.includes('word-break:break-word'), 'Wrap should enable word-break:break-word');
    assert.ok(table.formatCss!.includes('overflow:visible'), 'Wrap should enable overflow:visible');
    assert.strictEqual(table.cells.length, 1);
    assert.strictEqual(table.cells[0].formatClass, 'mxl-f0');
    assert.strictEqual(table.cells[0].text, 'Hello');
  });

  test('Designer XML: Cut textPlacement emits overflow:hidden', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <font faceName="Arial" height="8" bold="false" italic="false"/>
        <format><font>0</font><textPlacement>Cut</textPlacement></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>X</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);
    const css = model.tables[0].formatCss!;
    assert.ok(css.includes('table.mxl-table td.mxl-f0{'));
    assert.ok(css.includes('white-space:nowrap'));
    assert.ok(css.includes('overflow:hidden'));
    assert.ok(css.includes('overflow-wrap:normal'));
    assert.ok(css.includes('word-break:normal'));
  });

  test('Designer XML: Auto textPlacement generates same CSS as Wrap', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <font faceName="Arial" height="8" bold="false" italic="false"/>
        <format><font>0</font><textPlacement>Auto</textPlacement></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Y</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);
    const css = model.tables[0].formatCss!;
    assert.ok(css.includes('white-space:normal'));
    assert.ok(css.includes('overflow-wrap:break-word'));
    assert.ok(css.includes('word-break:break-word'));
    assert.ok(css.includes('overflow:visible'));
  });

  test('Designer XML: format without textPlacement does not add wrap properties', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <font faceName="Arial" height="8" bold="false" italic="false"/>
        <format><font>0</font><horizontalAlignment>Center</horizontalAlignment></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Test</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);
    const css = model.tables[0].formatCss!;
    assert.ok(!css.includes('overflow-wrap:break-word'));
    assert.ok(!css.includes('word-break:break-word'));
    assert.ok(!css.includes('overflow:visible'));
    assert.ok(!css.includes('overflow:hidden'));
  });

  test('root without required xmlns falls back to old path (MXL_TABLE_NOT_FOUND)', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="http://example.com/other">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 0);
    assert.ok(model.diagnostics.some((d) => d.code === 'MXL_TABLE_NOT_FOUND'));
  });

  test('Designer XML: columnsID on row picks the matching columns section for declared width', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <id>narrow</id>
          <size>5</size>
          <columnsItem>
            <index>1</index>
            <column><formatIndex>1</formatIndex></column>
          </columnsItem>
        </columns>
        <columns>
          <id>wide</id>
          <size>12</size>
          <columnsItem>
            <index>1</index>
            <column><formatIndex>1</formatIndex></column>
          </columnsItem>
        </columns>
        <rowsItem>
          <index>0</index>
          <row>
            <columnsID>wide</columnsID>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>X</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <format><width>100</width></format>
      </document>
    `;
    const model = parser.parse(xml);
    assert.strictEqual(model.tables[0].colCount, 12, 'grid width should follow <columns><id>wide</id>, not narrow');
    assert.strictEqual(model.tables[0].colWidthsPx?.length, 12);
  });

  test('Designer XML: inner <c> ШиринаОбъединения (colspan) is applied', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><ШиринаОбъединения>2</ШиринаОбъединения><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>B</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;
    const model = parser.parse(xml);
    const a = model.tables[0].cells.find((c) => c.text === 'A');
    const b = model.tables[0].cells.find((c) => c.text === 'B');
    assert.ok(a && b);
    assert.strictEqual(a!.colspan, 2);
    assert.strictEqual(b!.col, 2);
  });

  test('Designer XML: inner <c> ColSpan attribute variant', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c ColSpan="2"><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>P</v8:content></v8:item></tl></c></c>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Q</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;
    const model = parser.parse(xml);
    const p = model.tables[0].cells.find((c) => c.text === 'P');
    assert.ok(p);
    assert.strictEqual(p!.colspan, 2);
  });

  test('Designer XML: merge region can extend colCount past columns size', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <size>5</size>
          <columnsItem>
            <index>1</index>
            <column><formatIndex>1</formatIndex></column>
          </columnsItem>
        </columns>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Only</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <merge><r>0</r><c>4</c><w>2</w></merge>
        <format><width>50</width></format>
      </document>
    `;
    const model = parser.parse(xml);
    assert.strictEqual(
      model.tables[0].colCount,
      7,
      '<columns><size>5</size> but merge ending past column 6 should widen grid'
    );
  });

  // ── Column index (<i>) vs <columns><columnsItem><index> ───────────────────────
  // <i> is 0-based sheet column index (same as <merge> c). columnsItem index is for formats only.

  test('columns section with 1-based columnsItem: <i>0</i> still lands at col=0', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <size>3</size>
          <columnsItem>
            <index>1</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>2</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>3</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
        </columns>
        <rowsItem>
          <index>0</index>
          <row>
            <c><i>0</i><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <format><width>50</width></format>
      </document>
    `;
    const model = parser.parse(xml);
    const cell = model.tables[0].cells.find((c) => c.text === 'A');
    assert.ok(cell, 'cell A should exist');
    assert.strictEqual(cell!.col, 0, '<i>0</i> → col=0 regardless of columnsItem starting at 1');
  });

  test('<i>16</i> in 17-column file (cols 0–16) lands at col=16', () => {
    // <i> is 0-based; last column of 17-wide grid is index 16 (not 17).
    const parser = new MxlParser();
    const colItems = Array.from({ length: 17 }, (_, k) =>
      `<columnsItem><index>${k + 1}</index><column><formatIndex>0</formatIndex></column></columnsItem>`
    ).join('\n          ');
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <size>17</size>
          ${colItems}
        </columns>
        <rowsItem>
          <index>0</index>
          <row>
            <c><i>16</i><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Last</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <format><width>50</width></format>
      </document>
    `;
    const model = parser.parse(xml);
    const cell = model.tables[0].cells.find((c) => c.text === 'Last');
    assert.ok(cell, 'cell Last should exist');
    assert.strictEqual(cell!.col, 16, 'col should be 16');
  });

  test('<i>14</i> lands at col=14 with 1-based columnsItem section present', () => {
    const parser = new MxlParser();
    const colItems = Array.from({ length: 17 }, (_, k) =>
      `<columnsItem><index>${k + 1}</index><column><formatIndex>0</formatIndex></column></columnsItem>`
    ).join('\n          ');
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <size>17</size>
          ${colItems}
        </columns>
        <rowsItem>
          <index>0</index>
          <row>
            <c><i>14</i><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Mid</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <format><width>50</width></format>
      </document>
    `;
    const model = parser.parse(xml);
    const cell = model.tables[0].cells.find((c) => c.text === 'Mid');
    assert.ok(cell, 'cell Mid should exist');
    assert.strictEqual(cell!.col, 14, 'col should be 14');
  });

  // ── Preservation tests ───────────────────────────────────────────────────────
  // These tests MUST PASS on unfixed code — they confirm baseline behavior to preserve.
  // Validates: Requirements 3.1, 3.2, 3.3

  test('PRESERVATION: 0-based file — <i>0</i> → col=0, <i>2</i> → col=2 (no offset applied)', () => {
    // 0-based file: columnsItem indices start at 0 → columnIndexBase=0 → no offset.
    // On unfixed code: iVal used directly, which is already correct for 0-based files.
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <size>3</size>
          <columnsItem>
            <index>0</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>1</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>2</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
        </columns>
        <rowsItem>
          <index>0</index>
          <row>
            <c><i>0</i><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>First</v8:content></v8:item></tl></c></c>
            <c><i>2</i><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Third</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <format><width>50</width></format>
      </document>
    `;
    const model = parser.parse(xml);
    const first = model.tables[0].cells.find((c) => c.text === 'First');
    const third = model.tables[0].cells.find((c) => c.text === 'Third');
    assert.ok(first, 'cell First should exist');
    assert.ok(third, 'cell Third should exist');
    assert.strictEqual(first!.col, 0, '0-based <i>0</i> → col=0');
    assert.strictEqual(third!.col, 2, '0-based <i>2</i> → col=2');
  });

  test('PRESERVATION: no-<i> cells get sequential cursor positions (cols 0, 1, 2)', () => {
    // Cells without <i> always use the sequential cursor — unaffected by columnIndexBase.
    // On unfixed code: cursor-based positioning is correct and must remain unchanged.
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>X</v8:content></v8:item></tl></c></c>
            <c><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Y</v8:content></v8:item></tl></c></c>
            <c><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Z</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;
    const model = parser.parse(xml);
    const cells = model.tables[0].cells;
    assert.strictEqual(cells.length, 3);
    assert.strictEqual(cells[0].col, 0, 'first cursor cell → col=0');
    assert.strictEqual(cells[1].col, 1, 'second cursor cell → col=1');
    assert.strictEqual(cells[2].col, 2, 'third cursor cell → col=2');
  });

  test('PRESERVATION: mixed row — 0-based <i> cells and cursor cells all at correct positions', () => {
    // 0-based file with a mix of explicit <i> and cursor cells.
    // On unfixed code: 0-based <i> values are used directly (correct), cursor advances from last col.
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <size>5</size>
          <columnsItem>
            <index>0</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>1</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>2</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>3</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>4</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
        </columns>
        <rowsItem>
          <index>0</index>
          <row>
            <c><i>0</i><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Explicit0</v8:content></v8:item></tl></c></c>
            <c><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Cursor1</v8:content></v8:item></tl></c></c>
            <c><i>3</i><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Explicit3</v8:content></v8:item></tl></c></c>
            <c><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Cursor4</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <format><width>50</width></format>
      </document>
    `;
    const model = parser.parse(xml);
    const byText = (t: string) => model.tables[0].cells.find((c) => c.text === t);
    assert.ok(byText('Explicit0'), 'Explicit0 cell should exist');
    assert.ok(byText('Cursor1'), 'Cursor1 cell should exist');
    assert.ok(byText('Explicit3'), 'Explicit3 cell should exist');
    assert.ok(byText('Cursor4'), 'Cursor4 cell should exist');
    assert.strictEqual(byText('Explicit0')!.col, 0, '0-based <i>0</i> → col=0');
    assert.strictEqual(byText('Cursor1')!.col, 1, 'cursor after col=0 → col=1');
    assert.strictEqual(byText('Explicit3')!.col, 3, '0-based <i>3</i> → col=3');
    assert.strictEqual(byText('Cursor4')!.col, 4, 'cursor after col=3 → col=4');
  });

  // ── Bug condition exploration tests ──────────────────────────────────────────
  // These tests MUST FAIL on unfixed code — failure confirms the bug exists.
  // isBugCondition: minIndex >= 1 AND iVal IS PRESENT AND iVal >= minIndex
  // Expected behavior after fix: colFromI = iVal - columnIndexBase (where columnIndexBase = minIndex)

  test('cursor after <i>3</i> starts at col=4 (0-based explicit col, then +1)', () => {
    // <i>3</i> places the cell at col=3; the following cell without <i> is at col=4.
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <columns>
          <size>5</size>
          <columnsItem>
            <index>1</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>2</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>3</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>4</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
          <columnsItem>
            <index>5</index>
            <column><formatIndex>0</formatIndex></column>
          </columnsItem>
        </columns>
        <rowsItem>
          <index>0</index>
          <row>
            <c><i>3</i><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Explicit</v8:content></v8:item></tl></c></c>
            <c><c><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Cursor</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <format><width>50</width></format>
      </document>
    `;
    const model = parser.parse(xml);
    const cursorCell = model.tables[0].cells.find((c) => c.text === 'Cursor');
    assert.ok(cursorCell, 'cursor cell should exist');
    assert.strictEqual(cursorCell!.col, 4, 'cursor cell col should be 4 (after explicit at col=3)');
  });

  // ── Bug condition exploration tests (implicit merge gap) ──────────────────────
  // These tests MUST FAIL on unfixed code — failure confirms the bug exists.
  // Bug: detectImplicitMerges breaks at the first gap column (absent from cells array).
  // Expected behavior after fix: anchor colspan extends through gap columns.
  // Validates: Requirements 1.1, 1.2

  test('BUG CONDITION (gap): single gap — anchor col=0 text, col=1 absent, col=2 present empty → colspan=3', () => {
    // Unfixed: colspan=1 (loop breaks at gap col=1 because candidate.col=2 !== anchor.col+1=1).
    // Fixed: colspan=3 (gap col=1 treated as empty, merges through to col=2).
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Hello</v8:content></v8:item></tl></c></c>
            <c><i>2</i><c><f>1</f></c></c>
          </row>
        </rowsItem>
        <format></format>
        <format></format>
      </document>
    `;
    const model = parser.parse(xml);
    const anchor = model.tables[0].cells.find((c) => c.text === 'Hello');
    assert.ok(anchor, 'anchor cell should exist');
    assert.strictEqual(anchor!.row, 0);
    assert.strictEqual(anchor!.col, 0);
    assert.strictEqual(anchor!.colspan, 3, 'anchor should span 3 cols (col=0 + gap col=1 + empty col=2)');
  });

  test('BUG CONDITION (gap): multiple gaps — anchor col=0 text, cols 1-5 absent, col=6 present empty → colspan=7', () => {
    // Unfixed: colspan=1 (loop breaks at gap col=1).
    // Fixed: colspan=7 (gap cols 1-5 treated as empty, merges through to col=6).
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Hello</v8:content></v8:item></tl></c></c>
            <c><i>6</i><c><f>1</f></c></c>
          </row>
        </rowsItem>
        <format></format>
        <format></format>
      </document>
    `;
    const model = parser.parse(xml);
    const anchor = model.tables[0].cells.find((c) => c.text === 'Hello');
    assert.ok(anchor, 'anchor cell should exist');
    assert.strictEqual(anchor!.row, 0);
    assert.strictEqual(anchor!.col, 0);
    assert.strictEqual(anchor!.colspan, 7, 'anchor should span 7 cols (col=0 + gap cols 1-5 + empty col=6)');
  });

  test('BUG CONDITION (gap): gap then text stop — anchor col=0 text, col=1 absent, col=2 has text → colspan=2', () => {
    // Unfixed: colspan=1 (loop breaks at gap col=1 before reaching text at col=2).
    // Fixed: colspan=2 (gap col=1 merged, stops before text at col=2).
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Hello</v8:content></v8:item></tl></c></c>
            <c><i>2</i><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>World</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <format></format>
        <format></format>
      </document>
    `;
    const model = parser.parse(xml);
    const anchor = model.tables[0].cells.find((c) => c.text === 'Hello');
    assert.ok(anchor, 'anchor cell should exist');
    assert.strictEqual(anchor!.row, 0);
    assert.strictEqual(anchor!.col, 0);
    assert.strictEqual(anchor!.colspan, 2, 'anchor should span 2 cols (col=0 + gap col=1, stops before text at col=2)');
  });

  test('BUG CONDITION (gap): gap then border stop — anchor col=0 text, col=1 absent, col=2 has left border → colspan=2', () => {
    // Unfixed: colspan=1 (loop breaks at gap col=1 before reaching border at col=2).
    // Fixed: colspan=2 (gap col=1 merged, stops before left-border cell at col=2).
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Hello</v8:content></v8:item></tl></c></c>
            <c><i>2</i><c><f>2</f></c></c>
          </row>
        </rowsItem>
        <format></format>
        <format></format>
        <format><leftBorder>0</leftBorder></format>
      </document>
    `;
    const model = parser.parse(xml);
    const anchor = model.tables[0].cells.find((c) => c.text === 'Hello');
    assert.ok(anchor, 'anchor cell should exist');
    assert.strictEqual(anchor!.row, 0);
    assert.strictEqual(anchor!.col, 0);
    assert.strictEqual(anchor!.colspan, 2, 'anchor should span 2 cols (col=0 + gap col=1, stops before left-border at col=2)');
  });

  // ── Preservation tests (implicit merge gap) ───────────────────────────────────
  // These tests MUST PASS on unfixed code — they confirm baseline behavior to preserve.
  // Non-bug condition: all columns contiguous (no gaps between anchor and next present cell).
  // Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6

  test('PRESERVATION (gap): contiguous empty cells — anchor col=0 text, cols 1-3 empty, col=4 text → colspan=4', () => {
    // No gap: all columns present. Unfixed and fixed both produce colspan=4.
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Anchor</v8:content></v8:item></tl></c></c>
            <c><c><f>1</f></c></c>
            <c><c><f>1</f></c></c>
            <c><c><f>1</f></c></c>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Stop</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <format></format>
        <format></format>
      </document>
    `;
    const model = parser.parse(xml);
    const anchor = model.tables[0].cells.find((c) => c.text === 'Anchor');
    assert.ok(anchor, 'anchor cell should exist');
    assert.strictEqual(anchor!.colspan, 4, 'anchor should span 4 cols (cols 0-3, stops before text at col=4)');
  });

  test('PRESERVATION (gap): stop at text (no gap) — anchor col=0 text, col=1 text → colspan=1', () => {
    // No gap: adjacent text cell stops merge immediately.
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Anchor</v8:content></v8:item></tl></c></c>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Text</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
        <format></format>
        <format></format>
      </document>
    `;
    const model = parser.parse(xml);
    const anchor = model.tables[0].cells.find((c) => c.text === 'Anchor');
    assert.ok(anchor, 'anchor cell should exist');
    assert.strictEqual(anchor!.colspan, 1, 'anchor should not merge when adjacent cell has text');
  });

  test('PRESERVATION (gap): stop at border (no gap) — anchor col=0 text, col=1 empty, col=2 left-border → colspan=2', () => {
    // No gap: empty cell merged, stops at left-border cell.
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Anchor</v8:content></v8:item></tl></c></c>
            <c><c><f>1</f></c></c>
            <c><c><f>2</f></c></c>
          </row>
        </rowsItem>
        <format></format>
        <format></format>
        <format><leftBorder>0</leftBorder></format>
      </document>
    `;
    const model = parser.parse(xml);
    const anchor = model.tables[0].cells.find((c) => c.text === 'Anchor');
    assert.ok(anchor, 'anchor cell should exist');
    assert.strictEqual(anchor!.colspan, 2, 'anchor should span 2 cols (col=0 + empty col=1, stops before left-border at col=2)');
  });

  test('PRESERVATION (gap): no-text anchor skipped — anchor col=0 empty text, col=1 empty → colspan=1', () => {
    // No gap: anchor has no text, so no implicit merge is initiated.
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>1</f></c></c>
            <c><c><f>1</f></c></c>
          </row>
        </rowsItem>
        <format></format>
        <format></format>
      </document>
    `;
    const model = parser.parse(xml);
    const cells = model.tables[0].cells;
    assert.strictEqual(cells.length, 2, 'both cells should remain (no merge)');
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[0].colspan, 1, 'empty anchor should not merge');
    assert.strictEqual(cells[1].col, 1);
    assert.strictEqual(cells[1].colspan, 1);
  });

  test('PRESERVATION (gap): explicit colspan anchor skipped — anchor col=0 text with colspan=2, col=2 empty → colspan=2', () => {
    // No gap: anchor already has explicit colspan=2, so no additional implicit merge.
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <rowsItem>
          <index>0</index>
          <row>
            <c><c ColSpan="2"><f>1</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Anchor</v8:content></v8:item></tl></c></c>
            <c><c><f>1</f></c></c>
          </row>
        </rowsItem>
        <format></format>
        <format></format>
      </document>
    `;
    const model = parser.parse(xml);
    const anchor = model.tables[0].cells.find((c) => c.text === 'Anchor');
    assert.ok(anchor, 'anchor cell should exist');
    assert.strictEqual(anchor!.col, 0);
    assert.strictEqual(anchor!.colspan, 2, 'explicit colspan=2 anchor should not get additional implicit merge');
  });

});

suite('MxlParser — Designer format border parsing', () => {
  const XMLNS = 'http://v8.1c.ru/8.2/data/spreadsheet';

  test('format with leftBorder=0 (Solid) is parsed', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format><leftBorder>0</leftBorder></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells.length, 1);
    assert.strictEqual(model.tables[0].cells[0].text, 'A');
  });

  test('format with leftBorder=1 (None) is parsed', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format><leftBorder>1</leftBorder></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>B</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells.length, 1);
    assert.strictEqual(model.tables[0].cells[0].text, 'B');
  });

  test('format with leftBorder=2 (custom line style) is parsed', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format><leftBorder>2</leftBorder></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>C</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells.length, 1);
    assert.strictEqual(model.tables[0].cells[0].text, 'C');
  });

  test('format without leftBorder is parsed (undefined)', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format><font>0</font></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>D</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells.length, 1);
    assert.strictEqual(model.tables[0].cells[0].text, 'D');
  });

  test('format with all four borders specified', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format><leftBorder>0</leftBorder><rightBorder>0</rightBorder><topBorder>0</topBorder><bottomBorder>0</bottomBorder></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>E</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells.length, 1);
    assert.strictEqual(model.tables[0].cells[0].text, 'E');
  });

  test('format with Russian attribute names (ЛеваяГраница, ПраваяГраница)', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format><ЛеваяГраница>0</ЛеваяГраница><ПраваяГраница>2</ПраваяГраница></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>F</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    assert.strictEqual(model.tables[0].cells.length, 1);
    assert.strictEqual(model.tables[0].cells[0].text, 'F');
  });

  test('format with backColor generates background-color CSS', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <font faceName="Arial" height="8" bold="false" italic="false"/>
        <format><font>0</font><backColor>#FFFFFF</backColor></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>G</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const css = model.tables[0].formatCss!;
    assert.ok(css.includes('background-color:#FFFFFF'), 'CSS should contain background-color:#FFFFFF');
    assert.strictEqual(model.tables[0].cells.length, 1);
    assert.strictEqual(model.tables[0].cells[0].text, 'G');
  });

});

suite('MxlParser — Implicit merge detection via borders', () => {
  const XMLNS = 'http://v8.1c.ru/8.2/data/spreadsheet';

  test('basic horizontal merge: text cell + empty cell with no left border', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c>
            <c><c><f>0</f></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const cells = model.tables[0].cells;
    assert.strictEqual(cells.length, 1, 'empty cell should be removed');
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[0].text, 'A');
    assert.strictEqual(cells[0].colspan, 2, 'should merge with empty cell');
  });

  test('no merge when anchor has left border', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format><leftBorder>0</leftBorder></format>
        <format></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c>
            <c><c><f>1</f></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const cells = model.tables[0].cells;
    assert.strictEqual(cells.length, 2, 'should not merge when anchor has left border');
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[0].text, 'A');
    assert.strictEqual(cells[0].colspan, 1);
    assert.strictEqual(cells[1].col, 1);
    assert.strictEqual(cells[1].colspan, 1);
  });

  test('no merge when empty cell has left border', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format></format>
        <format><leftBorder>0</leftBorder></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c>
            <c><c><f>1</f></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const cells = model.tables[0].cells;
    assert.strictEqual(cells.length, 2, 'should not merge when empty cell has left border');
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[0].text, 'A');
    assert.strictEqual(cells[0].colspan, 1);
    assert.strictEqual(cells[1].col, 1);
    assert.strictEqual(cells[1].colspan, 1);
  });

  test('merge stops at non-empty cell', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c>
            <c><c><f>0</f></c></c>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>B</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const cells = model.tables[0].cells;
    assert.strictEqual(cells.length, 2, 'should have 2 cells: A merged with empty, B standalone');
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[0].text, 'A');
    assert.strictEqual(cells[0].colspan, 2, 'A should merge with empty cell');
    assert.strictEqual(cells[1].col, 2);
    assert.strictEqual(cells[1].text, 'B');
    assert.strictEqual(cells[1].colspan, 1, 'B should not merge (non-empty)');
  });

  test('explicit merge takes precedence over implicit merge', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c>
            <c><c><f>0</f></c></c>
            <c><c><f>0</f></c></c>
          </row>
        </rowsItem>
        <merge><r>0</r><c>0</c><w>1</w></merge>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const cells = model.tables[0].cells;
    assert.strictEqual(cells.length, 2, 'should have 2 cells: A with explicit merge, one empty');
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[0].text, 'A');
    assert.strictEqual(cells[0].colspan, 2, 'explicit merge should be preserved');
    assert.strictEqual(cells[1].col, 2);
    assert.strictEqual(cells[1].text, '');
    assert.strictEqual(cells[1].colspan, 1, 'cell after explicit merge should not be implicitly merged');
  });

  test('multi-cell merge: 6 columns (row 8 cols 12-17 pattern)', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format></format>
        <rowsItem>
          <index>8</index>
          <row>
            <c><i>12</i><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>В том числе</v8:content></v8:item></tl></c></c>
            <c><c><f>0</f></c></c>
            <c><c><f>0</f></c></c>
            <c><c><f>0</f></c></c>
            <c><c><f>0</f></c></c>
            <c><c><f>0</f></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const cells = model.tables[0].cells;
    assert.strictEqual(cells.length, 1, 'empty cells should be removed');
    assert.strictEqual(cells[0].row, 8);
    assert.strictEqual(cells[0].col, 12);
    assert.strictEqual(cells[0].text, 'В том числе');
    assert.strictEqual(cells[0].colspan, 6, 'should merge 6 columns (12-17)');
  });

  test('non-adjacent columns: gap column is treated as empty and merged through', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>A</v8:content></v8:item></tl></c></c>
            <c><i>2</i><c><f>0</f></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const cells = model.tables[0].cells;
    // Gap column (col=1) is absent from cells — treated as empty and merged through.
    assert.strictEqual(cells.length, 1, 'empty cell at col=2 should be removed after merge');
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[0].text, 'A');
    assert.strictEqual(cells[0].colspan, 3, 'should merge through gap col=1 and empty col=2');
  });

  test('empty anchor: no merge when first cell is empty', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f></c></c>
            <c><c><f>0</f></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const cells = model.tables[0].cells;
    assert.strictEqual(cells.length, 2, 'should not merge when anchor is empty');
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[0].text, '');
    assert.strictEqual(cells[0].colspan, 1);
    assert.strictEqual(cells[1].col, 1);
    assert.strictEqual(cells[1].text, '');
    assert.strictEqual(cells[1].colspan, 1);
  });

  test('implicit merge does not intersect with covered cells from explicit merge', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Explicit</v8:content></v8:item></tl></c></c>
            <c><c><f>0</f></c></c>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Implicit</v8:content></v8:item></tl></c></c>
            <c><c><f>0</f></c></c>
          </row>
        </rowsItem>
        <merge><r>0</r><c>0</c><w>1</w></merge>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const cells = model.tables[0].cells;
    assert.strictEqual(cells.length, 2, 'should have 2 cells: explicit merge and implicit merge');
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[0].text, 'Explicit');
    assert.strictEqual(cells[0].colspan, 2, 'explicit merge should span 2 columns');
    assert.strictEqual(cells[1].col, 2);
    assert.strictEqual(cells[1].text, 'Implicit');
    assert.strictEqual(cells[1].colspan, 2, 'implicit merge should span remaining 2 columns');
  });

  test('multiple empty cells in sequence: merge all into first text cell', () => {
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Header</v8:content></v8:item></tl></c></c>
            <c><c><f>0</f></c></c>
            <c><c><f>0</f></c></c>
            <c><c><f>0</f></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);

    assert.strictEqual(model.tables.length, 1);
    const cells = model.tables[0].cells;
    assert.strictEqual(cells.length, 1, 'all empty cells should be removed');
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[0].text, 'Header');
    assert.strictEqual(cells[0].colspan, 4, 'should merge all 4 columns');
  });

  test('implicit merge: empty cell with colspan>1 is one slab (no double count past its span)', () => {
    // Regression: colToCell.get(nextCol) misses columns inside another cell's colspan; the walker
    // must advance by that cell's width so the next column is not treated as an extra "gap".
    const parser = new MxlParser();
    const xml = `
      <document xmlns="${XMLNS}">
        <format></format>
        <format></format>
        <rowsItem>
          <index>0</index>
          <row>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Left</v8:content></v8:item></tl></c></c>
            <c><i>3</i><c><f>1</f><colspan>2</colspan></c></c>
            <c><c><f>0</f><tl><v8:item xmlns:v8="http://v8.1c.ru/8.1/data/core"><v8:lang>ru</v8:lang><v8:content>Right</v8:content></v8:item></tl></c></c>
          </row>
        </rowsItem>
      </document>
    `;

    const model = parser.parse(xml);
    const cells = model.tables[0].cells.sort((a, b) => a.col - b.col);
    assert.strictEqual(cells.length, 2, 'Left absorbs gaps 1–2 and empty colspan-2 at 3–4; Right stays at 5');
    assert.strictEqual(cells[0].text, 'Left');
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[0].colspan, 5, 'cols 0–4 inclusive');
    assert.strictEqual(cells[1].text, 'Right');
    assert.strictEqual(cells[1].col, 5);
    assert.strictEqual(cells[1].colspan, 1);
  });

});
