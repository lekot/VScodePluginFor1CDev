/**
 * Shared helpers to parse ChildObjects from 1C metadata XML (Designer/EDT).
 * Used by designerParser and edtParser for Attributes and TabularSections.
 */
import { convertStringBooleans } from '../utils/xmlPropertyUtils';

export function findChildObjects(xmlContent: Record<string, unknown>): unknown {
  if (!xmlContent || typeof xmlContent !== 'object') {
    return null;
  }
  for (const [key, value] of Object.entries(xmlContent)) {
    if (key === 'ChildObjects') {
      return value;
    }
    if (typeof value === 'object' && value !== null) {
      const found = findChildObjects(value as Record<string, unknown>);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export function extractAttributes(childObjects: unknown): unknown[] {
  const attributes: unknown[] = [];
  if (!childObjects || typeof childObjects !== 'object') {
    return attributes;
  }
  const obj = childObjects as Record<string, unknown>;
  if (obj.Attribute) {
    const attrData = obj.Attribute;
    if (Array.isArray(attrData)) {
      attributes.push(...attrData);
    } else {
      attributes.push(attrData);
    }
  }
  return attributes;
}

export function extractTabularSections(childObjects: unknown): unknown[] {
  const sections: unknown[] = [];
  if (!childObjects || typeof childObjects !== 'object') {
    return sections;
  }
  const obj = childObjects as Record<string, unknown>;
  if (obj.TabularSection) {
    const tsData = obj.TabularSection;
    if (Array.isArray(tsData)) {
      sections.push(...tsData);
    } else {
      sections.push(tsData);
    }
  }
  return sections;
}

/**
 * Extract child subsystem names from ChildObjects (Configurator XML).
 * Used for building subsystem hierarchy: each subsystem XML lists its children as
 * <Subsystem>Name</Subsystem> inside ChildObjects.
 * @param childObjects - The ChildObjects value from findChildObjects(xmlContent)
 * @returns Array of subsystem names (e.g. ['НСИЗакупок', 'РасчетыСПоставщиками'])
 */
export function extractChildSubsystems(childObjects: unknown): string[] {
  const names: string[] = [];
  if (!childObjects || typeof childObjects !== 'object') {
    return names;
  }
  const obj = childObjects as Record<string, unknown>;
  const raw = obj.Subsystem;
  if (raw === undefined) {return names;}
  const items = Array.isArray(raw) ? raw : [raw];
  for (const item of items) {
    if (typeof item === 'string') {
      names.push(item);
    } else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)['#text'] === 'string') {
      names.push((item as Record<string, unknown>)['#text'] as string);
    }
  }
  return names;
}

/** Local-name match for `xr:Item` / `Item` keys from fast-xml-parser. */
function isXrItemKey(key: string): boolean {
  if (key === '@_' || key.startsWith('#')) {
    return false;
  }
  const local = key.includes(':') ? key.split(':').pop()! : key;
  return local === 'Item';
}

function collectXrItemTexts(raw: unknown): string[] {
  const out: string[] = [];
  if (raw === undefined || raw === null) {
    return out;
  }
  const list = Array.isArray(raw) ? raw : [raw];
  for (const item of list) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) {
        out.push(t);
      }
      continue;
    }
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)['#text'] === 'string') {
      const t = ((item as Record<string, unknown>)['#text'] as string).trim();
      if (t) {
        out.push(t);
      }
    }
  }
  return out;
}

/**
 * Parse subsystem `Properties.Content` (Designer XML) into metadata full names (`Catalog.Items`, …).
 * Supports `xr:Item` / `Item` shapes from fast-xml-parser.
 * Used for B.3 composition workflows; does not validate references against the configuration graph.
 */
export function extractSubsystemCompositionRefs(content: unknown): string[] {
  if (content == null) {
    return [];
  }
  if (typeof content === 'string') {
    const t = content.trim();
    return t ? [t] : [];
  }
  if (typeof content !== 'object') {
    return [];
  }
  const obj = content as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (isXrItemKey(k)) {
      return collectXrItemTexts(v);
    }
  }
  return [];
}

/**
 * Syntax-only check for a metadata full name in subsystem Content (B.3).
 * Returns `null` if valid; otherwise a short English reason for UI / logs.
 * Does not verify that the object exists in the workspace configuration.
 */
export function validateSubsystemCompositionRef(ref: string): string | null {
  const t = typeof ref === 'string' ? ref.trim() : '';
  if (!t) {
    return 'empty reference';
  }
  if (/\s/.test(t)) {
    return 'reference must not contain whitespace';
  }
  const dot = t.indexOf('.');
  if (dot < 1 || dot === t.length - 1) {
    return 'expected format MetadataType.ObjectName';
  }
  if (t.indexOf('.', dot + 1) !== -1) {
    return 'expected a single dot between metadata type and object name';
  }
  const typePart = t.slice(0, dot);
  const namePart = t.slice(dot + 1);
  const seg = /^[\p{L}_][\p{L}\p{N}_]*$/u;
  if (!seg.test(typePart) || !seg.test(namePart)) {
    return 'type and name must be non-empty identifiers';
  }
  return null;
}

export type SubsystemCompositionReconcileRejected = { ref: string; reason: string };

/**
 * Merge add/remove operations on subsystem `Content` refs with syntax validation (B.3).
 * Invalid additions are not applied and listed in `rejected`. Duplicates in `add` are ignored.
 * Removes match trimmed names; missing refs are a no-op.
 */
export function reconcileSubsystemCompositionRefs(
  current: string[],
  options: { add?: string[]; remove?: string[] }
): { refs: string[]; rejected: SubsystemCompositionReconcileRejected[] } {
  const rejected: SubsystemCompositionReconcileRejected[] = [];
  const normalized = current.map((r) => (typeof r === 'string' ? r.trim() : '')).filter(Boolean);
  const seen = new Set(normalized);
  const out = [...normalized];
  for (const raw of options.add ?? []) {
    const ref = typeof raw === 'string' ? raw.trim() : '';
    const err = validateSubsystemCompositionRef(ref);
    if (err) {
      rejected.push({ ref: String(raw), reason: err });
      continue;
    }
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    out.push(ref);
  }
  const removeSet = new Set(
    (options.remove ?? [])
      .map((r) => (typeof r === 'string' ? r.trim() : ''))
      .filter(Boolean)
  );
  const refs = out.filter((r) => !removeSet.has(r));
  return { refs, rejected };
}

/**
 * Parsed `Properties.Content` shape for Designer XML (`xr:Item` list), compatible with
 * {@link extractSubsystemCompositionRefs} and typical fast-xml-parser / XMLBuilder round-trip.
 */
export function buildSubsystemCompositionContentNode(refs: string[]): Record<string, unknown> {
  const items = refs.map((r) => ({ '#text': r }));
  if (items.length === 0) {
    return {};
  }
  return { 'xr:Item': items };
}

/**
 * Flatten attribute properties from XML structure (Attribute.Properties).
 */
export function flattenAttributeProperties(attr: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (!attr || typeof attr !== 'object') {
    return properties;
  }
  if (attr.uuid) {
    properties.uuid = attr.uuid;
  }
  if (attr.Properties && typeof attr.Properties === 'object') {
    const props = attr.Properties as Record<string, unknown>;
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith('@_') || key.startsWith('#')) {
        continue;
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        properties[key] = value;
      } else if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if (obj['v8:item']) {
          const items = obj['v8:item'];
          if (Array.isArray(items) && items.length > 0) {
            const firstItem = items[0];
            if (firstItem && typeof firstItem === 'object' && 'v8:content' in firstItem) {
              properties[key] = (firstItem as Record<string, unknown>)['v8:content'];
            }
          }
        } else if ('v8:Type' in obj) {
          properties[key] = obj;
        } else {
          properties[key] = value;
        }
      }
    }
  }
  return convertStringBooleans(properties);
}
