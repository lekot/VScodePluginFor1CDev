import * as fs from 'fs';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { XmlParser } from './xmlParser';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import { convertStringBooleans } from '../utils/xmlPropertyUtils';

/**
 * Parser for 1C Designer format metadata
 * Designer format uses structured XML files in specific directory structure
 * with 1cv8.cf or 1cv8.cfe file in root
 */
export class DesignerParser {
  /**
   * Parse Designer format configuration
   * @param configPath Path to configuration root directory
   * @returns Root tree node
   */
  static async parse(configPath: string): Promise<TreeNode> {
    Logger.info('Starting Designer format parsing', configPath);

    try {
      // Read ConfigDumpInfo.xml or Configuration.xml
      let configXmlPath = path.join(configPath, 'ConfigDumpInfo.xml');
      if (!fs.existsSync(configXmlPath)) {
        configXmlPath = path.join(configPath, 'Configuration.xml');
      }

      if (!fs.existsSync(configXmlPath)) {
        throw new Error(`Configuration metadata file not found at ${configPath}`);
      }

      const rootNode = await this.buildTreeFromConfiguration(configPath);

      Logger.info('Designer format parsing completed');
      return rootNode;
    } catch (error) {
      Logger.error('Error parsing Designer format', error);
      throw error;
    }
  }

  /**
   * Build tree from configuration metadata
   * @param configPath Path to configuration root
   * @returns Root tree node
   */
  private static async buildTreeFromConfiguration(
    configPath: string
  ): Promise<TreeNode> {
    const rootNode: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
      filePath: configPath,
    };

    // Parse metadata directories
    const metadataTypes = MetadataTypeMapper.getMetadataTypes();

    // Process all metadata types in parallel
    const typeNodes = await Promise.all(
      metadataTypes.map(async (metadataType) => {
        const typePath = path.join(configPath, metadataType);
        try {
          await fs.promises.access(typePath);
          return await this.parseMetadataType(typePath, metadataType);
        } catch {
          return null;
        }
      })
    );

    // Add non-empty type nodes to root and set parent
    for (const typeNode of typeNodes) {
      if (typeNode && typeNode.children && typeNode.children.length > 0) {
        typeNode.parent = rootNode;
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
  private static async parseMetadataType(typePath: string, typeName: string): Promise<TreeNode> {
    const metadataType = MetadataTypeMapper.map(typeName);

    const typeNode: TreeNode = {
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
      const elementNodes = await Promise.all(
        items.map(async (item) => {
          const itemPath = path.join(typePath, item);
          try {
            const stat = await fs.promises.stat(itemPath);

            if (stat.isDirectory()) {
              // This is a metadata element directory
              return await this.parseMetadataElement(itemPath, item, typeName);
            }
          } catch (error) {
            Logger.debug(`Error processing item ${itemPath}`, error);
          }
          return null;
        })
      );

      // Add non-null element nodes and set parent
      for (const elementNode of elementNodes) {
        if (elementNode) {
          elementNode.parent = typeNode;
          typeNode.children?.push(elementNode);
        }
      }
    } catch (error) {
      Logger.warn(`Error reading metadata type directory ${typePath}`, error);
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
  private static async parseMetadataElement(elementPath: string, elementName: string, typeName: string): Promise<TreeNode> {
    const metadataType = MetadataTypeMapper.map(typeName);

    const elementNode: TreeNode = {
      id: `${typeName}.${elementName}`,
      name: elementName,
      type: metadataType,
      properties: { type: typeName },
      children: [],
      filePath: elementPath,
    };

    // Try to read metadata XML file
    // XML file is in the parent directory (e.g., CommonModules/Module.xml, not CommonModules/Module/Module.xml)
    const xmlPath = path.join(path.dirname(elementPath), `${elementName}.xml`);
    let xmlContent: Record<string, unknown> | null = null;
    try {
      await fs.promises.access(xmlPath);
      try {
        xmlContent = await XmlParser.parseFileAsync(xmlPath);
        const properties = this.extractPropertiesFromElement(xmlContent);
        elementNode.properties = { ...elementNode.properties, ...properties };
        
        // Update filePath to point to XML file for property editing
        elementNode.filePath = xmlPath;
      } catch (error) {
        Logger.warn(`Error parsing element XML ${xmlPath}`, error);
      }
    } catch {
      // XML file doesn't exist, skip
    }

    // Parse Attributes from XML ChildObjects if available
    if (xmlContent) {
      const attributesNode = await this.parseAttributesFromXML(xmlContent, elementPath, elementName);
      if (attributesNode && attributesNode.children && attributesNode.children.length > 0) {
        attributesNode.parent = elementNode;
        elementNode.children?.push(attributesNode);
      }
    }

    // Parse sub-elements (Ext, Forms, Attributes, etc.)
    try {
      const items = await fs.promises.readdir(elementPath);

      for (const item of items) {
        if (item === 'Ext') {
          // Special handling for CommonModule - add .bsl files directly without Extensions container
          if (typeName === 'CommonModules') {
            const extPath = path.join(elementPath, item);
            try {
              const extItems = await fs.promises.readdir(extPath);
              for (const extItem of extItems) {
                if (extItem.endsWith('.bsl')) {
                  const bslPath = path.join(extPath, extItem);
                  const child: TreeNode = {
                    id: `${typeName}.${elementName}.${extItem}`,
                    name: extItem,
                    type: MetadataType.Method,
                    properties: {},
                    filePath: bslPath,
                  };
                  child.parent = elementNode;
                  elementNode.children?.push(child);
                }
              }
            } catch (error) {
              Logger.debug(`Error reading Ext directory for CommonModule ${elementPath}`, error);
            }
          } else {
            // For other types, use Extensions container
            const extPath = path.join(elementPath, item);
            const extNode = await this.parseExtensions(extPath);
            if (extNode.children && extNode.children.length > 0) {
              extNode.parent = elementNode;
              elementNode.children?.push(extNode);
            }
          }
        } else if (item === 'Forms') {
          // Parse forms
          const formsPath = path.join(elementPath, item);
          const formsNode = await this.parseForms(formsPath);
          if (formsNode.children && formsNode.children.length > 0) {
            formsNode.parent = elementNode;
            elementNode.children?.push(formsNode);
          }
        } else if (item === 'Attributes') {
          // Parse attributes (реквизиты)
          const attributesPath = path.join(elementPath, item);
          const attributesNode = await this.parseAttributes(attributesPath);
          if (attributesNode.children && attributesNode.children.length > 0) {
            attributesNode.parent = elementNode;
            elementNode.children?.push(attributesNode);
          }
        } else if (item === 'TabularSections') {
          // Parse tabular sections
          const tabularPath = path.join(elementPath, item);
          const tabularNode = await this.parseTabularSections(tabularPath);
          if (tabularNode.children && tabularNode.children.length > 0) {
            tabularNode.parent = elementNode;
            elementNode.children?.push(tabularNode);
          }
        }
      }
    } catch (error) {
      Logger.debug(`Error reading element directory ${elementPath}`, error);
    }

    return elementNode;
  }

  /**
   * Parse extensions directory
   * @param extPath Path to Ext directory
   * @returns Tree node for extensions
   */
  private static async parseExtensions(extPath: string): Promise<TreeNode> {
    const extNode: TreeNode = {
      id: 'Ext',
      name: 'Extensions',
      type: MetadataType.Extension,
      properties: {},
      children: [],
      filePath: extPath,
    };

    try {
      const items = await fs.promises.readdir(extPath);

      // Process all extension items in parallel
      const extElementNodes = await Promise.all(
        items.map(async (item) => {
          const itemPath = path.join(extPath, item);
          try {
            const stat = await fs.promises.stat(itemPath);

            if (stat.isDirectory()) {
              // For directories like "Form", recursively search for .bsl files
              const bslFiles = await this.findBslFilesRecursive(itemPath);
              if (bslFiles.length > 0) {
                // Create a container node with .bsl files as children
                return {
                  id: `Ext.${item}`,
                  name: item,
                  type: MetadataType.Extension,
                  properties: { isExtension: true },
                  filePath: itemPath,
                  children: bslFiles.map(bslPath => ({
                    id: `Ext.${item}.${path.basename(bslPath)}`,
                    name: path.basename(bslPath),
                    type: MetadataType.Method,
                    properties: { 
                      isModule: true,
                      fileType: 'bsl'
                    },
                    filePath: bslPath,
                  })),
                };
              }
              return null; // Skip empty directories
            } else if (stat.isFile() && item.endsWith('.bsl')) {
              // Add .bsl module files directly
              return {
                id: `Ext.${item}`,
                name: item,
                type: MetadataType.Method,
                properties: { 
                  isModule: true,
                  fileType: 'bsl'
                },
                filePath: itemPath,
              };
            }
          } catch (error) {
            Logger.debug(`Error processing extension ${itemPath}`, error);
          }
          return null;
        })
      );

      // Add non-null extension nodes and set parent
      for (const extElementNode of extElementNodes) {
        if (extElementNode) {
          (extElementNode as TreeNode).parent = extNode;
          extNode.children?.push(extElementNode);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading extensions directory ${extPath}`, error);
    }

    return extNode;
  }

  /**
   * Recursively find all .bsl files in a directory
   */
  private static async findBslFilesRecursive(dirPath: string): Promise<string[]> {
    const bslFiles: string[] = [];
    
    try {
      const items = await fs.promises.readdir(dirPath);
      
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        try {
          const stat = await fs.promises.stat(itemPath);
          
          if (stat.isDirectory()) {
            // Recursively search subdirectories
            const subFiles = await this.findBslFilesRecursive(itemPath);
            bslFiles.push(...subFiles);
          } else if (stat.isFile() && item.endsWith('.bsl')) {
            bslFiles.push(itemPath);
          }
        } catch (error) {
          Logger.debug(`Error processing ${itemPath}`, error);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading directory ${dirPath}`, error);
    }
    
    return bslFiles;
  }

  /**
   * Parse forms directory
   * @param formsPath Path to Forms directory
   * @returns Tree node for forms
   */
  private static async parseForms(formsPath: string): Promise<TreeNode> {
    const formsNode: TreeNode = {
      id: 'Forms',
      name: 'Forms',
      type: MetadataType.Form,
      properties: {},
      children: [],
      filePath: formsPath,
    };

    try {
      const items = await fs.promises.readdir(formsPath);

      // Process all form items
      const formNodes = await Promise.all(
        items.map(async (item) => {
          const itemPath = path.join(formsPath, item);
          try {
            const stat = await fs.promises.stat(itemPath);

            if (stat.isDirectory()) {
              // Parse form XML to get properties
              const xmlPath = path.join(itemPath, `${item}.xml`);
              let properties: Record<string, unknown> = { name: item };
              
              try {
                await fs.promises.access(xmlPath);
                const xmlContent = await XmlParser.parseFileAsync(xmlPath);
                properties = { ...properties, ...this.extractPropertiesFromElement(xmlContent) };
              } catch {
                // XML doesn't exist, use default properties
              }

              const formNode: TreeNode = {
                id: `Forms.${item}`,
                name: item,
                type: MetadataType.Form,
                properties,
                filePath: xmlPath,
                children: [],
              };

              // Parse form's Ext directory for modules
              const extPath = path.join(itemPath, 'Ext');
              try {
                await fs.promises.access(extPath);
                const extNode = await this.parseExtensions(extPath);
                if (extNode.children && extNode.children.length > 0) {
                  extNode.parent = formNode;
                  formNode.children?.push(extNode);
                }
              } catch {
                // No Ext directory
              }

              formNode.parent = formsNode;
              return formNode;
            }
          } catch (error) {
            Logger.debug(`Error processing form ${itemPath}`, error);
          }
          return null;
        })
      );

      // Add non-null form nodes
      for (const formNode of formNodes) {
        if (formNode) {
          formNode.parent = formsNode;
          formsNode.children?.push(formNode);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading forms directory ${formsPath}`, error);
    }

    return formsNode;
  }

  /**
   * Parse attributes directory
   * @param attributesPath Path to Attributes directory
   * @returns Tree node for attributes
   */
  private static async parseAttributes(attributesPath: string): Promise<TreeNode> {
    const attributesNode: TreeNode = {
      id: 'Attributes',
      name: 'Attributes',
      type: MetadataType.Attribute,
      properties: {},
      children: [],
      filePath: attributesPath,
    };

    try {
      const items = await fs.promises.readdir(attributesPath);

      // Process all attribute items
      const attributeNodes = await Promise.all(
        items.map(async (item) => {
          const itemPath = path.join(attributesPath, item);
          try {
            const stat = await fs.promises.stat(itemPath);

            if (stat.isDirectory()) {
              // Parse attribute XML to get properties
              const xmlPath = path.join(itemPath, `${item}.xml`);
              let properties: Record<string, unknown> = { name: item };
              
              try {
                await fs.promises.access(xmlPath);
                const xmlContent = await XmlParser.parseFileAsync(xmlPath);
                properties = { ...properties, ...this.extractPropertiesFromElement(xmlContent) };
              } catch {
                // XML doesn't exist, use default properties
              }

              const attrNode: TreeNode = {
                id: `Attributes.${item}`,
                name: item,
                type: MetadataType.Attribute,
                properties,
                filePath: xmlPath,
              };
              attrNode.parent = attributesNode;
              return attrNode;
            }
          } catch (error) {
            Logger.debug(`Error processing attribute ${itemPath}`, error);
          }
          return null;
        })
      );

      // Add non-null attribute nodes
      for (const attributeNode of attributeNodes) {
        if (attributeNode) {
          attributesNode.children?.push(attributeNode);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading attributes directory ${attributesPath}`, error);
    }

    return attributesNode;
  }

  /**
   * Parse tabular sections directory
   * @param tabularPath Path to TabularSections directory
   * @returns Tree node for tabular sections
   */
  private static async parseTabularSections(tabularPath: string): Promise<TreeNode> {
    const tabularNode: TreeNode = {
      id: 'TabularSections',
      name: 'Tabular Sections',
      type: MetadataType.TabularSection,
      properties: {},
      children: [],
      filePath: tabularPath,
    };

    try {
      const items = await fs.promises.readdir(tabularPath);

      // Process all tabular section items
      const tabularSectionNodes = await Promise.all(
        items.map(async (item) => {
          const itemPath = path.join(tabularPath, item);
          try {
            const stat = await fs.promises.stat(itemPath);

            if (stat.isDirectory()) {
              // Parse tabular section XML to get properties
              const xmlPath = path.join(itemPath, `${item}.xml`);
              let properties: Record<string, unknown> = { name: item };
              
              try {
                await fs.promises.access(xmlPath);
                const xmlContent = await XmlParser.parseFileAsync(xmlPath);
                properties = { ...properties, ...this.extractPropertiesFromElement(xmlContent) };
              } catch {
                // XML doesn't exist, use default properties
              }

              const tsNode: TreeNode = {
                id: `TabularSections.${item}`,
                name: item,
                type: MetadataType.TabularSection,
                properties,
                filePath: xmlPath,
              };
              tsNode.parent = tabularNode;
              return tsNode;
            }
          } catch (error) {
            Logger.debug(`Error processing tabular section ${itemPath}`, error);
          }
          return null;
        })
      );

      // Add non-null tabular section nodes
      for (const tabularSectionNode of tabularSectionNodes) {
        if (tabularSectionNode) {
          tabularNode.children?.push(tabularSectionNode);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading tabular sections directory ${tabularPath}`, error);
    }

    return tabularNode;
  }

  /**
   * Parse attributes from XML ChildObjects section
   * @param xmlContent Parsed XML content
   * @param elementPath Path to element directory
   * @param elementName Name of element
   * @returns Tree node for attributes container
   */
  private static async parseAttributesFromXML(
    xmlContent: Record<string, unknown>,
    elementPath: string,
    elementName: string
  ): Promise<TreeNode> {
    const parentXmlPath = path.join(elementPath, `${elementName}.xml`);
    
    const attributesNode: TreeNode = {
      id: 'Attributes',
      name: 'Attributes',
      type: MetadataType.Attribute,
      properties: {},
      children: [],
      // Don't set filePath to avoid collision with parent node
      parentFilePath: parentXmlPath,
    };

    try {
      // Navigate through XML structure to find ChildObjects
      const childObjects = this.findChildObjects(xmlContent);
      if (childObjects == null) {
        return attributesNode;
      }

      const attributes = this.extractAttributes(childObjects);
      
      for (const attr of attributes) {
        const a = attr as Record<string, unknown>;
        const attrName = (a.Properties && (a.Properties as Record<string, unknown>).Name) || a.Name || 'Unknown';
        const attributeNode: TreeNode = {
          id: `Attributes.${String(attrName)}`,
          name: String(attrName),
          type: MetadataType.Attribute,
          properties: this.flattenAttributeProperties(a),
          // Use parentFilePath instead of filePath to avoid collision
          parentFilePath: parentXmlPath,
        };
        
        attributeNode.parent = attributesNode;
        attributesNode.children?.push(attributeNode);
      }
    } catch (error) {
      Logger.debug(`Error parsing attributes from XML for ${elementName}`, error);
    }

    return attributesNode;
  }

  /**
   * Find ChildObjects section in parsed XML
   * @param xmlContent Parsed XML content
   * @returns ChildObjects section or null
   */
  private static findChildObjects(xmlContent: Record<string, unknown>): unknown {
    if (!xmlContent || typeof xmlContent !== 'object') {
      return null;
    }

    // Search for ChildObjects in the XML structure
    // The structure varies but typically: MetaDataObject -> Catalog/Document -> ChildObjects
    
    for (const [key, value] of Object.entries(xmlContent)) {
      if (key === 'ChildObjects') {
        return value;
      }
      
      if (typeof value === 'object' && value !== null) {
        const found = this.findChildObjects(value as Record<string, unknown>);
        if (found) {
          return found;
        }
      }
    }
    
    return null;
  }

  /**
   * Extract Attribute elements from ChildObjects
   * @param childObjects ChildObjects section
   * @returns Array of attribute objects
   */
  private static extractAttributes(childObjects: unknown): unknown[] {
    const attributes: unknown[] = [];
    if (!childObjects || typeof childObjects !== 'object') {
      return attributes;
    }
    const obj = childObjects as Record<string, unknown>;
    if (obj.Attribute) {
      const attrData = obj.Attribute;
      if (Array.isArray(attrData)) {
        attributes.push(...attrData);
      } else {
        attributes.push(attrData);
      }
    }
    
    return attributes;
  }

  /**
   * Flatten attribute properties from XML structure
   * @param attr Attribute object from XML
   * @returns Flattened properties
   */
  private static flattenAttributeProperties(attr: Record<string, unknown>): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    
    if (!attr || typeof attr !== 'object') {
      return properties;
    }

    // Extract uuid if present
    if (attr.uuid) {
      properties.uuid = attr.uuid;
    }

    // Extract Properties section
    if (attr.Properties && typeof attr.Properties === 'object') {
      const props = attr.Properties;
      
      for (const [key, value] of Object.entries(props)) {
        // Skip XML metadata keys
        if (key.startsWith('@_') || key.startsWith('#')) {
          continue;
        }
        
        // Extract simple values
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          properties[key] = value;
        } else if (value && typeof value === 'object') {
          // Handle complex types (like Synonym with v8:item)
          const obj = value as Record<string, unknown>;
          
          // Check for v8:item structure (localized strings)
          if (obj['v8:item']) {
            const items = obj['v8:item'];
            if (Array.isArray(items) && items.length > 0) {
              const firstItem = items[0];
              if (firstItem && typeof firstItem === 'object' && 'v8:content' in firstItem) {
                properties[key] = (firstItem as Record<string, unknown>)['v8:content'];
              }
            }
          } else if ('v8:Type' in obj) {
            // Store raw type object so the type editor can open (serialize to XML).
            // Properties panel formats for display via TypeParser.parseFromObject + TypeFormatter.
            properties[key] = obj;
          } else {
            // For other complex types, store as-is or extract text
            properties[key] = value;
          }
        }
      }
    }
    
    // Convert string "false"/"true" values to boolean primitives
    return convertStringBooleans(properties);
  }

  /**
   * Extract properties from metadata element XML
   * @param xmlContent Parsed XML content
   * @returns Properties object
   */
  private static extractPropertiesFromElement(xmlContent: Record<string, unknown>): Record<string, unknown> {
      const result: Record<string, unknown> = {};

      // Find the root element (Catalog, Document, CommonModule, etc.)
      for (const [key, value] of Object.entries(xmlContent)) {
        if (key === '@_' || key.startsWith('#')) {
          continue;
        }

        if (typeof value === 'object' && value !== null) {
          const element = value as Record<string, unknown>;
          const properties = element.Properties as Record<string, unknown>;

          if (properties) {
            for (const [propKey, propValue] of Object.entries(properties)) {
              if (propKey === '@_' || propKey.startsWith('#')) {
                continue;
              }

              // Handle different value types
              if (typeof propValue === 'boolean' || typeof propValue === 'number') {
                // Direct boolean or number values
                result[propKey] = propValue;
              } else if (typeof propValue === 'string') {
                // Direct string values
                result[propKey] = propValue;
              } else if (typeof propValue === 'object' && propValue !== null) {
                const obj = propValue as Record<string, unknown>;

                // Check for v8:item structure (localized strings like Synonym)
                if (obj['v8:item']) {
                  const items = obj['v8:item'];
                  if (Array.isArray(items) && items.length > 0) {
                    const firstItem = items[0];
                    if (firstItem && typeof firstItem === 'object' && 'v8:content' in firstItem) {
                      result[propKey] = (firstItem as Record<string, unknown>)['v8:content'];
                    }
                  }
                } else if ('v8:Type' in obj) {
                  // Store raw type object so the type editor can open (serialize to XML).
                  // Properties panel formats for display via TypeParser.parseFromObject + TypeFormatter.
                  result[propKey] = obj;
                } else if (obj.item) {
                  // Simple item wrapper
                  result[propKey] = obj.item;
                } else {
                  // Complex object - store as-is
                  result[propKey] = propValue;
                }
              } else {
                // Other types (null, undefined, etc.)
                result[propKey] = propValue;
              }
            }
          }
        }
      }

      // Convert string "false"/"true" values to boolean primitives
      return convertStringBooleans(result);
    }


  /**
   * Detect if path contains Designer format configuration
   * @param configPath Path to check
   * @returns true if Designer format detected
   */
  static async isDesignerFormat(configPath: string): Promise<boolean> {
    try {
      // Designer format has 1cv8.cf or 1cv8.cfe file in root
      const cfPath = path.join(configPath, '1cv8.cf');
      const cfePath = path.join(configPath, '1cv8.cfe');
      const configDumpPath = path.join(configPath, 'ConfigDumpInfo.xml');
      const configXmlPath = path.join(configPath, 'Configuration.xml');

      // Check if binary files exist (full Designer format)
      const hasBinaryFiles = fs.existsSync(cfPath) || fs.existsSync(cfePath);
      
      // Check if XML metadata exists (exported Designer format)
      const hasXmlMetadata = fs.existsSync(configDumpPath) || fs.existsSync(configXmlPath);

      // Designer format if either binary files or XML metadata exists
      // AND has typical Designer directory structure (Catalogs, Documents, etc.)
      if (hasXmlMetadata) {
        // Check for at least one metadata type directory
        const metadataTypes = ['Catalogs', 'Documents', 'Enums', 'Reports', 'DataProcessors'];
        for (const type of metadataTypes) {
          const typePath = path.join(configPath, type);
          if (fs.existsSync(typePath)) {
            return true;
          }
        }
      }

      return hasBinaryFiles && hasXmlMetadata;
    } catch (error) {
      Logger.debug('Designer format detection failed', error);
      return false;
    }
  }
}
