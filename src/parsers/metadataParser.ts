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
  MetadataType.ChartOfAccounts,
  MetadataType.FilterCriterion,
  MetadataType.DocumentJournal,
  MetadataType.SettingsStorage,
  MetadataType.Enum,
]);

/**
 * Main metadata parser that handles both EDT and Designer formats
 */
export class MetadataParser {
  private static typeContentsCacheStoragePath: string | null = null;
  private static readonly inFlightTypeContents = new Map<string, Promise<TreeNode[]>>();

  static setTypeContentsCacheStoragePath(storagePath: string | null): void {
    this.typeContentsCacheStoragePath = storagePath && storagePath.trim() ? storagePath : null;
  }

  static async invalidateTypeContentsCache(configPath: string): Promise<void> {
    if (!this.typeContentsCacheStoragePath) {
      return;
    }
    await invalidateTypeContentsCache(this.typeContentsCacheStoragePath, configPath);
  }

  static async clearTypeContentsCache(): Promise<void> {
    if (!this.typeContentsCacheStoragePath) {
      return;
    }
    await clearTypeContentsCache(this.typeContentsCacheStoragePath);
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
    format: ConfigFormat
  ): string {
    return `${format}:${path.normalize(configPath).toLowerCase()}:${typeName}`;
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
    const format = options?.format ?? await FormatDetector.detect(configPath);
    if (options?.bypassCache === true) {
      return await this.parseTypeContentsUncached(configPath, typeName, format);
    }

    const inFlightKey = this.getTypeContentsInFlightKey(configPath, typeName, format);
    const existing = this.inFlightTypeContents.get(inFlightKey);
    if (existing) {
      return await existing;
    }

    const pending = (async () => {
      return await this.parseTypeContentsWithCache(configPath, typeName, format);
    })().finally(() => {
      if (this.inFlightTypeContents.get(inFlightKey) === pending) {
        this.inFlightTypeContents.delete(inFlightKey);
      }
    });

    this.inFlightTypeContents.set(inFlightKey, pending);
    return await pending;
  }

  private static async parseTypeContentsWithCache(
    configPath: string,
    typeName: string,
    format: ConfigFormat
  ): Promise<TreeNode[]> {
    const typePath = this.getTypePath(configPath, typeName, format);
    const storagePath = this.typeContentsCacheStoragePath;
    if (!typePath || !storagePath) {
      return await this.parseTypeContentsUncached(configPath, typeName, format);
    }

    const signature = await computeTypeContentsSignature(typePath, format);
    if (!signature) {
      return await this.parseTypeContentsUncached(configPath, typeName, format);
    }

    const cached = await loadTypeContentsFromCache(storagePath, configPath, typeName, signature);
    if (cached) {
      return cached;
    }

    const children = await this.parseTypeContentsUncached(configPath, typeName, format);
    await saveTypeContentsToCache(storagePath, configPath, typeName, signature, children);
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
