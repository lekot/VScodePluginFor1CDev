import * as path from 'path';
import { MetadataType, TreeNode } from '../models/treeNode';
import type { CompositionObjectEntry, CompositionTypeContainer } from './compositionTypes';

/**
 * Top-level metadata types that can be included in a subsystem composition.
 */
const COMPOSITION_ELIGIBLE_TYPES = new Set<MetadataType>([
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.Enum,
  MetadataType.Report,
  MetadataType.DataProcessor,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfAccounts,
  MetadataType.ChartOfCalculationTypes,
  MetadataType.InformationRegister,
  MetadataType.AccumulationRegister,
  MetadataType.AccountingRegister,
  MetadataType.CalculationRegister,
  MetadataType.BusinessProcess,
  MetadataType.Task,
  MetadataType.ExternalDataSource,
  MetadataType.Constant,
  MetadataType.SessionParameter,
  MetadataType.FilterCriterion,
  MetadataType.ScheduledJob,
  MetadataType.FunctionalOption,
  MetadataType.FunctionalOptionsParameter,
  MetadataType.SettingsStorage,
  MetadataType.EventSubscription,
  MetadataType.CommonModule,
  MetadataType.CommandGroup,
  MetadataType.Command,
  MetadataType.Role,
  MetadataType.WebService,
  MetadataType.HTTPService,
  MetadataType.IntegrationService,
  MetadataType.Subsystem,
  MetadataType.ExchangePlan,
  MetadataType.DocumentJournal,
  MetadataType.DefinedType,
  MetadataType.CommonAttribute,
  MetadataType.CommonCommand,
  MetadataType.CommonForm,
  MetadataType.CommonPicture,
  MetadataType.CommonTemplate,
  MetadataType.DocumentNumerator,
]);

/**
 * Normalise a path for case-insensitive comparison (Windows-safe).
 */
function normalisePath(p: string): string {
  return path.resolve(p).toLowerCase();
}

/**
 * Recursively collect all Subsystem nodes, skipping ancestors of the current subsystem.
 */
function collectSubsystems(
  node: TreeNode,
  ancestorIds: Set<string>,
  result: CompositionObjectEntry[],
): void {
  if (node.type === MetadataType.Subsystem) {
    if (!ancestorIds.has(node.id)) {
      result.push({
        ref: `Subsystem.${node.name}`,
        displayName: node.name,
        type: MetadataType.Subsystem,
      });
    }
    // Recurse into child subsystems regardless of ancestor status
    // (children of an ancestor may still be valid composition targets)
    if (node.children) {
      for (const child of node.children) {
        if (child.type === MetadataType.Subsystem) {
          collectSubsystems(child, ancestorIds, result);
        }
      }
    }
  }
}

/**
 * Determine which root nodes are visible for the given subsystem.
 *
 * - Subsystem in main config → only main config roots visible.
 * - Subsystem in extension → all roots visible.
 */
function resolveVisibleRoots(
  rootNodes: readonly TreeNode[],
  subsystemConfigPath: string | null,
): TreeNode[] {
  const firstRootConfigPath =
    rootNodes[0]?.filePath ? normalisePath(path.dirname(rootNodes[0].filePath)) : null;

  const normalisedSubsystemConfigPath =
    subsystemConfigPath ? normalisePath(subsystemConfigPath) : null;

  const isSubsystemInMainConfig =
    normalisedSubsystemConfigPath !== null &&
    normalisedSubsystemConfigPath === firstRootConfigPath;

  return isSubsystemInMainConfig
    ? rootNodes.filter((r) => {
        const rcp = r.filePath ? normalisePath(path.dirname(r.filePath)) : null;
        return rcp === normalisedSubsystemConfigPath;
      })
    : [...rootNodes]; // extension sees all configurations
}

/**
 * Build ancestor id set from the given subsystem node upward.
 */
function buildAncestorIds(subsystemNode: TreeNode): Set<string> {
  const ancestorIds = new Set<string>();
  let p: TreeNode | undefined = subsystemNode.parent;
  while (p) {
    if (p.type === MetadataType.Subsystem) {
      ancestorIds.add(p.id);
    }
    p = p.parent;
  }
  return ancestorIds;
}

/**
 * Collect type-folder containers for lazy tree rendering.
 *
 * Fast and synchronous — does NOT load children. If a type folder's children
 * are not yet loaded, `objectCount` will be `null`.
 *
 * @param rootNodes           All configuration root nodes from the tree provider.
 * @param subsystemNode       The subsystem being edited.
 * @param subsystemConfigPath Config path for the subsystem's configuration (may be null).
 * @param checkedRefs         Currently checked refs (for `checkedCount` approximation).
 * @returns Sorted list of CompositionTypeContainer items.
 */
export function collectTypeFolders(
  rootNodes: readonly TreeNode[],
  _subsystemNode: TreeNode,
  subsystemConfigPath: string | null,
  checkedRefs: ReadonlySet<string>,
): CompositionTypeContainer[] {
  const visibleRoots = resolveVisibleRoots(rootNodes, subsystemConfigPath);

  const seen = new Map<string, CompositionTypeContainer>();

  for (const root of visibleRoots) {
    if (!root.children) {
      continue;
    }
    for (const typeFolder of root.children) {
      // Skip already processed type folders (deduplication)
      if (seen.has(typeFolder.id)) {
        continue;
      }

      // Determine if this type folder is eligible
      const isSubsystemFolder = typeFolder.type === MetadataType.Subsystem;
      if (!isSubsystemFolder && !COMPOSITION_ELIGIBLE_TYPES.has(typeFolder.type)) {
        continue;
      }

      const metadataType: string = isSubsystemFolder
        ? MetadataType.Subsystem
        : (typeFolder.children?.[0]?.type ?? typeFolder.type);

      const objectCount: number | null =
        typeFolder.children !== undefined && typeFolder.children.length > 0
          ? typeFolder.children.length
          : null;

      // Approximate checkedCount based on ref prefix
      let checkedCount = 0;
      for (const ref of checkedRefs) {
        if (isSubsystemFolder) {
          if (ref.startsWith('Subsystem.')) {
            checkedCount++;
          }
        } else {
          if (ref.startsWith(`${metadataType}.`)) {
            checkedCount++;
          }
        }
      }

      seen.set(typeFolder.id, {
        typeFolderId: typeFolder.id,
        metadataType,
        displayName: typeFolder.name,
        objectCount,
        checkedCount,
      });
    }
  }

  const result = [...seen.values()];
  result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return result;
}

/**
 * Collect metadata objects for a specific type folder.
 *
 * Synchronous — works only with already-loaded children. If children are not
 * loaded yet, returns []. Call treeProvider.getChildren(typeFolder) first.
 *
 * @param rootNodes           All configuration root nodes from the tree provider.
 * @param subsystemNode       The subsystem being edited.
 * @param subsystemConfigPath Config path for the subsystem's configuration (may be null).
 * @param typeFolderId        ID of the type folder to collect objects from.
 * @returns Sorted list of CompositionObjectEntry items.
 */
export function collectObjectsForType(
  rootNodes: readonly TreeNode[],
  subsystemNode: TreeNode,
  subsystemConfigPath: string | null,
  typeFolderId: string,
): CompositionObjectEntry[] {
  const ancestorIds = buildAncestorIds(subsystemNode);
  const visibleRoots = resolveVisibleRoots(rootNodes, subsystemConfigPath);

  let typeFolder: TreeNode | undefined;
  for (const root of visibleRoots) {
    typeFolder = root.children?.find(c => c.id === typeFolderId);
    if (typeFolder) {
      break;
    }
  }

  if (!typeFolder || !typeFolder.children) {
    return [];
  }

  const result: CompositionObjectEntry[] = [];

  if (typeFolder.type === MetadataType.Subsystem) {
    for (const child of typeFolder.children) {
      collectSubsystems(child, ancestorIds, result);
    }
  } else {
    for (const element of typeFolder.children) {
      if (!COMPOSITION_ELIGIBLE_TYPES.has(element.type)) {
        continue;
      }
      if (ancestorIds.has(element.id)) {
        continue;
      }
      result.push({
        ref: `${element.type}.${element.name}`,
        displayName: element.name,
        type: element.type,
      });
    }
  }

  result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return result;
}

/**
 * Build orphan entries — refs that are checked in the subsystem XML but whose
 * objects are not found in the metadata tree for the given metadataType.
 *
 * @param checkedRefs   Currently checked refs from the subsystem XML.
 * @param metadataType  Metadata type prefix (e.g. "Catalog").
 * @param knownObjects  Objects already collected from the tree for this type.
 * @returns Sorted list of orphan CompositionObjectEntry items.
 */
export function buildOrphanEntries(
  checkedRefs: ReadonlySet<string>,
  metadataType: string,
  knownObjects: readonly CompositionObjectEntry[],
): CompositionObjectEntry[] {
  const knownRefs = new Set(knownObjects.map(o => o.ref));
  const prefix = `${metadataType}.`;
  const result: CompositionObjectEntry[] = [];
  for (const ref of checkedRefs) {
    if (ref.startsWith(prefix) && !knownRefs.has(ref)) {
      result.push({
        ref,
        displayName: ref.slice(prefix.length),
        type: metadataType,
        orphan: true,
      });
    }
  }
  result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return result;
}

/**
 * Collect all metadata objects that can be included in a subsystem composition.
 *
 * @deprecated Используйте collectTypeFolders + collectObjectsForType
 *
 * Visibility rules:
 * - If the subsystem belongs to the main (first) configuration, only objects from
 *   that configuration are visible (extensions are not visible from the main config).
 * - If the subsystem belongs to an extension (not the first root), objects from all
 *   configurations are visible (extension sees the main config and its own objects).
 *
 * @param rootNodes   All configuration root nodes from the tree provider.
 * @param subsystemNode  The subsystem being edited.
 * @param subsystemConfigPath  Config path for the subsystem's configuration (may be null).
 * @returns Sorted list of eligible CompositionObjectEntry items.
 */
export function collectCompositionEligibleObjects(
  rootNodes: readonly TreeNode[],
  subsystemNode: TreeNode,
  subsystemConfigPath: string | null,
): CompositionObjectEntry[] {
  const containers = collectTypeFolders(rootNodes, subsystemNode, subsystemConfigPath, new Set());
  const result: CompositionObjectEntry[] = [];
  for (const c of containers) {
    result.push(...collectObjectsForType(rootNodes, subsystemNode, subsystemConfigPath, c.typeFolderId));
  }
  result.sort((a, b) => {
    const typeCmp = a.type.localeCompare(b.type);
    return typeCmp !== 0 ? typeCmp : a.displayName.localeCompare(b.displayName);
  });
  return result;
}
