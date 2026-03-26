import * as vscode from 'vscode';
import { MxlDiagnostic, MxlRenderCell, MxlRenderModel, MxlRenderTable } from './mxlRenderModel';

const MAX_DIAGNOSTICS_IN_HTML = 50;

export interface MxlWebviewHtmlInput {
  webview: vscode.Webview;
  filePath: string;
  sourceFormat: string;
  model: MxlRenderModel;
}

export interface MxlParserErrorHtmlInput {
  webview: vscode.Webview;
  filePath: string;
  sourceFormat: string;
  diagnostics: MxlDiagnostic[];
}

export function buildMxlPreviewHtml(input: MxlWebviewHtmlInput): string {
  const escapedPath = escapeHtml(input.filePath);
  const escapedFormat = escapeHtml(input.sourceFormat);
  const diagnosticsHtml = renderDiagnostics(input.model.diagnostics);
  const tablesHtml = renderTables(input.model.tables);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${input.webview.cspSource} data:; style-src ${input.webview.cspSource} 'unsafe-inline';">
  <title>MXL Preview</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .container {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px 14px;
      background: var(--vscode-sideBar-background);
    }
    .title {
      margin: 0 0 8px 0;
      font-size: 13px;
      font-weight: 600;
    }
    .subtitle {
      margin: 0 0 8px 0;
      opacity: 0.92;
      font-size: 12px;
      line-height: 1.4;
    }
    .meta {
      margin: 0 0 12px 0;
      display: grid;
      gap: 4px;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-editor-background);
      margin: 0 0 12px 0;
      max-width: 100%;
    }
    table.mxl-table {
      border-collapse: collapse;
      table-layout: fixed;
    }
    table.mxl-table td {
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 6px;
      vertical-align: top;
      font-size: 12px;
      white-space: normal;
      overflow-wrap: break-word;
    }
    table.mxl-table td.empty {
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
    }
    .table-title {
      margin: 10px 0 6px 0;
      font-size: 12px;
      font-weight: 600;
    }
    .empty-state {
      padding: 14px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 12px;
      opacity: 0.9;
      margin: 0 0 12px 0;
    }
    .diagnostics {
      margin-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 8px;
    }
    ul {
      margin: 6px 0 0 18px;
      padding: 0;
      font-size: 12px;
      line-height: 1.4;
    }
    code {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <p class="title">MXL Preview</p>
    <div class="meta">
      <p class="subtitle">File: <code>${escapedPath}</code></p>
      <p class="subtitle">Detected format: <b>${escapedFormat}</b></p>
      <p class="subtitle">Mode: readonly</p>
    </div>
    ${tablesHtml}
    ${diagnosticsHtml}
  </div>
</body>
</html>`;
}

export function buildMxlErrorHtml(webview: vscode.Webview, filePath: string, err: unknown): string {
  const escapedPath = escapeHtml(filePath);
  const escapedError = escapeHtml(err instanceof Error ? err.message : String(err));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline';">
  <title>MXL Preview</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .container {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px 14px;
      background: var(--vscode-sideBar-background);
    }
    .title {
      margin: 0 0 8px 0;
      font-size: 13px;
      font-weight: 600;
    }
    .subtitle {
      margin: 0;
      opacity: 0.9;
      font-size: 12px;
      line-height: 1.4;
    }
    code {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <p class="title">MXL preview error</p>
    <p class="subtitle">Failed to load <code>${escapedPath}</code>.</p>
    <p class="subtitle"><code>${escapedError}</code></p>
  </div>
</body>
</html>`;
}

export function buildMxlParserErrorHtml(input: MxlParserErrorHtmlInput): string {
  const escapedPath = escapeHtml(input.filePath);
  const escapedFormat = escapeHtml(input.sourceFormat);
  const diagnosticsHtml = renderDiagnostics(input.diagnostics);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${input.webview.cspSource} data:; style-src ${input.webview.cspSource} 'unsafe-inline';">
  <title>MXL Preview</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .container {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px 14px;
      background: var(--vscode-sideBar-background);
    }
    .title {
      margin: 0 0 8px 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-errorForeground);
    }
    .subtitle {
      margin: 0 0 8px 0;
      opacity: 0.92;
      font-size: 12px;
      line-height: 1.4;
    }
    code {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <p class="title">MXL preview unavailable</p>
    <p class="subtitle">File: <code>${escapedPath}</code></p>
    <p class="subtitle">Detected format: <b>${escapedFormat}</b></p>
    <p class="subtitle">Parser reported blocking errors. Try opening the source as text/XML and validate encoding/XML structure.</p>
    ${diagnosticsHtml}
  </div>
</body>
</html>`;
}

function renderTables(tables: MxlRenderTable[]): string {
  if (tables.length === 0) {
    return '<div class="empty-state">No supported table nodes found in this MXL document.</div>';
  }

  return tables
    .map((table, index) => `<p class="table-title">Table ${index + 1}</p><div class="table-wrap">${renderTable(table)}</div>`)
    .join('');
}

function renderColgroup(table: MxlRenderTable, colCount: number): { html: string; totalWidth: number } {
  if (!table.colWidthsPx || table.colWidthsPx.length === 0) {
    return { html: '', totalWidth: 0 };
  }
  let totalWidth = 0;
  const cols = Array.from({ length: colCount }, (_, i) => {
    const w = table.colWidthsPx![i];
    const px = w !== undefined && w > 0 ? w : 60;
    totalWidth += px;
    return `<col style="width:${px}px">`;
  });
  return { html: `<colgroup>${cols.join('')}</colgroup>`, totalWidth };
}

function renderTable(table: MxlRenderTable): string {
  const matrix = indexCells(table);
  const rowCount = matrix.rowCount;
  const colCount = matrix.colCount;
  if (rowCount === 0 || colCount === 0) {
    return '<div class="empty-state">Table is empty.</div>';
  }

  const rows: string[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const cols: string[] = [];
    for (let col = 0; col < colCount; col += 1) {
      const key = cellKey(row, col);
      if (matrix.covered.has(key)) {
        continue;
      }
      const cell = matrix.anchors.get(key);
      if (!cell) {
        cols.push('<td class="empty"></td>');
        continue;
      }
      const attrs = `${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''}${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ''}`;
      const style = buildCellStyle(cell);
      cols.push(`<td${attrs}${style ? ` style="${style}"` : ''}>${escapeHtml(cell.text)}</td>`);
    }
    rows.push(`<tr>${cols.join('')}</tr>`);
  }

  const { html: colgroupHtml, totalWidth } = renderColgroup(table, colCount);
  const tableStyle = totalWidth > 0 ? ` style="width:${totalWidth}px"` : '';
  return `<table class="mxl-table"${tableStyle}>${colgroupHtml}<tbody>${rows.join('')}</tbody></table>`;
}

function indexCells(table: MxlRenderTable): {
  anchors: Map<string, MxlRenderCell>;
  covered: Set<string>;
  rowCount: number;
  colCount: number;
} {
  const anchors = new Map<string, MxlRenderCell>();
  const covered = new Set<string>();
  let maxRow = Math.max(0, table.rowCount);
  let maxCol = Math.max(0, table.colCount);

  table.cells.forEach((cell) => {
    const row = Math.max(0, cell.row);
    const col = Math.max(0, cell.col);
    const rowspan = Math.max(1, cell.rowspan);
    const colspan = Math.max(1, cell.colspan);
    const normalized: MxlRenderCell = { ...cell, row, col, rowspan, colspan };
    anchors.set(cellKey(row, col), normalized);

    for (let r = row; r < row + rowspan; r += 1) {
      for (let c = col; c < col + colspan; c += 1) {
        if (r === row && c === col) {
          continue;
        }
        covered.add(cellKey(r, c));
      }
    }
    maxRow = Math.max(maxRow, row + rowspan);
    maxCol = Math.max(maxCol, col + colspan);
  });

  return { anchors, covered, rowCount: maxRow, colCount: maxCol };
}

function renderDiagnostics(diagnostics: MxlDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return '<p class="subtitle">Diagnostics: no warnings.</p>';
  }
  const lines = diagnostics
    .slice(0, MAX_DIAGNOSTICS_IN_HTML)
    .map((diag) => {
      const path = diag.path ? ` (${escapeHtml(diag.path)})` : '';
      const level = escapeHtml(diag.level.toUpperCase());
      const message = escapeHtml(diag.message);
      return `<li><b>${level}</b> [${escapeHtml(diag.code)}] ${message}${path}</li>`;
    })
    .join('');

  const note =
    diagnostics.length > MAX_DIAGNOSTICS_IN_HTML
      ? `<p class="subtitle">Diagnostics are truncated: showing ${MAX_DIAGNOSTICS_IN_HTML} of ${diagnostics.length}.</p>`
      : '';
  return `<div class="diagnostics">
      <p class="subtitle">Diagnostics:</p>
      <ul>${lines}</ul>
      ${note}
    </div>`;
}

function buildCellStyle(cell: MxlRenderCell): string {
  const style = cell.style;
  if (!style) {
    return '';
  }

  const declarations: string[] = [];
  const fontFamily = sanitizeFontFamily(style.fontFamily);
  if (fontFamily) {
    declarations.push(`font-family:${fontFamily}`);
  }
  if (typeof style.fontSizePt === 'number' && Number.isFinite(style.fontSizePt) && style.fontSizePt > 0) {
    declarations.push(`font-size:${Math.min(72, Math.max(6, style.fontSizePt))}pt`);
  }
  if (style.bold === true) {
    declarations.push('font-weight:700');
  }
  if (style.italic === true) {
    declarations.push('font-style:italic');
  }

  const textAlign = normalizeAlign(style.horizontalAlign, 'horizontal');
  if (textAlign) {
    declarations.push(`text-align:${textAlign}`);
  }
  const verticalAlign = normalizeAlign(style.verticalAlign, 'vertical');
  if (verticalAlign) {
    declarations.push(`vertical-align:${verticalAlign}`);
  }

  const background = sanitizeColor(style.backgroundColor);
  if (background) {
    declarations.push(`background-color:${background}`);
  }
  const border = sanitizeBorder(style.border);
  if (border) {
    declarations.push(`border:${border}`);
  }

  return declarations.join(';');
}

function sanitizeFontFamily(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  // font-family value goes into HTML attribute `style="..."`, so we must not allow `"` to
  // break the attribute boundary (CSP/escaping hardening).
  if (trimmed.includes('"')) {
    return undefined;
  }
  return /^[A-Za-z0-9 _\-,']{1,80}$/.test(trimmed) ? trimmed : undefined;
}

function sanitizeColor(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^#[0-9A-Fa-f]{3,8}$/.test(trimmed) || /^[a-zA-Z]{3,20}$/.test(trimmed) ? trimmed : undefined;
}

function sanitizeBorder(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^[A-Za-z0-9#().,%\- ]{1,60}$/.test(trimmed) ? trimmed : undefined;
}

function normalizeAlign(value: string | undefined, type: 'horizontal' | 'vertical'): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (type === 'horizontal') {
    if (normalized.includes('left') || normalized.includes('лев')) {
      return 'left';
    }
    if (normalized.includes('right') || normalized.includes('прав')) {
      return 'right';
    }
    if (normalized.includes('center') || normalized.includes('centr') || normalized.includes('центр')) {
      return 'center';
    }
    if (normalized.includes('justify')) {
      return 'justify';
    }
    return undefined;
  }
  if (normalized.includes('top') || normalized.includes('верх')) {
    return 'top';
  }
  if (normalized.includes('bottom') || normalized.includes('низ')) {
    return 'bottom';
  }
  if (normalized.includes('middle') || normalized.includes('center') || normalized.includes('центр')) {
    return 'middle';
  }
  return undefined;
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
