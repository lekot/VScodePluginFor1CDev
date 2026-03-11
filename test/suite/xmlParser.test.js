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
const xmlParser_1 = require("../../src/parsers/xmlParser");
suite('XmlParser', () => {
    test('should parse valid XML file', () => {
        const xmlPath = path.join(__dirname, '../fixtures/designer-config/Configuration.xml');
        const result = xmlParser_1.XmlParser.parseFile(xmlPath);
        assert.ok(result);
        assert.ok(Object.keys(result).length > 0);
    });
    test('should parse XML string', () => {
        const xmlString = '<?xml version="1.0"?><root><item>test</item></root>';
        const result = xmlParser_1.XmlParser.parseString(xmlString);
        assert.ok(result);
        assert.ok(result.root);
    });
    test('should throw error for non-existent file', () => {
        const xmlPath = path.join(__dirname, '../fixtures/non-existent.xml');
        assert.throws(() => {
            xmlParser_1.XmlParser.parseFile(xmlPath);
        });
    });
    test('should throw error for invalid XML', () => {
        const invalidXml = '<?xml version="1.0"?><root><item>test</root>';
        assert.throws(() => {
            xmlParser_1.XmlParser.parseString(invalidXml);
        });
    });
    test('should get root element name', () => {
        const xmlPath = path.join(__dirname, '../fixtures/designer-config/Configuration.xml');
        const rootName = xmlParser_1.XmlParser.getRootElementName(xmlPath);
        assert.ok(rootName);
        assert.strictEqual(typeof rootName, 'string');
    });
    test('should validate XML file', () => {
        const xmlPath = path.join(__dirname, '../fixtures/designer-config/Configuration.xml');
        const isValid = xmlParser_1.XmlParser.isValidXml(xmlPath);
        assert.strictEqual(isValid, true);
    });
    test('should return false for invalid XML file', () => {
        const xmlPath = path.join(__dirname, '../fixtures/non-existent.xml');
        const isValid = xmlParser_1.XmlParser.isValidXml(xmlPath);
        assert.strictEqual(isValid, false);
    });
    test('should get element by path', () => {
        const obj = {
            root: {
                child: {
                    value: 'test',
                },
            },
        };
        const result = xmlParser_1.XmlParser.getElementByPath(obj, 'root.child.value');
        assert.strictEqual(result, 'test');
    });
    test('should return undefined for non-existent path', () => {
        const obj = {
            root: {
                child: {
                    value: 'test',
                },
            },
        };
        const result = xmlParser_1.XmlParser.getElementByPath(obj, 'root.nonexistent.value');
        assert.strictEqual(result, undefined);
    });
    test('should set element by path', () => {
        const obj = {
            root: {
                child: {},
            },
        };
        xmlParser_1.XmlParser.setElementByPath(obj, 'root.child.value', 'test');
        const result = xmlParser_1.XmlParser.getElementByPath(obj, 'root.child.value');
        assert.strictEqual(result, 'test');
    });
    test('should convert object to XML', () => {
        const obj = {
            root: {
                item: 'test',
            },
        };
        const xml = xmlParser_1.XmlParser.objectToXml(obj);
        assert.ok(xml);
        assert.ok(xml.includes('<?xml'));
        assert.ok(xml.includes('<root>'));
        assert.ok(xml.includes('<item>'));
    });
});
//# sourceMappingURL=xmlParser.test.js.map