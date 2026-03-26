import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { MxlLoadResult, MxlLoaderService } from './mxlLoaderService';
import { buildMxlErrorHtml, buildMxlPreviewHtml } from './mxlWebviewHtml';

class MxlPreviewDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {}
}

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
      webviewPanel.webview.html = this.getPreviewHtml(webviewPanel.webview, loaded);
    } catch (err) {
      Logger.error('Failed to load MXL preview', err);
      webviewPanel.webview.html = this.getErrorHtml(webviewPanel.webview, document.uri, err);
    }
  }

  private getPreviewHtml(webview: vscode.Webview, result: MxlLoadResult): string {
    const relativePath = vscode.workspace.asRelativePath(result.uri, false);
    return buildMxlPreviewHtml({
      webview,
      filePath: relativePath,
      sourceFormat: result.sourceFormat,
      model: result.model,
    });
  }

  private getErrorHtml(webview: vscode.Webview, uri: vscode.Uri, err: unknown): string {
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    return buildMxlErrorHtml(webview, relativePath, err);
  }
}
