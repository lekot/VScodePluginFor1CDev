/**
 * Commit 3 — Object file collector.
 *
 * Collects the set of config files on disk that belong to a metadata tree node,
 * so that incremental ibcmd `import files` commands can target only the changed objects.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TreeNode } from '../../models/treeNode';

const COLLECTED_EXTENSIONS = new Set(['.xml', '.bsl', '.os', '.mxl', '.bin']);

/** Normalises an absolute path to a forward-slash path relative to configRoot. */
function toRelativeForwardSlash(absolutePath: string, configRoot: string): string {
  return path.relative(configRoot, absolutePath).replace(/\\/g, '/');
}

/**
 * Recursively walks a directory and returns all files matching COLLECTED_EXTENSIONS.
 * Returns absolute paths.
 */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile()) {
      if (COLLECTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Collects all config files that belong to the given metadata tree node.
 *
 * - Returns [] if the node has no filePath.
 * - Always includes the descriptor XML itself (node.filePath relative to configRoot).
 * - Walks the sibling directory named the same as the descriptor (without extension)
 *   to collect subordinate BSL modules, forms, templates, etc.
 * - Returns paths relative to configRoot with forward slashes.
 * - Deduplicates: if the directory walk yields the descriptor file again it is included only once.
 */
export function collectObjectFiles(node: TreeNode, configRoot: string): string[] {
  if (!node.filePath) {
    return [];
  }

  const descriptorAbs = node.filePath; // already absolute
  const descriptorRel = toRelativeForwardSlash(descriptorAbs, configRoot);

  // lower-case key set for deduplication
  const seen = new Set<string>();
  const results: string[] = [];

  const addUnique = (rel: string): void => {
    const key = rel.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push(rel);
    }
  };

  // Always include the descriptor XML first.
  addUnique(descriptorRel);

  // Walk the corresponding object directory: same base name, no extension.
  // e.g.  CommonModules/тестМодуль.xml  →  CommonModules/тестМодуль/
  const objectDir = path.join(
    path.dirname(descriptorAbs),
    path.basename(descriptorAbs, path.extname(descriptorAbs)),
  );

  let dirStat: fs.Stats | undefined;
  try {
    dirStat = fs.statSync(objectDir);
  } catch {
    dirStat = undefined;
  }

  if (dirStat?.isDirectory()) {
    const walked = walkDir(objectDir);
    for (const absFile of walked) {
      addUnique(toRelativeForwardSlash(absFile, configRoot));
    }
  }

  return results;
}

/**
 * Collects all config files for a selection of metadata tree nodes.
 *
 * Deduplicates by lower-case key (Windows case-insensitive paths) while
 * preserving the original casing of the first occurrence.
 */
export function collectFilesForSelection(
  nodes: readonly TreeNode[],
  configRoot: string,
): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  // ibcmd import files requires Configuration.xml (parent object) to be present
  // for any child objects. Always include it first.
  const configXml = 'Configuration.xml';
  const configXmlAbs = path.join(configRoot, configXml);
  try {
    if (fs.statSync(configXmlAbs).isFile()) {
      seen.add(configXml.toLowerCase());
      results.push(configXml);
    }
  } catch { /* missing — skip */ }

  for (const node of nodes) {
    const files = collectObjectFiles(node, configRoot);
    for (const rel of files) {
      const key = rel.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push(rel);
      }
    }
  }

  return results;
}
