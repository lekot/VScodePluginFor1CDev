import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TreeNode, MetadataType } from '../models/treeNode';
import { serializeTree, deserializeTree } from './treeSerializer';
import { Logger } from './logger';

interface CacheEntry {
  configPath: string;
  tree: string;
}

function cacheKey(configPath: string): string {
  return crypto.createHash('sha256').update(configPath).digest('hex').slice(0, 16);
}

function getCacheDir(globalStoragePath: string): string {
  const dir = path.join(globalStoragePath, '1cviewer-tree-cache');
  return dir;
}

function getCacheFilePath(globalStoragePath: string, configPath: string): string {
  return path.join(getCacheDir(globalStoragePath), `${cacheKey(configPath)}.json`);
}

/**
 * Load tree from disk cache if present and valid for this configPath.
 */
export async function loadTreeFromCache(
  globalStoragePath: string,
  configPath: string
): Promise<TreeNode | null> {
  try {
    const filePath = getCacheFilePath(globalStoragePath, configPath);
    await fs.promises.access(filePath);
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const entry = JSON.parse(raw) as CacheEntry;
    if (entry.configPath !== configPath || !entry.tree) {
      return null;
    }
    const root = deserializeTree(entry.tree);
    
    // MIGRATION: Fix filePath for Configuration root nodes loaded from old cache
    // Old cache may have filePath = directory; new code expects filePath = Configuration.xml
    if (root.type === MetadataType.Configuration && root.filePath && !root.filePath.endsWith('.xml')) {
      root.filePath = path.join(root.filePath, 'Configuration.xml');
      Logger.info('Migrated Configuration root filePath to Configuration.xml');
    }
    
    Logger.info('Tree loaded from disk cache', { configPath: configPath.slice(-40) });
    return root;
  } catch {
    return null;
  }
}

/**
 * Save tree to disk cache (structure-only tree is small).
 */
export async function saveTreeToCache(
  globalStoragePath: string,
  configPath: string,
  root: TreeNode
): Promise<void> {
  try {
    const dir = getCacheDir(globalStoragePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = getCacheFilePath(globalStoragePath, configPath);
    const entry: CacheEntry = { configPath, tree: serializeTree(root) };
    await fs.promises.writeFile(filePath, JSON.stringify(entry), 'utf-8');
    Logger.info('Tree saved to disk cache', { configPath: configPath.slice(-40) });
  } catch (error) {
    Logger.warn('Failed to save tree cache', error);
  }
}

/**
 * Clear all tree cache files for this extension.
 */
export async function clearTreeCache(globalStoragePath: string): Promise<void> {
  try {
    const dir = getCacheDir(globalStoragePath);
    const files = await fs.promises.readdir(dir).catch(() => []);
    for (const f of files) {
      if (f.endsWith('.json')) {
        await fs.promises.unlink(path.join(dir, f));
      }
    }
    Logger.info('Tree disk cache cleared');
  } catch (error) {
    Logger.warn('Failed to clear tree cache', error);
  }
}
