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
exports.DesignerParser = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const treeNode_1 = require("../models/treeNode");
const logger_1 = require("../utils/logger");
const xmlParser_1 = require("./xmlParser");
const metadataTypeMapper_1 = require("../utils/metadataTypeMapper");
/**
 * Parser for 1C Designer format metadata
 * Designer format uses structured XML files in specific directory structure
 * with 1cv8.cf or 1cv8.cfe file in root
 */
class DesignerParser {
    /**
     * Parse Designer format configuration
     * @param configPath Path to configuration root directory
     * @returns Root tree node
     */
    static async parse(configPath) {
        logger_1.Logger.info('Starting Designer format parsing', configPath);
        try {
            // Read ConfigDumpInfo.xml or Configuration.xml
            let configXmlPath = path.join(configPath, 'ConfigDumpInfo.xml');
            if (!fs.existsSync(configXmlPath)) {
                configXmlPath = path.join(configPath, 'Configuration.xml');
            }
            if (!fs.existsSync(configXmlPath)) {
                throw new Error(`Configuration metadata file not found at ${configPath}`);
            }
            xmlParser_1.XmlParser.parseFile(configXmlPath);
            const rootNode = await this.buildTreeFromConfiguration(configPath);
            logger_1.Logger.info('Designer format parsing completed');
            return rootNode;
        }
        catch (error) {
            logger_1.Logger.error('Error parsing Designer format', error);
            throw error;
        }
    }
    /**
     * Build tree from configuration metadata
     * @param configPath Path to configuration root
     * @returns Root tree node
     */
    static async buildTreeFromConfiguration(configPath) {
        const rootNode = {
            id: 'root',
            name: 'Configuration',
            type: treeNode_1.MetadataType.Configuration,
            properties: {},
            children: [],
            filePath: configPath,
        };
        // Parse metadata directories
        const metadataTypes = metadataTypeMapper_1.MetadataTypeMapper.getMetadataTypes();
        // Process all metadata types in parallel
        const typeNodes = await Promise.all(metadataTypes.map(async (metadataType) => {
            const typePath = path.join(configPath, metadataType);
            try {
                await fs.promises.access(typePath);
                return await this.parseMetadataType(typePath, metadataType);
            }
            catch {
                return null;
            }
        }));
        // Add non-empty type nodes to root
        for (const typeNode of typeNodes) {
            if (typeNode && typeNode.children && typeNode.children.length > 0) {
                rootNode.children?.push(typeNode);
            }
        }
        return rootNode;
    }
    /**
     * Parse metadata type directory
     * @param typePath Path to metadata type directory
     * @param typeName Name of metadata type
     * @returns Tree node for metadata type
     */
    static async parseMetadataType(typePath, typeName) {
        const metadataType = metadataTypeMapper_1.MetadataTypeMapper.map(typeName);
        const typeNode = {
            id: typeName,
            name: typeName,
            type: metadataType,
            properties: { type: typeName },
            children: [],
            filePath: typePath,
        };
        // Read items in this type directory
        try {
            const items = await fs.promises.readdir(typePath);
            // Process all items in parallel
            const elementNodes = await Promise.all(items.map(async (item) => {
                const itemPath = path.join(typePath, item);
                try {
                    const stat = await fs.promises.stat(itemPath);
                    if (stat.isDirectory()) {
                        // This is a metadata element directory
                        return await this.parseMetadataElement(itemPath, item, typeName);
                    }
                }
                catch (error) {
                    logger_1.Logger.debug(`Error processing item ${itemPath}`, error);
                }
                return null;
            }));
            // Add non-null element nodes
            for (const elementNode of elementNodes) {
                if (elementNode) {
                    typeNode.children?.push(elementNode);
                }
            }
        }
        catch (error) {
            logger_1.Logger.warn(`Error reading metadata type directory ${typePath}`, error);
        }
        return typeNode;
    }
    /**
     * Parse metadata element directory
     * @param elementPath Path to element directory
     * @param elementName Name of element
     * @param typeName Type of element
     * @returns Tree node for metadata element
     */
    static async parseMetadataElement(elementPath, elementName, typeName) {
        const metadataType = metadataTypeMapper_1.MetadataTypeMapper.map(typeName);
        const elementNode = {
            id: `${typeName}.${elementName}`,
            name: elementName,
            type: metadataType,
            properties: { type: typeName },
            children: [],
            filePath: elementPath,
        };
        // Try to read metadata XML file
        const xmlPath = path.join(elementPath, `${elementName}.xml`);
        try {
            await fs.promises.access(xmlPath);
            try {
                const xmlContent = xmlParser_1.XmlParser.parseFile(xmlPath);
                const properties = this.extractPropertiesFromElement(xmlContent);
                elementNode.properties = { ...elementNode.properties, ...properties };
            }
            catch (error) {
                logger_1.Logger.warn(`Error parsing element XML ${xmlPath}`, error);
            }
        }
        catch {
            // XML file doesn't exist, skip
        }
        // Parse sub-elements (Ext, Forms, etc.)
        try {
            const items = await fs.promises.readdir(elementPath);
            for (const item of items) {
                if (item === 'Ext') {
                    // Parse extensions
                    const extPath = path.join(elementPath, item);
                    const extNode = await this.parseExtensions(extPath);
                    if (extNode.children && extNode.children.length > 0) {
                        elementNode.children?.push(extNode);
                    }
                }
            }
        }
        catch (error) {
            logger_1.Logger.debug(`Error reading element directory ${elementPath}`, error);
        }
        return elementNode;
    }
    /**
     * Parse extensions directory
     * @param extPath Path to Ext directory
     * @returns Tree node for extensions
     */
    static async parseExtensions(extPath) {
        const extNode = {
            id: 'Ext',
            name: 'Extensions',
            type: treeNode_1.MetadataType.Extension,
            properties: {},
            children: [],
            filePath: extPath,
        };
        try {
            const items = await fs.promises.readdir(extPath);
            // Process all extension items in parallel
            const extElementNodes = await Promise.all(items.map(async (item) => {
                const itemPath = path.join(extPath, item);
                try {
                    const stat = await fs.promises.stat(itemPath);
                    if (stat.isDirectory()) {
                        return {
                            id: `Ext.${item}`,
                            name: item,
                            type: treeNode_1.MetadataType.Extension,
                            properties: { isExtension: true },
                            filePath: itemPath,
                        };
                    }
                }
                catch (error) {
                    logger_1.Logger.debug(`Error processing extension ${itemPath}`, error);
                }
                return null;
            }));
            // Add non-null extension nodes
            for (const extElementNode of extElementNodes) {
                if (extElementNode) {
                    extNode.children?.push(extElementNode);
                }
            }
        }
        catch (error) {
            logger_1.Logger.debug(`Error reading extensions directory ${extPath}`, error);
        }
        return extNode;
    }
    /**
     * Extract properties from metadata element XML
     * @param xmlContent Parsed XML content
     * @returns Properties object
     */
    static extractPropertiesFromElement(xmlContent) {
        const result = {};
        // Find the root element (Catalog, Document, etc.)
        for (const [key, value] of Object.entries(xmlContent)) {
            if (key === '@_' || key.startsWith('#')) {
                continue;
            }
            if (typeof value === 'object' && value !== null) {
                const element = value;
                const properties = element.Properties;
                if (properties) {
                    for (const [propKey, propValue] of Object.entries(properties)) {
                        if (propKey === '@_' || propKey.startsWith('#')) {
                            continue;
                        }
                        if (typeof propValue === 'object' && propValue !== null) {
                            const obj = propValue;
                            if (obj.item) {
                                result[propKey] = obj.item;
                            }
                            else {
                                result[propKey] = propValue;
                            }
                        }
                        else {
                            result[propKey] = propValue;
                        }
                    }
                }
            }
        }
        return result;
    }
    /**
     * Detect if path contains Designer format configuration
     * @param configPath Path to check
     * @returns true if Designer format detected
     */
    static async isDesignerFormat(configPath) {
        try {
            // Designer format has 1cv8.cf or 1cv8.cfe file in root
            const cfPath = path.join(configPath, '1cv8.cf');
            const cfePath = path.join(configPath, '1cv8.cfe');
            if (!fs.existsSync(cfPath) && !fs.existsSync(cfePath)) {
                return false;
            }
            // Check if ConfigDumpInfo.xml or Configuration.xml exists
            const configDumpPath = path.join(configPath, 'ConfigDumpInfo.xml');
            const configPath2 = path.join(configPath, 'Configuration.xml');
            return fs.existsSync(configDumpPath) || fs.existsSync(configPath2);
        }
        catch (error) {
            logger_1.Logger.debug('Designer format detection failed', error);
            return false;
        }
    }
}
exports.DesignerParser = DesignerParser;
//# sourceMappingURL=designerParser.js.map