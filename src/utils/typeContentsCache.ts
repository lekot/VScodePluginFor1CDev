import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigFormat } from '../parsers/formatDetector';
import { TreeNode, MetadataType } from '../models/treeNode';
import { deserializeTree, serializeTree } from './treeSerializer';
import { Logger } from './logger';
import { filesystemPathKey } from './configurationPathIdentity';

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

export function normalizePathForSignature(value: string, platform?: NodeJS.Platform): string {
  return filesystemPathKey(value, platform).replace(/\\/g, '/');
}

export function getConfigCachePrefix(configPath: string, platform?: NodeJS.Platform): string {
  return `${hash(normalizePathForSignature(configPath, platform))}-`;
}

export type TypeCacheKind = 'contents' | 'index';

export function getCacheFilePath(
  globalStoragePath: string,
  configPath: string,
  typeName: string,
  kind: TypeCacheKind = 'contents',
  platform?: NodeJS.Platform
): string {
  const ext = kind === 'index' ? '.index.json' : '.json';
  return path.join(getCacheDir(globalStoragePath), `${getConfigCachePrefix(configPath, platform)}${hash(typeName)}${ext}`);
}

async function statPart(filePath: string, label: string): Promise<string | null> {
  const st = await fs.promises.stat(filePath).catch(() => null);
  if (!st) {
    return null;
  }
  return `${label}:${st.isDirectory() ? 'd' : 'f'}:${Math.round(st.mtimeMs)}:${st.size}`;
}

async function collectEdtElementMetadataParts(elementPath: string, elementName: string): Promise<string[]> {
  const entries = await fs.promises.readdir(elementPath, { withFileTypes: true }).catch(() => []);
  const candidateEntries = entries.filter((entry) => {
    if (!entry.isFile()) {
      return false;
    }
    const lower = entry.name.toLowerCase();
    return lower === `${elementName.toLowerCase()}.mdo` || lower.endsWith('.xml') || lower.endsWith('.bsl');
  });

  const parts: string[] = [];
  const sorted = [...candidateEntries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const p = await statPart(path.join(elementPath, entry.name), `${elementName}/${entry.name}`);
    if (p) {
      parts.push(p);
    }
  }
  return parts;
}

export async function computeTypeContentsSignature(
  typePath: string,
  format: ConfigFormat,
  platform?: NodeJS.Platform
): Promise<string | null> {
  const stat = await fs.promises.stat(typePath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return null;
  }

  const entries = await fs.promises.readdir(typePath, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return null;
  }

  const parts: string[] = [`path:${normalizePathForSignature(typePath, platform)}`, `format:${format}`];
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const entryParts = await Promise.all(
    sortedEntries.map(async (entry) => {
      const entryPath = path.join(typePath, entry.name);
      const entryPartsList: string[] = [];
      const part = await statPart(entryPath, entry.name);
      if (part) {
        entryPartsList.push(part);
      }
      if (format === ConfigFormat.EDT && entry.isDirectory()) {
        entryPartsList.push(...await collectEdtElementMetadataParts(entryPath, entry.name));
      }
      return entryPartsList;
    })
  );

  for (const list of entryParts) {
    parts.push(...list);
  }

  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

export async function loadTypeContentsFromCache(
  globalStoragePath: string,
  configPath: string,
  typeName: string,
  signature: string,
  kind: TypeCacheKind = 'contents',
  platform?: NodeJS.Platform
): Promise<TreeNode[] | null> {
  try {
    const cacheFilePath = getCacheFilePath(globalStoragePath, configPath, typeName, kind, platform);
    const raw = await fs.promises.readFile(cacheFilePath, 'utf-8');
    const entry = JSON.parse(raw) as TypeContentsCacheEntry;
    if (
      entry.version !== CACHE_VERSION ||
      normalizePathForSignature(entry.configPath, platform) !== normalizePathForSignature(configPath, platform) ||
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
  children: TreeNode[],
  kind: TypeCacheKind = 'contents',
  platform?: NodeJS.Platform
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
      getCacheFilePath(globalStoragePath, configPath, typeName, kind, platform),
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
  configPath: string,
  platform?: NodeJS.Platform
): Promise<void> {
  const dir = getCacheDir(globalStoragePath);
  const prefix = getConfigCachePrefix(configPath, platform);
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
