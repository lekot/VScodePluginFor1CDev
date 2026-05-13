import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { DesignerParser } from './designerParser';
import { EdtParser } from './edtParser';
import { CONFIGURATION_XML } from '../constants/fileNames';

/**
 * Configuration format types
 */
/* eslint-disable @typescript-eslint/naming-convention -- values mirror 1C toolchain format names */
export enum ConfigFormat {
  Designer = 'Designer',
  EDT = 'EDT',
  Unknown = 'Unknown',
}
/* eslint-enable @typescript-eslint/naming-convention */

const SKIPPED_DISCOVERY_DIRS = new Set(['node_modules', '.git', '.vscode', 'dist', 'out']);
const CONFIG_ROOT_MARKERS = new Set(['1cv8.cf', '1cv8.cfe', CONFIGURATION_XML, 'ConfigDumpInfo.xml']);
const NESTED_CONFIGURATION_CONTAINERS = [
  ['ConfigurationExtensions'],
  ['Extensions'],
  ['src', 'Extensions'],
] as const;

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
   * Check if the given directory path is a configuration root (has 1cv8.cf, 1cv8.cfe, or valid Configuration.xml).
   */
  private static async isConfigurationRoot(dirPath: string): Promise<boolean> {
    const entries = await this.readDirectoryEntries(dirPath);
    return entries ? this.hasConfigurationRootMarkers(entries) : false;
  }

  private static async readDirectoryEntries(dirPath: string): Promise<fs.Dirent[] | null> {
    try {
      return await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      Logger.debug(`Error reading directory ${dirPath}`, error);
      return null;
    }
  }

  private static hasConfigurationRootMarkers(entries: readonly fs.Dirent[]): boolean {
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    return [...CONFIG_ROOT_MARKERS].some((marker) => names.has(marker));
  }

  private static getCandidateChildDirectories(dirPath: string, entries: readonly fs.Dirent[]): string[] {
    return entries
      .filter((entry) => entry.isDirectory() && !SKIPPED_DISCOVERY_DIRS.has(entry.name))
      .map((entry) => path.join(dirPath, entry.name));
  }

  private static async findNestedKnownConfigurationRoots(configRootPath: string): Promise<string[]> {
    const found: string[] = [];
    for (const containerSegments of NESTED_CONFIGURATION_CONTAINERS) {
      const containerPath = path.join(configRootPath, ...containerSegments);
      const entries = await this.readDirectoryEntries(containerPath);
      if (!entries) {
        continue;
      }
      for (const childPath of this.getCandidateChildDirectories(containerPath, entries)) {
        const childEntries = await this.readDirectoryEntries(childPath);
        if (childEntries && this.hasConfigurationRootMarkers(childEntries)) {
          found.push(childPath);
        }
      }
    }
    return found;
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
          const nested = await this.findNestedKnownConfigurationRoots(workspacePath);
          for (const configPath of nested) {
            const n = normalize(configPath);
            if (!seen.has(n)) {
              seen.add(n);
              result.push({ configPath, workspaceFolderPath: workspacePath });
            }
          }
          continue;
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
    maxDepth: number,
    knownEntries?: fs.Dirent[]
  ): Promise<string[]> {
    if (currentDepth >= maxDepth) {return [];}
    const found: string[] = [];
    const entries = knownEntries ?? await this.readDirectoryEntries(dirPath);
    if (!entries) {
      return found;
    }

    const nonRootChildren: Array<{ itemPath: string; entries: fs.Dirent[] }> = [];
    for (const itemPath of this.getCandidateChildDirectories(dirPath, entries)) {
      const childEntries = await this.readDirectoryEntries(itemPath);
      if (!childEntries) {
        continue;
      }
      if (this.hasConfigurationRootMarkers(childEntries)) {
        found.push(itemPath);
        Logger.info(`Found configuration at depth ${currentDepth + 1}: ${itemPath}`);
        found.push(...await this.findNestedKnownConfigurationRoots(itemPath));
        continue;
      }
      nonRootChildren.push({ itemPath, entries: childEntries });
    }

    for (const child of nonRootChildren) {
      const sub = await this.searchAllConfigurationsRecursive(
        child.itemPath,
        currentDepth + 1,
        maxDepth,
        child.entries
      );
      found.push(...sub);
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
    maxDepth: number,
    knownEntries?: fs.Dirent[]
  ): Promise<string | null> {
    if (currentDepth >= maxDepth) {
      return null;
    }

    const entries = knownEntries ?? await this.readDirectoryEntries(dirPath);
    if (!entries) {
      return null;
    }

    const nonRootChildren: Array<{ itemPath: string; entries: fs.Dirent[] }> = [];
    for (const itemPath of this.getCandidateChildDirectories(dirPath, entries)) {
      const childEntries = await this.readDirectoryEntries(itemPath);
      if (!childEntries) {
        continue;
      }
      if (this.hasConfigurationRootMarkers(childEntries)) {
        Logger.info(`Found configuration at depth ${currentDepth + 1}: ${itemPath}`);
        return itemPath;
      }
      nonRootChildren.push({ itemPath, entries: childEntries });
    }

    for (const child of nonRootChildren) {
      const found = await this.searchConfigurationRecursive(
        child.itemPath,
        currentDepth + 1,
        maxDepth,
        child.entries
      );
      if (found) {
        return found;
      }
    }
    return null;
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
      const configXmlPath = path.join(configPath, CONFIGURATION_XML);
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
