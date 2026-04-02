/**
 * xmlChildObjectsService — nested element update/write logic.
 *
 * Add/remove operations live in {@link ./xmlChildObjectsMutations}.
 * Constants and shared types live in {@link ./xmlChildObjectsConstants}.
 *
 * This module re-exports the full public API so all existing imports keep working.
 */

// Re-export constants and types
export {
  TOP_LEVEL_TYPES,
  ROOT_TAGS_WITHOUT_CHILDOBJECTS,
  type WriteNestedElementOptions,
  type NestedAttributeScopeState,
} from './xmlChildObjectsConstants';

// Re-export add/remove + builders
export {
  extractNameFromElementArray,
  extractNameFromNestedElement,
  buildMinimalNestedElement,
  addNestedElementInStructure,
  removeNestedElementInStructure,
} from './xmlChildObjectsMutations';

import { Logger } from '../logger';
import { xmlParser } from './xmlCore';
import { buildXmlString } from './xmlFileIo';
import { type WriteNestedElementOptions, type NestedAttributeScopeState } from './xmlChildObjectsConstants';

// ---------------------------------------------------------------------------
// Internal scope-state helpers
// ---------------------------------------------------------------------------

function buildNestedAttributeScopeState(
  elementType: string,
  options?: WriteNestedElementOptions
): NestedAttributeScopeState | undefined {
  const n = options?.scopedTabularSectionName?.trim();
  if (!n || elementType !== 'Attribute') {
    return undefined;
  }
  return { scopedTabularSectionName: n, insideMatchingTabularSection: false };
}

function matchesTabularSectionXmlKey(key: string): boolean {
  return key === 'TabularSection' || key.endsWith(':TabularSection');
}

function matchesNestedMetadataElementKey(key: string, elementType: string): boolean {
  return key === elementType || key.endsWith(':' + elementType);
}

/**
 * Designer sometimes stores `Attribute` / `TabularSection` directly under a parent object (not only under ChildObjects).
 * Normalize to the wrapped shape expected by {@link updateNestedElementArray}.
 */
function applyDirectNestedElementKeyUpdate(
  key: string,
  value: unknown,
  elementType: string,
  elementName: string,
  properties: Record<string, unknown>,
  changedKeys: string[] | undefined,
  scopeState?: NestedAttributeScopeState
): unknown {
  const wasArray = Array.isArray(value);
  const raw = wasArray ? value : value != null ? [value] : [];
  const elementsArray = raw.map((x: unknown) => ({ [key]: [x] }));
  const updated = updateNestedElementArray(
    elementsArray,
    elementType,
    elementName,
    properties,
    changedKeys,
    scopeState
  );
  const flat = updated.flatMap((it) => ((it as Record<string, unknown>)[key] as unknown[]) || []);
  return wasArray ? flat : flat[0] ?? flat;
}

function isScopedTabularAttributeMode(
  elementType: string,
  scopeState: NestedAttributeScopeState | undefined
): scopeState is NestedAttributeScopeState {
  return elementType === 'Attribute' && scopeState !== undefined;
}

function extractPlainTextFromXmlScalar(val: unknown): string {
  if (typeof val === 'string') {
    return val;
  }
  if (Array.isArray(val) && val.length > 0) {
    const first = val[0];
    if (first && typeof first === 'object' && '#text' in first) {
      return String((first as Record<string, unknown>)['#text']);
    }
  }
  if (val && typeof val === 'object' && '#text' in (val as object)) {
    return String((val as Record<string, unknown>)['#text']);
  }
  return '';
}

function extractNameFromMetadataPropertiesItem(item: unknown): string {
  if (!item || typeof item !== 'object') {
    return '';
  }
  const o = item as Record<string, unknown>;
  const nameKey = 'Name' in o ? 'Name' : Object.keys(o).find((k) => k === 'Name' || k.endsWith(':Name'));
  if (!nameKey) {
    return '';
  }
  return extractPlainTextFromXmlScalar(o[nameKey]);
}

function extractTabularSectionNameFromSectionObject(sectionObj: Record<string, unknown>): string {
  const props = sectionObj.Properties;
  if (props === undefined || props === null) {
    return '';
  }
  if (Array.isArray(props)) {
    for (const p of props) {
      const n = extractNameFromMetadataPropertiesItem(p);
      if (n) {
        return n;
      }
    }
    return '';
  }
  if (typeof props === 'object') {
    return extractNameFromMetadataPropertiesItem(props);
  }
  return '';
}

/** TabularSection node(s) under ChildObjects: parser may use a single object or an array. */
function mapTabularSectionValueForScopedAttribute(
  value: unknown,
  elementType: string,
  elementName: string,
  properties: Record<string, unknown>,
  changedKeys: string[] | undefined,
  scopeState: NestedAttributeScopeState
): unknown {
  if (Array.isArray(value)) {
    return value.map((sectionEl) =>
      updateTabularSectionNodeForScopedAttribute(
        sectionEl,
        elementType,
        elementName,
        properties,
        changedKeys,
        scopeState
      )
    );
  }
  if (value && typeof value === 'object') {
    return updateTabularSectionNodeForScopedAttribute(
      value,
      elementType,
      elementName,
      properties,
      changedKeys,
      scopeState
    );
  }
  return value;
}

/**
 * Apply nested element updates to a ChildObjects value (array or compressed object form from fast-xml-parser).
 */
function updateChildObjectsNestedValue(
  value: unknown,
  elementType: string,
  elementName: string,
  properties: Record<string, unknown>,
  changedKeys: string[] | undefined,
  scopeState?: NestedAttributeScopeState
): unknown {
  const innerHasElementType = (v: Record<string, unknown>) =>
    elementType in v || Object.keys(v).some((k) => k === elementType || k.endsWith(':' + elementType));

  if (Array.isArray(value)) {
    return updateNestedElementArray(
      value,
      elementType,
      elementName,
      properties,
      changedKeys,
      scopeState
    );
  }
  if (value && typeof value === 'object' && innerHasElementType(value as Record<string, unknown>)) {
    const inner = value as Record<string, unknown>;
    const metaKeys = Object.keys(inner).filter((k) => k !== ':@');
    const elementKey =
      elementType in inner
        ? elementType
        : Object.keys(inner).find((k) => k === elementType || k.endsWith(':' + elementType));
    if (!elementKey) {
      return updateNestedElementInStructure(
        value,
        elementType,
        elementName,
        properties,
        changedKeys,
        scopeState
      );
    }
    const onlyThisElementTypeMetadata =
      metaKeys.length === 1 &&
      (metaKeys[0] === elementKey || metaKeys[0].endsWith(':' + elementType));
    if (!onlyThisElementTypeMetadata) {
      return updateNestedElementInStructure(
        value,
        elementType,
        elementName,
        properties,
        changedKeys,
        scopeState
      );
    }
    const raw = inner[elementKey];
    const innerArr = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    const elementsArray = innerArr.map((x: unknown) => ({ [elementKey]: [x] }));
    const updated = updateNestedElementArray(
      elementsArray,
      elementType,
      elementName,
      properties,
      changedKeys,
      scopeState
    );
    return {
      [elementKey]: updated.flatMap((it) => ((it as Record<string, unknown>)[elementKey] as unknown[]) || []),
    };
  }
  if (value !== null && value !== undefined && typeof value === 'object') {
    return updateNestedElementInStructure(
      value,
      elementType,
      elementName,
      properties,
      changedKeys,
      scopeState
    );
  }
  return value;
}

function updateTabularSectionNodeForScopedAttribute(
  sectionEl: unknown,
  elementType: string,
  elementName: string,
  properties: Record<string, unknown>,
  changedKeys: string[] | undefined,
  scopeState: NestedAttributeScopeState
): unknown {
  if (!sectionEl || typeof sectionEl !== 'object') {
    return sectionEl;
  }
  const obj = sectionEl as Record<string, unknown>;
  const sectionName = extractTabularSectionNameFromSectionObject(obj);
  const childMatching = sectionName === scopeState.scopedTabularSectionName;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === ':@') {
      result[key] = value;
      continue;
    }
    if (key === 'ChildObjects' || key.endsWith(':ChildObjects')) {
      const next: NestedAttributeScopeState = {
        ...scopeState,
        insideMatchingTabularSection: childMatching,
      };
      result[key] = updateChildObjectsNestedValue(
        value,
        elementType,
        elementName,
        properties,
        changedKeys,
        next
      );
    } else {
      result[key] = updateNestedElementInStructure(
        value,
        elementType,
        elementName,
        properties,
        changedKeys,
        { ...scopeState, insideMatchingTabularSection: false }
      );
    }
  }
  return result;
}

function updateNestedElementInStructure(
  parsed: unknown,
  elementType: string,
  elementName: string,
  properties: Record<string, unknown>,
  changedKeys?: string[],
  scopeState?: NestedAttributeScopeState
): unknown {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }

  const containerName =
    elementType === 'Attribute' || elementType === 'TabularSection'
      ? 'ChildObjects'
      : elementType + 's';
  const matchesContainer = (k: string) => k === containerName || k.endsWith(':' + containerName);

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

        if (
          matchesTabularSectionXmlKey(key) &&
          isScopedTabularAttributeMode(elementType, scopeState) &&
          value !== null &&
          value !== undefined &&
          (Array.isArray(value) || typeof value === 'object')
        ) {
          result[key] = mapTabularSectionValueForScopedAttribute(
            value,
            elementType,
            elementName,
            properties,
            changedKeys,
            scopeState
          );
          continue;
        }

        if (
          matchesNestedMetadataElementKey(key, elementType) &&
          value !== null &&
          value !== undefined &&
          (Array.isArray(value) || typeof value === 'object')
        ) {
          result[key] = applyDirectNestedElementKeyUpdate(
            key,
            value,
            elementType,
            elementName,
            properties,
            changedKeys,
            scopeState
          );
          continue;
        }

        if (matchesContainer(key)) {
          result[key] = updateChildObjectsNestedValue(
            value,
            elementType,
            elementName,
            properties,
            changedKeys,
            scopeState
          );
        } else if (Array.isArray(value)) {
          result[key] = updateNestedElementInStructure(
            value,
            elementType,
            elementName,
            properties,
            changedKeys,
            scopeState
          );
        } else if (value !== null && value !== undefined && typeof value === 'object') {
          result[key] = updateNestedElementInStructure(
            value,
            elementType,
            elementName,
            properties,
            changedKeys,
            scopeState
          );
        } else {
          result[key] = value;
        }
      }

      return result;
    });
  }

  // Root or nested object: recurse into values to find containerName
  const obj = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === ':@' || (typeof key === 'string' && key.startsWith('?'))) {
      result[key] = value;
      continue;
    }

    if (
      matchesTabularSectionXmlKey(key) &&
      isScopedTabularAttributeMode(elementType, scopeState) &&
      value !== null &&
      value !== undefined &&
      (Array.isArray(value) || typeof value === 'object')
    ) {
      result[key] = mapTabularSectionValueForScopedAttribute(
        value,
        elementType,
        elementName,
        properties,
        changedKeys,
        scopeState
      );
      continue;
    }

    if (
      matchesNestedMetadataElementKey(key, elementType) &&
      value !== null &&
      value !== undefined &&
      (Array.isArray(value) || typeof value === 'object')
    ) {
      result[key] = applyDirectNestedElementKeyUpdate(
        key,
        value,
        elementType,
        elementName,
        properties,
        changedKeys,
        scopeState
      );
      continue;
    }

    if (matchesContainer(key)) {
      result[key] = updateChildObjectsNestedValue(
        value,
        elementType,
        elementName,
        properties,
        changedKeys,
        scopeState
      );
    } else if (value !== null && value !== undefined && typeof value === 'object') {
      result[key] = updateNestedElementInStructure(
        value,
        elementType,
        elementName,
        properties,
        changedKeys,
        scopeState
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function updateNestedElementArray(
  elementsArray: unknown[],
  elementType: string,
  elementName: string,
  properties: Record<string, unknown>,
  changedKeys?: string[],
  scopeState?: NestedAttributeScopeState
): unknown[] {
  const matchesElementType = (k: string) => k === elementType || k.endsWith(':' + elementType);
  return elementsArray.map((item) => {
    if (!item || typeof item !== 'object') {
      return item;
    }

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(item)) {
      if (key === ':@') {
        result[key] = value;
        continue;
      }

      if (
        matchesTabularSectionXmlKey(key) &&
        isScopedTabularAttributeMode(elementType, scopeState) &&
        value !== null &&
        value !== undefined &&
        (Array.isArray(value) || typeof value === 'object')
      ) {
        result[key] = mapTabularSectionValueForScopedAttribute(
          value,
          elementType,
          elementName,
          properties,
          changedKeys,
          scopeState
        );
        continue;
      }

      if (matchesElementType(key) && Array.isArray(value)) {
        const elementData = extractNestedElementData(value);
        if (elementData.name === elementName) {
          if (isScopedTabularAttributeMode(elementType, scopeState) && !scopeState.insideMatchingTabularSection) {
            result[key] = value;
          } else {
            result[key] = updateNestedElementProperties(value, properties, changedKeys);
          }
        } else {
          result[key] = value;
        }
      } else if (typeof key === 'string' && key.startsWith('?')) {
        result[key] = value;
      } else if (value !== null && value !== undefined && typeof value === 'object') {
        result[key] = updateNestedElementInStructure(
          value,
          elementType,
          elementName,
          properties,
          changedKeys,
          scopeState
        );
      } else {
        result[key] = value;
      }
    }

    return result;
  });
}

function extractNestedElementData(elementArray: unknown[]): { name: string } {
  const textFrom = (val: unknown): string => {
    if (typeof val === 'string') {return val;}
    if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object' && '#text' in (val[0] as object)) {
      return String((val[0] as Record<string, unknown>)['#text']);
    }
    if (val && typeof val === 'object' && '#text' in (val as object)) {
      return String((val as Record<string, unknown>)['#text']);
    }
    return '';
  };
  const extractNameFrom = (arr: unknown): string => {
    if (arr && typeof arr === 'object' && !Array.isArray(arr)) {
      const obj = arr as Record<string, unknown>;
      const nameKey = 'Name' in obj ? 'Name' : Object.keys(obj).find((k) => k === 'Name' || k.endsWith(':Name'));
      if (nameKey) {
        const n = textFrom(obj[nameKey]);
        if (n) {return n;}
      }
      if ('Properties' in obj) {
        const inner = extractNameFrom(obj.Properties);
        if (inner) {return inner;}
      }
      return '';
    }
    if (!Array.isArray(arr)) {return '';}
    for (const it of arr) {
      if (!it || typeof it !== 'object') {continue;}
      const o = it as Record<string, unknown>;
      if ('Name' in o && Array.isArray(o.Name)) {
        const nameArr = o.Name as unknown[];
        if (nameArr.length > 0 && nameArr[0] && typeof nameArr[0] === 'object') {
          const nameObj = nameArr[0] as Record<string, unknown>;
          if ('#text' in nameObj) {return String(nameObj['#text']);}
        }
      }
      if ('Properties' in o) {
        const inner = extractNameFrom(o.Properties);
        if (inner) {return inner;}
      }
    }
    return '';
  };
  const name = extractNameFrom(elementArray);
  return { name };
}

/** Extract Type element content from parser output (handles preserveOrder root array) */
function extractTypeContentFromParsed(parsed: unknown): unknown[] | unknown | null {
  if (!parsed || typeof parsed !== 'object') {return null;}
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === 'object' && 'Type' in (item as Record<string, unknown>)) {
        const inner = (item as Record<string, unknown>).Type;
        return inner != null ? inner : null;
      }
    }
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  return 'Type' in obj ? obj.Type ?? null : null;
}

/** Updates Properties when in object form (key -> array or value per property). */
function updateNestedElementPropertiesObject(
  propertiesObj: Record<string, unknown>,
  newProperties: Record<string, unknown>,
  changedKeys?: string[]
): Record<string, unknown> {
  const result = { ...propertiesObj };
  for (const [key, newVal] of Object.entries(newProperties)) {
    // Apply selective write if changedKeys provided and key not in changedKeys
    if (changedKeys && !changedKeys.includes(key)) {
      // Keep existing property as-is; do not write derived/tool properties
      if (!key.startsWith('_')) {
        result[key] = propertiesObj[key];
      }
      continue;
    }

    const existing = result[key];

    // Do not write raw objects; preserve existing structured content for non-user keys
    if (typeof newVal === 'object' && newVal !== null && !Array.isArray(newVal)) {
      // Only overwrite if we have a structured Type object parse from XML
      if (key === 'Type' && !Array.isArray(existing) && existing && typeof existing === 'object') {
        // Keep existing Type object (structured v8:Type/v8:Qualifiers), do not flatten
        result[key] = existing; // already set by spread
      } else {
        result[key] = existing; // keep existing for other object props
      }
      continue;
    }

    // Compute text value for simple props
    const textVal = typeof newVal === 'boolean' || typeof newVal === 'number' ? newVal : String(newVal);

    // Handle Type as structured XML (from type editor)
    if (key === 'Type' && typeof newVal === 'string' && newVal.trim().includes('<')) {
      try {
        const typeParsed = xmlParser.parse(newVal.trim());
        const inner = extractTypeContentFromParsed(typeParsed);
        result[key] = inner != null ? (Array.isArray(inner) ? inner : [inner]) : [{ '#text': newVal }];
      } catch {
        // On parse error, write as text node only if not already structured
        if (!Array.isArray(existing)) {
          result[key] = [{ '#text': newVal }];
        } else {
          result[key] = existing;
        }
      }
    } else if (Array.isArray(existing) && existing.length > 0) {
      // Update existing array-form props
      const first = existing[0];
      if (first && typeof first === 'object' && '#text' in first) {
        result[key] = [{ ...first, '#text': textVal }];
      } else {
        const arr: unknown[] = Array.isArray(existing) ? [...existing] : [];
        if (arr.length === 0) {arr.push({});}
        const base = arr[0] && typeof arr[0] === 'object' ? (arr[0] as Record<string, unknown>) : {};
        result[key] = [{ ...base, '#text': textVal }];
      }
    } else if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      const rec = existing as Record<string, unknown>;
      if ('#text' in rec) {
        result[key] = { ...rec, '#text': textVal };
      } else {
        result[key] = [{ '#text': textVal }];
      }
    } else {
      result[key] = [{ '#text': textVal }];
    }
  }
  return result;
}

function updateNestedElementProperties(
  elementArray: unknown[],
  properties: Record<string, unknown>,
  changedKeys?: string[]
): unknown[] {
  // если changedKeys не передан, по умолчанию обновлять все пропсы из properties
  const targets = changedKeys && changedKeys.length ? changedKeys : Object.keys(properties || {});
  return elementArray.map((item) => {
    if (!item || typeof item !== 'object') {
      return item;
    }

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(item)) {
      if (key === ':@') {
        result[key] = value;
        continue;
      }

      // Designer format: Attribute props (Type, Name, etc.) live inside Properties
      if (key === 'Properties') {
        const val = value;
        if (Array.isArray(val)) {
          result[key] = updateNestedElementProperties(val, properties, changedKeys);
        } else if (val && typeof val === 'object') {
          result[key] = updateNestedElementPropertiesObject(val as Record<string, unknown>, properties, changedKeys);
        } else {
          result[key] = val;
        }
        continue;
      }

      // Обновляем только если ключ в списке целевых ключей для selective write
      const shouldUpdateThisKey = targets.includes(key);

      if (shouldUpdateThisKey) {
        const newValue = properties[key];
        const textValue = typeof newValue === 'boolean' || typeof newValue === 'number'
          ? newValue
          : String(newValue ?? '');

        // Keep raw object references as-is (except for Type structured handling below)
        if (typeof newValue === 'object' && newValue !== null && !Array.isArray(newValue)) {
          if (key === 'Type' && value && typeof value === 'object') {
            // preserve existing structured Type element (v8:Type and qualifiers)
            result[key] = value; // keeps existing child object structure
          } else {
            // skip corruption for other raw object props
            result[key] = value;
          }
          continue;
        }

        // Type from type editor is sent as XML string; write as structured content, not #text
        if (key === 'Type' && typeof newValue === 'string' && newValue.trim().includes('<')) {
          try {
            const typeParsed = xmlParser.parse(newValue.trim());
            const inner = extractTypeContentFromParsed(typeParsed);
            result[key] = inner != null ? (Array.isArray(inner) ? inner : [inner]) : [{ '#text': textValue }];
          } catch (parseErr) {
            Logger.error('Failed to parse Type XML in updateNestedElementProperties', parseErr);
            result[key] = [{ '#text': textValue }];
          }
        } else {
          // Handle flat property updates
          if (Array.isArray(value) && value.length > 0) {
            const firstChild = value[0];
            if (firstChild && typeof firstChild === 'object' && '@_xsi:nil' in firstChild) {
              result[key] = value; // Keep original xsi:nil
            } else if (firstChild && typeof firstChild === 'object' && '#text' in firstChild) {
              result[key] = [{ ...firstChild, '#text': textValue }];
            } else {
              result[key] = [{ '#text': textValue }];
            }
          } else {
            result[key] = [{ '#text': textValue }];
          }
        }
      } else {
        // preserve existing property when not updating
        result[key] = value;
      }
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Public API — buildUpdatedNestedXml
// ---------------------------------------------------------------------------

export function buildUpdatedNestedXml(
  xmlContent: string,
  elementType: string,
  elementName: string,
  properties: Record<string, unknown>,
  changedKeys?: string[],
  options?: WriteNestedElementOptions
): string {
  const parsed = xmlParser.parse(xmlContent);
  const scopeState = buildNestedAttributeScopeState(elementType, options);
  let updated = updateNestedElementInStructure(
    parsed,
    elementType,
    elementName,
    properties,
    changedKeys,
    scopeState
  );
  // Parser may return root as array of one element; builder expects single object
  if (Array.isArray(updated) && updated.length === 1) {
    updated = updated[0];
  }
  return buildXmlString(updated);
}
