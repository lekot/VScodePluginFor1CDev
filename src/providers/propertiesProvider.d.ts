import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { MetadataTreeDataProvider } from './treeDataProvider';
/**
 * Properties View Provider for displaying and editing element properties
 */
export declare class PropertiesProvider {
    private context;
    private treeDataProvider;
    private panel;
    private currentNode;
    private disposables;
    constructor(context: vscode.ExtensionContext, treeDataProvider: MetadataTreeDataProvider);
    /**
     * Show properties for a tree node
     * Creates new panel or reuses existing one (singleton pattern)
     */
    showProperties(node: TreeNode): Promise<void>;
    /**
     * Create webview panel with proper configuration
     */
    private createPanel;
    /**
     * Update webview content with current node
     */
    private updateWebviewContent;
    /**
     * Generate HTML content for webview
     */
    private getWebviewContent;
    /**
     * Generate empty state HTML when no element is selected
     */
    private getEmptyStateContent;
    /**
     * Render properties as input fields
     */
    private renderProperties;
    /**
     * Render a single property input field
     */
    private renderPropertyInput;
    /**
     * Detect property type from value
     */
    private detectPropertyType;
    /**
     * Generate webview JavaScript for client-side interaction
     */
    private getWebviewScript;
    /**
     * Handle messages from webview
     */
    private handleMessage;
    /**
     * Handle save message from webview
     */
    private handleSaveMessage;
    /**
     * Handle cancel message from webview
     */
    private handleCancelMessage;
    /**
     * Handle validate message from webview
     */
    private handleValidateMessage;
    /**
     * Save property changes to XML file
     */
    private saveProperties;
    /**
     * Validate property values
     */
    private validateProperties;
    /**
     * Get expected type for a property based on original value
     */
    private getExpectedType;
    /**
     * Check if a property is required
     */
    private isRequiredProperty;
    /**
     * Send message to webview
     */
    private postMessage;
    /**
     * Escape HTML to prevent XSS
     */
    private escapeHtml;
    /**
     * Dispose of resources and cleanup
     */
    dispose(): void;
}
//# sourceMappingURL=propertiesProvider.d.ts.map