import type { TreeNode } from '../models/treeNode';

export type TreeLoadErrorCode =
  | 'TREE_LOAD_FAILED'
  | 'TREE_LOAD_SUPERSEDED'
  | 'TREE_LOAD_DISPOSED'
  | 'CONFIGURATION_CONTEXT_UNAVAILABLE';

export class TreeLoadError extends Error {
  constructor(
    readonly code: TreeLoadErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TreeLoadError';
  }
}

export type TreeTypeLoadResult =
  | { readonly status: 'loaded'; readonly children: readonly TreeNode[] }
  | { readonly status: 'failed'; readonly error: TreeLoadError }
  | { readonly status: 'superseded'; readonly error: TreeLoadError }
  | { readonly status: 'disposed'; readonly error: TreeLoadError };

export function unwrapTreeTypeLoadResult(result: TreeTypeLoadResult): TreeNode[] {
  if (result.status === 'loaded') {
    return [...result.children];
  }
  throw result.error;
}
