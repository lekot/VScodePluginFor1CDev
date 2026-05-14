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
  extractEnumValues,
  extractDimensions,
  extractResources,
  flattenAttributeProperties,
} from './xmlChildObjects';
import { buildSubsystemTree } from './subsystemTreeBuilder';
import { CONFIGURATION_XML } from '../constants/fileNames';
import {
  extractExtensionProperties,
  extractObjectBelonging,
} from '../extensionSupport/extensionXmlParser';
import { STANDARD_MODULES } from '../constants/moduleTypes';

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
        filePath: path.join(configPath, CONFIGURATION_XML),
      };

      // Try to read extension properties from Configuration.mdo (EDT format)
      try {
        const configMdoPath = path.join(srcPath, 'Configuration', 'Configuration.mdo');
        await fs.promises.access(configMdoPath);
        const configXml = await XmlParser.parseFileAsync(configMdoPath);
        const extProps = extractExtensionProperties(configXml);
        if (extProps.extensionPurpose !== undefined) {
          rootNode.properties.extensionPurpose = extProps.extensionPurpose;
        }
        if (extProps.namePrefix !== undefined) {
          rootNode.properties.namePrefix = extProps.namePrefix;
        }
      } catch {
        // Not an extension or .mdo not found — skip
      }

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
      filePath: path.join(configPath, CONFIGURATION_XML),
    };

    // Try to read extension properties from Configuration.mdo (EDT format)
    try {
      const configMdoPath = path.join(srcPath, 'Configuration', 'Configuration.mdo');
      await fs.promises.access(configMdoPath);
      const configXml = await XmlParser.parseFileAsync(configMdoPath);
      const extProps = extractExtensionProperties(configXml);
      if (extProps.extensionPurpose !== undefined) {
        rootNode.properties.extensionPurpose = extProps.extensionPurpose;
      }
      if (extProps.namePrefix !== undefined) {
        rootNode.properties.namePrefix = extProps.namePrefix;
      }
    } catch {
      // Not an extension or .mdo not found — skip
    }

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
   * Build only direct object nodes for a metadata type without parsing .mdo/XML.
   * Per-object details are loaded later through loadChildrenForElement.
   */
  static async parseTypeIndex(configPath: string, typeName: string): Promise<TreeNode[]> {
    const typePath = path.join(configPath, 'src', typeName);
    const metadataType = MetadataTypeMapper.map(typeName);

    if (typeName === 'Subsystems') {
      const typeNode = await this.parseMetadataType(typePath, typeName, { shallow: true });
      return typeNode.children || [];
    }

    const entries = await fs.promises.readdir(typePath, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base' }))
      .map((name) => ({
        id: `${typeName}.${name}`,
        name,
        type: metadataType,
        properties: { type: typeName, _lazy: true },
        children: [],
        filePath: path.join(typePath, name),
      }));
  }

  /**
   * Load direct children (Attributes, TabularSections from .mdo; Forms, Ext from filesystem) for a metadata element.
   * For Subsystems, child subsystems are already in the tree; path is derived from element.filePath when provided.
   */
  static async loadChildrenForElement(
    configPath: string,
    typeName: string,
    elementName: string,
    element?: TreeNode
  ): Promise<TreeNode[]> {
    const elementPath =
      typeName === 'Subsystems' && element?.filePath
        ? path.dirname(element.filePath)
        : path.join(configPath, 'src', typeName, elementName);
    const children: TreeNode[] = [];
    const mdoFileName = this.getMdoFileName(typeName);
    const mdoPath = path.join(elementPath, mdoFileName);

    try {
      await fs.promises.access(mdoPath);
      const mdoContent = await XmlParser.parseFileAsync(mdoPath);
      const fromMdo = this.buildAttributesAndTabularFromMdo(mdoContent, mdoPath);
      if (fromMdo.enumValuesNode?.children?.length) {
        children.push(fromMdo.enumValuesNode);
      }
      if (fromMdo.dimensionsNode?.children?.length) {
        children.push(fromMdo.dimensionsNode);
      }
      if (fromMdo.resourcesNode?.children?.length) {
        children.push(fromMdo.resourcesNode);
      }
      if (fromMdo.attributesNode?.children?.length) {
        children.push(fromMdo.attributesNode);
      }
      if (fromMdo.tabularNode?.children?.length) {
        children.push(fromMdo.tabularNode);
      }
    } catch {
      // No .mdo or parse error — skip Attributes/TabularSections from MDO
    }

    // Add virtual module nodes based on type
    const metadataType = MetadataTypeMapper.map(typeName);
    const standardModules = STANDARD_MODULES[metadataType];
    if (standardModules) {
      for (const mod of standardModules) {
        const modPath = path.join(elementPath, mod.fileName);
        const modNode: TreeNode = {
          id: `${typeName}.${elementName}.${mod.fileName}`,
          name: mod.label,
          type: MetadataType.Method,
          properties: { isModule: true, fileType: 'bsl' },
          filePath: modPath,
        };
        children.push(modNode);
      }
    }

    try {
      const items = await fs.promises.readdir(elementPath);
      for (const item of items) {
        if (item === 'Forms') {
          const subPath = path.join(elementPath, item);
          const subNode = await this.parseSubElements(subPath, item);
          if (subNode.children && subNode.children.length > 0) {
            children.push(subNode);
          }
        } else if (item === 'Ext') {
          const subPath = path.join(elementPath, item);
          const subNode = await this.parseSubElements(subPath, item);
          subNode.parent = undefined; // will be set by caller
          children.push(subNode);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading EDT element directory ${elementPath}`, error);
    }
    return children;
  }

  /**
   * Build Attributes, TabularSections, EnumValues, Dimensions, and Resources tree nodes from parsed .mdo ChildObjects.
   */
  private static buildAttributesAndTabularFromMdo(
    mdoContent: Record<string, unknown>,
    mdoPath: string
  ): {
    attributesNode: TreeNode | null;
    tabularNode: TreeNode | null;
    enumValuesNode: TreeNode | null;
    dimensionsNode: TreeNode | null;
    resourcesNode: TreeNode | null;
  } {
    const childObjects = findChildObjects(mdoContent);
    if (!childObjects) {
      return { attributesNode: null, tabularNode: null, enumValuesNode: null, dimensionsNode: null, resourcesNode: null };
    }
    const co = childObjects as Record<string, unknown>;

    const attributesNode: TreeNode = {
      id: 'Attributes',
      name: 'Attributes',
      type: MetadataType.Attribute,
      properties: {},
      children: [],
      parentFilePath: mdoPath,
    };
    const attrList = extractAttributes(childObjects);
    for (const attr of attrList) {
      const a = attr as Record<string, unknown>;
      const attrName = (a.Properties && (a.Properties as Record<string, unknown>).Name) ?? (a as Record<string, unknown>).Name ?? 'Unknown';
      const attributeNode: TreeNode = {
        id: `Attributes.${String(attrName)}`,
        name: String(attrName),
        type: MetadataType.Attribute,
        properties: flattenAttributeProperties(a),
        parentFilePath: mdoPath,
      };
      attributeNode.parent = attributesNode;
      attributesNode.children!.push(attributeNode);
    }

    const tabularNode: TreeNode = {
      id: 'TabularSections',
      name: 'Tabular Sections',
      type: MetadataType.TabularSection,
      properties: {},
      children: [],
      parentFilePath: mdoPath,
    };
    const sectionList = extractTabularSections(childObjects);
    for (const section of sectionList) {
      const ts = section as Record<string, unknown>;
      const props = this.extractPropertiesFromMdo({ TabularSection: ts });
      const sectionName = String(props.Name ?? (ts.Properties && (ts.Properties as Record<string, unknown>).Name) ?? 'Unknown');
      const tsChildObjects = ts.ChildObjects;
      const tsAttrList = tsChildObjects && typeof tsChildObjects === 'object'
        ? extractAttributes(tsChildObjects as Record<string, unknown>)
        : [];

      const tsNode: TreeNode = {
        id: `TabularSections.${sectionName}`,
        name: sectionName,
        type: MetadataType.TabularSection,
        properties: { ...props },
        children: [],
        parentFilePath: mdoPath,
      };

      for (const attr of tsAttrList) {
        const a = attr as Record<string, unknown>;
        const attrName = (a.Properties && (a.Properties as Record<string, unknown>).Name) ?? (a as Record<string, unknown>).Name ?? 'Unknown';
        const attributeNode: TreeNode = {
          id: `TabularSections.${sectionName}.${String(attrName)}`,
          name: String(attrName),
          type: MetadataType.Attribute,
          properties: flattenAttributeProperties(a),
          parentFilePath: mdoPath,
        };
        attributeNode.parent = tsNode;
        tsNode.children!.push(attributeNode);
      }

      tsNode.parent = tabularNode;
      tabularNode.children!.push(tsNode);
    }

    // EnumValues
    const enumValuesList = extractEnumValues(co);
    let enumValuesNode: TreeNode | null = null;
    if (enumValuesList.length > 0) {
      enumValuesNode = {
        id: 'EnumValues',
        name: 'Значения',
        type: MetadataType.EnumValue,
        properties: {},
        children: [],
        parentFilePath: mdoPath,
      };
      for (const ev of enumValuesList) {
        const props = (ev as Record<string, unknown>).Properties ?? ev;
        const name = (props as Record<string, unknown>)?.Name ?? (props as Record<string, unknown>)?.name ?? 'Unknown';
        const evNode: TreeNode = {
          id: `EnumValues.${String(name)}`,
          name: String(name),
          type: MetadataType.EnumValue,
          properties: flattenAttributeProperties(ev),
          parentFilePath: mdoPath,
        };
        evNode.parent = enumValuesNode;
        enumValuesNode.children!.push(evNode);
      }
    }

    // Dimensions
    const dimensionsList = extractDimensions(co);
    let dimensionsNode: TreeNode | null = null;
    if (dimensionsList.length > 0) {
      dimensionsNode = {
        id: 'Dimensions',
        name: 'Измерения',
        type: MetadataType.Dimension,
        properties: {},
        children: [],
        parentFilePath: mdoPath,
      };
      for (const dim of dimensionsList) {
        const a = dim as Record<string, unknown>;
        const dimName = (a.Properties && (a.Properties as Record<string, unknown>).Name) ?? a.Name ?? 'Unknown';
        const dimNode: TreeNode = {
          id: `Dimensions.${String(dimName)}`,
          name: String(dimName),
          type: MetadataType.Dimension,
          properties: flattenAttributeProperties(a),
          parentFilePath: mdoPath,
        };
        dimNode.parent = dimensionsNode;
        dimensionsNode.children!.push(dimNode);
      }
    }

    // Resources
    const resourcesList = extractResources(co);
    let resourcesNode: TreeNode | null = null;
    if (resourcesList.length > 0) {
      resourcesNode = {
        id: 'Resources',
        name: 'Ресурсы',
        type: MetadataType.Resource,
        properties: {},
        children: [],
        parentFilePath: mdoPath,
      };
      for (const res of resourcesList) {
        const a = res as Record<string, unknown>;
        const resName = (a.Properties && (a.Properties as Record<string, unknown>).Name) ?? a.Name ?? 'Unknown';
        const resNode: TreeNode = {
          id: `Resources.${String(resName)}`,
          name: String(resName),
          type: MetadataType.Resource,
          properties: flattenAttributeProperties(a),
          parentFilePath: mdoPath,
        };
        resNode.parent = resourcesNode;
        resourcesNode.children!.push(resNode);
      }
    }

    return {
      attributesNode: attributesNode.children!.length > 0 ? attributesNode : null,
      tabularNode: tabularNode.children!.length > 0 ? tabularNode : null,
      enumValuesNode,
      dimensionsNode,
      resourcesNode,
    };
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

    if (typeName === 'Subsystems') {
      const flatNodes = await this.parseSubsystemsFlat(typePath, options?.shallow ?? false);
      buildSubsystemTree(flatNodes, typeNode);
      return typeNode;
    }

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
   * Load all subsystems as flat list with parentSubsystemRef for buildSubsystemTree (EDT: src/Subsystems/Name/Subsystem.mdo).
   */
  private static async parseSubsystemsFlat(typePath: string, shallow: boolean): Promise<TreeNode[]> {
    const flatNodes: TreeNode[] = [];
    let items: string[];
    try {
      items = await fs.promises.readdir(typePath);
    } catch {
      return flatNodes;
    }
    for (const item of items) {
      const itemPath = path.join(typePath, item);
      try {
        const stat = await fs.promises.stat(itemPath);
        if (!stat.isDirectory()) {continue;}
        const node = await this.parseMetadataElement(itemPath, item, 'Subsystems', shallow);
        const parentRef = node.properties.ParentSubsystem ?? node.properties.parentSubsystemRef;
        if (parentRef != null) {
          node.properties.parentSubsystemRef = this.normalizeParentSubsystemRef(parentRef);
        }
        flatNodes.push(node);
      } catch (error) {
        Logger.debug(`Error reading subsystem ${itemPath}`, error);
      }
    }
    return flatNodes;
  }

  /** Normalize EDT ParentSubsystem ref to subsystem name for matching (e.g. "Subsystem.Name" -> "Name"). */
  private static normalizeParentSubsystemRef(ref: unknown): string | null {
    if (ref == null) {return null;}
    let s: string;
    if (typeof ref === 'string') {
      s = ref.trim();
    } else if (typeof ref === 'object') {
      const obj = ref as Record<string, unknown>;
      const item = obj.item;
      if (typeof item !== 'string') {return null;}
      s = item.trim();
    } else {
      return null;
    }
    if (!s) {return null;}
    // Keep the most specific token. EDT refs are often like "Subsystem.<nameOrUuid>".
    // Prefer the rightmost segment so we don't collapse potentially unique refs to a name prefix.
    const dot = s.lastIndexOf('.');
    return dot >= 0 ? s.slice(dot + 1) : s;
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

    let mdoContent: Record<string, unknown> | null = null;
    try {
      await fs.promises.access(mdoPath);
      try {
        mdoContent = await XmlParser.parseFileAsync(mdoPath);
        const properties = this.extractPropertiesFromMdo(mdoContent);
        elementNode.properties = { ...elementNode.properties, ...properties };
        const objBelonging = extractObjectBelonging(mdoContent);
        if (objBelonging.objectBelonging !== undefined) {
          elementNode.properties.objectBelonging = objBelonging.objectBelonging;
        }
        if (objBelonging.extendedConfigurationObject !== undefined) {
          elementNode.properties.extendedConfigurationObject = objBelonging.extendedConfigurationObject;
        }
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

    if (mdoContent) {
      const fromMdo = this.buildAttributesAndTabularFromMdo(mdoContent, mdoPath);
      if (fromMdo.enumValuesNode?.children?.length) {
        fromMdo.enumValuesNode.parent = elementNode;
        elementNode.children?.push(fromMdo.enumValuesNode);
      }
      if (fromMdo.dimensionsNode?.children?.length) {
        fromMdo.dimensionsNode.parent = elementNode;
        elementNode.children?.push(fromMdo.dimensionsNode);
      }
      if (fromMdo.resourcesNode?.children?.length) {
        fromMdo.resourcesNode.parent = elementNode;
        elementNode.children?.push(fromMdo.resourcesNode);
      }
      if (fromMdo.attributesNode?.children?.length) {
        fromMdo.attributesNode.parent = elementNode;
        elementNode.children?.push(fromMdo.attributesNode);
      }
      if (fromMdo.tabularNode?.children?.length) {
        fromMdo.tabularNode.parent = elementNode;
        elementNode.children?.push(fromMdo.tabularNode);
      }
    }

    // Add virtual module nodes based on type
    const standardModules = STANDARD_MODULES[metadataType];
    if (standardModules) {
      for (const mod of standardModules) {
        const modPath = path.join(elementPath, mod.fileName);
        const modNode: TreeNode = {
          id: `${typeName}.${elementName}.${mod.fileName}`,
          name: mod.label,
          type: MetadataType.Method,
          properties: { isModule: true, fileType: 'bsl' },
          filePath: modPath,
          parent: elementNode,
        };
        elementNode.children?.push(modNode);
      }
    }

    try {
      const items = await fs.promises.readdir(elementPath);
      for (const item of items) {
        if (item === 'Forms') {
          const subPath = path.join(elementPath, item);
          const subNode = await this.parseSubElements(subPath, item);
          if (subNode.children && subNode.children.length > 0) {
            subNode.parent = elementNode;
            elementNode.children?.push(subNode);
          }
        } else if (item === 'Ext') {
          const subPath = path.join(elementPath, item);
          const subNode = await this.parseSubElements(subPath, item);
          subNode.parent = elementNode;
          elementNode.children?.push(subNode);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading EDT element directory ${elementPath}`, error);
    }

    return elementNode;
  }

  /**
   * Parse sub-elements (Forms, Ext, etc.)
   * For Ext: parity with Designer — recursive .bsl listing; folders as containers with Method children, single .bsl as Method.
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

      if (subType === 'Ext') {
        // Ext: same structure as Designer — .bsl files and folders with .bsl as children
        const extElementNodes = await Promise.all(
          items.map(async (item) => {
            const itemPath = path.join(subPath, item);
            try {
              const stat = await fs.promises.stat(itemPath);

              if (stat.isDirectory()) {
                const bslFiles = await this.findBslFilesRecursive(itemPath);
                if (bslFiles.length > 0) {
                  const container: TreeNode = {
                    id: `${subType}.${item}`,
                    name: item,
                    type: MetadataType.Extension,
                    properties: { isExtension: true },
                    filePath: itemPath,
                    children: bslFiles.map((bslPath) => ({
                      id: `${subType}.${item}.${path.basename(bslPath)}`,
                      name: path.basename(bslPath),
                      type: MetadataType.Method,
                      properties: { isModule: true, fileType: 'bsl' },
                      filePath: bslPath,
                    })),
                  };
                  return container;
                }
                return null;
              }
              if (stat.isFile() && item.endsWith('.bsl')) {
                return {
                  id: `${subType}.${item}`,
                  name: item,
                  type: MetadataType.Method,
                  properties: { isModule: true, fileType: 'bsl' },
                  filePath: itemPath,
                } as TreeNode;
              } else if (stat.isFile() && item === 'Predefined.xml') {
                // Parse predefined data items (#61)
                return this.parsePredefinedData(itemPath, `${subType}.`);
              }
            } catch (error) {
              Logger.debug(`Error processing Ext sub-element ${itemPath}`, error);
            }
            return null;
          })
        );
        for (const node of extElementNodes) {
          if (node) {
            (node as TreeNode).parent = subNode;
            if (node.children) {
              for (const ch of node.children) {
                (ch as TreeNode).parent = node as TreeNode;
              }
            }
            subNode.children?.push(node as TreeNode);
          }
        }
      } else {
        // Forms: directories as Form nodes
        const subElementNodes = await Promise.all(
          items.map(async (item) => {
            const itemPath = path.join(subPath, item);
            try {
              const stat = await fs.promises.stat(itemPath);

              if (stat.isDirectory()) {
                const child: TreeNode = {
                  id: `${subType}.${item}`,
                  name: item,
                  type: MetadataType.Form,
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

        for (const subElementNode of subElementNodes) {
          if (subElementNode) {
            subNode.children?.push(subElementNode);
          }
        }
      }
    } catch (error) {
      Logger.debug(`Error reading EDT sub-elements directory ${subPath}`, error);
    }

    return subNode;
  }

  /**
   * Parse Predefined.xml and return a container node with predefined item children.
   * Returns null when the file has no items or cannot be parsed.
   * @param filePath Absolute path to Predefined.xml
   * @param qp Id prefix (e.g. "Ext.")
   */
  private static async parsePredefinedData(filePath: string, qp: string): Promise<TreeNode | null> {
    try {
      const parsed = await XmlParser.parseFileAsync(filePath);
      if (!parsed) { return null; }

      // Find PredefinedData root — may carry a namespace prefix
      let predefinedData: Record<string, unknown> | null = null;
      for (const [key, val] of Object.entries(parsed)) {
        if (key === 'PredefinedData' || key.endsWith(':PredefinedData')) {
          predefinedData = val as Record<string, unknown>;
          break;
        }
      }
      if (!predefinedData) { return null; }

      const rawItems = predefinedData['Item'];
      if (!rawItems) { return null; }
      const items = Array.isArray(rawItems) ? rawItems : [rawItems];
      if (items.length === 0) { return null; }

      const containerId = `${qp}PredefinedData`;
      const container: TreeNode = {
        id: containerId,
        name: 'Предопределённые',
        type: MetadataType.PredefinedItem,
        properties: {},
        children: [],
        filePath,
      };

      for (const item of items) {
        if (!item || typeof item !== 'object') { continue; }
        const obj = item as Record<string, unknown>;
        const name = String(obj['Name'] ?? 'Unknown');
        const isFolder = String(obj['IsFolder'] ?? 'false') === 'true';
        const node: TreeNode = {
          id: `${containerId}.${name}`,
          name,
          type: MetadataType.PredefinedItem,
          properties: {
            ...(obj['Code'] != null ? { code: String(obj['Code']) } : {}),
            ...(obj['Description'] != null ? { description: String(obj['Description']) } : {}),
            ...(isFolder ? { isFolder: true } : {}),
          },
          parentFilePath: filePath,
          parent: container,
        };
        container.children!.push(node);
      }

      return container;
    } catch (error) {
      Logger.debug(`Error parsing predefined data from ${filePath}`, error);
      return null;
    }
  }

  /**
   * Recursively find all .bsl files in a directory (parity with DesignerParser for Ext).
   */
  private static async findBslFilesRecursive(
    dirPath: string,
    maxDepth: number = 10,
    currentDepth: number = 0
  ): Promise<string[]> {
    const bslFiles: string[] = [];
    if (currentDepth >= maxDepth) {
      Logger.debug(`Max depth ${maxDepth} reached at ${dirPath}`);
      return bslFiles;
    }
    try {
      const items = await fs.promises.readdir(dirPath);
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        try {
          const stat = await fs.promises.stat(itemPath);
          if (stat.isDirectory()) {
            const subFiles = await this.findBslFilesRecursive(itemPath, maxDepth, currentDepth + 1);
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
              if ('v8:Type' in obj) {
                result[propKey] = obj;
              } else if (obj.item) {
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
      ExchangePlans: 'ExchangePlan.mdo',
      DocumentJournals: 'DocumentJournal.mdo',
      DefinedTypes: 'DefinedType.mdo',
      CommonAttributes: 'CommonAttribute.mdo',
      CommonCommands: 'CommonCommand.mdo',
      CommonForms: 'CommonForm.mdo',
      CommonPictures: 'CommonPicture.mdo',
      CommonTemplates: 'CommonTemplate.mdo',
      DocumentNumerators: 'DocumentNumerator.mdo',
      Languages: 'Language.mdo',
      WSReferences: 'WSReference.mdo',
      XDTOPackages: 'XDTOPackage.mdo',
      StyleItems: 'StyleItem.mdo',
    };

    return typeMap[typeName] || 'Object.mdo';
  }

  /**
   * Load column nodes for a tabular section instance (Designer parity) when expanding the columns placeholder.
   */
  static async loadTabularSectionColumnChildren(sectionInstance: TreeNode): Promise<TreeNode[]> {
    const mdoPath = sectionInstance.parentFilePath || sectionInstance.filePath;
    if (!mdoPath || !mdoPath.toLowerCase().endsWith('.mdo')) {
      return [];
    }
    try {
      await fs.promises.access(mdoPath);
    } catch {
      return [];
    }
    const mdoContent = await XmlParser.parseFileAsync(mdoPath);
    const childObjects = findChildObjects(mdoContent as Record<string, unknown>);
    if (!childObjects) {
      return [];
    }
    const sectionList = extractTabularSections(childObjects);
    for (const sec of sectionList) {
      const ts = sec as Record<string, unknown>;
      const props = this.extractPropertiesFromMdo({ TabularSection: ts });
      const sn = String(
        props.Name ?? (ts.Properties && (ts.Properties as Record<string, unknown>).Name) ?? ''
      );
      if (sn !== sectionInstance.name) {
        continue;
      }
      const tsChildObjects = ts.ChildObjects;
      const attrList =
        tsChildObjects && typeof tsChildObjects === 'object' && !Array.isArray(tsChildObjects)
          ? extractAttributes(tsChildObjects as Record<string, unknown>)
          : [];
      const out: TreeNode[] = [];
      const baseId = sectionInstance.id;
      for (const attr of attrList) {
        const a = attr as Record<string, unknown>;
        const attrName =
          (a.Properties && (a.Properties as Record<string, unknown>).Name) ??
          (a as Record<string, unknown>).Name ??
          'Unknown';
        const attributeNode: TreeNode = {
          id: `${baseId}.${String(attrName)}`,
          name: String(attrName),
          type: MetadataType.Attribute,
          properties: flattenAttributeProperties(a),
          parentFilePath: mdoPath,
        };
        out.push(attributeNode);
      }
      return out;
    }
    return [];
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
