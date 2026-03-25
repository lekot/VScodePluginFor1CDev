import { TOP_LEVEL_TYPES } from './xmlChildObjectsService';

/** Properties that may store a reference like `Catalog.MyCat.Form.MyForm`. */
const DEFAULT_FORM_REF_PROPERTY_KEYS = [
  'DefaultObjectForm',
  'DefaultFolderForm',
  'DefaultListForm',
  'DefaultChoiceForm',
  'DefaultFolderChoiceForm',
  'AuxiliaryObjectForm',
  'AuxiliaryFolderForm',
  'AuxiliaryListForm',
  'AuxiliaryChoiceForm',
  'AuxiliaryFolderChoiceForm',
] as const;

function extractScalarXmlText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && '#text' in value) {
    return String((value as Record<string, unknown>)['#text']);
  }
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === 'string') {
      return first;
    }
    if (first && typeof first === 'object' && '#text' in first) {
      return String((first as Record<string, unknown>)['#text']);
    }
  }
  return '';
}

function formNamesFromChildObjectsFormField(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') {
    return [];
  }
  if (typeof raw === 'string') {
    return [raw];
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && '#text' in raw) {
    return [String((raw as Record<string, unknown>)['#text'])];
  }
  if (Array.isArray(raw)) {
    const res: string[] = [];
    for (const x of raw) {
      if (typeof x === 'string') {
        res.push(x);
      } else if (x && typeof x === 'object' && '#text' in x) {
        res.push(String((x as Record<string, unknown>)['#text']));
      }
    }
    return res;
  }
  return [];
}

function appendFormToChildObjectsInner(
  innerObj: Record<string, unknown>,
  formName: string
): { inner: Record<string, unknown>; changed: boolean } {
  const names = formNamesFromChildObjectsFormField(innerObj.Form);
  if (names.includes(formName)) {
    return { inner: innerObj, changed: false };
  }
  const next = { ...innerObj };
  names.push(formName);
  next.Form = names.length === 1 ? names[0] : names;
  return { inner: next, changed: true };
}

function stripFormEntryFromChildObjectsInner(
  innerObj: Record<string, unknown>,
  formName: string
): { inner: Record<string, unknown>; changed: boolean } {
  if (!('Form' in innerObj)) {
    return { inner: innerObj, changed: false };
  }
  const names = formNamesFromChildObjectsFormField(innerObj.Form);
  const filtered = names.filter((n) => n !== formName);
  if (filtered.length === names.length) {
    return { inner: innerObj, changed: false };
  }
  const next = { ...innerObj };
  if (filtered.length === 0) {
    delete next.Form;
  } else if (filtered.length === 1) {
    next.Form = filtered[0];
  } else {
    next.Form = filtered;
  }
  return { inner: next, changed: true };
}

/** Merge array-shaped `ChildObjects` (legacy) into a single record of tag → values. */
function childObjectsArrayToRecord(childObjects: unknown[]): Record<string, unknown> {
  const innerObj: Record<string, unknown> = {};
  for (const item of childObjects) {
    if (item && typeof item === 'object') {
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (!innerObj[k]) {
          innerObj[k] = [];
        }
        (innerObj[k] as unknown[]).push(v);
      }
    }
  }
  return innerObj;
}

/** Normal object or array `ChildObjects` → inner record used for `Form` / other keys. */
function normalizeOwnerChildObjectsRecord(elemObj: Record<string, unknown>): Record<string, unknown> {
  if (!('ChildObjects' in elemObj) || elemObj.ChildObjects === '' || elemObj.ChildObjects === undefined) {
    return {};
  }
  const co = elemObj.ChildObjects;
  if (Array.isArray(co)) {
    return childObjectsArrayToRecord(co);
  }
  if (typeof co === 'object') {
    return { ...(co as Record<string, unknown>) };
  }
  return {};
}

/**
 * Clears Default* / Auxiliary* form ref properties when the stored path ends with `.Form.<formName>`
 * (suffix match — same rule as pre-refactor `XMLWriter`; not full string equality).
 */
function clearDefaultFormPropertyRefs(
  properties: unknown,
  formName: string,
  state: { changed: boolean }
): unknown {
  const suffix = `.Form.${formName}`;
  const clearObj = (o: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...o };
    for (const key of DEFAULT_FORM_REF_PROPERTY_KEYS) {
      if (!(key in out)) {
        continue;
      }
      const text = extractScalarXmlText(out[key]);
      if (text && text.endsWith(suffix)) {
        out[key] = '';
        state.changed = true;
      }
    }
    return out;
  };
  if (!properties || typeof properties !== 'object') {
    return properties;
  }
  if (Array.isArray(properties)) {
    return properties.map((p) =>
      p && typeof p === 'object' ? clearObj(p as Record<string, unknown>) : p
    );
  }
  return clearObj(properties as Record<string, unknown>);
}

/**
 * Adds `<Form>formName</Form>` to the owner metadata object's ChildObjects (Designer layout).
 * Mutates `state.changed` when ChildObjects are updated.
 */
export function addDesignerFormReferenceInParsed(
  parsed: unknown,
  formName: string,
  state: { changed: boolean }
): unknown {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }
  if (Array.isArray(parsed)) {
    return parsed.map((item) => addDesignerFormReferenceInParsed(item, formName, state));
  }
  const obj = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = { ...obj };

  for (const typeName of TOP_LEVEL_TYPES) {
    if (typeName in obj) {
      const elementContent = obj[typeName as string];
      if (elementContent && typeof elementContent === 'object' && !Array.isArray(elementContent)) {
        const elemObj = elementContent as Record<string, unknown>;
        const next: Record<string, unknown> = { ...elemObj };
        const innerObj = normalizeOwnerChildObjectsRecord(elemObj);
        const { inner, changed } = appendFormToChildObjectsInner(innerObj, formName);
        if (changed) {
          state.changed = true;
        }
        next.ChildObjects = inner;
        result[typeName as string] = next;
        return result;
      }
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      result[key] = value.map((v) => addDesignerFormReferenceInParsed(v, formName, state));
    } else if (value && typeof value === 'object') {
      result[key] = addDesignerFormReferenceInParsed(value, formName, state);
    }
  }
  return result;
}

/**
 * Removes the form from ChildObjects and clears Default*Form / Auxiliary*Form properties
 * whose value ends with `.Form.<formName>`. Mutates `state.changed` when anything is updated.
 */
export function removeDesignerFormFromOwnerInParsed(
  parsed: unknown,
  formName: string,
  state: { changed: boolean }
): unknown {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }
  if (Array.isArray(parsed)) {
    return parsed.map((item) => removeDesignerFormFromOwnerInParsed(item, formName, state));
  }
  const obj = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = { ...obj };

  for (const typeName of TOP_LEVEL_TYPES) {
    if (typeName in obj) {
      const elementContent = obj[typeName as string];
      if (elementContent && typeof elementContent === 'object' && !Array.isArray(elementContent)) {
        const elemObj = elementContent as Record<string, unknown>;
        const next: Record<string, unknown> = { ...elemObj };

        if ('Properties' in elemObj) {
          next.Properties = clearDefaultFormPropertyRefs(elemObj.Properties, formName, state);
        }

        if ('ChildObjects' in elemObj && elemObj.ChildObjects !== '' && elemObj.ChildObjects !== undefined) {
          const innerObj = normalizeOwnerChildObjectsRecord(elemObj);
          const { inner, changed } = stripFormEntryFromChildObjectsInner(innerObj, formName);
          if (changed) {
            state.changed = true;
          }
          next.ChildObjects = inner;
        }

        result[typeName as string] = next;
        return result;
      }
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      result[key] = value.map((v) => removeDesignerFormFromOwnerInParsed(v, formName, state));
    } else if (value && typeof value === 'object') {
      result[key] = removeDesignerFormFromOwnerInParsed(value, formName, state);
    }
  }
  return result;
}
