/**
 * Builds subsystem hierarchy from a flat list of subsystem nodes (ADR 0001).
 * Used by EDT and Designer parsers to attach only root subsystems to the Subsystems type node.
 */
import { TreeNode } from '../models/treeNode';
import { Logger } from '../utils/logger';

const SUBSYSTEMS_PREFIX = 'Subsystems.';

/**
 * Normalizes filesystem path for stable matching (case-insensitive on Windows).
 */
function normPath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ParentRefKey =
  | { kind: 'filePath'; filePath: string }
  | { kind: 'uuid'; uuid: string }
  | { kind: 'name'; name: string };

/**
 * Resolves parentSubsystemRef (string or ref object) to a key for matching.
 */
function resolveParentRef(ref: unknown): ParentRefKey | null {
  if (ref == null) return null;
  if (typeof ref === 'string') {
    const s = ref.trim();
    if (!s) return null;
    if (UUID_RE.test(s)) return { kind: 'uuid', uuid: s };
    return { kind: 'name', name: s };
  }
  if (typeof ref === 'object') {
    const obj = ref as Record<string, unknown>;
    if (typeof obj.filePath === 'string' && obj.filePath.trim()) {
      return { kind: 'filePath', filePath: obj.filePath.trim() };
    }
    const item = typeof obj.item === 'string' ? (obj.item as string).trim() : '';
    const name = typeof obj.Name === 'string' ? (obj.Name as string).trim() : '';
    const text = typeof obj['#text'] === 'string' ? (obj['#text'] as string).trim() : '';
    const s = item || name || text;
    if (!s) return null;
    if (UUID_RE.test(s)) return { kind: 'uuid', uuid: s };
    return { kind: 'name', name: s };
  }
  return null;
}

function isSubsystemNode(n: TreeNode): boolean {
  // Do not import MetadataType here to keep builder low-level.
  return (n.type as unknown) === 'Subsystem';
}

/**
 * Builds the subsystem tree from flat nodes: assigns path-based id, parent, children,
 * and attaches only root subsystems to rootParent. Mutates flatNodes and rootParent.
 *
 * - Root = no parentSubsystemRef or ref unresolved (then node is treated as root, warning logged).
 * - path-based id: root = `Subsystems.${name}`, child = `${parent.id}.${name}`.
 */
export function buildSubsystemTree(flatNodes: TreeNode[], rootParent: TreeNode): void {
  const byName = new Map<string, TreeNode[]>();
  const byFilePath = new Map<string, TreeNode>();
  const byUuid = new Map<string, TreeNode>();
  for (const n of flatNodes) {
    const name = n.name;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(n);
    if (n.filePath) {
      byFilePath.set(normPath(n.filePath), n);
    }
    const uuid = (n.properties?.uuid as string | undefined) ?? undefined;
    if (uuid && typeof uuid === 'string' && UUID_RE.test(uuid)) {
      byUuid.set(uuid.toLowerCase(), n);
    }
  }

  const parentRefs = new Map<TreeNode, ParentRefKey | null>();
  for (const node of flatNodes) {
    const ref = node.properties?.parentSubsystemRef;
    const key = resolveParentRef(ref);
    parentRefs.set(node, key ?? null);
  }

  const preservedNonSubsystemChildren = new Map<TreeNode, TreeNode[]>();
  for (const node of flatNodes) {
    const existing = node.children ?? [];
    const nonSubsystem = existing.filter((c) => !isSubsystemNode(c));
    preservedNonSubsystemChildren.set(node, nonSubsystem);
  }

  const resolvedParent = new Map<TreeNode, TreeNode | null>();
  const resolveParentNode = (node: TreeNode): TreeNode | null => {
    const key = parentRefs.get(node) ?? null;
    if (!key) return null;
    if (key.kind === 'filePath') {
      const p = byFilePath.get(normPath(key.filePath));
      return p ?? null;
    }
    if (key.kind === 'uuid') {
      const p = byUuid.get(key.uuid.toLowerCase());
      return p ?? null;
    }
    // name fallback: can be ambiguous; we keep stable behavior but try to disambiguate by filePath context when possible.
    const candidates = byName.get(key.name) ?? [];
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    if (node.filePath) {
      const childPath = normPath(node.filePath);
      // Prefer a candidate whose container directory is a prefix of the child path (Designer nested subsystems).
      let best: TreeNode | null = null;
      let bestLen = -1;
      for (const cand of candidates) {
        if (!cand.filePath) continue;
        const candDir = normPath(cand.filePath);
        if (childPath.startsWith(candDir) && candDir.length > bestLen) {
          best = cand;
          bestLen = candDir.length;
        }
      }
      if (best) return best;
    }
    return candidates[0];
  };

  // Build parent pointers with cycle breaking: if resolving produces self/cycle, detach and log.
  const roots: TreeNode[] = [];
  const visiting = new Set<TreeNode>();
  const visited = new Set<TreeNode>();

  const dfsResolve = (node: TreeNode): TreeNode | null => {
    if (resolvedParent.has(node)) return resolvedParent.get(node)!;
    if (visiting.has(node)) {
      Logger.warn('Subsystem cycle detected, breaking', { subsystemName: node.name, subsystemId: node.id });
      resolvedParent.set(node, null);
      return null;
    }
    visiting.add(node);
    const parent = resolveParentNode(node);
    if (!parent) {
      resolvedParent.set(node, null);
      visiting.delete(node);
      visited.add(node);
      return null;
    }
    if (parent === node) {
      Logger.warn('Subsystem self-parent detected, breaking', { subsystemName: node.name, subsystemId: node.id });
      resolvedParent.set(node, null);
      visiting.delete(node);
      visited.add(node);
      return null;
    }
    // Recurse to detect indirect cycles.
    dfsResolve(parent);
    // If parent chain was broken at parent due to cycle, we can still keep direct parent relation.
    // But if parent is currently in visiting, we would have caught cycle above.
    resolvedParent.set(node, parent);
    visiting.delete(node);
    visited.add(node);
    return parent;
  };

  for (const node of flatNodes) {
    // Trigger resolution; warnings emitted inside.
    const p = dfsResolve(node);
    if (!p) roots.push(node);
  }

  // Ensure non-empty roots even if everything participates in a cycle and got detached oddly.
  if (roots.length === 0 && flatNodes.length > 0) {
    Logger.warn('Subsystem roots empty after build, forcing a root', { count: flatNodes.length });
    roots.push(flatNodes[0]);
    resolvedParent.set(flatNodes[0], null);
  }

  // Rebuild children: preserve non-subsystem children.
  for (const node of flatNodes) {
    const preserved = preservedNonSubsystemChildren.get(node) ?? [];
    node.children = [...preserved];
  }

  for (const node of flatNodes) {
    const parent = resolvedParent.get(node) ?? null;
    if (!parent) continue;
    node.parent = parent;
    parent.children = parent.children ?? [];
    parent.children.push(node);
  }

  rootParent.children = rootParent.children ?? [];
  rootParent.children.length = 0;
  for (const r of roots) {
    r.parent = rootParent;
    rootParent.children.push(r);
  }

  function assignPathBasedIds(node: TreeNode, prefix: string): void {
    const id = prefix ? `${prefix}.${node.name}` : `${SUBSYSTEMS_PREFIX}${node.name}`;
    node.id = id;
    for (const ch of node.children ?? []) {
      // Assign ids only for subsystem-to-subsystem links; keep existing ids for non-subsystem children.
      if (isSubsystemNode(ch)) {
        assignPathBasedIds(ch, id);
      }
    }
  }
  for (const r of roots) {
    assignPathBasedIds(r, '');
  }
}
