import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigFormat } from '../parsers/formatDetector';
import { TreeNode, MetadataType } from '../models/treeNode';
import { deserializeTree, serializeTree } from './treeSerializer';
import { Logger } from './logger';

interface TypeContentsCacheEntry {
  configPath: string;
  typeName: string;
  signature: string;
  tree: string;
  version: string;
}

const CACHE_VERSION = '1.0';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function getCacheDir(globalStoragePath: string): string {
  return path.join(globalStoragePath, '1cviewer-type-contents-cache');
}

function getConfigCachePrefix(configPath: string): string {
  return `${hash(path.normalize(configPath))}-`;
}

function getCacheFilePath(globalStoragePath: string, configPath: string, typeName: string): string {
  return path.join(getCacheDir(globalStoragePath), `${getConfigCachePrefix(configPath)}${hash(typeName)}.json`);
}

function normalizePathForSignature(value: string): string {
  return path.normalize(value).replace(/\\/g, '/').toLowerCase();
}

async function statPart(filePath: string, label: string): Promise<string | null> {
  const st = await fs.promises.stat(filePath).catch(() => null);
  if (!st) {
    return null;
  }
  return `${label}:${st.isDirectory() ? 'd' : 'f'}:${Math.round(st.mtimeMs)}:${st.size}`;
}

async function collectEdtElementMetadataParts(elementPath: string, elementName: string): Promise<string[]> {
  const parts: string[] = [];
  const entries = await fs.promises.readdir(elementPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.mdo') && !lower.endsWith('.xml')) {
      continue;
    }
    const part = await statPart(path.join(elementPath, entry.name), `${elementName}/${entry.name}`);
    if (part) {
      parts.push(part);
    }
  }
  return parts;
}

/**
 * Lightweight freshness signature for a type folder.
 *
 * Full recursive stat over large configurations is close to reparsing cost, so this tracks:
 * - direct type folder entries;
 * - Designer sibling XML files (direct entries);
 * - EDT immediate .mdo/.xml files inside each object directory.
 *
 * Open-session edits are additionally handled by watcher-driven invalidation.
 */
export async function computeTypeContentsSignature(
  typePath: string,
  format: ConfigFormat
): Promise<string | null> {
  const entries = await fs.promises.readdir(typePath, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return null;
  }

  const parts: string[] = [`path:${normalizePathForSignature(typePath)}`, `format:${format}`];
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sortedEntries) {
    const entryPath = path.join(typePath, entry.name);
    const part = await statPart(entryPath, entry.name);
    if (part) {
      parts.push(part);
    }
    if (format === ConfigFormat.EDT && entry.isDirectory()) {
      parts.push(...await collectEdtElementMetadataParts(entryPath, entry.name));
    }
  }

  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

export async function loadTypeContentsFromCache(
  globalStoragePath: string,
  configPath: string,
  typeName: string,
  signature: string
): Promise<TreeNode[] | null> {
  try {
    const cacheFilePath = getCacheFilePath(globalStoragePath, configPath, typeName);
    const raw = await fs.promises.readFile(cacheFilePath, 'utf-8');
    const entry = JSON.parse(raw) as TypeContentsCacheEntry;
    if (
      entry.version !== CACHE_VERSION ||
      entry.configPath !== configPath ||
      entry.typeName !== typeName ||
      entry.signature !== signature ||
      !entry.tree
    ) {
      return null;
    }

    const root = deserializeTree(entry.tree);
    const children = root.children ?? [];
    for (const child of children) {
      child.parent = undefined;
    }
    Logger.debug('Type contents loaded from disk cache', { typeName, count: children.length });
    return children;
  } catch (error) {
    Logger.debug('Failed to load type contents cache', error);
    return null;
  }
}

export async function saveTypeContentsToCache(
  globalStoragePath: string,
  configPath: string,
  typeName: string,
  signature: string,
  children: TreeNode[]
): Promise<void> {
  try {
    const dir = getCacheDir(globalStoragePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const root: TreeNode = {
      id: `type-cache:${typeName}`,
      name: typeName,
      type: MetadataType.Unknown,
      properties: {},
      children,
    };
    const entry: TypeContentsCacheEntry = {
      configPath,
      typeName,
      signature,
      tree: serializeTree(root),
      version: CACHE_VERSION,
    };
    await fs.promises.writeFile(
      getCacheFilePath(globalStoragePath, configPath, typeName),
      JSON.stringify(entry),
      'utf-8'
    );
    Logger.debug('Type contents saved to disk cache', { typeName, count: children.length });
  } catch (error) {
    Logger.warn('Failed to save type contents cache', error);
  }
}

export async function invalidateTypeContentsCache(
  globalStoragePath: string,
  configPath: string
): Promise<void> {
  const dir = getCacheDir(globalStoragePath);
  const prefix = getConfigCachePrefix(configPath);
  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
      .map((file) => fs.promises.unlink(path.join(dir, file)).catch(() => {}))
  );
}

export async function clearTypeContentsCache(globalStoragePath: string): Promise<void> {
  const dir = getCacheDir(globalStoragePath);
  const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map((file) => fs.promises.unlink(path.join(dir, file)).catch(() => {}))
  );
}
