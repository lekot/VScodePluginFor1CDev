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
