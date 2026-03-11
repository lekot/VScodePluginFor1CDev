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
const assert = __importStar(require("assert"));
const vscode = __importStar(require("vscode"));
const treeDataProvider_1 = require("../../src/providers/treeDataProvider");
const treeNode_1 = require("../../src/models/treeNode");
suite('MetadataTreeDataProvider Test Suite', () => {
    let provider;
    let mockContext;
    setup(() => {
        // Create mock context
        mockContext = {
            subscriptions: [],
            extensionPath: '',
            extensionUri: vscode.Uri.file(''),
            globalState: {},
            workspaceState: {},
            secrets: {},
            storageUri: undefined,
            storagePath: undefined,
            globalStorageUri: vscode.Uri.file(''),
            globalStoragePath: '',
            logUri: vscode.Uri.file(''),
            logPath: '',
            extensionMode: vscode.ExtensionMode.Test,
            extension: {},
            environmentVariableCollection: {},
            languageModelAccessInformation: {},
            asAbsolutePath: (relativePath) => relativePath,
        };
        provider = new treeDataProvider_1.MetadataTreeDataProvider(mockContext);
    });
    test('Provider should be initialized', () => {
        assert.ok(provider);
    });
    test('getChildren should return empty array when no root node', async () => {
        const children = await provider.getChildren();
        assert.strictEqual(children.length, 0);
    });
    test('getChildren should return root node when set', async () => {
        const rootNode = {
            id: 'root',
            name: 'Configuration',
            type: treeNode_1.MetadataType.Configuration,
            properties: {},
            children: [],
        };
        provider.setRootNode(rootNode);
        const children = await provider.getChildren();
        assert.strictEqual(children.length, 1);
        assert.strictEqual(children[0].name, 'Configuration');
    });
    test('getChildren should return children of a node', async () => {
        const childNode = {
            id: 'child1',
            name: 'Catalog1',
            type: treeNode_1.MetadataType.Catalog,
            properties: {},
        };
        const rootNode = {
            id: 'root',
            name: 'Configuration',
            type: treeNode_1.MetadataType.Configuration,
            properties: {},
            children: [childNode],
        };
        provider.setRootNode(rootNode);
        const children = await provider.getChildren(rootNode);
        assert.strictEqual(children.length, 1);
        assert.strictEqual(children[0].name, 'Catalog1');
    });
    test('getTreeItem should return correct tree item', () => {
        const node = {
            id: 'test',
            name: 'TestNode',
            type: treeNode_1.MetadataType.Catalog,
            properties: { synonym: 'Test Synonym' },
        };
        const treeItem = provider.getTreeItem(node);
        assert.strictEqual(treeItem.label, 'TestNode');
        assert.strictEqual(treeItem.contextValue, treeNode_1.MetadataType.Catalog);
        assert.strictEqual(treeItem.description, 'Test Synonym');
    });
    test('getTreeItem should set collapsible state for nodes with children', () => {
        const node = {
            id: 'test',
            name: 'TestNode',
            type: treeNode_1.MetadataType.Catalog,
            properties: {},
            children: [
                {
                    id: 'child',
                    name: 'Child',
                    type: treeNode_1.MetadataType.Attribute,
                    properties: {},
                },
            ],
        };
        const treeItem = provider.getTreeItem(node);
        assert.strictEqual(treeItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    });
    test('getTreeItem should set none collapsible state for nodes without children', () => {
        const node = {
            id: 'test',
            name: 'TestNode',
            type: treeNode_1.MetadataType.Catalog,
            properties: {},
        };
        const treeItem = provider.getTreeItem(node);
        assert.strictEqual(treeItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
    });
    test('getParent should return parent node', () => {
        const parentNode = {
            id: 'parent',
            name: 'Parent',
            type: treeNode_1.MetadataType.Configuration,
            properties: {},
        };
        const childNode = {
            id: 'child',
            name: 'Child',
            type: treeNode_1.MetadataType.Catalog,
            properties: {},
            parent: parentNode,
        };
        const parent = provider.getParent(childNode);
        assert.strictEqual(parent, parentNode);
    });
    test('findNodeById should find node by id', () => {
        const childNode = {
            id: 'child1',
            name: 'Catalog1',
            type: treeNode_1.MetadataType.Catalog,
            properties: {},
        };
        const rootNode = {
            id: 'root',
            name: 'Configuration',
            type: treeNode_1.MetadataType.Configuration,
            properties: {},
            children: [childNode],
        };
        provider.setRootNode(rootNode);
        const found = provider.findNodeById('child1');
        assert.ok(found);
        assert.strictEqual(found.name, 'Catalog1');
    });
    test('findNodeById should return null for non-existent id', () => {
        const rootNode = {
            id: 'root',
            name: 'Configuration',
            type: treeNode_1.MetadataType.Configuration,
            properties: {},
            children: [],
        };
        provider.setRootNode(rootNode);
        const found = provider.findNodeById('non-existent');
        assert.strictEqual(found, null);
    });
    test('expandNode should set isExpanded to true', () => {
        const node = {
            id: 'test',
            name: 'TestNode',
            type: treeNode_1.MetadataType.Catalog,
            properties: {},
            isExpanded: false,
        };
        provider.expandNode(node);
        assert.strictEqual(node.isExpanded, true);
    });
    test('collapseNode should set isExpanded to false', () => {
        const node = {
            id: 'test',
            name: 'TestNode',
            type: treeNode_1.MetadataType.Catalog,
            properties: {},
            isExpanded: true,
        };
        provider.collapseNode(node);
        assert.strictEqual(node.isExpanded, false);
    });
});
//# sourceMappingURL=treeDataProvider.test.js.map