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
const parsingErrors_1 = require("../../src/parsers/parsingErrors");
suite('ParsingErrors', () => {
    test('should create ParsingError with correct properties', () => {
        const error = new parsingErrors_1.ParsingError(parsingErrors_1.ParsingErrorType.FileNotFound, '/path/to/file.xml', 'File not found');
        assert.strictEqual(error.type, parsingErrors_1.ParsingErrorType.FileNotFound);
        assert.strictEqual(error.filePath, '/path/to/file.xml');
        assert.strictEqual(error.message, 'File not found');
    });
    test('should get user-friendly error message', () => {
        const error = new parsingErrors_1.ParsingError(parsingErrors_1.ParsingErrorType.FileNotFound, '/path/to/file.xml', 'File not found');
        const userMessage = error.getUserMessage();
        assert.ok(userMessage.includes('File not found'));
        assert.ok(userMessage.includes('/path/to/file.xml'));
    });
    test('should get detailed error message', () => {
        const originalError = new Error('Original error');
        const error = new parsingErrors_1.ParsingError(parsingErrors_1.ParsingErrorType.InvalidXml, '/path/to/file.xml', 'Invalid XML', originalError);
        const detailedMessage = error.getDetailedMessage();
        assert.ok(detailedMessage.includes('InvalidXml'));
        assert.ok(detailedMessage.includes('Invalid XML'));
        assert.ok(detailedMessage.includes('Original error'));
    });
    test('should handle file system errors', () => {
        const fsError = new Error('ENOENT: no such file or directory');
        fsError.code = 'ENOENT';
        const parsingError = parsingErrors_1.ParsingErrorHandler.handleFileSystemError(fsError, '/path/to/file.xml');
        assert.strictEqual(parsingError.type, parsingErrors_1.ParsingErrorType.FileNotFound);
    });
    test('should handle permission denied errors', () => {
        const fsError = new Error('EACCES: permission denied');
        fsError.code = 'EACCES';
        const parsingError = parsingErrors_1.ParsingErrorHandler.handleFileSystemError(fsError, '/path/to/file.xml');
        assert.strictEqual(parsingError.type, parsingErrors_1.ParsingErrorType.PermissionDenied);
    });
    test('should handle XML parsing errors', () => {
        const xmlError = new Error('Invalid XML syntax');
        const parsingError = parsingErrors_1.ParsingErrorHandler.handleXmlError(xmlError, '/path/to/file.xml');
        assert.strictEqual(parsingError.type, parsingErrors_1.ParsingErrorType.InvalidXml);
    });
    test('should handle missing element errors', () => {
        const parsingError = parsingErrors_1.ParsingErrorHandler.handleMissingElement('Configuration', '/path/to/file.xml');
        assert.strictEqual(parsingError.type, parsingErrors_1.ParsingErrorType.MissingElement);
        assert.ok(parsingError.message.includes('Configuration'));
    });
    test('should validate configuration path', () => {
        assert.doesNotThrow(() => {
            parsingErrors_1.ParsingValidation.validateConfigPath('/valid/path');
        });
    });
    test('should throw error for empty configuration path', () => {
        assert.throws(() => {
            parsingErrors_1.ParsingValidation.validateConfigPath('');
        });
    });
    test('should throw error for null configuration path', () => {
        assert.throws(() => {
            parsingErrors_1.ParsingValidation.validateConfigPath(null);
        });
    });
    test('should validate XML structure', () => {
        const obj = {
            root: 'value',
            child: 'value',
        };
        assert.doesNotThrow(() => {
            parsingErrors_1.ParsingValidation.validateXmlStructure(obj, ['root', 'child'], '/path/to/file.xml');
        });
    });
    test('should throw error for missing required elements', () => {
        const obj = {
            root: 'value',
        };
        assert.throws(() => {
            parsingErrors_1.ParsingValidation.validateXmlStructure(obj, ['root', 'missing'], '/path/to/file.xml');
        });
    });
    test('should validate metadata type', () => {
        assert.strictEqual(parsingErrors_1.ParsingValidation.isValidMetadataType('Catalog'), true);
        assert.strictEqual(parsingErrors_1.ParsingValidation.isValidMetadataType('Document'), true);
        assert.strictEqual(parsingErrors_1.ParsingValidation.isValidMetadataType('InvalidType'), false);
    });
    test('should get error message from ParsingError', () => {
        const error = new parsingErrors_1.ParsingError(parsingErrors_1.ParsingErrorType.FileNotFound, '/path/to/file.xml', 'File not found');
        const message = parsingErrors_1.ParsingErrorHandler.getErrorMessage(error);
        assert.ok(message.includes('File not found'));
    });
    test('should get error message from regular Error', () => {
        const error = new Error('Test error');
        const message = parsingErrors_1.ParsingErrorHandler.getErrorMessage(error);
        assert.strictEqual(message, 'Test error');
    });
    test('should get default error message for unknown error', () => {
        const message = parsingErrors_1.ParsingErrorHandler.getErrorMessage('unknown error');
        assert.strictEqual(message, 'Unknown error occurred');
    });
});
//# sourceMappingURL=parsingErrors.test.js.map