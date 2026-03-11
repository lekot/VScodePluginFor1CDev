import * as fs from 'fs';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { Logger } from './logger';

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
export class XMLWriter {
  private static parser = new XMLParser(XML_WRITER_OPTIONS);
  private static builder = new XMLBuilder(XML_WRITER_OPTIONS);

  /**
   * Read properties from XML file
   * @param filePath Path to XML file
   * @returns Properties object extracted from XML
   * @throws Error if file cannot be read or parsed
   */
  static async readProperties(filePath: string): Promise<Record<string, unknown>> {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Read file content
      let xmlContent: string;
      try {
        xmlContent = await fs.promises.readFile(filePath, 'utf-8');
      } catch (readError) {
        throw new Error(
          `Unable to read file. ${readError instanceof Error ? readError.message : String(readError)}`
        );
      }

      // Parse XML with error handling
      let parsed: any;
      try {
        parsed = this.parser.parse(xmlContent);
      } catch (parseError) {
        // Handle XML parse errors with user-friendly messages
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
        Logger.error(`XML parsing failed for ${filePath}`, parseError);
        throw new Error(
          `Invalid XML structure in file. The file may be corrupted or not a valid XML document. ${errorMsg}`
        );
      }

      // Extract properties from parsed XML
      const properties = this.extractProperties(parsed);

      Logger.info(`Successfully read properties from ${filePath}`);
      return properties;
    } catch (error) {
      // Log detailed error to extension output channel
      Logger.error(`Error reading properties from ${filePath}`, error);
      
      // Re-throw with context
      if (error instanceof Error && error.message.includes('Invalid XML structure')) {
        throw error; // Already has user-friendly message
      }
      
      throw new Error(
        `Failed to read properties from XML file: ${filePath}. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Write properties to XML file
   * Preserves XML structure and formatting
   * @param filePath Path to XML file
   * @param properties Properties object to write
   * @throws Error if file cannot be written
   */
  static async writeProperties(
    filePath: string,
    properties: Record<string, unknown>
  ): Promise<void> {
    try {
      // Read existing XML content
      let xmlContent: string;
      try {
        xmlContent = await fs.promises.readFile(filePath, 'utf-8');
      } catch (readError) {
        Logger.error(`Failed to read file for writing: ${filePath}`, readError);
        throw new Error(
          `Unable to read file for updating. ${readError instanceof Error ? readError.message : String(readError)}`
        );
      }

      // Parse existing XML with error handling
      let parsed: any;
      try {
        parsed = this.parser.parse(xmlContent);
      } catch (parseError) {
        // Handle XML parse errors with user-friendly messages
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
        Logger.error(`XML parsing failed for ${filePath}`, parseError);
        throw new Error(
          `Invalid XML structure in file. Cannot update properties in a corrupted XML file. ${errorMsg}`
        );
      }

      // Update properties in parsed structure
      const updated = this.updatePropertiesInStructure(parsed, properties);

      // Build XML string with preserved formatting
      let xmlString: string;
      try {
        xmlString = this.builder.build(updated);
      } catch (buildError) {
        Logger.error(`Failed to build XML for ${filePath}`, buildError);
        throw new Error(
          `Failed to generate XML content. ${buildError instanceof Error ? buildError.message : String(buildError)}`
        );
      }

      // Write back to file with error handling
      try {
        await fs.promises.writeFile(filePath, xmlString, 'utf-8');
      } catch (writeError) {
        Logger.error(`Failed to write file: ${filePath}`, writeError);
        throw new Error(
          `Unable to write to file. Check file permissions and disk space. ${
            writeError instanceof Error ? writeError.message : String(writeError)
          }`
        );
      }

      Logger.info(`Successfully wrote properties to ${filePath}`);
    } catch (error) {
      // Log detailed error to extension output channel
      Logger.error(`Error writing properties to ${filePath}`, error);
      
      // Re-throw with context (preserve user-friendly messages)
      if (error instanceof Error && 
          (error.message.includes('Invalid XML structure') || 
           error.message.includes('Unable to'))) {
        throw error; // Already has user-friendly message
      }
      
      throw new Error(
        `Failed to write properties to XML file: ${filePath}. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
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
  static async updateProperty(
    filePath: string,
    propertyName: string,
    value: unknown
  ): Promise<void> {
    try {
      // Read existing properties
      const properties = await this.readProperties(filePath);

      // Update specific property
      properties[propertyName] = value;

      // Write back all properties
      await this.writeProperties(filePath, properties);

      Logger.info(`Successfully updated property '${propertyName}' in ${filePath}`);
    } catch (error) {
      Logger.error(`Error updating property '${propertyName}' in ${filePath}`, error);
      throw new Error(
        `Failed to update property '${propertyName}' in XML file: ${filePath}. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Extract properties from parsed XML structure
   * Handles preserveOrder mode where structure is array-based
   * @param parsed Parsed XML object (array format from preserveOrder: true)
   * @returns Flat properties object
   */
  private static extractProperties(parsed: unknown): Record<string, unknown> {
    const properties: Record<string, unknown> = {};

    if (!parsed || typeof parsed !== 'object') {
      return properties;
    }

    // Handle array of nodes (preserveOrder mode)
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object') {
          // Each item is { tagName: [children], ":@": attributes }
          for (const [key, value] of Object.entries(item)) {
            // Skip attributes and special nodes
            if (key === ':@' || key.startsWith('?')) {
              continue;
            }

            // Check if this is a Properties node
            if (key === 'Properties' && Array.isArray(value)) {
              return this.flattenPropertiesArray(value);
            }

            // Recursively search in children
            if (Array.isArray(value)) {
              const nested = this.extractProperties(value);
              if (Object.keys(nested).length > 0) {
                return nested;
              }
            }
          }
        }
      }
      return properties;
    }

    // Fallback for non-array structure (shouldn't happen with preserveOrder: true)
    const obj = parsed as Record<string, unknown>;
    if (obj.Properties && typeof obj.Properties === 'object') {
      return this.flattenProperties(obj.Properties as Record<string, unknown>);
    }

    return properties;
  }

  /**
   * Flatten properties array from preserveOrder mode
   * @param propertiesArray Array of property nodes
   * @returns Flattened properties object
   */
  private static flattenPropertiesArray(propertiesArray: unknown[]): Record<string, unknown> {
    const flattened: Record<string, unknown> = {};

    for (const item of propertiesArray) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      // Each item is { propertyName: [{ "#text": value }] }
      for (const [key, value] of Object.entries(item)) {
        // Skip attributes
        if (key === ':@') {
          continue;
        }

        // Extract value from array structure
        if (Array.isArray(value) && value.length > 0) {
          const firstChild = value[0];
          if (firstChild && typeof firstChild === 'object' && '#text' in firstChild) {
            flattened[key] = (firstChild as any)['#text'];
          } else {
            // Complex nested structure - keep as is for now
            flattened[key] = value;
          }
        } else {
          flattened[key] = value;
        }
      }
    }

    return flattened;
  }

  /**
   * Flatten properties object to simple key-value pairs
   * @param properties Properties object
   * @returns Flattened properties
   */
  private static flattenProperties(properties: Record<string, unknown>): Record<string, unknown> {
    const flattened: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(properties)) {
      // Skip XML attributes and special nodes
      if (key.startsWith('@_') || key.startsWith('#')) {
        continue;
      }

      // Extract text content if it's a simple node
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        if ('#text' in obj) {
          flattened[key] = obj['#text'];
        } else {
          flattened[key] = value;
        }
      } else {
        flattened[key] = value;
      }
    }

    return flattened;
  }

  /**
   * Update properties in parsed XML structure
   * Handles preserveOrder mode where structure is array-based
   * @param parsed Parsed XML object
   * @param properties Properties to update
   * @returns Updated XML structure
   */
  private static updatePropertiesInStructure(
    parsed: unknown,
    properties: Record<string, unknown>
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }

    // Handle array of nodes (preserveOrder mode)
    if (Array.isArray(parsed)) {
      return parsed.map((item) => {
        if (!item || typeof item !== 'object') {
          return item;
        }

        const result: Record<string, unknown> = {};
        
        for (const [key, value] of Object.entries(item)) {
          // Preserve attributes
          if (key === ':@') {
            result[key] = value;
            continue;
          }

          // Check if this is a Properties node
          if (key === 'Properties' && Array.isArray(value)) {
            result[key] = this.updatePropertiesArray(value, properties);
          } else if (Array.isArray(value)) {
            // Recursively update children
            result[key] = this.updatePropertiesInStructure(value, properties);
          } else {
            result[key] = value;
          }
        }

        return result;
      });
    }

    return parsed;
  }

  /**
   * Update properties array from preserveOrder mode
   * @param propertiesArray Array of property nodes
   * @param properties Properties to update
   * @returns Updated properties array
   */
  private static updatePropertiesArray(
    propertiesArray: unknown[],
    properties: Record<string, unknown>
  ): unknown[] {
    return propertiesArray.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(item)) {
        // Preserve attributes
        if (key === ':@') {
          result[key] = value;
          continue;
        }

        // Check if this property should be updated
        if (key in properties) {
          // Update the value while preserving structure
          const newValue = properties[key];
          
          if (Array.isArray(value) && value.length > 0) {
            const firstChild = value[0];
            if (firstChild && typeof firstChild === 'object' && '#text' in firstChild) {
              // Preserve the array structure with #text
              // Convert value to appropriate type for XML
              const textValue = typeof newValue === 'boolean' || typeof newValue === 'number' 
                ? newValue 
                : String(newValue);
              result[key] = [{ ...firstChild, '#text': textValue }];
            } else {
              const textValue = typeof newValue === 'boolean' || typeof newValue === 'number'
                ? newValue
                : String(newValue);
              result[key] = [{ '#text': textValue }];
            }
          } else {
            const textValue = typeof newValue === 'boolean' || typeof newValue === 'number'
              ? newValue
              : String(newValue);
            result[key] = [{ '#text': textValue }];
          }
        } else {
          // Keep original value
          result[key] = value;
        }
      }

      return result;
    });
  }
}
