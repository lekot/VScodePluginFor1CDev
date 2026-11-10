import type { CompareCancellationToken } from './compareCancellation';
import type { CompareTreeProjection } from './projection/compareTreeProjection';
import type { CompareTreeNode } from './compareTreeTypes';

/**
 * A read-only observation of work performed while a configuration comparison is built.
 * Progress callbacks are advisory: callback exceptions are ignored so UI code cannot fail a compare.
 */
export interface CompareBuildProgress {
  phase: 'detecting' | 'metadata' | 'inventory' | 'bsl' | 'comparing' | 'projecting';
  completed?: number;
  total?: number;
  projection?: CompareTreeProjection;
}

export interface CompareBuildOptions {
  cancellation?: CompareCancellationToken;
  onProgress?: (progress: CompareBuildProgress) => void;
}

/** Progress is advisory: a UI observer must never fail a comparison build. */
export function publishCompareBuildProgress(
  options: CompareBuildOptions,
  progress: CompareBuildProgress
): void {
  if (!options.onProgress) {
    return;
  }
  try {
    options.onProgress?.(progress);
  } catch {
    // Ignore observer failures; the comparison remains authoritative.
  }
}

/** Clone a projection for interim display and remove every executable marker. */
export function createReadOnlyCompareProjection(
  projection: CompareTreeProjection
): CompareTreeProjection {
  return {
    root: cloneReadOnlyNode(projection.root),
    stats: { ...projection.stats, mergeable: 0 },
  };
}

function cloneReadOnlyNode(node: CompareTreeNode): CompareTreeNode {
  return {
    ...node,
    mergeable: false,
    ...(node.conflict ? { conflict: { ...node.conflict } } : {}),
    ...(node.mergeState ? { mergeState: { ...node.mergeState } } : {}),
    ...(node.presentation
      ? {
          presentation: {
            ...node.presentation,
            ...(node.presentation.ownerAliases
              ? { ownerAliases: [...node.presentation.ownerAliases] }
              : {}),
            ...(node.presentation.identities
              ? { identities: node.presentation.identities.map((identity) => ({ ...identity })) }
              : {}),
          },
        }
      : {}),
    children: node.children.map(cloneReadOnlyNode),
  };
}
