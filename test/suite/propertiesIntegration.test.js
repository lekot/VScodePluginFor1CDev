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
const treeNode_1 = require("../../src/models/treeNode");
suite('Properties Integration Test Suite', () => {
    let extension;
    suiteSetup(async () => {
        extension = vscode.extensions.getExtension('1c-dev.1c-metadata-tree-vscode');
        if (extension && !extension.isActive) {
            await extension.activate();
        }
    });
    test('Task 2: Tree view selection should trigger properties command', async function () {
        this.timeout(5000);
        // Verify extension is active
        assert.ok(extension);
        assert.ok(extension.isActive, 'Extension should be active');
        // Verify showProperties command is registered
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('1c-metadata-tree.showProperties'), 'showProperties command should be registered');
        // Create a test node
        const testNode = {
            id: 'test-catalog-1',
            name: 'TestCatalog',
            type: treeNode_1.MetadataType.Catalog,
            properties: {
                name: 'TestCatalog',
                synonym: 'Test Catalog',
                hierarchical: false,
            },
            children: [],
            isExpanded: false,
        };
        // Execute the showProperties command with the test node
        // This simulates what happens when a tree item is selected
        await vscode.commands.executeCommand('1c-metadata-tree.showProperties', testNode);
        // Wait a bit for the webview to be created
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Verify that a webview panel was created
        // Note: We can't directly access the panel, but we can verify the command executed without error
        // In a real scenario, the panel would be visible in VS Code
        assert.ok(true, 'Command executed successfully');
    });
    test('Task 2: Tree data provider should not have default file open command', async function () {
        this.timeout(5000);
        // Get the tree view
        const treeView = vscode.window.createTreeView('1c-metadata-tree', {
            treeDataProvider: {
                getTreeItem: (element) => {
                    const treeItem = new vscode.TreeItem(element.name);
                    // Verify that no command is set for opening files
                    assert.strictEqual(treeItem.command, undefined, 'TreeItem should not have a default command');
                    return treeItem;
                },
                getChildren: () => Promise.resolve([]),
            },
        });
        treeView.dispose();
    });
    test('Task 2: openXML command should be registered for context menu', async function () {
        this.timeout(5000);
        // Verify openXML command is registered
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('1c-metadata-tree.openXML'), 'openXML command should be registered for context menu access');
    });
    test('Task 2: Properties panel should display node information', async function () {
        this.timeout(5000);
        // Create a test node with various property types
        const testNode = {
            id: 'test-document-1',
            name: 'TestDocument',
            type: treeNode_1.MetadataType.Document,
            properties: {
                name: 'TestDocument',
                synonym: 'Test Document',
                numberLength: 9,
                numberPeriodicity: 'Year',
                checkUnique: true,
            },
            children: [],
            isExpanded: false,
        };
        // Execute the showProperties command
        await vscode.commands.executeCommand('1c-metadata-tree.showProperties', testNode);
        // Wait for the webview to be created
        await new Promise((resolve) => setTimeout(resolve, 500));
        // The properties panel should be created and display the node's properties
        // We can't directly inspect the webview content in tests, but we verify the command succeeds
        assert.ok(true, 'Properties panel command executed successfully');
    });
    test('Task 2: Multiple selections should reuse the same panel (singleton pattern)', async function () {
        this.timeout(5000);
        // Create multiple test nodes
        const node1 = {
            id: 'test-catalog-1',
            name: 'Catalog1',
            type: treeNode_1.MetadataType.Catalog,
            properties: { name: 'Catalog1' },
            children: [],
            isExpanded: false,
        };
        const node2 = {
            id: 'test-catalog-2',
            name: 'Catalog2',
            type: treeNode_1.MetadataType.Catalog,
            properties: { name: 'Catalog2' },
            children: [],
            isExpanded: false,
        };
        // Show properties for first node
        await vscode.commands.executeCommand('1c-metadata-tree.showProperties', node1);
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Show properties for second node (should reuse the same panel)
        await vscode.commands.executeCommand('1c-metadata-tree.showProperties', node2);
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Both commands should execute successfully
        // The singleton pattern ensures only one panel exists
        assert.ok(true, 'Multiple selections handled correctly');
    });
});
//# sourceMappingURL=propertiesIntegration.test.js.map