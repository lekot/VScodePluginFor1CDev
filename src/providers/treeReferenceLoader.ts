import * as path from 'path';
import { compareCodeUnits } from '../utils/compareCodeUnits';
import { TreeNode, MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import type { ReferenceableGroup } from '../types/typeDefinitions';
import { MetadataParser } from '../parsers/metadataParser';
import { ConfigFormat } from '../parsers/formatDetector';
import { METADATA_TYPE_TO_REFERENCE_KIND } from '../constants/metadataTypeReferenceKinds';
import { TreeCacheService } from './treeCacheService';
import { configurationPathKey } from '../utils/configurationPathIdentity';
import type { ConfigurationId } from '../services/configurationSession/types';

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

function resolveTypeEditorConfigRoot(
  node: TreeNode | undefined,
  rootNodes: readonly TreeNode[]
): TreeNode | null {
  if (!node) {
    return null;
  }
  let cur: TreeNode | undefined = node;
  let selectedConfigRoot: TreeNode | undefined;
  while (cur) {
    if (cur.type === MetadataType.Configuration) {
      selectedConfigRoot = cur;
      break;
    }
    cur = cur.parent;
  }
  if (!selectedConfigRoot) {
    throw new TreeConfigurationScopeUnavailableError();
  }
  const activeRoot = rootNodes.find((root) => root === selectedConfigRoot);
  if (activeRoot) {
    return activeRoot;
  }
  if (selectedConfigRoot.configurationId) {
    const replacement = rootNodes.find((root) =>
      root.type === MetadataType.Configuration
      && root.configurationId === selectedConfigRoot.configurationId,
    );
    if (replacement) {
      return replacement;
    }
  }
  throw new TreeConfigurationScopeUnavailableError(selectedConfigRoot.configurationId);
}

export class TreeConfigurationScopeUnavailableError extends Error {
  readonly code = 'TREE_CONFIGURATION_SCOPE_UNAVAILABLE';

  constructor(configurationId?: ConfigurationId) {
    super(configurationId
      ? `Выбранная конфигурация ${configurationId} отсутствует в опубликованном дереве.`
      : 'Не удалось определить выбранную конфигурацию в опубликованном дереве.');
    this.name = 'TreeConfigurationScopeUnavailableError';
  }
}

export function resolveRootsToUse(
  node: TreeNode | undefined,
  rootNodes: readonly TreeNode[]
): readonly TreeNode[] {
  const configRoot = resolveTypeEditorConfigRoot(node, rootNodes);
  return configRoot ? [configRoot] : rootNodes;
}

function configRootScopeFingerprint(root: TreeNode, cache: TreeCacheService): string {
  const context = cache.getLoadContext(root);
  if (context) {
    return 'configuration:' + context.configurationId;
  }
  if (root.configurationId) {
    return 'configuration:' + root.configurationId;
  }
  if (root.filePath) {
    return 'path:' + configurationPathKey(path.dirname(root.filePath));
  }
  return 'node:' + root.id;
}

/**
 * Stable cache key for {@link getReferenceableObjectsForTypeEditor} results, or null when empty / not cacheable.
 */
export function getTypeEditorReferenceableScopeKey(
  node: TreeNode | undefined,
  rootNodes: readonly TreeNode[],
  cache: TreeCacheService
): string | null {
  const rootsToUse = resolveRootsToUse(node, rootNodes);
  if (!rootsToUse.length) {
    return null;
  }
  const configRoot = resolveTypeEditorConfigRoot(node, rootNodes);
  if (configRoot) {
    return `cfg:${configRootScopeFingerprint(configRoot, cache)}`;
  }
  return `all:${[...rootNodes].map((r) => configRootScopeFingerprint(r, cache)).sort(compareCodeUnits).join('|')}`;
}

/**
 * Number of referenceable type folders that still need disk parse (empty children).
 */
export function countPendingReferenceableTypeLoads(
  node: TreeNode | undefined,
  rootNodes: readonly TreeNode[],
  cache: TreeCacheService
): number {
  const rootsToUse = resolveRootsToUse(node, rootNodes);
  let n = 0;
  for (const root of rootsToUse) {
    if (!root.children || root.children.length === 0) {
      continue;
    }
    const loadContext = cache.getLoadContext(root);
    if (!loadContext) {
      continue;
    }
    for (const typeNode of root.children) {
      if (!REFERENCEABLE_METADATA_TYPES.has(typeNode.type)) {
        continue;
      }
      if (typeNode.children && typeNode.children.length > 0) {
        continue;
      }
      n++;
    }
  }
  return n;
}

/** Deep copy so callers cannot mutate cached snapshot. */
export function cloneReferenceableGroups(groups: ReferenceableGroup[]): ReferenceableGroup[] {
  return groups.map((g) => ({
    referenceKind: g.referenceKind,
    objectNames: g.objectNames.slice(),
  }));
}

/**
 * Returns referenceable objects for the type editor: each reference kind with its project object names.
 * Aggregates from all given roots (first root used for kind order; names merged per kind).
 */
export function getReferenceableObjects(rootNodes: readonly TreeNode[]): ReferenceableGroup[] {
  const byKind = new Map<string, Set<string>>();
  for (const root of rootNodes) {
    if (!root.children) {
      continue;
    }
    for (const node of root.children) {
      if (!REFERENCEABLE_METADATA_TYPES.has(node.type)) {
        continue;
      }
      const referenceKind = METADATA_TYPE_TO_REFERENCE_KIND[node.type];
      if (!referenceKind) {
        continue;
      }
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

function aggregateReferenceableGroupsFromRoots(rootsToUse: readonly TreeNode[]): ReferenceableGroup[] {
  const byKind = new Map<string, Set<string>>();
  for (const root of rootsToUse) {
    if (!root.children) {
      continue;
    }
    for (const child of root.children) {
      if (!REFERENCEABLE_METADATA_TYPES.has(child.type)) {
        continue;
      }
      const referenceKind = METADATA_TYPE_TO_REFERENCE_KIND[child.type];
      if (!referenceKind) {
        continue;
      }
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
  const rootsToUse = resolveRootsToUse(node, rootNodes);

  if (!rootsToUse.length) {
    return [];
  }

  type LoadTask = { typeNode: TreeNode; configPath: string; format: ConfigFormat };
  const loadTasks: LoadTask[] = [];

  for (const root of rootsToUse) {
    if (!root.children || root.children.length === 0) {
      continue;
    }

    const loadContext = cache.getLoadContext(root);
    if (!loadContext) {
      continue;
    }
    const configPath = loadContext.configPath;

    for (const typeNode of root.children) {
      if (!REFERENCEABLE_METADATA_TYPES.has(typeNode.type)) {
        continue;
      }
      if (typeNode.children && typeNode.children.length > 0) {
        continue;
      }
      loadTasks.push({ typeNode, configPath, format: loadContext.format });
    }
  }

  if (loadTasks.length > 0) {
    const settled = await Promise.all(
      loadTasks.map(async ({ typeNode, configPath, format }) => {
        try {
          const children = await MetadataParser.parseTypeIndex(configPath, typeNode.id, { format });
          return { typeNode, children };
        } catch (e) {
          Logger.warn('Failed to eager load referenceable type contents for type editor', {
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

  return aggregateReferenceableGroupsFromRoots(rootsToUse);
}
