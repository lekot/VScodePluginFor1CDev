import * as fs from 'fs';
import * as path from 'path';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { AtomicFileStorage, hashContent } from './configurationSession/atomicFileStorage';

// ConfigDumpInfo.xml update deferred (Phase 2); format TBD.

const CONFIGURATION_XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: false,
  preserveOrder: true,
  commentPropName: '#comment',
  cdataTagName: '__cdata',
  processEntities: true,
};

const parser = new XMLParser(CONFIGURATION_XML_OPTIONS);
const builder = new XMLBuilder(CONFIGURATION_XML_OPTIONS);
const mutationTails = new Map<string, Promise<void>>();

export type RootObjectConfigurationMutation =
  | { readonly type: 'add'; readonly rootTag: string; readonly objectName: string }
  | { readonly type: 'remove'; readonly rootTag: string; readonly objectName: string }
  | { readonly type: 'rename'; readonly rootTag: string; readonly objectName: string; readonly newName: string };

/** Pure counterpart used by durable multi-file MutationPlan builders. */
export function buildRootObjectConfigurationContent(
  xmlContent: string,
  mutation: RootObjectConfigurationMutation,
): string {
  if (!xmlContent.trim()) {
    throw new Error('Configuration.xml is empty or invalid.');
  }
  const parsed = parser.parse(xmlContent);
  const configChildren = findConfigurationChildren(parsed);
  if (!configChildren) {
    throw new Error('Configuration.xml: MetaDataObject/Configuration structure not found.');
  }
  const childObjectsArray = findChildObjectsArray(configChildren);
  if (mutation.type === 'add') {
    const newEntry = { [mutation.rootTag]: [{ '#text': mutation.objectName }] };
    if (childObjectsArray) {
      childObjectsArray.push(newEntry);
    } else {
      configChildren.push({ ChildObjects: [newEntry] });
    }
    return buildConfigurationXml(parsed);
  }
  if (!childObjectsArray) {
    if (mutation.type === 'remove') {
      return xmlContent;
    }
    throw new Error(`Configuration.xml: root object ${mutation.rootTag}.${mutation.objectName} is not registered.`);
  }
  if (mutation.type === 'rename') {
    let replacements = 0;
    for (let index = 0; index < childObjectsArray.length; index++) {
      const item = childObjectsArray[index];
      if (!item || typeof item !== 'object') { continue; }
      const entry = item as Record<string, unknown>;
      if (!(mutation.rootTag in entry)) { continue; }
      const result = replaceRootObjectNameInValue(entry[mutation.rootTag], mutation.objectName.trim(), mutation.newName);
      if (result.replacements > 0) {
        childObjectsArray[index] = { ...entry, [mutation.rootTag]: result.value };
        replacements += result.replacements;
      }
    }
    if (replacements === 0) {
      throw new Error(`Configuration.xml: root object ${mutation.rootTag}.${mutation.objectName} is not registered.`);
    }
    return buildConfigurationXml(parsed);
  }
  const targetName = mutation.objectName.trim();
  for (let index = childObjectsArray.length - 1; index >= 0; index--) {
    const item = childObjectsArray[index];
    if (!item || typeof item !== 'object') { continue; }
    const entry = item as Record<string, unknown>;
    if (mutation.rootTag in entry && rootObjectValueContainsName(entry[mutation.rootTag], targetName)) {
      childObjectsArray.splice(index, 1);
    }
  }
  if (childObjectsArray.length === 0) {
    const index = configChildren.findIndex(
      (item) => Boolean(item && typeof item === 'object' && 'ChildObjects' in (item as Record<string, unknown>)),
    );
    if (index !== -1) {
      configChildren.splice(index, 1);
    }
  }
  return buildConfigurationXml(parsed);
}

/**
 * Find the Configuration node's content array in the parsed tree (preserveOrder: root is array).
 * Returns the array of Configuration children, or null if not found.
 */
function findConfigurationChildren(parsed: unknown): unknown[] | null {
  if (!parsed || typeof parsed !== 'object') {return null;}
  const rootArray = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of rootArray) {
    if (!item || typeof item !== 'object') {continue;}
    const obj = item as Record<string, unknown>;
    if ('MetaDataObject' in obj) {
      const metaContent = obj.MetaDataObject;
      if (!Array.isArray(metaContent)) {continue;}
      for (const metaChild of metaContent) {
        if (!metaChild || typeof metaChild !== 'object') {continue;}
        const metaObj = metaChild as Record<string, unknown>;
        if ('Configuration' in metaObj) {
          const configContent = metaObj.Configuration;
          return Array.isArray(configContent) ? configContent : null;
        }
      }
    }
  }
  return null;
}

/**
 * Find the ChildObjects array inside the Configuration children.
 * If missing, returns null (caller will create it).
 */
function findChildObjectsArray(configChildren: unknown[]): unknown[] | null {
  for (const item of configChildren) {
    if (!item || typeof item !== 'object') {continue;}
    const obj = item as Record<string, unknown>;
    if (obj['ChildObjects'] !== undefined) {
      const val = obj['ChildObjects'];
      if (Array.isArray(val)) {return val;}
      return null;
    }
  }
  return null;
}

function replaceRootObjectNameInValue(
  value: unknown,
  oldName: string,
  newName: string
): { value: unknown; replacements: number } {
  if (Array.isArray(value)) {
    let replacements = 0;
    const updated = value.map((entry) => {
      const result = replaceRootObjectNameInValue(entry, oldName, newName);
      replacements += result.replacements;
      return result.value;
    });
    return { value: updated, replacements };
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('#text' in record && String(record['#text']).trim() === oldName) {
      return {
        value: { ...record, '#text': newName },
        replacements: 1,
      };
    }
    return { value, replacements: 0 };
  }

  if (typeof value === 'string' && value.trim() === oldName) {
    return { value: newName, replacements: 1 };
  }

  return { value, replacements: 0 };
}

function rootObjectValueContainsName(value: unknown, objectName: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => rootObjectValueContainsName(entry, objectName));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '#text' in record && String(record['#text']).trim() === objectName;
  }
  return typeof value === 'string' && value.trim() === objectName;
}

/** Read-only preflight for filesystem operations which also mutate Configuration.xml. */
export async function isRootObjectRegisteredInConfiguration(
  configRootPath: string,
  rootTag: string,
  objectName: string
): Promise<boolean> {
  const configPath = path.join(configRootPath, CONFIGURATION_XML);
  const xmlContent = await fs.promises.readFile(configPath, 'utf-8');
  if (!xmlContent.trim()) {
    throw new Error('Configuration.xml is empty or invalid.');
  }
  const parsed = parser.parse(xmlContent);
  const configChildren = findConfigurationChildren(parsed);
  if (!configChildren) {
    throw new Error('Configuration.xml: MetaDataObject/Configuration structure not found.');
  }
  const childObjectsArray = findChildObjectsArray(configChildren);
  if (!childObjectsArray) {
    return false;
  }
  const targetName = objectName.trim();
  return childObjectsArray.some((item) => {
    if (!item || typeof item !== 'object') { return false; }
    const entry = item as Record<string, unknown>;
    return rootTag in entry && rootObjectValueContainsName(entry[rootTag], targetName);
  });
}

/**
 * Add a root metadata object to Configuration.xml's ChildObjects.
 * Reads Configuration.xml from configRootPath, appends <rootTag>objectName</rootTag> to ChildObjects,
 * writes back. If ChildObjects is missing, creates it with the single new element.
 * @param configRootPath - Directory containing Configuration.xml.
 * @param rootTag - E.g. Catalog, Document, Enum.
 * @param objectName - Display name of the object (will be XML-escaped).
 */
export async function addRootObjectToConfiguration(
  configRootPath: string,
  rootTag: string,
  objectName: string
): Promise<void> {
  await mutateConfigurationXml(configRootPath, (parsed) => {
    const configChildren = findConfigurationChildren(parsed);
    if (!configChildren) {
      throw new Error('Configuration.xml: MetaDataObject/Configuration structure not found.');
    }
    const newEntry: Record<string, unknown> = {
      [rootTag]: [{ '#text': objectName }],
    };
    const childObjectsArray = findChildObjectsArray(configChildren);
    if (childObjectsArray) {
      childObjectsArray.push(newEntry);
    } else {
      configChildren.push({ ChildObjects: [newEntry] });
    }
    return buildConfigurationXml(parsed);
  });
}

/**
 * Rename a root metadata object in Configuration.xml without changing the
 * ChildObjects entry tag or its position relative to neighboring entries.
 */
export async function renameRootObjectInConfiguration(
  configRootPath: string,
  rootTag: string,
  oldName: string,
  newName: string
): Promise<void> {
  await mutateConfigurationXml(configRootPath, (parsed) => {
    const configChildren = findConfigurationChildren(parsed);
    if (!configChildren) {
      throw new Error('Configuration.xml: MetaDataObject/Configuration structure not found.');
    }
    const childObjectsArray = findChildObjectsArray(configChildren);
    if (!childObjectsArray) {
      throw new Error(`Configuration.xml: root object ${rootTag}.${oldName} is not registered.`);
    }

    let replacements = 0;
    for (let i = 0; i < childObjectsArray.length; i++) {
      const item = childObjectsArray[i];
      if (!item || typeof item !== 'object') { continue; }
      const entry = item as Record<string, unknown>;
      if (!(rootTag in entry)) { continue; }
      const result = replaceRootObjectNameInValue(entry[rootTag], oldName.trim(), newName);
      if (result.replacements > 0) {
        childObjectsArray[i] = { ...entry, [rootTag]: result.value };
        replacements += result.replacements;
      }
    }
    if (replacements === 0) {
      throw new Error(`Configuration.xml: root object ${rootTag}.${oldName} is not registered.`);
    }
    return buildConfigurationXml(parsed);
  });
}

/**
 * Remove a root metadata object reference from Configuration.xml's ChildObjects.
 * Reads Configuration.xml, finds and removes the <rootTag>objectName</rootTag> entry.
 * @param configRootPath - Directory containing Configuration.xml.
 * @param rootTag - E.g. Catalog, Document, Enum.
 * @param objectName - Display name of the object to remove.
 */
export async function removeRootObjectFromConfiguration(
  configRootPath: string,
  rootTag: string,
  objectName: string
): Promise<void> {
  await mutateConfigurationXml(configRootPath, (parsed) => {
    const configChildren = findConfigurationChildren(parsed);
    if (!configChildren) {
      throw new Error('Configuration.xml: MetaDataObject/Configuration structure not found.');
    }
    const childObjectsArray = findChildObjectsArray(configChildren);
    if (!childObjectsArray) {
      return null;
    }

    const targetName = objectName.trim();
    let removedAny = false;
    for (let i = childObjectsArray.length - 1; i >= 0; i--) {
      const item = childObjectsArray[i];
      if (!item || typeof item !== 'object') {continue;}
      const obj = item as Record<string, unknown>;
      if (!(rootTag in obj)) {continue;}
      if (rootObjectValueContainsName(obj[rootTag], targetName)) {
        childObjectsArray.splice(i, 1);
        removedAny = true;
      }
    }
    if (!removedAny) {
      return null;
    }
    if (childObjectsArray.length === 0) {
      const coIdx = configChildren.findIndex((item) => {
        if (!item || typeof item !== 'object') {return false;}
        return 'ChildObjects' in (item as Record<string, unknown>);
      });
      if (coIdx !== -1) {
        configChildren.splice(coIdx, 1);
      }
    }
    return buildConfigurationXml(parsed);
  });
}

async function mutateConfigurationXml(
  configRootPath: string,
  transform: (parsed: unknown) => string | null,
): Promise<void> {
  const key = await fs.promises.realpath(path.resolve(configRootPath));
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate, () => gate);
  mutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    const configPath = path.join(configRootPath, CONFIGURATION_XML);
    let xmlContent: string;
    try {
      xmlContent = await fs.promises.readFile(configPath, 'utf-8');
    } catch (error) {
      throw new Error(`Configuration.xml not found or unreadable at ${configPath}. ${errorMessage(error)}`);
    }
    if (!xmlContent.trim()) {
      throw new Error('Configuration.xml is empty or invalid.');
    }
    let parsed: unknown;
    try {
      parsed = parser.parse(xmlContent);
    } catch (error) {
      throw new Error(`Configuration.xml parse failed. ${errorMessage(error)}`);
    }
    const nextContent = transform(parsed);
    if (nextContent === null) {
      return;
    }
    const outcome = await new AtomicFileStorage(configRootPath).replace(
      configPath,
      nextContent,
      hashContent(xmlContent),
    );
    if (outcome.status !== 'committed') {
      throw new Error(`Configuration.xml atomic write ${outcome.status}: ${outcome.message}`);
    }
  } finally {
    release();
    if (mutationTails.get(key) === tail) {
      mutationTails.delete(key);
    }
  }
}

function buildConfigurationXml(parsed: unknown): string {
  try {
    return builder.build(parsed);
  } catch (error) {
    throw new Error(`Configuration.xml build failed. ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
