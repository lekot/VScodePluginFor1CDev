/**
 * XML Parser for 1C metadata files
 */
export declare class XmlParser {
    private static parser;
    private static builder;
    /**
     * Parse XML file and return parsed object
     * @param filePath Path to XML file
     * @returns Parsed XML object
     */
    static parseFile(filePath: string): Record<string, unknown>;
    /**
     * Parse XML string and return parsed object
     * @param xmlString XML content as string
     * @returns Parsed XML object
     */
    static parseString(xmlString: string): Record<string, unknown>;
    /**
     * Convert object to XML string
     * @param obj Object to convert
     * @returns XML string
     */
    static objectToXml(obj: Record<string, unknown>): string;
    /**
     * Get root element name from XML file
     * @param filePath Path to XML file
     * @returns Root element name
     */
    static getRootElementName(filePath: string): string;
    /**
     * Get element by path from parsed XML
     * @param obj Parsed XML object
     * @param path Path to element (e.g., 'Configuration.Properties.Name')
     * @returns Element value or undefined
     */
    static getElementByPath(obj: Record<string, unknown>, elementPath: string): unknown;
    /**
     * Set element by path in parsed XML
     * @param obj Parsed XML object
     * @param elementPath Path to element
     * @param value Value to set
     */
    static setElementByPath(obj: Record<string, unknown>, elementPath: string, value: unknown): void;
    /**
     * Validate XML structure
     * @param filePath Path to XML file
     * @returns true if valid XML
     */
    static isValidXml(filePath: string): boolean;
}
//# sourceMappingURL=xmlParser.d.ts.map