import * as vscode from 'vscode';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { getFormPaths } from '../formEditor/formPaths';
import type { ReferenceableGroup } from '../types/typeDefinitions';
import { MetadataParser } from '../parsers/metadataParser';
import { ConfigFormat } from '../parsers/formatDetector';
import { MESSAGES } from '../constants/messages';

/** MetadataType → reference kind string for type editor. */
const METADATA_TYPE_TO_REFERENCE_KIND: Record<MetadataType, string | undefined> = {
  [MetadataType.Catalog]: 'CatalogRef',
  [MetadataType.Document]: 'DocumentRef',
  [MetadataType.Enum]: 'EnumRef',
  [MetadataType.ChartOfCharacteristicTypes]: 'ChartOfCharacteristicTypesRef',
  [MetadataType.ChartOfAccounts]: 'ChartOfAccountsRef',
  [MetadataType.ChartOfCalculationTypes]: 'ChartOfCalculationTypesRef',
  [MetadataType.Configuration]: undefined,
  [MetadataType.Report]: undefined,
  [MetadataType.DataProcessor]: undefined,
  [MetadataType.InformationRegister]: undefined,
  [MetadataType.AccumulationRegister]: undefined,
  [MetadataType.AccountingRegister]: undefined,
  [MetadataType.CalculationRegister]: undefined,
  [MetadataType.BusinessProcess]: undefined,
  [MetadataType.Task]: undefined,
  [MetadataType.ExternalDataSource]: undefined,
  [MetadataType.Constant]: undefined,
  [MetadataType.SessionParameter]: undefined,
  [MetadataType.FilterCriterion]: undefined,
  [MetadataType.ScheduledJob]: undefined,
  [MetadataType.FunctionalOption]: undefined,
  [MetadataType.FunctionalOptionsParameter]: undefined,
  [MetadataType.SettingsStorage]: undefined,
  [MetadataType.EventSubscription]: undefined,
  [MetadataType.CommonModule]: undefined,
  [MetadataType.CommandGroup]: undefined,
  [MetadataType.Command]: undefined,
  [MetadataType.Role]: undefined,
  [MetadataType.Interface]: undefined,
  [MetadataType.Style]: undefined,
  [MetadataType.WebService]: undefined,
  [MetadataType.HTTPService]: undefined,
  [MetadataType.IntegrationService]: undefined,
  [MetadataType.Subsystem]: undefined,
  [MetadataType.Attribute]: undefined,
  [MetadataType.TabularSection]: undefined,
  [MetadataType.Form]: undefined,
  [MetadataType.Template]: undefined,
  [MetadataType.CommandSubElement]: undefined,
  [MetadataType.Recurrence]: undefined,
  [MetadataType.Method]: undefined,
  [MetadataType.Parameter]: undefined,
  [MetadataType.Extension]: undefined,
  [MetadataType.Unknown]: undefined,
};

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
  /** Normalized name (lowercase) → node ids, for fast search (Stage 8.3). */
  private nameIndex = new Map<string, string[]>();
  /** Per-root load context for lazy loading (key = root node id). */
  private loadContextByRootId = new Map<string, { configPath: string; format: ConfigFormat }>();

  private searchQuery = '';
  private searchBySynonymComment = false;
  private searchUseRegex = false;
  private typeFilter: Set<MetadataType> | null = null;
  private searchHistory: string[] = [];
  private filterAncestorOrVisibleIds: Set<string> | null = null;
  private messageUpdater: ((message: string | undefined) => void) | null = null;

  constructor(_context: vscode.ExtensionContext) {
    Logger.info('MetadataTreeDataProvider initialized');
  }

  setMessageUpdater(updater: (message: string | undefined) => void): void {
    this.messageUpdater = updater;
  }

  /** Display form of search query: *query* for plain substring search, else as-is (additional_req.md п.2). */
  private getSearchQueryForDisplay(): string {
    const q = this.searchQuery.trim();
    if (!q) return q;
    if (this.searchUseRegex) return q;
    const trimmed = q;
    if (trimmed.startsWith('*') || trimmed.endsWith('*')) return trimmed;
    return `*${trimmed}*`;
  }

  private updateFilterMessage(): void {
    if (!this.messageUpdater) return;
    const parts: string[] = [];
    if (this.searchQuery.trim()) parts.push(`Поиск: ${this.getSearchQueryForDisplay()}`);
    if (this.typeFilter && this.typeFilter.size > 0) parts.push(`Типы: ${this.typeFilter.size}`);
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
    if (options.bySynonymComment !== undefined) this.searchBySynonymComment = options.bySynonymComment;
    if (options.useRegex !== undefined) this.searchUseRegex = options.useRegex;
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

  clearSearch(): void {
    this.searchQuery = '';
    this.typeFilter = null;
    this.filterAncestorOrVisibleIds = null;
    this.updateFilterMessage();
    this.refresh();
  }

  addSearchToHistory(query: string): void {
    const q = (query || '').trim();
    if (!q) return;
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
    if (!query) return true;
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

    if (testString(name)) return true;
    if (this.searchBySynonymComment && (testString(synonym) || testString(comment))) return true;
    return false;
  }

  private nodeOrDescendantMatchesSearch(node: TreeNode, query: string): boolean {
    if (!query) return true;
    if (this.nodeMatchesSearch(node, query)) return true;
    if (node.children) {
      for (const child of node.children) {
        if (this.nodeOrDescendantMatchesSearch(child, query)) return true;
      }
    }
    return false;
  }

  private hasDescendantWithTypeInFilter(node: TreeNode): boolean {
    if (!this.typeFilter || this.typeFilter.size === 0) return true;
    if (this.typeFilter.has(node.type)) return true;
    if (node.children) {
      for (const child of node.children) {
        if (this.hasDescendantWithTypeInFilter(child)) return true;
      }
    }
    return false;
  }

  private passesTypeFilter(node: TreeNode): boolean {
    if (!this.typeFilter || this.typeFilter.size === 0) return true;
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
    if (loadContext) this.loadContextByRootId.set(node.id, loadContext);
    this.nodeCache.clear();
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
    this.nameIndex.clear();
    for (const node of nodes) this.buildCache(node);
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
    if (!first) return null;
    return this.loadContextByRootId.get(first.id)?.configPath ?? first.filePath ?? null;
  }

  /**
   * Get configuration root path for a node (walk up to Configuration node, return its filePath).
   */
  getConfigPathForNode(node: TreeNode): string | null {
    let n: TreeNode | undefined = node;
    while (n) {
      if (n.type === MetadataType.Configuration && n.filePath) return n.filePath;
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
    if (!q) return [];
    const result: TreeNode[] = [];
    for (const [key, ids] of this.nameIndex) {
      if (key.includes(q)) {
        for (const id of ids) {
          const node = this.nodeCache.get(id);
          if (node) result.push(node);
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

  private getConfigurationRoot(node: TreeNode): TreeNode | null {
    let n: TreeNode | undefined = node;
    while (n) {
      if (n.type === MetadataType.Configuration) return n;
      n = n.parent;
    }
    return null;
  }

  /**
   * Get tree item for a node
   */
  private isLazyTypeNode(element: TreeNode): boolean {
    const root = element.parent && this.rootNodes.includes(element.parent) ? element.parent : null;
    return (
      root !== null &&
      this.loadContextByRootId.has(root.id) &&
      (!element.children || element.children.length === 0)
    );
  }

  private isLazyElementNode(element: TreeNode): boolean {
    const configRoot = this.getConfigurationRoot(element);
    return (
      configRoot !== null &&
      this.loadContextByRootId.has(configRoot.id) &&
      element.properties._lazy === true &&
      (!element.children || element.children.length === 0)
    );
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    try {
      // Collapsible: has children, or lazy type node, or lazy element node (load on expand)
      const hasChildren =
        (element.children && element.children.length > 0) ||
        this.isLazyTypeNode(element) ||
        this.isLazyElementNode(element);
      const collapsibleState = hasChildren
        ? element.isExpanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

      const treeItem = new vscode.TreeItem(element.name, collapsibleState);

      // Set context value for context menu (Forms folder vs concrete Form node)
      treeItem.contextValue = element.id === 'Forms' ? 'Forms' : element.type;

      // Set tooltip: name, type, path (additional_req.md п.14)
      const synonym = element.properties.synonym as string | undefined;
      let tooltipText =
        synonym ? `${element.type}: ${element.name}\nСиноним: ${synonym}` : `${element.type}: ${element.name}`;
      const pathStr = this.getPathForTooltip(element);
      if (pathStr) tooltipText += `\n${pathStr}`;
      // Highlight match in tooltip when search is active (additional_req.md п.2)
      const q = this.searchQuery.trim();
      if (q && !this.searchUseRegex && this.nodeMatchesSearch(element, q)) {
        tooltipText += `\nНайдено: "${q}"`;
      }
      treeItem.tooltip = tooltipText;

      // Set description (shown next to the label)
      if (synonym) {
        treeItem.description = synonym;
      }

      // Set icon based on metadata type
      treeItem.iconPath = this.getIconForType(element.type);

      // Remove default file open command - selection will trigger properties panel instead
      // Context menu will provide "Open XML" option for direct file access

      // Set resource URI: for Form open Ext/Form.xml in form editor, else open metadata file
      if (element.filePath) {
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
        if (this.rootNodes.length === 0) return Promise.resolve([]);
        if (!this.hasActiveFilter()) return Promise.resolve(this.rootNodes);
        this.ensureFilterSets();
        const ids = this.filterAncestorOrVisibleIds!;
        return Promise.resolve(this.rootNodes.filter((r) => ids.has(r.id)));
      }

      // Lazy load: type node with no children yet
      if (this.isLazyTypeNode(element) && element.parent) {
        const ctx = this.loadContextByRootId.get(element.parent.id);
        if (!ctx) return Promise.resolve([]);
        return MetadataParser.parseTypeContents(ctx.configPath, element.id).then((children) => {
          for (const c of children) {
            c.parent = element;
            this.buildCache(c);
          }
          element.children = children;
          Logger.info('Tree cache size after lazy load', {
            type: element.id,
            nodeCount: this.nodeCache.size,
          });
          this.filterAncestorOrVisibleIds = null;
          this.refresh(element);
          if (!this.hasActiveFilter()) return children;
          this.ensureFilterSets();
          const ids = this.filterAncestorOrVisibleIds!;
          return children.filter((c) => ids.has(c.id));
        });
      }

      // Lazy load: element node with _lazy and no children yet (Attributes, Forms, Ext, etc.)
      if (this.isLazyElementNode(element)) {
        const configRoot = this.getConfigurationRoot(element);
        const ctx = configRoot ? this.loadContextByRootId.get(configRoot.id) : undefined;
        if (!ctx) return Promise.resolve([]);
        const format = ctx.format;
        if (format == null) {
          return Promise.resolve([]);
        }
        return MetadataParser.loadElementChildren(ctx.configPath, format, element).then(
          (children) => {
            for (const c of children) {
              c.parent = element;
              this.buildCache(c);
            }
            element.children = children;
            delete element.properties._lazy;
            Logger.info('Tree cache size after lazy element load', {
              element: element.id,
              nodeCount: this.nodeCache.size,
            });
            this.filterAncestorOrVisibleIds = null;
            this.refresh(element);
            if (!this.hasActiveFilter()) return children;
            this.ensureFilterSets();
            const ids = this.filterAncestorOrVisibleIds!;
            return children.filter((c) => ids.has(c.id));
          }
        );
      }

      const raw = element.children || [];
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
    return this.searchQuery.trim() !== '' || (this.typeFilter != null && this.typeFilter.size > 0);
  }

  /** Path for tooltip: filePath if set, otherwise parent chain (e.g. "Configuration / Catalogs / MyCatalog"). */
  private getPathForTooltip(element: TreeNode): string {
    if (element.filePath) return element.filePath;
    const parts: string[] = [];
    let p: TreeNode | undefined = element.parent;
    while (p) {
      parts.unshift(p.name);
      p = p.parent;
    }
    return parts.length > 0 ? parts.join(' / ') : '';
  }

  private ensureFilterSets(): void {
    if (this.filterAncestorOrVisibleIds != null) return;
    const visibleIds = new Set<string>();
    for (const node of this.nodeCache.values()) {
      if (this.nodeOrDescendantMatchesSearch(node, this.searchQuery) && this.passesTypeFilter(node)) {
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
    if (this.rootNodes.length === 0) return [];
    this.ensureFilterSets();
    const ids = this.filterAncestorOrVisibleIds!;
    const out: string[] = [];
    const walk = (n: TreeNode): void => {
      if (!ids.has(n.id)) return;
      out.push(n.id);
      for (const c of n.children || []) walk(c);
    };
    for (const root of this.rootNodes) walk(root);
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
   * Find nodes by name (uses name index for fast lookup). For Stage 6 search.
   * @param query Normalized (e.g. lowercase) or exact name to match
   * @returns Nodes whose name matches (includes partial match if index is extended)
   */
  findNodesByName(query: string): TreeNode[] {
    const key = (query || '').toLowerCase().trim();
    if (!key) return [];
    const ids = this.nameIndex.get(key);
    if (!ids) return [];
    const out: TreeNode[] = [];
    for (const id of ids) {
      const node = this.nodeCache.get(id);
      if (node) out.push(node);
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
      if (!root.children) continue;
      for (const node of root.children) {
        if (!REFERENCEABLE_METADATA_TYPES.has(node.type)) continue;
        const referenceKind = METADATA_TYPE_TO_REFERENCE_KIND[node.type];
        if (!referenceKind) continue;
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
}
