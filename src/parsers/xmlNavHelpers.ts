/**
 * Shared helpers for navigating fast-xml-parser objects by local name.
 * Used by content file updaters (subsystem, exchange plan, common attribute, functional option).
 */

/** Strip namespace prefix from an XML element key (e.g. "xr:Item" → "Item"). */
export function localName(key: string): string {
  return key.includes(':') ? key.split(':').pop()! : key;
}

/**
 * Find a value in a parsed XML object by its local name, skipping
 * attribute keys (:@, @_, #text, etc.).
 */
export function getValueByLocalName(obj: Record<string, unknown>, name: string): unknown {
  for (const [k, v] of Object.entries(obj)) {
    if (k === ':@' || k === '@_' || k.startsWith('#')) {
      continue;
    }
    if (localName(k) === name) {
      return v;
    }
  }
  return undefined;
}

/**
 * Navigate through a MetaDataObject to reach the Properties of a specific element type.
 * Works for any 1C metadata type: Subsystem, CommonAttribute, FunctionalOption, etc.
 */
export function getPropertiesFromParsed(
  parsed: Record<string, unknown>,
  elementTypeName: string,
): Record<string, unknown> | null {
  const metaRaw = getValueByLocalName(parsed, 'MetaDataObject');
  if (metaRaw === undefined || metaRaw === null) {
    return null;
  }
  const meta = Array.isArray(metaRaw) ? metaRaw[0] : metaRaw;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }
  const elRaw = getValueByLocalName(meta as Record<string, unknown>, elementTypeName);
  if (elRaw === undefined || elRaw === null) {
    return null;
  }
  const elObj = Array.isArray(elRaw) ? elRaw[0] : elRaw;
  if (!elObj || typeof elObj !== 'object' || Array.isArray(elObj)) {
    return null;
  }
  const propsRaw = getValueByLocalName(elObj as Record<string, unknown>, 'Properties');
  if (!propsRaw || typeof propsRaw !== 'object' || Array.isArray(propsRaw)) {
    return null;
  }
  return propsRaw as Record<string, unknown>;
}
