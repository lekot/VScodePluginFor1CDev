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
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      let xmlContent: string;
      try {
        xmlContent = await fs.promises.readFile(filePath, 'utf-8');
      } catch (readError) {
        throw new Error(
          `Failed to read properties. Unable to read file. ${readError instanceof Error ? readError.message : String(readError)}`
        );
      }

      if (!xmlContent || xmlContent.trim() === '') {
        throw new Error('Failed to read properties. File is empty or invalid.');
      }

      let parsed: unknown;
      try {
        parsed = this.parser.parse(xmlContent);
      } catch (parseError) {
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
        Logger.error(`XML parsing failed for ${filePath}`, parseError);
        throw new Error(
          `Failed to read properties. Invalid XML structure in file. The file may be corrupted or not a valid XML document. ${errorMsg}`
        );
      }

      if (!parsed || typeof parsed !== 'object' || (Object.keys(parsed as object).length === 0 && xmlContent.trim().length > 0)) {
        throw new Error('Failed to read properties. Invalid XML structure in file.');
      }

      const properties = this.extractProperties(parsed);
      Logger.info(`Successfully read properties from ${filePath}`);
      return properties;
    } catch (error) {
      Logger.error(`Error reading properties from ${filePath}`, error);
      
      if (error instanceof Error && error.message.includes('Invalid XML structure')) {
        throw error;
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
      let xmlContent: string;
      try {
        xmlContent = await fs.promises.readFile(filePath, 'utf-8');
      } catch (readError) {
        Logger.error(`Failed to read file for writing: ${filePath}`, readError);
        throw new Error(
          `Failed to write properties. Unable to read file for updating. ${readError instanceof Error ? readError.message : String(readError)}`
        );
      }

      let parsed: unknown;
      try {
        parsed = this.parser.parse(xmlContent);
      } catch (parseError) {
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
        Logger.error(`XML parsing failed for ${filePath}`, parseError);
        throw new Error(
          `Invalid XML structure in file. Cannot update properties in a corrupted XML file. ${errorMsg}`
        );
      }

      const updated = this.updatePropertiesInStructure(parsed, properties);

      let xmlString: string;
      try {
        xmlString = this.builder.build(updated);
      } catch (buildError) {
        Logger.error(`Failed to build XML for ${filePath}`, buildError);
        throw new Error(
          `Failed to generate XML content. ${buildError instanceof Error ? buildError.message : String(buildError)}`
        );
      }

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
      Logger.error(`Error writing properties to ${filePath}`, error);
      
      if (error instanceof Error && 
          (error.message.includes('Invalid XML structure') || 
           error.message.includes('Unable to'))) {
        throw error;
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
      const properties = await this.readProperties(filePath);
      properties[propertyName] = value;
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
   * Write properties for a nested element (Attribute, TabularSection, etc.)
   * Updates only the specific nested element, not the entire file
   * @param filePath Path to XML file
   * @param elementType Type of nested element (e.g., 'Attribute', 'TabularSection')
   * @param elementName Name of the nested element to update
   * @param properties Properties object to write
   * @throws Error if file cannot be written
   */
  static async writeNestedElementProperties(
    filePath: string,
    elementType: string,
    elementName: string,
    properties: Record<string, unknown>
  ): Promise<void> {
    try {
      let xmlContent: string;
      try {
        xmlContent = await fs.promises.readFile(filePath, 'utf-8');
      } catch (readError) {
        Logger.error(`Failed to read file for writing: ${filePath}`, readError);
        throw new Error(
          `Unable to read file for updating. ${readError instanceof Error ? readError.message : String(readError)}`
        );
      }

      let parsed: unknown;
      try {
        parsed = this.parser.parse(xmlContent);
      } catch (parseError) {
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
        Logger.error(`XML parsing failed for ${filePath}`, parseError);
        throw new Error(
          `Invalid XML structure in file. Cannot update properties in a corrupted XML file. ${errorMsg}`
        );
      }

      const updated = this.updateNestedElementInStructure(parsed, elementType, elementName, properties);

      let xmlString: string;
      try {
        xmlString = this.builder.build(updated);
      } catch (buildError) {
        Logger.error(`Failed to build XML for ${filePath}`, buildError);
        throw new Error(
          `Failed to generate XML content. ${buildError instanceof Error ? buildError.message : String(buildError)}`
        );
      }

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

      Logger.info(`Successfully wrote properties for ${elementType} '${elementName}' to ${filePath}`);
    } catch (error) {
      Logger.error(`Error writing nested element properties to ${filePath}`, error);
      
      if (error instanceof Error && 
          (error.message.includes('Invalid XML structure') || 
           error.message.includes('Unable to'))) {
        throw error;
      }
      
      throw new Error(
        `Failed to write nested element properties to XML file: ${filePath}. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Convert string boolean values to actual boolean primitives
   * @param properties Properties object that may contain string "false"/"true" values
   * @returns Properties object with string booleans converted to primitives
   */
  private static convertStringBooleans(properties: Record<string, unknown>): Record<string, unknown> {
    const converted: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(properties)) {
      if (value === 'false') {
        converted[key] = false;
      } else if (value === 'true') {
        converted[key] = true;
      } else {
        converted[key] = value;
      }
    }
    
    return converted;
  }

  private static extractProperties(parsed: unknown): Record<string, unknown> {
    const properties: Record<string, unknown> = {};

    if (!parsed || typeof parsed !== 'object') {
      return properties;
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object') {
          for (const [key, value] of Object.entries(item)) {
            if (key === ':@' || key.startsWith('?')) {
              continue;
            }

            if (key === 'Properties' && Array.isArray(value)) {
              const flattened = this.flattenPropertiesArray(value);
              return this.convertStringBooleans(this.postProcessProperties(flattened));
            }

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

    const obj = parsed as Record<string, unknown>;
    if (obj.Properties && typeof obj.Properties === 'object') {
      const flattened = this.flattenProperties(obj.Properties as Record<string, unknown>);
      return this.convertStringBooleans(this.postProcessProperties(flattened));
    }

    return properties;
  }

  /**
   * Post-process properties to format Type arrays
   */
  private static postProcessProperties(properties: Record<string, unknown>): Record<string, unknown> {
    // Check if Type property is an array that needs formatting
    if (properties.Type && Array.isArray(properties.Type)) {
      try {
        const { TypeParser } = require('../parsers/typeParser');
        const { TypeFormatter } = require('./typeFormatter');
        
        // Merge all type-related elements into a single object
        const typeObject: Record<string, unknown> = {};
        const v8Types: unknown[] = [];
        
        for (const typeItem of properties.Type) {
          if (typeItem && typeof typeItem === 'object') {
            for (const [typeKey, typeValue] of Object.entries(typeItem)) {
              if (typeKey === 'v8:Type') {
                // Collect all v8:Type elements
                if (Array.isArray(typeValue)) {
                  v8Types.push(...typeValue);
                } else {
                  v8Types.push(typeValue);
                }
              } else if (typeKey.startsWith('v8:')) {
                // Collect qualifiers (v8:StringQualifiers, v8:NumberQualifiers, etc.)
                typeObject[typeKey] = typeValue;
              }
            }
          }
        }
        
        // Add collected v8:Type elements to typeObject
        if (v8Types.length > 0) {
          typeObject['v8:Type'] = v8Types;
        }
        
        const typeDef = TypeParser.parseFromObject(typeObject);
        properties.Type = TypeFormatter.formatTypeDisplay(typeDef);
      } catch (error) {
        // If parsing fails, leave as-is
        Logger.error('Failed to format Type property in postProcessProperties', error);
      }
    }
    
    return properties;
  }

  private static flattenPropertiesArray(propertiesArray: unknown[]): Record<string, unknown> {
    const flattened: Record<string, unknown> = {};

    for (const item of propertiesArray) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      for (const [key, value] of Object.entries(item)) {
        if (key === ':@') {
          continue;
        }

        if (key === 'Type' && Array.isArray(value) && value.length > 0) {
          // Handle Type element - collect all v8:Type, qualifiers, etc. from array
          try {
            const { TypeParser } = require('../parsers/typeParser');
            const { TypeFormatter } = require('../utils/typeFormatter');
            
            // Merge all type-related elements into a single object
            const typeObject: Record<string, unknown> = {};
            const v8Types: unknown[] = [];
            
            for (const typeItem of value) {
              if (typeItem && typeof typeItem === 'object') {
                for (const [typeKey, typeValue] of Object.entries(typeItem)) {
                  if (typeKey === 'v8:Type') {
                    // Collect all v8:Type elements
                    if (Array.isArray(typeValue)) {
                      v8Types.push(...typeValue);
                    } else {
                      v8Types.push(typeValue);
                    }
                  } else if (typeKey.startsWith('v8:')) {
                    // Collect qualifiers (v8:StringQualifiers, v8:NumberQualifiers, etc.)
                    typeObject[typeKey] = typeValue;
                  }
                }
              }
            }
            
            // Add collected v8:Type elements to typeObject
            if (v8Types.length > 0) {
              typeObject['v8:Type'] = v8Types;
            }
            
            const typeDef = TypeParser.parseFromObject(typeObject);
            flattened[key] = TypeFormatter.formatTypeDisplay(typeDef);
          } catch (error) {
            // If parsing fails, fall back to raw value
            Logger.error('Failed to parse type in XMLWriter.flattenPropertiesArray', error);
            flattened[key] = value;
          }
        } else if (Array.isArray(value) && value.length > 0) {
          const firstChild = value[0];
          if (firstChild && typeof firstChild === 'object' && '#text' in firstChild) {
            flattened[key] = (firstChild as any)['#text'];
          } else {
            flattened[key] = value;
          }
        } else if (key === 'Type' && value && typeof value === 'object' && 'v8:Type' in value) {
          // Handle Type element when it's a single object (not array)
          try {
            const { TypeParser } = require('../parsers/typeParser');
            const { TypeFormatter } = require('../utils/typeFormatter');
            const typeDef = TypeParser.parseFromObject(value as Record<string, unknown>);
            flattened[key] = TypeFormatter.formatTypeDisplay(typeDef);
          } catch (error) {
            Logger.error('Failed to parse type in XMLWriter.flattenPropertiesArray', error);
            const typeValue = (value as any)['v8:Type'];
            flattened[key] = Array.isArray(typeValue) ? typeValue[0] : typeValue;
          }
        } else {
          flattened[key] = value;
        }
      }
    }

    return flattened;
  }

  private static flattenProperties(properties: Record<string, unknown>): Record<string, unknown> {
    const flattened: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(properties)) {
      if (key.startsWith('@_') || key.startsWith('#')) {
        continue;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        if ('#text' in obj) {
          flattened[key] = obj['#text'];
        } else if ('v8:Type' in obj) {
          // Handle Type element with v8:Type child
          // Parse and format the type for display
          try {
            const { TypeParser } = require('../parsers/typeParser');
            const { TypeFormatter } = require('../utils/typeFormatter');
            const typeDef = TypeParser.parseFromObject(obj);
            flattened[key] = TypeFormatter.formatTypeDisplay(typeDef);
          } catch (error) {
            // If parsing fails, fall back to raw v8:Type value
            Logger.error('Failed to parse type in XMLWriter.flattenProperties', error);
            flattened[key] = obj['v8:Type'];
          }
        } else {
          flattened[key] = value;
        }
      } else {
        flattened[key] = value;
      }
    }

    return flattened;
  }

  private static updatePropertiesInStructure(
    parsed: unknown,
    properties: Record<string, unknown>
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }

    if (Array.isArray(parsed)) {
      return parsed.map((item) => {
        if (!item || typeof item !== 'object') {
          return item;
        }

        const result: Record<string, unknown> = {};
        
        for (const [key, value] of Object.entries(item)) {
          if (key === ':@') {
            result[key] = value;
            continue;
          }

          if (key === 'Properties' && Array.isArray(value)) {
            result[key] = this.updatePropertiesArray(value, properties);
          } else if (Array.isArray(value)) {
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
        if (key === ':@') {
          result[key] = value;
          continue;
        }

        if (key in properties) {
          const newValue = properties[key];
          
          if (Array.isArray(value) && value.length > 0) {
            const firstChild = value[0];
            if (firstChild && typeof firstChild === 'object' && '#text' in firstChild) {
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
          result[key] = value;
        }
      }

      return result;
    });
  }

  private static updateNestedElementInStructure(
    parsed: unknown,
    elementType: string,
    elementName: string,
    properties: Record<string, unknown>
  ): unknown {
    if (!parsed || typeof parsed !== 'object') {
      return parsed;
    }

    if (Array.isArray(parsed)) {
      return parsed.map((item) => {
        if (!item || typeof item !== 'object') {
          return item;
        }

        const result: Record<string, unknown> = {};
        
        for (const [key, value] of Object.entries(item)) {
          if (key === ':@') {
            result[key] = value;
            continue;
          }

          const containerName = elementType + 's';
          if (key === containerName && Array.isArray(value)) {
            result[key] = this.updateNestedElementArray(value, elementType, elementName, properties);
          } else if (Array.isArray(value)) {
            result[key] = this.updateNestedElementInStructure(value, elementType, elementName, properties);
          } else {
            result[key] = value;
          }
        }

        return result;
      });
    }

    return parsed;
  }

  private static updateNestedElementArray(
    elementsArray: unknown[],
    elementType: string,
    elementName: string,
    properties: Record<string, unknown>
  ): unknown[] {
    return elementsArray.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(item)) {
        if (key === ':@') {
          result[key] = value;
          continue;
        }

        if (key === elementType && Array.isArray(value)) {
          const elementData = this.extractNestedElementData(value);
          if (elementData.name === elementName) {
            result[key] = this.updateNestedElementProperties(value, properties);
          } else {
            result[key] = value;
          }
        } else {
          result[key] = value;
        }
      }

      return result;
    });
  }

  private static extractNestedElementData(elementArray: unknown[]): { name: string } {
    for (const item of elementArray) {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if ('Name' in obj && Array.isArray(obj.Name)) {
          const nameArray = obj.Name as unknown[];
          if (nameArray.length > 0 && nameArray[0] && typeof nameArray[0] === 'object') {
            const nameObj = nameArray[0] as Record<string, unknown>;
            if ('#text' in nameObj) {
              return { name: String(nameObj['#text']) };
            }
          }
        }
      }
    }
    return { name: '' };
  }

  private static updateNestedElementProperties(
    elementArray: unknown[],
    properties: Record<string, unknown>
  ): unknown[] {
    return elementArray.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(item)) {
        if (key === ':@') {
          result[key] = value;
          continue;
        }

        if (key in properties) {
          const newValue = properties[key];
          
          if (Array.isArray(value) && value.length > 0) {
            const firstChild = value[0];
            if (firstChild && typeof firstChild === 'object' && '#text' in firstChild) {
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
          result[key] = value;
        }
      }

      return result;
    });
  }
}
