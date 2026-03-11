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
exports.XmlParser = void 0;
const fs = __importStar(require("fs"));
const fast_xml_parser_1 = require("fast-xml-parser");
const logger_1 = require("../utils/logger");
/**
 * XML parsing options for fast-xml-parser
 */
const XML_PARSER_OPTIONS = {
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    trimValues: true,
    cdataTagName: '__cdata',
    cdataPositionChar: '\\\\',
    parseTrueNumberOnly: false,
    numParseOptions: {
        hex: false,
        leadingZeros: false,
        skipLike: /^$/,
    },
    arrayMode: false,
    attrNodeName: '@_',
    ignoreNameSpace: false,
    removeNSPrefix: false,
};
/**
 * XML Parser for 1C metadata files
 */
class XmlParser {
    /**
     * Parse XML file and return parsed object
     * @param filePath Path to XML file
     * @returns Parsed XML object
     */
    static parseFile(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${filePath}`);
            }
            const xmlContent = fs.readFileSync(filePath, 'utf-8');
            return this.parseString(xmlContent);
        }
        catch (error) {
            logger_1.Logger.error(`Error parsing XML file: ${filePath}`, error);
            throw new Error(`Failed to parse XML file: ${filePath}. ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Parse XML string and return parsed object
     * @param xmlString XML content as string
     * @returns Parsed XML object
     */
    static parseString(xmlString) {
        try {
            const parsed = this.parser.parse(xmlString);
            return parsed;
        }
        catch (error) {
            logger_1.Logger.error('Error parsing XML string', error);
            throw new Error(`Failed to parse XML: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Convert object to XML string
     * @param obj Object to convert
     * @returns XML string
     */
    static objectToXml(obj) {
        try {
            return this.builder.build(obj);
        }
        catch (error) {
            logger_1.Logger.error('Error converting object to XML', error);
            throw new Error(`Failed to convert object to XML: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Get root element name from XML file
     * @param filePath Path to XML file
     * @returns Root element name
     */
    static getRootElementName(filePath) {
        try {
            const parsed = this.parseFile(filePath);
            const keys = Object.keys(parsed);
            return keys[0] || 'Unknown';
        }
        catch (error) {
            logger_1.Logger.error(`Error getting root element name from ${filePath}`, error);
            throw error;
        }
    }
    /**
     * Get element by path from parsed XML
     * @param obj Parsed XML object
     * @param path Path to element (e.g., 'Configuration.Properties.Name')
     * @returns Element value or undefined
     */
    static getElementByPath(obj, elementPath) {
        const parts = elementPath.split('.');
        let current = obj;
        for (const part of parts) {
            if (current && typeof current === 'object') {
                current = current[part];
            }
            else {
                return undefined;
            }
        }
        return current;
    }
    /**
     * Set element by path in parsed XML
     * @param obj Parsed XML object
     * @param elementPath Path to element
     * @param value Value to set
     */
    static setElementByPath(obj, elementPath, value) {
        const parts = elementPath.split('.');
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!current[part]) {
                current[part] = {};
            }
            current = current[part];
        }
        current[parts[parts.length - 1]] = value;
    }
    /**
     * Validate XML structure
     * @param filePath Path to XML file
     * @returns true if valid XML
     */
    static isValidXml(filePath) {
        try {
            this.parseFile(filePath);
            return true;
        }
        catch {
            return false;
        }
    }
}
exports.XmlParser = XmlParser;
XmlParser.parser = new fast_xml_parser_1.XMLParser(XML_PARSER_OPTIONS);
XmlParser.builder = new fast_xml_parser_1.XMLBuilder(XML_PARSER_OPTIONS);
//# sourceMappingURL=xmlParser.js.map