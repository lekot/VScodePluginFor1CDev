import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import type { ReferenceableGroup } from '../types/typeDefinitions';
import { MetadataParser } from '../parsers/metadataParser';
import { METADATA_TYPE_TO_REFERENCE_KIND } from '../constants/metadataTypeReferenceKinds';
import { TreeCacheService } from './treeCacheService';

const REFERENCEABLE_METADATA_TYPES: ReadonlySet<MetadataType> = new Set([
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.Enum,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfAccounts,
  MetadataType.ChartOfCalculationTypes,
]);

const REF_KIND_ORDER = [
  'CatalogRef',
  'DocumentRef',
  'EnumRef',
  'ChartOfCharacteristicTypesRef',
  'ChartOfAccountsRef',
  'ChartOfCalculationTypesRef',
];

/**
 * Returns referenceable objects for the type editor: each reference kind with its project object names.
 * Aggregates from all given roots (first root used for kind order; names merged per kind).
 */
export function getReferenceableObjects(rootNodes: readonly TreeNode[]): ReferenceableGroup[] {
  const byKind = new Map<string, Set<string>>();
  for (const root of rootNodes) {
    if (!root.children) { continue; }
    for (const node of root.children) {
      if (!REFERENCEABLE_METADATA_TYPES.has(node.type)) { continue; }
      const referenceKind = METADATA_TYPE_TO_REFERENCE_KIND[node.type];
      if (!referenceKind) { continue; }
      const names = (node.children || []).map((c) => c.name);
      const set = byKind.get(referenceKind) ?? new Set<string>();
      names.forEach((n) => set.add(n));
      byKind.set(referenceKind, set);
    }
  }
  return REF_KIND_ORDER.map((refKind) => ({
    referenceKind: refKind,
    objectNames: Array.from(byKind.get(refKind) ?? []),
  }));
}

/**
 * Returns referenceable objects for the type editor, ensuring that the underlying
 * metadata type nodes (Catalogs/Documents/Enums/...) are loaded.
 *
 * Problem: parseStructureOnly() creates type nodes with empty `children` (lazy loading).
 * If type editor gets an empty list, it can't offer "DocumentRef.<...>" selection.
 */
export async function getReferenceableObjectsForTypeEditor(
  node: TreeNode | undefined,
  rootNodes: readonly TreeNode[],
  cache: TreeCacheService
): Promise<ReferenceableGroup[]> {
  // Determine which configuration root we should use.
  // If `node` is provided, we restrict loading/aggregation to that configuration only.
  const configRoot = (() => {
    if (!node) { return null; }
    let cur: TreeNode | undefined = node;
    while (cur) {
      const curNode: TreeNode = cur;
      if (curNode.type === MetadataType.Configuration && rootNodes.some((r) => r.id === curNode.id)) {
        return curNode;
      }
      cur = curNode.parent;
    }
    return null;
  })();

  const rootsToUse = configRoot ? [configRoot] : rootNodes;

  // Load missing type contents (if `children` are empty) so that objectNames are available.
  for (const root of rootsToUse) {
    if (!root.children || root.children.length === 0) { continue; }

    const configPath =
      cache.getLoadContext(root.id)?.configPath ??
      (root.filePath ? path.dirname(root.filePath) : null);

    if (!configPath) { continue; }

    for (const typeNode of root.children) {
      if (!REFERENCEABLE_METADATA_TYPES.has(typeNode.type)) { continue; }
      if (typeNode.children && typeNode.children.length > 0) { continue; }

      try {
        const children = await MetadataParser.parseTypeContents(configPath, typeNode.id);
        for (const c of children) { c.parent = typeNode; }
        typeNode.children = children;

        // Update in-memory caches so other features can use the newly loaded nodes.
        for (const c of children) { cache.buildCache(c); }
      } catch (e) {
        Logger.warn('Failed to eager load referenceable type contents for type editor', {
          configPath,
          typeNodeId: typeNode.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // Aggregate only for selected roots.
  if (!rootsToUse.length) { return []; }

  const byKind = new Map<string, Set<string>>();
  for (const root of rootsToUse) {
    if (!root.children) { continue; }
    for (const child of root.children) {
      if (!REFERENCEABLE_METADATA_TYPES.has(child.type)) { continue; }
      const referenceKind = METADATA_TYPE_TO_REFERENCE_KIND[child.type];
      if (!referenceKind) { continue; }
      const names = (child.children || []).map((c: TreeNode) => c.name);
      const set = byKind.get(referenceKind) ?? new Set<string>();
      names.forEach((n: string) => set.add(n));
      byKind.set(referenceKind, set);
    }
  }

  return REF_KIND_ORDER.map((refKind) => ({
    referenceKind: refKind,
    objectNames: Array.from(byKind.get(refKind) ?? []),
  }));
}
