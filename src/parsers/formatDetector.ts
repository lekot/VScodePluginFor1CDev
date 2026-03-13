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
      try {
        await fs.promises.access(configPath);
      } catch {
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
   * Check if the given directory path is a configuration root (has 1cv8.cf/1cv8.cfe/Configuration.xml and metadata dirs).
   */
  private static async isConfigurationRoot(dirPath: string): Promise<boolean> {
    const cfPath = path.join(dirPath, '1cv8.cf');
    const cfePath = path.join(dirPath, '1cv8.cfe');
    const configXmlPath = path.join(dirPath, 'Configuration.xml');
    try {
      await fs.promises.access(cfPath);
      return true;
    } catch {
      // continue
    }
    try {
      await fs.promises.access(cfePath);
      return true;
    } catch {
      // continue
    }
    try {
      await fs.promises.access(configXmlPath);
      const hasMetadata = await this.hasMetadataDirectories(dirPath);
      return hasMetadata;
    } catch {
      return false;
    }
  }

  /**
   * Get configuration root path from workspace (first found only).
   * @param workspacePath Path to workspace
   * @returns Configuration root path or null
   */
  static async findConfigurationRoot(workspacePath: string): Promise<string | null> {
    try {
      if (await this.isConfigurationRoot(workspacePath)) {
        return workspacePath;
      }
      const found = await this.searchConfigurationRecursive(workspacePath, 0, 5);
      return found;
    } catch (error) {
      Logger.error('Error finding configuration root', error);
      return null;
    }
  }

  /**
   * Find all configuration roots in the given workspace folder paths.
   * Each folder is scanned (including recursive subdirs); same config path appears only once.
   * @param workspacePaths Array of workspace folder paths
   * @returns Pairs of config root path and the workspace folder it was found under
   */
  static async findAllConfigurationRoots(
    workspacePaths: string[]
  ): Promise<Array<{ configPath: string; workspaceFolderPath: string }>> {
    const seen = new Set<string>();
    const result: Array<{ configPath: string; workspaceFolderPath: string }> = [];
    const normalize = (p: string) => path.normalize(p);

    for (const workspacePath of workspacePaths) {
      try {
        if (await this.isConfigurationRoot(workspacePath)) {
          const n = normalize(workspacePath);
          if (!seen.has(n)) {
            seen.add(n);
            result.push({ configPath: workspacePath, workspaceFolderPath: workspacePath });
          }
        }
        const inSubdirs = await this.searchAllConfigurationsRecursive(workspacePath, 0, 5);
        for (const configPath of inSubdirs) {
          const n = normalize(configPath);
          if (!seen.has(n)) {
            seen.add(n);
            result.push({ configPath, workspaceFolderPath: workspacePath });
          }
        }
      } catch (error) {
        Logger.debug(`Error scanning workspace folder ${workspacePath}`, error);
      }
    }
    return result;
  }

  /**
   * Recursively collect all configuration root paths under dirPath (does not check dirPath itself).
   */
  private static async searchAllConfigurationsRecursive(
    dirPath: string,
    currentDepth: number,
    maxDepth: number
  ): Promise<string[]> {
    if (currentDepth >= maxDepth) return [];
    const found: string[] = [];
    try {
      const items = await fs.promises.readdir(dirPath);
      for (const item of items) {
        if (item === 'node_modules' || item === '.git' || item === '.vscode' || item === 'dist' || item === 'out') {
          continue;
        }
        const itemPath = path.join(dirPath, item);
        try {
          const stat = await fs.promises.stat(itemPath);
          if (!stat.isDirectory()) continue;
          if (await this.isConfigurationRoot(itemPath)) {
            found.push(itemPath);
            Logger.info(`Found configuration at depth ${currentDepth + 1}: ${itemPath}`);
          }
          const sub = await this.searchAllConfigurationsRecursive(itemPath, currentDepth + 1, maxDepth);
          found.push(...sub);
        } catch (error) {
          Logger.debug(`Error checking subdirectory ${itemPath}`, error);
        }
      }
    } catch (error) {
      Logger.debug(`Error reading directory ${dirPath}`, error);
    }
    return found;
  }

  /**
   * Recursively search for configuration in subdirectories
   * @param dirPath Directory to search
   * @param currentDepth Current recursion depth
   * @param maxDepth Maximum recursion depth
   * @returns Configuration path or null
   */
  private static async searchConfigurationRecursive(
    dirPath: string,
    currentDepth: number,
    maxDepth: number
  ): Promise<string | null> {
    if (currentDepth >= maxDepth) {
      return null;
    }

    try {
      const items = await fs.promises.readdir(dirPath);

      for (const item of items) {
        // Skip common non-config directories
        if (item === 'node_modules' || item === '.git' || item === '.vscode' || item === 'dist' || item === 'out') {
          continue;
        }

        const itemPath = path.join(dirPath, item);
        try {
          const stat = await fs.promises.stat(itemPath);

          if (stat.isDirectory()) {
            // Check if this directory is a configuration root
            const cfPath = path.join(itemPath, '1cv8.cf');
            const cfePath = path.join(itemPath, '1cv8.cfe');
            const configXmlPath = path.join(itemPath, 'Configuration.xml');

            // Check all paths in parallel
            const checks = await Promise.allSettled([
              fs.promises.access(cfPath),
              fs.promises.access(cfePath),
              fs.promises.access(configXmlPath),
            ]);

            if (checks.some(result => result.status === 'fulfilled')) {
              // Also verify metadata directories exist
              const hasMetadata = await this.hasMetadataDirectories(itemPath);
              if (hasMetadata) {
                Logger.info(`Found configuration at depth ${currentDepth + 1}: ${itemPath}`);
                return itemPath;
              }
            }

            // Recursively search in this subdirectory
            const found = await this.searchConfigurationRecursive(itemPath, currentDepth + 1, maxDepth);
            if (found) {
              return found;
            }
          }
        } catch (error) {
          Logger.debug(`Error checking subdirectory ${itemPath}`, error);
        }
      }

      return null;
    } catch (error) {
      Logger.debug(`Error reading directory ${dirPath}`, error);
      return null;
    }
  }

  /**
   * Check if directory has metadata type directories
   * @param dirPath Directory to check
   * @returns true if has at least one metadata directory
   */
  private static async hasMetadataDirectories(dirPath: string): Promise<boolean> {
    const metadataTypes = ['Catalogs', 'Documents', 'Enums', 'Reports', 'DataProcessors', 'CommonModules'];
    
    for (const type of metadataTypes) {
      const typePath = path.join(dirPath, type);
      try {
        await fs.promises.access(typePath);
        const stat = await fs.promises.stat(typePath);
        if (stat.isDirectory()) {
          return true;
        }
      } catch {
        // Continue checking
      }
    }
    
    return false;
  }

  /**
   * Validate configuration path
   * @param configPath Path to validate
   * @returns true if valid configuration path
   */
  static async isValidConfigurationPath(configPath: string): Promise<boolean> {
    try {
      // Check if path exists
      try {
        await fs.promises.access(configPath);
      } catch {
        return false;
      }

      const stat = await fs.promises.stat(configPath);
      if (!stat.isDirectory()) {
        return false;
      }

      // Check for required files or directories
      const cfPath = path.join(configPath, '1cv8.cf');
      const cfePath = path.join(configPath, '1cv8.cfe');
      const configXmlPath = path.join(configPath, 'Configuration.xml');
      const configDumpPath = path.join(configPath, 'ConfigDumpInfo.xml');

      // Check all paths in parallel
      const checks = await Promise.allSettled([
        fs.promises.access(cfPath),
        fs.promises.access(cfePath),
        fs.promises.access(configXmlPath),
        fs.promises.access(configDumpPath),
      ]);

      return checks.some(result => result.status === 'fulfilled');
    } catch (error) {
      Logger.debug('Error validating configuration path', error);
      return false;
    }
  }
}
