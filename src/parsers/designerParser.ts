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
  extractChildSubsystems,
  flattenAttributeProperties,
} from './xmlChildObjects';
import { buildSubsystemTree } from './subsystemTreeBuilder';
import { CONFIGURATION_XML } from '../constants/fileNames';
import {
  extractExtensionProperties,
  extractObjectBelonging,
} from '../extensionSupport/extensionXmlParser';

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
        configXmlPath = path.join(configPath, CONFIGURATION_XML);
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
   * Resolve path to configuration properties file (Configuration.xml).
   */
  private static getConfigurationXmlPath(configPath: string): string {
    return path.join(configPath, CONFIGURATION_XML);
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

    // Try to read extension properties from Configuration.xml
    try {
      const configXmlPath = this.getConfigurationXmlPath(configPath);
      await fs.promises.access(configXmlPath);
      const configXml = await XmlParser.parseFileAsync(configXmlPath);
      const extProps = extractExtensionProperties(configXml);
      if (extProps.extensionPurpose !== undefined) {
        rootNode.properties.extensionPurpose = extProps.extensionPurpose;
      }
      if (extProps.namePrefix !== undefined) {
        rootNode.properties.namePrefix = extProps.namePrefix;
      }
    } catch {
      // Not an extension or Configuration.xml not found — skip
    }

    // Parse metadata directories
    const metadataTypes = MetadataTypeMapper.getMetadataTypes();

    // Process all metadata types in parallel
    const typeNodes = await Promise.all(
      metadataTypes.map(async (metadataType) => {
        const typePath = path.join(configPath, metadataType);
        try {
          await fs.promises.access(typePath);
          return await this.parseMetadataType(typePath, metadataType);
        } catch (error) {
          Logger.debug(`Failed to parse type ${metadataType} at ${typePath}`, error);
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

    // Try to read extension properties from Configuration.xml
    try {
      const configXmlPath = this.getConfigurationXmlPath(configPath);
      await fs.promises.access(configXmlPath);
      const configXml = await XmlParser.parseFileAsync(configXmlPath);
      const extProps = extractExtensionProperties(configXml);
      if (extProps.extensionPurpose !== undefined) {
        rootNode.properties.extensionPurpose = extProps.extensionPurpose;
      }
      if (extProps.namePrefix !== undefined) {
        rootNode.properties.namePrefix = extProps.namePrefix;
      }
    } catch {
      // Not an extension or Configuration.xml not found — skip
    }

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
   * For Subsystems, child subsystems are already in the tree; path is derived from element.filePath when provided.
   */
  static async loadChildrenForElement(
    configPath: string,
    typeName: string,
    elementName: string,
    element?: TreeNode
  ): Promise<TreeNode[]> {
    let elementPath: string;
    let xmlPath: string;
    if (typeName === 'Subsystems' && element?.filePath) {
      const dir = path.dirname(element.filePath);
      const dirWithName = path.join(dir, element.name);
      try {
        await fs.promises.access(dirWithName);
        elementPath = dirWithName;
      } catch {
        elementPath = dir;
      }
      xmlPath = element.filePath;
    } else {
      elementPath = path.join(configPath, typeName, elementName);
      xmlPath = path.join(configPath, typeName, `${elementName}.xml`);
    }
    const children: TreeNode[] = [];

    let xmlContent: Record<string, unknown> | null = null;
    try {
      await fs.promises.access(xmlPath);
      xmlContent = await XmlParser.parseFileAsync(xmlPath);
    } catch {
      // No XML
    }

    // Use a temporary container to leverage the shared child-building helpers.
    const container: TreeNode = {
      id: `${typeName}.${elementName}`,
      name: elementName,
      type: MetadataType.Configuration,
      properties: {},
      children,
    };

    if (xmlContent) {
      await this.applyXmlDerivedChildren(container, xmlContent, xmlPath, elementName);
    }

    const typeDir = path.join(configPath, typeName);
    const isElementPathTypeRoot = path.normalize(elementPath) === path.normalize(typeDir);
    try {
      if (isElementPathTypeRoot) {
        return children;
      }
      const items = await fs.promises.readdir(elementPath);
      for (const item of items) {
        await this.applyDirectoryChild(container, elementPath, typeName, elementName, item);
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

    if (typeName === 'Subsystems') {
      const flatNodes = await this.collectDesignerSubsystemsFlat(typePath, options?.shallow ?? false);
      buildSubsystemTree(flatNodes, typeNode);
      return typeNode;
    }

    // Read items: каталог объекта ИЛИ плоский «Имя.xml» в папке типа (частая выгрузка без подкаталога на объект).
    try {
      const items = await fs.promises.readdir(typePath);
      const shallow = options?.shallow ?? false;
      const elementNodes: TreeNode[] = [];
      const dirNames = new Set<string>();

      for (const item of items) {
        const itemPath = path.join(typePath, item);
        try {
          const stat = await fs.promises.stat(itemPath);
          if (stat.isDirectory()) {
            dirNames.add(item);
            const node = await this.parseMetadataElement(itemPath, item, typeName, shallow);
            elementNodes.push(node);
          }
        } catch (error) {
          Logger.debug(`Error processing item ${itemPath}`, error);
        }
      }

      for (const item of items) {
        if (!item.toLowerCase().endsWith('.xml')) {
          continue;
        }
        const elementName = path.basename(item, path.extname(item));
        if (dirNames.has(elementName)) {
          continue;
        }
        const itemPath = path.join(typePath, item);
        try {
          const stat = await fs.promises.stat(itemPath);
          if (!stat.isFile()) {
            continue;
          }
          const virtualElementPath = path.join(typePath, elementName);
          const node = await this.parseMetadataElement(virtualElementPath, elementName, typeName, shallow);
          elementNodes.push(node);
        } catch (error) {
          Logger.debug(`Error processing flat metadata xml ${itemPath}`, error);
        }
      }

      elementNodes.sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }));
      for (const elementNode of elementNodes) {
        elementNode.parent = typeNode;
        typeNode.children?.push(elementNode);
      }
    } catch (error) {
      Logger.warn(`Error reading metadata type directory ${typePath}`, error);
    }

    return typeNode;
  }

  /**
   * Recursively collect all subsystem XML paths: Subsystems/Name.xml and Subsystems/Name/Subsystems/Name.xml.
   */
  private static async collectSubsystemXmlPaths(subsystemsDir: string): Promise<string[]> {
    const result: string[] = [];
    const items = await fs.promises.readdir(subsystemsDir).catch(() => [] as string[]);
    for (const item of items) {
      const full = path.join(subsystemsDir, item);
      const stat = await fs.promises.stat(full).catch(() => null);
      if (!stat) {continue;}
      if (stat.isFile() && item.toLowerCase().endsWith('.xml')) {
        result.push(full);
      } else if (stat.isDirectory()) {
        const subSubsystems = path.join(full, 'Subsystems');
        const subStat = await fs.promises.stat(subSubsystems).catch(() => null);
        if (subStat?.isDirectory()) {
          const nested = await this.collectSubsystemXmlPaths(subSubsystems);
          result.push(...nested);
        }
      }
    }
    return result;
  }

  /**
   * Collect all Designer subsystems as flat list with parentSubsystemRef derived from path.
   */
  private static async collectDesignerSubsystemsFlat(
    typePath: string,
    shallow: boolean
  ): Promise<TreeNode[]> {
    const xmlPaths = await this.collectSubsystemXmlPaths(typePath);
    const flatNodes: TreeNode[] = [];
    for (const xmlPath of xmlPaths) {
      let xmlContent: Record<string, unknown>;
      try {
        xmlContent = await XmlParser.parseFileAsync(xmlPath);
      } catch (error) {
        Logger.debug(`Error parsing subsystem XML ${xmlPath}`, error);
        continue;
      }
      const properties = this.extractPropertiesFromElement(xmlContent);
      const name = String(properties?.Name ?? path.basename(xmlPath, '.xml'));
      const childObjects = findChildObjects(xmlContent);
      const childSubsystemNames = extractChildSubsystems(childObjects);
      const node: TreeNode = {
        id: `${typePath}.${name}`,
        name,
        type: MetadataType.Subsystem,
        properties: { type: 'Subsystems', ...properties, childSubsystemNames },
        children: [],
        filePath: xmlPath,
      };
      if (shallow) {
        node.properties._lazy = true;
      }
      if (properties?.uuid != null) {
        node.properties.uuid = properties.uuid;
      }
      flatNodes.push(node);
    }
    const elementDirByNode = new Map<TreeNode, string>();
    const containerDirByNode = new Map<TreeNode, string>();
    const normalizedTypePath = path.normalize(typePath);
    for (const node of flatNodes) {
      const elementDir = path.normalize(path.dirname(node.filePath!));
      elementDirByNode.set(node, elementDir);
      if (elementDir === normalizedTypePath) {
        containerDirByNode.set(node, path.join(elementDir, node.name));
      } else if (elementDir.endsWith(path.sep + 'Subsystems')) {
        containerDirByNode.set(node, path.dirname(elementDir));
      } else {
        containerDirByNode.set(node, path.join(elementDir, node.name));
      }
    }
    // When two nodes share the same containerDir (e.g. root Администрирование.xml and nested .../Администрирование/Subsystems/Администрирование.xml),
    // prefer the root-level one (XML in type dir) as the container owner so parent lookup finds the correct parent.
    const byContainerDir = new Map<string, TreeNode>();
    for (const node of flatNodes) {
      const cdir = containerDirByNode.get(node)!;
      const existing = byContainerDir.get(cdir);
      const nodeIsRootLevel = elementDirByNode.get(node) === normalizedTypePath;
      if (!existing) {
        byContainerDir.set(cdir, node);
      } else {
        const existingIsRootLevel = elementDirByNode.get(existing) === normalizedTypePath;
        if (nodeIsRootLevel && !existingIsRootLevel) {
          byContainerDir.set(cdir, node);
        }
      }
    }
    for (const node of flatNodes) {
      const elementDir = elementDirByNode.get(node)!;
      if (elementDir === normalizedTypePath) {continue;}
      if (elementDir.endsWith(path.sep + 'Subsystems')) {
        const parentContainerDir = path.normalize(path.dirname(elementDir));
        const parent = byContainerDir.get(parentContainerDir);
        if (parent) {
          // ADR 0001: parent reference must not be ambiguous by name (names can repeat).
          // We keep a stable unique key for builder: parent subsystem filePath.
          node.properties.parentSubsystemRef = { filePath: parent.filePath, name: parent.name };
        }
      }
    }
    return flatNodes;
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
        const objBelonging = extractObjectBelonging(xmlContent);
        if (objBelonging.objectBelonging !== undefined) {
          elementNode.properties.objectBelonging = objBelonging.objectBelonging;
        }
        if (objBelonging.extendedConfigurationObject !== undefined) {
          elementNode.properties.extendedConfigurationObject = objBelonging.extendedConfigurationObject;
        }
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
      // Update filePath to point to XML file regardless of parse success
      elementNode.filePath = xmlPath;
      try {
        xmlContent = await XmlParser.parseFileAsync(xmlPath);
        const properties = this.extractPropertiesFromElement(xmlContent);
        elementNode.properties = { ...elementNode.properties, ...properties };
        const objBelonging = extractObjectBelonging(xmlContent);
        if (objBelonging.objectBelonging !== undefined) {
          elementNode.properties.objectBelonging = objBelonging.objectBelonging;
        }
        if (objBelonging.extendedConfigurationObject !== undefined) {
          elementNode.properties.extendedConfigurationObject = objBelonging.extendedConfigurationObject;
        }
      } catch (error) {
        Logger.warn(`Error parsing element XML ${xmlPath}`, error);
      }
    } catch {
      // XML file doesn't exist, skip
    }

    // Parse Attributes and TabularSections from XML ChildObjects if available
    if (xmlContent) {
      await this.applyXmlDerivedChildren(elementNode, xmlContent, xmlPath, elementName);
    }

    // Parse sub-elements from filesystem (Ext, Forms, Attributes, TabularSections)
    try {
      const items = await fs.promises.readdir(elementPath);
      for (const item of items) {
        await this.applyDirectoryChild(elementNode, elementPath, typeName, elementName, item);
      }
    } catch (error) {
      Logger.debug(`Error reading element directory ${elementPath}`, error);
    }

    return elementNode;
  }

  /**
   * Parse extensions directory
   * @param extPath Path to Ext directory
   * @param idPrefix Optional prefix for stable node ids (e.g. `CommonModules.MyModule`) so `Ext` is unique in the tree cache
   * @returns Tree node for extensions
   */
  private static async parseExtensions(extPath: string, idPrefix?: string): Promise<TreeNode> {
    const qp = idPrefix != null && idPrefix !== '' ? `${idPrefix}.` : '';
    const extNode: TreeNode = {
      id: `${qp}Ext`,
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
                  id: `${qp}Ext.${item}`,
                  name: item,
                  type: MetadataType.Extension,
                  properties: { isExtension: true },
                  filePath: itemPath,
                  children: bslFiles.map((bslPath) => ({
                    id: `${qp}Ext.${item}.${path.basename(bslPath)}`,
                    name: path.basename(bslPath),
                    type: MetadataType.Method,
                    properties: {
                      isModule: true,
                      fileType: 'bsl',
                    },
                    filePath: bslPath,
                  })),
                };
              }
              return null; // Skip empty directories
            } else if (stat.isFile() && item.endsWith('.bsl')) {
              // Add .bsl module files directly
              return {
                id: `${qp}Ext.${item}`,
                name: item,
                type: MetadataType.Method,
                properties: {
                  isModule: true,
                  fileType: 'bsl',
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
   * @param dirPath Directory to search
   * @param maxDepth Maximum recursion depth (default: 10)
   * @param currentDepth Current recursion depth (used internally)
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
            // Recursively search subdirectories
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
      const names = new Set<string>();
      for (const item of items) {
        const itemPath = path.join(formsPath, item);
        try {
          const stat = await fs.promises.stat(itemPath);
          if (stat.isFile() && item.toLowerCase().endsWith('.xml')) {
            names.add(path.basename(item, path.extname(item)));
          } else if (stat.isDirectory()) {
            names.add(item);
          }
        } catch {
          /* skip */
        }
      }

      const sortedNames = Array.from(names).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      for (const name of sortedNames) {
        const flatMetaPath = path.join(formsPath, `${name}.xml`);
        const nestedDir = path.join(formsPath, name);
        const nestedMetaPath = path.join(nestedDir, `${name}.xml`);
        let filePath: string;
        let extBase: string;
        let properties: Record<string, unknown> = { name };
        try {
          let hasFlatMeta = false;
          try {
            await fs.promises.access(flatMetaPath);
            hasFlatMeta = true;
          } catch {
            hasFlatMeta = false;
          }
          let hasNestedDir = false;
          try {
            const st = await fs.promises.stat(nestedDir);
            hasNestedDir = st.isDirectory();
          } catch {
            hasNestedDir = false;
          }

          if (hasFlatMeta) {
            filePath = flatMetaPath;
            extBase = nestedDir;
            try {
              const xmlContent = await XmlParser.parseFileAsync(flatMetaPath);
              properties = { ...properties, ...this.extractPropertiesFromElement(xmlContent) };
            } catch {
              /* keep minimal properties */
            }
          } else if (hasNestedDir) {
            filePath = nestedDir;
            extBase = nestedDir;
            try {
              await fs.promises.access(nestedMetaPath);
              const xmlContent = await XmlParser.parseFileAsync(nestedMetaPath);
              properties = { ...properties, ...this.extractPropertiesFromElement(xmlContent) };
            } catch {
              /* {Name}.xml внутри каталога может отсутствовать */
            }
          } else {
            continue;
          }

          const formNode: TreeNode = {
            id: `Forms.${name}`,
            name,
            type: MetadataType.Form,
            properties,
            filePath,
            children: [],
            parent: formsNode,
          };

          const extPath = path.join(extBase, 'Ext');
          try {
            await fs.promises.access(extPath);
            const extNode = await this.parseExtensions(extPath);
            if (extNode.children && extNode.children.length > 0) {
              extNode.parent = formNode;
              formNode.children?.push(extNode);
            }
          } catch {
            /* No Ext directory */
          }

          formsNode.children?.push(formNode);
        } catch (error) {
          Logger.debug(`Error processing form ${name}`, error);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading forms directory ${formsPath}`, error);
    }

    return formsNode;
  }

  /**
   * Build a single attribute TreeNode from a raw XML attribute object.
   * Shared by both XML-embedded and filesystem attribute parsing paths.
   */
  private static buildAttributeNodeFromRaw(
    attr: Record<string, unknown>,
    idPrefix: string,
    parentXmlPath: string
  ): TreeNode {
    const attrName =
      (attr.Properties && (attr.Properties as Record<string, unknown>).Name) ||
      attr.Name ||
      'Unknown';
    return {
      id: `${idPrefix}.${String(attrName)}`,
      name: String(attrName),
      type: MetadataType.Attribute,
      properties: flattenAttributeProperties(attr),
      parentFilePath: parentXmlPath,
    };
  }

  /**
   * Build a single tabular section TreeNode (and its attribute children) from a raw XML section object.
   * Shared by both XML-embedded and filesystem tabular-section parsing paths.
   */
  private static buildTsNodeFromRaw(
    ts: Record<string, unknown>,
    xmlFilePath: string,
    containerNode: TreeNode
  ): TreeNode {
    const props = this.extractPropertiesFromElement({ TabularSection: ts });
    const sectionName = String(
      props.Name ??
        ((ts.Properties && (ts.Properties as Record<string, unknown>).Name) ?? 'Unknown')
    );

    const tsNode: TreeNode = {
      id: `TabularSections.${sectionName}`,
      name: sectionName,
      type: MetadataType.TabularSection,
      properties: { ...props },
      children: [],
      parentFilePath: xmlFilePath,
    };
    tsNode.parent = containerNode;

    const colNodes = this.buildTabularColumnNodesFromTsBlock(ts, tsNode, xmlFilePath);
    for (const col of colNodes) {
      col.parent = tsNode;
      tsNode.children!.push(col);
    }

    return tsNode;
  }

  /**
   * Merge a parsed tabular sections container into a parent node's children list.
   * If a 'TabularSections' container already exists, deduplicates by section name.
   * Otherwise appends the new container node.
   */
  private static mergeTabularNode(parent: TreeNode, tabularNode: TreeNode): void {
    const existing = parent.children?.find((c) => c.id === 'TabularSections');
    if (!existing) {
      tabularNode.parent = parent;
      parent.children!.push(tabularNode);
      return;
    }
    existing.children = existing.children ?? [];
    for (const ch of tabularNode.children ?? []) {
      if (existing.children.some((e) => e.name === ch.name)) {
        continue;
      }
      ch.parent = existing;
      existing.children.push(ch);
    }
  }

  /**
   * Parse the XML-embedded Attributes and TabularSections from ChildObjects and push results
   * into the given parent node's children. Handles deduplication for tabular sections.
   */
  private static async applyXmlDerivedChildren(
    parent: TreeNode,
    xmlContent: Record<string, unknown>,
    xmlPath: string,
    elementName: string
  ): Promise<void> {
    const attributesNode = await this.parseAttributesFromXML(xmlContent, xmlPath, elementName);
    if (attributesNode.children && attributesNode.children.length > 0) {
      attributesNode.parent = parent;
      parent.children!.push(attributesNode);
    }

    const tabularNode = await this.parseTabularSectionsFromXML(xmlContent, xmlPath, elementName);
    if (tabularNode && tabularNode.children && tabularNode.children.length > 0) {
      this.mergeTabularNode(parent, tabularNode);
    }
  }

  /**
   * Process a single directory item (Ext, Forms, Attributes, TabularSections) from an element
   * directory and push resulting child nodes into the parent node's children list.
   */
  private static async applyDirectoryChild(
    parent: TreeNode,
    elementPath: string,
    typeName: string,
    elementName: string,
    item: string
  ): Promise<void> {
    if (item === 'Ext') {
      const extNode = await this.parseExtensions(
        path.join(elementPath, item),
        typeName === 'CommonModules' ? `${typeName}.${elementName}` : undefined
      );
      if (extNode.children && extNode.children.length > 0) {
        extNode.parent = parent;
        parent.children!.push(extNode);
      }
    } else if (item === 'Forms') {
      const formsNode = await this.parseForms(path.join(elementPath, item));
      if (formsNode.children && formsNode.children.length > 0) {
        formsNode.parent = parent;
        parent.children!.push(formsNode);
      }
    } else if (item === 'Attributes') {
      const attributesNode = await this.parseAttributes(path.join(elementPath, item));
      if (attributesNode.children && attributesNode.children.length > 0) {
        attributesNode.parent = parent;
        parent.children!.push(attributesNode);
      }
    } else if (item === 'TabularSections') {
      const tabularNode = await this.parseTabularSections(path.join(elementPath, item));
      if (tabularNode.children && tabularNode.children.length > 0) {
        this.mergeTabularNode(parent, tabularNode);
      }
    }
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

      const attributeNodes = await Promise.all(
        items.map(async (item) => {
          const itemPath = path.join(attributesPath, item);
          try {
            const stat = await fs.promises.stat(itemPath);

            if (stat.isDirectory()) {
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

      const tabularSectionNodes = await Promise.all(
        items.map((item) => this.parseSingleTabularSectionDir(tabularPath, item, tabularNode))
      );

      for (const tsNode of tabularSectionNodes) {
        if (tsNode) {
          tabularNode.children?.push(tsNode);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading tabular sections directory ${tabularPath}`, error);
    }

    return tabularNode;
  }

  /**
   * Parse a single tabular section subdirectory into a TreeNode.
   * Returns null when the item is not a directory or cannot be parsed.
   */
  private static async parseSingleTabularSectionDir(
    tabularPath: string,
    item: string,
    containerNode: TreeNode
  ): Promise<TreeNode | null> {
    const itemPath = path.join(tabularPath, item);
    try {
      const stat = await fs.promises.stat(itemPath);
      if (!stat.isDirectory()) {
        return null;
      }

      const xmlPath = path.join(itemPath, `${item}.xml`);
      let properties: Record<string, unknown> = { name: item };
      let tsChildren: TreeNode[] = [];

      try {
        await fs.promises.access(xmlPath);
        const xmlContent = await XmlParser.parseFileAsync(xmlPath);
        properties = { ...properties, ...this.extractPropertiesFromElement(xmlContent) };

        const tsChildObjects = findChildObjects(xmlContent);
        if (tsChildObjects) {
          const attrList = extractAttributes(tsChildObjects);
          tsChildren = attrList.map((attr) =>
            this.buildAttributeNodeFromRaw(
              attr as Record<string, unknown>,
              `TabularSections.${item}`,
              xmlPath
            )
          );
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
        c.parent = tsNode;
      }
      tsNode.parent = containerNode;
      return tsNode;
    } catch (error) {
      Logger.debug(`Error processing tabular section ${itemPath}`, error);
      return null;
    }
  }

  /**
   * Parse attributes from XML ChildObjects section.
   * @param xmlContent Parsed XML content
   * @param xmlFilePath Path to the element's XML file (same file we read attributes from)
   * @param elementName Name of element (used for logging)
   * @returns Tree node for attributes container
   */
  private static async parseAttributesFromXML(
    xmlContent: Record<string, unknown>,
    xmlFilePath: string,
    elementName: string
  ): Promise<TreeNode> {
    const attributesNode: TreeNode = {
      id: 'Attributes',
      name: 'Attributes',
      type: MetadataType.Attribute,
      properties: {},
      children: [],
      // Don't set filePath to avoid collision with parent node
      parentFilePath: xmlFilePath,
    };

    try {
      const childObjects = findChildObjects(xmlContent);
      if (childObjects == null) {
        return attributesNode;
      }

      for (const attr of extractAttributes(childObjects)) {
        const attrNode = this.buildAttributeNodeFromRaw(
          attr as Record<string, unknown>,
          'Attributes',
          xmlFilePath
        );
        attrNode.parent = attributesNode;
        attributesNode.children!.push(attrNode);
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
   * @param _elementName Name of the element (unused; kept for call-site consistency)
   * @returns Tree node for TabularSections container or null if none found
   */
  private static async parseTabularSectionsFromXML(
    xmlContent: Record<string, unknown>,
    xmlFilePath: string,
    _elementName: string
  ): Promise<TreeNode | null> {
    void _elementName;
    const childObjects = findChildObjects(xmlContent);
    if (childObjects == null) {return null;}

    const sectionList = extractTabularSections(childObjects);
    if (sectionList.length === 0) {return null;}

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
      const tsNode = this.buildTsNodeFromRaw(ts, xmlFilePath, tabularNode);
      tabularNode.children!.push(tsNode);
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

  private static buildTabularColumnNodesFromTsBlock(
    ts: Record<string, unknown>,
    sectionInstance: TreeNode,
    xmlPath: string
  ): TreeNode[] {
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
        parentFilePath: xmlPath,
      };
      out.push(attributeNode);
    }
    return out;
  }

  /**
   * Load column (Attribute) nodes for a tabular section instance when expanding the «Реквизиты» placeholder.
   */
  static async loadTabularSectionColumnChildren(sectionInstance: TreeNode): Promise<TreeNode[]> {
    const xmlPath =
      sectionInstance.filePath && sectionInstance.filePath.toLowerCase().endsWith('.xml')
        ? sectionInstance.filePath
        : sectionInstance.parentFilePath;
    if (!xmlPath) {
      return [];
    }
    try {
      await fs.promises.access(xmlPath);
    } catch {
      return [];
    }
    const xmlContent = await XmlParser.parseFileAsync(xmlPath);
    const metaWrapper = xmlContent as Record<string, unknown>;
    const rootObj = (metaWrapper.MetaDataObject ?? metaWrapper) as Record<string, unknown>;
    const tsRaw = rootObj.TabularSection;
    if (tsRaw) {
      const tsBlock = (Array.isArray(tsRaw) ? tsRaw[0] : tsRaw) as Record<string, unknown>;
      const props = this.extractPropertiesFromElement({ TabularSection: tsBlock });
      const nameFromXml = String(props.Name ?? '');
      if (!nameFromXml || nameFromXml === sectionInstance.name) {
        return this.buildTabularColumnNodesFromTsBlock(tsBlock, sectionInstance, xmlPath);
      }
    }
    for (const key of Object.keys(rootObj)) {
      if (key === '@_' || key.startsWith('#')) {
        continue;
      }
      const val = rootObj[key];
      if (!val || typeof val !== 'object' || Array.isArray(val)) {
        continue;
      }
      const elem = val as Record<string, unknown>;
      const co = findChildObjects(elem);
      if (!co) {
        continue;
      }
      const sectionList = extractTabularSections(co);
      for (const sec of sectionList) {
        const ts = sec as Record<string, unknown>;
        const props = this.extractPropertiesFromElement({ TabularSection: ts });
        const sn = String(props.Name ?? '');
        if (sn !== sectionInstance.name) {
          continue;
        }
        return this.buildTabularColumnNodesFromTsBlock(ts, sectionInstance, xmlPath);
      }
    }
    return [];
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
      const configXmlPath = path.join(configPath, CONFIGURATION_XML);

      // Check if binary files exist (full Designer format)
      const hasBinaryFiles = fs.existsSync(cfPath) || fs.existsSync(cfePath);
      
      // Check if XML metadata exists (exported Designer format)
      const hasXmlMetadata = fs.existsSync(configDumpPath) || fs.existsSync(configXmlPath);

      // Binary format: both binary and XML metadata must exist
      if (hasBinaryFiles && hasXmlMetadata) {
        return true;
      }
      // XML-only export: Configuration.xml (or ConfigDumpInfo.xml) is sufficient (e.g. empty configuration)
      if (hasXmlMetadata) {
        return true;
      }

      return false;
    } catch (error) {
      Logger.debug('Designer format detection failed', error);
      return false;
    }
  }
}
