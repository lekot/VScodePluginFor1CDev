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
