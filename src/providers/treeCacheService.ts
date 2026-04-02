import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { ConfigFormat } from '../parsers/formatDetector';

/**
 * Encapsulates node caching and lookup logic for the metadata tree.
 * Used by MetadataTreeDataProvider for fast node resolution and search.
 */
export class TreeCacheService {
  private nodeCache = new Map<string, TreeNode>();
  /** ID → all nodes with that ID (for collision-safe lookup). */
  private nodeCandidatesById = new Map<string, TreeNode[]>();
  /** Normalized name (lowercase) → node ids, for fast search. */
  private nameIndex = new Map<string, string[]>();
  /** Per-root load context for lazy loading (key = root node id). */
  loadContextByRootId = new Map<string, { configPath: string; format: ConfigFormat }>();

  // --- Cache management ---

  clear(): void {
    this.nodeCache.clear();
    this.nodeCandidatesById.clear();
    this.nameIndex.clear();
  }

  clearLoadContexts(): void {
    this.loadContextByRootId.clear();
  }

  setLoadContexts(map: Map<string, { configPath: string; format: ConfigFormat }>): void {
    this.loadContextByRootId = new Map(map);
  }

  setLoadContext(nodeId: string, ctx: { configPath: string; format: ConfigFormat }): void {
    this.loadContextByRootId.set(nodeId, ctx);
  }

  getLoadContext(nodeId: string): { configPath: string; format: ConfigFormat } | undefined {
    return this.loadContextByRootId.get(nodeId);
  }

  get size(): number {
    return this.nodeCache.size;
  }

  get nodes(): ReadonlyMap<string, TreeNode> {
    return this.nodeCache;
  }

  /**
   * Build cache for fast node lookup and name index for search.
   */
  buildCache(node: TreeNode): void {
    this.nodeCache.set(node.id, node);
    const candidates = this.nodeCandidatesById.get(node.id) ?? [];
    candidates.push(node);
    this.nodeCandidatesById.set(node.id, candidates);
    const key = (node.name || '').toLowerCase();
    if (key) {
      const list = this.nameIndex.get(key) ?? [];
      list.push(node.id);
      this.nameIndex.set(key, list);
    }
    if (node.children) {
      for (const child of node.children) {
        this.buildCache(child);
      }
    }
  }

  /**
   * Find a node by exact id. Returns null if not found.
   */
  findById(id: string): TreeNode | null {
    return this.nodeCache.get(id) ?? null;
  }

  /**
   * Find nodes by exact lowercase name (used for search).
   */
  findByName(key: string): TreeNode[] {
    const normalizedKey = (key || '').toLowerCase().trim();
    if (!normalizedKey) {return [];}
    const ids = this.nameIndex.get(normalizedKey);
    if (!ids) {return [];}
    const out: TreeNode[] = [];
    for (const id of ids) {
      const node = this.nodeCache.get(id);
      if (node) {out.push(node);}
    }
    return out;
  }

  /**
   * Search nodes by name (substring, case-insensitive). Uses name index for speed.
   * Returns only nodes currently in cache (loaded so far).
   */
  searchByName(query: string): TreeNode[] {
    const q = (query || '').trim().toLowerCase();
    if (!q) {return [];}
    const result: TreeNode[] = [];
    for (const [key, ids] of this.nameIndex) {
      if (key.includes(q)) {
        for (const id of ids) {
          const node = this.nodeCache.get(id);
          if (node) {result.push(node);}
        }
      }
    }
    return result;
  }

  getCandidatesById(id: string): TreeNode[] {
    return this.nodeCandidatesById.get(id) ?? [];
  }

  // --- Node resolution helpers ---

  private getNodeLineage(node: TreeNode): TreeNode[] {
    const lineage: TreeNode[] = [];
    let current: TreeNode | undefined = node;
    while (current) {
      lineage.push(current);
      current = current.parent;
    }
    return lineage.reverse();
  }

  private normalizeIdentityPath(value: string | undefined): string {
    return (value ?? '').replace(/\\/g, '/').toLowerCase();
  }

  private getConfigRootIdentity(root: TreeNode | null): string {
    if (!root) {return '';}
    const fromLoadContext = this.loadContextByRootId.get(root.id)?.configPath;
    if (fromLoadContext) {return this.normalizeIdentityPath(fromLoadContext);}
    if (root.filePath) {return this.normalizeIdentityPath(path.dirname(root.filePath));}
    return this.normalizeIdentityPath(root.id);
  }

  getNodeRootIdentity(node: TreeNode): string {
    return this.getConfigRootIdentity(this.getConfigurationRoot(node));
  }

  private getLineageSignature(node: TreeNode): string {
    const lineage = this.getNodeLineage(node);
    return lineage.map((part) => `${part.type}:${part.name}:${part.id}`).join(' > ');
  }

  private preferCandidateOnTie(target: TreeNode, currentBest: TreeNode, candidate: TreeNode): TreeNode {
    const targetRootIdentity = this.getNodeRootIdentity(target);
    if (targetRootIdentity) {
      const bestMatchesRoot = this.getNodeRootIdentity(currentBest) === targetRootIdentity;
      const candidateMatchesRoot = this.getNodeRootIdentity(candidate) === targetRootIdentity;
      if (candidateMatchesRoot !== bestMatchesRoot) {
        return candidateMatchesRoot ? candidate : currentBest;
      }
    }

    const bestHasParent = currentBest.parent != null;
    const candidateHasParent = candidate.parent != null;
    if (candidateHasParent !== bestHasParent) {
      return candidateHasParent ? candidate : currentBest;
    }

    const bestLineage = this.getLineageSignature(currentBest);
    const candidateLineage = this.getLineageSignature(candidate);
    if (candidateLineage !== bestLineage) {
      return candidateLineage < bestLineage ? candidate : currentBest;
    }

    return candidate.id < currentBest.id ? candidate : currentBest;
  }

  private scoreNodeCandidate(target: TreeNode, candidate: TreeNode): number {
    let score = 0;
    if (candidate.type === target.type) {score += 8;}
    if (candidate.name === target.name) {score += 8;}
    if (candidate.id === target.id) {score += 4;}
    if (target.filePath && candidate.filePath && target.filePath === candidate.filePath) {score += 6;}
    if (
      target.parentFilePath &&
      candidate.parentFilePath &&
      target.parentFilePath === candidate.parentFilePath
    ) {
      score += 4;
    }
    if (target.parent && candidate.parent && target.parent.id === candidate.parent.id) {score += 3;}
    return score;
  }

  pickBestCandidate(target: TreeNode, candidates: TreeNode[]): TreeNode | null {
    if (candidates.length === 0) {return null;}
    let best: TreeNode | null = null;
    let bestScore = -1;
    for (const candidate of candidates) {
      const score = this.scoreNodeCandidate(target, candidate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      } else if (score === bestScore && best) {
        best = this.preferCandidateOnTie(target, best, candidate);
      }
    }
    return best;
  }

  private findNodeByIdWithContext(node: TreeNode): TreeNode | null {
    const candidates = this.nodeCandidatesById.get(node.id) ?? [];
    if (candidates.length === 0) {return null;}
    return this.pickBestCandidate(node, candidates);
  }

  /**
   * Resolve stale TreeNode instance to active node from the current in-memory tree.
   * This keeps getChildren stable after tree reloads when VS Code passes old references.
   */
  resolveActiveNode(node: TreeNode, rootNodes: readonly TreeNode[]): TreeNode {
    const lineage = this.getNodeLineage(node);
    if (lineage.length === 0) {return node;}

    const rootSegment = lineage[0];
    const rootCandidates = rootNodes.filter(
      (root) => root.type === rootSegment.type && root.name === rootSegment.name
    );
    let current = this.pickBestCandidate(rootSegment, rootCandidates);
    if (!current) {
      current = this.findNodeByIdWithContext(rootSegment);
    }
    if (!current) {
      return this.findNodeByIdWithContext(node) ?? this.nodeCache.get(node.id) ?? node;
    }

    for (let i = 1; i < lineage.length; i++) {
      const segment = lineage[i];
      const children = current.children ?? [];
      if (children.length === 0) {
        return this.findNodeByIdWithContext(node) ?? this.nodeCache.get(node.id) ?? current;
      }
      const childCandidates = children.filter(
        (child) =>
          child.type === segment.type &&
          child.name === segment.name &&
          (!segment.filePath || !child.filePath || child.filePath === segment.filePath)
      );
      const next = this.pickBestCandidate(segment, childCandidates);
      if (!next) {
        return this.findNodeByIdWithContext(node) ?? this.nodeCache.get(node.id) ?? current;
      }
      current = next;
    }

    return current;
  }

  // --- Tree navigation helpers ---

  getConfigurationRoot(node: TreeNode): TreeNode | null {
    let n: TreeNode | undefined = node;
    while (n) {
      if (n.type === MetadataType.Configuration) {return n;}
      n = n.parent;
    }
    return null;
  }

  findRollbackParentNode(parentId: string, configRootId: string): TreeNode | null {
    const candidates = this.nodeCandidatesById.get(parentId) ?? [];
    if (candidates.length === 0) {
      return null;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }
    const scoped = candidates.find((candidate) => this.getNodeRootIdentity(candidate) === configRootId);
    return scoped ?? candidates[0];
  }
}
