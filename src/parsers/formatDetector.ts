import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { DesignerParser } from './designerParser';
import { EdtParser } from './edtParser';

/**
 * Configuration format types
 */
export enum ConfigFormat {
  Designer = 'Designer',
  EDT = 'EDT',
  Unknown = 'Unknown',
}

/**
 * Detector for 1C configuration format
 */
export class FormatDetector {
  /**
   * Detect configuration format
   * @param configPath Path to configuration root directory
   * @returns Detected format
   */
  static async detect(configPath: string): Promise<ConfigFormat> {
    Logger.info('Detecting configuration format', configPath);

    try {
      // Check if path exists
      if (!fs.existsSync(configPath)) {
        Logger.warn(`Configuration path does not exist: ${configPath}`);
        return ConfigFormat.Unknown;
      }

      // Check for Designer format first (has 1cv8.cf or 1cv8.cfe)
      if (await DesignerParser.isDesignerFormat(configPath)) {
        Logger.info('Detected Designer format');
        return ConfigFormat.Designer;
      }

      // Check for EDT format (has Configuration.xml)
      if (await EdtParser.isEdtFormat(configPath)) {
        Logger.info('Detected EDT format');
        return ConfigFormat.EDT;
      }

      Logger.warn('Unknown configuration format');
      return ConfigFormat.Unknown;
    } catch (error) {
      Logger.error('Error detecting configuration format', error);
      return ConfigFormat.Unknown;
    }
  }

  /**
   * Get configuration root path from workspace
   * @param workspacePath Path to workspace
   * @returns Configuration root path or null
   */
  static findConfigurationRoot(workspacePath: string): string | null {
    try {
      // Look for 1cv8.cf or 1cv8.cfe in workspace
      const cfPath = path.join(workspacePath, '1cv8.cf');
      const cfePath = path.join(workspacePath, '1cv8.cfe');

      if (fs.existsSync(cfPath) || fs.existsSync(cfePath)) {
        return workspacePath;
      }

      // Look for Configuration.xml in workspace
      const configXmlPath = path.join(workspacePath, 'Configuration.xml');
      if (fs.existsSync(configXmlPath)) {
        return workspacePath;
      }

      // Search in subdirectories (one level deep)
      const items = fs.readdirSync(workspacePath);
      for (const item of items) {
        const itemPath = path.join(workspacePath, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
          const cfPath2 = path.join(itemPath, '1cv8.cf');
          const cfePath2 = path.join(itemPath, '1cv8.cfe');
          const configXmlPath2 = path.join(itemPath, 'Configuration.xml');

          if (fs.existsSync(cfPath2) || fs.existsSync(cfePath2) || fs.existsSync(configXmlPath2)) {
            return itemPath;
          }
        }
      }

      return null;
    } catch (error) {
      Logger.error('Error finding configuration root', error);
      return null;
    }
  }

  /**
   * Validate configuration path
   * @param configPath Path to validate
   * @returns true if valid configuration path
   */
  static isValidConfigurationPath(configPath: string): boolean {
    try {
      if (!fs.existsSync(configPath)) {
        return false;
      }

      const stat = fs.statSync(configPath);
      if (!stat.isDirectory()) {
        return false;
      }

      // Check for required files or directories
      const cfPath = path.join(configPath, '1cv8.cf');
      const cfePath = path.join(configPath, '1cv8.cfe');
      const configXmlPath = path.join(configPath, 'Configuration.xml');
      const configDumpPath = path.join(configPath, 'ConfigDumpInfo.xml');

      return (
        fs.existsSync(cfPath) ||
        fs.existsSync(cfePath) ||
        fs.existsSync(configXmlPath) ||
        fs.existsSync(configDumpPath)
      );
    } catch (error) {
      Logger.debug('Error validating configuration path', error);
      return false;
    }
  }
}
