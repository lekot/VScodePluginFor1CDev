import * as fs from 'fs';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { Logger } from './logger';
import {
  getDefaultPropertiesForRootTag,
  getDefaultPropertiesForNestedElement,
} from '../constants/metadataDefaultValues';

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

      const backupPath = `${filePath}.bak`;
      try {
        await fs.promises.writeFile(backupPath, xmlContent, 'utf-8');
      } catch (backupErr) {
        Logger.warn(`Failed to create backup ${backupPath}`, backupErr);
      }

      try {
        await fs.promises.writeFile(filePath, xmlString, 'utf-8');
      } catch (writeError) {
        Logger.error(`Failed to write file: ${filePath}`, writeError);
        try {
          if (fs.existsSync(backupPath)) {
            const restored = await fs.promises.readFile(backupPath, 'utf-8');
            await fs.promises.writeFile(filePath, restored, 'utf-8');
            await fs.promises.unlink(backupPath);
            Logger.info(`Rolled back ${filePath} from backup`);
          }
        } catch (rollbackErr) {
          Logger.error(`Rollback failed for ${filePath}`, rollbackErr);
        }
        throw new Error(
          `Unable to write to file. Check file permissions and disk space. ${
            writeError instanceof Error ? writeError.message : String(writeError)
          }`
        );
      }

      try {
        if (fs.existsSync(backupPath)) {
          await fs.promises.unlink(backupPath);
        }
      } catch {
        Logger.debug(`Could not remove backup ${backupPath}`);
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
   * Add a nested element (Attribute or TabularSection) to ChildObjects in the XML file.
   * @param filePath Path to XML file
   * @param elementType 'Attribute' or 'TabularSection'
   * @param elementName Name of the new element
   * @param minimalProperties Optional minimal properties (Name is always set)
   * @throws Error if file cannot be read or written
   */
  static async addNestedElement(
    filePath: string,
    elementType: string,
    elementName: string,
    minimalProperties?: Record<string, unknown>
  ): Promise<void> {
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = this.parser.parse(xmlContent);
    const updated = this.addNestedElementInStructure(parsed, elementType, elementName, minimalProperties ?? {});
    const xmlString = this.builder.build(updated);
    await fs.promises.writeFile(filePath, xmlString, 'utf-8');
    Logger.info(`Added ${elementType} '${elementName}' to ${filePath}`);
  }

  /**
   * Remove a nested element from ChildObjects in the XML file.
   * @param filePath Path to XML file
   * @param elementType 'Attribute' or 'TabularSection'
   * @param elementName Name of the element to remove
   * @throws Error if file cannot be read or written
   */
  static async removeNestedElement(
    filePath: string,
    elementType: string,
    elementName: string
  ): Promise<void> {
    const xmlContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = this.parser.parse(xmlContent);
    const updated = this.removeNestedElementInStructure(parsed, elementType, elementName);
    const xmlString = this.builder.build(updated);
    await fs.promises.writeFile(filePath, xmlString, 'utf-8');
    Logger.info(`Removed ${elementType} '${elementName}' from ${filePath}`);
  }

  /**
   * Create a new XML file with minimal Designer structure for a metadata element.
   * @param filePath Path for the new file
   * @param rootTag Root element tag (e.g. 'Catalog', 'Document', 'Enum')
   * @param elementName Name of the element
   * @throws Error if file cannot be written
   */
  static async createMinimalElementFile(
    filePath: string,
    rootTag: string,
    elementName: string
  ): Promise<void> {
    const uuid = this.generateSimpleUuid();
    const defaultProps = getDefaultPropertiesForRootTag(rootTag);
    const defaultPropsLines = this.formatDefaultPropertiesAsXml(defaultProps);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
\t<${rootTag} uuid="${uuid}">
\t\t<Properties>
\t\t\t<Name>${this.escapeXml(elementName)}</Name>
\t\t\t<Synonym>
\t\t\t\t<v8:item>
\t\t\t\t\t<v8:lang>ru</v8:lang>
\t\t\t\t\t<v8:content>${this.escapeXml(elementName)}</v8:content>
\t\t\t\t</v8:item>
\t\t\t</Synonym>
\t\t\t<Comment/>
${defaultPropsLines}\t\t</Properties>
\t\t<ChildObjects/>
\t</${rootTag}>
</MetaDataObject>
`;
    await fs.promises.writeFile(filePath, content, 'utf-8');
    Logger.info(`Created minimal ${rootTag} file ${filePath}`);
  }

  private static formatDefaultPropertiesAsXml(props: Record<string, unknown>): string {
    if (Object.keys(props).length === 0) return '';
    return Object.entries(props)
      .map(([key, value]) => `\t\t\t<${key}>${this.escapeXml(String(value))}</${key}>`)
      .join('\n') + '\n';
  }

  private static generateSimpleUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private static escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private static addNestedElementInStructure(
    parsed: unknown,
    elementType: string,
    elementName: string,
    minimalProperties: Record<string, unknown>
  ): unknown {
    const containerName = elementType === 'Attribute' ? 'ChildObjects' : elementType + 's';
    const newBlock = this.buildMinimalNestedElement(elementType, elementName, minimalProperties);
    return this.mutateChildObjectsArray(parsed, containerName, elementType, (arr) => {
      arr.push(newBlock);
    });
  }

  private static removeNestedElementInStructure(
    parsed: unknown,
    elementType: string,
    elementName: string
  ): unknown {
    const containerName = elementType === 'Attribute' ? 'ChildObjects' : elementType + 's';
    return this.mutateChildObjectsArray(parsed, containerName, elementType, (arr) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const item = arr[i];
        if (item && typeof item === 'object' && elementType in (item as object)) {
          const inner = (item as Record<string, unknown>)[elementType];
          if (Array.isArray(inner)) {
            const name = this.extractNameFromElementArray(inner);
            if (name === elementName) {
              arr.splice(i, 1);
              return;
            }
          }
        }
      }
    });
  }

  private static extractNameFromElementArray(elementArray: unknown[]): string {
    for (const it of elementArray) {
      if (!it || typeof it !== 'object') continue;
      const o = it as Record<string, unknown>;
      if ('Name' in o && Array.isArray(o.Name) && o.Name.length > 0) {
        const first = o.Name[0];
        if (first && typeof first === 'object' && '#text' in (first as object)) {
          return String((first as Record<string, unknown>)['#text']);
        }
      }
      if ('Properties' in o && Array.isArray(o.Properties)) {
        const inner = this.extractNameFromElementArray(o.Properties as unknown[]);
        if (inner) return inner;
      }
    }
    return '';
  }

  private static buildMinimalNestedElement(
    elementType: string,
    elementName: string,
    minimalProperties: Record<string, unknown>
  ): Record<string, unknown> {
    const uuid = this.generateSimpleUuid();
    const defaults =
      elementType === 'Attribute' || elementType === 'TabularSection'
        ? getDefaultPropertiesForNestedElement(elementType as 'Attribute' | 'TabularSection')
        : {};
    const merged = { ...defaults, ...minimalProperties, Name: elementName };

    const properties: unknown[] = [
      { Name: [{ '#text': elementName }] },
      {
        Synonym: [
          {
            'v8:item': [
              { 'v8:lang': [{ '#text': 'ru' }] },
              { 'v8:content': [{ '#text': elementName }] },
            ],
          },
        ],
      },
    ];

    if (elementType === 'Attribute') {
      properties.push({
        Type: [
          {
            'v8:Type': [{ '#text': 'xs:string' }],
            'v8:StringQualifiers': [
              { Length: [{ '#text': '50' }] },
              { AllowedLength: [{ '#text': 'Variable' }] },
            ],
          },
        ],
      });
    }

    for (const [key, value] of Object.entries(merged)) {
      if (key === 'Name' || key === 'Synonym' || key === 'Type') continue;
      if (value !== undefined && value !== null) {
        properties.push({ [key]: [{ '#text': String(value) }] });
      }
    }

    return {
      [elementType]: [{ '@_uuid': uuid }, { Properties: properties }],
    };
  }

  private static mutateChildObjectsArray(
    parsed: unknown,
    containerName: string,
    _elementType: string,
    mutate: (arr: unknown[]) => void
  ): unknown {
    if (!parsed || typeof parsed !== 'object') return parsed;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const obj = item as Record<string, unknown>;
        for (const [key, value] of Object.entries(obj)) {
          if (key === containerName && Array.isArray(value)) {
            mutate(value);
            return obj;
          }
          if (Array.isArray(value)) {
            const updated = this.mutateChildObjectsArray(value, containerName, _elementType, mutate);
            if (updated !== value) {
              const result = { ...obj, [key]: updated };
              return result;
            }
          }
        }
        return obj;
      });
    }
    return parsed;
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

      const backupPath = `${filePath}.bak`;
      try {
        await fs.promises.writeFile(backupPath, xmlContent, 'utf-8');
      } catch (backupErr) {
        Logger.warn(`Failed to create backup ${backupPath}`, backupErr);
      }

      try {
        await fs.promises.writeFile(filePath, xmlString, 'utf-8');
      } catch (writeError) {
        Logger.error(`Failed to write file: ${filePath}`, writeError);
        try {
          if (fs.existsSync(backupPath)) {
            const restored = await fs.promises.readFile(backupPath, 'utf-8');
            await fs.promises.writeFile(filePath, restored, 'utf-8');
            await fs.promises.unlink(backupPath);
            Logger.info(`Rolled back ${filePath} from backup`);
          }
        } catch (rollbackErr) {
          Logger.error(`Rollback failed for ${filePath}`, rollbackErr);
        }
        throw new Error(
          `Unable to write to file. Check file permissions and disk space. ${
            writeError instanceof Error ? writeError.message : String(writeError)
          }`
        );
      }

      try {
        if (fs.existsSync(backupPath)) {
          await fs.promises.unlink(backupPath);
        }
      } catch {
        Logger.debug(`Could not remove backup ${backupPath}`);
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

    // Recurse into nested structure (e.g. MetaDataObject → Configuration → Properties)
    for (const [k, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;
      if (k === ':@' || (typeof k === 'string' && k.startsWith('?'))) continue;
      const nested = this.extractProperties(value);
      if (Object.keys(nested).length > 0) {
        return nested;
      }
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
            const rec = firstChild as Record<string, unknown>;
            flattened[key] = rec['#text'];
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
            const valueRec = value as Record<string, unknown>;
            const typeValue = valueRec['v8:Type'];
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

          // Designer format: attributes live under ChildObjects, not Attributes
          const containerName = elementType === 'Attribute' ? 'ChildObjects' : elementType + 's';
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
    const extractNameFrom = (arr: unknown[]): string => {
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        const o = it as Record<string, unknown>;
        if ('Name' in o && Array.isArray(o.Name)) {
          const nameArr = o.Name as unknown[];
          if (nameArr.length > 0 && nameArr[0] && typeof nameArr[0] === 'object') {
            const nameObj = nameArr[0] as Record<string, unknown>;
            if ('#text' in nameObj) return String(nameObj['#text']);
          }
        }
        if ('Properties' in o && Array.isArray(o.Properties)) {
          const inner = extractNameFrom(o.Properties as unknown[]);
          if (inner) return inner;
        }
      }
      return '';
    };
    const name = extractNameFrom(elementArray);
    return { name };
  }

  /** Extract Type element content from parser output (handles preserveOrder root array) */
  private static extractTypeContentFromParsed(parsed: unknown): unknown[] | unknown | null {
    if (!parsed || typeof parsed !== 'object') return null;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object' && 'Type' in (item as Record<string, unknown>)) {
          const inner = (item as Record<string, unknown>).Type;
          return inner != null ? inner : null;
        }
      }
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    return 'Type' in obj ? obj.Type ?? null : null;
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

        // Designer format: Attribute props (Type, Name, etc.) live inside Properties
        if (key === 'Properties' && Array.isArray(value)) {
          result[key] = this.updateNestedElementProperties(value, properties);
          continue;
        }

        if (key in properties) {
          const newValue = properties[key];

          // Don't write object values as "[object Object]" — 1C XDTO expects proper XML or primitives
          if (typeof newValue === 'object' && newValue !== null && !Array.isArray(newValue)) {
            result[key] = value;
            continue;
          }

          // Type from type editor is sent as XML string; write as structured content, not #text
          if (key === 'Type' && typeof newValue === 'string' && newValue.trim().includes('<')) {
            try {
              const typeParsed = this.parser.parse(newValue.trim());
              const inner = this.extractTypeContentFromParsed(typeParsed);
              if (inner != null) {
                result[key] = Array.isArray(inner) ? inner : [inner];
              } else {
                result[key] = [{ '#text': newValue }];
              }
            } catch (parseErr) {
              Logger.error('Failed to parse Type XML in updateNestedElementProperties', parseErr);
              result[key] = [{ '#text': newValue }];
            }
          } else if (Array.isArray(value) && value.length > 0) {
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
