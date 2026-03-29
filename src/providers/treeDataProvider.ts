import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { getFormPaths } from '../formEditor/formPaths';
import type { ReferenceableGroup } from '../types/typeDefinitions';
import { MetadataParser } from '../parsers/metadataParser';
import { ConfigFormat } from '../parsers/formatDetector';
import { MESSAGES } from '../constants/messages';
import { METADATA_TYPE_TO_REFERENCE_KIND } from '../constants/metadataTypeReferenceKinds';
import {
  ensureR6PlaceholdersForInstanceNode,
  ensureTabularSectionColumnsPlaceholder,
  R5_COMMON_DISK_BACKED_FOLDER_IDS,
} from '../utils/treeNormalization';
import { OptimisticDeleteToken } from '../types/reloadContracts';
import { TOP_LEVEL_TYPES } from '../services/elementOperations';
import { validateSubsystemCompositionRef } from '../parsers/xmlChildObjects';
import { expectedTreeNodeIdForCompositionRef } from '../services/subsystemCompositionRefResolver';
import type { ConfigurationBindingDecoration } from '../bindings/bindingDecorationTypes';
import {
  bindingKey,
  detectIbcmdExtensionNameFromConfigRelativePath,
  normalizeConfigRelativePath,
} from '../bindings/bindingPathUtils';

const REFERENCEABLE_METADATA_TYPES: ReadonlySet<MetadataType> = new Set([
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.Enum,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfAccounts,
  MetadataType.ChartOfCalculationTypes,
]);

/** Main metadata types shown in type filter QuickPick. */
const FILTERABLE_METADATA_TYPES: MetadataType[] = [
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.Enum,
  MetadataType.Report,
  MetadataType.DataProcessor,
  MetadataType.InformationRegister,
  MetadataType.AccumulationRegister,
  MetadataType.ChartOfAccounts,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfCalculationTypes,
  MetadataType.BusinessProcess,
  MetadataType.Task,
  MetadataType.Constant,
  MetadataType.CommonModule,
  MetadataType.Subsystem,
  MetadataType.Role,
  MetadataType.Extension,
];

const MAX_SEARCH_HISTORY = 10;

/** R6 placeholders under object XML — reload via loadElementChildren after mutations (see invalidateLoadedChildren). */
const R6_LAZY_SECTION_IDS = new Set(['Attributes', 'TabularSections', 'Forms', 'Commands', 'Templates']);

/**
 * Tree Data Provider for VS Code Tree View
 */
export class MetadataTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> =
    new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private rootNodes: TreeNode[] = [];
  private nodeCache = new Map<string, TreeNode>();
  /** ID → all nodes with that ID (for collision-safe lookup). */
  private nodeCandidatesById = new Map<string, TreeNode[]>();
  /** Normalized name (lowercase) → node ids, for fast search (Stage 8.3). */
  private nameIndex = new Map<string, string[]>();
  /** Per-root load context for lazy loading (key = root node id). */
  private loadContextByRootId = new Map<string, { configPath: string; format: ConfigFormat }>();

  private searchQuery = '';
  private searchBySynonymComment = false;
  private searchUseRegex = false;
  private typeFilter: Set<MetadataType> | null = null;
  private subsystemFilter: { subsystemId: string | null; subsystemName: string | null } = {
    subsystemId: null,
    subsystemName: null,
  };
  private searchHistory: string[] = [];
  private filterAncestorOrVisibleIds: Set<string> | null = null;
  private messageUpdater: ((message: string | undefined) => void) | null = null;
  /** Ключ {@link bindingKey}(workspaceFolder, configRelativePath) → сводка для узла Configuration. */
  private configurationBindingDecorations = new Map<string, ConfigurationBindingDecoration>();

  constructor(_context: vscode.ExtensionContext) {
    void _context;
    Logger.info('MetadataTreeDataProvider initialized');
  }

  setMessageUpdater(updater: (message: string | undefined) => void): void {
    this.messageUpdater = updater;
  }

  /**
   * Обновляет кэш привязок ИБ для бейджа/tooltip на узле Configuration (WOW §2C).
   */
  setConfigurationBindingDecorations(map: ReadonlyMap<string, ConfigurationBindingDecoration>): void {
    this.configurationBindingDecorations = new Map(map);
  }

  private lookupConfigurationBindingDecoration(element: TreeNode): ConfigurationBindingDecoration | undefined {
    if (element.type === MetadataType.Configuration) {
      const configDir = this.getConfigPathForNode(element);
      if (!configDir) {
        return undefined;
      }
      const configXmlFs = path.join(configDir, 'Configuration.xml');
      const uri = vscode.Uri.file(configXmlFs);
      const wf = vscode.workspace.getWorkspaceFolder(uri);
      if (!wf) {
        return undefined;
      }
      const rel = path.relative(wf.uri.fsPath, configXmlFs).replace(/\\/g, '/');
      const norm = normalizeConfigRelativePath(rel);
      const ext = detectIbcmdExtensionNameFromConfigRelativePath(norm);
      const key = bindingKey(wf.name, norm, ext);
      return this.configurationBindingDecorations.get(key);
    }
    if (element.type === MetadataType.Extension) {
      const props = element.properties as Record<string, unknown> | undefined;
      if (props?.isExtension !== true || !element.filePath?.trim()) {
        return undefined;
      }
      const configXmlFs = path.join(element.filePath.trim(), 'Configuration.xml');
      try {
        if (!fs.existsSync(configXmlFs)) {
          return undefined;
        }
      } catch {
        return undefined;
      }
      const uri = vscode.Uri.file(configXmlFs);
      const wf = vscode.workspace.getWorkspaceFolder(uri);
      if (!wf) {
        return undefined;
      }
      const rel = path.relative(wf.uri.fsPath, configXmlFs).replace(/\\/g, '/');
      const norm = normalizeConfigRelativePath(rel);
      const ext = detectIbcmdExtensionNameFromConfigRelativePath(norm);
      const key = bindingKey(wf.name, norm, ext);
      return this.configurationBindingDecorations.get(key);
    }
    return undefined;
  }

  /** WOW Phase 4 #64 — папка выгрузки расширения с отдельным Configuration.xml. */
  private isExtensionInfobaseBindingRoot(element: TreeNode): boolean {
    if (element.type !== MetadataType.Extension) {
      return false;
    }
    const props = element.properties as Record<string, unknown> | undefined;
    if (props?.isExtension !== true) {
      return false;
    }
    const dir = element.filePath?.trim();
    if (!dir) {
      return false;
    }
    try {
      return fs.existsSync(path.join(dir, 'Configuration.xml'));
    } catch {
      return false;
    }
  }

  /** Display form of search query: *query* for plain substring search, else as-is (additional_req.md п.2). */
  private getSearchQueryForDisplay(): string {
    const q = this.searchQuery.trim();
    if (!q) {return q;}
    if (this.searchUseRegex) {return q;}
    const trimmed = q;
    if (trimmed.startsWith('*') || trimmed.endsWith('*')) {return trimmed;}
    return `*${trimmed}*`;
  }

  private updateFilterMessage(): void {
    if (!this.messageUpdater) {return;}
    const parts: string[] = [];
    if (this.searchQuery.trim()) {parts.push(`Поиск: ${this.getSearchQueryForDisplay()}`);}
    if (this.typeFilter && this.typeFilter.size > 0) {parts.push(`Типы: ${this.typeFilter.size}`);}
    const subsystemLabel = this.getSubsystemFilterLabel();
    if (subsystemLabel) {parts.push(subsystemLabel);}
    this.messageUpdater(parts.length > 0 ? parts.join(' · ') : undefined);
  }

  // --- Search/filter state (public API) ---

  setSearchQuery(query: string): void {
    this.searchQuery = (query || '').trim();
    this.filterAncestorOrVisibleIds = null;
    this.updateFilterMessage();
    this.refresh();
  }

  getSearchQuery(): string {
    return this.searchQuery;
  }

  setSearchOptions(options: { bySynonymComment?: boolean; useRegex?: boolean }): void {
    if (options.bySynonymComment !== undefined) {this.searchBySynonymComment = options.bySynonymComment;}
    if (options.useRegex !== undefined) {this.searchUseRegex = options.useRegex;}
    this.filterAncestorOrVisibleIds = null;
    this.refresh();
  }

  setTypeFilter(types: MetadataType[] | null): void {
    this.typeFilter = types && types.length > 0 ? new Set(types) : null;
    this.updateFilterMessage();
    this.refresh();
  }

  getTypeFilter(): MetadataType[] | null {
    return this.typeFilter ? Array.from(this.typeFilter) : null;
  }

  /**
   * Set subsystem filter to show only nodes belonging to the specified subsystem.
   * @param subsystemId The ID of the subsystem node to filter by, or null to clear filter
   * @param subsystemName The display name of the subsystem, or null to clear filter
   */
  async setSubsystemFilter(subsystemId: string | null, subsystemName: string | null): Promise<void> {
    this.subsystemFilter.subsystemId = subsystemId;
    this.subsystemFilter.subsystemName = subsystemName;
    
    if (subsystemId) {
      const subsystemNode = this.nodeCache.get(subsystemId);
      if (subsystemNode) {
        await this.loadSubsystemContent(subsystemNode);
        // Eagerly load all type-nodes referenced in subsystem Content so that
        // ensureFilterSets() can find them in nodeCache (lazy nodes are not yet loaded).
        await this.eagerLoadSubsystemTypes(subsystemNode);
      }
    }
    
    this.filterAncestorOrVisibleIds = null;
    this.updateFilterMessage();
    this.refresh();
  }

  /**
   * Get current subsystem filter state.
   * @returns Object with subsystemId and subsystemName, or null values if no filter is active
   */
  getSubsystemFilter(): { subsystemId: string | null; subsystemName: string | null } {
    return { ...this.subsystemFilter };
  }

  /**
   * Subsystem filter contract (ADR 0001): a node passes if (1) no filter, or (2) node is the
   * selected subsystem or its ancestor, or (3) node is in the Content of the selected subsystem
   * or in the Content of any of its descendant subsystems (recursively). TreeDataProvider uses
   * path-based id for subsystems and loads Content from subsystemNode.filePath when present.
   */
  private async loadSubsystemContent(subsystemNode: TreeNode): Promise<void> {
    Logger.info('loadSubsystemContent called', {
      subsystemId: subsystemNode.id,
      hasContent: !!subsystemNode.properties.Content,
      isLazy: !!subsystemNode.properties._lazy,
      hasFilePath: !!subsystemNode.filePath,
      filePath: subsystemNode.filePath,
    });
    
    // If already loaded, skip
    if (subsystemNode.properties.Content) {
      Logger.info('Skipping load - already loaded');
      return;
    }

    // Get config path
    const configRoot = this.getConfigurationRoot(subsystemNode);
    if (!configRoot) {
      Logger.info('No config root found');
      return;
    }
    
    const ctx = this.loadContextByRootId.get(configRoot.id);
    if (!ctx) {
      Logger.info('No load context found');
      return;
    }

    const pathModule = await import('path');
    const xmlPath = subsystemNode.filePath
      ? pathModule.default.normalize(subsystemNode.filePath)
      : pathModule.default.join(ctx.configPath, 'Subsystems', `${subsystemNode.name}.xml`);
    
    Logger.info('Loading subsystem XML', { xmlPath });

    try {
      const xmlParserModule = await import('../parsers/xmlParser');
      const xmlContent = await xmlParserModule.XmlParser.parseFileAsync(xmlPath);
      const properties = this.extractPropertiesFromXml(xmlContent);
      
      subsystemNode.properties = { ...subsystemNode.properties, ...properties };
      delete subsystemNode.properties._lazy;
      
      Logger.info('Loaded subsystem properties', {
        subsystemId: subsystemNode.id,
        propertyKeys: Object.keys(subsystemNode.properties),
        hasContent: !!subsystemNode.properties.Content,
      });
    } catch (error) {
      Logger.error('Failed to load subsystem properties', error);
    }
  }

  /**
   * Eagerly load all type-nodes referenced in subsystem Content (selected + all descendants) into nodeCache.
   * Without this, lazy type-nodes (Documents, Reports, etc.) have no children in cache
   * and ensureFilterSets() cannot match any element nodes.
   */
  private async eagerLoadSubsystemTypes(subsystemNode: TreeNode): Promise<void> {
    const subsystemsToLoad = this.collectSubsystemAndDescendants(subsystemNode);
    for (const sub of subsystemsToLoad) {
      await this.loadSubsystemContent(sub);
    }
    const refTypeToFolder = this.buildRefTypeToFolderMap();
    const foldersToLoad = new Set<string>();
    for (const sub of subsystemsToLoad) {
      const content = sub.properties.Content;
      if (!content || typeof content !== 'object') {continue;}
      const contentObj = content as Record<string, unknown>;
      const rawItems = contentObj['xr:Item'];
      const items: unknown[] = Array.isArray(rawItems) ? rawItems : (rawItems != null ? [rawItems] : []);
      for (const item of items) {
        if (typeof item === 'object' && item !== null) {
          const refText = (item as Record<string, unknown>)['#text'] as string;
          if (refText) {
            const refType = refText.split('.')[0];
            const folder = refTypeToFolder.get(refType);
            if (folder) {foldersToLoad.add(folder);}
          }
        }
      }
    }
    if (foldersToLoad.size === 0) {return;}

    // Find config root and load context
    const configRoot = this.getConfigurationRoot(subsystemNode);
    if (!configRoot) {return;}
    const ctx = this.loadContextByRootId.get(configRoot.id);
    if (!ctx) {return;}

    // For each folder, find the type-node in the tree and load its children if not yet loaded
    for (const folder of foldersToLoad) {
      const typeNode = this.findTypeFolderNode(configRoot, folder);
      if (!typeNode) {continue;}
      // Already loaded
      if (typeNode.children && typeNode.children.length > 0) {continue;}

      Logger.info('Eager loading type for subsystem filter', { folder });
      try {
        const children = await MetadataParser.parseTypeContents(ctx.configPath, folder);
        for (const c of children) {
          c.parent = typeNode;
          this.buildCache(c);
        }
        typeNode.children = children;
      } catch (error) {
        Logger.warn('Failed to eager load type for subsystem filter', { folder, error });
      }
    }
  }

  /** Build a map from XML ref type name (singular) to folder name (plural). */
  private buildRefTypeToFolderMap(): Map<string, string> {
    // Derived from MetadataTypeMapper: folder → MetadataType, we need refType → folder.
    // refType in subsystem Content matches the singular XML element name used in 1C,
    // which equals the MetadataType enum value (e.g. 'Document', 'Report', 'Catalog').
    // The folder name is the plural form used in the file system.
    const map = new Map<string, string>([
      ['Catalog', 'Catalogs'],
      ['Document', 'Documents'],
      ['Enum', 'Enums'],
      ['Report', 'Reports'],
      ['DataProcessor', 'DataProcessors'],
      ['ChartOfCharacteristicTypes', 'ChartsOfCharacteristicTypes'],
      ['ChartOfAccounts', 'ChartsOfAccounts'],
      ['ChartOfCalculationTypes', 'ChartsOfCalculationTypes'],
      ['InformationRegister', 'InformationRegisters'],
      ['AccumulationRegister', 'AccumulationRegisters'],
      ['AccountingRegister', 'AccountingRegisters'],
      ['CalculationRegister', 'CalculationRegisters'],
      ['BusinessProcess', 'BusinessProcesses'],
      ['Task', 'Tasks'],
      ['ExternalDataSource', 'ExternalDataSources'],
      ['Constant', 'Constants'],
      ['SessionParameter', 'SessionParameters'],
      ['FilterCriterion', 'FilterCriteria'],
      ['ScheduledJob', 'ScheduledJobs'],
      ['FunctionalOption', 'FunctionalOptions'],
      ['FunctionalOptionsParameter', 'FunctionalOptionsParameters'],
      ['SettingsStorage', 'SettingsStorages'],
      ['EventSubscription', 'EventSubscriptions'],
      ['CommonModule', 'CommonModules'],
      ['CommandGroup', 'CommandGroups'],
      ['Role', 'Roles'],
      ['Interface', 'Interfaces'],
      ['Style', 'Styles'],
      ['WebService', 'WebServices'],
      ['HTTPService', 'HTTPServices'],
      ['IntegrationService', 'IntegrationServices'],
      ['Subsystem', 'Subsystems'],
      ['ExchangePlan', 'ExchangePlans'],
      ['DocumentJournal', 'DocumentJournals'],
      ['DefinedType', 'DefinedTypes'],
      ['CommonAttribute', 'CommonAttributes'],
      ['CommonCommand', 'CommonCommands'],
      ['CommonForm', 'CommonForms'],
      ['CommonPicture', 'CommonPictures'],
      ['CommonTemplate', 'CommonTemplates'],
      ['DocumentNumerator', 'DocumentNumerators'],
      ['Language', 'Languages'],
      ['WSReference', 'WSReferences'],
      ['XDTOPackage', 'XDTOPackages'],
      ['StyleItem', 'StyleItems'],
    ]);
    return map;
  }

  private extractPropertiesFromXml(xmlContent: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // Find Properties object at depth 1 or depth 2.
    // Subsystem XML has structure: MetaDataObject → Subsystem → Properties
    // Other XMLs may have: RootElement → Properties
    const findProperties = (element: Record<string, unknown>): Record<string, unknown> | null => {
      if (element.Properties && typeof element.Properties === 'object' && !Array.isArray(element.Properties)) {
        return element.Properties as Record<string, unknown>;
      }
      // One level deeper (e.g. MetaDataObject.Subsystem.Properties)
      for (const val of Object.values(element)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const nested = val as Record<string, unknown>;
          if (nested.Properties && typeof nested.Properties === 'object' && !Array.isArray(nested.Properties)) {
            return nested.Properties as Record<string, unknown>;
          }
        }
      }
      return null;
    };

    for (const [key, value] of Object.entries(xmlContent)) {
      if (key === '@_' || key.startsWith('#')) {continue;}

      if (typeof value === 'object' && value !== null) {
        const element = value as Record<string, unknown>;
        const properties = findProperties(element);

        if (properties) {
          for (const [propKey, propValue] of Object.entries(properties)) {
            if (propKey === '@_' || propKey.startsWith('#')) {continue;}

            if (typeof propValue === 'boolean' || typeof propValue === 'number' || typeof propValue === 'string') {
              result[propKey] = propValue;
            } else if (typeof propValue === 'object' && propValue !== null) {
              const obj = propValue as Record<string, unknown>;
              if (obj['v8:item']) {
                const items = obj['v8:item'];
                if (Array.isArray(items) && items.length > 0) {
                  const firstItem = items[0];
                  if (firstItem && typeof firstItem === 'object' && 'v8:content' in firstItem) {
                    result[propKey] = (firstItem as Record<string, unknown>)['v8:content'];
                  }
                }
              } else if ('v8:Type' in obj) {
                result[propKey] = obj;
              } else if (obj['xr:Item']) {
                // Handle Content field with xr:Item array
                result[propKey] = obj;
              } else if (obj.item) {
                result[propKey] = obj.item;
              } else {
                result[propKey] = propValue;
              }
            } else {
              result[propKey] = propValue;
            }
          }
        }
      }
    }
    return result;
  }

  /** Filter: visible if node is selected subsystem or its ancestor, or in Content of selected or any descendant subsystem (ADR 0001). */
  private nodePassesSubsystemFilter(node: TreeNode): boolean {
      if (!this.subsystemFilter.subsystemId) {
        return true;
      }

      // Check if node is ancestor of the subsystem (Configuration → Subsystems → SelectedSubsystem)
      let current: TreeNode | undefined = node;
      while (current) {
        // `id` is expected to be unique in real metadata. In property-based tests it can be duplicated,
        // so we also require the node to be an actual subsystem.
        if (
          current.id === this.subsystemFilter.subsystemId &&
          current.type === MetadataType.Subsystem
        ) {
          return true;
        }
        current = current.parent;
      }

      const subsystemNode = this.nodeCache.get(this.subsystemFilter.subsystemId);
      if (!subsystemNode || subsystemNode.type !== MetadataType.Subsystem) {return false;}

      const subsystemsToCheck = this.collectSubsystemAndDescendants(subsystemNode);
      for (const sub of subsystemsToCheck) {
        const content = sub.properties.Content;
        if (!content || typeof content !== 'object' || content === null) {continue;}
        const contentObj = content as Record<string, unknown>;
        const rawItems = contentObj['xr:Item'];
        const items: unknown[] = Array.isArray(rawItems) ? rawItems : (rawItems != null ? [rawItems] : []);
        for (const item of items) {
          if (typeof item === 'object' && item !== null) {
            const refText = (item as Record<string, unknown>)['#text'] as string;
            if (refText && this.nodeMatchesContentRef(node, refText)) {
              return true;
            }
          }
        }
      }
      return false;
    }

  /** Collect subsystem node and all descendant subsystem nodes (by tree children). */
  private collectSubsystemAndDescendants(subsystemNode: TreeNode): TreeNode[] {
    const out: TreeNode[] = [subsystemNode];
    const stack: TreeNode[] = [subsystemNode];
    while (stack.length > 0) {
      const n = stack.pop()!;
      for (const ch of n.children ?? []) {
        if (ch.type === MetadataType.Subsystem) {
          out.push(ch);
          stack.push(ch);
        }
      }
    }
    return out;
  }

  /**
   * Check if a node matches a subsystem content reference.
   * Content references are in format "Type.Name" (e.g., "CommonModule.ТелеграмСервер")
   */
  private nodeMatchesContentRef(node: TreeNode, refText: string): boolean {
    // Parse reference: "CommonModule.ТелеграмСервер" → type="CommonModule", name="ТелеграмСервер"
    const parts = refText.split('.');
    if (parts.length < 2) {
      return false;
    }

    const refType = parts[0];
    const refName = parts.slice(1).join('.'); // Handle names with dots

    // Check if node matches the reference directly
    if (node.type === refType && node.name === refName) {
      return true;
    }

    // Check if any ancestor matches (to include child elements like Attributes, Forms, etc.)
    let current: TreeNode | undefined = node.parent;
    while (current) {
      if (current.type === refType && current.name === refName) {
        return true;
      }
      current = current.parent;
    }

    return false;
  }

  /**
   * Get the subsystem filter label for display in the UI.
   * @returns The filter label string, or null if no filter is active
   */
  getSubsystemFilterLabel(): string | null {
    if (!this.subsystemFilter.subsystemId || !this.subsystemFilter.subsystemName) {
      return null;
    }
    return `Подсистема: ${this.subsystemFilter.subsystemName}`;
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.typeFilter = null;
    this.subsystemFilter.subsystemId = null;
    this.subsystemFilter.subsystemName = null;
    this.filterAncestorOrVisibleIds = null;
    this.updateFilterMessage();
    this.refresh();
  }

  addSearchToHistory(query: string): void {
    const q = (query || '').trim();
    if (!q) {return;}
    this.searchHistory = [q, ...this.searchHistory.filter((x) => x !== q)].slice(0, MAX_SEARCH_HISTORY);
  }

  getSearchHistory(): string[] {
    return [...this.searchHistory];
  }

  /** Human-readable labels for filterable types. */
  static getFilterableTypeLabels(): { type: MetadataType; label: string }[] {
    const labels: Record<MetadataType, string> = {
      [MetadataType.Configuration]: 'Конфигурация',
      [MetadataType.Catalog]: 'Справочник',
      [MetadataType.Document]: 'Документ',
      [MetadataType.Enum]: 'Перечисление',
      [MetadataType.Report]: 'Отчёт',
      [MetadataType.DataProcessor]: 'Обработка',
      [MetadataType.ChartOfCharacteristicTypes]: 'План видов характеристик',
      [MetadataType.ChartOfAccounts]: 'План счетов',
      [MetadataType.ChartOfCalculationTypes]: 'План видов расчёта',
      [MetadataType.InformationRegister]: 'Регистр сведений',
      [MetadataType.AccumulationRegister]: 'Регистр накопления',
      [MetadataType.AccountingRegister]: 'Регистр бухгалтерии',
      [MetadataType.CalculationRegister]: 'Регистр расчёта',
      [MetadataType.BusinessProcess]: 'Бизнес-процесс',
      [MetadataType.Task]: 'Задача',
      [MetadataType.ExternalDataSource]: 'Внешний источник',
      [MetadataType.Constant]: 'Константа',
      [MetadataType.SessionParameter]: 'Параметр сеанса',
      [MetadataType.FilterCriterion]: 'Критерий отбора',
      [MetadataType.ScheduledJob]: 'Регламентное задание',
      [MetadataType.FunctionalOption]: 'Функциональная опция',
      [MetadataType.FunctionalOptionsParameter]: 'Параметр ФО',
      [MetadataType.SettingsStorage]: 'Хранилище настроек',
      [MetadataType.EventSubscription]: 'Подписка на событие',
      [MetadataType.CommonModule]: 'Общий модуль',
      [MetadataType.CommandGroup]: 'Группа команд',
      [MetadataType.Command]: 'Команда',
      [MetadataType.Role]: 'Роль',
      [MetadataType.Interface]: 'Интерфейс',
      [MetadataType.Style]: 'Стиль',
      [MetadataType.WebService]: 'Веб-сервис',
      [MetadataType.HTTPService]: 'HTTP-сервис',
      [MetadataType.IntegrationService]: 'Сервис интеграции',
      [MetadataType.Subsystem]: 'Подсистема',
      [MetadataType.ExchangePlan]: 'План обмена',
      [MetadataType.DocumentJournal]: 'Журнал документов',
      [MetadataType.DefinedType]: 'Определяемый тип',
      [MetadataType.CommonAttribute]: 'Общий реквизит',
      [MetadataType.CommonCommand]: 'Общая команда',
      [MetadataType.CommonForm]: 'Общая форма',
      [MetadataType.CommonPicture]: 'Общая картинка',
      [MetadataType.CommonTemplate]: 'Общий макет',
      [MetadataType.DocumentNumerator]: 'Нумератор документов',
      [MetadataType.Language]: 'Язык',
      [MetadataType.WSReference]: 'WS-ссылка',
      [MetadataType.XDTOPackage]: 'XDTO-пакет',
      [MetadataType.StyleItem]: 'Элемент стиля',
      [MetadataType.Attribute]: 'Реквизит',
      [MetadataType.TabularSection]: 'Табличная часть',
      [MetadataType.Form]: 'Форма',
      [MetadataType.Template]: 'Макет',
      [MetadataType.CommandSubElement]: 'Подэлемент команды',
      [MetadataType.Recurrence]: 'Повторение',
      [MetadataType.Method]: 'Метод',
      [MetadataType.Parameter]: 'Параметр',
      [MetadataType.Extension]: 'Расширение',
      [MetadataType.Unknown]: 'Неизвестный',
    };
    return FILTERABLE_METADATA_TYPES.map((type) => ({ type, label: labels[type] ?? type }));
  }

  private nodeMatchesSearch(node: TreeNode, query: string): boolean {
    if (!query) {return true;}
    const q = query.trim().toLowerCase();
    const name = (node.name || '').toLowerCase();
    const synonym = String((node.properties?.synonym as string) ?? '').toLowerCase();
    const comment = String((node.properties?.comment as string) ?? '').toLowerCase();

    const testString = (s: string): boolean => {
      if (this.searchUseRegex) {
        try {
          const raw = this.searchQuery.trim();
          const pattern = raw.startsWith('/') && raw.endsWith('/') ? raw.slice(1, -1) : raw;
          return new RegExp(pattern, 'i').test(s);
        } catch {
          return s.includes(q);
        }
      }
      return s.includes(q);
    };

    if (testString(name)) {return true;}
    if (this.searchBySynonymComment && (testString(synonym) || testString(comment))) {return true;}
    return false;
  }

  private nodeOrDescendantMatchesSearch(node: TreeNode, query: string): boolean {
    if (!query) {return true;}
    if (this.nodeMatchesSearch(node, query)) {return true;}
    if (node.children) {
      for (const child of node.children) {
        if (this.nodeOrDescendantMatchesSearch(child, query)) {return true;}
      }
    }
    return false;
  }

  private hasDescendantWithTypeInFilter(node: TreeNode): boolean {
    if (!this.typeFilter || this.typeFilter.size === 0) {return true;}
    if (this.typeFilter.has(node.type)) {return true;}
    if (node.children) {
      for (const child of node.children) {
        if (this.hasDescendantWithTypeInFilter(child)) {return true;}
      }
    }
    return false;
  }

  private passesTypeFilter(node: TreeNode): boolean {
    if (!this.typeFilter || this.typeFilter.size === 0) {return true;}
    return this.typeFilter.has(node.type) || this.hasDescendantWithTypeInFilter(node);
  }

  /** Visible nodes in depth-first order (for next/previous match navigation). */
  getVisibleNodesInOrder(): TreeNode[] {
    const ids = this.getVisibleOrderedNodeIds();
    return ids
      .map((id) => this.nodeCache.get(id))
      .filter((n): n is TreeNode => n != null);
  }

  /**
   * Set single root node and refresh tree (backward compat).
   * @param loadContext When provided, type nodes load their children on first expand (lazy loading).
   */
  setRootNode(node: TreeNode, loadContext?: { configPath: string; format: ConfigFormat }): void {
    if (!node) {
      Logger.error('Cannot set null or undefined root node');
      return;
    }
    this.rootNodes = [node];
    this.loadContextByRootId.clear();
    if (loadContext) {this.loadContextByRootId.set(node.id, loadContext);}
    this.nodeCache.clear();
    this.nodeCandidatesById.clear();
    this.nameIndex.clear();
    this.buildCache(node);
    Logger.info('Tree cache size', { nodeCount: this.nodeCache.size });
    this.filterAncestorOrVisibleIds = null;
    this.refresh();
    if (this.messageUpdater && !this.hasActiveFilter()) {
      this.messageUpdater(undefined);
    }
  }

  /**
   * Set multiple root nodes (one per configuration) and per-root load context.
   */
  setRootNodes(
    nodes: TreeNode[],
    loadContextMap?: Map<string, { configPath: string; format: ConfigFormat }>
  ): void {
    this.rootNodes = nodes;
    this.loadContextByRootId = new Map(loadContextMap ?? []);
    this.nodeCache.clear();
    this.nodeCandidatesById.clear();
    this.nameIndex.clear();
    for (const node of nodes) {this.buildCache(node);}
    Logger.info('Tree cache size', { nodeCount: this.nodeCache.size, roots: nodes.length });
    this.filterAncestorOrVisibleIds = null;
    this.refresh();
    if (this.messageUpdater) {
      if (this.rootNodes.length === 0) {
        this.messageUpdater(MESSAGES.EMPTY_TREE_MESSAGE);
      } else if (!this.hasActiveFilter()) {
        this.messageUpdater(undefined);
      }
    }
  }

  /**
   * Get first root node (for backward compat when single root).
   */
  getRootNode(): TreeNode | null {
    return this.rootNodes.length > 0 ? this.rootNodes[0] : null;
  }

  /**
   * Get configuration root path for the tree (first root's context; backward compat).
   */
  getConfigPath(): string | null {
    const first = this.rootNodes[0];
    if (!first) {return null;}
    return this.loadContextByRootId.get(first.id)?.configPath ?? first.filePath ?? null;
  }

  /**
   * Get configuration root path for a node (walk up to Configuration node, return its directory path).
   */
  getConfigPathForNode(node: TreeNode): string | null {
    let n: TreeNode | undefined = node;
    while (n) {
      if (n.type === MetadataType.Configuration && n.filePath) {return path.dirname(n.filePath);}
      n = n.parent;
    }
    return null;
  }

  /**
   * Search nodes by name (substring, case-insensitive). Uses name index for speed.
   * Returns only nodes currently in cache (loaded so far).
   */
  searchByName(query: string): TreeNode[] {
    const q = (query || '').trim().toLowerCase();
    if (!q) {return [];}
    const result: TreeNode[] = [];
    for (const [key, ids] of this.nameIndex) {
      if (key.includes(q)) {
        for (const id of ids) {
          const node = this.nodeCache.get(id);
          if (node) {result.push(node);}
        }
      }
    }
    return result;
  }

  /**
   * Build cache for fast node lookup and name index for search
   */
  private buildCache(node: TreeNode): void {
    this.nodeCache.set(node.id, node);
    const candidates = this.nodeCandidatesById.get(node.id) ?? [];
    candidates.push(node);
    this.nodeCandidatesById.set(node.id, candidates);
    const key = (node.name || '').toLowerCase();
    if (key) {
      const list = this.nameIndex.get(key) ?? [];
      list.push(node.id);
      this.nameIndex.set(key, list);
    }
    if (node.children) {
      for (const child of node.children) {
        this.buildCache(child);
      }
    }
  }

  /**
   * Refresh tree view
   */
  refresh(element?: TreeNode): void {
    Logger.debug('Refreshing tree view', element ? element.name : 'root');
    this._onDidChangeTreeData.fire(element);
  }

  /**
   * Drop cached children so the next {@link getChildren} reloads from disk/XML.
   * Call after create/delete that change files under this container (matrix, tests).
   */
  invalidateLoadedChildren(element: TreeNode): void {
    const el = this.resolveActiveNode(element);
    if (!el.properties) {
      el.properties = {};
    }
    el.children = [];
    if (R6_LAZY_SECTION_IDS.has(el.id) || el.type === MetadataType.Subsystem) {
      (el.properties as Record<string, unknown>)._lazy = true;
    } else if (
      TOP_LEVEL_TYPES.has(el.type) &&
      el.id.includes('.') &&
      el.type !== MetadataType.Form
    ) {
      // Instance XML (e.g. Roles.Имя, CommonModules.X): after create/delete under this node,
      // children must reload from disk like first expand — same as shallow parseMetadataElement.
      (el.properties as Record<string, unknown>)._lazy = true;
    }
    this.filterAncestorOrVisibleIds = null;
    this.refresh(el);
  }

  private getConfigurationRoot(node: TreeNode): TreeNode | null {
    let n: TreeNode | undefined = node;
    while (n) {
      if (n.type === MetadataType.Configuration) {return n;}
      n = n.parent;
    }
    return null;
  }

  /** Type folder under `Configuration` or under «Общие» (`Common`) after tree normalization. */
  private findTypeFolderNode(configRoot: TreeNode, folderId: string): TreeNode | undefined {
    const direct = configRoot.children?.find((c) => c.id === folderId);
    if (direct) {
      return direct;
    }
    const commonGroup = configRoot.children?.find((c) => c.id === 'Common');
    return commonGroup?.children?.find((c) => c.id === folderId);
  }

  private getNodeLineage(node: TreeNode): TreeNode[] {
    const lineage: TreeNode[] = [];
    let current: TreeNode | undefined = node;
    while (current) {
      lineage.push(current);
      current = current.parent;
    }
    return lineage.reverse();
  }

  private normalizeIdentityPath(value: string | undefined): string {
    return (value ?? '').replace(/\\/g, '/').toLowerCase();
  }

  private getConfigRootIdentity(root: TreeNode | null): string {
    if (!root) {return '';}
    const fromLoadContext = this.loadContextByRootId.get(root.id)?.configPath;
    if (fromLoadContext) {return this.normalizeIdentityPath(fromLoadContext);}
    if (root.filePath) {return this.normalizeIdentityPath(path.dirname(root.filePath));}
    return this.normalizeIdentityPath(root.id);
  }

  private getNodeRootIdentity(node: TreeNode): string {
    return this.getConfigRootIdentity(this.getConfigurationRoot(node));
  }

  private getLineageSignature(node: TreeNode): string {
    const lineage = this.getNodeLineage(node);
    return lineage.map((part) => `${part.type}:${part.name}:${part.id}`).join(' > ');
  }

  private preferCandidateOnTie(target: TreeNode, currentBest: TreeNode, candidate: TreeNode): TreeNode {
    const targetRootIdentity = this.getNodeRootIdentity(target);
    if (targetRootIdentity) {
      const bestMatchesRoot = this.getNodeRootIdentity(currentBest) === targetRootIdentity;
      const candidateMatchesRoot = this.getNodeRootIdentity(candidate) === targetRootIdentity;
      if (candidateMatchesRoot !== bestMatchesRoot) {
        return candidateMatchesRoot ? candidate : currentBest;
      }
    }

    const bestHasParent = currentBest.parent != null;
    const candidateHasParent = candidate.parent != null;
    if (candidateHasParent !== bestHasParent) {
      return candidateHasParent ? candidate : currentBest;
    }

    const bestLineage = this.getLineageSignature(currentBest);
    const candidateLineage = this.getLineageSignature(candidate);
    if (candidateLineage !== bestLineage) {
      return candidateLineage < bestLineage ? candidate : currentBest;
    }

    return candidate.id < currentBest.id ? candidate : currentBest;
  }

  private scoreNodeCandidate(target: TreeNode, candidate: TreeNode): number {
    let score = 0;
    if (candidate.type === target.type) {score += 8;}
    if (candidate.name === target.name) {score += 8;}
    if (candidate.id === target.id) {score += 4;}
    if (target.filePath && candidate.filePath && target.filePath === candidate.filePath) {score += 6;}
    if (
      target.parentFilePath &&
      candidate.parentFilePath &&
      target.parentFilePath === candidate.parentFilePath
    ) {
      score += 4;
    }
    if (target.parent && candidate.parent && target.parent.id === candidate.parent.id) {score += 3;}
    return score;
  }

  private pickBestCandidate(target: TreeNode, candidates: TreeNode[]): TreeNode | null {
    if (candidates.length === 0) {return null;}
    let best: TreeNode | null = null;
    let bestScore = -1;
    for (const candidate of candidates) {
      const score = this.scoreNodeCandidate(target, candidate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      } else if (score === bestScore && best) {
        best = this.preferCandidateOnTie(target, best, candidate);
      }
    }
    return best;
  }

  private findNodeByIdWithContext(node: TreeNode): TreeNode | null {
    const candidates = this.nodeCandidatesById.get(node.id) ?? [];
    if (candidates.length === 0) {return null;}
    return this.pickBestCandidate(node, candidates);
  }

  /**
   * Resolve stale TreeNode instance to active node from the current in-memory tree.
   * This keeps getChildren stable after tree reloads when VS Code passes old references.
   */
  private resolveActiveNode(node: TreeNode): TreeNode {
    const lineage = this.getNodeLineage(node);
    if (lineage.length === 0) {return node;}

    const rootSegment = lineage[0];
    const rootCandidates = this.rootNodes.filter(
      (root) => root.type === rootSegment.type && root.name === rootSegment.name
    );
    let current = this.pickBestCandidate(rootSegment, rootCandidates);
    if (!current) {
      current = this.findNodeByIdWithContext(rootSegment);
    }
    if (!current) {
      return this.findNodeByIdWithContext(node) ?? this.nodeCache.get(node.id) ?? node;
    }

    for (let i = 1; i < lineage.length; i++) {
      const segment = lineage[i];
      const children = current.children ?? [];
      if (children.length === 0) {
        return this.findNodeByIdWithContext(node) ?? this.nodeCache.get(node.id) ?? current;
      }
      const childCandidates = children.filter(
        (child) =>
          child.type === segment.type &&
          child.name === segment.name &&
          (!segment.filePath || !child.filePath || child.filePath === segment.filePath)
      );
      const next = this.pickBestCandidate(segment, childCandidates);
      if (!next) {
        return this.findNodeByIdWithContext(node) ?? this.nodeCache.get(node.id) ?? current;
      }
      current = next;
    }

    return current;
  }

  /**
   * Get tree item for a node
   */
  private isLazyTypeNode(element: TreeNode): boolean {
    if (element.children && element.children.length > 0) {
      return false;
    }
    const configRoot = this.getConfigurationRoot(element);
    if (!configRoot || !this.loadContextByRootId.has(configRoot.id)) {
      return false;
    }
    const p = element.parent;
    if (!p) {
      return false;
    }
    if (p === configRoot) {
      return true;
    }
    if (p.type === MetadataType.Unknown && p.id === 'Common') {
      return R5_COMMON_DISK_BACKED_FOLDER_IDS.has(element.id);
    }
    return false;
  }

  private isLazyElementNode(element: TreeNode): boolean {
    const configRoot = this.getConfigurationRoot(element);
    if (!configRoot || !this.loadContextByRootId.has(configRoot.id) || element.properties._lazy !== true) {
      return false;
    }
    if (!element.children || element.children.length === 0) {return true;}
    if (element.type === MetadataType.Subsystem) {
      const hasNonSubsystem = element.children.some((c) => c.type !== MetadataType.Subsystem);
      return !hasNonSubsystem;
    }
    return false;
  }

  /**
   * Parsers may leave a tabular section instance with no children when there are no columns yet.
   * Without the synthetic «Реквизиты» node the item is a leaf and the user cannot add the first column.
   * {@link MetadataParser.loadElementChildren} already fixes this for `_lazy` sections; mirror here for eager nodes.
   */
  private ensureTabularSectionColumnsIfNeeded(node: TreeNode): void {
    if (
      node.parent?.id !== 'TabularSections' ||
      node.type !== MetadataType.TabularSection ||
      !node.id.startsWith('TabularSections.') ||
      node.id === 'TabularSections'
    ) {
      return;
    }
    ensureTabularSectionColumnsPlaceholder(node);
    for (const c of node.children ?? []) {
      if (!this.nodeCache.has(c.id)) {
        this.buildCache(c);
      }
    }
  }

  /** Instance of a tabular section (under folder «Табличные части») always has at least the «Реквизиты» subtree in the UI. */
  private isTabularSectionInstanceNode(element: TreeNode): boolean {
    return (
      element.parent?.id === 'TabularSections' &&
      element.type === MetadataType.TabularSection &&
      element.id.startsWith('TabularSections.') &&
      element.id !== 'TabularSections'
    );
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    try {
      // Collapsible: has children, or lazy type node, or lazy element node (load on expand)
      const hasChildren =
        (element.children && element.children.length > 0) ||
        this.isLazyTypeNode(element) ||
        this.isLazyElementNode(element) ||
        this.isTabularSectionInstanceNode(element);
      const collapsibleState = hasChildren
        ? element.isExpanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

      const treeItem = new vscode.TreeItem(element.name, collapsibleState);

      // Set context value for context menu (Forms folder vs concrete Form node vs BSL module leaf)
      const props = element.properties as Record<string, unknown> | undefined;
      if (element.type === MetadataType.Method && props?.fileType === 'bsl') {
        treeItem.contextValue = 'MethodBsl';
      } else {
        treeItem.contextValue = element.id === 'Forms' ? 'Forms' : element.type;
      }

      const bindingDeco = this.lookupConfigurationBindingDecoration(element);
      // WOW §2D: контекст для «Раскатать в базу/базы» (viewItem when в package.json).
      if (element.type === MetadataType.Configuration) {
        let cv = 'Configuration';
        if (bindingDeco && bindingDeco.boundCount > 0) {
          cv += ' bindingBound';
          // Дизайн §12.5: подпись/иконка от флага массовой раскатки, не от числа баз в списке.
          const many = bindingDeco.massDeployment === true;
          cv += many ? ' deployMany' : ' deployOne';
        }
        treeItem.contextValue = cv;
      } else if (this.isExtensionInfobaseBindingRoot(element)) {
        let cv = 'Extension extensionBindingRoot';
        if (bindingDeco && bindingDeco.boundCount > 0) {
          cv += ' bindingBound';
          const many = bindingDeco.massDeployment === true;
          cv += many ? ' deployMany' : ' deployOne';
        }
        treeItem.contextValue = cv;
      }

      // Set tooltip: name, type, path (additional_req.md п.14)
      const synonym = element.properties.synonym as string | undefined;
      let tooltipText =
        synonym ? `${element.type}: ${element.name}\nСиноним: ${synonym}` : `${element.type}: ${element.name}`;
      const pathStr = this.getPathForTooltip(element);
      if (pathStr) {tooltipText += `\n${pathStr}`;}
      // Highlight match in tooltip when search is active (additional_req.md п.2)
      const q = this.searchQuery.trim();
      if (q && !this.searchUseRegex && this.nodeMatchesSearch(element, q)) {
        tooltipText += `\nНайдено: "${q}"`;
      }
      if (element.type === MetadataType.Configuration) {
        if (bindingDeco && bindingDeco.boundCount > 0) {
          const mass = bindingDeco.massDeployment ? '\nМассовая раскатка: да' : '';
          tooltipText += `\n\nПривязка ИБ: ${bindingDeco.boundCount} баз(ы).${mass}\n${bindingDeco.namesPreview}`;
        } else {
          tooltipText +=
            '\n\nПривязка ИБ: не настроена. Контекстное меню узла → «Привязать базы…».';
        }
      } else if (this.isExtensionInfobaseBindingRoot(element)) {
        if (bindingDeco && bindingDeco.boundCount > 0) {
          const mass = bindingDeco.massDeployment ? '\nМассовая раскатка: да' : '';
          tooltipText += `\n\nПривязка ИБ (расширение): ${bindingDeco.boundCount} баз(ы).${mass}\n${bindingDeco.namesPreview}`;
        } else {
          tooltipText += '\n\nПривязка ИБ расширения: не настроена. Контекстное меню → «Привязать базы…».';
        }
      }
      treeItem.tooltip = tooltipText;

      // Set description (shown next to the label); для Configuration — бейдж числа привязок (§2C)
      const descParts: string[] = [];
      if (synonym) {
        descParts.push(synonym);
      }
      if (
        (element.type === MetadataType.Configuration || this.isExtensionInfobaseBindingRoot(element)) &&
        bindingDeco &&
        bindingDeco.boundCount > 0
      ) {
        descParts.push(`🔗${bindingDeco.boundCount}`);
      }
      if (descParts.length > 0) {
        treeItem.description = descParts.join(' · ');
      }

      // Set icon based on metadata type
      treeItem.iconPath = this.getIconForType(element.type);

      // Remove default file open command - selection will trigger properties panel instead
      // Context menu will provide "Open XML" option for direct file access

      // Set resource URI: Configuration → Configuration.xml in configDir; Form → formXmlPath; else filePath
      if (element.type === MetadataType.Configuration) {
        const configDir = this.getConfigPathForNode(element);
        if (configDir != null) {
          treeItem.resourceUri = vscode.Uri.file(path.join(configDir, 'Configuration.xml'));
        }
      } else if (this.isExtensionInfobaseBindingRoot(element) && element.filePath?.trim()) {
        treeItem.resourceUri = vscode.Uri.file(path.join(element.filePath.trim(), 'Configuration.xml'));
      } else if (element.filePath) {
        if (element.type === MetadataType.Form) {
          const { formXmlPath } = getFormPaths(element.filePath);
          treeItem.resourceUri = vscode.Uri.file(formXmlPath);
        } else {
          treeItem.resourceUri = vscode.Uri.file(element.filePath);
        }
      }

      return treeItem;
    } catch (error) {
      Logger.error('Error creating tree item', error);
      // Return minimal tree item on error
      return new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    }
  }

  /**
   * Get children for a node (lazy loading). When search/type filter is active, returns only children that match or contain matches.
   * For lazy type nodes (structure-only load), loads type contents on first expand.
   */
  getChildren(element?: TreeNode): Thenable<TreeNode[]> {
    try {
      if (!element) {
        if (this.rootNodes.length === 0) {return Promise.resolve([]);}
        if (!this.hasActiveFilter()) {return Promise.resolve(this.rootNodes);}
        this.ensureFilterSets();
        const ids = this.filterAncestorOrVisibleIds!;
        return Promise.resolve(this.rootNodes.filter((r) => ids.has(r.id)));
      }
      const activeElement = this.resolveActiveNode(element);

      // Lazy load: type node with no children yet
      if (this.isLazyTypeNode(activeElement)) {
        const configRoot = this.getConfigurationRoot(activeElement);
        const ctx = configRoot ? this.loadContextByRootId.get(configRoot.id) : undefined;
        if (!ctx) {return Promise.resolve([]);}
        return MetadataParser.parseTypeContents(ctx.configPath, activeElement.id).then((children) => {
          for (const c of children) {
            c.parent = activeElement;
            this.buildCache(c);
          }
          activeElement.children = children;
          for (const c of children) {
            ensureR6PlaceholdersForInstanceNode(c, { configPath: ctx.configPath, format: ctx.format });
          }
          Logger.info('Tree cache size after lazy load', {
            type: activeElement.id,
            nodeCount: this.nodeCache.size,
          });
          this.filterAncestorOrVisibleIds = null;
          this.refresh(activeElement);
          if (!this.hasActiveFilter()) {return children;}
          this.ensureFilterSets();
          const ids = this.filterAncestorOrVisibleIds!;
          return children.filter((c) => ids.has(c.id));
        });
      }

      // Lazy load: element node with _lazy and no children yet (Attributes, Forms, Ext, etc.)
      if (this.isLazyElementNode(activeElement)) {
        const configRoot = this.getConfigurationRoot(activeElement);
        const ctx = configRoot ? this.loadContextByRootId.get(configRoot.id) : undefined;
        if (!ctx) {return Promise.resolve([]);}
        const format = ctx.format;
        if (format == null) {
          return Promise.resolve([]);
        }
        return MetadataParser.loadElementChildren(ctx.configPath, format, activeElement).then(
          (loaded) => {
            const existingSubsystems = (activeElement.children ?? []).filter(
              (c) => c.type === MetadataType.Subsystem
            );
            const children = existingSubsystems.length > 0 ? [...existingSubsystems, ...loaded] : loaded;
            for (const c of loaded) {
              c.parent = activeElement;
              this.buildCache(c);
            }
            activeElement.children = children;
            delete activeElement.properties._lazy;
            Logger.info('Tree cache size after lazy element load', {
              element: activeElement.id,
              nodeCount: this.nodeCache.size,
            });
            this.filterAncestorOrVisibleIds = null;
            this.refresh(activeElement);
            if (!this.hasActiveFilter()) {return children;}
            this.ensureFilterSets();
            const ids = this.filterAncestorOrVisibleIds!;
            return children.filter((c) => ids.has(c.id));
          }
        );
      }

      const configRoot = this.getConfigurationRoot(activeElement);
      const ctx = configRoot ? this.loadContextByRootId.get(configRoot.id) : undefined;
      if (ctx) {
        ensureR6PlaceholdersForInstanceNode(activeElement, { configPath: ctx.configPath, format: ctx.format });
      }

      this.ensureTabularSectionColumnsIfNeeded(activeElement);

      const raw = activeElement.children || [];
      if (!this.hasActiveFilter()) {
        return Promise.resolve(raw);
      }

      this.ensureFilterSets();
      const ids = this.filterAncestorOrVisibleIds!;
      const filtered = raw.filter((c) => ids.has(c.id));
      return Promise.resolve(filtered);
    } catch (error) {
      Logger.error('Error getting children', error);
      return Promise.resolve([]);
    }
  }

  private hasActiveFilter(): boolean {
    return (
      this.searchQuery.trim() !== '' ||
      (this.typeFilter != null && this.typeFilter.size > 0) ||
      this.subsystemFilter.subsystemId != null
    );
  }

  /** Path for tooltip: filePath if set, otherwise parent chain (e.g. "Configuration / Catalogs / MyCatalog"). */
  private getPathForTooltip(element: TreeNode): string {
    if (element.filePath) {return element.filePath;}
    const parts: string[] = [];
    let p: TreeNode | undefined = element.parent;
    while (p) {
      parts.unshift(p.name);
      p = p.parent;
    }
    return parts.length > 0 ? parts.join(' / ') : '';
  }

  private ensureFilterSets(): void {
    if (this.filterAncestorOrVisibleIds != null) {return;}
    const visibleIds = new Set<string>();
    for (const node of this.nodeCache.values()) {
      if (
        this.nodeOrDescendantMatchesSearch(node, this.searchQuery) &&
        this.passesTypeFilter(node) &&
        this.nodePassesSubsystemFilter(node)
      ) {
        visibleIds.add(node.id);
      }
    }
    const ancestorIds = new Set<string>(visibleIds);
    for (const id of visibleIds) {
      let n = this.nodeCache.get(id);
      while (n?.parent) {
        ancestorIds.add(n.parent.id);
        n = n.parent;
      }
    }
    this.filterAncestorOrVisibleIds = ancestorIds;
  }

  /** Ordered list of visible node ids (depth-first) for next/previous match navigation. */
  getVisibleOrderedNodeIds(): string[] {
    if (this.rootNodes.length === 0) {return [];}
    this.ensureFilterSets();
    const ids = this.filterAncestorOrVisibleIds!;
    const out: string[] = [];
    const walk = (n: TreeNode): void => {
      if (!ids.has(n.id)) {return;}
      out.push(n.id);
      for (const c of n.children || []) {walk(c);}
    };
    for (const root of this.rootNodes) {walk(root);}
    return out;
  }

  /** Metadata types offered in the type filter QuickPick. */
  getFilterableMetadataTypes(): MetadataType[] {
    return [...FILTERABLE_METADATA_TYPES];
  }

  /**
   * Get parent for a node
   */
  getParent(element: TreeNode): vscode.ProviderResult<TreeNode> {
    return element.parent || null;
  }

  /**
   * Get icon for metadata type
   */
  private getIconForType(type: MetadataType): vscode.ThemeIcon {
    // Map metadata types to VS Code built-in icons
    const iconMap: Record<MetadataType, string> = {
      // Root
      [MetadataType.Configuration]: 'package',

      // Main types
      [MetadataType.Catalog]: 'book',
      [MetadataType.Document]: 'file-text',
      [MetadataType.Enum]: 'symbol-enum',
      [MetadataType.Report]: 'graph',
      [MetadataType.DataProcessor]: 'gear',
      [MetadataType.ChartOfCharacteristicTypes]: 'symbol-class',
      [MetadataType.ChartOfAccounts]: 'symbol-numeric',
      [MetadataType.ChartOfCalculationTypes]: 'calculator',
      [MetadataType.InformationRegister]: 'database',
      [MetadataType.AccumulationRegister]: 'archive',
      [MetadataType.AccountingRegister]: 'symbol-ruler',
      [MetadataType.CalculationRegister]: 'symbol-operator',
      [MetadataType.BusinessProcess]: 'git-branch',
      [MetadataType.Task]: 'checklist',
      [MetadataType.ExternalDataSource]: 'cloud',
      [MetadataType.Constant]: 'symbol-constant',
      [MetadataType.SessionParameter]: 'symbol-parameter',
      [MetadataType.FilterCriterion]: 'filter',
      [MetadataType.ScheduledJob]: 'watch',
      [MetadataType.FunctionalOption]: 'symbol-boolean',
      [MetadataType.FunctionalOptionsParameter]: 'symbol-variable',
      [MetadataType.SettingsStorage]: 'save',
      [MetadataType.EventSubscription]: 'bell',
      [MetadataType.CommonModule]: 'symbol-module',
      [MetadataType.CommandGroup]: 'folder',
      [MetadataType.Command]: 'terminal',
      [MetadataType.Role]: 'shield',
      [MetadataType.Interface]: 'symbol-interface',
      [MetadataType.Style]: 'paintcan',
      [MetadataType.WebService]: 'globe',
      [MetadataType.HTTPService]: 'server',
      [MetadataType.IntegrationService]: 'plug',
      [MetadataType.Subsystem]: 'folder-library',
      [MetadataType.ExchangePlan]: 'repo-sync',
      [MetadataType.DocumentJournal]: 'notebook',
      [MetadataType.DefinedType]: 'symbol-misc',
      [MetadataType.CommonAttribute]: 'symbol-field',
      [MetadataType.CommonCommand]: 'terminal',
      [MetadataType.CommonForm]: 'layout',
      [MetadataType.CommonPicture]: 'file-media',
      [MetadataType.CommonTemplate]: 'file-code',
      [MetadataType.DocumentNumerator]: 'list-ordered',
      [MetadataType.Language]: 'globe',
      [MetadataType.WSReference]: 'link',
      [MetadataType.XDTOPackage]: 'package',
      [MetadataType.StyleItem]: 'symbol-color',

      // Sub-elements
      [MetadataType.Attribute]: 'symbol-field',
      [MetadataType.TabularSection]: 'table',
      [MetadataType.Form]: 'layout',
      [MetadataType.Template]: 'file-code',
      [MetadataType.CommandSubElement]: 'symbol-method',
      [MetadataType.Recurrence]: 'sync',
      [MetadataType.Method]: 'symbol-method',
      [MetadataType.Parameter]: 'symbol-parameter',

      // Extensions
      [MetadataType.Extension]: 'extensions',

      // Unknown
      [MetadataType.Unknown]: 'question',
    };

    const iconName = iconMap[type] || 'file';
    return new vscode.ThemeIcon(iconName);
  }

  /**
   * Find node by ID (uses cache for performance)
   */
  findNodeById(id: string): TreeNode | null {
    return this.nodeCache.get(id) || null;
  }

  /**
   * Resolve a subsystem composition ref (`Catalog.Name`) to a loaded root object node in the same
   * configuration as `scopeNode`. Returns `null` if invalid or not found in the tree.
   */
  findRootObjectForCompositionRef(ref: string, scopeNode: TreeNode): TreeNode | null {
    if (validateSubsystemCompositionRef(ref) !== null) {
      return null;
    }
    const expectedId = expectedTreeNodeIdForCompositionRef(ref);
    if (!expectedId) {
      return null;
    }
    const candidates = this.nodeCandidatesById.get(expectedId) ?? [];
    const configPath = this.getConfigPathForNode(scopeNode);
    if (candidates.length === 0) {
      return this.nodeCache.get(expectedId) ?? null;
    }
    if (configPath) {
      const scoped = candidates.find((candidate) => this.getConfigPathForNode(candidate) === configPath);
      return scoped ?? null;
    }
    return candidates[0] ?? null;
  }

  /**
   * Returns true when a valid composition ref exists in the workspace cache,
   * but only under another configuration root than `scopeNode`.
   */
  hasCompositionRefInOtherConfiguration(ref: string, scopeNode: TreeNode): boolean {
    if (validateSubsystemCompositionRef(ref) !== null) {
      return false;
    }
    const expectedId = expectedTreeNodeIdForCompositionRef(ref);
    if (!expectedId) {
      return false;
    }
    const candidates = this.nodeCandidatesById.get(expectedId) ?? [];
    if (candidates.length === 0) {
      return false;
    }
    const scopeConfigPath = this.getConfigPathForNode(scopeNode);
    if (!scopeConfigPath) {
      return false;
    }
    const inSameConfig = candidates.some((candidate) => this.getConfigPathForNode(candidate) === scopeConfigPath);
    if (inSameConfig) {
      return false;
    }
    return candidates.some((candidate) => this.getConfigPathForNode(candidate) !== scopeConfigPath);
  }

  /** Resolve possibly stale node reference to active in-memory node. */
  resolveNodeForUi(node: TreeNode): TreeNode {
    return this.resolveActiveNode(node);
  }

  applyOptimisticDelete(node: TreeNode, operationId: string): OptimisticDeleteToken | null {
    const activeNode = this.resolveActiveNode(node);
    const parent = activeNode.parent;
    if (!parent || !parent.children || parent.children.length === 0) {
      return null;
    }

    const removedIndex = parent.children.findIndex((candidate) =>
      candidate === activeNode ||
      (
        candidate.id === activeNode.id &&
        candidate.name === activeNode.name &&
        candidate.type === activeNode.type
      )
    );
    if (removedIndex < 0) {
      return null;
    }

    const [removedNode] = parent.children.splice(removedIndex, 1);
    if (!removedNode) {
      return null;
    }

    const configPath = this.getConfigPathForNode(parent) ?? '';
    const token: OptimisticDeleteToken = {
      configRootId: this.getNodeRootIdentity(parent),
      parentId: parent.id,
      removedNodeId: removedNode.id,
      removedNodeSnapshot: this.cloneNodeForRollback(removedNode),
      removedIndex,
      operationId,
    };
    this.filterAncestorOrVisibleIds = null;
    this.refresh(parent);
    Logger.info('Applied optimistic delete', { operationId, configPath, parentId: parent.id, removedNodeId: removedNode.id });
    return token;
  }

  rollbackOptimisticDelete(token: OptimisticDeleteToken): boolean {
    const parent = this.findRollbackParentNode(token);
    if (!parent) {
      Logger.warn('Rollback skipped: parent not found', { operationId: token.operationId, parentId: token.parentId });
      return false;
    }
    if (!parent.children) {
      parent.children = [];
    }

    const alreadyPresent = parent.children.some((child) => child.id === token.removedNodeId);
    if (alreadyPresent) {
      Logger.debug('Rollback skipped: node already present', { operationId: token.operationId, nodeId: token.removedNodeId });
      return false;
    }

    const restoredNode = this.rehydrateRollbackNode(token.removedNodeSnapshot, parent);
    const insertionIndex = Math.max(0, Math.min(token.removedIndex, parent.children.length));
    parent.children.splice(insertionIndex, 0, restoredNode);
    this.buildCache(restoredNode);
    this.filterAncestorOrVisibleIds = null;
    this.refresh(parent);
    Logger.warn('Optimistic delete rolled back', { operationId: token.operationId, parentId: token.parentId, nodeId: token.removedNodeId });
    return true;
  }

  private findRollbackParentNode(token: OptimisticDeleteToken): TreeNode | null {
    const candidates = this.nodeCandidatesById.get(token.parentId) ?? [];
    if (candidates.length === 0) {
      return null;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }
    const scoped = candidates.find((candidate) => this.getNodeRootIdentity(candidate) === token.configRootId);
    return scoped ?? candidates[0];
  }

  /**
   * Find nodes by name (uses name index for fast lookup). For Stage 6 search.
   * @param query Normalized (e.g. lowercase) or exact name to match
   * @returns Nodes whose name matches (includes partial match if index is extended)
   */
  findNodesByName(query: string): TreeNode[] {
    const key = (query || '').toLowerCase().trim();
    if (!key) {return [];}
    const ids = this.nameIndex.get(key);
    if (!ids) {return [];}
    const out: TreeNode[] = [];
    for (const id of ids) {
      const node = this.nodeCache.get(id);
      if (node) {out.push(node);}
    }
    return out;
  }

  /**
   * Expand node
   */
  expandNode(node: TreeNode): void {
    node.isExpanded = true;
    this.refresh(node);
  }

  /**
   * Collapse node
   */
  collapseNode(node: TreeNode): void {
    node.isExpanded = false;
    this.refresh(node);
  }

  /**
   * Returns referenceable objects for the type editor: each reference kind with its project object names.
   * Aggregates from all configuration roots (first root used for kind order; names merged per kind).
   */
  getReferenceableObjects(): ReferenceableGroup[] {
    const refKindOrder = [
      'CatalogRef',
      'DocumentRef',
      'EnumRef',
      'ChartOfCharacteristicTypesRef',
      'ChartOfAccountsRef',
      'ChartOfCalculationTypesRef',
    ];
    const byKind = new Map<string, Set<string>>();
    for (const root of this.rootNodes) {
      if (!root.children) {continue;}
      for (const node of root.children) {
        if (!REFERENCEABLE_METADATA_TYPES.has(node.type)) {continue;}
        const referenceKind = METADATA_TYPE_TO_REFERENCE_KIND[node.type];
        if (!referenceKind) {continue;}
        const names = (node.children || []).map((c) => c.name);
        const set = byKind.get(referenceKind) ?? new Set<string>();
        names.forEach((n) => set.add(n));
        byKind.set(referenceKind, set);
      }
    }
    return refKindOrder.map((refKind) => ({
      referenceKind: refKind,
      objectNames: Array.from(byKind.get(refKind) ?? []),
    }));
  }

  /**
   * Returns referenceable objects for the type editor, ensuring that the underlying
   * metadata type nodes (Catalogs/Documents/Enums/...) are loaded.
   *
   * Problem: parseStructureOnly() creates type nodes with empty `children` (lazy loading).
   * If type editor gets an empty list, it can't offer "DocumentRef.<...>" selection.
   */
  public async getReferenceableObjectsForTypeEditor(node?: TreeNode): Promise<ReferenceableGroup[]> {
    // Determine which configuration root we should use.
    // If `node` is provided, we restrict loading/aggregation to that configuration only.
    const configRoot = (() => {
      if (!node) {return null;}
      let cur: TreeNode | undefined = node;
      while (cur) {
        const curNode: TreeNode = cur;
        if (curNode.type === MetadataType.Configuration && this.rootNodes.some((r) => r.id === curNode.id)) {
          return curNode;
        }
        cur = curNode.parent;
      }
      return null;
    })();

    const rootsToUse = configRoot ? [configRoot] : this.rootNodes;

    // Load missing type contents (if `children` are empty) so that objectNames are available.
    for (const root of rootsToUse) {
      if (!root.children || root.children.length === 0) {continue;}

      const configPath =
        this.loadContextByRootId.get(root.id)?.configPath ??
        (root.filePath ? path.dirname(root.filePath) : null);

      if (!configPath) {continue;}

      for (const typeNode of root.children) {
        if (!REFERENCEABLE_METADATA_TYPES.has(typeNode.type)) {continue;}
        if (typeNode.children && typeNode.children.length > 0) {continue;}

        try {
          const children = await MetadataParser.parseTypeContents(configPath, typeNode.id);
          for (const c of children) {c.parent = typeNode;}
          typeNode.children = children;

          // Update in-memory caches so other features can use the newly loaded nodes.
          for (const c of children) {this.buildCache(c);}
        } catch (e) {
          Logger.warn('Failed to eager load referenceable type contents for type editor', {
            configPath,
            typeNodeId: typeNode.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    // Aggregate only for selected roots.
    if (!rootsToUse.length) {return [];}

    const refKindOrder = [
      'CatalogRef',
      'DocumentRef',
      'EnumRef',
      'ChartOfCharacteristicTypesRef',
      'ChartOfAccountsRef',
      'ChartOfCalculationTypesRef',
    ];
    const byKind = new Map<string, Set<string>>();
    for (const root of rootsToUse) {
      if (!root.children) {continue;}
      for (const child of root.children) {
        if (!REFERENCEABLE_METADATA_TYPES.has(child.type)) {continue;}
        const referenceKind = METADATA_TYPE_TO_REFERENCE_KIND[child.type];
        if (!referenceKind) {continue;}
        const names = (child.children || []).map((c: TreeNode) => c.name);
        const set = byKind.get(referenceKind) ?? new Set<string>();
        names.forEach((n: string) => set.add(n));
        byKind.set(referenceKind, set);
      }
    }

    return refKindOrder.map((refKind) => ({
      referenceKind: refKind,
      objectNames: Array.from(byKind.get(refKind) ?? []),
    }));
  }

  private cloneNodeForRollback(node: TreeNode): TreeNode {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      properties: { ...node.properties },
      filePath: node.filePath,
      parentFilePath: node.parentFilePath,
      isExpanded: node.isExpanded,
      children: (node.children ?? []).map((child) => this.cloneNodeForRollback(child)),
    };
  }

  private rehydrateRollbackNode(node: TreeNode, parent?: TreeNode): TreeNode {
    const restored: TreeNode = {
      id: node.id,
      name: node.name,
      type: node.type,
      parent,
      properties: { ...node.properties },
      filePath: node.filePath,
      parentFilePath: node.parentFilePath,
      isExpanded: node.isExpanded,
      children: [],
    };
    restored.children = (node.children ?? []).map((child) => this.rehydrateRollbackNode(child, restored));
    return restored;
  }
}
