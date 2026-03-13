import * as fs from 'fs';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { XmlParser } from './xmlParser';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import { convertStringBooleans } from '../utils/xmlPropertyUtils';
import {
  findChildObjects,
  extractAttributes,
  extractTabularSections,
  flattenAttributeProperties,
} from './xmlChildObjects';

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
   * Resolve path to configuration properties file (Configuration.xml or ConfigDumpInfo.xml).
   */
  private static getConfigurationXmlPath(configPath: string): string {
    const configDumpPath = path.join(configPath, 'ConfigDumpInfo.xml');
    if (fs.existsSync(configDumpPath)) {
      return configDumpPath;
    }
    return path.join(configPath, 'Configuration.xml');
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
      filePath: this.getConfigurationXmlPath(configPath),
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
   * Build only root and type nodes without parsing element contents (for lazy loading).
   * @param configPath Path to configuration root
   * @returns Root node with type nodes that have empty children
   */
  static async parseStructureOnly(configPath: string): Promise<TreeNode> {
    const rootNode: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
      filePath: this.getConfigurationXmlPath(configPath),
    };

    const metadataTypes = MetadataTypeMapper.getMetadataTypes();
    for (const typeName of metadataTypes) {
      const typePath = path.join(configPath, typeName);
      try {
        await fs.promises.access(typePath);
      } catch {
        continue;
      }
      const metadataType = MetadataTypeMapper.map(typeName);
      const typeNode: TreeNode = {
        id: typeName,
        name: typeName,
        type: metadataType,
        properties: { type: typeName },
        children: [],
        filePath: typePath,
      };
      typeNode.parent = rootNode;
      rootNode.children!.push(typeNode);
    }

    Logger.info('Designer structure-only parsing completed');
    return rootNode;
  }

  /**
   * Parse contents of a single metadata type (e.g. Catalogs).
   * Uses shallow mode so element nodes have no sub-elements until loaded on demand.
   */
  static async parseTypeContents(configPath: string, typeName: string): Promise<TreeNode[]> {
    const typePath = path.join(configPath, typeName);
    const typeNode = await this.parseMetadataType(typePath, typeName, { shallow: true });
    return typeNode.children || [];
  }

  /**
   * Load direct children (Attributes, Forms, Ext, TabularSections) for a metadata element.
   * Used when expanding an element that was loaded in shallow mode.
   */
  static async loadChildrenForElement(
    configPath: string,
    typeName: string,
    elementName: string
  ): Promise<TreeNode[]> {
    const elementPath = path.join(configPath, typeName, elementName);
    const xmlPath = path.join(configPath, typeName, `${elementName}.xml`);
    const children: TreeNode[] = [];

    let xmlContent: Record<string, unknown> | null = null;
    try {
      await fs.promises.access(xmlPath);
      xmlContent = await XmlParser.parseFileAsync(xmlPath);
    } catch {
      // No XML
    }

    if (xmlContent) {
      const attributesNode = await this.parseAttributesFromXML(xmlContent, xmlPath, elementName);
      if (attributesNode && attributesNode.children && attributesNode.children.length > 0) {
        children.push(attributesNode);
      }
      const tabularFromXml = await this.parseTabularSectionsFromXML(xmlContent, xmlPath, elementName);
      if (tabularFromXml && tabularFromXml.children && tabularFromXml.children.length > 0) {
        children.push(tabularFromXml);
      }
    }

    try {
      const items = await fs.promises.readdir(elementPath);
      for (const item of items) {
        if (item === 'Ext') {
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
                  children.push(child);
                }
              }
            } catch (error) {
              Logger.debug(`Error reading Ext for CommonModule ${elementPath}`, error);
            }
          } else {
            const extPath = path.join(elementPath, item);
            const extNode = await this.parseExtensions(extPath);
            if (extNode.children && extNode.children.length > 0) {
              children.push(extNode);
            }
          }
        } else if (item === 'Forms') {
          const formsPath = path.join(elementPath, item);
          const formsNode = await this.parseForms(formsPath);
          if (formsNode.children && formsNode.children.length > 0) {
            children.push(formsNode);
          }
        } else if (item === 'Attributes') {
          const attributesPath = path.join(elementPath, item);
          const attributesNode = await this.parseAttributes(attributesPath);
          if (attributesNode.children && attributesNode.children.length > 0) {
            children.push(attributesNode);
          }
        } else if (item === 'TabularSections') {
          const tabularPath = path.join(elementPath, item);
          const tabularNode = await this.parseTabularSections(tabularPath);
          if (tabularNode.children && tabularNode.children.length > 0) {
            const existingTabularId = children.find((c) => c.id === 'TabularSections');
            if (!existingTabularId) {
              children.push(tabularNode);
            } else {
              const existing = existingTabularId as TreeNode;
              for (const ch of tabularNode.children ?? []) {
                ch.parent = existing;
                existing.children = existing.children ?? [];
                existing.children.push(ch);
              }
            }
          }
        }
      }
    } catch (error) {
      Logger.debug(`Error reading element directory ${elementPath}`, error);
    }

    return children;
  }

  /**
   * Parse metadata type directory
   * @param typePath Path to metadata type directory
   * @param typeName Name of metadata type
   * @param options shallow: if true, element nodes are created without sub-elements (_lazy)
   * @returns Tree node for metadata type
   */
  private static async parseMetadataType(
    typePath: string,
    typeName: string,
    options?: { shallow?: boolean }
  ): Promise<TreeNode> {
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
              return await this.parseMetadataElement(itemPath, item, typeName, options?.shallow ?? false);
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
   * @param shallow If true, do not parse sub-elements (Attributes, Forms, Ext); set _lazy for on-demand load
   */
  private static async parseMetadataElement(
    elementPath: string,
    elementName: string,
    typeName: string,
    shallow = false
  ): Promise<TreeNode> {
    const metadataType = MetadataTypeMapper.map(typeName);

    const elementNode: TreeNode = {
      id: `${typeName}.${elementName}`,
      name: elementName,
      type: metadataType,
      properties: { type: typeName },
      children: [],
      filePath: elementPath,
    };

    if (shallow) {
      elementNode.properties._lazy = true;
      // Still read main XML for properties and filePath
      const xmlPath = path.join(path.dirname(elementPath), `${elementName}.xml`);
      try {
        await fs.promises.access(xmlPath);
        const xmlContent = await XmlParser.parseFileAsync(xmlPath);
        const properties = this.extractPropertiesFromElement(xmlContent);
        elementNode.properties = { ...elementNode.properties, ...properties };
        elementNode.filePath = xmlPath;
      } catch {
        // Keep elementPath as filePath
      }
      return elementNode;
    }

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

    // Parse Attributes from XML ChildObjects if available (use xmlPath — same file we read from)
    if (xmlContent) {
      const attributesNode = await this.parseAttributesFromXML(xmlContent, xmlPath, elementName);
      if (attributesNode && attributesNode.children && attributesNode.children.length > 0) {
        attributesNode.parent = elementNode;
        elementNode.children?.push(attributesNode);
      }
      const tabularFromXml = await this.parseTabularSectionsFromXML(xmlContent, xmlPath, elementName);
      if (tabularFromXml && tabularFromXml.children && tabularFromXml.children.length > 0) {
        tabularFromXml.parent = elementNode;
        elementNode.children?.push(tabularFromXml);
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
            const existingTabular = elementNode.children?.find((c) => c.id === 'TabularSections');
            if (!existingTabular) {
              tabularNode.parent = elementNode;
              elementNode.children?.push(tabularNode);
            } else {
              for (const ch of tabularNode.children ?? []) {
                ch.parent = existingTabular;
                existingTabular.children = existingTabular.children ?? [];
                existingTabular.children.push(ch);
              }
            }
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
              // Form folder: real content is Ext/Form.xml; {FormName}.xml often absent in Designer
              const xmlPath = path.join(itemPath, `${item}.xml`);
              let properties: Record<string, unknown> = { name: item };
              try {
                await fs.promises.access(xmlPath);
                const xmlContent = await XmlParser.parseFileAsync(xmlPath);
                properties = { ...properties, ...this.extractPropertiesFromElement(xmlContent) };
              } catch {
                // {FormName}.xml doesn't exist; properties panel will read from Ext/Form.xml
              }
              // filePath = form directory so getFormPaths() and properties panel resolve Ext/Form.xml
              const formNode: TreeNode = {
                id: `Forms.${item}`,
                name: item,
                type: MetadataType.Form,
                properties,
                filePath: itemPath,
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
              // Parse tabular section XML to get properties and child attributes
              const xmlPath = path.join(itemPath, `${item}.xml`);
              let properties: Record<string, unknown> = { name: item };
              const tsChildren: TreeNode[] = [];

              try {
                await fs.promises.access(xmlPath);
                const xmlContent = await XmlParser.parseFileAsync(xmlPath);
                properties = { ...properties, ...this.extractPropertiesFromElement(xmlContent) };
                const tsChildObjects = findChildObjects(xmlContent);
                if (tsChildObjects) {
                  const attrList = extractAttributes(tsChildObjects);
                  for (const attr of attrList) {
                    const a = attr as Record<string, unknown>;
                    const attrName = (a.Properties && (a.Properties as Record<string, unknown>).Name) ?? (a as Record<string, unknown>).Name ?? 'Unknown';
                    const attributeNode: TreeNode = {
                      id: `TabularSections.${item}.${String(attrName)}`,
                      name: String(attrName),
                      type: MetadataType.Attribute,
                      properties: flattenAttributeProperties(a),
                      parentFilePath: xmlPath,
                    };
                    attributeNode.parent = undefined;
                    tsChildren.push(attributeNode);
                  }
                }
              } catch {
                // XML doesn't exist, use default properties
              }

              const tsNode: TreeNode = {
                id: `TabularSections.${item}`,
                name: item,
                type: MetadataType.TabularSection,
                properties,
                children: tsChildren.length > 0 ? tsChildren : undefined,
                filePath: xmlPath,
              };
              for (const c of tsChildren) {
                (c as TreeNode).parent = tsNode;
              }
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
   * @param xmlFilePath Path to the element's XML file (same file we read attributes from)
   * @param elementName Name of element
   * @returns Tree node for attributes container
   */
  private static async parseAttributesFromXML(
    xmlContent: Record<string, unknown>,
    xmlFilePath: string,
    elementName: string
  ): Promise<TreeNode> {
    const parentXmlPath = xmlFilePath;
    
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
      const childObjects = findChildObjects(xmlContent);
      if (childObjects == null) {
        return attributesNode;
      }

      const attributes = extractAttributes(childObjects);
      
      for (const attr of attributes) {
        const a = attr as Record<string, unknown>;
        const attrName = (a.Properties && (a.Properties as Record<string, unknown>).Name) || a.Name || 'Unknown';
        const attributeNode: TreeNode = {
          id: `Attributes.${String(attrName)}`,
          name: String(attrName),
          type: MetadataType.Attribute,
          properties: flattenAttributeProperties(a),
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
   * Parse tabular sections and their attributes from object XML (single-file Designer format).
   * @param xmlContent Parsed XML content of the object file
   * @param xmlFilePath Path to the object XML file
   * @param _elementName Name of the element (for logging)
   * @returns Tree node for TabularSections container or null if none
   */
  private static async parseTabularSectionsFromXML(
    xmlContent: Record<string, unknown>,
    xmlFilePath: string,
    _elementName: string
  ): Promise<TreeNode | null> {
    const childObjects = findChildObjects(xmlContent);
    if (childObjects == null) return null;

    const sectionList = extractTabularSections(childObjects);
    if (sectionList.length === 0) return null;

    const tabularNode: TreeNode = {
      id: 'TabularSections',
      name: 'Tabular Sections',
      type: MetadataType.TabularSection,
      properties: {},
      children: [],
      parentFilePath: xmlFilePath,
    };

    for (const section of sectionList) {
      const ts = section as Record<string, unknown>;
      const props = this.extractPropertiesFromElement({ TabularSection: ts });
      const sectionName = String(props.Name ?? ts.Properties && (ts.Properties as Record<string, unknown>).Name ?? 'Unknown');
      const tsChildObjects = ts.ChildObjects;
      const attrList = tsChildObjects && typeof tsChildObjects === 'object'
        ? extractAttributes(tsChildObjects as Record<string, unknown>)
        : [];

      const tsNode: TreeNode = {
        id: `TabularSections.${sectionName}`,
        name: sectionName,
        type: MetadataType.TabularSection,
        properties: { ...props },
        children: [],
        parentFilePath: xmlFilePath,
      };

      for (const attr of attrList) {
        const a = attr as Record<string, unknown>;
        const attrName = (a.Properties && (a.Properties as Record<string, unknown>).Name) ?? (a as Record<string, unknown>).Name ?? 'Unknown';
        const attributeNode: TreeNode = {
          id: `TabularSections.${sectionName}.${String(attrName)}`,
          name: String(attrName),
          type: MetadataType.Attribute,
          properties: flattenAttributeProperties(a),
          parentFilePath: xmlFilePath,
        };
        attributeNode.parent = tsNode;
        tsNode.children?.push(attributeNode);
      }

      tsNode.parent = tabularNode;
      tabularNode.children?.push(tsNode);
    }

    return tabularNode;
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
