/**
 * Parser for Ext/Form.xml (1C form structure).
 * Extracts ChildItems, Attributes, Commands, Events into FormModel.
 * Does not modify existing metadata parsers.
 */

import * as fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from '../utils/logger';
import {
  FormModel,
  FormChildItem,
  FormAttribute,
  FormCommand,
  FormEventItem,
  FormParseResult,
  FormParseError,
  FormParseFileMissing,
  createEmptyFormModel,
} from './formModel';

const FORM_XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  ignoreNameSpace: true,
  trimValues: true,
};

/** Get local name (after last ':') for namespace-aware matching. */
function localName(key: string): string {
  return key.includes(':') ? key.split(':').pop()! : key;
}

/**
 * Get the first object in array that has the given key (by local name).
 */
function findKeyInArray(arr: unknown[] | undefined, key: string): unknown[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    for (const k of Object.keys(item as object)) {
      if (localName(k) === key) {
        const val = (item as Record<string, unknown>)[k];
        return Array.isArray(val) ? val : undefined;
      }
    }
  }
  return undefined;
}

/**
 * Get value from object by local name of key.
 */
function getByLocalName(obj: Record<string, unknown>, key: string): unknown {
  for (const k of Object.keys(obj)) {
    if (localName(k) === key) return obj[k];
  }
  return undefined;
}

/**
 * Get @_name and @_id from content array.
 * Attributes may be direct items { "@_name": "..." } or in a ":@" wrapper { ":@": { "@_name": "...", "@_id": "..." } }.
 */
function getAttrsFromContent(content: unknown[]): { name?: string; id?: string } {
  const attrs: { name?: string; id?: string } = {};
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if ('@_name' in o && typeof o['@_name'] === 'string') attrs.name = o['@_name'];
    if ('@_id' in o && typeof o['@_id'] === 'string') attrs.id = o['@_id'];
    const at = o[':@'];
    if (at && typeof at === 'object' && !Array.isArray(at)) {
      const atObj = at as Record<string, unknown>;
      if (typeof atObj['@_name'] === 'string') attrs.name = atObj['@_name'];
      if (typeof atObj['@_id'] === 'string') attrs.id = atObj['@_id'];
    }
  }
  return attrs;
}

/**
 * Extract Events from array of Event elements (each item is { Event: [ ... ] }).
 */
function parseEventsContent(content: unknown[] | undefined): FormEventItem[] {
  const out: FormEventItem[] = [];
  if (!Array.isArray(content)) return out;
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const evContentRaw = getByLocalName(o, 'Event');
    if (evContentRaw === undefined) continue;
    const evContent = Array.isArray(evContentRaw) ? evContentRaw : [evContentRaw];
    let name: string | undefined;
    let method = '';
    for (const ev of evContent) {
      if (!ev || typeof ev !== 'object') continue;
      const e = ev as Record<string, unknown>;
      const at = e[':@'];
      if (at && typeof at === 'object' && !Array.isArray(at)) {
        const atObj = at as Record<string, unknown>;
        if (typeof atObj['@_name'] === 'string') name = atObj['@_name'];
      }
      if ('#text' in e && e['#text'] != null) method = String(e['#text']).trim();
    }
    if (name) out.push({ name, method });
  }
  return out;
}

/**
 * Parse ChildItems array into FormChildItem[]. Content is array of { TagName: [ ... ] }.
 */
function parseChildItemsArray(content: unknown[] | undefined): FormChildItem[] {
  const result: FormChildItem[] = [];
  if (!Array.isArray(content)) return result;
  const skipTags = new Set(['ChildItems', 'Events']);
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    for (const tag of Object.keys(obj)) {
      if (tag.startsWith('@') || tag === '#text' || tag === ':@' || skipTags.has(localName(tag))) continue;
      const childContent = obj[tag];
      const arr = Array.isArray(childContent) ? childContent : [];
      let { name: attrName, id: attrId } = getAttrsFromContent(arr);
      const at = obj[':@'];
      if (at && typeof at === 'object' && !Array.isArray(at)) {
        const atObj = at as Record<string, unknown>;
        if (typeof atObj['@_name'] === 'string') attrName = atObj['@_name'];
        if (typeof atObj['@_id'] === 'string') attrId = atObj['@_id'];
      }
      const name = attrName ?? tag;
      const childItemsContent = findKeyInArray(arr, 'ChildItems');
      const childItems = parseChildItemsArray(childItemsContent);
      const eventsContent = findKeyInArray(arr, 'Events');
      const eventList = parseEventsContent(eventsContent as unknown[]);
      const eventsMap: Record<string, string> = {};
      for (const e of eventList) eventsMap[e.name] = e.method;
      const properties: Record<string, unknown> = {};
      for (const prop of arr) {
        if (!prop || typeof prop !== 'object') continue;
        const p = prop as Record<string, unknown>;
        const k = Object.keys(p)[0];
        if (!k || k.startsWith('@') || k === '#text' || k === 'ChildItems' || k === 'Events') continue;
        properties[k] = p[k];
      }
      result.push({
        tag,
        id: attrId,
        name,
        properties,
        childItems,
        events: Object.keys(eventsMap).length > 0 ? eventsMap : undefined,
      });
    }
  }
  return result;
}

/**
 * Parse Attributes section: array of Attribute elements.
 */
function parseAttributesContent(content: unknown[] | undefined): FormAttribute[] {
  const result: FormAttribute[] = [];
  if (!Array.isArray(content)) return result;
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const attrContent = getByLocalName(o, 'Attribute');
    if (attrContent === undefined) continue;
    const c = Array.isArray(attrContent) ? attrContent : [attrContent];
    const { name: n, id } = getAttrsFromContent(c);
    const properties: Record<string, unknown> = {};
    for (const prop of c) {
      if (!prop || typeof prop !== 'object') continue;
      const p = prop as Record<string, unknown>;
      const k = Object.keys(p)[0];
      if (!k || k.startsWith('@') || k === '#text') continue;
      properties[k] = p[k];
    }
    if (n) result.push({ name: n, id, properties });
  }
  return result;
}

/**
 * Parse Commands section: array of Command elements.
 */
function parseCommandsContent(content: unknown[] | undefined): FormCommand[] {
  const result: FormCommand[] = [];
  if (!Array.isArray(content)) return result;
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const cmdContent = getByLocalName(o, 'Command');
    if (cmdContent === undefined) continue;
    const c = Array.isArray(cmdContent) ? cmdContent : [cmdContent];
    const { name: n, id } = getAttrsFromContent(c);
    const properties: Record<string, unknown> = {};
    for (const prop of c) {
      if (!prop || typeof prop !== 'object') continue;
      const p = prop as Record<string, unknown>;
      const k = Object.keys(p)[0];
      if (!k || k.startsWith('@') || k === '#text') continue;
      properties[k] = p[k];
    }
    if (n) result.push({ name: n, id, properties });
  }
  return result;
}

/**
 * Parse Attributes section when it's direct array of Attribute objects (form root level).
 */
function parseAttributesSection(formContent: unknown[]): FormAttribute[] {
  for (const item of formContent) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const attrs = getByLocalName(o, 'Attributes');
    if (Array.isArray(attrs)) return parseAttributesContent(attrs as unknown[]);
  }
  return [];
}

/**
 * Parse Commands section from form content.
 */
function parseCommandsSection(formContent: unknown[]): FormCommand[] {
  for (const item of formContent) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const cmds = getByLocalName(o, 'Commands');
    if (Array.isArray(cmds)) return parseCommandsContent(cmds as unknown[]);
  }
  return [];
}

/**
 * Parse form-level Events from form content.
 */
function parseFormEventsSection(formContent: unknown[]): FormEventItem[] {
  for (const item of formContent) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const evs = getByLocalName(o, 'Events');
    if (Array.isArray(evs)) return parseEventsContent(evs as unknown[]);
  }
  return [];
}

/**
 * Parse top-level ChildItems (under Form).
 */
function parseRootChildItems(formContent: unknown[]): FormChildItem[] {
  for (const item of formContent) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const children = getByLocalName(o, 'ChildItems');
    if (Array.isArray(children)) return parseChildItemsArray(children as unknown[]);
  }
  return [];
}

/**
 * Parse AutoCommandBar at form root: returns { name?, id? }.
 * AutoCommandBar is a single element with attributes name and/or id.
 */
function parseAutoCommandBar(formContent: unknown[]): { name?: string; id?: string } {
  for (const item of formContent) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const autoBar = getByLocalName(o, 'AutoCommandBar');
    if (autoBar === undefined) continue;
    const arr = Array.isArray(autoBar) ? autoBar : [autoBar];
    const { name, id } = getAttrsFromContent(arr);
    return { name, id };
  }
  return {};
}

/**
 * Parse Form.xml from file path.
 * @param formXmlPath Path to Ext/Form.xml
 * @param allowFileMissing If true, return fileMissing + empty model instead of error when file does not exist
 */
export async function parseFormXml(
  formXmlPath: string,
  allowFileMissing = false
): Promise<FormParseResult> {
  let xmlContent: string;
  try {
    xmlContent = await fs.promises.readFile(formXmlPath, 'utf-8');
  } catch (readErr) {
    const err = readErr as NodeJS.ErrnoException;
    if (allowFileMissing && err?.code === 'ENOENT') {
      Logger.debug(`Form.xml not found (allowed): ${formXmlPath}`);
      return { fileMissing: true, model: createEmptyFormModel() } as FormParseFileMissing;
    }
    Logger.error(`Failed to read Form.xml: ${formXmlPath}`, readErr);
    return { error: `Не удалось прочитать файл: ${err?.message ?? String(readErr)}` } as FormParseError;
  }

  if (!xmlContent || xmlContent.trim() === '') {
    if (allowFileMissing) {
      return { fileMissing: true, model: createEmptyFormModel() } as FormParseFileMissing;
    }
    return { error: 'Файл структуры формы пуст.' } as FormParseError;
  }

  let parsed: unknown;
  try {
    const parser = new XMLParser(FORM_XML_OPTIONS);
    parsed = parser.parse(xmlContent);
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    Logger.error(`Form.xml parse error: ${formXmlPath}`, parseErr);
    return { error: `Не удалось разобрать Form.xml: ${msg}` } as FormParseError;
  }

  if (!parsed || !Array.isArray(parsed)) {
    return { error: 'Неверная структура Form.xml.' } as FormParseError;
  }

  let formContent: unknown[] | undefined;
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    for (const tag of Object.keys(obj)) {
      if (tag.startsWith('?') || tag === ':@') continue;
      const local = tag.includes(':') ? tag.split(':').pop()! : tag;
      if (local === 'Form') {
        const val = obj[tag];
        formContent = Array.isArray(val) ? val : undefined;
        break;
      }
    }
    if (formContent !== undefined) break;
  }
  if (!formContent) {
    return { error: 'В Form.xml не найден корневой элемент Form.' } as FormParseError;
  }

  const autoCommandBar = parseAutoCommandBar(formContent);
  const model: FormModel = {
    childItemsRoot: parseRootChildItems(formContent),
    attributes: parseAttributesSection(formContent),
    commands: parseCommandsSection(formContent),
    formEvents: parseFormEventsSection(formContent),
    autoCommandBarName: autoCommandBar.name,
    autoCommandBarId: autoCommandBar.id,
  };

  return { model };
}
