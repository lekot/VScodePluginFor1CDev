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
 * Root attributes required on the Rights element so 1C XDTO maps children to typed properties.
 * A bare Rights root (no xmlns / xsi:type) makes the platform treat content as xs:anyType and fail on setForNewObjects.
 */
const RIGHTS_ROOT_ATTRS_1C: Record<string, string> = {
  '@_xmlns': 'http://v8.1c.ru/8.2/roles',
  '@_xmlns:xs': 'http://www.w3.org/2001/XMLSchema',
  '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
  '@_xsi:type': 'Rights',
  '@_version': '2.20'
};

/**
 * fast-xml-parser XMLBuilder (preserveOrder) does not emit the leading `:@` attribute bag as root tag
 * attributes — output becomes a bare `<Rights>`. 1C then treats children as xs:anyType.
 */
const RIGHTS_ROOT_OPEN_TAG_1C =
  '<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">';

function applyRightsRootOpenTagFor1CXdto(xml: string): string {
  return xml.replace(/<(?:[a-zA-Z0-9_.]+:)?Rights\b[^>]*>/, (openTag) => {
    if (
      openTag.includes('http://v8.1c.ru/8.2/roles') &&
      openTag.includes('xsi:type') &&
      openTag.includes('version=')
    ) {
      return openTag;
    }
    return RIGHTS_ROOT_OPEN_TAG_1C;
  });
}

function findRightsKey(root: Record<string, unknown>): string | undefined {
  for (const k of Object.keys(root)) {
    if (k === 'Rights' || (k.includes(':') && k.split(':').pop() === 'Rights')) {
      return k;
    }
  }
  return undefined;
}

/**
 * Ensure preserveOrder DOM has a leading attribute bag on the Rights root for 1C Configurator / EDT.
 * Mutates dom in place.
 */
export function ensureRightsRootAttrsFor1CXdto(dom: RightsDom): void {
  if (!dom.length || typeof dom[0] !== 'object' || dom[0] === null) {
    return;
  }
  const root = dom[0] as Record<string, unknown>;
  const rightsKey = findRightsKey(root);
  if (!rightsKey) {
    return;
  }
  const val = root[rightsKey];
  if (!Array.isArray(val)) {
    return;
  }
  const content = val as unknown[];
  const first = content[0];
  const isAttrBag =
    first !== null &&
    typeof first === 'object' &&
    !Array.isArray(first) &&
    ':@' in first &&
    typeof (first as Record<string, unknown>)[':@'] === 'object' &&
    (first as Record<string, unknown>)[':@'] !== null;

  if (isAttrBag) {
    const bag = (first as Record<string, unknown>)[':@'] as Record<string, string>;
    for (const [attrName, defaultVal] of Object.entries(RIGHTS_ROOT_ATTRS_1C)) {
      const cur = bag[attrName];
      if (cur === undefined || cur === '') {
        bag[attrName] = defaultVal;
      }
    }
    return;
  }

  content.unshift({ ':@': { ...RIGHTS_ROOT_ATTRS_1C } });
}

/**
 * Candidate paths for `Ext/Rights.xml` next to a role XML file, **same probe order** as
 * `RoleXmlParser.parseRightsXml` (first existing file wins for reads).
 *
 * - EDT: `Roles/ИмяРоли.xml` → `[Roles/ИмяРоли/Ext/Rights.xml, Roles/Ext/Rights.xml]`
 * - Designer: `Roles/ИмяРоли/Role.xml` → `[Roles/ИмяРоли/Ext/Rights.xml]`
 */
export function listRightsXmlCandidatePaths(roleXmlPath: string): string[] {
  const roleDir = path.dirname(roleXmlPath);
  const baseName = path.basename(roleXmlPath, path.extname(roleXmlPath));
  if (baseName.toLowerCase() !== 'role') {
    return [
      path.join(roleDir, baseName, 'Ext', 'Rights.xml'),
      path.join(roleDir, 'Ext', 'Rights.xml'),
    ];
  }
  return [path.join(roleDir, 'Ext', 'Rights.xml')];
}

/**
 * Primary EDT `Ext/Rights.xml` path for **writes** (Case A). Always {@link listRightsXmlCandidatePaths}[0].
 * Not used when the open file is `Role.xml` (Case B — serializer writes the role file).
 */
export function getRightsPath(roleFilePath: string): string {
  return listRightsXmlCandidatePaths(roleFilePath)[0];
}

/**
 * Create minimal Rights document DOM (file does not exist).
 * Root <Rights> with xmlns, setForNewObjects, setForAttributesByDefault, independentRightsOfChildObjects.
 */
export function createMinimalRightsDom(): RightsDom {
  const content: unknown[] = [
    {
      ':@': {
        ...RIGHTS_ROOT_ATTRS_1C
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

  const dom = parsed as RightsDom;
  ensureRightsRootAttrsFor1CXdto(dom);
  return dom;
}

function getRightsContentArray(dom: RightsDom): unknown[] {
  for (const item of dom) {
    if (!item || typeof item !== 'object') {continue;}
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
  if (typeof value === 'string') {return value.trim();}
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
    if (local === localName) {return obj[k];}
  }
  return undefined;
}

function getObjectNameFromContent(content: unknown[]): string | null {
  for (const item of content) {
    if (!item || typeof item !== 'object') {continue;}
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
    if (!item || typeof item !== 'object') {continue;}
    const o = item as Record<string, unknown>;
    const objVal = getByLocalName(o, 'object');
    if (objVal !== undefined) {
      const arr = Array.isArray(objVal) ? objVal : [objVal];
      result.push({ index: i, content: arr });
    }
  }
  return result;
}

/** Allowed child element local names for a "simple" right (only name + value). */
const SIMPLE_RIGHT_CHILD_NAMES = new Set(['name', 'value']);

/**
 * Return true if this right has only <name> and <value> children (no restrictionByCondition etc.).
 */
function isSimpleRight(rightContent: unknown[]): boolean {
  for (const item of rightContent) {
    if (!item || typeof item !== 'object') {continue;}
    const o = item as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const local = k.includes(':') ? k.split(':').pop()! : k;
      if (!SIMPLE_RIGHT_CHILD_NAMES.has(local)) {return false;}
    }
  }
  return true;
}

/** Remove the <right> entry with given name from object content array (mutates array). */
function removeRightFromObjectContent(objectContent: unknown[], rightName: string): void {
  for (let i = 0; i < objectContent.length; i++) {
    const item = objectContent[i];
    if (!item || typeof item !== 'object') {continue;}
    const o = item as Record<string, unknown>;
    const rightVal = getByLocalName(o, 'right');
    if (rightVal === undefined) {continue;}
    const rightContent = Array.isArray(rightVal) ? rightVal : [rightVal];
    for (const sub of rightContent) {
      if (!sub || typeof sub !== 'object') {continue;}
      const subObj = sub as Record<string, unknown>;
      const nameVal = getByLocalName(subObj, 'name');
      const n = getTextFromNode(nameVal);
      if (n === rightName) {
        objectContent.splice(i, 1);
        return;
      }
    }
  }
}

/** Find <right> with given name in object content. Each entry is { right: rightContentArray }. Returns that array to mutate. */
function findRightInObjectContent(objectContent: unknown[], rightName: string): unknown[] | null {
  for (const item of objectContent) {
    if (!item || typeof item !== 'object') {continue;}
    const o = item as Record<string, unknown>;
    const rightVal = getByLocalName(o, 'right');
    if (rightVal === undefined) {continue;}
    const rightContent = Array.isArray(rightVal) ? rightVal : [rightVal];
    for (const sub of rightContent) {
      if (!sub || typeof sub !== 'object') {continue;}
      const subObj = sub as Record<string, unknown>;
      const nameVal = getByLocalName(subObj, 'name');
      const n = getTextFromNode(nameVal);
      if (n === rightName) {return rightContent;}
    }
  }
  return null;
}

/** Update <value> inside a right content array. Preserves other children (e.g. restrictionByCondition). */
function setValueInRightContent(rightContent: unknown[], value: boolean): void {
  const valueStr = value ? 'true' : 'false';
  for (const item of rightContent) {
    if (!item || typeof item !== 'object') {continue;}
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
    if (!item || typeof item !== 'object') {continue;}
    const o = item as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const local = k.includes(':') ? k.split(':').pop()! : k;
      if (local === 'restrictionTemplate') {return i;}
    }
  }
  return content.length;
}

/** Build new <object> element content for objectFullName and objectRights. When compactWrite is true, only rights with value true are added. */
function buildNewObjectContent(
  objectFullName: string,
  objectRights: ObjectRights,
  compactWrite: boolean
): unknown[] {
  const content: unknown[] = [{ name: [{ '#text': objectFullName }] }];
  for (const rightType of ALL_RIGHT_TYPES) {
    const xmlName = RIGHTS_TO_XML_NAME[rightType as RightType];
    const value = objectRights[rightType as RightType];
    if (compactWrite && !value) {continue;}
    content.push({
      right: [
        { name: [{ '#text': xmlName }] },
        { value: [{ '#text': value ? 'true' : 'false' }] }
      ]
    });
  }
  return content;
}

export interface MergeRightsOptions {
  /** When true (default): write only true for simple rights; remove simple <right> when false; keep and only update <value> for rights with restrictionByCondition etc. */
  compactWrite?: boolean;
}

/**
 * Merge RoleModel.rights into the Rights DOM. Mutates dom.
 * For each objectFullName: find or create <object>, update/add only known rights; never remove restrictionByCondition, restrictionTemplate, or unknown rights.
 * When compactWrite is true: simple <right> only when value true (remove when false); rights with extra children only get <value> updated.
 */
export function mergeRightsIntoDom(
  dom: RightsDom,
  rights: RightsMap,
  options?: MergeRightsOptions
): void {
  const compactWrite = options?.compactWrite !== false;
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
      const newContent = buildNewObjectContent(objectFullName, objectRights, compactWrite);
      const newItem: Record<string, unknown> = { object: newContent };
      content.splice(insertBeforeIndex, 0, newItem);
      objectItems.push({ index: insertBeforeIndex, content: newContent });
      for (let j = insertBeforeIndex + 1; j < objectItems.length; j++) {objectItems[j].index++;}
      continue;
    }

    for (const rightType of ALL_RIGHT_TYPES) {
      const xmlName = RIGHTS_TO_XML_NAME[rightType as RightType];
      const value = objectRights[rightType as RightType];
      const rightContent = findRightInObjectContent(objectContent, xmlName);
      if (rightContent) {
        if (!isSimpleRight(rightContent)) {
          setValueInRightContent(rightContent, value);
        } else {
          if (compactWrite && !value) {
            removeRightFromObjectContent(objectContent, xmlName);
          } else {
            setValueInRightContent(rightContent, value);
          }
        }
      } else {
        if (compactWrite && !value) {continue;}
        appendRightToObjectContent(objectContent, xmlName, value);
      }
    }
  }
}

/**
 * Unescape &quot; to " so 1C receives literal quotes in condition text.
 * Single global replace is O(n) and safe for Rights.xml (no &quot; in attribute values).
 */
function unescapeQuotesInConditions(xmlString: string): string {
  if (typeof xmlString !== 'string') {return xmlString;}
  return xmlString.replace(/&quot;/g, '"');
}

/**
 * Serialize Rights DOM to XML string. Preserves declaration and root attributes.
 * Unescapes &quot; so 1C compatibility is preserved.
 */
/** Same pattern as RoleXmlParser.extractRestrictionTemplatesBlocks — strip template blocks from serialized Rights.xml. */
const RESTRICTION_TEMPLATE_BLOCK_RE =
  /<(?:[a-zA-Z0-9_.]+:)?restrictionTemplate\b[^>]*>[\s\S]*?<\/(?:[a-zA-Z0-9_.]+:)?restrictionTemplate>/gi;

/**
 * Remove all restrictionTemplate blocks from a Rights.xml string (before re-inserting user-edited templates).
 */
export function stripRestrictionTemplateBlocksFromRightsXml(xml: string): string {
  return xml.replace(RESTRICTION_TEMPLATE_BLOCK_RE, '');
}

/**
 * After merge/serialize, replace template section with user text (raw XML), inserted before closing </Rights>.
 */
export function insertRestrictionTemplatesBeforeClosingRights(
  xml: string,
  templatesBlock: string
): string {
  const trimmed = templatesBlock.trim();
  const withoutOld = stripRestrictionTemplateBlocksFromRightsXml(xml);
  if (!trimmed) {
    return withoutOld;
  }
  return withoutOld.replace(
    /<\/(?:[a-zA-Z0-9_.]+:)?Rights\s*>/i,
    (closeTag) => `\n${trimmed}\n${closeTag}`
  );
}

export function serializeRightsDomToXml(dom: RightsDom): string {
  ensureRightsRootAttrsFor1CXdto(dom);
  const builder = new XMLBuilder(RIGHTS_XML_BUILDER_OPTIONS);
  let xmlString: string;
  try {
    xmlString = builder.build(dom) as string;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error('Failed to serialize Rights.xml', err);
    throw new Error(`Не удалось сформировать Rights.xml: ${message}`);
  }
  xmlString = applyRightsRootOpenTagFor1CXdto(xmlString);
  try {
    xmlString = unescapeQuotesInConditions(xmlString);
  } catch (e) {
    Logger.warn('unescapeQuotesInConditions failed, using builder output as-is', e);
  }
  if (!xmlString.startsWith('<?xml')) {
    xmlString = '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlString;
  }
  if (!xmlString.endsWith('\n')) {
    xmlString += '\n';
  }
  return xmlString;
}
