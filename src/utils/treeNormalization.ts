import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { ConfigFormat } from '../parsers/formatDetector';
import { Logger } from './logger';

export type NormalizeContext = {
  configPath: string;
  format: ConfigFormat;
};

type PlaceholderDef = {
  /** Stable node id (provider-lazy loading depends on folder/name ids when applicable). */
  id: string;
  /** Display name (Russian, as in 1C configurator). */
  name: string;
  /** Technical type used by provider for icon/context and for lazy routing where possible. */
  type: MetadataType;
  /** Folder / type id for EDT/Designer file paths (when file-backed placeholders). */
  typeDirName?: string;
};

function getPlaceholderTypeFilePath(ctx: NormalizeContext, typeDirName: string): string {
  // EDT keeps metadata under `src/<TypeDir>/...`, Designer uses `<configRoot>/<TypeDir>/...`.
  return ctx.format === ConfigFormat.EDT
    ? path.join(ctx.configPath, 'src', typeDirName)
    : path.join(ctx.configPath, typeDirName);
}

function ensureChildrenArray(node: TreeNode): void {
  node.children = node.children ?? [];
}

function upsertChildNode(parent: TreeNode, def: PlaceholderDef, ctx: NormalizeContext): void {
  ensureChildrenArray(parent);

  const existing = parent.children!.find((c) => c.id === def.id);
  if (existing) {
    // Never wipe or replace existing children — real content (e.g. loaded Attributes/Forms) must be preserved.
    existing.name = def.name;
    existing.type = existing.type ?? def.type;
    existing.properties = existing.properties ?? {};
    (existing.properties as Record<string, unknown>).type = (existing.properties as Record<string, unknown>).type ?? def.id;

    existing.filePath =
      existing.filePath ?? (def.typeDirName ? getPlaceholderTypeFilePath(ctx, def.typeDirName) : undefined);
    existing.parent = parent;
    if (existing.children === undefined) {
      existing.children = [];
    }
    return;
  }

  const placeholder: TreeNode = {
    id: def.id,
    name: def.name,
    type: def.type,
    properties: def.typeDirName ? { type: def.id } : { type: def.id },
    children: [],
    filePath: def.typeDirName ? getPlaceholderTypeFilePath(ctx, def.typeDirName) : undefined,
    parent,
  };

  parent.children!.push(placeholder);
}

function reorderChildrenByIds(node: TreeNode, orderedIds: string[]): void {
  if (!node.children) {
    return;
  }
  const orderIndex = new Map<string, number>(orderedIds.map((id, i) => [id, i]));
  node.children.sort((a, b) => {
    const ai = orderIndex.has(a.id) ? orderIndex.get(a.id)! : Number.POSITIVE_INFINITY;
    const bi = orderIndex.has(b.id) ? orderIndex.get(b.id)! : Number.POSITIVE_INFINITY;
    if (ai !== bi) {
      return ai - bi;
    }
    // Keep deterministic order for "unknown" children.
    return a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' });
  });
}

const R4_TOP_LEVEL_ORDER: ReadonlyArray<PlaceholderDef> = [
  // R5 group "Общие" (UI-only placeholder group).
  { id: 'Common', name: 'Общие', type: MetadataType.Unknown },
  // R4 supported (folder-backed) types.
  { id: 'Constants', name: 'Константы', type: MetadataType.Constant, typeDirName: 'Constants' },
  { id: 'Catalogs', name: 'Справочники', type: MetadataType.Catalog, typeDirName: 'Catalogs' },
  { id: 'Documents', name: 'Документы', type: MetadataType.Document, typeDirName: 'Documents' },
  { id: 'ExchangePlans', name: 'Планы обмена', type: MetadataType.ExchangePlan, typeDirName: 'ExchangePlans' },
  { id: 'DocumentJournals', name: 'Журналы документов', type: MetadataType.DocumentJournal, typeDirName: 'DocumentJournals' },
  { id: 'DocumentNumerators', name: 'Нумераторы документов', type: MetadataType.DocumentNumerator, typeDirName: 'DocumentNumerators' },
  { id: 'Enums', name: 'Перечисления', type: MetadataType.Enum, typeDirName: 'Enums' },
  { id: 'Reports', name: 'Отчеты', type: MetadataType.Report, typeDirName: 'Reports' },
  { id: 'DataProcessors', name: 'Обработки', type: MetadataType.DataProcessor, typeDirName: 'DataProcessors' },
  { id: 'ChartsOfCharacteristicTypes', name: 'Планы видов характеристик', type: MetadataType.ChartOfCharacteristicTypes, typeDirName: 'ChartsOfCharacteristicTypes' },
  { id: 'ChartsOfAccounts', name: 'Планы счетов', type: MetadataType.ChartOfAccounts, typeDirName: 'ChartsOfAccounts' },
  { id: 'ChartsOfCalculationTypes', name: 'Планы видов расчета', type: MetadataType.ChartOfCalculationTypes, typeDirName: 'ChartsOfCalculationTypes' },
  { id: 'InformationRegisters', name: 'Регистры сведений', type: MetadataType.InformationRegister, typeDirName: 'InformationRegisters' },
  { id: 'AccumulationRegisters', name: 'Регистры накопления', type: MetadataType.AccumulationRegister, typeDirName: 'AccumulationRegisters' },
  { id: 'AccountingRegisters', name: 'Регистры бухгалтерии', type: MetadataType.AccountingRegister, typeDirName: 'AccountingRegisters' },
  { id: 'CalculationRegisters', name: 'Регистры расчета', type: MetadataType.CalculationRegister, typeDirName: 'CalculationRegisters' },
  { id: 'BusinessProcesses', name: 'Бизнес-процессы', type: MetadataType.BusinessProcess, typeDirName: 'BusinessProcesses' },
  { id: 'Tasks', name: 'Задачи', type: MetadataType.Task, typeDirName: 'Tasks' },
  { id: 'ExternalDataSources', name: 'Внешние источники данных', type: MetadataType.ExternalDataSource, typeDirName: 'ExternalDataSources' },
];

const R5_COMMON_CHILD_ORDER: ReadonlyArray<PlaceholderDef> = [
  { id: 'Subsystems', name: 'Подсистемы', type: MetadataType.Subsystem, typeDirName: 'Subsystems' },
  { id: 'CommonModules', name: 'Общие модули', type: MetadataType.CommonModule, typeDirName: 'CommonModules' },
  { id: 'CommonAttributes', name: 'Общие реквизиты', type: MetadataType.CommonAttribute, typeDirName: 'CommonAttributes' },
  { id: 'SessionParameters', name: 'Параметры сеанса', type: MetadataType.SessionParameter, typeDirName: 'SessionParameters' },
  { id: 'Roles', name: 'Роли', type: MetadataType.Role, typeDirName: 'Roles' },
  { id: 'FilterCriteria', name: 'Критерии отбора', type: MetadataType.FilterCriterion, typeDirName: 'FilterCriteria' },
  { id: 'EventSubscriptions', name: 'Подписки на события', type: MetadataType.EventSubscription, typeDirName: 'EventSubscriptions' },
  { id: 'ScheduledJobs', name: 'Регламентные задания', type: MetadataType.ScheduledJob, typeDirName: 'ScheduledJobs' },

  // UI-only placeholders without code mapping.
  { id: 'Bots', name: 'Боты', type: MetadataType.Unknown },
  { id: 'FunctionalOptions', name: 'Функциональные опции', type: MetadataType.FunctionalOption, typeDirName: 'FunctionalOptions' },
  { id: 'FunctionalOptionsParameters', name: 'Параметры функциональных опций', type: MetadataType.FunctionalOptionsParameter, typeDirName: 'FunctionalOptionsParameters' },
  { id: 'DefinedTypes', name: 'Определяемые типы', type: MetadataType.DefinedType, typeDirName: 'DefinedTypes' },
  { id: 'SettingsStorages', name: 'Хранилища настроек', type: MetadataType.SettingsStorage, typeDirName: 'SettingsStorages' },
  { id: 'CommonCommands', name: 'Общие команды', type: MetadataType.CommonCommand, typeDirName: 'CommonCommands' },
  { id: 'CommandGroups', name: 'Группы команд', type: MetadataType.CommandGroup, typeDirName: 'CommandGroups' },
  { id: 'CommonForms', name: 'Общие формы', type: MetadataType.CommonForm, typeDirName: 'CommonForms' },
  { id: 'CommonTemplates', name: 'Общие макеты', type: MetadataType.CommonTemplate, typeDirName: 'CommonTemplates' },
  { id: 'CommonPictures', name: 'Общие картинки', type: MetadataType.CommonPicture, typeDirName: 'CommonPictures' },
  { id: 'XDTOPackages', name: 'XDTO-пакеты', type: MetadataType.XDTOPackage, typeDirName: 'XDTOPackages' },
  { id: 'WebServices', name: 'Web-сервисы', type: MetadataType.WebService, typeDirName: 'WebServices' },
  { id: 'HTTPServices', name: 'HTTP-сервисы', type: MetadataType.HTTPService, typeDirName: 'HTTPServices' },
  { id: 'WSReferences', name: 'WS-ссылки', type: MetadataType.WSReference, typeDirName: 'WSReferences' },
  { id: 'WebSocketClients', name: 'WebSocket-клиенты', type: MetadataType.Unknown },
  { id: 'IntegrationServices', name: 'Сервисы интеграции', type: MetadataType.IntegrationService, typeDirName: 'IntegrationServices' },
  { id: 'StyleItems', name: 'Элементы стиля', type: MetadataType.StyleItem, typeDirName: 'StyleItems' },
  { id: 'Styles', name: 'Стили', type: MetadataType.Style, typeDirName: 'Styles' },
  { id: 'Languages', name: 'Языки', type: MetadataType.Language, typeDirName: 'Languages' },
];

/**
 * R5 ids under «Общие» that map to a real on-disk type directory (`typeDirName`).
 * Used for lazy `parseTypeContents` — UI-only placeholders (e.g. `Bots`) are excluded.
 */
export const R5_COMMON_DISK_BACKED_FOLDER_IDS: ReadonlySet<string> = new Set(
  R5_COMMON_CHILD_ORDER.filter((x) => x.typeDirName != null).map((x) => x.id)
);

function normalizedDiskPathKey(value: string | undefined): string {
  if (value == null || String(value).trim() === '') {
    return '';
  }
  return path.normalize(value).replace(/\\/g, '/').toLowerCase();
}

/**
 * Moves parser-built R5 type-folder nodes from direct `Configuration` children under the
 * canonical `Common` placeholder (same stable `id`), then removes the duplicate from the root.
 */
export function mergeR5TypeFoldersUnderCommon(rootNode: TreeNode, ctx: NormalizeContext): void {
  const commonGroup = rootNode.children?.find((c) => c.id === 'Common');
  if (!commonGroup) {
    return;
  }
  ensureChildrenArray(commonGroup);
  ensureChildrenArray(rootNode);

  for (const folderId of R5_COMMON_CHILD_ORDER.map((x) => x.id)) {
    const parserIdx = rootNode.children!.findIndex((c) => c.id === folderId);
    if (parserIdx < 0) {
      continue;
    }
    const parserNode = rootNode.children![parserIdx];
    let placeholderNode = commonGroup.children!.find((c) => c.id === folderId);
    if (!placeholderNode) {
      const def = R5_COMMON_CHILD_ORDER.find((d) => d.id === folderId);
      if (def) {
        upsertChildNode(commonGroup, def, ctx);
        placeholderNode = commonGroup.children!.find((c) => c.id === folderId);
      }
    }
    if (!placeholderNode) {
      const msg = `Не удалось найти плейсхолдер «${folderId}» под «Общие» при слиянии с узлом парсера.`;
      Logger.error(msg);
      throw new Error(msg);
    }

    const phPath = normalizedDiskPathKey(placeholderNode.filePath);
    const prPath = normalizedDiskPathKey(parserNode.filePath);
    if (phPath && prPath && phPath !== prPath) {
      const msg = `Конфликт путей при слиянии узла «${folderId}» под «Общие»: плейсхолдер «${placeholderNode.filePath}», парсер «${parserNode.filePath}».`;
      Logger.error(msg);
      throw new Error(msg);
    }
    const phParentPath = normalizedDiskPathKey(placeholderNode.parentFilePath);
    const prParentPath = normalizedDiskPathKey(parserNode.parentFilePath);
    if (phParentPath && prParentPath && phParentPath !== prParentPath) {
      const msg = `Конфликт parentFilePath при слиянии узла «${folderId}» под «Общие».`;
      Logger.error(msg);
      throw new Error(msg);
    }

    if (prPath) {
      placeholderNode.filePath = parserNode.filePath;
    }
    if (prParentPath) {
      placeholderNode.parentFilePath = parserNode.parentFilePath;
    }
    placeholderNode.properties = { ...placeholderNode.properties, ...parserNode.properties };

    ensureChildrenArray(placeholderNode);
    const seenChildIds = new Set((placeholderNode.children ?? []).map((c) => c.id));
    for (const child of [...(parserNode.children ?? [])]) {
      if (seenChildIds.has(child.id)) {
        const msg = `Дубликат дочернего узла «${child.id}» при слиянии «${folderId}» под «Общие».`;
        Logger.error(msg);
        throw new Error(msg);
      }
      seenChildIds.add(child.id);
      child.parent = placeholderNode;
      placeholderNode.children!.push(child);
    }
    parserNode.children = [];

    rootNode.children!.splice(parserIdx, 1);
  }

  reorderChildrenByIds(commonGroup, R5_COMMON_CHILD_ORDER.map((x) => x.id));
}

const R6_OBJECT_CHILDREN: ReadonlyArray<PlaceholderDef> = [
  { id: 'Dimensions', name: 'Измерения', type: MetadataType.Dimension, typeDirName: 'Dimensions' },
  { id: 'Resources', name: 'Ресурсы', type: MetadataType.Resource, typeDirName: 'Resources' },
  { id: 'Attributes', name: 'Реквизиты', type: MetadataType.Attribute, typeDirName: 'Attributes' },
  { id: 'TabularSections', name: 'Табличные части', type: MetadataType.TabularSection, typeDirName: 'TabularSections' },
  { id: 'Forms', name: 'Формы', type: MetadataType.Form, typeDirName: 'Forms' },
  { id: 'Commands', name: 'Команды', type: MetadataType.Command, typeDirName: 'Commands' },
  { id: 'Templates', name: 'Макеты', type: MetadataType.Template, typeDirName: 'Templates' },
];

/**
 * Каталог содержимого объекта Designer (Forms/, Attributes/, …):
 * - вложенно: `Type/Object/Object.xml` → корень объекта = `dirname(xml)`;
 * - плоско (часто в выгрузке): `Type/Object.xml` → корень = `Type/Object/`, а не `Type/`.
 */
function getObjectContentDirForR6(instanceNode: TreeNode, ctx: NormalizeContext): string | undefined {
  const fp = instanceNode.filePath;
  if (!fp) {
    return undefined;
  }
  if (ctx.format === ConfigFormat.EDT) {
    return fp.toLowerCase().endsWith('.xml') ? path.dirname(fp) : fp;
  }
  if (!fp.toLowerCase().endsWith('.xml')) {
    return fp;
  }
  const dir = path.dirname(fp);
  const fileBase = path.basename(fp, '.xml');
  const parentDirName = path.basename(dir);
  if (parentDirName === fileBase) {
    return dir;
  }
  return path.join(dir, fileBase);
}

function fixR6PlaceholderFilePaths(instanceNode: TreeNode, ctx: NormalizeContext): void {
  const baseDir = getObjectContentDirForR6(instanceNode, ctx);
  if (!baseDir) {
    return;
  }
  for (const def of R6_OBJECT_CHILDREN) {
    if (!def.typeDirName) {
      continue;
    }
    const child = instanceNode.children?.find((c) => c.id === def.id);
    if (!child) {
      continue;
    }
    child.filePath = path.join(baseDir, def.typeDirName);
    child.parent = instanceNode;
  }
}

/**
 * Map: metadata type → which R6 placeholder child IDs it supports.
 * Source: 1C platform spec (1c-config-objects-spec.md) + real ERP fixtures (FormatSamples/uh).
 *
 * Full set (Attribute, TabularSection, Form, Command, Template):
 *   Catalog, Document, DataProcessor, Report, BusinessProcess, Task,
 *   ExchangePlan, ChartOfCharacteristicTypes, ChartOfCalculationTypes
 *
 * Subset — registers have Dimension/Resource instead of Attribute/TabularSection:
 *   InformationRegister: Form, Command, Template
 *   AccumulationRegister, AccountingRegister, CalculationRegister: Form, Template
 *
 * Form + Command only:
 *   FilterCriterion, DocumentJournal, ChartOfAccounts
 *
 * Form only:
 *   SettingsStorage
 *
 * None (own child structure: EnumValue, URLTemplate, Operation, etc.):
 *   Enum, HTTPService, WebService, IntegrationService, ExternalDataSource
 */
const ALL_R6: string[] = ['Attributes', 'TabularSections', 'Forms', 'Commands', 'Templates'];
const FORMS_COMMANDS_TEMPLATES: string[] = ['Forms', 'Commands', 'Templates'];
const FORMS_COMMANDS: string[] = ['Forms', 'Commands'];
const FORMS_ONLY: string[] = ['Forms'];

const R6_ALLOWED_CHILDREN = new Map<MetadataType, string[]>([
  [MetadataType.Catalog, ALL_R6],
  [MetadataType.Document, ALL_R6],
  [MetadataType.DataProcessor, ALL_R6],
  [MetadataType.Report, ALL_R6],
  [MetadataType.BusinessProcess, ALL_R6],
  [MetadataType.Task, ALL_R6],
  [MetadataType.ExchangePlan, ALL_R6],
  [MetadataType.ChartOfCharacteristicTypes, ALL_R6],
  [MetadataType.ChartOfCalculationTypes, ALL_R6],
  [MetadataType.InformationRegister, ['Dimensions', 'Resources', 'Attributes', 'Forms', 'Commands', 'Templates']],
  [MetadataType.AccumulationRegister, ['Dimensions', 'Resources', 'Attributes', 'Forms', 'Commands', 'Templates']],
  [MetadataType.AccountingRegister, ['Dimensions', 'Resources', 'Attributes', 'Forms', 'Commands', 'Templates']],
  [MetadataType.CalculationRegister, ['Dimensions', 'Resources', 'Attributes', 'Forms', 'Commands', 'Templates']],
  [MetadataType.ChartOfAccounts, FORMS_COMMANDS_TEMPLATES],
  [MetadataType.FilterCriterion, FORMS_COMMANDS],
  [MetadataType.DocumentJournal, FORMS_COMMANDS_TEMPLATES],
  [MetadataType.SettingsStorage, FORMS_ONLY],
]);

const R6_OBJECT_TYPES: ReadonlySet<MetadataType> = new Set(R6_ALLOWED_CHILDREN.keys());
const R6_ALLOWED_SETS = new Map<MetadataType, ReadonlySet<string>>(
  [...R6_ALLOWED_CHILDREN.entries()].map(([k, v]) => [k, new Set(v)])
);

/**
 * Ensures that an object instance node has R6 placeholder children appropriate for its type.
 * Which placeholders are added is governed by R6_ALLOWED_CHILDREN (e.g. Catalog gets all 5,
 * InformationRegister gets Forms+Commands+Templates, SettingsStorage gets Forms only).
 */
export function ensureR6PlaceholdersForInstanceNode(node: TreeNode, ctx: NormalizeContext): void {
  if (!node || !R6_OBJECT_TYPES.has(node.type)) {
    return;
  }
  // Guard: do not add R6 to type-folder layer nodes (e.g. top-level «Справочники» / «Документы» under Configuration).
  // Those nodes use the same MetadataType as instances (Catalog, Document, …) but sit directly under the config root.
  // After R5 merge, other type folders may live under «Общие»; R6 still applies only to instance nodes below them.
  if (node.parent && node.parent.type === MetadataType.Configuration) {
    return;
  }
  const allowedSet = R6_ALLOWED_SETS.get(node.type)!;
  const applicableDefs = R6_OBJECT_CHILDREN.filter((def) => allowedSet.has(def.id));
  ensureChildrenArray(node);
  for (const def of applicableDefs) {
    upsertChildNode(node, def, ctx);
  }
  reorderChildrenByIds(node, applicableDefs.map((x) => x.id));
  fixR6PlaceholderFilePaths(node, ctx);
  // Mark R6 placeholders as lazy so the provider calls loadElementChildren on expand.
  for (const def of applicableDefs) {
    const child = node.children!.find((c) => c.id === def.id);
    if (child) {
      (child.properties as Record<string, unknown>)._lazy = true;
    }
  }
}

/**
 * Ensure configuration root contains placeholder type nodes for Catalogs/Documents.
 * - Stable IDs: `Catalogs` / `Documents`
 * - Inserted nodes are compatible with lazy loading in `MetadataTreeDataProvider`.
 */
/** Properties.type value for the synthetic «Реквизиты» node under a tabular section instance (columns). */
export const TABULAR_SECTION_COLUMNS_PLACEHOLDER_TYPE = 'TabularSectionColumns';

export function isTabularSectionColumnsContainer(node: TreeNode): boolean {
  return (node.properties as Record<string, unknown> | undefined)?.type === TABULAR_SECTION_COLUMNS_PLACEHOLDER_TYPE;
}

/** Stable id: `TabularSections.<SectionName>.Attributes` (columns under that ТЧ). */
export function tabularSectionColumnsContainerId(sectionInstanceId: string): string {
  return `${sectionInstanceId}.Attributes`;
}

/**
 * Under the real folder node `TabularSections`, each section instance gets exactly one child container
 * for columns (symmetry with R6 «Реквизиты»). Reparents flat Attribute children from the parser.
 * Empty columns → `_lazy` on the container so the tree can expand and load from disk on demand.
 */
export function ensureTabularSectionColumnsPlaceholder(sectionInstance: TreeNode): void {
  if (!sectionInstance.parent || sectionInstance.parent.id !== 'TabularSections') {
    return;
  }
  if (sectionInstance.id === 'TabularSections' || !sectionInstance.id.startsWith('TabularSections.')) {
    return;
  }
  if (sectionInstance.type !== MetadataType.TabularSection) {
    return;
  }

  const containerId = tabularSectionColumnsContainerId(sectionInstance.id);
  const xmlPath =
    sectionInstance.filePath && sectionInstance.filePath.toLowerCase().endsWith('.xml')
      ? sectionInstance.filePath
      : sectionInstance.parentFilePath;

  const existingContainer = sectionInstance.children?.find((c) => c.id === containerId);
  if (existingContainer) {
    const looseAttrs = (sectionInstance.children ?? []).filter(
      (c) => c.type === MetadataType.Attribute && c.id !== containerId
    );
    if (looseAttrs.length > 0) {
      ensureChildrenArray(existingContainer);
      for (const a of looseAttrs) {
        a.parent = existingContainer;
        existingContainer.children!.push(a);
      }
    }
    const rest = (sectionInstance.children ?? []).filter(
      (c) => c.id !== containerId && !looseAttrs.includes(c)
    );
    sectionInstance.children = [existingContainer, ...rest];
    existingContainer.name = 'Реквизиты';
    existingContainer.type = MetadataType.Attribute;
    existingContainer.filePath = sectionInstance.filePath ?? existingContainer.filePath;
    existingContainer.parentFilePath = xmlPath ?? existingContainer.parentFilePath;
    existingContainer.parent = sectionInstance;
    (existingContainer.properties as Record<string, unknown>).type = TABULAR_SECTION_COLUMNS_PLACEHOLDER_TYPE;
    for (const c of existingContainer.children ?? []) {
      c.parent = existingContainer;
    }
    if (!existingContainer.children || existingContainer.children.length === 0) {
      (existingContainer.properties as Record<string, unknown>)._lazy = true;
    } else {
      delete (existingContainer.properties as Record<string, unknown>)._lazy;
    }
    return;
  }

  const raw = sectionInstance.children;
  const flatAttrs = (raw ?? []).filter((c) => c.type === MetadataType.Attribute);
  const other = (raw ?? []).filter((c) => c.type !== MetadataType.Attribute);

  const container: TreeNode = {
    id: containerId,
    name: 'Реквизиты',
    type: MetadataType.Attribute,
    properties: { type: TABULAR_SECTION_COLUMNS_PLACEHOLDER_TYPE },
    children: flatAttrs.length > 0 ? [...flatAttrs] : [],
    filePath: sectionInstance.filePath,
    parentFilePath: xmlPath,
    parent: sectionInstance,
  };
  for (const a of container.children ?? []) {
    a.parent = container;
  }
  if (!container.children || container.children.length === 0) {
    (container.properties as Record<string, unknown>)._lazy = true;
  }

  sectionInstance.children = [container, ...other];
}

function walkTabularSectionColumnPlaceholders(node: TreeNode): void {
  if (node.id === 'TabularSections' && node.children) {
    for (const ch of node.children) {
      ensureTabularSectionColumnsPlaceholder(ch);
    }
  }
  for (const ch of node.children ?? []) {
    walkTabularSectionColumnPlaceholders(ch);
  }
}

/** Apply {@link ensureTabularSectionColumnsPlaceholder} for every `TabularSections` folder in the tree. */
export function normalizeTabularSectionColumnPlaceholders(rootNode: TreeNode): void {
  walkTabularSectionColumnPlaceholders(rootNode);
}

export function normalizeEmptyPlaceholderTree(rootNode: TreeNode, ctx: NormalizeContext): TreeNode {
  if (!rootNode) {
    return rootNode;
  }

  // Insert R4/R5 placeholders directly under Configuration roots.
  ensureChildrenArray(rootNode);

  // Ensure all required R4 nodes exist under this configuration root.
  for (const def of R4_TOP_LEVEL_ORDER) {
    upsertChildNode(rootNode, def, ctx);

    // Special: if "Общие" group exists, normalize its children too.
    if (def.id === 'Common') {
      const commonGroup = rootNode.children!.find((c) => c.id === def.id);
      if (commonGroup) {
        ensureChildrenArray(commonGroup);
        for (const childDef of R5_COMMON_CHILD_ORDER) {
          upsertChildNode(commonGroup, childDef, ctx);
        }
        reorderChildrenByIds(commonGroup, R5_COMMON_CHILD_ORDER.map((x) => x.id));
        commonGroup.name = 'Общие';
        commonGroup.type = MetadataType.Unknown;
      }
    }
  }

  mergeR5TypeFoldersUnderCommon(rootNode, ctx);

  // Deterministic order under Configuration root.
  reorderChildrenByIds(rootNode, R4_TOP_LEVEL_ORDER.map((x) => x.id));

  normalizeTabularSectionColumnPlaceholders(rootNode);

  // Process R6 object type folders to add placeholders to their instance nodes.
  // Collect all type folder nodes (R4 top-level + R5 under «Общие») whose type is in R6_OBJECT_TYPES.
  const allTypeFolderNodes: TreeNode[] = [];
  const commonNode = rootNode.children?.find((c) => c.id === 'Common');
  for (const searchRoot of [rootNode, commonNode]) {
    if (!searchRoot?.children) { continue; }
    for (const child of searchRoot.children) {
      if (R6_OBJECT_TYPES.has(child.type)) {
        allTypeFolderNodes.push(child);
      }
    }
  }

  // Process instance nodes under R6 type folders and add R6 placeholders to each instance.
  // This ensures placeholders like 'Реквизиты', 'Табличные части' etc. appear only under
  // concrete object instances (e.g., Document11, Документ12), not in the type folders themselves.
  for (const typeFolderNode of allTypeFolderNodes) {
    ensureChildrenArray(typeFolderNode);

    for (const instanceNode of typeFolderNode.children ?? []) {
      if (!R6_OBJECT_TYPES.has(instanceNode.type)) {
        continue;
      }
      ensureChildrenArray(instanceNode);
      ensureR6PlaceholdersForInstanceNode(instanceNode, ctx);
    }
  }

  return rootNode;
}

