// src/agent/predefinedCharacteristicOperations.ts
// Business logic for predefined-characteristic API (no vscode dependency).

import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from '../utils/logger';
import { parsePredefinedCharacteristics } from '../parsers/predefinedCharacteristicsParser';
import { buildXmlString, writeUtf8FileWithBackup } from '../utils/xml/xmlFileIo';
import type { PredefinedCharacteristicEntry } from '../types/predefinedCharacteristic';

// Designer folder name for COT
const COT_FOLDER = 'ChartsOfCharacteristicTypes';
// InformationRegisters folder name
const IR_FOLDER = 'InformationRegisters';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Resolve a COT name or agent path (ChartOfCharacteristicTypes.Name) to the COT directory. */
function resolveCotDir(configRoot: string, cotPath: string): { cotName: string; cotDir: string } {
  const segments = cotPath.split('.');
  // Accept 'ChartOfCharacteristicTypes.Name' or plain 'Name'
  const cotName = segments.length >= 2 ? segments[segments.length - 1] : cotPath;
  const cotDir = path.join(configRoot, COT_FOLDER, cotName);
  return { cotName, cotDir };
}

function predefinedXmlPath(cotDir: string): string {
  return path.join(cotDir, 'Ext', 'Predefined.xml');
}

// ─── Read helpers ────────────────────────────────────────────────────────────

async function readPredefinedXml(cotDir: string): Promise<string | null> {
  const xmlPath = predefinedXmlPath(cotDir);
  try {
    return await fs.promises.readFile(xmlPath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Type serialization for write ────────────────────────────────────────────

// http://v8.1c.ru/8.1/data/enterprise/current-config namespace used in Predefined.xml
const CURRENT_CONFIG_NS = 'http://v8.1c.ru/8.1/data/enterprise/current-config';

/**
 * Build the <Type> child object from an array of type strings.
 * cfg:CatalogRef.X → xmlns:d4p1 attribute + d4p1:CatalogRef.X text.
 * xs:* primitives stay as-is.
 */
function buildTypeObject(types: readonly string[]): Record<string, unknown> {
  if (types.length === 0) {
    return {};
  }

  const typeEntries: unknown[] = [];
  let needsCfgNs = false;

  for (const t of types) {
    if (t.startsWith('cfg:')) {
      needsCfgNs = true;
      // d4p1:CatalogRef.X
      const local = t.slice('cfg:'.length);
      typeEntries.push({ '@_xmlns:d4p1': CURRENT_CONFIG_NS, '#text': `d4p1:${local}` });
    } else {
      typeEntries.push(t);
    }
  }

  const typeNode: Record<string, unknown> = {};
  if (needsCfgNs && typeEntries.length === 1) {
    typeNode['v8:Type'] = typeEntries[0];
  } else if (typeEntries.length === 1) {
    typeNode['v8:Type'] = typeEntries[0];
  } else {
    typeNode['v8:Type'] = typeEntries;
  }
  return typeNode;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * List all predefined characteristic entries for a COT.
 */
export async function listPredefinedCharacteristics(
  configRoot: string,
  cotPath: string
): Promise<PredefinedCharacteristicEntry[]> {
  const { cotDir } = resolveCotDir(configRoot, cotPath);
  const xml = await readPredefinedXml(cotDir);
  if (!xml) {
    return [];
  }
  return parsePredefinedCharacteristics(xml);
}

/**
 * Get the type strings for a specific predefined characteristic by name.
 */
export async function getPredefinedCharacteristicType(
  configRoot: string,
  cotPath: string,
  predefinedName: string
): Promise<string[]> {
  const entries = await listPredefinedCharacteristics(configRoot, cotPath);
  const entry = entries.find((e) => e.name === predefinedName);
  if (!entry) {
    return [];
  }
  return [...entry.type];
}

/**
 * Set the type for a specific predefined characteristic by name.
 * Reads Predefined.xml, finds the Item, replaces its <Type> content, and writes back.
 */
export async function setPredefinedCharacteristicType(
  configRoot: string,
  cotPath: string,
  predefinedName: string,
  types: readonly string[]
): Promise<void> {
  const { cotDir } = resolveCotDir(configRoot, cotPath);
  const xmlPath = predefinedXmlPath(cotDir);
  const originalContent = await fs.promises.readFile(xmlPath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(originalContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Predefined.xml: ${msg}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Predefined.xml structure');
  }

  // Find PredefinedData root
  let root: Record<string, unknown> | null = null;
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if ((key === 'PredefinedData' || key.endsWith(':PredefinedData')) &&
        val && typeof val === 'object' && !Array.isArray(val)) {
      root = val as Record<string, unknown>;
      break;
    }
  }

  if (!root) {
    throw new Error('PredefinedData root not found in Predefined.xml');
  }

  const rawItems = root['Item'];
  if (!rawItems) {
    throw new Error(`Item "${predefinedName}" not found`);
  }

  const itemArray = Array.isArray(rawItems) ? rawItems as Record<string, unknown>[] : [rawItems as Record<string, unknown>];
  const targetItem = itemArray.find((item) => item['Name'] === predefinedName);

  if (!targetItem) {
    throw new Error(`Predefined item "${predefinedName}" not found`);
  }

  targetItem['Type'] = buildTypeObject(types);

  const updated = buildXmlString(parsed);
  await writeUtf8FileWithBackup(xmlPath, originalContent, updated);
  Logger.info(`setPredefinedCharacteristicType: updated "${predefinedName}" in ${xmlPath}`);
}

/**
 * Find InformationRegisters that reference this COT via Resources or Dimensions.
 * Looks for <v8:Type>...ChartOfCharacteristicTypesRef.<cotName>...</v8:Type>.
 * Returns array like ['InformationRegister.A', 'InformationRegister.B'].
 */
export async function getCharacteristicValueRegisters(
  configRoot: string,
  cotPath: string
): Promise<string[]> {
  const { cotName } = resolveCotDir(configRoot, cotPath);
  const irDir = path.join(configRoot, IR_FOLDER);

  let irEntries: string[];
  try {
    irEntries = await fs.promises.readdir(irDir);
  } catch {
    Logger.warn(`getCharacteristicValueRegisters: InformationRegisters dir not found at ${irDir}`);
    return [];
  }

  // Pattern: ChartOfCharacteristicTypesRef.cotName (with any prefix like cfg: or d4p1:)
  const refPattern = `ChartOfCharacteristicTypesRef.${cotName}`;

  const found = new Set<string>();

  for (const entry of irEntries) {
    if (!entry.endsWith('.xml')) {
      continue;
    }
    const xmlPath = path.join(irDir, entry);
    try {
      const content = await fs.promises.readFile(xmlPath, 'utf-8');
      if (content.includes(refPattern)) {
        const regName = entry.slice(0, -4); // strip .xml
        found.add(`InformationRegister.${regName}`);
      }
    } catch (err) {
      Logger.warn(`getCharacteristicValueRegisters: failed to read ${xmlPath}`, err);
    }
  }

  return Array.from(found).sort();
}
