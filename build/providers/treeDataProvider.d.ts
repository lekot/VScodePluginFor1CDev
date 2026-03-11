import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
/**
 * Tree Data Provider for VS Code Tree View
 */
export declare class MetadataTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void>;
    private rootNode;
    constructor();
    /**
     * Set root node and refresh tree
     */
    setRootNode(node: TreeNode): void;
    /**
     * Refresh tree view
     */
    refresh(): void;
    /**
     * Get tree item for a node
     */
    getTreeItem(element: TreeNode): vscode.TreeItem;
    /**
     * Get children for a node
     */
    getChildren(element?: TreeNode): Thenable<TreeNode[]>;
    /**
     * Get parent for a node
     */
    getParent(element: TreeNode): vscode.ProviderResult<TreeNode>;
}
//# sourceMappingURL=treeDataProvider.d.ts.map