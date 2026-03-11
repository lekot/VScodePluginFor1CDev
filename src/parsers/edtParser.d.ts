import { TreeNode } from '../models/treeNode';
/**
 * Parser for 1C EDT (Eclipse Development Tools) format metadata
 * EDT format uses .mdo files in specific directory structure
 * Structure: src/Catalogs/CatalogName/Catalog.mdo, src/Documents/DocName/Document.mdo, etc.
 */
export declare class EdtParser {
    /**
     * Parse EDT format configuration
     * @param configPath Path to configuration root directory (usually contains 'src' folder)
     * @returns Root tree node
     */
    static parse(configPath: string): Promise<TreeNode>;
    /**
     * Parse metadata type directory (e.g., src/Catalogs/)
     * @param typePath Path to metadata type directory
     * @param typeName Name of metadata type
     * @returns Tree node for metadata type
     */
    private static parseMetadataType;
    /**
     * Parse metadata element directory (e.g., src/Catalogs/CatalogName/)
     * @param elementPath Path to element directory
     * @param elementName Name of element
     * @param typeName Type of element
     * @returns Tree node for metadata element
     */
    private static parseMetadataElement;
    /**
     * Parse sub-elements (Forms, Ext, etc.)
     * @param subPath Path to sub-elements directory
     * @param subType Type of sub-elements
     * @returns Tree node for sub-elements
     */
    private static parseSubElements;
    /**
     * Extract properties from .mdo file
     * @param mdoContent Parsed MDO content
     * @returns Properties object
     */
    private static extractPropertiesFromMdo;
    /**
     * Get .mdo file name for metadata type
     * @param typeName Type name (e.g., 'Catalogs')
     * @returns MDO file name (e.g., 'Catalog.mdo')
     */
    private static getMdoFileName;
    /**
     * Detect if path contains EDT format configuration
     * @param configPath Path to check
     * @returns true if EDT format detected
     */
    static isEdtFormat(configPath: string): Promise<boolean>;
}
//# sourceMappingURL=edtParser.d.ts.map