import * as path from 'path';
import { TreeNode } from '../models/treeNode';
import { MetadataType } from '../models/treeNode';
import { FormatDetector, ConfigFormat } from '../parsers/formatDetector';

/**
 * Get configuration root path from any tree node (walk up to root).
 * Designer: root.filePath is config path. EDT: root.filePath is src folder, so config is parent of src.
 */
export function getConfigRootFromNode(node: TreeNode): string | null {
  let current: TreeNode | undefined = node;
  while (current?.parent) {
    current = current.parent;
  }
  if (!current) return null;
  const rootPath = current.filePath;
  if (!rootPath) return null;
  // EDT root has filePath = configPath/src; Designer root has filePath = configPath
  if (current.type === MetadataType.Configuration && current.name === 'Configuration') {
    // Heuristic: if path ends with /src, treat as EDT
    if (rootPath.endsWith(path.sep + 'src') || rootPath.endsWith('/src')) {
      return path.dirname(rootPath);
    }
    return rootPath;
  }
  return rootPath;
}

/**
 * Detect configuration format from a tree node (uses config root).
 */
export async function getFormatFromNode(node: TreeNode): Promise<ConfigFormat | null> {
  const configRoot = getConfigRootFromNode(node);
  if (!configRoot) return null;
  return await FormatDetector.detect(configRoot);
}
