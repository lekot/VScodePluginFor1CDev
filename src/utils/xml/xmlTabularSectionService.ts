import { MetadataType } from '../../models/treeNode';
import {
  TOP_LEVEL_TYPES,
  buildMinimalNestedElement,
  extractNameFromElementArray,
  extractNameFromNestedElement,
} from './xmlChildObjectsService';
import { generateSimpleUuid } from './xmlHelpers';

/**
 * Dedicated `TabularSections/Name/Name.xml`: unwrap root TabularSection block.
 * Differs from tabular-section name extraction used for scoped nested writes in `xmlChildObjectsService`.
 */
function unwrapSingleTabularSection(mo: Record<string, unknown>): Record<string, unknown> | null {
  const ts = mo.TabularSection;
  if (ts == null) {
    return null;
  }
  if (Array.isArray(ts)) {
    return ts[0] as Record<string, unknown>;
  }
  return ts as Record<string, unknown>;
}

/** Tabular section display name from its Properties (object or array shape). */
function tabularSectionNameFromBlock(ts: Record<string, unknown>): string {
  const props = ts.Properties;
  if (props && !Array.isArray(props) && typeof props === 'object') {
    const n = (props as Record<string, unknown>).Name;
    if (typeof n === 'string') {
      return n;
    }
  }
  if (Array.isArray(props)) {
    const n = extractNameFromElementArray(props as unknown[]);
    if (n) {
      return n;
    }
  }
  return '';
}

function insertAttributeIntoTabularSectionBlock(
  tsElem: Record<string, unknown>,
  attributeInnerContent: unknown
): void {
  const co = tsElem.ChildObjects;
  if (
    co == null ||
    co === '' ||
    (typeof co === 'object' && !Array.isArray(co) && Object.keys(co as object).length === 0)
  ) {
    tsElem.ChildObjects = { Attribute: [attributeInnerContent] };
    return;
  }
  if (typeof co !== 'object' || Array.isArray(co)) {
    tsElem.ChildObjects = { Attribute: [attributeInnerContent] };
    return;
  }
  const childObj = { ...(co as Record<string, unknown>) };
  const existing = childObj.Attribute;
  const arr = Array.isArray(existing) ? [...existing] : existing !== undefined && existing !== null ? [existing] : [];
  arr.push(attributeInnerContent);
  childObj.Attribute = arr;
  tsElem.ChildObjects = childObj;
}

function removeAttributeFromTabularSectionBlock(tsElem: Record<string, unknown>, columnName: string): boolean {
  const co = tsElem.ChildObjects;
  if (!co || typeof co !== 'object' || Array.isArray(co)) {
    return false;
  }
  const childObj = co as Record<string, unknown>;
  if (!('Attribute' in childObj)) {
    return false;
  }
  const inner = childObj.Attribute;
  const items = Array.isArray(inner) ? inner : inner != null ? [inner] : [];
  const filtered = items.filter((item) => extractNameFromNestedElement(item) !== columnName);
  if (filtered.length === items.length) {
    return false;
  }
  const next = { ...childObj };
  if (filtered.length === 0) {
    delete next.Attribute;
  } else {
    next.Attribute = filtered;
  }
  tsElem.ChildObjects = Object.keys(next).length === 0 ? {} : next;
  return true;
}

function getAttributeItemsFromTsBlock(tsElem: Record<string, unknown>): Record<string, unknown>[] {
  const co = tsElem.ChildObjects;
  if (!co || typeof co !== 'object' || Array.isArray(co)) {
    return [];
  }
  const childObj = co as Record<string, unknown>;
  if (!('Attribute' in childObj)) {
    return [];
  }
  const inner = childObj.Attribute;
  const items = Array.isArray(inner) ? inner : inner != null ? [inner] : [];
  return items.filter(
    (x): x is Record<string, unknown> => x != null && typeof x === 'object' && !Array.isArray(x)
  );
}

function findAttributeItemInTsBlock(tsElem: Record<string, unknown>, columnName: string): Record<string, unknown> | null {
  for (const item of getAttributeItemsFromTsBlock(tsElem)) {
    if (extractNameFromNestedElement(item) === columnName) {
      return item;
    }
  }
  return null;
}

function tsBlockHasColumnName(tsElem: Record<string, unknown>, name: string): boolean {
  return getAttributeItemsFromTsBlock(tsElem).some((item) => extractNameFromNestedElement(item) === name);
}

/**
 * If the parsed synonym text still matches the old column name, set it to the new name (Designer-like duplicate).
 * Custom synonyms that differ from the technical name are left unchanged.
 */
function tryAlignSynonymWithNewColumnName(
  props: Record<string, unknown>,
  previousColumnName: string,
  newName: string
): void {
  const syn = props.Synonym;
  if (syn == null) {
    return;
  }
  if (typeof syn === 'string' && syn.trim() === '') {
    return;
  }
  if (!Array.isArray(syn) || syn.length === 0) {
    return;
  }
  const first = syn[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return;
  }
  const v8item = (first as Record<string, unknown>)['v8:item'];
  if (!Array.isArray(v8item) || v8item.length === 0) {
    return;
  }
  const row = v8item[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return;
  }
  const content = (row as Record<string, unknown>)['v8:content'];
  if (!Array.isArray(content) || content.length === 0) {
    return;
  }
  const cell = content[0];
  if (cell && typeof cell === 'object' && !Array.isArray(cell) && '#text' in cell) {
    const cur = String((cell as Record<string, unknown>)['#text'] ?? '');
    if (cur === previousColumnName) {
      (cell as Record<string, unknown>)['#text'] = newName;
    }
  }
}

function cloneTabularColumnAttributeForDuplicate(
  sourceItem: Record<string, unknown>,
  sourceColumnName: string,
  newColumnName: string
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(sourceItem)) as Record<string, unknown>;
  cloned['@_uuid'] = generateSimpleUuid();
  const props = cloned.Properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const po = props as Record<string, unknown>;
    po.Name = [{ '#text': newColumnName }];
    tryAlignSynonymWithNewColumnName(po, sourceColumnName, newColumnName);
  }
  return cloned;
}

function insertDuplicatedTabularColumnIntoBlock(
  tsMut: Record<string, unknown>,
  sourceColumnName: string,
  newColumnName: string
): void {
  const sourceItem = findAttributeItemInTsBlock(tsMut, sourceColumnName);
  if (!sourceItem) {
    throw new Error(`Колонка «${sourceColumnName}» не найдена в табличной части.`);
  }
  if (tsBlockHasColumnName(tsMut, newColumnName)) {
    throw new Error(`Колонка «${newColumnName}» уже существует.`);
  }
  const cloned = cloneTabularColumnAttributeForDuplicate(sourceItem, sourceColumnName, newColumnName);
  insertAttributeIntoTabularSectionBlock(tsMut, cloned);
}

/**
 * Mutates a copy of parsed XML: adds an Attribute column under the tabular section named `tabularSectionName`.
 * Supports dedicated `TabularSection` root files and embedded sections under object `ChildObjects`.
 *
 * @returns Updated parse tree (shallow-cloned path with mutated nested nodes).
 * @throws Error with Russian message if the tabular section is not found.
 */
export function addAttributeToTabularSectionInParsed(
  parsed: unknown,
  tabularSectionName: string,
  columnName: string,
  parentRootType: MetadataType,
  parentObjectName: string
): unknown {
  const newBlock = buildMinimalNestedElement(
    'Attribute',
    columnName,
    {},
    parentRootType,
    parentObjectName
  );
  const unwrapped = (newBlock as Record<string, unknown>).Attribute;

  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }
  const root = { ...(parsed as Record<string, unknown>) };
  const moKey = 'MetaDataObject' in root ? 'MetaDataObject' : null;
  const mo = (moKey ? (root.MetaDataObject as Record<string, unknown>) : root) as Record<string, unknown>;
  if (!mo || typeof mo !== 'object') {
    return parsed;
  }

  const moCopy = { ...mo };
  const dedicatedTs = unwrapSingleTabularSection(moCopy);
  if (dedicatedTs) {
    const tsName = tabularSectionNameFromBlock(dedicatedTs);
    if (!tsName || tsName === tabularSectionName) {
      const tsMut = { ...dedicatedTs };
      insertAttributeIntoTabularSectionBlock(tsMut, unwrapped);
      if (moKey) {
        const inner = {
          ...moCopy,
          TabularSection: Array.isArray(moCopy.TabularSection) ? [tsMut] : tsMut,
        };
        return { ...root, MetaDataObject: inner };
      }
      return { ...root, TabularSection: tsMut };
    }
  }

  for (const typeName of TOP_LEVEL_TYPES) {
    if (!(typeName in moCopy)) {
      continue;
    }
    const elem = moCopy[typeName as string] as Record<string, unknown>;
    if (!elem || typeof elem !== 'object' || Array.isArray(elem)) {
      continue;
    }
    const childObjects = elem.ChildObjects;
    if (!childObjects || typeof childObjects !== 'object' || Array.isArray(childObjects)) {
      continue;
    }
    const co = { ...(childObjects as Record<string, unknown>) };
    if (!co.TabularSection) {
      continue;
    }

    const tsRaw = co.TabularSection;
    const tsList = Array.isArray(tsRaw) ? [...tsRaw] : [tsRaw];
    let hit = false;
    const updated = tsList.map((ts) => {
      if (!ts || typeof ts !== 'object') {
        return ts;
      }
      const tsRec = ts as Record<string, unknown>;
      if (tabularSectionNameFromBlock(tsRec) !== tabularSectionName) {
        return tsRec;
      }
      hit = true;
      const tsMut = { ...tsRec };
      insertAttributeIntoTabularSectionBlock(tsMut, unwrapped);
      return tsMut;
    });
    if (!hit) {
      continue;
    }

    co.TabularSection = updated.length === 1 && !Array.isArray(tsRaw) ? updated[0] : updated;
    const newElem = { ...elem, ChildObjects: co };
    const newMo = { ...moCopy, [typeName as string]: newElem };
    if (moKey) {
      return { ...root, MetaDataObject: newMo };
    }
    return { ...root, ...newMo };
  }

  throw new Error(`Табличная часть «${tabularSectionName}» не найдена в XML.`);
}

/**
 * Deep-clones the source column block (Type, qualifiers, etc.), assigns a new uuid and `newColumnName`.
 * Aligns synonym text with the new name when it still matched the old column name (Designer-like behaviour).
 *
 * @returns Updated parse tree.
 * @throws Error with Russian message if the tabular section is not found, source column is missing,
 *   or `newColumnName` already exists.
 */
export function duplicateAttributeInTabularSectionInParsed(
  parsed: unknown,
  tabularSectionName: string,
  sourceColumnName: string,
  newColumnName: string
): unknown {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }
  const root = { ...(parsed as Record<string, unknown>) };
  const moKey = 'MetaDataObject' in root ? 'MetaDataObject' : null;
  const mo = (moKey ? (root.MetaDataObject as Record<string, unknown>) : root) as Record<string, unknown>;
  if (!mo || typeof mo !== 'object') {
    return parsed;
  }

  const moCopy = { ...mo };
  const dedicatedTs = unwrapSingleTabularSection(moCopy);
  if (dedicatedTs) {
    const tsName = tabularSectionNameFromBlock(dedicatedTs);
    if (!tsName || tsName === tabularSectionName) {
      const tsMut = { ...dedicatedTs };
      insertDuplicatedTabularColumnIntoBlock(tsMut, sourceColumnName, newColumnName);
      if (moKey) {
        const inner = {
          ...moCopy,
          TabularSection: Array.isArray(moCopy.TabularSection) ? [tsMut] : tsMut,
        };
        return { ...root, MetaDataObject: inner };
      }
      return { ...root, TabularSection: tsMut };
    }
  }

  for (const typeName of TOP_LEVEL_TYPES) {
    if (!(typeName in moCopy)) {
      continue;
    }
    const elem = moCopy[typeName as string] as Record<string, unknown>;
    if (!elem || typeof elem !== 'object' || Array.isArray(elem)) {
      continue;
    }
    const childObjects = elem.ChildObjects;
    if (!childObjects || typeof childObjects !== 'object' || Array.isArray(childObjects)) {
      continue;
    }
    const co = { ...(childObjects as Record<string, unknown>) };
    if (!co.TabularSection) {
      continue;
    }

    const tsRaw = co.TabularSection;
    const tsList = Array.isArray(tsRaw) ? [...tsRaw] : [tsRaw];
    let hit = false;
    const updated = tsList.map((ts) => {
      if (!ts || typeof ts !== 'object') {
        return ts;
      }
      const tsRec = ts as Record<string, unknown>;
      if (tabularSectionNameFromBlock(tsRec) !== tabularSectionName) {
        return tsRec;
      }
      hit = true;
      const tsMut = { ...tsRec };
      insertDuplicatedTabularColumnIntoBlock(tsMut, sourceColumnName, newColumnName);
      return tsMut;
    });
    if (!hit) {
      continue;
    }

    co.TabularSection = updated.length === 1 && !Array.isArray(tsRaw) ? updated[0] : updated;
    const newElem = { ...elem, ChildObjects: co };
    const newMo = { ...moCopy, [typeName as string]: newElem };
    if (moKey) {
      return { ...root, MetaDataObject: newMo };
    }
    return { ...root, ...newMo };
  }

  throw new Error(`Табличная часть «${tabularSectionName}» не найдена в XML.`);
}

/**
 * Removes an Attribute column from the tabular section named `tabularSectionName` (dedicated or embedded layout).
 *
 * @returns Updated parse tree.
 * @throws Error with Russian message if the section is not found, or the section is found but the column is not.
 */
export function removeAttributeFromTabularSectionInParsed(
  parsed: unknown,
  tabularSectionName: string,
  columnName: string
): unknown {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }
  const root = { ...(parsed as Record<string, unknown>) };
  const moKey = 'MetaDataObject' in root ? 'MetaDataObject' : null;
  const mo = (moKey ? (root.MetaDataObject as Record<string, unknown>) : root) as Record<string, unknown>;
  if (!mo || typeof mo !== 'object') {
    return parsed;
  }

  const moCopy = { ...mo };
  const dedicatedTs = unwrapSingleTabularSection(moCopy);
  if (dedicatedTs) {
    const tsName = tabularSectionNameFromBlock(dedicatedTs);
    if (!tsName || tsName === tabularSectionName) {
      const tsMut = { ...dedicatedTs };
      const ok = removeAttributeFromTabularSectionBlock(tsMut, columnName);
      if (ok) {
        if (moKey) {
          const inner = {
            ...moCopy,
            TabularSection: Array.isArray(moCopy.TabularSection) ? [tsMut] : tsMut,
          };
          return { ...root, MetaDataObject: inner };
        }
        return { ...root, TabularSection: tsMut };
      }
    }
  }

  for (const typeName of TOP_LEVEL_TYPES) {
    if (!(typeName in moCopy)) {
      continue;
    }
    const elem = moCopy[typeName as string] as Record<string, unknown>;
    if (!elem || typeof elem !== 'object' || Array.isArray(elem)) {
      continue;
    }
    const childObjects = elem.ChildObjects;
    if (!childObjects || typeof childObjects !== 'object' || Array.isArray(childObjects)) {
      continue;
    }
    const co = { ...(childObjects as Record<string, unknown>) };
    if (!co.TabularSection) {
      continue;
    }
    const tsRaw = co.TabularSection;
    const tsList = Array.isArray(tsRaw) ? [...tsRaw] : [tsRaw];
    let hit = false;
    let removed = false;
    const updated = tsList.map((ts) => {
      if (!ts || typeof ts !== 'object') {
        return ts;
      }
      const tsRec = ts as Record<string, unknown>;
      if (tabularSectionNameFromBlock(tsRec) !== tabularSectionName) {
        return tsRec;
      }
      hit = true;
      const tsMut = { ...tsRec };
      if (removeAttributeFromTabularSectionBlock(tsMut, columnName)) {
        removed = true;
      }
      return tsMut;
    });
    if (!hit) {
      continue;
    }
    if (!removed) {
      throw new Error(`Колонка «${columnName}» в табличной части «${tabularSectionName}» не найдена в XML.`);
    }
    co.TabularSection = updated.length === 1 && !Array.isArray(tsRaw) ? updated[0] : updated;
    const newElem = { ...elem, ChildObjects: co };
    const newMo = { ...moCopy, [typeName as string]: newElem };
    if (moKey) {
      return { ...root, MetaDataObject: newMo };
    }
    return { ...root, ...newMo };
  }

  throw new Error(`Колонка «${columnName}» в табличной части «${tabularSectionName}» не найдена в XML.`);
}
