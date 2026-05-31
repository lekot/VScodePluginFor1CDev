import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';

/** Main metadata types shown in type filter QuickPick. */
export const FILTERABLE_METADATA_TYPES: MetadataType[] = [
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
 * Encapsulates all search/filter state and matching logic for the metadata tree.
 * Used by MetadataTreeDataProvider to determine which nodes are visible.
 */
export class TreeFilterService {
  private searchQuery = '';
  private searchBySynonymComment = false;
  private searchUseRegex = false;
  private typeFilter: Set<MetadataType> | null = null;
  private subsystemFilter: { subsystemId: string | null; subsystemName: string | null } = {
    subsystemId: null,
    subsystemName: null,
  };
  private searchHistory: string[] = [];
  /** Cached set of node ids that are visible or are ancestors of visible nodes. */
  filterAncestorOrVisibleIds: Set<string> | null = null;

  // --- Search query ---

  setSearchQuery(query: string): void {
    this.searchQuery = (query || '').trim();
    this.filterAncestorOrVisibleIds = null;
  }

  getSearchQuery(): string {
    return this.searchQuery;
  }

  /** Display form of search query: *query* for plain substring search, else as-is. */
  getSearchQueryForDisplay(): string {
    const q = this.searchQuery.trim();
    if (!q) {return q;}
    if (this.searchUseRegex) {return q;}
    const trimmed = q;
    if (trimmed.startsWith('*') || trimmed.endsWith('*')) {return trimmed;}
    return `*${trimmed}*`;
  }

  setSearchOptions(options: { bySynonymComment?: boolean; useRegex?: boolean }): void {
    if (options.bySynonymComment !== undefined) {this.searchBySynonymComment = options.bySynonymComment;}
    if (options.useRegex !== undefined) {this.searchUseRegex = options.useRegex;}
    this.filterAncestorOrVisibleIds = null;
  }

  get rawSearchQuery(): string {
    return this.searchQuery;
  }

  get isRegex(): boolean {
    return this.searchUseRegex;
  }

  // --- Type filter ---

  setTypeFilter(types: MetadataType[] | null): void {
    this.typeFilter = types && types.length > 0 ? new Set(types) : null;
    this.filterAncestorOrVisibleIds = null;
  }

  getTypeFilter(): MetadataType[] | null {
    return this.typeFilter ? Array.from(this.typeFilter) : null;
  }

  // --- Subsystem filter ---

  setSubsystemFilter(subsystemId: string | null, subsystemName: string | null): void {
    this.subsystemFilter.subsystemId = subsystemId;
    this.subsystemFilter.subsystemName = subsystemName;
    this.filterAncestorOrVisibleIds = null;
  }

  getSubsystemFilter(): { subsystemId: string | null; subsystemName: string | null } {
    return { ...this.subsystemFilter };
  }

  get activeSubsystemId(): string | null {
    return this.subsystemFilter.subsystemId;
  }

  getSubsystemFilterLabel(): string | null {
    if (!this.subsystemFilter.subsystemId || !this.subsystemFilter.subsystemName) {
      return null;
    }
    return `Подсистема: ${this.subsystemFilter.subsystemName}`;
  }

  // --- Clear / history ---

  clearAll(): void {
    this.searchQuery = '';
    this.typeFilter = null;
    this.subsystemFilter.subsystemId = null;
    this.subsystemFilter.subsystemName = null;
    this.filterAncestorOrVisibleIds = null;
  }

  addSearchToHistory(query: string): void {
    const q = (query || '').trim();
    if (!q) {return;}
    this.searchHistory = [q, ...this.searchHistory.filter((x) => x !== q)].slice(0, MAX_SEARCH_HISTORY);
  }

  getSearchHistory(): string[] {
    return [...this.searchHistory];
  }

  // --- Active filter check ---

  hasActiveFilter(): boolean {
    return (
      this.searchQuery.trim() !== '' ||
      (this.typeFilter != null && this.typeFilter.size > 0) ||
      this.subsystemFilter.subsystemId != null
    );
  }

  /** Build filter message parts for display in the UI status area. */
  buildFilterMessageParts(): string[] {
    const parts: string[] = [];
    if (this.searchQuery.trim()) {parts.push(`Поиск: ${this.getSearchQueryForDisplay()}`);}
    if (this.typeFilter && this.typeFilter.size > 0) {parts.push(`Типы: ${this.typeFilter.size}`);}
    const subsystemLabel = this.getSubsystemFilterLabel();
    if (subsystemLabel) {parts.push(subsystemLabel);}
    return parts;
  }

  // --- Node matching ---

  nodeMatchesSearch(node: TreeNode, query: string): boolean {
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

  nodeOrDescendantMatchesSearch(node: TreeNode, query: string): boolean {
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

  passesTypeFilter(node: TreeNode): boolean {
    if (!this.typeFilter || this.typeFilter.size === 0) {return true;}
    return this.typeFilter.has(node.type) || this.hasDescendantWithTypeInFilter(node);
  }

  /**
   * Subsystem filter contract (ADR 0001): a node passes if (1) no filter, or (2) node is the
   * selected subsystem or its ancestor, or (3) node is in the Content of the selected subsystem
   * or in the Content of any of its descendant subsystems (recursively).
   */
  nodePassesSubsystemFilter(node: TreeNode, nodeCache: ReadonlyMap<string, TreeNode>): boolean {
    if (!this.subsystemFilter.subsystemId) {
      return true;
    }

    // Check if node is ancestor of the subsystem (Configuration → Subsystems → SelectedSubsystem)
    let current: TreeNode | undefined = node;
    while (current) {
      if (
        current.id === this.subsystemFilter.subsystemId &&
        current.type === MetadataType.Subsystem
      ) {
        return true;
      }
      current = current.parent;
    }

    const subsystemNode = nodeCache.get(this.subsystemFilter.subsystemId);
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
  collectSubsystemAndDescendants(subsystemNode: TreeNode): TreeNode[] {
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
  nodeMatchesContentRef(node: TreeNode, refText: string): boolean {
    const parts = refText.split('.');
    if (parts.length < 2) {
      return false;
    }

    const refType = parts[0];
    const refName = parts.slice(1).join('.'); // Handle names with dots

    if (node.type === refType && node.name === refName) {
      return true;
    }

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
   * Compute (and cache) the set of node IDs that are either directly visible or are
   * ancestors of visible nodes. Must be called before filtering children.
   */
  ensureFilterSets(nodeCache: ReadonlyMap<string, TreeNode>): void {
    if (this.filterAncestorOrVisibleIds != null) {return;}
    const visibleIds = new Set<string>();
    for (const node of nodeCache.values()) {
      if (
        this.nodeOrDescendantMatchesSearch(node, this.searchQuery) &&
        this.passesTypeFilter(node) &&
        this.nodePassesSubsystemFilter(node, nodeCache)
      ) {
        visibleIds.add(node.id);
      }
    }
    const ancestorIds = new Set<string>(visibleIds);
    for (const id of visibleIds) {
      let n = nodeCache.get(id);
      while (n?.parent) {
        ancestorIds.add(n.parent.id);
        n = n.parent;
      }
    }
    this.filterAncestorOrVisibleIds = ancestorIds;
    Logger.debug('Filter sets computed', { visibleCount: visibleIds.size, ancestorCount: ancestorIds.size });
  }

  // --- Static helpers ---

  /** Human-readable labels for filterable types. */
  static getFilterableTypeLabels(): { type: MetadataType; label: string }[] {
    const labels: Record<MetadataType, string> = {
      [MetadataType.ConfigurationPackage]: 'Configuration package',
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
      [MetadataType.EnumValue]: 'Значение перечисления',
      [MetadataType.Dimension]: 'Измерение',
      [MetadataType.Resource]: 'Ресурс',
      [MetadataType.Extension]: 'Расширение',
      [MetadataType.PredefinedItem]: 'Предопределённый элемент',
      [MetadataType.Unknown]: 'Неизвестный',
    };
    return FILTERABLE_METADATA_TYPES.map((type) => ({ type, label: labels[type] ?? type }));
  }
}
