import { compareCodeUnits } from '../../utils/compareCodeUnits';
import { getPropertyLabel } from '../../constants/propertyLabels';
import type { CompareTreeNode, CompareTreeStatus } from '../compareTreeTypes';

export interface CompareDisplayIdentity {
  side: 'left' | 'right';
  qualifiedName: string;
  uuid?: string;
  filePath?: string;
  ownership?: 'own' | 'adopted';
  sourceUuid?: string;
}

export interface CompareDisplayNode {
  key: string;
  label: string;
  kind: string;
  status: CompareTreeStatus;
  leftValue?: string;
  rightValue?: string;
  destructive?: boolean;
  mergeState?: CompareTreeNode['mergeState'];
  conflict?: CompareTreeNode['conflict'];
  ownerAliases?: string[];
  metadataType?: string;
  qualifiedNames?: string[];
  canonicalNodeIds: string[];
  candidateNodeIds: string[];
  identities: CompareDisplayIdentity[];
  children: CompareDisplayNode[];
}

export interface CompareDisplayTree {
  root: CompareDisplayNode;
  nodeCount: number;
}

const METADATA_TYPE_LABELS: Readonly<Record<string, string>> = {
  AccumulationRegister: 'Регистры накопления',
  AccountingRegister: 'Регистры бухгалтерии',
  CalculationRegister: 'Регистры расчёта',
  BusinessProcess: 'Бизнес-процессы',
  Catalog: 'Справочники',
  ChartOfAccounts: 'Планы счетов',
  ChartOfCalculationTypes: 'Планы видов расчёта',
  ChartOfCharacteristicTypes: 'Планы видов характеристик',
  Command: 'Команды',
  CommonAttribute: 'Общие реквизиты',
  CommonCommand: 'Общие команды',
  CommonForm: 'Общие формы',
  CommonModule: 'Общие модули',
  CommonPicture: 'Общие картинки',
  CommonTemplate: 'Общие макеты',
  Constant: 'Константы',
  DataProcessor: 'Обработки',
  DefinedType: 'Определяемые типы',
  Document: 'Документы',
  DocumentNumerator: 'Нумераторы документов',
  DocumentJournal: 'Журналы документов',
  Enum: 'Перечисления',
  EventSubscription: 'Подписки на события',
  FilterCriterion: 'Критерии отбора',
  ExchangePlan: 'Планы обмена',
  ExternalDataSource: 'Внешние источники данных',
  Form: 'Формы',
  FunctionalOption: 'Функциональные опции',
  FunctionalOptionsParameter: 'Параметры функциональных опций',
  HTTPService: 'HTTP-сервисы',
  InformationRegister: 'Регистры сведений',
  IntegrationService: 'Сервисы интеграции',
  Interface: 'Интерфейсы',
  Language: 'Языки',
  Report: 'Отчёты',
  Role: 'Роли',
  Sequence: 'Последовательности',
  ScheduledJob: 'Регламентные задания',
  SessionParameter: 'Параметры сеанса',
  SettingsStorage: 'Хранилища настроек',
  Style: 'Стили',
  StyleItem: 'Элементы стиля',
  Subsystem: 'Подсистемы',
  Task: 'Задачи',
  WSReference: 'WS-ссылки',
  WebService: 'Web-сервисы',
  XDTOPackage: 'XDTO-пакеты',
  CommandGroup: 'Группы команд',
  TabularSection: 'Табличные части',
  Attribute: 'Реквизиты',
  Dimension: 'Измерения',
  Resource: 'Ресурсы',
  EnumValue: 'Значения перечисления',
  Template: 'Макеты',
  URLTemplate: 'Шаблоны URL',
  Method: 'Методы',
  Operation: 'Операции',
  Parameter: 'Параметры',
  AddressingAttribute: 'Реквизиты адресации',
  AccountingFlag: 'Признаки учёта',
  ExtDimensionAccountingFlag: 'Признаки учёта субконто',
  Column: 'Колонки',
  Table: 'Таблицы',
  Field: 'Поля',
};

const CANONICAL_ARTIFACT_LABELS: Readonly<Record<string, string>> = {
  dcsXml: 'Схема компоновки данных',
  formXml: 'Описание формы',
  metadataXml: 'Свойства',
  predefinedXml: 'Предопределённые данные',
  roleRightsXml: 'Права',
};

const BSL_MODULE_LABELS: Readonly<Record<string, string>> = {
  Command: 'Модуль команды',
  CommonModule: 'Общий модуль',
  Form: 'Модуль формы',
  Manager: 'Модуль менеджера',
  Object: 'Модуль объекта',
};

/**
 * Builds a display-only hierarchy. Every candidate ID in the result comes from an
 * existing canonical node; grouping and conflict coalescing never create actions.
 */
export function buildCompareDisplayTree(root: CompareTreeNode): CompareDisplayTree {
  const rootChildren: CompareDisplayNode[] = [];
  const metadataNodes = root.children.find((node) => node.kind === 'metadataGroup');
  const owners = metadataNodes
    ? coalesceMetadataOwners(metadataNodes.children.filter((node) => node.kind !== 'diagnostic'))
    : [];
  const ownerByAlias = new Map<string, CompareDisplayNode | undefined>();
  for (const owner of owners) {
    for (const alias of owner.ownerAliases ?? []) {
      ownerByAlias.set(alias, ownerByAlias.has(alias) ? undefined : owner);
    }
  }
  const otherChanges: CompareDisplayNode[] = [];
  const bslFallbacks: CompareDisplayNode[] = [];

  const attachProvenOwner = (node: CompareTreeNode, fallback: CompareDisplayNode[]): void => {
    const aliases = node.presentation?.ownerAliases ?? [];
    const owner = aliases.map((alias) => ownerByAlias.get(alias)).find(isDefined);
    if (!owner) {
      fallback.push(displayCanonicalNode(node));
      return;
    }
    const child = displayCanonicalNode(node);
    if (!owner.children.some((existing) => existing.key === child.key)) {
      owner.children.push(child);
    }
  };

  for (const node of root.children) {
    if (node.kind === 'bslGroup') {
      for (const module of node.children) {
        attachProvenOwner(module, bslFallbacks);
      }
    } else if (node.kind === 'adapterGroup') {
      for (const change of node.children) {
        attachProvenOwner(change, otherChanges);
      }
    } else if (node.kind === 'extensionObjectGroup') {
      const rows = node.children.map((child) => displayCanonicalNode(child));
      if (rows.length > 0) {
        rootChildren.push(
          displayGroup(
            'display:extension-objects',
            'Объекты расширения',
            'displayGroup',
            buildMetadataHierarchy(rows)
          )
        );
      }
    }
  }

  if (metadataNodes) {
    const typeGroups = buildMetadataHierarchy(owners);
    if (typeGroups.length > 0) {
      rootChildren.push(
        displayGroup('display:metadata', 'Метаданные', 'displayGroup', typeGroups)
      );
    }

    const diagnostics = metadataNodes.children.filter(
      (node) => node.kind === 'diagnostic' || !node.presentation?.ownerKey
    );
    if (diagnostics.length > 0) {
      rootChildren.push(
        displayGroup(
          'display:metadata-diagnostics',
          'Диагностика метаданных',
          'diagnosticsGroup',
          sortDisplayNodes(diagnostics.map((node) => displayCanonicalNode(node)))
        )
      );
    }
  }

  for (const node of root.children) {
    if (node === metadataNodes) {
      continue;
    }
    if (node.kind === 'bslGroup') {
      if (bslFallbacks.length > 0) {
        rootChildren.push(
          displayGroup('display:bsl', 'Процедуры и функции', 'displayGroup', bslFallbacks)
        );
      }
    } else if (node.kind === 'adapterGroup') {
      if (otherChanges.length > 0) {
        rootChildren.push(
          displayGroup(
            'display:other-changes',
            'Прочие изменения',
            'displayGroup',
            sortDisplayNodes(otherChanges)
          )
        );
      }
    } else if (node.kind === 'diagnosticsGroup') {
      rootChildren.push(
        displayGroup(
          'display:diagnostics',
          'Диагностика сравнения',
          'diagnosticsGroup',
          node.children.map((child) => displayCanonicalNode(child))
        )
      );
    } else if (node.kind === 'extensionRootPropertyGroup') {
      rootChildren.push(
        displayGroup(
          'display:extension-root-properties',
          'Свойства расширения',
          'displayGroup',
          node.children.map((child) => displayCanonicalNode(child))
        )
      );
    } else if (node.kind === 'extensionDiagnosticGroup') {
      rootChildren.push(
        displayGroup(
          'display:extension-diagnostics',
          'Диагностика расширения',
          'diagnosticsGroup',
          node.children.map((child) => displayCanonicalNode(child))
        )
      );
    } else if (node.kind === 'extensionObjectGroup') {
      // Already rendered above with its typed display hierarchy.
    } else {
      rootChildren.push(displayCanonicalNode(node));
    }
  }

  const displayRoot = displayGroup('display:root', 'Сравнение конфигураций', 'displayRoot', rootChildren);
  refreshDisplayStatuses(displayRoot);
  return { root: displayRoot, nodeCount: countNodes(displayRoot) };
}

function coalesceMetadataOwners(nodes: readonly CompareTreeNode[]): CompareDisplayNode[] {
  const ambiguousAliases = findAmbiguousOwnerAliases(nodes);
  const parent = nodes.map((_node, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };
  const firstNodeByAlias = new Map<string, number>();
  const standalone: CompareTreeNode[] = [];
  const eligibleIndices = new Set<number>();
  for (const [index, node] of nodes.entries()) {
    const presentation = node.presentation;
    const ownerKey = presentation?.ownerKey;
    if (!presentation || !ownerKey || !isMetadataOwnerNode(node)) {
      standalone.push(node);
      continue;
    }
    if (presentation.ambiguousIdentitySet) {
      standalone.push(node);
      continue;
    }
    eligibleIndices.add(index);
    const aliases = presentation.ownerAliases?.length
      ? presentation.ownerAliases
      : [ownerKey];
    for (const alias of aliases) {
      if (ambiguousAliases.has(alias)) {continue;}
      const previous = firstNodeByAlias.get(alias);
      if (previous === undefined) {
        firstNodeByAlias.set(alias, index);
      } else {
        union(index, previous);
      }
    }
  }

  const groups = new Map<number, CompareTreeNode[]>();
  for (const index of eligibleIndices) {
    const groupRoot = find(index);
    const group = groups.get(groupRoot) ?? [];
    group.push(nodes[index]);
    groups.set(groupRoot, group);
  }

  return [
    ...[...groups.values()].map((ownerNodes) =>
      displayMetadataOwner(
        ownerNodes,
        ownerNodes.some((node) =>
          node.presentation?.ownerAliases?.some((alias) => ambiguousAliases.has(alias))
        )
          ? ownerNodes.map((node) => node.id).sort(compareCodeUnits).join('|')
          : undefined
      )
    ),
    ...standalone.map((node) => displayCanonicalNode(node)),
  ];
}

function findAmbiguousOwnerAliases(nodes: readonly CompareTreeNode[]): Set<string> {
  const identitiesByAlias = new Map<string, Set<string>>();
  const explicitlyAmbiguous = new Set<string>();
  for (const node of nodes) {
    const presentation = node.presentation;
    if (!presentation?.ambiguousIdentitySet) {continue;}
    const identities = presentation.identities ?? [];
    if (identities.length === 0) {
      for (const alias of presentation.ownerAliases ?? []) {explicitlyAmbiguous.add(alias);}
      continue;
    }
    for (const identity of identities) {
      const identityKey = [identity.side, identity.qualifiedName, identity.uuid ?? '', identity.filePath ?? ''].join('\0');
      const metadataType = presentation.metadataType ?? identity.qualifiedName.split('.')[0] ?? 'Metadata';
      const aliases = [`${metadataType}:name:${identity.qualifiedName}`];
      if (identity.uuid) {aliases.push(`${metadataType}:uuid:${identity.uuid}`);}
      for (const alias of aliases) {
        const identitySet = identitiesByAlias.get(alias) ?? new Set<string>();
        identitySet.add(identityKey);
        identitiesByAlias.set(alias, identitySet);
      }
    }
  }
  const ambiguous = new Set(explicitlyAmbiguous);
  for (const [alias, identities] of identitiesByAlias) {
    if (identities.size > 1) {ambiguous.add(alias);}
  }
  return ambiguous;
}

function displayMetadataOwner(
  nodes: readonly CompareTreeNode[],
  ambiguousDiscriminator?: string
): CompareDisplayNode {
  const ownerKey = nodes[0].presentation?.ownerKey ?? nodes[0].id;
  const identities = uniqueIdentities(nodes.flatMap((node) => node.presentation?.identities ?? []));
  const conflictNode = nodes.find((node) => node.presentation?.identityConflict || node.conflict);
  const ambiguousOwner = Boolean(ambiguousDiscriminator);
  const preferred = nodes.find((node) => node.kind === 'metadataObject') ?? nodes[0];
  const qualifiedNames = [...new Set(identities.map((identity) => identity.qualifiedName))];
  const qualifiedName = nodes
    .map((node) => node.presentation?.qualifiedName)
    .find((value): value is string => Boolean(value));
  const hasLeft = nodes.some((node) => node.status !== 'rightOnly');
  const hasRight = nodes.some((node) => node.status !== 'leftOnly');
  const status: CompareTreeStatus = nodes.every((node) => node.status === 'equal')
    ? 'equal'
    : !hasLeft
      ? 'rightOnly'
      : !hasRight
        ? 'leftOnly'
        : 'changed';
  const candidateNodeIds = conflictNode || ambiguousOwner
    ? []
    : nodes.filter((node) => node.mergeable === true).map((node) => node.id);
  const reasons = [...new Set(nodes.map((node) => node.mergeState?.reason).filter(isString))];
  const mergeState = conflictNode
    ? {
        state: 'identityConflict' as const,
        reason: conflictNode.mergeState?.reason ?? conflictNode.conflict?.message,
      }
    : ambiguousOwner
      ? {
          state: 'identityConflict' as const,
          reason: 'Неоднозначная идентичность объекта; действие недоступно.',
        }
    : nodes.find((node) => node.mergeState)?.mergeState;
  const childrenByKey = new Map<string, CompareDisplayNode>();
  for (const node of nodes) {
    for (const child of node.children) {
      childrenByKey.set(child.id, displayCanonicalNode(child));
    }
  }
  const ownerAliases = [...new Set(nodes.flatMap((node) =>
    node.presentation?.ownerAliases?.length
      ? node.presentation.ownerAliases
      : node.presentation?.ownerKey ? [node.presentation.ownerKey] : []
  ))];
  const keyDiscriminator = ambiguousDiscriminator
    ? `:${encodeURIComponent(ambiguousDiscriminator)}`
    : '';
  return {
    key: `display:metadata-owner:${encodeURIComponent(ownerKey)}${keyDiscriminator}`,
    label:
      conflictNode?.presentation?.ambiguousIdentitySet
        ? ambiguousIdentityLabel(conflictNode)
        : qualifiedNames.length > 1
          ? `${shortQualifiedName(qualifiedNames.find((name) => identities.find((identity) => identity.side === 'left')?.qualifiedName === name) ?? qualifiedNames[0])} → ${shortQualifiedName(qualifiedNames.find((name) => identities.find((identity) => identity.side === 'right')?.qualifiedName === name) ?? qualifiedNames[1])}`
          : shortQualifiedName(qualifiedName ?? preferred.label),
    kind: 'metadataOwner',
    status: conflictNode || ambiguousOwner ? 'changed' : status,
    leftValue: sideSummary(nodes, 'left'),
    rightValue: sideSummary(nodes, 'right'),
    mergeState: mergeState ?? (reasons.length > 0 ? { state: 'blocked', reason: reasons.join('\n') } : undefined),
    destructive: candidateNodeIds.some((id) => nodes.some((node) => node.id === id && node.destructive))
      ? true
      : undefined,
    conflict: conflictNode?.conflict,
    canonicalNodeIds: nodes.map((node) => node.id),
    candidateNodeIds,
    identities,
    ownerAliases,
    metadataType: nodes.map((node) => node.presentation?.metadataType).find(isString),
    qualifiedNames: [...new Set(identities.map((identity) => identity.qualifiedName))],
    children: [...childrenByKey.values()],
  };
}

function buildMetadataHierarchy(owners: CompareDisplayNode[]): CompareDisplayNode[] {
  const ownersByName = new Map<string, CompareDisplayNode[]>();
  for (const owner of owners) {
    for (const qualifiedName of owner.qualifiedNames ?? []) {
      const matches = ownersByName.get(qualifiedName) ?? [];
      matches.push(owner);
      ownersByName.set(qualifiedName, matches);
    }
  }

  const childrenByParent = new Map<CompareDisplayNode, Map<string, CompareDisplayNode[]>>();
  const rootOwners: CompareDisplayNode[] = [];
  for (const owner of owners) {
    const parentName = metadataParentQualifiedName(owner);
    const parents = parentName ? ownersByName.get(parentName) : undefined;
    const parent = parents?.length === 1 ? parents[0] : undefined;
    if (!parent || parent === owner) {
      rootOwners.push(owner);
      continue;
    }
    const type = owner.metadataType ?? 'Metadata';
    const typeGroups = childrenByParent.get(parent) ?? new Map<string, CompareDisplayNode[]>();
    const children = typeGroups.get(type) ?? [];
    children.push(owner);
    typeGroups.set(type, children);
    childrenByParent.set(parent, typeGroups);
  }

  for (const [parent, typeGroups] of childrenByParent) {
    const nestedGroups = [...typeGroups.entries()]
      .sort((left, right) => compareCodeUnits(metadataTypeLabel(left[0]), metadataTypeLabel(right[0])))
      .map(([metadataType, children]) =>
        displayGroup(
          `display:metadata-children:${encodeURIComponent(parent.key)}:${encodeURIComponent(metadataType)}`,
          metadataTypeLabel(metadataType),
          'metadataTypeGroup',
          sortDisplayNodes(children)
        )
      );
    parent.children.push(...nestedGroups);
  }

  const rootByType = new Map<string, CompareDisplayNode[]>();
  const untyped: CompareDisplayNode[] = [];
  for (const owner of rootOwners) {
    const type = owner.metadataType;
    if (!type) {
      untyped.push(owner);
      continue;
    }
    const group = rootByType.get(type) ?? [];
    group.push(owner);
    rootByType.set(type, group);
  }
  const groups = [...rootByType.entries()]
    .sort((left, right) => compareCodeUnits(metadataTypeLabel(left[0]), metadataTypeLabel(right[0])))
    .map(([metadataType, children]) =>
      displayGroup(
        `display:metadata-type:${encodeURIComponent(metadataType)}`,
        metadataTypeLabel(metadataType),
        'metadataTypeGroup',
        sortDisplayNodes(children)
      )
    );
  if (untyped.length > 0) {
    groups.push(
      displayGroup(
        'display:metadata-type:other',
        'Другие метаданные',
        'metadataTypeGroup',
        sortDisplayNodes(untyped)
      )
    );
  }
  return groups;
}

function metadataParentQualifiedName(owner: CompareDisplayNode): string | undefined {
  if (!owner.metadataType || !owner.qualifiedNames || owner.qualifiedNames.length === 0) {
    return undefined;
  }
  const parents = owner.qualifiedNames.map((qualifiedName) => {
    const segments = qualifiedName.split('.').filter(Boolean);
    if (segments.length < 4 || segments[segments.length - 2] !== owner.metadataType) {
      return undefined;
    }
    return segments.slice(0, -2).join('.');
  });
  const uniqueParents = [...new Set(parents)];
  return uniqueParents.length === 1 ? uniqueParents[0] : undefined;
}

function displayCanonicalNode(node: CompareTreeNode): CompareDisplayNode {
  return {
    key: node.id,
    label: canonicalDisplayLabel(node),
    kind: node.kind,
    status: node.status,
    leftValue: node.leftValue,
    rightValue: node.rightValue,
    destructive: node.destructive,
    mergeState: node.mergeState,
    conflict: node.conflict,
    canonicalNodeIds: [node.id],
    candidateNodeIds: node.mergeable && !node.presentation?.identityConflict ? [node.id] : [],
    identities: uniqueIdentities(node.presentation?.identities ?? []),
    ownerAliases: node.presentation?.ownerAliases ? [...node.presentation.ownerAliases] : undefined,
    metadataType: node.presentation?.metadataType,
    qualifiedNames: node.presentation?.qualifiedName ? [node.presentation.qualifiedName] : undefined,
    children: node.children.map((child) => displayCanonicalNode(child)),
  };
}

function canonicalDisplayLabel(node: CompareTreeNode): string {
  if (node.presentation?.ambiguousIdentitySet) {
    return ambiguousIdentityLabel(node);
  }
  if (node.kind === 'xmlProperty') {
    return getPropertyLabel(node.label);
  }
  const artifactLabel = CANONICAL_ARTIFACT_LABELS[node.kind];
  if (artifactLabel) {
    return artifactLabel;
  }
  if (node.kind === 'bslModule') {
    return BSL_MODULE_LABELS[node.presentation?.moduleKind ?? ''] ?? node.label;
  }
  if (
    node.presentation?.qualifiedName &&
    (node.kind === 'metadataObject' ||
      node.kind === 'metadataMatch' ||
      node.kind === 'metadataConflict' ||
      node.kind === 'extensionMetadataObject')
  ) {
    return shortQualifiedName(node.presentation.qualifiedName);
  }
  return node.label;
}

function displayGroup(
  key: string,
  label: string,
  kind: string,
  children: CompareDisplayNode[]
): CompareDisplayNode {
  return {
    key,
    label,
    kind,
    status: children.some((child) => child.status !== 'equal') ? 'changed' : 'equal',
    leftValue: '',
    rightValue: '',
    canonicalNodeIds: [],
    candidateNodeIds: [],
    identities: [],
    children,
  };
}

function sideSummary(nodes: readonly CompareTreeNode[], side: 'left' | 'right'): string {
  const hasSide = nodes.some((node) =>
    side === 'left' ? node.status !== 'rightOnly' : node.status !== 'leftOnly'
  );
  return hasSide ? 'Есть' : 'Нет';
}

function isMetadataOwnerNode(node: CompareTreeNode): boolean {
  return node.kind === 'metadataMatch' || node.kind === 'metadataConflict' || node.kind === 'metadataObject';
}

function ambiguousIdentityLabel(node: CompareTreeNode): string {
  const uuid = node.presentation?.identities?.find((identity) => identity.uuid)?.uuid;
  const qualifiedName = node.presentation?.identities?.[0]?.qualifiedName;
  if (node.conflict?.kind === 'duplicateQualifiedName') {
    return `Повтор имени ${qualifiedName ?? node.label}`;
  }
  if (node.conflict?.kind === 'duplicateUuid') {
    return `Повтор UUID ${uuid ?? node.label}`;
  }
  return uuid ? `Повтор UUID ${uuid}` : `Повтор имени ${qualifiedName ?? node.label}`;
}

function uniqueIdentities(identities: readonly CompareDisplayIdentity[]): CompareDisplayIdentity[] {
  const unique = new Map<string, CompareDisplayIdentity>();
  for (const identity of identities) {
    const key = `${identity.side}:${identity.qualifiedName}:${identity.uuid ?? ''}:${identity.filePath ?? ''}:${identity.ownership ?? ''}:${identity.sourceUuid ?? ''}`;
    unique.set(key, identity);
  }
  return [...unique.values()].sort((left, right) =>
    compareCodeUnits(`${left.side}:${left.qualifiedName}`, `${right.side}:${right.qualifiedName}`)
  );
}

function sortDisplayNodes(nodes: CompareDisplayNode[]): CompareDisplayNode[] {
  return [...nodes].sort((left, right) =>
    compareCodeUnits(left.label, right.label) || compareCodeUnits(left.key, right.key)
  );
}

function metadataTypeLabel(metadataType: string): string {
  return METADATA_TYPE_LABELS[metadataType] ?? metadataType;
}

function shortQualifiedName(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const lastPart = normalized.slice(normalized.lastIndexOf('.') + 1).split('/').filter(Boolean).pop();
  return lastPart || value;
}

function countNodes(node: CompareDisplayNode): number {
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}

function refreshDisplayStatuses(root: CompareDisplayNode): void {
  const stack: Array<{ node: CompareDisplayNode; visited: boolean }> = [{ node: root, visited: false }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!current.visited) {
      stack.push({ node: current.node, visited: true });
      for (const child of current.node.children) {stack.push({ node: child, visited: false });}
      continue;
    }
    const node = current.node;
    if (!node.children.length) {continue;}
    const isGroup = node.kind === 'displayRoot' || node.kind === 'displayGroup' || node.kind === 'metadataTypeGroup' || node.kind === 'diagnosticsGroup';
    if (!isGroup && node.status !== 'equal') {continue;}
    const differences = node.children.map((child) => child.status).filter((status) => status !== 'equal');
    if (differences.length === 0) {
      if (isGroup) {node.status = 'equal';}
      continue;
    }
    node.status = differences.every((status) => status === 'leftOnly')
      ? 'leftOnly'
      : differences.every((status) => status === 'rightOnly')
        ? 'rightOnly'
        : 'changed';
  }
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
