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
const path = __importStar(require("path"));
const metadataParser_1 = require("../../src/parsers/metadataParser");
const treeNode_1 = require("../../src/models/treeNode");
const formatDetector_1 = require("../../src/parsers/formatDetector");
suite('MetadataParser', () => {
    test('should parse configuration', async () => {
        const configPath = path.join(__dirname, '../fixtures/designer-config');
        const rootNode = await metadataParser_1.MetadataParser.parse(configPath);
        assert.ok(rootNode);
        assert.strictEqual(rootNode.name, 'Configuration');
        assert.strictEqual(rootNode.type, treeNode_1.MetadataType.Configuration);
    });
    test('should throw error for invalid configuration path', async () => {
        const configPath = path.join(__dirname, '../fixtures/non-existent');
        try {
            await metadataParser_1.MetadataParser.parse(configPath);
            assert.fail('Should have thrown an error');
        }
        catch (error) {
            assert.ok(error instanceof Error);
        }
    });
    test('should detect configuration format', async () => {
        const configPath = path.join(__dirname, '../fixtures/designer-config');
        const format = await metadataParser_1.MetadataParser.getFormat(configPath);
        assert.strictEqual(format, formatDetector_1.ConfigFormat.Designer);
    });
    test('should find configuration root in workspace', async () => {
        const workspacePath = path.join(__dirname, '../fixtures');
        const configRoot = await metadataParser_1.MetadataParser.findConfigurationRoot(workspacePath);
        assert.ok(configRoot);
        assert.ok(configRoot?.includes('designer-config'));
    });
    test('should parse configuration from workspace', async () => {
        const workspacePath = path.join(__dirname, '../fixtures');
        const rootNode = await metadataParser_1.MetadataParser.parseFromWorkspace(workspacePath);
        assert.ok(rootNode);
        assert.strictEqual(rootNode?.name, 'Configuration');
        assert.strictEqual(rootNode?.type, treeNode_1.MetadataType.Configuration);
    });
    test('should return null if configuration not found in workspace', async () => {
        const workspacePath = path.join(__dirname, '../fixtures/non-existent');
        const rootNode = await metadataParser_1.MetadataParser.parseFromWorkspace(workspacePath);
        assert.strictEqual(rootNode, null);
    });
});
//# sourceMappingURL=metadataParser.test.js.map