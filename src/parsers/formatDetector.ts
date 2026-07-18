import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { DesignerParser } from './designerParser';
import { EdtParser } from './edtParser';
import {
  CONFIG_DUMP_INFO_XML,
  CONFIGURATION_PACKAGE_EXTENSIONS,
  CONFIGURATION_XML,
} from '../constants/fileNames';

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
const XML_CONFIG_ROOT_MARKERS = new Set([CONFIGURATION_XML, CONFIG_DUMP_INFO_XML]);
const NESTED_CONFIGURATION_CONTAINERS = [
  ['ConfigurationExtensions'],
  ['Extensions'],
  ['src', 'Extensions'],
] as const;

export type DiscoveryStatus = 'authoritative' | 'partial' | 'error';

export interface DiscoveryIssue {
  readonly path: string;
  readonly error: unknown;
}

export interface DiscoveryResult<T> {
  readonly status: DiscoveryStatus;
  readonly items: readonly T[];
  readonly issues: readonly DiscoveryIssue[];
}

export class ConfigurationDiscoveryError extends Error {
  constructor(
    readonly discoveryKind: 'configuration-roots' | 'configuration-packages',
    readonly result: DiscoveryResult<unknown>
  ) {
    super(
      `Configuration ${discoveryKind} discovery is ${result.status}: `
      + result.issues.map((issue) => issue.path).join(', ')
    );
    this.name = 'ConfigurationDiscoveryError';
  }
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

      // Prefer concrete EDT layout when a hybrid workspace also has Designer markers.
      if (await EdtParser.isEdtFormat(configPath)) {
        Logger.info('Detected EDT format');
        return ConfigFormat.EDT;
      }

      if (await DesignerParser.isDesignerFormat(configPath)) {
        Logger.info('Detected Designer format');
        return ConfigFormat.Designer;
      }

      Logger.warn('Unknown configuration format');
      return ConfigFormat.Unknown;
    } catch (error) {
      Logger.error('Error detecting configuration format', error);
      return ConfigFormat.Unknown;
    }
  }

  /** Check if the directory is a Designer XML root or a real EDT project root. */
  private static async isConfigurationRoot(
    dirPath: string,
    issues?: DiscoveryIssue[]
  ): Promise<boolean> {
    const entries = await this.readDirectoryEntries(dirPath, issues);
    return entries ? this.isConfigurationRootFromEntries(dirPath, entries, issues) : false;
  }

  private static async readDirectoryEntries(
    dirPath: string,
    issues?: DiscoveryIssue[],
    missingIsIssue = true
  ): Promise<fs.Dirent[] | null> {
    try {
      return await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      Logger.debug(`Error reading directory ${dirPath}`, error);
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (missingIsIssue || errorCode !== 'ENOENT') {
        issues?.push({ path: dirPath, error });
      }
      return null;
    }
  }

  private static hasConfigurationRootMarkers(entries: readonly fs.Dirent[]): boolean {
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    return [...XML_CONFIG_ROOT_MARKERS].some((marker) => names.has(marker));
  }

  private static async isConfigurationRootFromEntries(
    dirPath: string,
    entries: readonly fs.Dirent[],
    issues?: DiscoveryIssue[]
  ): Promise<boolean> {
    if (this.hasConfigurationRootMarkers(entries)) {
      return true;
    }
    if (!entries.some((entry) => entry.isDirectory() && entry.name === 'src')) {
      return false;
    }
    const descriptorPath = path.join(dirPath, 'src', 'Configuration', 'Configuration.mdo');
    try {
      return (await fs.promises.stat(descriptorPath)).isFile();
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== 'ENOENT' && errorCode !== 'ENOTDIR') {
        issues?.push({ path: descriptorPath, error });
      }
      return false;
    }
  }

  private static isConfigurationPackageFile(entry: fs.Dirent): boolean {
    return entry.isFile() && CONFIGURATION_PACKAGE_EXTENSIONS.includes(
      path.extname(entry.name).toLowerCase() as typeof CONFIGURATION_PACKAGE_EXTENSIONS[number]
    );
  }

  private static getCandidateChildDirectories(dirPath: string, entries: readonly fs.Dirent[]): string[] {
    return entries
      .filter((entry) => entry.isDirectory() && !SKIPPED_DISCOVERY_DIRS.has(entry.name))
      .map((entry) => path.join(dirPath, entry.name));
  }

  private static async findNestedKnownConfigurationRoots(
    configRootPath: string,
    issues?: DiscoveryIssue[]
  ): Promise<string[]> {
    const found: string[] = [];
    for (const containerSegments of NESTED_CONFIGURATION_CONTAINERS) {
      const containerPath = path.join(configRootPath, ...containerSegments);
      const entries = await this.readDirectoryEntries(containerPath, issues, false);
      if (!entries) {
        continue;
      }
      for (const childPath of this.getCandidateChildDirectories(containerPath, entries)) {
        const childEntries = await this.readDirectoryEntries(childPath, issues);
        if (childEntries && await this.isConfigurationRootFromEntries(childPath, childEntries, issues)) {
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
  static async discoverAllConfigurationRoots(
    workspacePaths: string[]
  ): Promise<DiscoveryResult<{ configPath: string; workspaceFolderPath: string }>> {
    const seen = new Set<string>();
    const result: Array<{ configPath: string; workspaceFolderPath: string }> = [];
    const issues: DiscoveryIssue[] = [];
    const normalize = (p: string) => path.normalize(p);

    for (const workspacePath of workspacePaths) {
      try {
        if (await this.isConfigurationRoot(workspacePath, issues)) {
          const n = normalize(workspacePath);
          if (!seen.has(n)) {
            seen.add(n);
            result.push({ configPath: workspacePath, workspaceFolderPath: workspacePath });
          }
          const nested = await this.findNestedKnownConfigurationRoots(workspacePath, issues);
          for (const configPath of nested) {
            const n = normalize(configPath);
            if (!seen.has(n)) {
              seen.add(n);
              result.push({ configPath, workspaceFolderPath: workspacePath });
            }
          }
          continue;
        }
        const inSubdirs = await this.searchAllConfigurationsRecursive(workspacePath, 0, 5, undefined, issues);
        for (const configPath of inSubdirs) {
          const n = normalize(configPath);
          if (!seen.has(n)) {
            seen.add(n);
            result.push({ configPath, workspaceFolderPath: workspacePath });
          }
        }
      } catch (error) {
        Logger.debug(`Error scanning workspace folder ${workspacePath}`, error);
        issues.push({ path: workspacePath, error });
      }
    }
    return this.createDiscoveryResult(result, issues);
  }

  static async findAllConfigurationRoots(
    workspacePaths: string[]
  ): Promise<Array<{ configPath: string; workspaceFolderPath: string }>> {
    const discovery = await this.discoverAllConfigurationRoots(workspacePaths);
    if (discovery.status !== 'authoritative') {
      throw new ConfigurationDiscoveryError('configuration-roots', discovery);
    }
    return [...discovery.items];
  }

  /**
   * Find all binary configuration package files (.cf/.cfe) outside XML configuration roots.
   * @param workspacePaths Array of workspace folder paths
   * @returns Pairs of package file path and the workspace folder it was found under
   */
  static async discoverAllConfigurationPackageFiles(
    workspacePaths: string[]
  ): Promise<DiscoveryResult<{ filePath: string; workspaceFolderPath: string }>> {
    const seen = new Set<string>();
    const result: Array<{ filePath: string; workspaceFolderPath: string }> = [];
    const issues: DiscoveryIssue[] = [];
    const normalize = (p: string) => path.normalize(p);

    for (const workspacePath of workspacePaths) {
      try {
        const files = await this.searchConfigurationPackagesRecursive(workspacePath, 0, 5, undefined, issues);
        for (const filePath of files) {
          const n = normalize(filePath);
          if (!seen.has(n)) {
            seen.add(n);
            result.push({ filePath, workspaceFolderPath: workspacePath });
          }
        }
      } catch (error) {
        Logger.debug(`Error scanning workspace folder for packages ${workspacePath}`, error);
        issues.push({ path: workspacePath, error });
      }
    }
    return this.createDiscoveryResult(result, issues);
  }

  static async findAllConfigurationPackageFiles(
    workspacePaths: string[]
  ): Promise<Array<{ filePath: string; workspaceFolderPath: string }>> {
    const discovery = await this.discoverAllConfigurationPackageFiles(workspacePaths);
    if (discovery.status !== 'authoritative') {
      throw new ConfigurationDiscoveryError('configuration-packages', discovery);
    }
    return [...discovery.items];
  }

  private static createDiscoveryResult<T>(
    items: readonly T[],
    issues: readonly DiscoveryIssue[]
  ): DiscoveryResult<T> {
    const status: DiscoveryStatus = issues.length === 0
      ? 'authoritative'
      : items.length === 0 ? 'error' : 'partial';
    return { status, items, issues };
  }

  /**
   * Recursively collect all configuration root paths under dirPath (does not check dirPath itself).
   */
  private static async searchAllConfigurationsRecursive(
    dirPath: string,
    currentDepth: number,
    maxDepth: number,
    knownEntries?: fs.Dirent[],
    issues?: DiscoveryIssue[]
  ): Promise<string[]> {
    if (currentDepth >= maxDepth) {return [];}
    const found: string[] = [];
    const entries = knownEntries ?? await this.readDirectoryEntries(dirPath, issues);
    if (!entries) {
      return found;
    }

    const nonRootChildren: Array<{ itemPath: string; entries: fs.Dirent[] }> = [];
    for (const itemPath of this.getCandidateChildDirectories(dirPath, entries)) {
      const childEntries = await this.readDirectoryEntries(itemPath, issues);
      if (!childEntries) {
        continue;
      }
      if (await this.isConfigurationRootFromEntries(itemPath, childEntries, issues)) {
        found.push(itemPath);
        Logger.info(`Found configuration at depth ${currentDepth + 1}: ${itemPath}`);
        found.push(...await this.findNestedKnownConfigurationRoots(itemPath, issues));
        continue;
      }
      nonRootChildren.push({ itemPath, entries: childEntries });
    }

    for (const child of nonRootChildren) {
      const sub = await this.searchAllConfigurationsRecursive(
        child.itemPath,
        currentDepth + 1,
        maxDepth,
        child.entries,
        issues
      );
      found.push(...sub);
    }
    return found;
  }

  /**
   * Recursively collect binary package files under dirPath, pruning XML configuration roots.
   */
  private static async searchConfigurationPackagesRecursive(
    dirPath: string,
    currentDepth: number,
    maxDepth: number,
    knownEntries?: fs.Dirent[],
    issues?: DiscoveryIssue[]
  ): Promise<string[]> {
    if (currentDepth > maxDepth) {return [];}
    const found: string[] = [];
    const entries = knownEntries ?? await this.readDirectoryEntries(dirPath, issues);
    if (!entries) {
      return found;
    }

    if (await this.isConfigurationRootFromEntries(dirPath, entries, issues)) {
      return found;
    }

    for (const entry of entries) {
      if (this.isConfigurationPackageFile(entry)) {
        found.push(path.join(dirPath, entry.name));
      }
    }

    if (currentDepth >= maxDepth) {
      return found;
    }

    for (const itemPath of this.getCandidateChildDirectories(dirPath, entries)) {
      const childEntries = await this.readDirectoryEntries(itemPath, issues);
      if (!childEntries || await this.isConfigurationRootFromEntries(itemPath, childEntries, issues)) {
        continue;
      }
      const sub = await this.searchConfigurationPackagesRecursive(
        itemPath,
        currentDepth + 1,
        maxDepth,
        childEntries,
        issues
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
      if (await this.isConfigurationRootFromEntries(itemPath, childEntries)) {
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

      return await this.isConfigurationRoot(configPath);
    } catch (error) {
      Logger.debug('Error validating configuration path', error);
      return false;
    }
  }
}
