import * as fs from 'fs';
import * as path from 'path';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

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

/**
 * Find the Configuration node's content array in the parsed tree (preserveOrder: root is array).
 * Returns the array of Configuration children, or null if not found.
 */
function findConfigurationChildren(parsed: unknown): unknown[] | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const rootArray = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of rootArray) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if ('MetaDataObject' in obj) {
      const metaContent = obj.MetaDataObject;
      if (!Array.isArray(metaContent)) continue;
      for (const metaChild of metaContent) {
        if (!metaChild || typeof metaChild !== 'object') continue;
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
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj['ChildObjects'] !== undefined) {
      const val = obj['ChildObjects'];
      if (Array.isArray(val)) return val;
      return null;
    }
  }
  return null;
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
  const configPath = path.join(configRootPath, 'Configuration.xml');
  let xmlContent: string;
  try {
    xmlContent = await fs.promises.readFile(configPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Configuration.xml not found or unreadable at ${configPath}. ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!xmlContent || !xmlContent.trim()) {
    throw new Error('Configuration.xml is empty or invalid.');
  }
  let parsed: unknown;
  try {
    parsed = parser.parse(xmlContent);
  } catch (parseErr) {
    throw new Error(
      `Configuration.xml parse failed. ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
    );
  }
  const configChildren = findConfigurationChildren(parsed);
  if (!configChildren) {
    throw new Error('Configuration.xml: MetaDataObject/Configuration structure not found.');
  }
  const newEntry: Record<string, unknown> = {
    [rootTag]: [{ '#text': objectName }],
  };
  let childObjectsArray = findChildObjectsArray(configChildren);
  if (childObjectsArray) {
    childObjectsArray.push(newEntry);
  } else {
    // ChildObjects missing: create it and add to Configuration children.
    const newChildObjects = [newEntry];
    configChildren.push({ ChildObjects: newChildObjects });
  }
  let outXml: string;
  try {
    outXml = builder.build(parsed);
  } catch (buildErr) {
    throw new Error(
      `Configuration.xml build failed. ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`
    );
  }
  await fs.promises.writeFile(configPath, outXml, 'utf-8');
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
  const configPath = path.join(configRootPath, 'Configuration.xml');
  let xmlContent: string;
  try {
    xmlContent = await fs.promises.readFile(configPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Configuration.xml not found or unreadable at ${configPath}. ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!xmlContent || !xmlContent.trim()) {
    throw new Error('Configuration.xml is empty or invalid.');
  }
  let parsed: unknown;
  try {
    parsed = parser.parse(xmlContent);
  } catch (parseErr) {
    throw new Error(
      `Configuration.xml parse failed. ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
    );
  }
  const configChildren = findConfigurationChildren(parsed);
  if (!configChildren) {
    throw new Error('Configuration.xml: MetaDataObject/Configuration structure not found.');
  }
  const childObjectsArray = findChildObjectsArray(configChildren);
  if (!childObjectsArray) {
    return; // nothing to remove
  }

  const targetName = objectName.trim();
  let removedAny = false;

  // Удаляем ВСЕ совпадения, т.к. fast-xml-parser может представлять узлы по-разному
  // (массив/объект) и в Configuration.xml могут быть дубликаты.
  for (let i = childObjectsArray.length - 1; i >= 0; i--) {
    const item = childObjectsArray[i];
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (!(rootTag in obj)) continue;

    const tagVal = obj[rootTag];
    const candidates: string[] = [];

    if (Array.isArray(tagVal)) {
      for (const entry of tagVal) {
        if (entry && typeof entry === 'object' && '#text' in (entry as Record<string, unknown>)) {
          candidates.push(String((entry as Record<string, unknown>)['#text']).trim());
        } else if (typeof entry === 'string') {
          candidates.push(entry.trim());
        }
      }
    } else if (tagVal && typeof tagVal === 'object') {
      const rec = tagVal as Record<string, unknown>;
      if ('#text' in rec) {
        candidates.push(String(rec['#text']).trim());
      }
    } else if (typeof tagVal === 'string') {
      candidates.push(tagVal.trim());
    }

    if (candidates.some((c) => c === targetName)) {
      childObjectsArray.splice(i, 1);
      removedAny = true;
    }
  }

  if (!removedAny) {
    return; // entry not found — nothing to remove
  }

  // If ChildObjects is now empty, remove the ChildObjects node entirely
  if (childObjectsArray.length === 0) {
    const coIdx = configChildren.findIndex((item) => {
      if (!item || typeof item !== 'object') return false;
      const obj = item as Record<string, unknown>;
      return 'ChildObjects' in obj;
    });
    if (coIdx !== -1) {
      configChildren.splice(coIdx, 1);
    }
  }

  let outXml: string;
  try {
    outXml = builder.build(parsed);
  } catch (buildErr) {
    throw new Error(
      `Configuration.xml build failed. ${buildErr instanceof Error ? buildErr.message : String(buildErr)}`
    );
  }
  await fs.promises.writeFile(configPath, outXml, 'utf-8');
}
