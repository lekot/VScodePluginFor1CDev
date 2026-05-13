/**
 * Metadata loader utility for the Roles and Rights Editor
 * Loads all metadata objects from configuration and prepares them for rights assignment
 */

import * as path from 'path';
import * as fs from 'fs';
import { MetadataParser } from '../parsers/metadataParser';
import { FormatDetector, ConfigFormat } from '../parsers/formatDetector';
import { TreeNode, MetadataType } from '../models/treeNode';
import { MetadataObject } from './models/metadataObject';
import { RightsMap } from './models/roleModel';
import { Logger } from '../utils/logger';
import { MetadataTypeMapper } from '../utils/metadataTypeMapper';
import { CONFIGURATION_XML } from '../constants/fileNames';

/**
 * Metadata types that can have rights assigned
 * Excludes sub-elements like Attributes, Forms, etc.
 */
const RIGHTS_ASSIGNABLE_TYPES: MetadataType[] = [
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.Enum,
  MetadataType.Report,
  MetadataType.DataProcessor,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfAccounts,
  MetadataType.ChartOfCalculationTypes,
  MetadataType.InformationRegister,
  MetadataType.AccumulationRegister,
  MetadataType.AccountingRegister,
  MetadataType.CalculationRegister,
  MetadataType.BusinessProcess,
  MetadataType.Task,
  MetadataType.ExternalDataSource,
  MetadataType.Constant,
  MetadataType.SessionParameter,
  MetadataType.FilterCriterion,
  MetadataType.ScheduledJob,
  MetadataType.FunctionalOption,
  MetadataType.FunctionalOptionsParameter,
  MetadataType.SettingsStorage,
  MetadataType.Command,
  MetadataType.WebService,
  MetadataType.HTTPService,
  MetadataType.IntegrationService,
  MetadataType.Subsystem,
  MetadataType.ExchangePlan,
  MetadataType.DocumentJournal,
  MetadataType.CommonAttribute,
  MetadataType.CommonCommand,
  MetadataType.CommonForm,
];

/** Types for which we load attribute-level rights rows (same scope as R6 lazy Attributes in the tree). */
const OBJECT_TYPES_FOR_ATTRIBUTE_RIGHTS: MetadataType[] = [
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.DataProcessor,
  MetadataType.ChartOfCharacteristicTypes,
];

const CONFIGURATION_RIGHTS_FULL_NAME = 'Configuration';

function folderNameForMetadataType(t: MetadataType): string | null {
  for (const folder of MetadataTypeMapper.getMetadataTypes()) {
    if (MetadataTypeMapper.map(folder) === t) {
      return folder;
    }
  }
  return null;
}

/**
 * Best-effort synonym or name from Configuration.xml for the configuration root rights row.
 */
async function readConfigurationRootDisplayName(configRootPath: string): Promise<string> {
  const configXmlPath = path.join(configRootPath, CONFIGURATION_XML);
  try {
    const text = await fs.promises.readFile(configXmlPath, 'utf-8');
    const syn = text.match(/<Synonym>[\s\S]*?<v8:content>([^<]+)<\/v8:content>/i);
    if (syn?.[1]?.trim()) {
      return syn[1].trim();
    }
    const nameM = text.match(/<Properties>[\s\S]*?<Name>([^<]+)<\/Name>/i);
    if (nameM?.[1]?.trim()) {
      return nameM[1].trim();
    }
  } catch (err) {
    Logger.debug(`Could not read configuration label from ${configXmlPath}`, err);
  }
  return 'Configuration';
}

/**
 * Load attribute metadata rows for one object (reuses MetadataParser.loadElementChildren).
 */
async function loadAttributeRowsForElement(
  configPath: string,
  format: ConfigFormat,
  element: MetadataObject,
  currentRights: RightsMap
): Promise<MetadataObject[]> {
  const folder = folderNameForMetadataType(element.type);
  if (!folder) {
    return [];
  }

  const rootStub: TreeNode = {
    id: 'root',
    name: 'root',
    type: MetadataType.Configuration,
    properties: {},
  };

  const typeFolderNode: TreeNode = {
    id: folder,
    name: folder,
    type: element.type,
    properties: { type: folder },
    parent: rootStub,
  };

  const objectNode: TreeNode = {
    id: `${folder}.${element.name}`,
    name: element.name,
    type: element.type,
    properties: { type: folder },
    parent: typeFolderNode,
  };

  const attributesSection: TreeNode = {
    id: 'Attributes',
    name: 'Attributes',
    type: MetadataType.Attribute,
    properties: {},
    parent: objectNode,
  };

  try {
    const attrNodes = await MetadataParser.loadElementChildren(configPath, format, attributesSection);
    const parentLabel = `${element.displayName || element.name} (${element.type})`;
    const rows: MetadataObject[] = [];
    for (const attr of attrNodes) {
      const fullName = `${element.type}.${element.name}.Attribute.${attr.name}`;
      rows.push({
        fullName,
        type: MetadataType.Attribute,
        name: attr.name,
        displayName: attr.name,
        hasRights: fullName in currentRights,
        rowKind: 'attribute',
        parentLabel,
      });
    }
    return rows;
  } catch (err) {
    Logger.debug(`Attribute rights rows skipped for ${element.fullName}`, err);
    return [];
  }
}

/**
 * Load all metadata objects from configuration
 * @param roleFilePath Path to the Role.xml file
 * @param currentRights Current rights map to determine which objects have rights
 * @param configPath Optional configuration path - if provided, skips the search for configuration root
 * @returns Array of metadata objects sorted by type then name
 * @throws Error if configuration path cannot be determined or metadata cannot be loaded
 */
export async function loadMetadataObjects(
  roleFilePath: string,
  currentRights: RightsMap = {},
  configPath?: string | null
): Promise<MetadataObject[]> {
  try {
    // Step 1: Use provided configPath or find configuration root from role file path
    const effectiveConfigPath = configPath ?? await findConfigurationPath(roleFilePath);
    
    if (!effectiveConfigPath) {
      throw new Error('Cannot determine configuration path from role file. Configuration structure not found.');
    }

    Logger.info('Loading metadata objects from configuration', effectiveConfigPath);

    const format = await FormatDetector.detect(effectiveConfigPath);

    // Step 2: Parse configuration structure
    const rootNode = await MetadataParser.parseStructureOnly(effectiveConfigPath);

    // Step 3: Extract metadata objects from tree
    const baseObjects: MetadataObject[] = [];

    if (rootNode.children) {
      for (const typeNode of rootNode.children) {
        // Only process types that can have rights assigned
        if (!RIGHTS_ASSIGNABLE_TYPES.includes(typeNode.type)) {
          continue;
        }

        // Load elements for this type
        const elements = await MetadataParser.parseTypeContents(effectiveConfigPath, typeNode.name, { format });

        for (const element of elements) {
          const metadataObject = createMetadataObject(element, currentRights);
          metadataObject.rowKind = 'object';
          baseObjects.push(metadataObject);
        }
      }
    }

    const attributeRows = (
      await Promise.all(
        baseObjects
          .filter((o) => OBJECT_TYPES_FOR_ATTRIBUTE_RIGHTS.includes(o.type))
          .map((el) => loadAttributeRowsForElement(effectiveConfigPath, format, el, currentRights))
      )
    ).flat();

    const configDisplayName = await readConfigurationRootDisplayName(effectiveConfigPath);
    const configurationRow: MetadataObject = {
      fullName: CONFIGURATION_RIGHTS_FULL_NAME,
      type: MetadataType.Configuration,
      name: 'Configuration',
      displayName: `${configDisplayName} (root)`,
      hasRights: CONFIGURATION_RIGHTS_FULL_NAME in currentRights,
      rowKind: 'configurationRoot',
    };

    const metadataObjects: MetadataObject[] = [configurationRow, ...baseObjects, ...attributeRows];

    // Step 4: Sort — configuration first, then main objects, then attributes; then type/name
    metadataObjects.sort((a, b) => {
      const rank = (o: MetadataObject): number => {
        if (o.rowKind === 'configurationRoot') {return 0;}
        if (o.rowKind === 'attribute') {return 2;}
        return 1;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) {
        return ra - rb;
      }
      const typeComparison = a.type.localeCompare(b.type);
      if (typeComparison !== 0) {
        return typeComparison;
      }
      return a.name.localeCompare(b.name);
    });

    Logger.info(`Loaded ${metadataObjects.length} metadata objects`);
    return metadataObjects;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('Error loading metadata objects', error);
    throw new Error(`Failed to load metadata objects: ${errorMessage}`);
  }
}

/**
 * Find configuration root path from role file path
 * Walks up the directory tree looking for configuration markers
 * @param roleFilePath Path to Role.xml file
 * @returns Configuration root path or null if not found
 */
async function findConfigurationPath(roleFilePath: string): Promise<string | null> {
  try {
    // Role files are typically at: {configRoot}/Roles/{RoleName}/Role.xml (Designer)
    // or {configRoot}/Roles/{RoleName}.xml (EDT)
    
    let currentPath = path.dirname(roleFilePath);
    
    Logger.debug(`Finding configuration path from role file: ${roleFilePath}`);
    Logger.debug(`Starting search from: ${currentPath}`);
    
    // Normalize the role file path for comparison
    const normalizedRolePath = path.resolve(roleFilePath).toLowerCase();
    
    // Walk up the directory tree
    for (let i = 0; i < 10; i++) {
      Logger.debug(`Checking path level ${i}: ${currentPath}`);
      
      // Check if this is a valid configuration root
      if (await FormatDetector.isValidConfigurationPath(currentPath)) {
        // Check if the role file is inside this configuration
        const normalizedConfigPath = path.resolve(currentPath).toLowerCase();
        // Use path.sep for proper path comparison on Windows/Linux
        const configPathWithSep = normalizedConfigPath.endsWith(path.sep)
          ? normalizedConfigPath
          : normalizedConfigPath + path.sep;
        
        if (normalizedRolePath.startsWith(configPathWithSep)) {
          Logger.info(`Found configuration root at: ${currentPath}`);
          return currentPath;
        } else {
          Logger.debug(`Found configuration at ${currentPath}, but role file is not inside it`);
        }
      }
      
      // Move up one directory
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        // Reached filesystem root
        Logger.debug('Reached filesystem root, stopping search');
        break;
      }
      currentPath = parentPath;
    }

    // If not found by walking up, try using FormatDetector's workspace search
    // This handles cases where the role file might be in an unusual location
    Logger.debug('Trying workspace search as fallback');
    const workspacePath = path.dirname(path.dirname(path.dirname(roleFilePath)));
    const allConfigs = await FormatDetector.findAllConfigurationRoots([workspacePath]);
    
    // Find the first configuration that contains the role file
    for (const config of allConfigs) {
      const normalizedConfigPath = path.resolve(config.configPath).toLowerCase();
      const configPathWithSep = normalizedConfigPath.endsWith(path.sep)
        ? normalizedConfigPath
        : normalizedConfigPath + path.sep;
      
      if (normalizedRolePath.startsWith(configPathWithSep)) {
        Logger.info(`Found configuration root via workspace search: ${config.configPath}`);
        return config.configPath;
      } else {
        Logger.debug(`Found configuration at ${config.configPath}, but role file is not inside it`);
      }
    }
    
    Logger.warn('Could not find configuration root');
    return null;

  } catch (error) {
    Logger.error('Error finding configuration path', error);
    return null;
  }
}

/**
 * Create a MetadataObject from a TreeNode
 * @param node TreeNode representing a metadata element
 * @param currentRights Current rights map to check if object has rights
 * @returns MetadataObject instance
 */
function createMetadataObject(node: TreeNode, currentRights: RightsMap): MetadataObject {
  // Extract display name from properties (synonym)
  const synonym = node.properties?.synonym as string | undefined;
  const displayName = synonym || node.name;

  // Build full name in format: {Type}.{Name}
  const fullName = `${node.type}.${node.name}`;

  // Check if this object has rights in the current role
  const hasRights = fullName in currentRights;

  return {
    fullName,
    type: node.type,
    name: node.name,
    displayName,
    hasRights
  };
}

/**
 * Get configuration path from role file path (synchronous helper)
 * This is a simplified version for cases where async is not needed
 * @param roleFilePath Path to Role.xml file
 * @returns Estimated configuration root path
 */
export function getConfigurationPathSync(roleFilePath: string): string {
  // Assume standard structure: {configRoot}/Roles/{RoleName}/Role.xml
  // Go up 2-3 levels to reach config root
  let currentPath = path.dirname(roleFilePath);
  
  // If path ends with Role.xml, go up 2 levels (Designer format)
  if (path.basename(roleFilePath).toLowerCase() === 'role.xml') {
    currentPath = path.dirname(path.dirname(currentPath));
  } else {
    // EDT format: {configRoot}/Roles/{RoleName}.xml
    currentPath = path.dirname(currentPath);
  }
  
  return currentPath;
}
