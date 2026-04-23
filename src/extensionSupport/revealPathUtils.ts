/**
 * Path scoring for «reveal active file in metadata tree» — which TreeNode best matches a filesystem path.
 */
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { getFormPaths } from '../formEditor/formPaths';
import { CONFIGURATION_XML } from '../constants/fileNames';

const EXACT_SCORE_BASE = 10_000_000;

export function normalizePathForMatch(filePath: string): string {
  return path.resolve(path.normalize(filePath)).toLowerCase();
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => p.length > 0))];
}

/**
 * Collect filesystem paths that identify this node (exact or directory prefix) for the active file.
 */
export function collectNodeIdentityPaths(
  node: TreeNode,
  getConfigPathForNode: (n: TreeNode) => string | null
): string[] {
  const out: string[] = [];
  if (node.filePath?.trim()) {
    out.push(path.resolve(path.normalize(node.filePath.trim())));
  }
  if (node.parentFilePath?.trim()) {
    out.push(path.resolve(path.normalize(node.parentFilePath.trim())));
  }
  if (node.type === MetadataType.Form && node.filePath) {
    try {
      const fp = getFormPaths(node.filePath);
      out.push(
        path.resolve(path.normalize(fp.formDirectory)),
        path.resolve(path.normalize(fp.formXmlPath)),
        path.resolve(path.normalize(fp.modulePath))
      );
    } catch {
      // ignore
    }
  }
  if (node.type === MetadataType.Configuration) {
    const d = getConfigPathForNode(node);
    if (d) {
      out.push(path.resolve(path.normalize(path.join(d, CONFIGURATION_XML))));
    }
  }
  return dedupe(out);
}

function directoryPrefixForUnderMatch(normalizedPath: string): string {
  const n = path.normalize(normalizedPath);
  const ex = path.extname(n);
  if (ex && n.toLowerCase().endsWith(ex.toLowerCase())) {
    return path.resolve(path.dirname(n));
  }
  return path.resolve(n);
}

/**
 * Returns a non-negative score; 0 = no match. Higher = more specific (best node wins).
 */
export function scoreNodeAgainstTarget(
  targetNorm: string,
  node: TreeNode,
  getConfigPathForNode: (n: TreeNode) => string | null
): number {
  const paths = collectNodeIdentityPaths(node, getConfigPathForNode);
  let best = 0;
  for (const p of paths) {
    const n = path.resolve(p).toLowerCase();
    if (targetNorm === n) {
      best = Math.max(best, EXACT_SCORE_BASE + n.length);
      continue;
    }
    const base = directoryPrefixForUnderMatch(p).toLowerCase();
    if (base && targetNorm.length > base.length && (targetNorm.startsWith(base + path.sep) || targetNorm.startsWith(`${base}/`))) {
      best = Math.max(best, base.length);
    }
  }
  return best;
}
