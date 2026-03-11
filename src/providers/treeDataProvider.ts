import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { Logger } from '../utils/logger';

/**
 * Tree Data Provider for VS Code Tree View
 */
export class MetadataTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> =
    new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private rootNode: TreeNode | null = null;

  constructor() {
    Logger.info('MetadataTreeDataProvider initialized');
  }

  /**
   * Set root node and refresh tree
   */
  setRootNode(node: TreeNode): void {
    this.rootNode = node;
    this.refresh();
  }

  /**
   * Refresh tree view
   */
  refresh(): void {
    Logger.debug('Refreshing tree view');
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get tree item for a node
   */
  getTreeItem(element: TreeNode): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(
      element.name,
      element.children && element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    treeItem.contextValue = element.type;
    treeItem.tooltip = `${element.type}: ${element.name}`;

    return treeItem;
  }

  /**
   * Get children for a node
   */
  getChildren(element?: TreeNode): Thenable<TreeNode[]> {
    if (!element) {
      return Promise.resolve(this.rootNode ? [this.rootNode] : []);
    }

    return Promise.resolve(element.children || []);
  }

  /**
   * Get parent for a node
   */
  getParent(element: TreeNode): vscode.ProviderResult<TreeNode> {
    return element.parent || null;
  }
}
