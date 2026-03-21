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
  // No technical mapping in codebase.
  { id: 'DocumentJournals', name: 'Журналы документов', type: MetadataType.Unknown },
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
  { id: 'SessionParameters', name: 'Параметры сеанса', type: MetadataType.SessionParameter, typeDirName: 'SessionParameters' },
  { id: 'Roles', name: 'Роли', type: MetadataType.Role, typeDirName: 'Roles' },
  { id: 'FilterCriteria', name: 'Критерии отбора', type: MetadataType.FilterCriterion, typeDirName: 'FilterCriteria' },
  { id: 'EventSubscriptions', name: 'Подписки на события', type: MetadataType.EventSubscription, typeDirName: 'EventSubscriptions' },
  { id: 'ScheduledJobs', name: 'Регламентные задания', type: MetadataType.ScheduledJob, typeDirName: 'ScheduledJobs' },

  // UI-only placeholders without code mapping.
  { id: 'Bots', name: 'Боты', type: MetadataType.Unknown },
  { id: 'FunctionalOptions', name: 'Функциональные опции', type: MetadataType.FunctionalOption, typeDirName: 'FunctionalOptions' },
  { id: 'FunctionalOptionsParameters', name: 'Параметры функциональных опций', type: MetadataType.FunctionalOptionsParameter, typeDirName: 'FunctionalOptionsParameters' },
  { id: 'DefinableTypes', name: 'Определяемые типы', type: MetadataType.Unknown },
  { id: 'SettingsStorages', name: 'Хранилища настроек', type: MetadataType.SettingsStorage, typeDirName: 'SettingsStorages' },
  { id: 'CommonCommands', name: 'Общие команды', type: MetadataType.Unknown },
  { id: 'CommandGroups', name: 'Группы команд', type: MetadataType.CommandGroup, typeDirName: 'CommandGroups' },
  { id: 'CommonForms', name: 'Общие формы', type: MetadataType.Unknown },
  { id: 'CommonLayouts', name: 'Общие макеты', type: MetadataType.Unknown },
  { id: 'CommonPictures', name: 'Общие картинки', type: MetadataType.Unknown },
  { id: 'XDTO', name: 'XDTO-пакеты', type: MetadataType.Unknown },
  { id: 'WebServices', name: 'Web-сервисы', type: MetadataType.WebService, typeDirName: 'WebServices' },
  { id: 'HTTPServices', name: 'HTTP-сервисы', type: MetadataType.HTTPService, typeDirName: 'HTTPServices' },
  { id: 'WSLinks', name: 'WS-ссылки', type: MetadataType.Unknown },
  { id: 'WebSocketClients', name: 'WebSocket-клиенты', type: MetadataType.Unknown },
  { id: 'IntegrationServices', name: 'Сервисы интеграции', type: MetadataType.IntegrationService, typeDirName: 'IntegrationServices' },
  { id: 'StyleElements', name: 'Элементы стиля', type: MetadataType.Unknown },
  { id: 'Styles', name: 'Стили', type: MetadataType.Style, typeDirName: 'Styles' },
  { id: 'Languages', name: 'Языки', type: MetadataType.Unknown },
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
  { id: 'Attributes', name: 'Реквизиты', type: MetadataType.Attribute, typeDirName: 'Attributes' },
  { id: 'TabularSections', name: 'Табличные части', type: MetadataType.TabularSection, typeDirName: 'TabularSections' },
  { id: 'Forms', name: 'Формы', type: MetadataType.Form, typeDirName: 'Forms' },
  { id: 'Commands', name: 'Команды', type: MetadataType.Command, typeDirName: 'Commands' },
  { id: 'Templates', name: 'Макеты', type: MetadataType.Template, typeDirName: 'Templates' },
];

const R6_OBJECT_TYPES: ReadonlySet<MetadataType> = new Set([
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.DataProcessor,
  MetadataType.ChartOfCharacteristicTypes,
]);

/**
 * Ensures that an object instance node (Catalog, Document, DataProcessor, ChartOfCharacteristicTypes)
 * has R6 placeholder children (Attributes, TabularSections, Forms, Commands, Templates).
 * Used when returning children in the tree provider so placeholders appear after lazy-loaded instances.
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
  ensureChildrenArray(node);
  for (const def of R6_OBJECT_CHILDREN) {
    upsertChildNode(node, def, ctx);
  }
  reorderChildrenByIds(node, R6_OBJECT_CHILDREN.map((x) => x.id));
  // Mark R6 placeholders as lazy so the provider calls loadElementChildren on expand.
  for (const def of R6_OBJECT_CHILDREN) {
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

  // Process only the four R6 object type folders to add placeholders to their instance nodes
  const r6TypeFolders = R4_TOP_LEVEL_ORDER.filter(def => 
    def.type === MetadataType.Catalog ||
    def.type === MetadataType.Document ||
    def.type === MetadataType.DataProcessor ||
    def.type === MetadataType.ChartOfCharacteristicTypes
  );

  // Process instance nodes under R6 type folders and add R6 placeholders to each instance.
  // This ensures placeholders like 'Реквизиты', 'Табличные части' etc. appear only under
  // concrete object instances (e.g., Document11, Документ12), not in the type folders themselves.
  for (const typeDef of r6TypeFolders) {
    const typeFolderNode = rootNode.children?.find((c) => c.id === typeDef.id);
    if (!typeFolderNode) {
      continue;
    }

    // Process only the instance nodes (children of the type folder), not the folder itself
    ensureChildrenArray(typeFolderNode);
    
    for (const instanceNode of typeFolderNode.children ?? []) {
      // Skip if this is not a real R6 object instance (has wrong type)
      if (!R6_OBJECT_TYPES.has(instanceNode.type)) {
        continue;
      }
      ensureChildrenArray(instanceNode);
      
      // Add all R6 placeholders to this instance node
      for (const childDef of R6_OBJECT_CHILDREN) {
        upsertChildNode(instanceNode, childDef, ctx);
      }
      
      // Mark R6 placeholders as lazy for proper loading behavior
      const existingPlaceholders = instanceNode.children?.filter(c => R6_OBJECT_CHILDREN.some(def => def.id === c.id)) ?? [];
      for (const placeholder of existingPlaceholders) {
        (placeholder.properties as Record<string, unknown>)._lazy = true;
      }
      
      // Reorder the R6 children for consistent display
      reorderChildrenByIds(instanceNode, R6_OBJECT_CHILDREN.map((x) => x.id));
    }
  }

  return rootNode;
}

