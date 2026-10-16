import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { DesignerParser } from './designerParser';
import { EdtParser } from './edtParser';
import { FormatDetector, ConfigFormat } from './formatDetector';
import {
  clearTypeContentsCache,
  computeTypeContentsSignature,
  invalidateTypeContentsCache,
  loadTypeContentsFromCache,
  saveTypeContentsToCache,
} from '../utils/typeContentsCache';
import {
  ensureTabularSectionColumnsPlaceholder,
  isTabularSectionColumnsContainer,
} from '../utils/treeNormalization';
import { configurationPathKey, filesystemPathKey } from '../utils/configurationPathIdentity';

const R6_SECTION_IDS = new Set(['Attributes', 'TabularSections', 'Forms', 'Commands', 'Templates', 'Dimensions', 'Resources', 'EnumValues', 'PredefinedData']);
/** Types with R6 placeholder children (Forms, Attributes, etc.) — must match treeNormalization.ts R6_OBJECT_TYPES. */
const R6_OBJECT_TYPES = new Set<MetadataType>([
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.DataProcessor,
  MetadataType.Report,
  MetadataType.BusinessProcess,
  MetadataType.Task,
  MetadataType.ExchangePlan,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfCalculationTypes,
  MetadataType.InformationRegister,
  MetadataType.AccumulationRegister,
  MetadataType.AccountingRegister,
  MetadataType.CalculationRegister,
  MetadataType.Sequence,
  MetadataType.ChartOfAccounts,
  MetadataType.FilterCriterion,
  MetadataType.DocumentJournal,
  MetadataType.SettingsStorage,
  MetadataType.Enum,
]);

interface TypeContentsCacheEpochToken {
  readonly storagePath: string | null;
  readonly storageIdentity: string | null;
  readonly globalEpoch: number;
  readonly configPathKey: string;
  readonly configEpoch: number;
}

/**
 * Main metadata parser that handles both EDT and Designer formats
 */
export class MetadataParser {
  private static typeContentsCacheStoragePath: string | null = null;
  private static typeContentsCacheStorageIdentity: string | null = null;
  private static typeContentsCacheGlobalEpoch = 0;
  private static readonly typeContentsCacheConfigEpochs = new Map<string, number>();
  /** Serializes short cache filesystem operations; signatures and parsing must stay outside this queue. */
  private static diskCacheOperationQueue: Promise<void> = Promise.resolve();
  private static readonly inFlightTypeContents = new Map<string, Promise<TreeNode[]>>();
  private static readonly inFlightTypeIndex = new Map<string, Promise<TreeNode[]>>();

  static setTypeContentsCacheStoragePath(storagePath: string | null): void {
    const nextStoragePath = storagePath && storagePath.trim() ? storagePath : null;
    const nextStorageIdentity = nextStoragePath ? filesystemPathKey(nextStoragePath) : null;
    if (nextStorageIdentity !== this.typeContentsCacheStorageIdentity) {
      this.typeContentsCacheGlobalEpoch += 1;
    }
    this.typeContentsCacheStoragePath = nextStoragePath;
    this.typeContentsCacheStorageIdentity = nextStorageIdentity;
  }

  static async invalidateTypeContentsCache(configPath: string): Promise<void> {
    const configPathKey = configurationPathKey(configPath);
    this.advanceConfigEpoch(configPathKey);

    const storagePath = this.typeContentsCacheStoragePath;
    if (!storagePath) {
      return;
    }
    await this.enqueueDiskCacheOperation(async () => {
      await invalidateTypeContentsCache(storagePath, configPath);
    });
  }

  static async clearTypeContentsCache(): Promise<void> {
    this.typeContentsCacheGlobalEpoch += 1;

    const storagePath = this.typeContentsCacheStoragePath;
    if (!storagePath) {
      return;
    }
    await this.enqueueDiskCacheOperation(async () => {
      await clearTypeContentsCache(storagePath);
    });
  }

  private static advanceConfigEpoch(configPathKey: string): void {
    const currentEpoch = this.typeContentsCacheConfigEpochs.get(configPathKey) ?? 0;
    this.typeContentsCacheConfigEpochs.set(configPathKey, currentEpoch + 1);
  }

  private static captureTypeContentsCacheEpoch(configPath: string): TypeContentsCacheEpochToken {
    const configPathKey = configurationPathKey(configPath);
    return Object.freeze({
      storagePath: this.typeContentsCacheStoragePath,
      storageIdentity: this.typeContentsCacheStorageIdentity,
      globalEpoch: this.typeContentsCacheGlobalEpoch,
      configPathKey,
      configEpoch: this.typeContentsCacheConfigEpochs.get(configPathKey) ?? 0,
    });
  }

  private static isTypeContentsCacheEpochCurrent(token: TypeContentsCacheEpochToken): boolean {
    return token.globalEpoch === this.typeContentsCacheGlobalEpoch &&
      token.storageIdentity === this.typeContentsCacheStorageIdentity &&
      token.configEpoch === (this.typeContentsCacheConfigEpochs.get(token.configPathKey) ?? 0);
  }

  private static getTypeContentsCacheEpochInFlightKey(
    configPath: string,
    typeName: string,
    format: ConfigFormat,
    token: TypeContentsCacheEpochToken,
  ): string {
    return JSON.stringify([
      this.getTypeContentsInFlightKey(configPath, typeName, format),
      token.storageIdentity,
      token.globalEpoch,
      token.configEpoch,
    ]);
  }

  private static enqueueDiskCacheOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.diskCacheOperationQueue.then(operation);
    this.diskCacheOperationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private static getTypePath(configPath: string, typeName: string, format: ConfigFormat): string | null {
    if (format === ConfigFormat.Designer) {
      return path.join(configPath, typeName);
    }
    if (format === ConfigFormat.EDT) {
      return path.join(configPath, 'src', typeName);
    }
    return null;
  }

  private static getTypeContentsInFlightKey(
    configPath: string,
    typeName: string,
    format: ConfigFormat,
    platform?: NodeJS.Platform,
  ): string {
    return `${format}:${configurationPathKey(configPath, platform)}:${typeName}`;
  }

  private static async parseTypeContentsUncached(
    configPath: string,
    typeName: string,
    format: ConfigFormat
  ): Promise<TreeNode[]> {
    if (format === ConfigFormat.Designer) {
      return await DesignerParser.parseTypeContents(configPath, typeName);
    }
    if (format === ConfigFormat.EDT) {
      return await EdtParser.parseTypeContents(configPath, typeName);
    }
    return [];
  }

  private static async parseTypeIndexUncached(
    configPath: string,
    typeName: string,
    format: ConfigFormat
  ): Promise<TreeNode[]> {
    if (format === ConfigFormat.Designer) {
      return await DesignerParser.parseTypeIndex(configPath, typeName);
    }
    if (format === ConfigFormat.EDT) {
      return await EdtParser.parseTypeIndex(configPath, typeName);
    }
    return [];
  }

  private static cloneTreeNode(node: TreeNode, parent?: TreeNode): TreeNode {
    const clone: TreeNode = {
      id: node.id,
      name: node.name,
      type: node.type,
      properties: { ...node.properties },
      filePath: node.filePath,
      parentFilePath: node.parentFilePath,
      nestedPath: node.nestedPath?.map((segment) => ({ ...segment })),
      parent,
    };
    if (node.children) {
      clone.children = node.children.map((child) => this.cloneTreeNode(child, clone));
    }
    return clone;
  }

  private static cloneTreeNodes(nodes: readonly TreeNode[]): TreeNode[] {
    return nodes.map((node) => this.cloneTreeNode(node));
  }

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
  static async parseTypeContents(
    configPath: string,
    typeName: string,
    options?: { format?: ConfigFormat; bypassCache?: boolean }
  ): Promise<TreeNode[]> {
    // Capture before the first await so a delayed format detection cannot join a newer generation.
    const token = this.captureTypeContentsCacheEpoch(configPath);
    const format = options?.format ?? await FormatDetector.detect(configPath);
    if (options?.bypassCache === true) {
      return await this.parseTypeContentsUncached(configPath, typeName, format);
    }

    const inFlightKey = this.getTypeContentsCacheEpochInFlightKey(configPath, typeName, format, token);
    const existing = this.inFlightTypeContents.get(inFlightKey);
    if (existing) {
      return await existing;
    }

    const pending = (async () => {
      return await this.parseTypeContentsWithCache(configPath, typeName, format, token);
    })().finally(() => {
      if (this.inFlightTypeContents.get(inFlightKey) === pending) {
        this.inFlightTypeContents.delete(inFlightKey);
      }
    });

    this.inFlightTypeContents.set(inFlightKey, pending);
    return await pending;
  }

  /**
   * Load only direct object nodes for a metadata type without parsing every object XML.
   * This is the fast path for tree type-folder expansion and background warmup.
   */
  static async parseTypeIndex(
    configPath: string,
    typeName: string,
    options?: { format?: ConfigFormat; bypassCache?: boolean }
  ): Promise<TreeNode[]> {
    // Capture before the first await so a delayed format detection cannot join a newer generation.
    const token = this.captureTypeContentsCacheEpoch(configPath);
    const format = options?.format ?? await FormatDetector.detect(configPath);
    if (options?.bypassCache === true) {
      return this.cloneTreeNodes(await this.parseTypeIndexUncached(configPath, typeName, format));
    }

    const inFlightKey = this.getTypeContentsCacheEpochInFlightKey(configPath, typeName, format, token);
    const existing = this.inFlightTypeIndex.get(inFlightKey);
    if (existing) {
      return this.cloneTreeNodes(await existing);
    }

    const pending = (async () => {
      return await this.parseTypeIndexWithCache(configPath, typeName, format, token);
    })().finally(() => {
      if (this.inFlightTypeIndex.get(inFlightKey) === pending) {
        this.inFlightTypeIndex.delete(inFlightKey);
      }
    });

    this.inFlightTypeIndex.set(inFlightKey, pending);
    return this.cloneTreeNodes(await pending);
  }

  private static async parseTypeIndexWithCache(
    configPath: string,
    typeName: string,
    format: ConfigFormat,
    token: TypeContentsCacheEpochToken,
  ): Promise<TreeNode[]> {
    const typePath = this.getTypePath(configPath, typeName, format);
    const storagePath = token.storagePath;
    if (!typePath || !storagePath) {
      return await this.parseTypeIndexUncached(configPath, typeName, format);
    }

    const signature = await computeTypeContentsSignature(typePath, format);
    if (!signature || !this.isTypeContentsCacheEpochCurrent(token)) {
      return await this.parseTypeIndexUncached(configPath, typeName, format);
    }

    const cached = await this.enqueueDiskCacheOperation(async () => {
      if (!this.isTypeContentsCacheEpochCurrent(token)) {
        return null;
      }
      return await loadTypeContentsFromCache(storagePath, configPath, typeName, signature, 'index');
    });
    if (cached) {
      return cached;
    }

    const children = await this.parseTypeIndexUncached(configPath, typeName, format);
    await this.enqueueDiskCacheOperation(async () => {
      if (this.isTypeContentsCacheEpochCurrent(token)) {
        await saveTypeContentsToCache(storagePath, configPath, typeName, signature, children, 'index');
      }
    });
    return children;
  }

  private static async parseTypeContentsWithCache(
    configPath: string,
    typeName: string,
    format: ConfigFormat,
    token: TypeContentsCacheEpochToken,
  ): Promise<TreeNode[]> {
    const typePath = this.getTypePath(configPath, typeName, format);
    const storagePath = token.storagePath;
    if (!typePath || !storagePath) {
      return await this.parseTypeContentsUncached(configPath, typeName, format);
    }

    const signature = await computeTypeContentsSignature(typePath, format);
    if (!signature || !this.isTypeContentsCacheEpochCurrent(token)) {
      return await this.parseTypeContentsUncached(configPath, typeName, format);
    }

    const cached = await this.enqueueDiskCacheOperation(async () => {
      if (!this.isTypeContentsCacheEpochCurrent(token)) {
        return null;
      }
      return await loadTypeContentsFromCache(storagePath, configPath, typeName, signature);
    });
    if (cached) {
      return cached;
    }

    const children = await this.parseTypeContentsUncached(configPath, typeName, format);
    await this.enqueueDiskCacheOperation(async () => {
      if (this.isTypeContentsCacheEpochCurrent(token)) {
        await saveTypeContentsToCache(storagePath, configPath, typeName, signature, children);
      }
    });
    return children;
  }

  /**
   * Load direct children (Attributes, Forms, Ext, etc.) for a metadata element.
   * For Subsystems, child subsystems are already in the tree; only non-subsystem children are loaded.
   * Path for Subsystems is derived from element.filePath when present.
   */
  static async loadElementChildren(
    configPath: string,
    format: ConfigFormat,
    element: TreeNode
  ): Promise<TreeNode[]> {
    if (element?.properties) {
      delete element.properties._parseError;
    }
    if (element.parent?.properties) {
      delete element.parent.properties._parseError;
    }
    const id = element.id;
    const parent = element.parent;

    if (
      parent &&
      isTabularSectionColumnsContainer(element) &&
      parent.id.startsWith('TabularSections.') &&
      parent.parent?.id === 'TabularSections'
    ) {
      const loaded =
        format === ConfigFormat.Designer
          ? await DesignerParser.loadTabularSectionColumnChildren(parent)
          : format === ConfigFormat.EDT
            ? await EdtParser.loadTabularSectionColumnChildren(parent)
            : [];
      for (const c of loaded) {
        c.parent = element;
      }
      return loaded;
    }

    // When expanding an R6 placeholder (Attributes, Forms, etc.) under an object, use parent path:
    // e.g. Catalogs/ТелеграмСервис.xml (Designer) or src/Catalogs/ТелеграмСервис (EDT), not Attributes/Реквизиты.
    if (
      parent &&
      R6_SECTION_IDS.has(id) &&
      R6_OBJECT_TYPES.has(parent.type as MetadataType) &&
      parent.parent
    ) {
      const typeFolderId = parent.parent.id;
      const objectName = parent.name;
      const siblings =
        format === ConfigFormat.Designer
          ? await DesignerParser.loadChildrenForElement(configPath, typeFolderId, objectName, parent)
          : format === ConfigFormat.EDT
            ? await EdtParser.loadChildrenForElement(configPath, typeFolderId, objectName, parent)
            : [];
      if (parent.properties?._parseError) {
        throw parent.properties._parseError;
      }
      const sectionNode = siblings.find((c) => c.id === id);
      if (sectionNode?.children) {
        for (const c of sectionNode.children) {
          ensureTabularSectionColumnsPlaceholder(c);
        }
        for (const c of sectionNode.children) {
          c.parent = element;
        }
        return sectionNode.children;
      }
      return [];
    }

    const dot = id.indexOf('.');
    const typeName = dot >= 0 ? id.slice(0, dot) : id;
    const elementName = dot >= 0 ? id.slice(dot + 1) : element.name;

    let loaded: TreeNode[] = [];
    if (format === ConfigFormat.Designer) {
      loaded = await DesignerParser.loadChildrenForElement(configPath, typeName, elementName, element);
    } else if (format === ConfigFormat.EDT) {
      loaded = await EdtParser.loadChildrenForElement(configPath, typeName, elementName, element);
    } else {
      return [];
    }
    if (element?.properties?._parseError) {
      throw element.properties._parseError;
    }

    // Lazy expand of a tabular section instance: parsers may return [] when there are no columns;
    // still expose the «Реквизиты» placeholder so the user can add the first column (same as R6 TabularSections path).
    if (
      element.parent?.id === 'TabularSections' &&
      element.type === MetadataType.TabularSection &&
      element.id.startsWith('TabularSections.') &&
      element.id !== 'TabularSections'
    ) {
      element.children = loaded;
      for (const c of loaded) {
        c.parent = element;
      }
      ensureTabularSectionColumnsPlaceholder(element);
      return element.children ?? loaded;
    }

    return loaded;
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
