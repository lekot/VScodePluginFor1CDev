"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetadataTreeDataProvider = void 0;
const vscode = __importStar(require("vscode"));
const treeNode_1 = require("../models/treeNode");
const logger_1 = require("../utils/logger");
/**
 * Tree Data Provider for VS Code Tree View
 */
class MetadataTreeDataProvider {
    constructor(_context) {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.rootNode = null;
        this.nodeCache = new Map();
        logger_1.Logger.info('MetadataTreeDataProvider initialized');
    }
    /**
     * Set root node and refresh tree
     */
    setRootNode(node) {
        if (!node) {
            logger_1.Logger.error('Cannot set null or undefined root node');
            return;
        }
        this.rootNode = node;
        this.buildCache(node);
        this.refresh();
    }
    /**
     * Build cache for fast node lookup
     */
    buildCache(node) {
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
    refresh(element) {
        logger_1.Logger.debug('Refreshing tree view', element ? element.name : 'root');
        this._onDidChangeTreeData.fire(element);
    }
    /**
     * Get tree item for a node
     */
    getTreeItem(element) {
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
            const synonym = element.properties.synonym;
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
        }
        catch (error) {
            logger_1.Logger.error('Error creating tree item', error);
            // Return minimal tree item on error
            return new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
        }
    }
    /**
     * Get children for a node (lazy loading)
     */
    getChildren(element) {
        try {
            if (!element) {
                // Return root node
                return Promise.resolve(this.rootNode ? [this.rootNode] : []);
            }
            // Return children (lazy loading - children are already parsed)
            return Promise.resolve(element.children || []);
        }
        catch (error) {
            logger_1.Logger.error('Error getting children', error);
            return Promise.resolve([]);
        }
    }
    /**
     * Get parent for a node
     */
    getParent(element) {
        return element.parent || null;
    }
    /**
     * Get icon for metadata type
     */
    getIconForType(type) {
        // Map metadata types to VS Code built-in icons
        const iconMap = {
            // Root
            [treeNode_1.MetadataType.Configuration]: 'package',
            // Main types
            [treeNode_1.MetadataType.Catalog]: 'book',
            [treeNode_1.MetadataType.Document]: 'file-text',
            [treeNode_1.MetadataType.Enum]: 'symbol-enum',
            [treeNode_1.MetadataType.Report]: 'graph',
            [treeNode_1.MetadataType.DataProcessor]: 'gear',
            [treeNode_1.MetadataType.ChartOfCharacteristicTypes]: 'symbol-class',
            [treeNode_1.MetadataType.ChartOfAccounts]: 'symbol-numeric',
            [treeNode_1.MetadataType.ChartOfCalculationTypes]: 'calculator',
            [treeNode_1.MetadataType.InformationRegister]: 'database',
            [treeNode_1.MetadataType.AccumulationRegister]: 'archive',
            [treeNode_1.MetadataType.AccountingRegister]: 'symbol-ruler',
            [treeNode_1.MetadataType.CalculationRegister]: 'symbol-operator',
            [treeNode_1.MetadataType.BusinessProcess]: 'git-branch',
            [treeNode_1.MetadataType.Task]: 'checklist',
            [treeNode_1.MetadataType.ExternalDataSource]: 'cloud',
            [treeNode_1.MetadataType.Constant]: 'symbol-constant',
            [treeNode_1.MetadataType.SessionParameter]: 'symbol-parameter',
            [treeNode_1.MetadataType.FilterCriterion]: 'filter',
            [treeNode_1.MetadataType.ScheduledJob]: 'watch',
            [treeNode_1.MetadataType.FunctionalOption]: 'symbol-boolean',
            [treeNode_1.MetadataType.FunctionalOptionsParameter]: 'symbol-variable',
            [treeNode_1.MetadataType.SettingsStorage]: 'save',
            [treeNode_1.MetadataType.EventSubscription]: 'bell',
            [treeNode_1.MetadataType.CommonModule]: 'symbol-module',
            [treeNode_1.MetadataType.CommandGroup]: 'folder',
            [treeNode_1.MetadataType.Command]: 'terminal',
            [treeNode_1.MetadataType.Role]: 'shield',
            [treeNode_1.MetadataType.Interface]: 'symbol-interface',
            [treeNode_1.MetadataType.Style]: 'paintcan',
            [treeNode_1.MetadataType.WebService]: 'globe',
            [treeNode_1.MetadataType.HTTPService]: 'server',
            [treeNode_1.MetadataType.IntegrationService]: 'plug',
            [treeNode_1.MetadataType.Subsystem]: 'folder-library',
            // Sub-elements
            [treeNode_1.MetadataType.Attribute]: 'symbol-field',
            [treeNode_1.MetadataType.TabularSection]: 'table',
            [treeNode_1.MetadataType.Form]: 'layout',
            [treeNode_1.MetadataType.Template]: 'file-code',
            [treeNode_1.MetadataType.CommandSubElement]: 'symbol-method',
            [treeNode_1.MetadataType.Recurrence]: 'sync',
            [treeNode_1.MetadataType.Method]: 'symbol-method',
            [treeNode_1.MetadataType.Parameter]: 'symbol-parameter',
            // Extensions
            [treeNode_1.MetadataType.Extension]: 'extensions',
            // Unknown
            [treeNode_1.MetadataType.Unknown]: 'question',
        };
        const iconName = iconMap[type] || 'file';
        return new vscode.ThemeIcon(iconName);
    }
    /**
     * Find node by ID (uses cache for performance)
     */
    findNodeById(id) {
        return this.nodeCache.get(id) || null;
    }
    /**
     * Expand node
     */
    expandNode(node) {
        node.isExpanded = true;
        this.refresh(node);
    }
    /**
     * Collapse node
     */
    collapseNode(node) {
        node.isExpanded = false;
        this.refresh(node);
    }
}
exports.MetadataTreeDataProvider = MetadataTreeDataProvider;
//# sourceMappingURL=treeDataProvider.js.map