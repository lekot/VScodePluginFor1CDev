import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
/**
 * Tree Data Provider for VS Code Tree View
 */
export declare class MetadataTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void>;
    private rootNode;
    private nodeCache;
    constructor(_context: vscode.ExtensionContext);
    /**
     * Set root node and refresh tree
     */
    setRootNode(node: TreeNode): void;
    /**
     * Build cache for fast node lookup
     */
    private buildCache;
    /**
     * Refresh tree view
     */
    refresh(element?: TreeNode): void;
    /**
     * Get tree item for a node
     */
    getTreeItem(element: TreeNode): vscode.TreeItem;
    /**
     * Get children for a node (lazy loading)
     */
    getChildren(element?: TreeNode): Thenable<TreeNode[]>;
    /**
     * Get parent for a node
     */
    getParent(element: TreeNode): vscode.ProviderResult<TreeNode>;
    /**
     * Get icon for metadata type
     */
    private getIconForType;
    /**
     * Find node by ID (uses cache for performance)
     */
    findNodeById(id: string): TreeNode | null;
    /**
     * Expand node
     */
    expandNode(node: TreeNode): void;
    /**
     * Collapse node
     */
    collapseNode(node: TreeNode): void;
}
//# sourceMappingURL=treeDataProvider.d.ts.map