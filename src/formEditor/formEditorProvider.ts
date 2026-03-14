/**
 * Custom editor provider for 1C form structure (Ext/Form.xml).
 * Slim entry point — delegates to formMessageHandler and formWebviewHtml.
 * Requirements: 1.6, 2.1, 2.2, 2.3, 2.4
 */

import * as vscode from 'vscode';
import type { FormModel } from './formModel';
import { handleMessage, type MessageHandlerContext } from './formMessageHandler';
import { getWebviewHtml } from './formWebviewHtml';
export { moveNodeInModel } from './formTreeOperations'; // backward compat

/** Minimal custom document for form editor. */
class FormEditorDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class FormEditorProvider implements vscode.CustomReadonlyEditorProvider<FormEditorDocument> {
  private documentModel = new Map<string, FormModel>();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): FormEditorDocument {
    return new FormEditorDocument(uri);
  }

  async resolveCustomEditor(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = getWebviewHtml(webviewPanel.webview);
    const ctx: MessageHandlerContext = {
      document,
      webviewPanel,
      documentModel: this.documentModel,
    };
    webviewPanel.webview.onDidReceiveMessage(async (msg) => handleMessage(ctx, msg));
  }
}
