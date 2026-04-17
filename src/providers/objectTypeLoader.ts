import * as path from 'path';
import { TreeNode } from '../models/treeNode';
import { Logger } from '../utils/logger';
import type { ObjectableGroup } from '../types/objectTypeDefinitions';
import { MetadataParser } from '../parsers/metadataParser';
import { METADATA_TYPE_TO_OBJECT_KIND, OBJECT_KIND_ORDER, ALL_MANAGER_KINDS } from '../constants/metadataTypeObjectKinds';
import { resolveRootsToUse } from './treeReferenceLoader';
import { TreeCacheService } from './treeCacheService';

const OBJECTABLE_METADATA_TYPES = new Set(Object.keys(METADATA_TYPE_TO_OBJECT_KIND));

/** Deep copy so callers cannot mutate cached snapshot. */
export function cloneObjectableGroups(groups: ObjectableGroup[]): ObjectableGroup[] {
  return groups.map((g) => ({
    objectKind: g.objectKind,
    objectNames: g.objectNames.slice(),
  }));
}

function aggregateObjectableGroupsFromRoots(rootsToUse: readonly TreeNode[]): ObjectableGroup[] {
  const byKind = new Map<string, Set<string>>();

  for (const root of rootsToUse) {
    if (!root.children) {
      continue;
    }
    for (const child of root.children) {
      if (!OBJECTABLE_METADATA_TYPES.has(child.type)) {
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
  return aggregateObjectableGroupsFromRoots(rootNodes);
}

/**
 * Returns object-kind groups for the ObjectTypeEditor, ensuring that the underlying
 * metadata type nodes are loaded (parallel lazy load via MetadataParser.parseTypeContents).
 */
export async function getObjectableObjectsForEditor(
  node: TreeNode | undefined,
  rootNodes: readonly TreeNode[],
  cache: TreeCacheService
): Promise<ObjectableGroup[]> {
  const rootsToUse = resolveRootsToUse(node, rootNodes);

  if (!rootsToUse.length) {
    // Even with no roots, always include Manager-kinds and empty DefinedType group.
    return OBJECT_KIND_ORDER.map((objectKind) => ({
      objectKind,
      objectNames: ALL_MANAGER_KINDS.includes(objectKind) ? [''] : [],
    }));
  }

  type LoadTask = { typeNode: TreeNode; configPath: string };
  const loadTasks: LoadTask[] = [];

  for (const root of rootsToUse) {
    if (!root.children || root.children.length === 0) {
      continue;
    }

    const configPath =
      cache.getLoadContext(root.id)?.configPath ?? (root.filePath ? path.dirname(root.filePath) : null);

    if (!configPath) {
      continue;
    }

    for (const typeNode of root.children) {
      if (!OBJECTABLE_METADATA_TYPES.has(typeNode.type)) {
        continue;
      }
      if (typeNode.children && typeNode.children.length > 0) {
        continue;
      }
      loadTasks.push({ typeNode, configPath });
    }
  }

  if (loadTasks.length > 0) {
    const settled = await Promise.all(
      loadTasks.map(async ({ typeNode, configPath }) => {
        try {
          const children = await MetadataParser.parseTypeContents(configPath, typeNode.id);
          return { typeNode, children };
        } catch (e) {
          Logger.warn('Failed to eager load objectable type contents for object type editor', {
            configPath,
            typeNodeId: typeNode.id,
            error: e instanceof Error ? e.message : String(e),
          });
          return { typeNode, children: [] as TreeNode[] };
        }
      })
    );

    for (const { typeNode, children } of settled) {
      for (const c of children) {
        c.parent = typeNode;
      }
      typeNode.children = children;
      for (const c of children) {
        cache.buildCache(c);
      }
    }
  }

  return aggregateObjectableGroupsFromRoots(rootsToUse);
}
