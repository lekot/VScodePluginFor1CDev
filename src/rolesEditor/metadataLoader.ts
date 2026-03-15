/**
 * Metadata loader utility for the Roles and Rights Editor
 * Loads all metadata objects from configuration and prepares them for rights assignment
 */

import * as path from 'path';
import { MetadataParser } from '../parsers/metadataParser';
import { FormatDetector } from '../parsers/formatDetector';
import { TreeNode, MetadataType } from '../models/treeNode';
import { MetadataObject } from './models/metadataObject';
import { RightsMap } from './models/roleModel';
import { Logger } from '../utils/logger';

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
  MetadataType.EventSubscription,
  MetadataType.CommonModule,
  MetadataType.CommandGroup,
  MetadataType.Command,
  MetadataType.Role,
  MetadataType.Interface,
  MetadataType.Style,
  MetadataType.WebService,
  MetadataType.HTTPService,
  MetadataType.IntegrationService,
  MetadataType.Subsystem
];

/**
 * Load all metadata objects from configuration
 * @param roleFilePath Path to the Role.xml file
 * @param currentRights Current rights map to determine which objects have rights
 * @returns Array of metadata objects sorted by type then name
 * @throws Error if configuration path cannot be determined or metadata cannot be loaded
 */
export async function loadMetadataObjects(
  roleFilePath: string,
  currentRights: RightsMap = {}
): Promise<MetadataObject[]> {
  try {
    // Step 1: Find configuration root from role file path
    const configPath = await findConfigurationPath(roleFilePath);
    
    if (!configPath) {
      throw new Error('Cannot determine configuration path from role file. Configuration structure not found.');
    }

    Logger.info('Loading metadata objects from configuration', configPath);

    // Step 2: Parse configuration structure
    const rootNode = await MetadataParser.parseStructureOnly(configPath);

    // Step 3: Extract metadata objects from tree
    const metadataObjects: MetadataObject[] = [];

    if (rootNode.children) {
      for (const typeNode of rootNode.children) {
        // Only process types that can have rights assigned
        if (!RIGHTS_ASSIGNABLE_TYPES.includes(typeNode.type)) {
          continue;
        }

        // Load elements for this type
        const elements = await MetadataParser.parseTypeContents(configPath, typeNode.name);

        for (const element of elements) {
          const metadataObject = createMetadataObject(element, currentRights);
          metadataObjects.push(metadataObject);
        }
      }
    }

    // Step 4: Sort by type then name
    metadataObjects.sort((a, b) => {
      // First sort by type
      const typeComparison = a.type.localeCompare(b.type);
      if (typeComparison !== 0) {
        return typeComparison;
      }
      // Then sort by name
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
    
    // Walk up the directory tree
    for (let i = 0; i < 5; i++) {
      // Check if this is a valid configuration root
      if (await FormatDetector.isValidConfigurationPath(currentPath)) {
        return currentPath;
      }
      
      // Move up one directory
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        // Reached filesystem root
        break;
      }
      currentPath = parentPath;
    }

    // If not found by walking up, try using FormatDetector's workspace search
    // This handles cases where the role file might be in an unusual location
    const workspacePath = path.dirname(path.dirname(path.dirname(roleFilePath)));
    return await FormatDetector.findConfigurationRoot(workspacePath);

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
