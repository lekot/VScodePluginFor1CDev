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
  return replaceIdentityTokensInProject(
    configPath,
    new Map([[`${refKind}.${oldName}`, `${refKind}.${newName}`]])
  );
}

export interface PlannedReferenceWrite {
  filePath: string;
  originalContent: string;
  updatedContent: string;
  replaceCount: number;
}

/** Builds reference rewrites without touching disk so callers can include them in one WAL plan. */
export async function planIdentityTokenReplacements(
  configPath: string,
  replacements: ReadonlyMap<string, string>
): Promise<PlannedReferenceWrite[]> {
  if (replacements.size === 0) {
    return [];
  }
  const plans: PlannedReferenceWrite[] = [];
  await collectReplacementPlans(configPath, replacements, plans, 0);
  return plans;
}

/**
 * Replace exact metadata identity tokens across XML as one rollback-capable batch.
 * Callers supply only platform identity tokens, never bare object names.
 */
export async function replaceIdentityTokensInProject(
  configPath: string,
  replacements: ReadonlyMap<string, string>
): Promise<{ filePath: string; replaceCount: number }[]> {
  if (replacements.size === 0) {
    return [];
  }
  const plans = await planIdentityTokenReplacements(configPath, replacements);

  const written: PlannedReferenceWrite[] = [];
  try {
    for (const plan of plans) {
      await fs.promises.writeFile(plan.filePath, plan.updatedContent, 'utf-8');
      written.push(plan);
    }
  } catch (error) {
    for (const plan of written.reverse()) {
      try {
        await fs.promises.writeFile(plan.filePath, plan.originalContent, 'utf-8');
      } catch (rollbackError) {
        Logger.error(`referenceFinder: rollback failed for ${plan.filePath}`, rollbackError);
      }
    }
    throw error;
  }

  return plans.map(({ filePath, replaceCount }) => ({ filePath, replaceCount }));
}

async function collectReplacementPlans(
  dir: string,
  replacements: ReadonlyMap<string, string>,
  plans: PlannedReferenceWrite[],
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
      await collectReplacementPlans(full, replacements, plans, depth + 1);
    } else if (e.isFile() && e.name.endsWith('.xml')) {
      const plan = await buildReplacementPlan(full, replacements);
      if (plan) {
        plans.push(plan);
      }
    }
  }
}

async function buildReplacementPlan(
  filePath: string,
  replacements: ReadonlyMap<string, string>
): Promise<PlannedReferenceWrite | undefined> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  let updatedContent = content;
  let replaceCount = 0;
  const ordered = [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [oldPattern, newPattern] of ordered) {
    const re = new RegExp(
      `(?<![A-Za-z0-9_])${escapeRegex(oldPattern)}(?=[<"'.\\s]|$)`,
      'g'
    );
    const matches = updatedContent.match(re);
    if (!matches) { continue; }
    replaceCount += matches.length;
    updatedContent = updatedContent.replace(re, newPattern);
  }
  return replaceCount > 0
    ? { filePath, originalContent: content, updatedContent, replaceCount }
    : undefined;
}
