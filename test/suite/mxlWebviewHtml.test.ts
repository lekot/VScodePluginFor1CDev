import * as assert from 'assert';
import { buildMxlErrorHtml, buildMxlParserErrorHtml, buildMxlPreviewHtml } from '../../src/mxlPreview/mxlWebviewHtml';
import { MxlRenderModel } from '../../src/mxlPreview/mxlRenderModel';

const mockWebview = { cspSource: 'vscode-test-csp' } as any;

suite('mxlWebviewHtml', () => {
  test('renders preview load error and escapes dynamic text', () => {
    const html = buildMxlErrorHtml(mockWebview, 'broken/<file>.mxl', new Error('bad <xml>'));

    assert.ok(html.includes('MXL preview error'));
    assert.ok(html.includes('broken/&lt;file&gt;.mxl'));
    assert.ok(html.includes('bad &lt;xml&gt;'));
    assert.ok(html.includes('vscode-test-csp'));
  });

  test('renders empty-state when there are no tables', () => {
    const model: MxlRenderModel = {
      version: 'v1',
      tables: [],
      diagnostics: [],
    };

    const html = buildMxlPreviewHtml({
      webview: mockWebview,
      filePath: 'demo/file.mxl',
      sourceFormat: 'mxl',
      model,
    });

    assert.ok(html.includes('No supported table nodes found in this MXL document.'));
    assert.ok(html.includes('Detected format: <b>mxl</b>'));
    assert.ok(html.includes('Diagnostics: no warnings.'));
  });

  test('truncates diagnostics list in html output', () => {
    const diagnostics = Array.from({ length: 55 }).map((_, index) => ({
      level: 'warning' as const,
      code: `CODE_${index}`,
      message: `Diagnostic ${index}`,
      path: `$[${index}]`,
    }));

    const html = buildMxlPreviewHtml({
      webview: mockWebview,
      filePath: 'diag/file.xml',
      sourceFormat: 'xml',
      model: { version: 'v1', tables: [], diagnostics },
    });

    assert.ok(html.includes('showing 50 of 55'));
    assert.ok(html.includes('[CODE_49]'));
    assert.ok(!html.includes('[CODE_50]'));
  });

  test('renders basic table with cell and merge attributes', () => {
    const model: MxlRenderModel = {
      version: 'v1',
      tables: [
        {
          rowCount: 2,
          colCount: 3,
          cells: [
            { row: 0, col: 0, text: 'A1', rowspan: 1, colspan: 1 },
            { row: 0, col: 1, text: 'B1', rowspan: 1, colspan: 2 },
            { row: 1, col: 0, text: 'A2', rowspan: 1, colspan: 1 },
          ],
        },
      ],
      diagnostics: [],
    };

    const html = buildMxlPreviewHtml({
      webview: mockWebview,
      filePath: 'table/file.mxl',
      sourceFormat: 'mxl',
      model,
    });

    assert.ok(html.includes('Table 1'));
    assert.ok(html.includes('<table class="mxl-table" style="table-layout:auto">'));
    assert.ok(html.includes('<td>A1</td>'));
    assert.ok(html.includes('<td colspan="2">B1</td>'));
    assert.ok(html.includes('<td class="empty"></td>'));
  });

  test('renders explicit parser error state with fallback hint', () => {
    const html = buildMxlParserErrorHtml({
      webview: mockWebview,
      filePath: 'broken/file.mxl',
      sourceFormat: 'mxl',
      diagnostics: [{ level: 'error', code: 'MXL_XML_PARSE_ERROR', message: 'bad xml' }],
    });

    assert.ok(html.includes('MXL preview unavailable'));
    assert.ok(html.includes('Parser reported blocking errors.'));
    assert.ok(html.includes('[MXL_XML_PARSE_ERROR]'));
    assert.ok(html.includes('validate encoding/XML structure'));
  });

  test('does not inject font-family when it contains double quotes', () => {
    const model: MxlRenderModel = {
      version: 'v1',
      tables: [
        {
          rowCount: 1,
          colCount: 1,
          cells: [
            {
              row: 0,
              col: 0,
              text: 'A1',
              rowspan: 1,
              colspan: 1,
              style: { fontFamily: '"Times New Roman"' },
            },
          ],
        },
      ],
      diagnostics: [],
    };

    const html = buildMxlPreviewHtml({
      webview: mockWebview,
      filePath: 'table/file.mxl',
      sourceFormat: 'mxl',
      model,
    });

    assert.ok(!html.includes('Times New Roman'));
  });

  test('renders rowspan and does not render covered cells', () => {
    const model: MxlRenderModel = {
      version: 'v1',
      tables: [
        {
          rowCount: 2,
          colCount: 2,
          cells: [
            { row: 0, col: 0, text: 'A', rowspan: 2, colspan: 1 },
            { row: 0, col: 1, text: 'B', rowspan: 1, colspan: 1 },
            { row: 1, col: 1, text: 'C', rowspan: 1, colspan: 1 },
          ],
        },
      ],
      diagnostics: [],
    };

    const html = buildMxlPreviewHtml({
      webview: mockWebview,
      filePath: 'table/file.mxl',
      sourceFormat: 'mxl',
      model,
    });

    assert.ok(html.includes('<td rowspan="2">A</td>'));
    const tdCount = (html.match(/<td/g) ?? []).length;
    assert.strictEqual(tdCount, 3);
    assert.ok(!html.includes('class="empty"'));
  });

  test('uses fixed layout and width when colWidthsPx are present', () => {
    const model: MxlRenderModel = {
      version: 'v1',
      tables: [
        {
          rowCount: 1,
          colCount: 2,
          colWidthsPx: [80, 120],
          cells: [
            { row: 0, col: 0, text: 'A', rowspan: 1, colspan: 1 },
            { row: 0, col: 1, text: 'B', rowspan: 1, colspan: 1 },
          ],
        },
      ],
      diagnostics: [],
    };

    const html = buildMxlPreviewHtml({
      webview: mockWebview,
      filePath: 'table/file.mxl',
      sourceFormat: 'mxl',
      model,
    });

    assert.ok(html.includes('<colgroup><col style="width:80px"><col style="width:120px"></colgroup>'));
    assert.ok(html.includes('<table class="mxl-table" style="table-layout:fixed;width:200px">'));
  });

  test('base td CSS includes overflow:hidden', () => {
    const model: MxlRenderModel = {
      version: 'v1',
      tables: [
        {
          rowCount: 1,
          colCount: 1,
          cells: [{ row: 0, col: 0, text: 'A', rowspan: 1, colspan: 1 }],
        },
      ],
      diagnostics: [],
    };

    const html = buildMxlPreviewHtml({
      webview: mockWebview,
      filePath: 'table/file.mxl',
      sourceFormat: 'mxl',
      model,
    });

    assert.ok(html.includes('overflow: hidden'));
  });
});
