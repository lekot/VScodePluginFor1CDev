/**
 * moduleIdResolver — maps a BSL file path to an RdbgModuleId.
 * Pure Node.js, no vscode API dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { RdbgModuleId } from './rdbg/rdbgTypes';

export interface ModuleIdResolveResult {
  moduleId: RdbgModuleId;
  /** Human-readable label for debug UI, e.g. "Catalog.Номенклатура.ObjectModule" */
  label: string;
}

// ---------------------------------------------------------------------------
// Type folders that contain top-level metadata objects
// ---------------------------------------------------------------------------
const TOP_LEVEL_TYPE_FOLDERS = new Set([
  'Catalogs',
  'Documents',
  'DataProcessors',
  'Reports',
  'InformationRegisters',
  'AccumulationRegisters',
  'AccountingRegisters',
  'ChartsOfAccounts',
  'ChartsOfCharacteristicTypes',
  'ChartsOfCalculationTypes',
  'Tasks',
  'BusinessProcesses',
  'Enums',
  'ExchangePlans',
  'DocumentJournals',
  'Sequences',
  'ScheduledJobs',
  'FilterCriteria',
  'SettingsStorages',
  'FunctionalOptions',
  'Constants',
  'HTTPServices',
  'WebServices',
  'IntegrationServices',
  'CommonModules',
]);

// ---------------------------------------------------------------------------
// Module type → propertyId (numeric suffix as string)
// ---------------------------------------------------------------------------
type ModuleKind =
  | 'ObjectModule'
  | 'CommonModule'
  | 'FormModule'
  | 'ValueManagerModule'
  | 'CommandModule'
  | 'ManagerModule';

const PROPERTY_ID_MAP: Record<ModuleKind, string> = {
  ObjectModule: '0',
  CommonModule: '0',
  FormModule: '0',
  ValueManagerModule: '0',
  CommandModule: '2',
  // TODO: ManagerModule suffix may differ per metadata type
  //   e.g. ChartOfCharacteristicTypes = 16, but 3 is the common default.
  ManagerModule: '3',
};

// ---------------------------------------------------------------------------
// Parsed BSL path descriptor
// ---------------------------------------------------------------------------
interface BslPathDescriptor {
  /** e.g. "Catalogs" | "CommonModules" | "Constants" … */
  typeFolder: string;
  /** top-level object name */
  objectName: string;
  /** module kind */
  moduleKind: ModuleKind;
  /** form / command name when applicable */
  childName?: string;
  /** Absolute path to the metadata XML file that contains the uuid */
  xmlFilePath: string;
}

// ---------------------------------------------------------------------------
// Path parser
// ---------------------------------------------------------------------------
function parseBslPath(
  bslFilePath: string,
  workspaceRoot: string
): BslPathDescriptor | undefined {
  // Normalise to forward slashes for easier matching; keep original for FS ops.
  const norm = bslFilePath.replace(/\\/g, '/');
  const root = workspaceRoot.replace(/\\/g, '/');

  // Strip workspace root prefix (if present) — we work with relative segments.
  let rel = norm;
  if (norm.startsWith(root + '/')) {
    rel = norm.slice(root.length + 1);
  }

  const parts = rel.split('/');

  // Need at least 3 parts: <TypeFolder>/<ObjectName>/...
  if (parts.length < 3) {
    return undefined;
  }

  const [typeFolder, objectName, ...rest] = parts;

  if (!TOP_LEVEL_TYPE_FOLDERS.has(typeFolder)) {
    return undefined;
  }

  // Helper: absolute xml path
  const xmlAt = (...segments: string[]): string =>
    path.join(workspaceRoot, typeFolder, ...segments);

  // ---- CommonModules/<ModuleName>/Ext/Module.bsl ----
  if (typeFolder === 'CommonModules' && rest.join('/') === 'Ext/Module.bsl') {
    return {
      typeFolder,
      objectName,
      moduleKind: 'CommonModule',
      xmlFilePath: xmlAt(`${objectName}.xml`),
    };
  }

  // ---- Constants/<ConstName>/Ext/ValueManagerModule.bsl ----
  if (typeFolder === 'Constants' && rest.join('/') === 'Ext/ValueManagerModule.bsl') {
    return {
      typeFolder,
      objectName,
      moduleKind: 'ValueManagerModule',
      xmlFilePath: xmlAt(`${objectName}.xml`),
    };
  }

  // ---- <TypeFolder>/<ObjectName>/Forms/<FormName>/Ext/Form/Module.bsl ----
  //  rest = ['Forms', '<FormName>', 'Ext', 'Form', 'Module.bsl']
  if (
    rest.length === 5 &&
    rest[0] === 'Forms' &&
    rest[2] === 'Ext' &&
    rest[3] === 'Form' &&
    rest[4] === 'Module.bsl'
  ) {
    const formName = rest[1];
    return {
      typeFolder,
      objectName,
      moduleKind: 'FormModule',
      childName: formName,
      // UUID is taken from the form's own XML file
      xmlFilePath: xmlAt(objectName, 'Forms', `${formName}.xml`),
    };
  }

  // ---- <TypeFolder>/<ObjectName>/Commands/<CmdName>/Ext/CommandModule.bsl ----
  //  rest = ['Commands', '<CmdName>', 'Ext', 'CommandModule.bsl']
  if (
    rest.length === 4 &&
    rest[0] === 'Commands' &&
    rest[2] === 'Ext' &&
    rest[3] === 'CommandModule.bsl'
  ) {
    const cmdName = rest[1];
    return {
      typeFolder,
      objectName,
      moduleKind: 'CommandModule',
      childName: cmdName,
      // Commands don't have a separate XML with their own UUID;
      // the propertyId is the command's UUID but we fall back to object XML.
      // TODO: check whether RDGB uses command UUID or object UUID for CommandModule
      xmlFilePath: xmlAt(`${objectName}.xml`),
    };
  }

  // ---- <TypeFolder>/<ObjectName>/Ext/ObjectModule.bsl ----
  if (rest.join('/') === 'Ext/ObjectModule.bsl') {
    return {
      typeFolder,
      objectName,
      moduleKind: 'ObjectModule',
      xmlFilePath: xmlAt(`${objectName}.xml`),
    };
  }

  // ---- <TypeFolder>/<ObjectName>/Ext/ManagerModule.bsl ----
  if (rest.join('/') === 'Ext/ManagerModule.bsl') {
    return {
      typeFolder,
      objectName,
      moduleKind: 'ManagerModule',
      xmlFilePath: xmlAt(`${objectName}.xml`),
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// UUID extractor
// ---------------------------------------------------------------------------
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
});

/**
 * Read an XML metadata file and extract the uuid attribute from the first
 * child element of <MetaDataObject> (or from <MetaDataObject> itself if the
 * uuid lives there).
 */
async function readUuidFromXml(xmlFilePath: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await fs.promises.readFile(xmlFilePath, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = xmlParser.parse(content) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  // The structure is:
  //   { MetaDataObject: { Catalog: { '@_uuid': '...' } } }
  // or for forms:
  //   { MetaDataObject: { Form: { '@_uuid': '...' } } }
  const root = parsed['MetaDataObject'];
  if (!root || typeof root !== 'object') {
    return undefined;
  }

  const rootObj = root as Record<string, unknown>;

  // Iterate over child keys to find the metadata object element
  for (const key of Object.keys(rootObj)) {
    if (key.startsWith('@_') || key === '#text') {
      continue;
    }
    const child = rootObj[key];
    if (child && typeof child === 'object') {
      const uuid = (child as Record<string, unknown>)['@_uuid'];
      if (typeof uuid === 'string' && uuid.length > 0) {
        return uuid;
      }
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a BSL file path to an RdbgModuleId.
 * Reads the metadata XML to get the object UUID.
 * Returns undefined if the path cannot be resolved.
 */
export async function resolveModuleId(
  bslFilePath: string,
  workspaceRoot: string
): Promise<ModuleIdResolveResult | undefined> {
  try {
    const descriptor = parseBslPath(bslFilePath, workspaceRoot);
    if (!descriptor) {
      return undefined;
    }

    const objectId = await readUuidFromXml(descriptor.xmlFilePath);
    if (!objectId) {
      return undefined;
    }

    const propertyId = PROPERTY_ID_MAP[descriptor.moduleKind];

    const moduleId: RdbgModuleId = {
      objectId,
      propertyId,
    };

    // Build a human-readable label
    const typeSingular = descriptor.typeFolder.replace(/s$/, ''); // crude singularisation
    let label = `${typeSingular}.${descriptor.objectName}.${descriptor.moduleKind}`;
    if (descriptor.childName) {
      label += `.${descriptor.childName}`;
    }

    return { moduleId, label };
  } catch {
    return undefined;
  }
}
