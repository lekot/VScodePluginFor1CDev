/**
 * Utility functions for FormModel: ID generation, cloning, type helpers.
 * No vscode dependency — safe to import in console tests.
 */

import type { FormModel, FormChildItem, FormAttribute } from './formModel';

export type ContainerOrientation = 'horizontal' | 'vertical';

export interface ContainerLayoutPreviewMeta {
  orientation: ContainerOrientation;
  shouldIndentChildren: boolean;
  containerClassHints: string[];
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toScalarString(value: unknown): string {
  if (value == null) {return '';}
  if (typeof value === 'string') {return value.trim();}
  if (typeof value === 'number' || typeof value === 'boolean') {return String(value).trim();}
  if (typeof value !== 'object') {return '';}
  const rec = value as Record<string, unknown>;
  for (const k of ['#text', '_', 'value', 'Value', 'name', 'Name']) {
    if (rec[k] != null) {
      const nested = toScalarString(rec[k]);
      if (nested) {return nested;}
    }
  }
  return '';
}

function getPropertyValueByAliases(
  properties: Record<string, unknown> | undefined,
  aliases: readonly string[],
): string {
  if (!properties) {return '';}
  const directKeyMap = new Map<string, string>();
  for (const key of Object.keys(properties)) {
    if (key === ':@' || key.startsWith('@')) {continue;}
    directKeyMap.set(normalizeKey(key.includes(':') ? key.split(':').pop() ?? key : key), key);
  }
  for (const alias of aliases) {
    const lookup = directKeyMap.get(normalizeKey(alias));
    if (!lookup) {continue;}
    const val = toScalarString(properties[lookup]);
    if (val) {return val;}
  }
  return '';
}

function normalizeOrientation(rawValue: string): ContainerOrientation | null {
  const v = rawValue.toLowerCase().replace(/[\s_-]+/g, '');
  if (!v) {return null;}
  if (v.includes('horizontal') || v.includes('horiz') || v === 'row' || v.includes('leftright') || v.includes('слеванаправо')) {
    return 'horizontal';
  }
  if (v.includes('vertical') || v.includes('vert') || v === 'column' || v.includes('topbottom') || v.includes('сверхувниз')) {
    return 'vertical';
  }
  if (v.includes('по горизонтали') || v.includes('горизонт')) {return 'horizontal';}
  if (v.includes('по вертикали') || v.includes('вертикал')) {return 'vertical';}
  return null;
}

/** Compact, safe layout metadata for preview rendering of container child items. */
export function getContainerLayoutPreviewMeta(item: FormChildItem | undefined): ContainerLayoutPreviewMeta {
  const tag = String(item?.tag || '');
  const properties = item?.properties as Record<string, unknown> | undefined;
  const rawOrientation = getPropertyValueByAliases(properties, [
    'Group',
    'groups',
    'GroupOrientation',
    'Orientation',
    'Layout',
    'LayoutOrientation',
    'ChildrenLayout',
    'ChildItemsLayout',
    'Расположение',
    'Ориентация',
    'Группировка',
  ]);
  const orientation = normalizeOrientation(rawOrientation) ?? 'vertical';
  const rawIndent = getPropertyValueByAliases(properties, [
    'IndentChildren',
    'ShouldIndentChildren',
    'ChildIndent',
    'Вложенность',
    'ОтступДетей',
  ]).toLowerCase();
  const explicitIndent = rawIndent === 'true' || rawIndent === '1' || rawIndent === 'yes' || rawIndent === 'да'
    ? true
    : rawIndent === 'false' || rawIndent === '0' || rawIndent === 'no' || rawIndent === 'нет'
      ? false
      : undefined;
  const baseIndentByTag = tag === 'Page' || tag === 'Group' || tag === 'UsualGroup' || tag === 'CollapsibleGroup';
  const shouldIndentChildren = explicitIndent ?? baseIndentByTag;
  const hints = new Set<string>(['container', `container-${orientation}`]);
  if (shouldIndentChildren) {hints.add('container-indent');}
  if (tag) {hints.add(`container-${tag.toLowerCase()}`);}
  if (tag === 'AutoCommandBar') {hints.add('container-buttons');}
  if (tag === 'Page' || tag === 'Pages') {hints.add('container-page');}
  return {
    orientation,
    shouldIndentChildren,
    containerClassHints: [...hints],
  };
}

/** Resolve attribute type string from FormAttribute.properties (Type or v8:Type etc.). */
export function getAttributeTypeString(attr: FormAttribute): string {
  if (!attr?.properties) {return '';}
  const v = attr.properties['Type'];
  if (v != null) {
    if (typeof v === 'string') {return v.trim();}
    if (typeof v === 'object' && v !== null && '#text' in (v as object)) {return String((v as { '#text'?: unknown })['#text'] ?? '').trim();}
  }
  for (const k of Object.keys(attr.properties)) {
    if (k === ':@' || k.startsWith('@')) {continue;}
    const local = k.includes(':') ? k.split(':').pop()! : k;
    if (local === 'Type') {
      const val = attr.properties[k];
      if (typeof val === 'string') {return val.trim();}
      if (typeof val === 'object' && val !== null && '#text' in (val as object)) {return String((val as { '#text'?: unknown })['#text'] ?? '').trim();}
    }
  }
  return '';
}

/** Map form attribute type to form element tag: boolean → CheckBoxField, else InputField. */
export function requisiteTypeToTag(attr: FormAttribute | undefined): string {
  if (!attr) {return 'InputField';}
  const typeStr = getAttributeTypeString(attr).toLowerCase();
  if (typeStr === 'xs:boolean' || typeStr === 'boolean' || typeStr.includes('boolean')) {return 'CheckBoxField';}
  return 'InputField';
}

/** Collect all id values from tree (numeric ones for max). */
function collectIds(items: FormChildItem[], out: Set<string>): void {
  for (const item of items) {
    if (item.id != null) {out.add(String(item.id));}
    if (item.childItems?.length) {collectIds(item.childItems, out);}
  }
}

/** Generate next free id (max numeric + 1). */
export function generateNextId(model: FormModel): string {
  const ids = new Set<string>();
  collectIds(model.childItemsRoot, ids);
  let max = 0;
  for (const id of ids) {
    const n = parseInt(id, 10);
    if (!Number.isNaN(n) && n > max) {max = n;}
  }
  return String(max + 1);
}

/** Next numeric id for attributes (max of attribute ids + 1). */
export function generateNextAttributeId(model: FormModel): string {
  let max = 0;
  for (const a of model.attributes || []) {
    if (a.id) {
      const n = parseInt(a.id, 10);
      if (!Number.isNaN(n) && n > max) {max = n;}
    }
  }
  return String(max + 1);
}

/** Next numeric id for commands (max of command ids + 1). */
export function generateNextCommandId(model: FormModel): string {
  let max = 0;
  for (const c of model.commands || []) {
    if (c.id) {
      const n = parseInt(c.id, 10);
      if (!Number.isNaN(n) && n > max) {max = n;}
    }
  }
  return String(max + 1);
}

/** Deep clone FormChildItem and assign new ids via nextId(). */
export function cloneWithNewIds(item: FormChildItem, nextId: () => string): FormChildItem {
  const id = item.id ? nextId() : undefined;
  return {
    tag: item.tag,
    id,
    name: item.name,
    properties: JSON.parse(JSON.stringify(item.properties || {})),
    childItems: (item.childItems || []).map((c) => cloneWithNewIds(c, nextId)),
    events: item.events ? { ...item.events } : undefined,
  };
}

/** Create nextId generator for a model (uses generateNextId and then increments). */
export function createIdGenerator(model: FormModel): () => string {
  let next = 0;
  const initial = generateNextId(model);
  next = parseInt(initial, 10);
  if (Number.isNaN(next)) {next = 1;}
  return () => String(next++);
}

/** Return ids sorted so that descendants appear before their ancestors (deepest first). */
export function orderIdsForDeletion(model: FormModel, ids: string[]): string[] {
  const depthMap = new Map<string, number>();
  const walk = (items: FormChildItem[], d: number) => {
    for (const item of items) {
      const id = item.id || item.name;
      if (id) {depthMap.set(id, d);}
      if (item.childItems?.length) {walk(item.childItems, d + 1);}
    }
  };
  walk(model.childItemsRoot, 0);
  return ids.slice().sort((a, b) => (depthMap.get(b) ?? 0) - (depthMap.get(a) ?? 0));
}
