import { TreeNode } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { DesignerParser } from './designerParser';
import { EdtParser } from './edtParser';
import { FormatDetector, ConfigFormat } from './formatDetector';

/**
 * Main metadata parser that handles both EDT and Designer formats
 */
export class MetadataParser {
  /**
   * Build only root and type nodes without loading element contents (for lazy loading).
   * @param configPath Path to configuration root directory
   * @returns Root tree node with type nodes that have empty children
   */
  static async parseStructureOnly(configPath: string): Promise<TreeNode> {
    if (!(await FormatDetector.isValidConfigurationPath(configPath))) {
      throw new Error(`Invalid configuration path: ${configPath}`);
    }
    const format = await FormatDetector.detect(configPath);
    if (format === ConfigFormat.Unknown) {
      throw new Error(`Unknown configuration format at ${configPath}`);
    }
    if (format === ConfigFormat.Designer) {
      return await DesignerParser.parseStructureOnly(configPath);
    }
    return await EdtParser.parseStructureOnly(configPath);
  }

  /**
   * Load element nodes for a single metadata type (e.g. Catalogs).
   * @param configPath Path to configuration root directory
   * @param typeName Type directory name (e.g. Catalogs)
   * @returns Array of element tree nodes for this type
   */
  static async parseTypeContents(configPath: string, typeName: string): Promise<TreeNode[]> {
    const format = await FormatDetector.detect(configPath);
    if (format === ConfigFormat.Designer) {
      return await DesignerParser.parseTypeContents(configPath, typeName);
    }
    if (format === ConfigFormat.EDT) {
      return await EdtParser.parseTypeContents(configPath, typeName);
    }
    return [];
  }

  /**
   * Load direct children (Attributes, Forms, Ext, etc.) for a metadata element.
   * Used when expanding an element that was loaded in shallow (lazy) mode.
   */
  static async loadElementChildren(
    configPath: string,
    format: ConfigFormat,
    element: TreeNode
  ): Promise<TreeNode[]> {
    const id = element.id;
    const dot = id.indexOf('.');
    const typeName = dot >= 0 ? id.slice(0, dot) : id;
    const elementName = dot >= 0 ? id.slice(dot + 1) : element.name;
    if (format === ConfigFormat.Designer) {
      return await DesignerParser.loadChildrenForElement(configPath, typeName, elementName);
    }
    if (format === ConfigFormat.EDT) {
      return await EdtParser.loadChildrenForElement(configPath, typeName, elementName);
    }
    return [];
  }

  /**
   * Parse configuration metadata
   * @param configPath Path to configuration root directory
   * @returns Root tree node
   */
  static async parse(configPath: string): Promise<TreeNode> {
    Logger.info('Starting metadata parsing', configPath);

    try {
      // Validate configuration path
      if (!(await FormatDetector.isValidConfigurationPath(configPath))) {
        throw new Error(`Invalid configuration path: ${configPath}`);
      }

      // Detect format
      const format = await FormatDetector.detect(configPath);

      if (format === ConfigFormat.Unknown) {
        throw new Error(`Unknown configuration format at ${configPath}`);
      }

      // Parse based on format
      let rootNode: TreeNode;

      if (format === ConfigFormat.Designer) {
        rootNode = await DesignerParser.parse(configPath);
      } else if (format === ConfigFormat.EDT) {
        rootNode = await EdtParser.parse(configPath);
      } else {
        throw new Error(`Unsupported configuration format: ${format}`);
      }

      Logger.info('Metadata parsing completed successfully');
      return rootNode;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error('Error parsing metadata', error);
      throw new Error(`Failed to parse metadata: ${errorMessage}`);
    }
  }

  /**
   * Parse configuration from workspace
   * @param workspacePath Path to workspace
   * @returns Root tree node or null if configuration not found
   */
  static async parseFromWorkspace(workspacePath: string): Promise<TreeNode | null> {
    try {
      const configPath = await FormatDetector.findConfigurationRoot(workspacePath);

      if (!configPath) {
        Logger.warn('Configuration not found in workspace', workspacePath);
        return null;
      }

      return await this.parse(configPath);
    } catch (error) {
      Logger.error('Error parsing configuration from workspace', error);
      return null;
    }
  }

  /**
   * Get detected format for configuration
   * @param configPath Path to configuration
   * @returns Detected format
   */
  static async getFormat(configPath: string): Promise<ConfigFormat> {
    return FormatDetector.detect(configPath);
  }

  /**
   * Find configuration root in workspace
   * @param workspacePath Path to workspace
   * @returns Configuration root path or null
   */
  static async findConfigurationRoot(workspacePath: string): Promise<string | null> {
    return FormatDetector.findConfigurationRoot(workspacePath);
  }
}
