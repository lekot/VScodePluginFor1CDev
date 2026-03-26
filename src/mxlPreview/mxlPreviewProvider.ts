import * as vscode from 'vscode';

class MxlPreviewDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {}
}

/**
 * Readonly MXL preview provider (P1 scaffold).
 * Real MXL parsing/rendering is implemented in later phases.
 */
export class MxlPreviewProvider implements vscode.CustomReadonlyEditorProvider<MxlPreviewDocument> {
  openCustomDocument(uri: vscode.Uri): MxlPreviewDocument {
    return new MxlPreviewDocument(uri);
  }

  async resolveCustomEditor(
    document: MxlPreviewDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: false };
    webviewPanel.title = `MXL Preview: ${vscode.workspace.asRelativePath(document.uri, false)}`;
    webviewPanel.webview.html = this.getStubHtml(document.uri);
  }

  private getStubHtml(uri: vscode.Uri): string {
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    const escapedPath = this.escapeHtml(relativePath);
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
    <p class="title">MXL preview loading...</p>
    <p class="subtitle">Stub provider is active for <code>${escapedPath}</code>.</p>
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
