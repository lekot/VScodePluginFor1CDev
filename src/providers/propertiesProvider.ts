import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { Logger } from '../utils/logger';

/**
 * Properties View Provider for displaying element properties
 */
export class PropertiesProvider {
  private webviewPanel: vscode.WebviewPanel | null = null;
  private selectedNode: TreeNode | null = null;

  constructor(private context: vscode.ExtensionContext) {
    Logger.info('PropertiesProvider initialized');
  }

  /**
   * Show properties for a node
   */
  showProperties(node: TreeNode): void {
    this.selectedNode = node;

    if (!this.webviewPanel) {
      this.createWebviewPanel();
    }

    this.updateWebviewContent();
  }

  /**
   * Create webview panel for properties
   */
  private createWebviewPanel(): void {
    this.webviewPanel = vscode.window.createWebviewPanel(
      '1c-metadata-properties',
      '1C Metadata Properties',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [this.context.extensionUri],
      }
    );

    this.webviewPanel.onDidDispose(() => {
      this.webviewPanel = null;
    });
  }

  /**
   * Update webview content
   */
  private updateWebviewContent(): void {
    if (!this.webviewPanel || !this.selectedNode) {
      return;
    }

    const html = this.getWebviewContent(this.selectedNode);
    this.webviewPanel.webview.html = html;
  }

  /**
   * Generate HTML content for webview
   */
  private getWebviewContent(node: TreeNode): string {
    const properties = node.properties || {};

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Properties</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 10px;
          }
          .property {
            margin-bottom: 10px;
          }
          .property-label {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
          }
          .property-value {
            margin-left: 10px;
            color: var(--vscode-foreground);
          }
        </style>
      </head>
      <body>
        <h2>${node.name}</h2>
        <p><strong>Type:</strong> ${node.type}</p>
        <div id="properties">
          ${Object.entries(properties)
            .map(
              ([key, value]) => `
            <div class="property">
              <span class="property-label">${key}:</span>
              <span class="property-value">${String(value)}</span>
            </div>
          `
            )
            .join('')}
        </div>
      </body>
      </html>
    `;
  }
}
