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
exports.EdtParser = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const treeNode_1 = require("../models/treeNode");
const logger_1 = require("../utils/logger");
const xmlParser_1 = require("./xmlParser");
const metadataTypeMapper_1 = require("../utils/metadataTypeMapper");
/**
 * Parser for 1C EDT (Eclipse Development Tools) format metadata
 * EDT format uses .mdo files in specific directory structure
 * Structure: src/Catalogs/CatalogName/Catalog.mdo, src/Documents/DocName/Document.mdo, etc.
 */
class EdtParser {
    /**
     * Parse EDT format configuration
     * @param configPath Path to configuration root directory (usually contains 'src' folder)
     * @returns Root tree node
     */
    static async parse(configPath) {
        logger_1.Logger.info('Starting EDT format parsing', configPath);
        try {
            // EDT format has src directory with metadata
            const srcPath = path.join(configPath, 'src');
            try {
                await fs.promises.access(srcPath);
            }
            catch {
                throw new Error(`EDT src directory not found at ${srcPath}`);
            }
            const rootNode = {
                id: 'root',
                name: 'Configuration',
                type: treeNode_1.MetadataType.Configuration,
                properties: {},
                children: [],
                filePath: srcPath,
            };
            // Parse metadata directories in src
            const metadataTypes = metadataTypeMapper_1.MetadataTypeMapper.getMetadataTypes();
            // Process all metadata types in parallel
            const typeNodes = await Promise.all(metadataTypes.map(async (metadataType) => {
                const typePath = path.join(srcPath, metadataType);
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
            logger_1.Logger.info('EDT format parsing completed');
            return rootNode;
        }
        catch (error) {
            logger_1.Logger.error('Error parsing EDT format', error);
            throw error;
        }
    }
    /**
     * Parse metadata type directory (e.g., src/Catalogs/)
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
            logger_1.Logger.warn(`Error reading EDT metadata type directory ${typePath}`, error);
        }
        return typeNode;
    }
    /**
     * Parse metadata element directory (e.g., src/Catalogs/CatalogName/)
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
        // Try to read .mdo file (e.g., Catalog.mdo)
        const mdoFileName = this.getMdoFileName(typeName);
        const mdoPath = path.join(elementPath, mdoFileName);
        try {
            await fs.promises.access(mdoPath);
            try {
                const mdoContent = xmlParser_1.XmlParser.parseFile(mdoPath);
                const properties = this.extractPropertiesFromMdo(mdoContent);
                elementNode.properties = { ...elementNode.properties, ...properties };
            }
            catch (error) {
                logger_1.Logger.warn(`Error parsing MDO file ${mdoPath}`, error);
            }
        }
        catch {
            // MDO file doesn't exist, skip
        }
        // Parse sub-elements (Forms, Attributes, etc.)
        try {
            const items = await fs.promises.readdir(elementPath);
            for (const item of items) {
                if (item === 'Forms' || item === 'Ext') {
                    const subPath = path.join(elementPath, item);
                    const subNode = await this.parseSubElements(subPath, item);
                    if (subNode.children && subNode.children.length > 0) {
                        elementNode.children?.push(subNode);
                    }
                }
            }
        }
        catch (error) {
            logger_1.Logger.debug(`Error reading EDT element directory ${elementPath}`, error);
        }
        return elementNode;
    }
    /**
     * Parse sub-elements (Forms, Ext, etc.)
     * @param subPath Path to sub-elements directory
     * @param subType Type of sub-elements
     * @returns Tree node for sub-elements
     */
    static async parseSubElements(subPath, subType) {
        const subNode = {
            id: subType,
            name: subType,
            type: subType === 'Forms' ? treeNode_1.MetadataType.Form : treeNode_1.MetadataType.Extension,
            properties: {},
            children: [],
            filePath: subPath,
        };
        try {
            const items = await fs.promises.readdir(subPath);
            // Process all sub-elements in parallel
            const subElementNodes = await Promise.all(items.map(async (item) => {
                const itemPath = path.join(subPath, item);
                try {
                    const stat = await fs.promises.stat(itemPath);
                    if (stat.isDirectory()) {
                        return {
                            id: `${subType}.${item}`,
                            name: item,
                            type: subType === 'Forms' ? treeNode_1.MetadataType.Form : treeNode_1.MetadataType.Extension,
                            properties: {},
                            filePath: itemPath,
                        };
                    }
                }
                catch (error) {
                    logger_1.Logger.debug(`Error processing sub-element ${itemPath}`, error);
                }
                return null;
            }));
            // Add non-null sub-element nodes
            for (const subElementNode of subElementNodes) {
                if (subElementNode) {
                    subNode.children?.push(subElementNode);
                }
            }
        }
        catch (error) {
            logger_1.Logger.debug(`Error reading EDT sub-elements directory ${subPath}`, error);
        }
        return subNode;
    }
    /**
     * Extract properties from .mdo file
     * @param mdoContent Parsed MDO content
     * @returns Properties object
     */
    static extractPropertiesFromMdo(mdoContent) {
        const result = {};
        // Find the root element (Catalog, Document, etc.)
        for (const [key, value] of Object.entries(mdoContent)) {
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
     * Get .mdo file name for metadata type
     * @param typeName Type name (e.g., 'Catalogs')
     * @returns MDO file name (e.g., 'Catalog.mdo')
     */
    static getMdoFileName(typeName) {
        const typeMap = {
            Catalogs: 'Catalog.mdo',
            Documents: 'Document.mdo',
            Enums: 'Enum.mdo',
            Reports: 'Report.mdo',
            DataProcessors: 'DataProcessor.mdo',
            ChartsOfCharacteristicTypes: 'ChartOfCharacteristicTypes.mdo',
            ChartsOfAccounts: 'ChartOfAccounts.mdo',
            ChartsOfCalculationTypes: 'ChartOfCalculationTypes.mdo',
            InformationRegisters: 'InformationRegister.mdo',
            AccumulationRegisters: 'AccumulationRegister.mdo',
            AccountingRegisters: 'AccountingRegister.mdo',
            CalculationRegisters: 'CalculationRegister.mdo',
            BusinessProcesses: 'BusinessProcess.mdo',
            Tasks: 'Task.mdo',
            ExternalDataSources: 'ExternalDataSource.mdo',
            Constants: 'Constant.mdo',
            SessionParameters: 'SessionParameter.mdo',
            FilterCriteria: 'FilterCriterion.mdo',
            ScheduledJobs: 'ScheduledJob.mdo',
            FunctionalOptions: 'FunctionalOption.mdo',
            FunctionalOptionsParameters: 'FunctionalOptionsParameter.mdo',
            SettingsStorages: 'SettingsStorage.mdo',
            EventSubscriptions: 'EventSubscription.mdo',
            CommonModules: 'CommonModule.mdo',
            CommandGroups: 'CommandGroup.mdo',
            Roles: 'Role.mdo',
            Interfaces: 'Interface.mdo',
            Styles: 'Style.mdo',
            WebServices: 'WebService.mdo',
            HTTPServices: 'HTTPService.mdo',
            IntegrationServices: 'IntegrationService.mdo',
            Subsystems: 'Subsystem.mdo',
        };
        return typeMap[typeName] || 'Object.mdo';
    }
    /**
     * Detect if path contains EDT format configuration
     * @param configPath Path to check
     * @returns true if EDT format detected
     */
    static async isEdtFormat(configPath) {
        try {
            // EDT format has src directory with .mdo files
            const srcPath = path.join(configPath, 'src');
            try {
                await fs.promises.access(srcPath);
            }
            catch {
                return false;
            }
            // Check if there are metadata type directories with .mdo files
            const metadataTypes = ['Catalogs', 'Documents', 'Enums', 'Reports', 'DataProcessors'];
            for (const type of metadataTypes) {
                const typePath = path.join(srcPath, type);
                try {
                    await fs.promises.access(typePath);
                    const items = await fs.promises.readdir(typePath);
                    for (const item of items) {
                        const itemPath = path.join(typePath, item);
                        try {
                            const stat = await fs.promises.stat(itemPath);
                            if (stat.isDirectory()) {
                                // Check for .mdo file
                                const mdoFiles = (await fs.promises.readdir(itemPath)).filter(f => f.endsWith('.mdo'));
                                if (mdoFiles.length > 0) {
                                    return true;
                                }
                            }
                        }
                        catch {
                            // Skip items that can't be accessed
                        }
                    }
                }
                catch {
                    // Type directory doesn't exist, continue
                }
            }
            return false;
        }
        catch (error) {
            logger_1.Logger.debug('EDT format detection failed', error);
            return false;
        }
    }
}
exports.EdtParser = EdtParser;
//# sourceMappingURL=edtParser.js.map