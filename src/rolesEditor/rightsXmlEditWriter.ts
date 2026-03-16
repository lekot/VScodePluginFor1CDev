/**
 * Load, merge RoleModel.rights into EDT Ext/Rights.xml, and serialize back.
 * Used for Case A (Rights in Roles/ИмяРоли/Ext/Rights.xml). Do not use for Case B (Role.xml).
 */

import * as path from 'path';
import * as fs from 'fs';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { Logger } from '../utils/logger';
import type { RightsMap, ObjectRights } from './models/roleModel';
import { ALL_RIGHT_TYPES, type RightType } from './models/roleModel';

/** Mapping from ObjectRights property names to EDT Rights.xml right <name> values */
const RIGHTS_TO_XML_NAME: Record<keyof ObjectRights, string> = {
  read: 'Read',
  insert: 'Insert',
  update: 'Update',
  delete: 'Delete',
  view: 'View',
  edit: 'Edit',
  interactiveInsert: 'InteractiveInsert',
  interactiveDelete: 'InteractiveDelete',
  interactiveClear: 'InteractiveClear',
  interactiveDeleteMarked: 'InteractiveDeleteMarked',
  interactiveUndeleteMarked: 'InteractiveUndeleteMarked',
  interactiveDeletePredefinedData: 'InteractiveDeletePredefinedData',
  interactiveSetDeletionMark: 'InteractiveSetDeletionMark',
  interactiveClearDeletionMark: 'InteractiveClearDeletionMark',
  interactiveDeleteMarkedPredefinedData: 'InteractiveDeleteMarkedPredefinedData'
};

const RIGHTS_XML_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  trimValues: true,
  ignoreNameSpace: false,
  removeNSPrefix: false,
  parseTagValue: false,
};

const RIGHTS_XML_BUILDER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  preserveOrder: true,
  format: true,
  indentBy: '\t',
  suppressEmptyNode: false,
};

/** Parsed Rights.xml as preserveOrder array: root is [ { Rights: contentArray } ]. */
export type RightsDom = Array<Record<string, unknown>>;

/**
 * Compute path to Ext/Rights.xml from the role file path (same as roleXmlParser.parseRightsXml).
 * When opened file is Roles/ИмяРоли.xml → Roles/ИмяРоли/Ext/Rights.xml.
 */
export function getRightsPath(roleFilePath: string): string {
  const roleDir = path.dirname(roleFilePath);
  const baseName = path.basename(roleFilePath, path.extname(roleFilePath));
  return path.join(roleDir, baseName, 'Ext', 'Rights.xml');
}

/**
 * Create minimal Rights document DOM (file does not exist).
 * Root <Rights> with xmlns, setForNewObjects, setForAttributesByDefault, independentRightsOfChildObjects.
 */
export function createMinimalRightsDom(): RightsDom {
  const content: unknown[] = [
    {
      ':@': {
        '@_xmlns': 'http://v8.1c.ru/8.2/roles',
        '@_xmlns:xs': 'http://www.w3.org/2001/XMLSchema',
        '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        '@_xsi:type': 'Rights',
        '@_version': '2.20'
      }
    },
    { setForNewObjects: [{ '#text': 'false' }] },
    { setForAttributesByDefault: [{ '#text': 'true' }] },
    { independentRightsOfChildObjects: [{ '#text': 'false' }] }
  ];
  return [{ Rights: content }];
}

/**
 * Load and parse existing Rights.xml into a DOM. Preserves full structure.
 * If file does not exist, returns minimal DOM. On parse error throws.
 */
export async function loadRightsXml(rightsPath: string): Promise<RightsDom> {
  let xmlContent: string;
  try {
    xmlContent = await fs.promises.readFile(rightsPath, 'utf-8');
  } catch (err) {
    const code = err && typeof (err as NodeJS.ErrnoException).code === 'string' ? (err as NodeJS.ErrnoException).code : '';
    if (code === 'ENOENT') {
      Logger.debug(`Rights.xml not found at ${rightsPath}, using minimal document`);
      return createMinimalRightsDom();
    }
    Logger.error(`Failed to read Rights.xml: ${rightsPath}`, err);
    throw new Error(`Не удалось прочитать Rights.xml: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!xmlContent || xmlContent.trim() === '') {
    Logger.debug('Rights.xml is empty, using minimal document');
    return createMinimalRightsDom();
  }

  const parser = new XMLParser(RIGHTS_XML_PARSER_OPTIONS);
  let parsed: unknown;
  try {
    parsed = parser.parse(xmlContent);
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    Logger.error(`Failed to parse Rights.xml: ${rightsPath}`, parseErr);
    throw new Error(`Не удалось разобрать Rights.xml (некорректный XML). ${msg}`);
  }

  if (!parsed || !Array.isArray(parsed)) {
    throw new Error('Не удалось разобрать Rights.xml: неверная структура документа.');
  }

  return parsed as RightsDom;
}

function getRightsContentArray(dom: RightsDom): unknown[] {
  for (const item of dom) {
    if (!item || typeof item !== 'object') continue;
    for (const key of Object.keys(item)) {
      if (key === 'Rights' || (key.includes(':') && key.split(':').pop() === 'Rights')) {
        const val = (item as Record<string, unknown>)[key];
        return Array.isArray(val) ? val : [];
      }
    }
  }
  return [];
}

function getTextFromNode(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && '#text' in (item as object)) {
        const t = (item as Record<string, unknown>)['#text'];
        return t != null ? String(t).trim() : '';
      }
    }
  }
  if (value && typeof value === 'object' && '#text' in (value as object)) {
    const t = (value as Record<string, unknown>)['#text'];
    return t != null ? String(t).trim() : '';
  }
  return '';
}

function getByLocalName(obj: Record<string, unknown>, localName: string): unknown {
  for (const k of Object.keys(obj)) {
    const local = k.includes(':') ? k.split(':').pop()! : k;
    if (local === localName) return obj[k];
  }
  return undefined;
}

function getObjectNameFromContent(content: unknown[]): string | null {
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const nameVal = getByLocalName(o, 'name');
    if (nameVal !== undefined) {
      const s = getTextFromNode(nameVal);
      return s || null;
    }
  }
  return null;
}

/** Collect all <object> items from Rights content; each item is { object: contentArray }. */
function getObjectItems(content: unknown[]): Array<{ index: number; content: unknown[] }> {
  const result: Array<{ index: number; content: unknown[] }> = [];
  for (let i = 0; i < content.length; i++) {
    const item = content[i];
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const objVal = getByLocalName(o, 'object');
    if (objVal !== undefined) {
      const arr = Array.isArray(objVal) ? objVal : [objVal];
      result.push({ index: i, content: arr });
    }
  }
  return result;
}

/** Find <right> with given name in object content. Each entry is { right: rightContentArray }. Returns that array to mutate. */
function findRightInObjectContent(objectContent: unknown[], rightName: string): unknown[] | null {
  for (const item of objectContent) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const rightVal = getByLocalName(o, 'right');
    if (rightVal === undefined) continue;
    const rightContent = Array.isArray(rightVal) ? rightVal : [rightVal];
    for (const sub of rightContent) {
      if (!sub || typeof sub !== 'object') continue;
      const subObj = sub as Record<string, unknown>;
      const nameVal = getByLocalName(subObj, 'name');
      const n = getTextFromNode(nameVal);
      if (n === rightName) return rightContent;
    }
  }
  return null;
}

/** Update <value> inside a right content array. Preserves other children (e.g. restrictionByCondition). */
function setValueInRightContent(rightContent: unknown[], value: boolean): void {
  const valueStr = value ? 'true' : 'false';
  for (const item of rightContent) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const local = k.includes(':') ? k.split(':').pop()! : k;
      if (local === 'value') {
        o[k] = [{ '#text': valueStr }];
        return;
      }
    }
  }
  rightContent.push({ value: [{ '#text': valueStr }] });
}

/** Append new <right> (name + value) to object content array. */
function appendRightToObjectContent(objectContent: unknown[], rightName: string, value: boolean): void {
  const valueStr = value ? 'true' : 'false';
  const rightEntry: Record<string, unknown> = {
    right: [
      { name: [{ '#text': rightName }] },
      { value: [{ '#text': valueStr }] }
    ]
  };
  objectContent.push(rightEntry);
}

/** Find first index of restrictionTemplate in content array. */
function indexOfFirstRestrictionTemplate(content: unknown[]): number {
  for (let i = 0; i < content.length; i++) {
    const item = content[i];
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const local = k.includes(':') ? k.split(':').pop()! : k;
      if (local === 'restrictionTemplate') return i;
    }
  }
  return content.length;
}

/** Build new <object> element content for objectFullName and objectRights. */
function buildNewObjectContent(objectFullName: string, objectRights: ObjectRights): unknown[] {
  const content: unknown[] = [{ name: [{ '#text': objectFullName }] }];
  for (const rightType of ALL_RIGHT_TYPES) {
    const xmlName = RIGHTS_TO_XML_NAME[rightType as RightType];
    const value = objectRights[rightType as RightType];
    content.push({
      right: [
        { name: [{ '#text': xmlName }] },
        { value: [{ '#text': value ? 'true' : 'false' }] }
      ]
    });
  }
  return content;
}

/**
 * Merge RoleModel.rights into the Rights DOM. Mutates dom.
 * For each objectFullName: find or create <object>, update/add only known rights; never remove restrictionByCondition, restrictionTemplate, or unknown rights.
 */
export function mergeRightsIntoDom(dom: RightsDom, rights: RightsMap): void {
  const content = getRightsContentArray(dom);
  const objectItems = getObjectItems(content);
  const insertBeforeIndex = indexOfFirstRestrictionTemplate(content);

  for (const [objectFullName, objectRights] of Object.entries(rights)) {
    let objectContent: unknown[] | null = null;
    for (const { content: objContent } of objectItems) {
      const name = getObjectNameFromContent(objContent);
      if (name === objectFullName) {
        objectContent = objContent;
        break;
      }
    }

    if (!objectContent) {
      const newContent = buildNewObjectContent(objectFullName, objectRights);
      const newItem: Record<string, unknown> = { object: newContent };
      content.splice(insertBeforeIndex, 0, newItem);
      objectItems.push({ index: insertBeforeIndex, content: newContent });
      for (let j = insertBeforeIndex + 1; j < objectItems.length; j++) objectItems[j].index++;
      continue;
    }

    for (const rightType of ALL_RIGHT_TYPES) {
      const xmlName = RIGHTS_TO_XML_NAME[rightType as RightType];
      const value = objectRights[rightType as RightType];
      const rightContent = findRightInObjectContent(objectContent, xmlName);
      if (rightContent) {
        setValueInRightContent(rightContent, value);
      } else {
        appendRightToObjectContent(objectContent, xmlName, value);
      }
    }
  }
}

/**
 * Serialize Rights DOM to XML string. Preserves declaration and root attributes.
 */
export function serializeRightsDomToXml(dom: RightsDom): string {
  const builder = new XMLBuilder(RIGHTS_XML_BUILDER_OPTIONS);
  let xmlString: string;
  try {
    xmlString = builder.build(dom) as string;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Failed to serialize Rights.xml', err);
    throw new Error(`Не удалось сформировать Rights.xml: ${message}`);
  }
  if (!xmlString.startsWith('<?xml')) {
    xmlString = '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlString;
  }
  if (!xmlString.endsWith('\n')) {
    xmlString += '\n';
  }
  return xmlString;
}
