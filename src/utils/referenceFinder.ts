import * as fs from 'fs';
import * as path from 'path';
import { MetadataType } from '../models/treeNode';
import { Logger } from './logger';
import { METADATA_TYPE_TO_REFERENCE_KIND } from '../constants/metadataTypeReferenceKinds';

// Alias for backward compatibility
const METADATA_TYPE_TO_REF_KIND = METADATA_TYPE_TO_REFERENCE_KIND;

export interface ReferenceMatch {
  filePath: string;
  snippet: string;
}

/**
 * Find XML files under configPath that contain references to a metadata element.
 * Searches for patterns: cfg:CatalogRef.ElementName, DocumentRef.ElementName,
 * xr:GeneratedType name="CatalogRef.ElementName", <v8:Type>...Ref.ElementName...
 */
export async function findReferencesToElement(
  configPath: string,
  elementName: string,
  metadataType: MetadataType
): Promise<ReferenceMatch[]> {
  const refKind = METADATA_TYPE_TO_REF_KIND[metadataType];
  if (!refKind) {
    return [];
  }
  const pattern = `${refKind}.${elementName}`;
  const results: ReferenceMatch[] = [];
  await scanDir(configPath, pattern, results, 0);
  return results;
}

const MAX_SCAN_DEPTH = 20;

async function scanDir(
  dir: string,
  pattern: string,
  results: ReferenceMatch[],
  depth: number
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) {
    Logger.warn(`referenceFinder: max depth ${MAX_SCAN_DEPTH} reached at ${dir}, stopping recursion`);
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await scanDir(full, pattern, results, depth + 1);
    } else if (e.isFile() && e.name.endsWith('.xml')) {
      const matches = await grepInFile(full, pattern);
      if (matches.length > 0) {
        results.push(...matches.map((snippet) => ({ filePath: full, snippet })));
      }
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function grepInFile(filePath: string, pattern: string): Promise<string[]> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    Logger.debug(`referenceFinder: cannot read ${filePath}`, err);
    return [];
  }
  const lines = content.split(/\r?\n/);
  const snippets: string[] = [];
  const re = new RegExp(escapeRegex(pattern) + '(?=[<"\'.\\s]|$)', 'g');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      const line = lines[i].trim();
      snippets.push(line.length > 80 ? line.slice(0, 77) + '...' : line);
      re.lastIndex = 0;
    }
  }
  return snippets;
}

/**
 * Replace references to oldName with newName in XML files under configPath.
 * Replaces RefKind.OldName with RefKind.NewName in text.
 */
export async function replaceReferencesInProject(
  configPath: string,
  oldName: string,
  newName: string,
  metadataType: MetadataType
): Promise<{ filePath: string; replaceCount: number }[]> {
  const refKind = METADATA_TYPE_TO_REF_KIND[metadataType];
  if (!refKind) {
    return [];
  }
  const oldPattern = `${refKind}.${oldName}`;
  const newPattern = `${refKind}.${newName}`;
  const results: { filePath: string; replaceCount: number }[] = [];
  await replaceInDir(configPath, oldPattern, newPattern, results, 0);
  return results;
}

async function replaceInDir(
  dir: string,
  oldPattern: string,
  newPattern: string,
  results: { filePath: string; replaceCount: number }[],
  depth: number
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) {
    Logger.warn(`referenceFinder: max depth ${MAX_SCAN_DEPTH} reached at ${dir}, stopping recursion`);
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await replaceInDir(full, oldPattern, newPattern, results, depth + 1);
    } else if (e.isFile() && e.name.endsWith('.xml')) {
      const count = await replaceInFile(full, oldPattern, newPattern);
      if (count > 0) {
        results.push({ filePath: full, replaceCount: count });
      }
    }
  }
}

async function replaceInFile(
  filePath: string,
  oldPattern: string,
  newPattern: string
): Promise<number> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return 0;
  }
  const re = new RegExp(escapeRegex(oldPattern) + '(?=[<"\'.\\s]|$)', 'g');
  const matches = content.match(re);
  if (!matches) {return 0;}
  const newContent = content.replace(re, newPattern);
  await fs.promises.writeFile(filePath, newContent, 'utf-8');
  return matches.length;
}
