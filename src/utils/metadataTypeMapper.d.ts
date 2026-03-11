import { MetadataType } from '../models/treeNode';
/**
 * Utility class for mapping metadata type strings to MetadataType enum
 * Centralizes the type mapping logic used by both Designer and EDT parsers
 */
export declare class MetadataTypeMapper {
    private static readonly TYPE_MAP;
    /**
     * Map string type to MetadataType enum
     * @param typeString Type string from directory name
     * @returns MetadataType enum value
     */
    static map(typeString: string): MetadataType;
    /**
     * Get list of all metadata type directory names
     * @returns Array of metadata type names
     */
    static getMetadataTypes(): string[];
    /**
     * Check if type string is valid metadata type
     * @param typeString Type string to check
     * @returns true if valid
     */
    static isValidType(typeString: string): boolean;
}
//# sourceMappingURL=metadataTypeMapper.d.ts.map