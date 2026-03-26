import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { MxlLoadResult, MxlLoaderService } from './mxlLoaderService';
import { MxlDiagnostic } from './mxlRenderModel';

class MxlPreviewDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {}
}

/**
 * Readonly MXL preview provider (P1 scaffold).
 * Real MXL parsing/rendering is implemented in later phases.
 */
export class MxlPreviewProvider implements vscode.CustomReadonlyEditorProvider<MxlPreviewDocument> {
  private readonly loader = new MxlLoaderService();

  openCustomDocument(uri: vscode.Uri): MxlPreviewDocument {
    return new MxlPreviewDocument(uri);
  }

  async resolveCustomEditor(
    document: MxlPreviewDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: false };
    webviewPanel.title = `MXL Preview: ${vscode.workspace.asRelativePath(document.uri, false)}`;
    try {
      const loaded = await this.loader.loadFromUri(document.uri);
      webviewPanel.webview.html = this.getPreviewHtml(loaded);
    } catch (err) {
      Logger.error('Failed to load MXL preview', err);
      webviewPanel.webview.html = this.getErrorHtml(document.uri, err);
    }
  }

  private getPreviewHtml(result: MxlLoadResult): string {
    const relativePath = vscode.workspace.asRelativePath(result.uri, false);
    const escapedPath = this.escapeHtml(relativePath);
    const table = result.model.tables[0];
    const diagnostics = this.renderDiagnostics(result.model.diagnostics);
    const tableSummary = table
      ? `<p class="subtitle">Table: <b>${table.rowCount}</b> rows x <b>${table.colCount}</b> cols, cells: <b>${table.cells.length}</b>.</p>`
      : '<p class="subtitle">No supported table nodes parsed yet (v1 subset).</p>';
    const previewCells = table
      ? table.cells
          .slice(0, 12)
          .map((cell) => {
            const text = this.escapeHtml(cell.text || '');
            const merge =
              cell.rowspan > 1 || cell.colspan > 1
                ? ` rowspan=${cell.rowspan}, colspan=${cell.colspan}`
                : '';
            return `<li>[r${cell.row + 1} c${cell.col + 1}] <code>${text || '(empty)'}</code>${merge}</li>`;
          })
          .join('')
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
      margin: 0 0 6px 0;
      opacity: 0.9;
      font-size: 12px;
      line-height: 1.4;
    }
    ul {
      margin: 8px 0 0 18px;
      padding: 0;
      font-size: 12px;
      line-height: 1.4;
    }
    .warn {
      margin-top: 10px;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 8px;
    }
    code {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <p class="title">MXL preview (P2 parser skeleton)</p>
    <p class="subtitle">File: <code>${escapedPath}</code></p>
    <p class="subtitle">Detected format: <b>${result.sourceFormat}</b>.</p>
    ${tableSummary}
    ${previewCells ? `<ul>${previewCells}</ul>` : ''}
    ${diagnostics}
  </div>
</body>
</html>`;
  }

  private renderDiagnostics(diagnostics: MxlDiagnostic[]): string {
    if (diagnostics.length === 0) {
      return '<p class="subtitle">Diagnostics: no warnings.</p>';
    }
    const lines = diagnostics
      .slice(0, 20)
      .map((diag) => {
        const suffix = diag.path ? ` (${this.escapeHtml(diag.path)})` : '';
        return `<li><b>${diag.level.toUpperCase()}</b> ${this.escapeHtml(diag.message)}${suffix}</li>`;
      })
      .join('');
    const note =
      diagnostics.length > 20
        ? `<p class="subtitle">Diagnostics are truncated: showing 20 of ${diagnostics.length}.</p>`
        : '';
    return `<div class="warn">
      <p class="subtitle">Diagnostics:</p>
      <ul>${lines}</ul>
      ${note}
    </div>`;
  }

  private getErrorHtml(uri: vscode.Uri, err: unknown): string {
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    const escapedPath = this.escapeHtml(relativePath);
    const escapedError = this.escapeHtml(err instanceof Error ? err.message : String(err));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
