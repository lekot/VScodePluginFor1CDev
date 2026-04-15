import { Logger } from '../logger';
import { TypeParser } from '../../parsers/typeParser';
import { TypeFormatter } from '../typeFormatter';

/**
 * Convert string boolean values to actual boolean primitives.
 */
function convertStringBooleans(properties: Record<string, unknown>): Record<string, unknown> {
  const converted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (value === 'false') {
      converted[key] = false;
    } else if (value === 'true') {
      converted[key] = true;
    } else {
      converted[key] = value;
    }
  }

  return converted;
}

/**
 * Merge v8:Type entries and v8:* qualifiers from parsed Type array items into one object for TypeParser.
 */
function mergeV8TypeQualifiersIntoTypeObject(typeItems: unknown[]): Record<string, unknown> {
  const typeObject: Record<string, unknown> = {};
  const v8Types: unknown[] = [];

  for (const typeItem of typeItems) {
    if (typeItem && typeof typeItem === 'object') {
      for (const [typeKey, typeValue] of Object.entries(typeItem)) {
        if (typeKey === 'v8:Type') {
          if (Array.isArray(typeValue)) {
            v8Types.push(...typeValue);
          } else {
            v8Types.push(typeValue);
          }
        } else if (typeKey.startsWith('v8:')) {
          typeObject[typeKey] = typeValue;
        }
      }
    }
  }

  if (v8Types.length > 0) {
    typeObject['v8:Type'] = v8Types;
  }

  return typeObject;
}

export function extractProperties(parsed: unknown): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  if (!parsed || typeof parsed !== 'object') {
    return properties;
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        for (const [key, value] of Object.entries(item)) {
          if (key === ':@' || key.startsWith('?')) {
            continue;
          }

          if (key === 'Properties' && Array.isArray(value)) {
            const flattened = flattenPropertiesArray(value);
            return convertStringBooleans(postProcessProperties(flattened));
          }

          if (Array.isArray(value)) {
            const nested = extractProperties(value);
            if (Object.keys(nested).length > 0) {
              return nested;
            }
          }
        }
      }
    }
    return properties;
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.Properties && typeof obj.Properties === 'object') {
    const flattened = flattenProperties(obj.Properties as Record<string, unknown>);
    return convertStringBooleans(postProcessProperties(flattened));
  }

  for (const [k, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (k === ':@' || (typeof k === 'string' && k.startsWith('?'))) {
      continue;
    }
    const nested = extractProperties(value);
    if (Object.keys(nested).length > 0) {
      return nested;
    }
  }

  return properties;
}

function postProcessProperties(properties: Record<string, unknown>): Record<string, unknown> {
  if (properties.Type && Array.isArray(properties.Type)) {
    try {
      const typeObject = mergeV8TypeQualifiersIntoTypeObject(properties.Type);

      const typeDef = TypeParser.parseFromObject(typeObject);
      properties.Type = TypeFormatter.formatTypeDisplay(typeDef);
    } catch (error) {
      Logger.error('Failed to format Type property in postProcessProperties', error);
    }
  }

  return properties;
}

function flattenPropertiesArray(propertiesArray: unknown[]): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const item of propertiesArray) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    for (const [key, value] of Object.entries(item)) {
      if (key === ':@') {
        continue;
      }

      if (key === 'Type' && Array.isArray(value) && value.length > 0) {
        try {
          const typeObject = mergeV8TypeQualifiersIntoTypeObject(value);

          const typeDef = TypeParser.parseFromObject(typeObject);
          flattened[key] = TypeFormatter.formatTypeDisplay(typeDef);
        } catch (error) {
          Logger.error('Failed to parse type in xmlPropertiesService.flattenPropertiesArray', error);
          flattened[key] = value;
        }
      } else if (Array.isArray(value) && value.length > 0) {
        const firstChild = value[0];
        if (firstChild && typeof firstChild === 'object' && '#text' in firstChild) {
          const rec = firstChild as Record<string, unknown>;
          flattened[key] = rec['#text'];
        } else {
          flattened[key] = value;
        }
      } else if (key === 'Type' && value && typeof value === 'object' && 'v8:Type' in value) {
        try {
          const typeDef = TypeParser.parseFromObject(value as Record<string, unknown>);
          flattened[key] = TypeFormatter.formatTypeDisplay(typeDef);
        } catch (error) {
          Logger.error('Failed to parse type in xmlPropertiesService.flattenPropertiesArray', error);
          const valueRec = value as Record<string, unknown>;
          const typeValue = valueRec['v8:Type'];
          flattened[key] = Array.isArray(typeValue) ? typeValue[0] : typeValue;
        }
      } else {
        flattened[key] = value;
      }
    }
  }

  return flattened;
}

function flattenProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith('@_') || key.startsWith('#')) {
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if ('#text' in obj) {
        flattened[key] = obj['#text'];
      } else if ('v8:Type' in obj) {
        try {
          const typeDef = TypeParser.parseFromObject(obj);
          flattened[key] = TypeFormatter.formatTypeDisplay(typeDef);
        } catch (error) {
          Logger.error('Failed to parse type in xmlPropertiesService.flattenProperties', error);
          flattened[key] = obj['v8:Type'];
        }
      } else {
        flattened[key] = value;
      }
    } else {
      flattened[key] = value;
    }
  }

  return flattened;
}

export function updatePropertiesInStructure(
  parsed: unknown,
  properties: Record<string, unknown>
): unknown {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }

  if (Array.isArray(parsed)) {
    return parsed.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(item)) {
        if (key === ':@') {
          result[key] = value;
          continue;
        }

        if (key === 'Properties' && Array.isArray(value)) {
          result[key] = updatePropertiesArray(value, properties);
        } else if (key === 'Properties' && value && typeof value === 'object') {
          result[key] = updatePropertiesObject(value as Record<string, unknown>, properties);
        } else if (Array.isArray(value)) {
          result[key] = updatePropertiesInStructure(value, properties);
        } else if (value !== null && value !== undefined && typeof value === 'object') {
          result[key] = updatePropertiesInStructure(value, properties);
        } else {
          result[key] = value;
        }
      }

      return result;
    });
  }

  const obj = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === ':@' || (typeof key === 'string' && key.startsWith('?'))) {
      result[key] = value;
      continue;
    }
    if (key === 'Properties') {
      if (Array.isArray(value)) {
        result[key] = updatePropertiesArray(value, properties);
      } else if (value && typeof value === 'object') {
        result[key] = updatePropertiesObject(value as Record<string, unknown>, properties);
      } else {
        result[key] = value;
      }
    } else if (value !== null && value !== undefined && typeof value === 'object') {
      result[key] = updatePropertiesInStructure(value, properties);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function updatePropertiesObject(
  propertiesObj: Record<string, unknown>,
  newProperties: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...propertiesObj };
  for (const [key, newVal] of Object.entries(newProperties)) {
    const textVal =
      typeof newVal === 'boolean' || typeof newVal === 'number' ? newVal : String(newVal);
    const existing = result[key];
    if (Array.isArray(existing) && existing.length > 0) {
      const first = existing[0];
      if (first && typeof first === 'object' && '#text' in (first as object)) {
        result[key] = [{ ...(first as Record<string, unknown>), '#text': textVal }];
      } else {
        result[key] = [{ '#text': textVal }];
      }
    } else if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      const rec = existing as Record<string, unknown>;
      if ('#text' in rec) {
        result[key] = { ...rec, '#text': textVal };
      } else {
        // Object without #text (e.g. complex Type node like { 'v8:Type': [...] }) — replace with new value
        result[key] = { '#text': textVal };
      }
    } else {
      result[key] = [{ '#text': textVal }];
    }
  }
  return result;
}

function updatePropertiesArray(
  propertiesArray: unknown[],
  properties: Record<string, unknown>
): unknown[] {
  return propertiesArray.map((item) => {
    if (!item || typeof item !== 'object') {
      return item;
    }

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(item)) {
      if (key === ':@') {
        result[key] = value;
        continue;
      }

      if (key in properties) {
        const newValue = properties[key];

        if (Array.isArray(value) && value.length > 0) {
          const firstChild = value[0];
          if (firstChild && typeof firstChild === 'object' && '#text' in firstChild) {
            const textValue =
              typeof newValue === 'boolean' || typeof newValue === 'number'
                ? newValue
                : String(newValue);
            result[key] = [{ ...firstChild, '#text': textValue }];
          } else {
            const textValue =
              typeof newValue === 'boolean' || typeof newValue === 'number'
                ? newValue
                : String(newValue);
            result[key] = [{ '#text': textValue }];
          }
        } else {
          const textValue =
            typeof newValue === 'boolean' || typeof newValue === 'number'
              ? newValue
              : String(newValue);
          result[key] = [{ '#text': textValue }];
        }
      } else {
        result[key] = value;
      }
    }

    return result;
  });
}
