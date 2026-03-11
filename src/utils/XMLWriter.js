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
exports.XMLWriter = void 0;
const fs = __importStar(require("fs"));
const fast_xml_parser_1 = require("fast-xml-parser");
const logger_1 = require("./logger");
/**
 * XML Writer options for preserving formatting and structure
 */
const XML_WRITER_OPTIONS = {
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    format: true,
    indentBy: '  ',
    suppressEmptyNode: false,
    preserveOrder: true,
    commentPropName: '#comment',
    cdataTagName: '__cdata',
    processEntities: true,
    suppressBooleanAttributes: false,
    suppressUnpairedNode: false,
    unpairedTags: [],
};
/**
 * XMLWriter utility class for reading and writing XML files
 * while preserving structure and formatting
 */
class XMLWriter {
    /**
     * Read properties from XML file
     * @param filePath Path to XML file
     * @returns Properties object extracted from XML
     * @throws Error if file cannot be read or parsed
     */
    static async readProperties(filePath) {
        try {
            // Check if file exists
            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${filePath}`);
            }
            // Read file content
            const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
            // Parse XML
            const parsed = this.parser.parse(xmlContent);
            // Extract properties from parsed XML
            const properties = this.extractProperties(parsed);
            logger_1.Logger.info(`Successfully read properties from ${filePath}`);
            return properties;
        }
        catch (error) {
            logger_1.Logger.error(`Error reading properties from ${filePath}`, error);
            throw new Error(`Failed to read properties from XML file: ${filePath}. ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Write properties to XML file
     * Preserves XML structure and formatting
     * @param filePath Path to XML file
     * @param properties Properties object to write
     * @throws Error if file cannot be written
     */
    static async writeProperties(filePath, properties) {
        try {
            // Read existing XML content
            const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
            // Parse existing XML
            const parsed = this.parser.parse(xmlContent);
            // Update properties in parsed structure
            const updated = this.updatePropertiesInStructure(parsed, properties);
            // Build XML string with preserved formatting
            const xmlString = this.builder.build(updated);
            // Write back to file
            await fs.promises.writeFile(filePath, xmlString, 'utf-8');
            logger_1.Logger.info(`Successfully wrote properties to ${filePath}`);
        }
        catch (error) {
            logger_1.Logger.error(`Error writing properties to ${filePath}`, error);
            throw new Error(`Failed to write properties to XML file: ${filePath}. ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Update specific property in XML file
     * Only modifies the target property node
     * @param filePath Path to XML file
     * @param propertyName Name of property to update
     * @param value New value for the property
     * @throws Error if file cannot be read or written
     */
    static async updateProperty(filePath, propertyName, value) {
        try {
            // Read existing properties
            const properties = await this.readProperties(filePath);
            // Update specific property
            properties[propertyName] = value;
            // Write back all properties
            await this.writeProperties(filePath, properties);
            logger_1.Logger.info(`Successfully updated property '${propertyName}' in ${filePath}`);
        }
        catch (error) {
            logger_1.Logger.error(`Error updating property '${propertyName}' in ${filePath}`, error);
            throw new Error(`Failed to update property '${propertyName}' in XML file: ${filePath}. ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Extract properties from parsed XML structure
     * Recursively traverses the XML structure to find property nodes
     * @param parsed Parsed XML object
     * @returns Flat properties object
     */
    static extractProperties(parsed) {
        const properties = {};
        if (!parsed || typeof parsed !== 'object') {
            return properties;
        }
        // Handle array of nodes (preserveOrder mode)
        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                if (item && typeof item === 'object') {
                    Object.assign(properties, this.extractProperties(item));
                }
            }
            return properties;
        }
        // Handle object nodes
        const obj = parsed;
        // Look for common property containers in 1C metadata
        if (obj.Properties && typeof obj.Properties === 'object') {
            return this.flattenProperties(obj.Properties);
        }
        // If no Properties node, extract from root
        for (const [key, value] of Object.entries(obj)) {
            // Skip XML attributes and special nodes
            if (key.startsWith('@_') || key.startsWith('#')) {
                continue;
            }
            // If value is an object, recursively extract
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const nested = this.extractProperties(value);
                if (Object.keys(nested).length > 0) {
                    Object.assign(properties, nested);
                }
                else {
                    properties[key] = value;
                }
            }
            else {
                properties[key] = value;
            }
        }
        return properties;
    }
    /**
     * Flatten properties object to simple key-value pairs
     * @param properties Properties object
     * @returns Flattened properties
     */
    static flattenProperties(properties) {
        const flattened = {};
        for (const [key, value] of Object.entries(properties)) {
            // Skip XML attributes and special nodes
            if (key.startsWith('@_') || key.startsWith('#')) {
                continue;
            }
            // Extract text content if it's a simple node
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const obj = value;
                if ('#text' in obj) {
                    flattened[key] = obj['#text'];
                }
                else {
                    flattened[key] = value;
                }
            }
            else {
                flattened[key] = value;
            }
        }
        return flattened;
    }
    /**
     * Update properties in parsed XML structure
     * Preserves structure while updating values
     * @param parsed Parsed XML object
     * @param properties Properties to update
     * @returns Updated XML structure
     */
    static updatePropertiesInStructure(parsed, properties) {
        if (!parsed || typeof parsed !== 'object') {
            return parsed;
        }
        // Handle array of nodes (preserveOrder mode)
        if (Array.isArray(parsed)) {
            return parsed.map((item) => this.updatePropertiesInStructure(item, properties));
        }
        // Handle object nodes
        const obj = { ...parsed };
        // Look for Properties node in 1C metadata
        if (obj.Properties && typeof obj.Properties === 'object') {
            obj.Properties = this.updatePropertiesNode(obj.Properties, properties);
            return obj;
        }
        // Update properties at current level
        for (const [key, value] of Object.entries(obj)) {
            // Skip XML attributes and special nodes
            if (key.startsWith('@_') || key.startsWith('#')) {
                continue;
            }
            // If property exists in update set, update it
            if (key in properties) {
                // Preserve structure if it's an object with #text
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    const valueObj = value;
                    if ('#text' in valueObj) {
                        obj[key] = { ...valueObj, '#text': properties[key] };
                    }
                    else {
                        obj[key] = properties[key];
                    }
                }
                else {
                    obj[key] = properties[key];
                }
            }
            else if (value && typeof value === 'object') {
                // Recursively update nested objects
                obj[key] = this.updatePropertiesInStructure(value, properties);
            }
        }
        return obj;
    }
    /**
     * Update properties in a Properties node
     * @param propertiesNode Properties node object
     * @param properties Properties to update
     * @returns Updated properties node
     */
    static updatePropertiesNode(propertiesNode, properties) {
        const updated = { ...propertiesNode };
        for (const [key, value] of Object.entries(properties)) {
            if (key in updated) {
                const existing = updated[key];
                // Preserve structure if it's an object with #text
                if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
                    const existingObj = existing;
                    if ('#text' in existingObj) {
                        updated[key] = { ...existingObj, '#text': value };
                    }
                    else {
                        updated[key] = value;
                    }
                }
                else {
                    updated[key] = value;
                }
            }
            else {
                // Add new property
                updated[key] = value;
            }
        }
        return updated;
    }
}
exports.XMLWriter = XMLWriter;
XMLWriter.parser = new fast_xml_parser_1.XMLParser(XML_WRITER_OPTIONS);
XMLWriter.builder = new fast_xml_parser_1.XMLBuilder(XML_WRITER_OPTIONS);
//# sourceMappingURL=XMLWriter.js.map