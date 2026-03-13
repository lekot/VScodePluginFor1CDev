import * as fs from 'fs';
import * as path from 'path';
import { MetadataType } from '../models/treeNode';
import { Logger } from './logger';

/** Reference kind strings used in XML (e.g. CatalogRef, DocumentRef). */
const METADATA_TYPE_TO_REF_KIND: Record<MetadataType, string | undefined> = {
  [MetadataType.Catalog]: 'CatalogRef',
  [MetadataType.Document]: 'DocumentRef',
  [MetadataType.Enum]: 'EnumRef',
  [MetadataType.ChartOfCharacteristicTypes]: 'ChartOfCharacteristicTypesRef',
  [MetadataType.ChartOfAccounts]: 'ChartOfAccountsRef',
  [MetadataType.ChartOfCalculationTypes]: 'ChartOfCalculationTypesRef',
  [MetadataType.Configuration]: undefined,
  [MetadataType.Report]: undefined,
  [MetadataType.DataProcessor]: undefined,
  [MetadataType.InformationRegister]: undefined,
  [MetadataType.AccumulationRegister]: undefined,
  [MetadataType.AccountingRegister]: undefined,
  [MetadataType.CalculationRegister]: undefined,
  [MetadataType.BusinessProcess]: undefined,
  [MetadataType.Task]: undefined,
  [MetadataType.ExternalDataSource]: undefined,
  [MetadataType.Constant]: undefined,
  [MetadataType.SessionParameter]: undefined,
  [MetadataType.FilterCriterion]: undefined,
  [MetadataType.ScheduledJob]: undefined,
  [MetadataType.FunctionalOption]: undefined,
  [MetadataType.FunctionalOptionsParameter]: undefined,
  [MetadataType.SettingsStorage]: undefined,
  [MetadataType.EventSubscription]: undefined,
  [MetadataType.CommonModule]: undefined,
  [MetadataType.CommandGroup]: undefined,
  [MetadataType.Command]: undefined,
  [MetadataType.Role]: undefined,
  [MetadataType.Interface]: undefined,
  [MetadataType.Style]: undefined,
  [MetadataType.WebService]: undefined,
  [MetadataType.HTTPService]: undefined,
  [MetadataType.IntegrationService]: undefined,
  [MetadataType.Subsystem]: undefined,
  [MetadataType.Attribute]: undefined,
  [MetadataType.TabularSection]: undefined,
  [MetadataType.Form]: undefined,
  [MetadataType.Template]: undefined,
  [MetadataType.CommandSubElement]: undefined,
  [MetadataType.Recurrence]: undefined,
  [MetadataType.Method]: undefined,
  [MetadataType.Parameter]: undefined,
  [MetadataType.Extension]: undefined,
  [MetadataType.Unknown]: undefined,
};

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
  await scanDir(configPath, pattern, results);
  return results;
}

async function scanDir(
  dir: string,
  pattern: string,
  results: ReferenceMatch[]
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await scanDir(full, pattern, results);
    } else if (e.isFile() && e.name.endsWith('.xml')) {
      const matches = await grepInFile(full, pattern);
      if (matches.length > 0) {
        results.push(...matches.map((snippet) => ({ filePath: full, snippet })));
      }
    }
  }
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
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(pattern)) {
      const line = lines[i].trim();
      snippets.push(line.length > 80 ? line.slice(0, 77) + '...' : line);
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
  await replaceInDir(configPath, oldPattern, newPattern, results);
  return results;
}

async function replaceInDir(
  dir: string,
  oldPattern: string,
  newPattern: string,
  results: { filePath: string; replaceCount: number }[]
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await replaceInDir(full, oldPattern, newPattern, results);
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
  const parts = content.split(oldPattern);
  const count = parts.length - 1;
  if (count === 0) return 0;
  const newContent = parts.join(newPattern);
  await fs.promises.writeFile(filePath, newContent, 'utf-8');
  return count;
}
