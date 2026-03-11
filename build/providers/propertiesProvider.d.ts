import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
/**
 * Properties View Provider for displaying element properties
 */
export declare class PropertiesProvider {
    private context;
    private webviewPanel;
    private selectedNode;
    constructor(context: vscode.ExtensionContext);
    /**
     * Show properties for a node
     */
    showProperties(node: TreeNode): void;
    /**
     * Create webview panel for properties
     */
    private createWebviewPanel;
    /**
     * Update webview content
     */
    private updateWebviewContent;
    /**
     * Generate HTML content for webview
     */
    private getWebviewContent;
}
//# sourceMappingURL=propertiesProvider.d.ts.map