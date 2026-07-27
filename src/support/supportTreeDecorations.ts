import * as path from 'path';
import { METADATA_TYPE_DESCRIPTORS } from '../constants/metadataTypeDescriptors';
import { MetadataType, type TreeNode } from '../models/treeNode';
import { resolveMetadataUniverseEntry } from './metadataUniverseResolver';
import type { CachedSupportStatus } from './supportStateCache';
import type {
  ConfigurationSupportMode,
  MasterSupportSnapshot,
  MetadataUniverseEntry,
  ObjectSupportMode,
  ObjectSupportState,
  SupportRunSummary,
} from './supportTypes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONCRETE_OBJECT_TYPES = new Set(METADATA_TYPE_DESCRIPTORS.map((descriptor) => descriptor.type));

export type SupportConfigurationAggregate =
  | ConfigurationSupportMode
  | 'unmanaged'
  | 'unknown';

export type SupportSyncHealthState =
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'inDoubt'
  | 'stale'
  | 'obsolete';

export interface SupportSyncHealthDecoration {
  readonly state: SupportSyncHealthState;
  readonly tooltip: string;
}

export interface ConfigurationSupportDecoration {
  readonly kind: 'configuration';
  readonly mode: SupportConfigurationAggregate;
  readonly tooltip: string;
  readonly contextTokens: readonly string[];
  /** Replication health is deliberately independent from the master support mode. */
  readonly syncHealth?: SupportSyncHealthDecoration;
}

export interface ObjectSupportDecoration {
  readonly kind: 'object';
  readonly objectId: string;
  readonly locked: boolean;
  readonly effectiveMode: ObjectSupportMode;
  readonly iconIntent?: 'lock';
  readonly tooltip: string;
  readonly contextTokens: readonly string[];
}

export type SupportTreeDecoration =
  | ConfigurationSupportDecoration
  | ObjectSupportDecoration;

/** Resolves a support-only overlay without filesystem, parser or VS Code dependencies. */
export function resolveSupportTreeDecoration(
  node: TreeNode,
  cached: CachedSupportStatus | undefined,
): SupportTreeDecoration | undefined {
  if (!cached) {
    return undefined;
  }
  if (isRootConfiguration(node)) {
    return configurationDecoration(cached);
  }
  if (cached.master.kind !== 'ready') {
    return undefined;
  }
  const identity = resolveExactConcreteIdentity(node, cached);
  if (!identity) {
    return undefined;
  }
  const state = cached.master.snapshot.objectModes.get(identity.supportSubjectUuid);
  return state ? objectDecoration(state, cached.master.snapshot) : undefined;
}

export function resolveSupportSyncHealth(
  lastRun: SupportRunSummary | undefined,
): SupportSyncHealthDecoration | undefined {
  if (!lastRun || lastRun.state === 'complete') {
    return undefined;
  }
  if (lastRun.state === 'obsolete') {
    return { state: 'obsolete', tooltip: 'Синхронизация поддержки устарела: master generation изменилась.' };
  }
  if ('targets' in lastRun && lastRun.targets.some((target) => target.state === 'inDoubt')) {
    return { state: 'inDoubt', tooltip: 'Результат применения поддержки к одной или нескольким ИБ не определён.' };
  }
  if ('targets' in lastRun && lastRun.targets.some((target) => target.state === 'stale')) {
    return { state: 'stale', tooltip: 'Состояние поддержки одной или нескольких ИБ устарело.' };
  }
  const state = lastRun.state as 'partial' | 'failed' | 'cancelled';
  const labels: Record<typeof state, string> = {
    partial: 'Синхронизация поддержки завершена частично.',
    failed: 'Синхронизация поддержки не выполнена.',
    cancelled: 'Синхронизация поддержки отменена.',
  };
  return { state, tooltip: labels[state] };
}

function configurationDecoration(cached: CachedSupportStatus): ConfigurationSupportDecoration {
  const { master } = cached;
  const syncHealth = resolveSupportSyncHealth(cached.lastRun);
  if (master.kind === 'ready') {
    const mode = master.snapshot.configurationMode;
    return {
      kind: 'configuration',
      mode,
      tooltip: configurationTooltip(mode, master.snapshot),
      contextTokens: Object.freeze(['supportManaged', `supportConfiguration.${mode}`]),
      ...(syncHealth === undefined ? {} : { syncHealth }),
    };
  }
  if (master.kind === 'unmanaged') {
    return {
      kind: 'configuration',
      mode: 'unmanaged',
      tooltip: 'Конфигурация не находится на поддержке.',
      contextTokens: Object.freeze(['supportUnmanaged']),
      ...(syncHealth === undefined ? {} : { syncHealth }),
    };
  }
  return {
    kind: 'configuration',
    mode: 'unknown',
    tooltip: [
      'Состояние поддержки неизвестно.',
      'Изменение поддержки и deploy закрыты до восстановления ParentConfigurations.bin.',
      ...master.diagnostics,
    ].join('\n'),
    contextTokens: Object.freeze(['supportUnknown', 'supportWriteBlocked']),
    ...(syncHealth === undefined ? {} : { syncHealth }),
  };
}

function objectDecoration(
  state: ObjectSupportState,
  snapshot: MasterSupportSnapshot,
): ObjectSupportDecoration {
  return {
    kind: 'object',
    objectId: state.objectId,
    locked: state.locked,
    effectiveMode: state.effectiveMode,
    ...(state.locked ? { iconIntent: 'lock' as const } : {}),
    tooltip: objectTooltip(state, snapshot),
    contextTokens: Object.freeze([
      'supportObject',
      state.locked ? 'supportObject.locked' : 'supportObject.editable',
      `supportObject.${state.effectiveMode}`,
    ]),
  };
}

function configurationTooltip(
  mode: ConfigurationSupportMode,
  snapshot: MasterSupportSnapshot,
): string {
  const labels: Record<ConfigurationSupportMode, string> = {
    locked: 'заблокирована',
    mixed: 'смешанный режим',
    editable: 'редактирование разрешено',
  };
  const suppliers = snapshot.supplierConfigurations
    .map((supplier) => `• ${supplier.name} (${supplier.supplierConfigurationId})`)
    .join('\n');
  return [
    `Поддержка конфигурации: ${labels[mode]}.`,
    `Глобальное редактирование: ${snapshot.globalEditability === 'enabled' ? 'разрешено' : 'запрещено'}.`,
    ...(suppliers ? ['Родительские конфигурации:', suppliers] : []),
  ].join('\n');
}

function objectTooltip(state: ObjectSupportState, snapshot: MasterSupportSnapshot): string {
  const suppliers = new Map(snapshot.supplierConfigurations.map((supplier) => [
    supplier.supplierConfigurationId,
    supplier,
  ]));
  const sources = state.sources.map((source) => {
    const supplier = suppliers.get(source.supplierConfigurationId);
    const name = supplier?.name ?? 'Неизвестная родительская конфигурация';
    return `• ${name} (${source.supplierConfigurationId}): ${modeLabel(source.rawMode)}`;
  });
  return [
    state.locked ? 'Объект заблокирован поддержкой.' : 'Объект доступен для редактирования.',
    `Эффективный режим: ${modeLabel(state.effectiveMode)}.`,
    ...(snapshot.globalEditability === 'disabled'
      ? ['Глобальное редактирование конфигурации запрещено.']
      : []),
    ...(sources.length > 0 ? ['Источники поддержки:', ...sources] : []),
  ].join('\n');
}

function modeLabel(mode: ObjectSupportMode): string {
  const labels: Record<ObjectSupportMode, string> = {
    notEditable: 'не редактируется',
    editableWithSupport: 'редактируется с сохранением поддержки',
    removedFromSupport: 'снят с поддержки',
  };
  return labels[mode];
}

function isRootConfiguration(node: TreeNode): boolean {
  return node.type === MetadataType.Configuration && node.parent === undefined;
}

function parseNodeUuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

function resolveExactConcreteIdentity(
  node: TreeNode,
  cached: CachedSupportStatus,
): MetadataUniverseEntry | undefined {
  if (
    !CONCRETE_OBJECT_TYPES.has(node.type)
    || node.properties.isModule === true
    || node.properties.isVirtual === true
    || normalizePath(cached.metadataUniverse.configRoot) !== normalizePath(cached.configRoot)
  ) {
    return undefined;
  }
  const ownUuid = parseNodeUuid(node.properties.uuid);
  if (!ownUuid) {
    return undefined;
  }
  try {
    const resolved = resolveMetadataUniverseEntry(cached.metadataUniverse.configRoot, node);
    if (
      !resolved
      || resolved.objectUuid !== ownUuid
      || resolved.supportSubjectUuid !== ownUuid
    ) {
      return undefined;
    }
    if (!cached.metadataUniverseIdentityIndex.has(resolved)) {
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}

function normalizePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}
