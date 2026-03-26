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

  test('cell with <i>2</i> gets colspan=3 and next cell is at col=3', () => {
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
    assert.strictEqual(model.tables[0].cells[0].col, 0);
    assert.strictEqual(model.tables[0].cells[0].colspan, 3);
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

  test('cell with <i>0</i> gets colspan=1 and next cell is at col=1', () => {
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
    assert.ok(table.colWidthsPx, 'colWidthsPx should be defined');
    assert.strictEqual(table.colWidthsPx![0], Math.round(130 * 96 / 25.4));
    assert.strictEqual(table.colWidthsPx![1], Math.round(103 * 96 / 25.4));
    assert.strictEqual(table.colWidthsPx![0], 491);
    assert.strictEqual(table.colWidthsPx![1], 389);
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
});
