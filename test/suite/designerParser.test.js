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
const designerParser_1 = require("../../src/parsers/designerParser");
const treeNode_1 = require("../../src/models/treeNode");
suite('DesignerParser', () => {
    test('should detect Designer format', async () => {
        const configPath = path.join(__dirname, '../fixtures/designer-config');
        const isDesigner = await designerParser_1.DesignerParser.isDesignerFormat(configPath);
        assert.strictEqual(isDesigner, true);
    });
    test('should return false for non-Designer format', async () => {
        const configPath = path.join(__dirname, '../fixtures/non-existent');
        const isDesigner = await designerParser_1.DesignerParser.isDesignerFormat(configPath);
        assert.strictEqual(isDesigner, false);
    });
    test('should parse Designer format configuration', async () => {
        const configPath = path.join(__dirname, '../fixtures/designer-config');
        const rootNode = await designerParser_1.DesignerParser.parse(configPath);
        assert.ok(rootNode);
        assert.strictEqual(rootNode.name, 'Configuration');
        assert.strictEqual(rootNode.type, treeNode_1.MetadataType.Configuration);
        assert.ok(Array.isArray(rootNode.children));
    });
    test('should throw error for invalid configuration path', async () => {
        const configPath = path.join(__dirname, '../fixtures/non-existent');
        try {
            await designerParser_1.DesignerParser.parse(configPath);
            assert.fail('Should have thrown an error');
        }
        catch (error) {
            assert.ok(error instanceof Error);
        }
    });
    test('should parse metadata types', async () => {
        const configPath = path.join(__dirname, '../fixtures/designer-config');
        const rootNode = await designerParser_1.DesignerParser.parse(configPath);
        // Check if children exist
        assert.ok(rootNode.children);
        assert.ok(rootNode.children.length >= 0);
        // If there are children, check their structure
        if (rootNode.children.length > 0) {
            const firstChild = rootNode.children[0];
            assert.ok(firstChild.name);
            assert.ok(firstChild.type);
            assert.ok(firstChild.properties);
        }
    });
});
//# sourceMappingURL=designerParser.test.js.map