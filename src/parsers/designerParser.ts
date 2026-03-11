import * as fs from 'fs';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { XmlParser } from './xmlParser';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';

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

      XmlParser.parseFile(configXmlPath);
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

    // Add non-empty type nodes to root
    for (const typeNode of typeNodes) {
      if (typeNode && typeNode.children && typeNode.children.length > 0) {
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

      // Add non-null element nodes
      for (const elementNode of elementNodes) {
        if (elementNode) {
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
    const xmlPath = path.join(elementPath, `${elementName}.xml`);
    try {
      await fs.promises.access(xmlPath);
      try {
        const xmlContent = XmlParser.parseFile(xmlPath);
        const properties = this.extractPropertiesFromElement(xmlContent);
        elementNode.properties = { ...elementNode.properties, ...properties };
      } catch (error) {
        Logger.warn(`Error parsing element XML ${xmlPath}`, error);
      }
    } catch {
      // XML file doesn't exist, skip
    }

    // Parse sub-elements (Ext, Forms, etc.)
    try {
      const items = await fs.promises.readdir(elementPath);

      for (const item of items) {
        if (item === 'Ext') {
          // Parse extensions
          const extPath = path.join(elementPath, item);
          const extNode = await this.parseExtensions(extPath);
          if (extNode.children && extNode.children.length > 0) {
            elementNode.children?.push(extNode);
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
              return {
                id: `Ext.${item}`,
                name: item,
                type: MetadataType.Extension,
                properties: { isExtension: true },
                filePath: itemPath,
              };
            }
          } catch (error) {
            Logger.debug(`Error processing extension ${itemPath}`, error);
          }
          return null;
        })
      );

      // Add non-null extension nodes
      for (const extElementNode of extElementNodes) {
        if (extElementNode) {
          extNode.children?.push(extElementNode);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading extensions directory ${extPath}`, error);
    }

    return extNode;
  }

  /**
   * Extract properties from metadata element XML
   * @param xmlContent Parsed XML content
   * @returns Properties object
   */
  private static extractPropertiesFromElement(xmlContent: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // Find the root element (Catalog, Document, etc.)
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

            if (typeof propValue === 'object' && propValue !== null) {
              const obj = propValue as Record<string, unknown>;
              if (obj.item) {
                result[propKey] = obj.item;
              } else {
                result[propKey] = propValue;
              }
            } else {
              result[propKey] = propValue;
            }
          }
        }
      }
    }

    return result;
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
