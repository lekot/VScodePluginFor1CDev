import * as vscode from 'vscode';
import { TreeNode, MetadataType } from '../models/treeNode';
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
  private nodeCache = new Map<string, TreeNode>();

  constructor(_context: vscode.ExtensionContext) {
    Logger.info('MetadataTreeDataProvider initialized');
  }

  /**
   * Set root node and refresh tree
   */
  setRootNode(node: TreeNode): void {
    if (!node) {
      Logger.error('Cannot set null or undefined root node');
      return;
    }
    this.rootNode = node;
    this.buildCache(node);
    this.refresh();
  }

  /**
   * Build cache for fast node lookup
   */
  private buildCache(node: TreeNode): void {
    this.nodeCache.set(node.id, node);
    if (node.children) {
      for (const child of node.children) {
        this.buildCache(child);
      }
    }
  }

  /**
   * Refresh tree view
   */
  refresh(element?: TreeNode): void {
    Logger.debug('Refreshing tree view', element ? element.name : 'root');
    this._onDidChangeTreeData.fire(element);
  }

  /**
   * Get tree item for a node
   */
  getTreeItem(element: TreeNode): vscode.TreeItem {
    try {
      // Determine collapsible state
      const hasChildren = element.children && element.children.length > 0;
      const collapsibleState = hasChildren
        ? element.isExpanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

      const treeItem = new vscode.TreeItem(element.name, collapsibleState);

      // Set context value for context menu
      treeItem.contextValue = element.type;

      // Set tooltip with additional information
      const synonym = element.properties.synonym as string | undefined;
      treeItem.tooltip = synonym
        ? `${element.type}: ${element.name}\nСиноним: ${synonym}`
        : `${element.type}: ${element.name}`;

      // Set description (shown next to the label)
      if (synonym) {
        treeItem.description = synonym;
      }

      // Set icon based on metadata type
      treeItem.iconPath = this.getIconForType(element.type);

      // Remove default file open command - selection will trigger properties panel instead
      // Context menu will provide "Open XML" option for direct file access

      // Set resource URI for file operations
      if (element.filePath) {
        treeItem.resourceUri = vscode.Uri.file(element.filePath);
      }

      return treeItem;
    } catch (error) {
      Logger.error('Error creating tree item', error);
      // Return minimal tree item on error
      return new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    }
  }

  /**
   * Get children for a node (lazy loading)
   */
  getChildren(element?: TreeNode): Thenable<TreeNode[]> {
    try {
      if (!element) {
        // Return root node
        return Promise.resolve(this.rootNode ? [this.rootNode] : []);
      }

      // Return children (lazy loading - children are already parsed)
      return Promise.resolve(element.children || []);
    } catch (error) {
      Logger.error('Error getting children', error);
      return Promise.resolve([]);
    }
  }

  /**
   * Get parent for a node
   */
  getParent(element: TreeNode): vscode.ProviderResult<TreeNode> {
    return element.parent || null;
  }

  /**
   * Get icon for metadata type
   */
  private getIconForType(type: MetadataType): vscode.ThemeIcon {
    // Map metadata types to VS Code built-in icons
    const iconMap: Record<MetadataType, string> = {
      // Root
      [MetadataType.Configuration]: 'package',

      // Main types
      [MetadataType.Catalog]: 'book',
      [MetadataType.Document]: 'file-text',
      [MetadataType.Enum]: 'symbol-enum',
      [MetadataType.Report]: 'graph',
      [MetadataType.DataProcessor]: 'gear',
      [MetadataType.ChartOfCharacteristicTypes]: 'symbol-class',
      [MetadataType.ChartOfAccounts]: 'symbol-numeric',
      [MetadataType.ChartOfCalculationTypes]: 'calculator',
      [MetadataType.InformationRegister]: 'database',
      [MetadataType.AccumulationRegister]: 'archive',
      [MetadataType.AccountingRegister]: 'symbol-ruler',
      [MetadataType.CalculationRegister]: 'symbol-operator',
      [MetadataType.BusinessProcess]: 'git-branch',
      [MetadataType.Task]: 'checklist',
      [MetadataType.ExternalDataSource]: 'cloud',
      [MetadataType.Constant]: 'symbol-constant',
      [MetadataType.SessionParameter]: 'symbol-parameter',
      [MetadataType.FilterCriterion]: 'filter',
      [MetadataType.ScheduledJob]: 'watch',
      [MetadataType.FunctionalOption]: 'symbol-boolean',
      [MetadataType.FunctionalOptionsParameter]: 'symbol-variable',
      [MetadataType.SettingsStorage]: 'save',
      [MetadataType.EventSubscription]: 'bell',
      [MetadataType.CommonModule]: 'symbol-module',
      [MetadataType.CommandGroup]: 'folder',
      [MetadataType.Command]: 'terminal',
      [MetadataType.Role]: 'shield',
      [MetadataType.Interface]: 'symbol-interface',
      [MetadataType.Style]: 'paintcan',
      [MetadataType.WebService]: 'globe',
      [MetadataType.HTTPService]: 'server',
      [MetadataType.IntegrationService]: 'plug',
      [MetadataType.Subsystem]: 'folder-library',

      // Sub-elements
      [MetadataType.Attribute]: 'symbol-field',
      [MetadataType.TabularSection]: 'table',
      [MetadataType.Form]: 'layout',
      [MetadataType.Template]: 'file-code',
      [MetadataType.CommandSubElement]: 'symbol-method',
      [MetadataType.Recurrence]: 'sync',
      [MetadataType.Method]: 'symbol-method',
      [MetadataType.Parameter]: 'symbol-parameter',

      // Extensions
      [MetadataType.Extension]: 'extensions',

      // Unknown
      [MetadataType.Unknown]: 'question',
    };

    const iconName = iconMap[type] || 'file';
    return new vscode.ThemeIcon(iconName);
  }

  /**
   * Find node by ID (uses cache for performance)
   */
  findNodeById(id: string): TreeNode | null {
    return this.nodeCache.get(id) || null;
  }

  /**
   * Expand node
   */
  expandNode(node: TreeNode): void {
    node.isExpanded = true;
    this.refresh(node);
  }

  /**
   * Collapse node
   */
  collapseNode(node: TreeNode): void {
    node.isExpanded = false;
    this.refresh(node);
  }
}
