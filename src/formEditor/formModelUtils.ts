/**
 * Utility functions for FormModel: ID generation, cloning, type helpers.
 * No vscode dependency — safe to import in console tests.
 */

import type { FormModel, FormChildItem, FormAttribute } from './formModel';

/** Resolve attribute type string from FormAttribute.properties (Type or v8:Type etc.). */
export function getAttributeTypeString(attr: FormAttribute): string {
  if (!attr?.properties) return '';
  const v = attr.properties['Type'];
  if (v != null) {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'object' && v !== null && '#text' in (v as object)) return String((v as { '#text'?: unknown })['#text'] ?? '').trim();
  }
  for (const k of Object.keys(attr.properties)) {
    if (k === ':@' || k.startsWith('@')) continue;
    const local = k.includes(':') ? k.split(':').pop()! : k;
    if (local === 'Type') {
      const val = attr.properties[k];
      if (typeof val === 'string') return val.trim();
      if (typeof val === 'object' && val !== null && '#text' in (val as object)) return String((val as { '#text'?: unknown })['#text'] ?? '').trim();
    }
  }
  return '';
}

/** Map form attribute type to form element tag: boolean → CheckBoxField, else InputField. */
export function requisiteTypeToTag(attr: FormAttribute | undefined): string {
  if (!attr) return 'InputField';
  const typeStr = getAttributeTypeString(attr).toLowerCase();
  if (typeStr === 'xs:boolean' || typeStr === 'boolean' || typeStr.includes('boolean')) return 'CheckBoxField';
  return 'InputField';
}

/** Collect all id values from tree (numeric ones for max). */
function collectIds(items: FormChildItem[], out: Set<string>): void {
  for (const item of items) {
    if (item.id != null) out.add(String(item.id));
    if (item.childItems?.length) collectIds(item.childItems, out);
  }
}

/** Generate next free id (max numeric + 1). */
export function generateNextId(model: FormModel): string {
  const ids = new Set<string>();
  collectIds(model.childItemsRoot, ids);
  let max = 0;
  for (const id of ids) {
    const n = parseInt(id, 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return String(max + 1);
}

/** Next numeric id for attributes (max of attribute ids + 1). */
export function generateNextAttributeId(model: FormModel): string {
  let max = 0;
  for (const a of model.attributes || []) {
    if (a.id) {
      const n = parseInt(a.id, 10);
      if (!Number.isNaN(n) && n > max) max = n;
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
      if (!Number.isNaN(n) && n > max) max = n;
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
  if (Number.isNaN(next)) next = 1;
  return () => String(next++);
}

/** Return ids sorted so that descendants appear before their ancestors (deepest first). */
export function orderIdsForDeletion(model: FormModel, ids: string[]): string[] {
  const depthMap = new Map<string, number>();
  const walk = (items: FormChildItem[], d: number) => {
    for (const item of items) {
      const id = item.id || item.name;
      if (id) depthMap.set(id, d);
      if (item.childItems?.length) walk(item.childItems, d + 1);
    }
  };
  walk(model.childItemsRoot, 0);
  return ids.slice().sort((a, b) => (depthMap.get(b) ?? 0) - (depthMap.get(a) ?? 0));
}
