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
const propertiesProvider_1 = require("../../src/providers/propertiesProvider");
const treeDataProvider_1 = require("../../src/providers/treeDataProvider");
const treeNode_1 = require("../../src/models/treeNode");
suite('PropertiesProvider Message Protocol Test Suite', () => {
    let provider;
    let treeDataProvider;
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
        treeDataProvider = new treeDataProvider_1.MetadataTreeDataProvider(mockContext);
        provider = new propertiesProvider_1.PropertiesProvider(mockContext, treeDataProvider);
    });
    teardown(() => {
        provider.dispose();
    });
    test('Provider should be initialized', () => {
        assert.ok(provider);
    });
    test('Validation should pass for valid properties', () => {
        const node = {
            id: 'test',
            name: 'TestCatalog',
            type: treeNode_1.MetadataType.Catalog,
            properties: {
                name: 'TestCatalog',
                maxLength: 100,
                autoNumbering: true,
            },
            filePath: '/test/path.xml',
        };
        // Access private method through any cast for testing
        const validateProperties = provider.validateProperties.bind(provider);
        // Set current node
        provider.currentNode = node;
        const result = validateProperties({
            name: 'TestCatalog',
            maxLength: 100,
            autoNumbering: true,
        });
        assert.strictEqual(result.valid, true);
        assert.strictEqual(Object.keys(result.errors).length, 0);
    });
    test('Validation should fail for invalid number type', () => {
        const node = {
            id: 'test',
            name: 'TestCatalog',
            type: treeNode_1.MetadataType.Catalog,
            properties: {
                name: 'TestCatalog',
                maxLength: 100,
            },
            filePath: '/test/path.xml',
        };
        const validateProperties = provider.validateProperties.bind(provider);
        provider.currentNode = node;
        const result = validateProperties({
            name: 'TestCatalog',
            maxLength: 'not a number',
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.maxLength);
        assert.strictEqual(result.errors.maxLength, 'Must be a number');
    });
    test('Validation should fail for empty required field', () => {
        const node = {
            id: 'test',
            name: 'TestCatalog',
            type: treeNode_1.MetadataType.Catalog,
            properties: {
                name: 'TestCatalog',
                synonym: 'Test',
            },
            filePath: '/test/path.xml',
        };
        const validateProperties = provider.validateProperties.bind(provider);
        provider.currentNode = node;
        const result = validateProperties({
            name: '',
            synonym: 'Test',
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.name);
        assert.strictEqual(result.errors.name, 'This field is required');
    });
    test('Validation should fail for string exceeding max length', () => {
        const node = {
            id: 'test',
            name: 'TestCatalog',
            type: treeNode_1.MetadataType.Catalog,
            properties: {
                name: 'TestCatalog',
                description: 'Short description',
            },
            filePath: '/test/path.xml',
        };
        const validateProperties = provider.validateProperties.bind(provider);
        provider.currentNode = node;
        const longString = 'a'.repeat(1001);
        const result = validateProperties({
            name: 'TestCatalog',
            description: longString,
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.description);
        assert.strictEqual(result.errors.description, 'Value is too long (max 1000 characters)');
    });
    test('Validation should fail for invalid boolean type', () => {
        const node = {
            id: 'test',
            name: 'TestCatalog',
            type: treeNode_1.MetadataType.Catalog,
            properties: {
                name: 'TestCatalog',
                autoNumbering: true,
            },
            filePath: '/test/path.xml',
        };
        const validateProperties = provider.validateProperties.bind(provider);
        provider.currentNode = node;
        const result = validateProperties({
            name: 'TestCatalog',
            autoNumbering: 'yes',
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.autoNumbering);
        assert.strictEqual(result.errors.autoNumbering, 'Must be a boolean');
    });
    test('Property type detection should work correctly', () => {
        const detectPropertyType = provider.detectPropertyType.bind(provider);
        assert.strictEqual(detectPropertyType('test'), 'string');
        assert.strictEqual(detectPropertyType(123), 'number');
        assert.strictEqual(detectPropertyType(true), 'boolean');
        assert.strictEqual(detectPropertyType(null), 'unknown');
        assert.strictEqual(detectPropertyType(undefined), 'unknown');
    });
    test('HTML escaping should prevent XSS', () => {
        const escapeHtml = provider.escapeHtml.bind(provider);
        assert.strictEqual(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
        assert.strictEqual(escapeHtml('Test & Co'), 'Test &amp; Co');
        assert.strictEqual(escapeHtml("It's a test"), 'It&#039;s a test');
    });
});
//# sourceMappingURL=propertiesProvider.test.js.map