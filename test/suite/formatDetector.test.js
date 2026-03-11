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
const formatDetector_1 = require("../../src/parsers/formatDetector");
suite('FormatDetector', () => {
    test('should detect Designer format', async () => {
        const configPath = path.join(__dirname, '../fixtures/designer-config');
        const format = await formatDetector_1.FormatDetector.detect(configPath);
        assert.strictEqual(format, formatDetector_1.ConfigFormat.Designer);
    });
    test('should return Unknown for non-existent path', async () => {
        const configPath = path.join(__dirname, '../fixtures/non-existent');
        const format = await formatDetector_1.FormatDetector.detect(configPath);
        assert.strictEqual(format, formatDetector_1.ConfigFormat.Unknown);
    });
    test('should validate configuration path', async () => {
        const configPath = path.join(__dirname, '../fixtures/designer-config');
        const isValid = await formatDetector_1.FormatDetector.isValidConfigurationPath(configPath);
        assert.strictEqual(isValid, true);
    });
    test('should return false for invalid configuration path', async () => {
        const configPath = path.join(__dirname, '../fixtures/non-existent');
        const isValid = await formatDetector_1.FormatDetector.isValidConfigurationPath(configPath);
        assert.strictEqual(isValid, false);
    });
    test('should find configuration root in workspace', async () => {
        const workspacePath = path.join(__dirname, '../fixtures');
        const configRoot = await formatDetector_1.FormatDetector.findConfigurationRoot(workspacePath);
        assert.ok(configRoot);
        assert.ok(configRoot?.includes('designer-config'));
    });
    test('should return null if configuration not found', async () => {
        const workspacePath = path.join(__dirname, '../fixtures/non-existent');
        const configRoot = await formatDetector_1.FormatDetector.findConfigurationRoot(workspacePath);
        assert.strictEqual(configRoot, null);
    });
});
//# sourceMappingURL=formatDetector.test.js.map