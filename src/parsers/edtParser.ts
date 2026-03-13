import * as fs from 'fs';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { XmlParser } from './xmlParser';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import { convertStringBooleans } from '../utils/xmlPropertyUtils';

/**
 * Parser for 1C EDT (Eclipse Development Tools) format metadata
 * EDT format uses .mdo files in specific directory structure
 * Structure: src/Catalogs/CatalogName/Catalog.mdo, src/Documents/DocName/Document.mdo, etc.
 */
export class EdtParser {
  /**
   * Parse EDT format configuration
   * @param configPath Path to configuration root directory (usually contains 'src' folder)
   * @returns Root tree node
   */
  static async parse(configPath: string): Promise<TreeNode> {
    Logger.info('Starting EDT format parsing', configPath);

    try {
      // EDT format has src directory with metadata
      const srcPath = path.join(configPath, 'src');
      try {
        await fs.promises.access(srcPath);
      } catch {
        throw new Error(`EDT src directory not found at ${srcPath}`);
      }

      const rootNode: TreeNode = {
        id: 'root',
        name: 'Configuration',
        type: MetadataType.Configuration,
        properties: {},
        children: [],
        filePath: srcPath,
      };

      // Parse metadata directories in src
      const metadataTypes = MetadataTypeMapper.getMetadataTypes();

      // Process all metadata types in parallel
      const typeNodes = await Promise.all(
        metadataTypes.map(async (metadataType) => {
          const typePath = path.join(srcPath, metadataType);
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

      Logger.info('EDT format parsing completed');
      return rootNode;
    } catch (error) {
      Logger.error('Error parsing EDT format', error);
      throw error;
    }
  }

  /**
   * Build only root and type nodes without parsing element contents (for lazy loading).
   * @param configPath Path to configuration root
   * @returns Root node with type nodes that have empty children
   */
  static async parseStructureOnly(configPath: string): Promise<TreeNode> {
    const srcPath = path.join(configPath, 'src');
    try {
      await fs.promises.access(srcPath);
    } catch {
      throw new Error(`EDT src directory not found at ${srcPath}`);
    }

    const rootNode: TreeNode = {
      id: 'root',
      name: 'Configuration',
      type: MetadataType.Configuration,
      properties: {},
      children: [],
      filePath: srcPath,
    };

    const metadataTypes = MetadataTypeMapper.getMetadataTypes();
    for (const typeName of metadataTypes) {
      const typePath = path.join(srcPath, typeName);
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

    Logger.info('EDT structure-only parsing completed');
    return rootNode;
  }

  /**
   * Parse contents of a single metadata type (e.g. Catalogs).
   * @param configPath Path to configuration root
   * @param typeName Type directory name (e.g. Catalogs)
   * @returns Array of element nodes for this type
   */
  static async parseTypeContents(configPath: string, typeName: string): Promise<TreeNode[]> {
    const typePath = path.join(configPath, 'src', typeName);
    const typeNode = await this.parseMetadataType(typePath, typeName, { shallow: true });
    return typeNode.children || [];
  }

  /**
   * Load direct children (Forms, Ext) for a metadata element. Used when expanding in lazy mode.
   */
  static async loadChildrenForElement(
    configPath: string,
    typeName: string,
    elementName: string
  ): Promise<TreeNode[]> {
    const elementPath = path.join(configPath, 'src', typeName, elementName);
    const children: TreeNode[] = [];
    try {
      const items = await fs.promises.readdir(elementPath);
      for (const item of items) {
        if (item === 'Forms' || item === 'Ext') {
          const subPath = path.join(elementPath, item);
          const subNode = await this.parseSubElements(subPath, item);
          if (subNode.children && subNode.children.length > 0) {
            children.push(subNode);
          }
        }
      }
    } catch (error) {
      Logger.debug(`Error reading EDT element directory ${elementPath}`, error);
    }
    return children;
  }

  /**
   * Parse metadata type directory (e.g., src/Catalogs/)
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
              return await this.parseMetadataElement(
                itemPath,
                item,
                typeName,
                options?.shallow ?? false
              );
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
      Logger.warn(`Error reading EDT metadata type directory ${typePath}`, error);
    }

    return typeNode;
  }

  /**
   * Parse metadata element directory (e.g., src/Catalogs/CatalogName/)
   * @param shallow If true, do not parse sub-elements; set _lazy for on-demand load
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

    const mdoFileName = this.getMdoFileName(typeName);
    const mdoPath = path.join(elementPath, mdoFileName);

    try {
      await fs.promises.access(mdoPath);
      try {
        const mdoContent = await XmlParser.parseFileAsync(mdoPath);
        const properties = this.extractPropertiesFromMdo(mdoContent);
        elementNode.properties = { ...elementNode.properties, ...properties };
      } catch (error) {
        Logger.warn(`Error parsing MDO file ${mdoPath}`, error);
      }
    } catch {
      // MDO file doesn't exist, skip
    }

    if (shallow) {
      elementNode.properties._lazy = true;
      return elementNode;
    }

    try {
      const items = await fs.promises.readdir(elementPath);
      for (const item of items) {
        if (item === 'Forms' || item === 'Ext') {
          const subPath = path.join(elementPath, item);
          const subNode = await this.parseSubElements(subPath, item);
          if (subNode.children && subNode.children.length > 0) {
            subNode.parent = elementNode;
            elementNode.children?.push(subNode);
          }
        }
      }
    } catch (error) {
      Logger.debug(`Error reading EDT element directory ${elementPath}`, error);
    }

    return elementNode;
  }

  /**
   * Parse sub-elements (Forms, Ext, etc.)
   * @param subPath Path to sub-elements directory
   * @param subType Type of sub-elements
   * @returns Tree node for sub-elements
   */
  private static async parseSubElements(subPath: string, subType: string): Promise<TreeNode> {
    const subNode: TreeNode = {
      id: subType,
      name: subType,
      type: subType === 'Forms' ? MetadataType.Form : MetadataType.Extension,
      properties: {},
      children: [],
      filePath: subPath,
    };

    try {
      const items = await fs.promises.readdir(subPath);

      // Process all sub-elements in parallel
      const subElementNodes = await Promise.all(
        items.map(async (item) => {
          const itemPath = path.join(subPath, item);
          try {
            const stat = await fs.promises.stat(itemPath);

            if (stat.isDirectory()) {
              const child: TreeNode = {
                id: `${subType}.${item}`,
                name: item,
                type: subType === 'Forms' ? MetadataType.Form : MetadataType.Extension,
                properties: {},
                filePath: itemPath,
              };
              child.parent = subNode;
              return child;
            }
          } catch (error) {
            Logger.debug(`Error processing sub-element ${itemPath}`, error);
          }
          return null;
        })
      );

      // Add non-null sub-element nodes
      for (const subElementNode of subElementNodes) {
        if (subElementNode) {
          subNode.children?.push(subElementNode);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading EDT sub-elements directory ${subPath}`, error);
    }

    return subNode;
  }

  /**
   * Extract properties from .mdo file
   * @param mdoContent Parsed MDO content
   * @returns Properties object
   */
  private static extractPropertiesFromMdo(mdoContent: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // Find the root element (Catalog, Document, etc.)
    for (const [key, value] of Object.entries(mdoContent)) {
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

    // Convert string "false"/"true" values to boolean primitives
    return convertStringBooleans(result);
  }

  /**
   * Get .mdo file name for metadata type
   * @param typeName Type name (e.g., 'Catalogs')
   * @returns MDO file name (e.g., 'Catalog.mdo')
   */
  private static getMdoFileName(typeName: string): string {
    const typeMap: Record<string, string> = {
      Catalogs: 'Catalog.mdo',
      Documents: 'Document.mdo',
      Enums: 'Enum.mdo',
      Reports: 'Report.mdo',
      DataProcessors: 'DataProcessor.mdo',
      ChartsOfCharacteristicTypes: 'ChartOfCharacteristicTypes.mdo',
      ChartsOfAccounts: 'ChartOfAccounts.mdo',
      ChartsOfCalculationTypes: 'ChartOfCalculationTypes.mdo',
      InformationRegisters: 'InformationRegister.mdo',
      AccumulationRegisters: 'AccumulationRegister.mdo',
      AccountingRegisters: 'AccountingRegister.mdo',
      CalculationRegisters: 'CalculationRegister.mdo',
      BusinessProcesses: 'BusinessProcess.mdo',
      Tasks: 'Task.mdo',
      ExternalDataSources: 'ExternalDataSource.mdo',
      Constants: 'Constant.mdo',
      SessionParameters: 'SessionParameter.mdo',
      FilterCriteria: 'FilterCriterion.mdo',
      ScheduledJobs: 'ScheduledJob.mdo',
      FunctionalOptions: 'FunctionalOption.mdo',
      FunctionalOptionsParameters: 'FunctionalOptionsParameter.mdo',
      SettingsStorages: 'SettingsStorage.mdo',
      EventSubscriptions: 'EventSubscription.mdo',
      CommonModules: 'CommonModule.mdo',
      CommandGroups: 'CommandGroup.mdo',
      Roles: 'Role.mdo',
      Interfaces: 'Interface.mdo',
      Styles: 'Style.mdo',
      WebServices: 'WebService.mdo',
      HTTPServices: 'HTTPService.mdo',
      IntegrationServices: 'IntegrationService.mdo',
      Subsystems: 'Subsystem.mdo',
    };

    return typeMap[typeName] || 'Object.mdo';
  }

  /**
   * Detect if path contains EDT format configuration
   * @param configPath Path to check
   * @returns true if EDT format detected
   */
  static async isEdtFormat(configPath: string): Promise<boolean> {
    try {
      // EDT format has src directory with .mdo files
      const srcPath = path.join(configPath, 'src');
      try {
        await fs.promises.access(srcPath);
      } catch {
        return false;
      }

      // Check if there are metadata type directories with .mdo files
      const metadataTypes = ['Catalogs', 'Documents', 'Enums', 'Reports', 'DataProcessors'];

      for (const type of metadataTypes) {
        const typePath = path.join(srcPath, type);
        try {
          await fs.promises.access(typePath);
          const items = await fs.promises.readdir(typePath);
          
          for (const item of items) {
            const itemPath = path.join(typePath, item);
            try {
              const stat = await fs.promises.stat(itemPath);
              if (stat.isDirectory()) {
                // Check for .mdo file
                const mdoFiles = (await fs.promises.readdir(itemPath)).filter(f => f.endsWith('.mdo'));
                if (mdoFiles.length > 0) {
                  return true;
                }
              }
            } catch {
              // Skip items that can't be accessed
            }
          }
        } catch {
          // Type directory doesn't exist, continue
        }
      }

      return false;
    } catch (error) {
      Logger.debug('EDT format detection failed', error);
      return false;
    }
  }
}
