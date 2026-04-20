import * as path from 'path';
import { MetadataType, TreeNode } from '../models/treeNode';
import type { CompositionObjectEntry, CompositionTypeContainer } from './compositionContracts';

/**
 * Top-level metadata types eligible for subsystem composition.
 * Exported so SubsystemStrategy can import and pass it as `eligibleTypes`.
 */
export const SUBSYSTEM_ELIGIBLE_TYPES: ReadonlySet<string> = new Set<string>([
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
 * Recursively collect all Subsystem nodes, skipping excluded node ids.
 */
function collectSubsystems(
  node: TreeNode,
  excludedNodeIds: ReadonlySet<string>,
  result: CompositionObjectEntry[],
): void {
  if (node.type === MetadataType.Subsystem) {
    if (!excludedNodeIds.has(node.id)) {
      result.push({
        ref: `Subsystem.${node.name}`,
        displayName: node.name,
        type: MetadataType.Subsystem,
      });
    }
    // Recurse into child subsystems regardless of exclusion status
    // (children of an excluded ancestor may still be valid composition targets)
    if (node.children) {
      for (const child of node.children) {
        if (child.type === MetadataType.Subsystem) {
          collectSubsystems(child, excludedNodeIds, result);
        }
      }
    }
  }
}

function isExtensionConfigurationRoot(root: TreeNode): boolean {
  return (
    typeof root.properties.extensionPurpose === 'string' ||
    root.properties.isExtension === true
  );
}

/**
 * Determine which root nodes are visible for the given config path.
 *
 * - Editing a **non-extension** configuration in a multi-root workspace → only root(s) whose
 *   `Configuration.xml` directory matches `nodeConfigPath` (order-independent; avoids dedupe/expand
 *   picking the wrong tree when another root is listed first).
 * - Editing an **extension** configuration → all roots (base + extension merge for composition).
 * - Unknown `nodeConfigPath` or no matching root → all roots (backward-compatible fallback).
 */
export function resolveVisibleRoots(
  rootNodes: readonly TreeNode[],
  nodeConfigPath: string | null,
): TreeNode[] {
  if (rootNodes.length === 0) {
    return [];
  }
  if (!nodeConfigPath) {
    return [...rootNodes];
  }

  const ncp = normalisePath(nodeConfigPath);
  const rootsAtPath = rootNodes.filter(
    (r) => r.filePath && normalisePath(path.dirname(r.filePath)) === ncp,
  );
  if (rootsAtPath.length === 0) {
    return [...rootNodes];
  }

  if (rootNodes.length === 1) {
    return rootsAtPath;
  }

  if (rootsAtPath.some((r) => isExtensionConfigurationRoot(r))) {
    return [...rootNodes];
  }

  return rootsAtPath;
}

/**
 * Find a top-level type-folder node (e.g. `ExchangePlans`) under the same visible roots
 * as {@link collectObjectsForType} / {@link collectTypeFolders}.
 */
export function findCompositionTypeFolder(
  rootNodes: readonly TreeNode[],
  configPath: string | null,
  typeFolderId: string,
): TreeNode | undefined {
  const visibleRoots = resolveVisibleRoots(rootNodes, configPath);
  for (const root of visibleRoots) {
    const found = root.children?.find((c) => c.id === typeFolderId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Build ancestor id set from the given node upward through Subsystem ancestors.
 * Exported for use by SubsystemStrategy.
 */
export function buildAncestorIds(node: TreeNode): Set<string> {
  const ancestorIds = new Set<string>();
  let p: TreeNode | undefined = node.parent;
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
 * @param rootNodes            All configuration root nodes from the tree provider.
 * @param node                 The node being edited (used only for config path resolution).
 * @param configPath           Config path for the node's configuration (may be null).
 * @param checkedRefs          Currently checked refs (for `checkedCount` approximation).
 * @param eligibleTypes        Set of MetadataType strings that are eligible for this composition.
 * @param showNestedSubsystems When true, the Subsystem type folder is included.
 * @returns Sorted list of CompositionTypeContainer items.
 */
export function collectTypeFolders(
  rootNodes: readonly TreeNode[],
  _node: TreeNode,
  configPath: string | null,
  checkedRefs: ReadonlySet<string>,
  eligibleTypes: ReadonlySet<string>,
  showNestedSubsystems?: boolean,
): CompositionTypeContainer[] {
  const visibleRoots = resolveVisibleRoots(rootNodes, configPath);

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

      const isSubsystemFolder = typeFolder.type === MetadataType.Subsystem;

      // Skip Subsystem folder when showNestedSubsystems is not enabled
      if (isSubsystemFolder && !showNestedSubsystems) {
        continue;
      }

      // Skip non-eligible type folders
      if (!isSubsystemFolder && !eligibleTypes.has(typeFolder.type)) {
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
 * @param rootNodes            All configuration root nodes from the tree provider.
 * @param configPath           Config path for the node's configuration (may be null).
 * @param typeFolderId         ID of the type folder to collect objects from.
 * @param excludedNodeIds      Node IDs to exclude from the result (e.g. ancestor subsystems).
 * @param eligibleTypes        Set of MetadataType strings that are eligible for this composition.
 * @param showNestedSubsystems When true, subsystem objects use recursive collectSubsystems logic.
 * @returns Sorted list of CompositionObjectEntry items.
 */
export function collectObjectsForType(
  rootNodes: readonly TreeNode[],
  configPath: string | null,
  typeFolderId: string,
  excludedNodeIds: ReadonlySet<string>,
  eligibleTypes: ReadonlySet<string>,
  showNestedSubsystems?: boolean,
): CompositionObjectEntry[] {
  const typeFolder = findCompositionTypeFolder(rootNodes, configPath, typeFolderId);

  if (!typeFolder || !typeFolder.children) {
    return [];
  }

  const result: CompositionObjectEntry[] = [];

  if (typeFolder.type === MetadataType.Subsystem && showNestedSubsystems) {
    for (const child of typeFolder.children) {
      collectSubsystems(child, excludedNodeIds, result);
    }
  } else {
    for (const element of typeFolder.children) {
      if (!eligibleTypes.has(element.type)) {
        continue;
      }
      if (excludedNodeIds.has(element.id)) {
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
 * Build orphan entries — refs that are checked in the composition XML but whose
 * objects are not found in the metadata tree for the given metadataType.
 *
 * @param checkedRefs   Currently checked refs from the composition XML.
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
