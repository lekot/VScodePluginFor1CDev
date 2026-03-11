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
const logger_1 = require("../utils/logger");
/**
 * Tree Data Provider for VS Code Tree View
 */
class MetadataTreeDataProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.rootNode = null;
        logger_1.Logger.info('MetadataTreeDataProvider initialized');
    }
    /**
     * Set root node and refresh tree
     */
    setRootNode(node) {
        this.rootNode = node;
        this.refresh();
    }
    /**
     * Refresh tree view
     */
    refresh() {
        logger_1.Logger.debug('Refreshing tree view');
        this._onDidChangeTreeData.fire();
    }
    /**
     * Get tree item for a node
     */
    getTreeItem(element) {
        const treeItem = new vscode.TreeItem(element.name, element.children && element.children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        treeItem.contextValue = element.type;
        treeItem.tooltip = `${element.type}: ${element.name}`;
        return treeItem;
    }
    /**
     * Get children for a node
     */
    getChildren(element) {
        if (!element) {
            return Promise.resolve(this.rootNode ? [this.rootNode] : []);
        }
        return Promise.resolve(element.children || []);
    }
    /**
     * Get parent for a node
     */
    getParent(element) {
        return element.parent || null;
    }
}
exports.MetadataTreeDataProvider = MetadataTreeDataProvider;
//# sourceMappingURL=treeDataProvider.js.map