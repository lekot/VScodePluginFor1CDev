import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TreeNode, MetadataType } from '../models/treeNode';
import { serializeTree, deserializeTree } from './treeSerializer';
import { Logger } from './logger';

interface CacheEntry {
  configPath: string;
  tree: string;
  timestamp?: number; // mtime of Configuration.xml when cache was created
  version?: string; // Cache format version for future migrations
}

const CACHE_VERSION = '1.0';

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
 * Validates that Configuration.xml hasn't been modified since cache was created.
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
      Logger.debug('Cache entry invalid: path mismatch or empty tree');
      return null;
    }
    
    // Validate cache freshness by checking Configuration.xml mtime
    const configXmlPath = path.join(configPath, 'Configuration.xml');
    try {
      const stats = await fs.promises.stat(configXmlPath);
      const currentMtime = stats.mtimeMs;
      
      if (entry.timestamp && currentMtime > entry.timestamp) {
        Logger.info('Cache invalidated: Configuration.xml modified since cache creation');
        return null;
      }
    } catch (err) {
      // Configuration.xml doesn't exist or can't be accessed - invalidate cache
      Logger.debug('Cache invalidated: Configuration.xml not accessible');
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
 * Stores timestamp of Configuration.xml for cache validation.
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
    
    // Get Configuration.xml mtime for cache validation
    let timestamp: number | undefined;
    try {
      const configXmlPath = path.join(configPath, 'Configuration.xml');
      const stats = await fs.promises.stat(configXmlPath);
      timestamp = stats.mtimeMs;
    } catch {
      // If we can't get timestamp, cache will still work but won't validate freshness
      Logger.debug('Could not get Configuration.xml timestamp for cache');
    }
    
    const entry: CacheEntry = { 
      configPath, 
      tree: serializeTree(root),
      timestamp,
      version: CACHE_VERSION
    };
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
