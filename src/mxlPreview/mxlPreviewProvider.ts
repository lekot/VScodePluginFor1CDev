import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { MxlLoadResult, MxlLoaderService } from './mxlLoaderService';
import { MetadataType, TreeNode } from '../models/treeNode';
import { buildMxlErrorHtml, buildMxlParserErrorHtml, buildMxlPreviewHtml } from './mxlWebviewHtml';

class MxlPreviewDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {}
}

export class MxlPreviewProvider implements vscode.CustomReadonlyEditorProvider<MxlPreviewDocument> {
  private readonly loader = new MxlLoaderService();
  private static readonly OPEN_SOURCE_ACTION = 'Open source';
  private static readonly BLOCKING_PARSE_ERROR_CODES = new Set<string>([
    'MXL_XML_PARSE_ERROR',
    'MXL_EMPTY_INPUT',
    'MXL_ENCODING_DECODE_ERROR',
  ]);

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
      await this.handleBlockingDiagnostics(loaded);
    } catch (err) {
      Logger.error('Failed to load MXL preview', err);
      webviewPanel.webview.html = this.getErrorHtml(webviewPanel.webview, document.uri, err);
    }
  }

  private getPreviewHtml(webview: vscode.Webview, result: MxlLoadResult): string {
    const relativePath = vscode.workspace.asRelativePath(result.uri, false);
    const hasBlockingParseErrors = result.model.diagnostics.some(
      (diag) =>
        typeof diag.code === 'string' && MxlPreviewProvider.BLOCKING_PARSE_ERROR_CODES.has(diag.code)
    );
    if (hasBlockingParseErrors) {
      return buildMxlParserErrorHtml({
        webview,
        filePath: relativePath,
        sourceFormat: result.sourceFormat,
        diagnostics: result.model.diagnostics,
      });
    }
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

  private async handleBlockingDiagnostics(result: MxlLoadResult): Promise<void> {
    const hasBlockingParseErrors = result.model.diagnostics.some(
      (diag) =>
        typeof diag.code === 'string' && MxlPreviewProvider.BLOCKING_PARSE_ERROR_CODES.has(diag.code)
    );
    if (!hasBlockingParseErrors) {
      return;
    }
    const selection = await vscode.window.showWarningMessage(
      'MXL preview has blocking parser errors. Open source file as text/XML for inspection?',
      MxlPreviewProvider.OPEN_SOURCE_ACTION
    );
    if (selection !== MxlPreviewProvider.OPEN_SOURCE_ACTION) {
      return;
    }
    try {
      // Reuse existing openXML command logic (no duplicate open code).
      const fallbackNode: TreeNode = {
        id: 'MxlPreviewFallback',
        name: 'MxlPreviewFallback',
        type: MetadataType.Template,
        properties: {},
        filePath: result.uri.fsPath,
      };
      await vscode.commands.executeCommand('1c-metadata-tree.openXML', fallbackNode);
    } catch (err) {
      Logger.error('Failed to open source document for MXL parse fallback', err);
    }
  }
}
