import { TreeNode } from '../models/treeNode';
import type { ObjectableGroup } from '../types/objectTypeDefinitions';
import { METADATA_TYPE_TO_OBJECT_KIND, OBJECT_KIND_ORDER, ALL_MANAGER_KINDS } from '../constants/metadataTypeObjectKinds';
import { getTypeIndexFolders } from './typeFolderSelector';

const OBJECTABLE_METADATA_TYPES = new Set(Object.keys(METADATA_TYPE_TO_OBJECT_KIND));

export function isObjectableTypeFolder(typeFolder: TreeNode): boolean {
  return OBJECTABLE_METADATA_TYPES.has(typeFolder.type);
}

/** Deep copy so callers cannot mutate cached snapshot. */
export function cloneObjectableGroups(groups: ObjectableGroup[]): ObjectableGroup[] {
  return groups.map((g) => ({
    objectKind: g.objectKind,
    objectNames: g.objectNames.slice(),
  }));
}

export function projectObjectableObjectsForEditor(rootsToUse: readonly TreeNode[]): ObjectableGroup[] {
  const byKind = new Map<string, Set<string>>();

  for (const root of rootsToUse) {
    for (const child of getTypeIndexFolders(root)) {
      if (!isObjectableTypeFolder(child)) {
        continue;
      }
      const objectKind = METADATA_TYPE_TO_OBJECT_KIND[child.type];
      if (!objectKind) {
        continue;
      }
      const names = (child.children || []).map((c: TreeNode) => c.name);
      const set = byKind.get(objectKind) ?? new Set<string>();
      names.forEach((n: string) => set.add(n));
      byKind.set(objectKind, set);
    }
  }

  // Always add all 16 Manager-kinds with a single empty-name entry (they are "type as a whole").
  for (const managerKind of ALL_MANAGER_KINDS) {
    if (!byKind.has(managerKind)) {
      byKind.set(managerKind, new Set(['']));
    }
  }

  return OBJECT_KIND_ORDER.map((objectKind) => ({
    objectKind,
    objectNames: Array.from(byKind.get(objectKind) ?? []),
  }));
}

/**
 * Returns object-kind groups from root nodes without lazy loading.
 * Aggregates from all given roots; names merged per kind.
 */
export function getObjectableObjects(rootNodes: readonly TreeNode[]): ObjectableGroup[] {
  return projectObjectableObjectsForEditor(rootNodes);
}
