import { TreeNode } from '../models/treeNode';
/**
 * Parser for 1C Designer format metadata
 * Designer format uses structured XML files in specific directory structure
 * with 1cv8.cf or 1cv8.cfe file in root
 */
export declare class DesignerParser {
    /**
     * Parse Designer format configuration
     * @param configPath Path to configuration root directory
     * @returns Root tree node
     */
    static parse(configPath: string): Promise<TreeNode>;
    /**
     * Build tree from configuration metadata
     * @param configPath Path to configuration root
     * @returns Root tree node
     */
    private static buildTreeFromConfiguration;
    /**
     * Parse metadata type directory
     * @param typePath Path to metadata type directory
     * @param typeName Name of metadata type
     * @returns Tree node for metadata type
     */
    private static parseMetadataType;
    /**
     * Parse metadata element directory
     * @param elementPath Path to element directory
     * @param elementName Name of element
     * @param typeName Type of element
     * @returns Tree node for metadata element
     */
    private static parseMetadataElement;
    /**
     * Parse extensions directory
     * @param extPath Path to Ext directory
     * @returns Tree node for extensions
     */
    private static parseExtensions;
    /**
     * Extract properties from metadata element XML
     * @param xmlContent Parsed XML content
     * @returns Properties object
     */
    private static extractPropertiesFromElement;
    /**
     * Detect if path contains Designer format configuration
     * @param configPath Path to check
     * @returns true if Designer format detected
     */
    static isDesignerFormat(configPath: string): Promise<boolean>;
}
//# sourceMappingURL=designerParser.d.ts.map