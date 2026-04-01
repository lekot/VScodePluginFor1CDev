import * as path from 'path';
import { MetadataType, TreeNode } from '../models/treeNode';
import type { CompositionObjectEntry } from './compositionTypes';

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
 * Collect all metadata objects that can be included in a subsystem composition.
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
  // --- 1. Build ancestor set (all parent Subsystem nodes) ---
  const ancestorIds = new Set<string>();
  let p: TreeNode | undefined = subsystemNode.parent;
  while (p) {
    if (p.type === MetadataType.Subsystem) {
      ancestorIds.add(p.id);
    }
    p = p.parent;
  }

  // --- 2. Determine which roots are visible ---
  const firstRootConfigPath =
    rootNodes[0]?.filePath ? normalisePath(path.dirname(rootNodes[0].filePath)) : null;

  const normalisedSubsystemConfigPath =
    subsystemConfigPath ? normalisePath(subsystemConfigPath) : null;

  const isSubsystemInMainConfig =
    normalisedSubsystemConfigPath !== null &&
    normalisedSubsystemConfigPath === firstRootConfigPath;

  const visibleRoots: TreeNode[] = isSubsystemInMainConfig
    ? rootNodes.filter((r) => {
        const rcp = r.filePath ? normalisePath(path.dirname(r.filePath)) : null;
        return rcp === normalisedSubsystemConfigPath;
      })
    : [...rootNodes]; // extension sees all configurations

  // --- 3. Walk visible roots → type-folders → elements ---
  const result: CompositionObjectEntry[] = [];

  for (const root of visibleRoots) {
    if (!root.children) {
      continue;
    }
    for (const typeFolder of root.children) {
      if (!typeFolder.children) {
        continue;
      }

      // Subsystems require recursive traversal for nested subsystems
      if (typeFolder.type === MetadataType.Subsystem) {
        for (const child of typeFolder.children) {
          collectSubsystems(child, ancestorIds, result);
        }
        continue;
      }

      for (const element of typeFolder.children) {
        if (!COMPOSITION_ELIGIBLE_TYPES.has(element.type)) {
          continue;
        }
        // Skip ancestors of the current subsystem
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
  }

  // --- 4. Sort by type, then by displayName ---
  result.sort((a, b) => {
    const typeCmp = a.type.localeCompare(b.type);
    return typeCmp !== 0 ? typeCmp : a.displayName.localeCompare(b.displayName);
  });

  return result;
}
