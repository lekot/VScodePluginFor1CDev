// src/parsers/predefinedCharacteristicsParser.ts
// Parser for Ext/Predefined.xml of ChartOfCharacteristicTypes (PlanOfCharacteristicKind).

import { XMLParser } from 'fast-xml-parser';
import { Logger } from '../utils/logger';
import type { PredefinedCharacteristicEntry } from '../types/predefinedCharacteristic';

// The namespace URI that maps to the "cfg:" prefix in type strings.
// In Predefined.xml it appears as xmlns:d4p1="..." on the <v8:Type> element.
const CURRENT_CONFIG_NS = 'http://v8.1c.ru/8.1/data/enterprise/current-config';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // parseTagValue: false prevents numeric coercion of Code (would strip leading zeroes)
  // and keeps IsFolder as the literal string "true"/"false" rather than boolean.
  parseTagValue: false,
});

function normalizePrefixedType(raw: string, nsMap: Record<string, string>): string {
  // nsMap: { 'd4p1': 'http://...current-config', ... }
  const colonIdx = raw.indexOf(':');
  if (colonIdx < 0) {
    return raw;
  }
  const prefix = raw.slice(0, colonIdx);
  const local = raw.slice(colonIdx + 1);
  // d4p1:CatalogRef.X → cfg:CatalogRef.X
  if (nsMap[prefix] === CURRENT_CONFIG_NS) {
    return `cfg:${local}`;
  }
  return raw;
}

function extractTypeStrings(typeNode: unknown): readonly string[] {
  if (!typeNode || typeof typeNode !== 'object' || Array.isArray(typeNode)) {
    return [];
  }
  const t = typeNode as Record<string, unknown>;

  // Collect xmlns:* attributes to build a local ns map for this <Type> element.
  const nsMap: Record<string, string> = {};
  for (const [key, val] of Object.entries(t)) {
    if (key.startsWith('@_xmlns:') && typeof val === 'string') {
      nsMap[key.slice('@_xmlns:'.length)] = val;
    }
  }

  // v8:Type may appear as a string (single) or as an array with children that also carry attributes.
  // fast-xml-parser with ignoreAttributes: false flattens attributes into the same object.
  // When multiple <v8:Type> exist, they become an array.
  const rawV8Type = t['v8:Type'];
  const types: string[] = [];

  const processRaw = (raw: unknown): void => {
    if (typeof raw === 'string') {
      const normalized = normalizePrefixedType(raw.trim(), nsMap);
      if (normalized) {
        types.push(normalized);
      }
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // Object with '#text' and attributes
      const obj = raw as Record<string, unknown>;
      // Merge nsMap with attributes on this <v8:Type> element
      const localNsMap = { ...nsMap };
      for (const [key, val] of Object.entries(obj)) {
        if (key.startsWith('@_xmlns:') && typeof val === 'string') {
          localNsMap[key.slice('@_xmlns:'.length)] = val;
        }
      }
      const text = obj['#text'];
      if (typeof text === 'string' && text.trim()) {
        types.push(normalizePrefixedType(text.trim(), localNsMap));
      }
    }
  };

  if (Array.isArray(rawV8Type)) {
    for (const entry of rawV8Type) {
      processRaw(entry);
    }
  } else {
    processRaw(rawV8Type);
  }

  return types;
}

function extractDescription(descNode: unknown): string {
  if (!descNode) {
    return '';
  }
  if (typeof descNode === 'string') {
    return descNode;
  }
  if (typeof descNode === 'object' && !Array.isArray(descNode)) {
    const obj = descNode as Record<string, unknown>;
    // LocalString: may have 'ru' or '#text'
    const text = obj['#text'];
    if (typeof text === 'string') {
      return text;
    }
    // Some LocalString containers store language items as children
    const ru = obj['ru'];
    if (typeof ru === 'string') {
      return ru;
    }
  }
  return '';
}

function parseItem(raw: unknown): PredefinedCharacteristicEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const item = raw as Record<string, unknown>;

  const id = typeof item['@_id'] === 'string' ? item['@_id'] : '';
  const name = typeof item['Name'] === 'string' ? item['Name'] : '';
  const code = typeof item['Code'] === 'string' ? item['Code'] : '';
  const description = extractDescription(item['Description']);
  const isFolder =
    item['IsFolder'] === true ||
    item['IsFolder'] === 'true' ||
    item['IsFolder'] === 1;
  const type = extractTypeStrings(item['Type']);

  if (!name) {
    return null;
  }

  return { id, name, code, description, isFolder, type };
}

/**
 * Parse Ext/Predefined.xml for a ChartOfCharacteristicTypes object.
 * Returns empty array for unsupported xsi:type or malformed XML.
 */
export function parsePredefinedCharacteristics(xmlText: string): PredefinedCharacteristicEntry[] {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xmlText);
  } catch (err) {
    Logger.warn('parsePredefinedCharacteristics: XML parse failed', err);
    return [];
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }

  // Find PredefinedData root (may have namespace prefix)
  let root: Record<string, unknown> | null = null;
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if ((key === 'PredefinedData' || key.endsWith(':PredefinedData')) &&
        val && typeof val === 'object' && !Array.isArray(val)) {
      root = val as Record<string, unknown>;
      break;
    }
  }

  if (!root) {
    Logger.warn('parsePredefinedCharacteristics: PredefinedData root not found');
    return [];
  }

  // Validate xsi:type
  const xsiType = root['@_xsi:type'] as string | undefined;
  if (!xsiType || !xsiType.includes('PlanOfCharacteristicKind')) {
    Logger.warn(`parsePredefinedCharacteristics: unexpected xsi:type="${xsiType}", skipping`);
    return [];
  }

  const rawItems = root['Item'];
  if (!rawItems) {
    return [];
  }

  const itemArray = Array.isArray(rawItems) ? rawItems : [rawItems];
  const results: PredefinedCharacteristicEntry[] = [];

  for (const raw of itemArray) {
    const entry = parseItem(raw);
    if (entry) {
      results.push(entry);
    }
  }

  return results;
}
