/**
 * XMLWriter utility class for reading and writing XML files
 * while preserving structure and formatting
 */
export declare class XMLWriter {
    private static parser;
    private static builder;
    /**
     * Read properties from XML file
     * @param filePath Path to XML file
     * @returns Properties object extracted from XML
     * @throws Error if file cannot be read or parsed
     */
    static readProperties(filePath: string): Promise<Record<string, unknown>>;
    /**
     * Write properties to XML file
     * Preserves XML structure and formatting
     * @param filePath Path to XML file
     * @param properties Properties object to write
     * @throws Error if file cannot be written
     */
    static writeProperties(filePath: string, properties: Record<string, unknown>): Promise<void>;
    /**
     * Update specific property in XML file
     * Only modifies the target property node
     * @param filePath Path to XML file
     * @param propertyName Name of property to update
     * @param value New value for the property
     * @throws Error if file cannot be read or written
     */
    static updateProperty(filePath: string, propertyName: string, value: unknown): Promise<void>;
    /**
     * Extract properties from parsed XML structure
     * Recursively traverses the XML structure to find property nodes
     * @param parsed Parsed XML object
     * @returns Flat properties object
     */
    private static extractProperties;
    /**
     * Flatten properties object to simple key-value pairs
     * @param properties Properties object
     * @returns Flattened properties
     */
    private static flattenProperties;
    /**
     * Update properties in parsed XML structure
     * Preserves structure while updating values
     * @param parsed Parsed XML object
     * @param properties Properties to update
     * @returns Updated XML structure
     */
    private static updatePropertiesInStructure;
    /**
     * Update properties in a Properties node
     * @param propertiesNode Properties node object
     * @param properties Properties to update
     * @returns Updated properties node
     */
    private static updatePropertiesNode;
}
//# sourceMappingURL=XMLWriter.d.ts.map