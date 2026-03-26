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
