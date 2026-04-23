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
  /** Absolute path to the configuration root in which the file was found */
  configRoot: string;
}

/**
 * Describes one configuration root for reverse BSL path resolution.
 * extensionName is empty string for the main configuration.
 */
export interface ResolverConfigRoot {
  /** Empty string for main configuration; extension name for extension roots. */
  extensionName: string;
  root: string;
}

// ---------------------------------------------------------------------------
// Type folders that contain top-level metadata objects
// ---------------------------------------------------------------------------
export const TOP_LEVEL_TYPE_FOLDERS = new Set([
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
// Module type → propertyId (platform-constant UUID)
// ---------------------------------------------------------------------------
type ModuleKind =
  | 'ObjectModule'
  | 'CommonModule'
  | 'FormModule'
  | 'ValueManagerModule'
  | 'CommandModule'
  | 'ManagerModule'
  | 'RecordSetModule';

/**
 * Platform-constant UUIDs for module propertyId in the RDBG debug protocol.
 * Source: yukon39/bsl-debug-server ModulePropertyId.java (JAXB mapping).
 */
const PROPERTY_ID_MAP: Record<ModuleKind, string> = {
  ObjectModule: 'a637f77f-3840-441d-a1c3-699c8c5cb7e0',
  CommonModule: 'd5963243-262e-4398-b4d7-fb16d06484f6',
  FormModule: '32e087ab-1491-49b6-aba7-43571b41ac2b',
  ValueManagerModule: '3e58c91f-9aaa-4f42-8999-4baf33907b75',
  CommandModule: '078a6af8-d22c-4248-9c33-7e90075a3d2c',
  ManagerModule: 'd1b64a2c-8078-4982-8190-8f81aefda192',
  RecordSetModule: '9f36fd70-4bf4-47f6-b235-935f73aab43f',
};

/** Reverse map: RDBG propertyId → module kind (for stack-frame → file path). */
const PROPERTY_ID_TO_KIND: Record<string, ModuleKind> = Object.fromEntries(
  (Object.keys(PROPERTY_ID_MAP) as ModuleKind[]).map((k) => [PROPERTY_ID_MAP[k], k])
) as Record<string, ModuleKind>;

/**
 * ConfigDumpInfo `Metadata/@name` type prefix → hierarchical dump folder (same as TOP_LEVEL_TYPE_FOLDERS).
 */
const DUMP_TYPE_TO_FOLDER: Record<string, string> = {
  Catalog: 'Catalogs',
  Document: 'Documents',
  DataProcessor: 'DataProcessors',
  Report: 'Reports',
  InformationRegister: 'InformationRegisters',
  AccumulationRegister: 'AccumulationRegisters',
  AccountingRegister: 'AccountingRegisters',
  ChartOfAccounts: 'ChartsOfAccounts',
  ChartOfCharacteristicTypes: 'ChartsOfCharacteristicTypes',
  ChartOfCalculationTypes: 'ChartsOfCalculationTypes',
  Task: 'Tasks',
  BusinessProcess: 'BusinessProcesses',
  Enum: 'Enums',
  ExchangePlan: 'ExchangePlans',
  DocumentJournal: 'DocumentJournals',
  Sequence: 'Sequences',
  ScheduledJob: 'ScheduledJobs',
  FilterCriterion: 'FilterCriteria',
  FilterCriteria: 'FilterCriteria',
  SettingsStorage: 'SettingsStorages',
  FunctionalOption: 'FunctionalOptions',
  Constant: 'Constants',
  HTTPService: 'HTTPServices',
  WebService: 'WebServices',
  IntegrationService: 'IntegrationServices',
  CommonModule: 'CommonModules',
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
 * Attempt to detect configuration root from the BSL file path itself.
 * Looks for a known type folder (Catalogs, Documents, etc.) in the path
 * and returns everything before it as the root.
 */
function detectConfigRoot(bslFilePath: string): string | undefined {
  const norm = bslFilePath.replace(/\\/g, '/');
  for (const folder of TOP_LEVEL_TYPE_FOLDERS) {
    const marker = `/${folder}/`;
    const idx = norm.indexOf(marker);
    if (idx >= 0) {
      return norm.slice(0, idx);
    }
  }
  return undefined;
}

/**
 * Internal implementation — resolves a BSL path against an ordered list of config roots.
 * Returns the first match with configRoot filled in.
 */
async function resolveModuleIdInternal(
  bslFilePath: string,
  configRoots: string[]
): Promise<ModuleIdResolveResult | undefined> {
  try {
    // Try each provided root first
    for (const root of configRoots) {
      const descriptor = parseBslPath(bslFilePath, root);
      if (!descriptor) {
        continue;
      }
      const objectId = await readUuidFromXml(descriptor.xmlFilePath);
      if (!objectId) {
        continue;
      }
      const propertyId = PROPERTY_ID_MAP[descriptor.moduleKind];
      const extensionName = await readExtensionName(root);
      const moduleId: RdbgModuleId = { objectId, propertyId, extensionName };

      const typeSingular = descriptor.typeFolder.replace(/s$/, '');
      let label = `${typeSingular}.${descriptor.objectName}.${descriptor.moduleKind}`;
      if (descriptor.childName) {
        label += `.${descriptor.childName}`;
      }

      return { moduleId, label, configRoot: root };
    }

    // Fallback: auto-detect config root from path structure (e.g. single-root without explicit root)
    const detected = detectConfigRoot(bslFilePath);
    if (detected) {
      const descriptor = parseBslPath(bslFilePath, detected);
      if (descriptor) {
        const objectId = await readUuidFromXml(descriptor.xmlFilePath);
        if (objectId) {
          const propertyId = PROPERTY_ID_MAP[descriptor.moduleKind];
          const extensionName = await readExtensionName(detected);
          const moduleId: RdbgModuleId = { objectId, propertyId, extensionName };

          const typeSingular = descriptor.typeFolder.replace(/s$/, '');
          let label = `${typeSingular}.${descriptor.objectName}.${descriptor.moduleKind}`;
          if (descriptor.childName) {
            label += `.${descriptor.childName}`;
          }
          return { moduleId, label, configRoot: detected };
        }
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a BSL file path to an RdbgModuleId.
 * Overload 1: accepts an array of config roots (multi-root workspace support).
 * Overload 2: accepts a single workspaceRoot string (legacy, backward-compatible).
 */
export function resolveModuleId(sourcePath: string, configRoots: string[]): Promise<ModuleIdResolveResult | undefined>;
export function resolveModuleId(sourcePath: string, workspaceRoot: string): Promise<ModuleIdResolveResult | undefined>;
export function resolveModuleId(
  sourcePath: string,
  configRootsOrSingle: string | string[]
): Promise<ModuleIdResolveResult | undefined> {
  const configRoots = Array.isArray(configRootsOrSingle)
    ? configRootsOrSingle
    : [configRootsOrSingle];
  return resolveModuleIdInternal(sourcePath, configRoots);
}

// ---------------------------------------------------------------------------
// Extension name extraction from Configuration.xml
// ---------------------------------------------------------------------------

const extensionNameCache: Map<string, { mtimeMs: number; name: string }> = new Map();

/** Test hook: clear extension name cache. */
export function clearExtensionNameCache(): void {
  extensionNameCache.clear();
}

/**
 * Read the extension (or configuration) name from a config root's Configuration.xml.
 * Returns the name if this root is an extension (has ObjectBelonging element/property),
 * or empty string if this is a main configuration or the file is absent/unreadable.
 *
 * Caches results by (configRoot + mtime) to avoid repeated file I/O.
 */
export async function readExtensionName(configRoot: string): Promise<string> {
  // Try Configuration.xml at root, then Ext/Configuration.xml
  const candidates = [
    path.join(configRoot, 'Configuration.xml'),
    path.join(configRoot, 'Ext', 'Configuration.xml'),
  ];

  let xmlFilePath: string | undefined;
  let mtimeMs = 0;

  for (const candidate of candidates) {
    try {
      const st = await fs.promises.stat(candidate);
      xmlFilePath = candidate;
      mtimeMs = st.mtimeMs;
      break;
    } catch {
      // try next
    }
  }

  // No file found — cache as empty and return
  if (!xmlFilePath) {
    extensionNameCache.set(configRoot, { mtimeMs: 0, name: '' });
    return '';
  }

  // Check cache
  const cached = extensionNameCache.get(configRoot);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.name;
  }

  let content: string;
  try {
    content = await fs.promises.readFile(xmlFilePath, 'utf8');
  } catch {
    extensionNameCache.set(configRoot, { mtimeMs, name: '' });
    return '';
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = xmlParser.parse(content) as Record<string, unknown>;
  } catch {
    extensionNameCache.set(configRoot, { mtimeMs, name: '' });
    return '';
  }

  // Structure: { MetaDataObject: { Configuration: { Properties: { Name: '...', ObjectBelonging: 'Adopted' } } } }
  const metaRoot = parsed['MetaDataObject'];
  if (!metaRoot || typeof metaRoot !== 'object') {
    extensionNameCache.set(configRoot, { mtimeMs, name: '' });
    return '';
  }

  const metaRootObj = metaRoot as Record<string, unknown>;
  const configNode = metaRootObj['Configuration'];
  if (!configNode || typeof configNode !== 'object') {
    extensionNameCache.set(configRoot, { mtimeMs, name: '' });
    return '';
  }

  const configObj = configNode as Record<string, unknown>;
  const props = configObj['Properties'];
  if (!props || typeof props !== 'object') {
    extensionNameCache.set(configRoot, { mtimeMs, name: '' });
    return '';
  }

  const propsObj = props as Record<string, unknown>;
  const objectBelonging = propsObj['ObjectBelonging'];
  const name = propsObj['Name'];

  // Only return a name if this is an extension (ObjectBelonging = 'Adopted')
  if (
    typeof objectBelonging === 'string' &&
    objectBelonging.trim() === 'Adopted' &&
    typeof name === 'string' &&
    name.trim().length > 0
  ) {
    const result = name.trim();
    extensionNameCache.set(configRoot, { mtimeMs, name: result });
    return result;
  }

  // Main configuration — return empty string
  extensionNameCache.set(configRoot, { mtimeMs, name: '' });
  return '';
}

// ---------------------------------------------------------------------------
// ConfigDumpInfo → BSL path (reverse of resolveModuleId, for debug stack frames)
// ---------------------------------------------------------------------------

interface DumpMetaEntry {
  name: string;
  id: string;
}

const dumpMetadataCache = new Map<string, { mtimeMs: number; entries: DumpMetaEntry[] }>();

/** Test hook: clear cached ConfigDumpInfo parse results. */
export function clearDumpMetadataCache(): void {
  dumpMetadataCache.clear();
}

function walkDumpMetadataNode(node: unknown, out: DumpMetaEntry[]): void {
  if (node === undefined || node === null) {
    return;
  }
  const arr = Array.isArray(node) ? node : [node];
  for (const el of arr) {
    if (!el || typeof el !== 'object') {
      continue;
    }
    const o = el as Record<string, unknown>;
    const name = o['@_name'];
    const id = o['@_id'];
    if (typeof name === 'string' && typeof id === 'string') {
      out.push({ name, id });
    }
    const nested = o['Metadata'];
    if (nested) {
      walkDumpMetadataNode(nested, out);
    }
  }
}

async function loadConfigDumpMetadataList(configRoot: string): Promise<DumpMetaEntry[] | undefined> {
  const dumpPath = path.join(configRoot, 'ConfigDumpInfo.xml');
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(dumpPath);
  } catch {
    return undefined;
  }
  const cached = dumpMetadataCache.get(configRoot);
  if (cached && cached.mtimeMs === st.mtimeMs) {
    return cached.entries;
  }
  let content: string;
  try {
    content = await fs.promises.readFile(dumpPath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = xmlParser.parse(content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const rootKey =
    parsed['ConfigDumpInfo'] !== undefined
      ? 'ConfigDumpInfo'
      : Object.keys(parsed).find((k) => !k.startsWith('?') && typeof parsed[k] === 'object');
  const root = (rootKey ? (parsed[rootKey] as Record<string, unknown>) : undefined) ?? undefined;
  if (!root || typeof root !== 'object') {
    return undefined;
  }
  const versions = (root as Record<string, unknown>)['ConfigVersions'] as Record<string, unknown> | undefined;
  if (!versions || typeof versions !== 'object') {
    return undefined;
  }
  const topMeta = versions['Metadata'];
  const out: DumpMetaEntry[] = [];
  walkDumpMetadataNode(topMeta, out);
  dumpMetadataCache.set(configRoot, { mtimeMs: st.mtimeMs, entries: out });
  return out;
}

function findParentByName(entries: DumpMetaEntry[], parentName: string): DumpMetaEntry | undefined {
  return entries.find((e) => e.name === parentName);
}

/**
 * Pick ConfigDumpInfo `Metadata/@name` for this RDBG module id + property kind.
 */
function findDumpMetadataName(
  objectId: string,
  kind: ModuleKind,
  entries: DumpMetaEntry[]
): string | undefined {
  if (kind === 'CommonModule') {
    const hit = entries.find((e) => e.name.startsWith('CommonModule.') && e.id === objectId);
    return hit?.name;
  }

  if (kind === 'FormModule') {
    const hit = entries.find((e) => e.id === objectId && /\.Form\./.test(e.name));
    return hit?.name;
  }

  if (kind === 'CommandModule') {
    const byId = entries.find((e) => e.id === objectId && /\.Command\./.test(e.name));
    if (byId) {
      return byId.name;
    }
    for (const e of entries) {
      if (!e.name.includes('.Command.')) {
        continue;
      }
      const parentName = e.name.replace(/\.Command\.[^.]+$/, '');
      const parent = findParentByName(entries, parentName);
      if (parent && parent.id === objectId) {
        return e.name;
      }
    }
    return undefined;
  }

  if (kind === 'ValueManagerModule') {
    const byId = entries.find(
      (e) => e.id === objectId && (e.name.endsWith('.ValueManager') || e.name.includes('.ValueManager.'))
    );
    if (byId) {
      return byId.name;
    }
    for (const e of entries) {
      if (!e.name.endsWith('.ValueManager')) {
        continue;
      }
      const parentName = e.name.slice(0, -'.ValueManager'.length);
      const parent = findParentByName(entries, parentName);
      if (parent && parent.id === objectId) {
        return e.name;
      }
    }
    return undefined;
  }

  const suffix =
    kind === 'ObjectModule'
      ? '.ObjectModule'
      : kind === 'ManagerModule'
        ? '.ManagerModule'
        : kind === 'RecordSetModule'
          ? '.RecordSetModule'
          : '';

  if (!suffix) {
    return undefined;
  }

  for (const e of entries) {
    if (!e.name.endsWith(suffix)) {
      continue;
    }
    const parentName = e.name.slice(0, -suffix.length);
    const parent = findParentByName(entries, parentName);
    if (parent && parent.id === objectId) {
      return e.name;
    }
    if (e.id === objectId || e.id === `${objectId}.0` || e.id.startsWith(`${objectId}.`)) {
      return e.name;
    }
  }
  // Dump may omit `.ManagerModule` / `.ObjectModule` rows; parent object still has catalog UUID.
  const parentOnly = entries.find(
    (e) =>
      e.id === objectId &&
      /^[^.]+\.[^.]+$/u.test(e.name) &&
      !e.name.startsWith('CommonModule.')
  );
  if (parentOnly) {
    return `${parentOnly.name}${suffix}`;
  }
  return undefined;
}

/**
 * Map `Metadata/@name` from ConfigDumpInfo to path under config root (forward slashes).
 */
function metadataDumpNameToRelativeBslPath(metadataName: string, kind: ModuleKind): string | undefined {
  if (kind === 'CommonModule') {
    if (!metadataName.startsWith('CommonModule.')) {
      return undefined;
    }
    const modName = metadataName.slice('CommonModule.'.length);
    if (!modName) {
      return undefined;
    }
    return `CommonModules/${modName}/Ext/Module.bsl`;
  }

  if (kind === 'FormModule') {
    const m = metadataName.match(/^(.+)\.Form\.(.+)$/);
    if (!m) {
      return undefined;
    }
    const prefix = m[1];
    const formName = m[2];
    const dot = prefix.indexOf('.');
    if (dot < 0) {
      return undefined;
    }
    const dumpType = prefix.slice(0, dot);
    const obj = prefix.slice(dot + 1);
    const folder = DUMP_TYPE_TO_FOLDER[dumpType];
    if (!folder) {
      return undefined;
    }
    return `${folder}/${obj}/Forms/${formName}/Ext/Form/Module.bsl`;
  }

  if (kind === 'CommandModule') {
    const m = metadataName.match(/^(.+)\.Command\.(.+)$/);
    if (!m) {
      return undefined;
    }
    const prefix = m[1];
    const cmdName = m[2];
    const dot = prefix.indexOf('.');
    if (dot < 0) {
      return undefined;
    }
    const dumpType = prefix.slice(0, dot);
    const obj = prefix.slice(dot + 1);
    const folder = DUMP_TYPE_TO_FOLDER[dumpType];
    if (!folder) {
      return undefined;
    }
    return `${folder}/${obj}/Commands/${cmdName}/Ext/CommandModule.bsl`;
  }

  if (kind === 'ValueManagerModule') {
    if (!metadataName.endsWith('.ValueManager')) {
      return undefined;
    }
    const body = metadataName.slice(0, -'.ValueManager'.length);
    const dot = body.indexOf('.');
    if (dot < 0) {
      return undefined;
    }
    const dumpType = body.slice(0, dot);
    const obj = body.slice(dot + 1);
    const folder = DUMP_TYPE_TO_FOLDER[dumpType];
    if (!folder) {
      return undefined;
    }
    return `${folder}/${obj}/Ext/ValueManagerModule.bsl`;
  }

  const modSuffix =
    kind === 'ObjectModule'
      ? '.ObjectModule'
      : kind === 'ManagerModule'
        ? '.ManagerModule'
        : kind === 'RecordSetModule'
          ? '.RecordSetModule'
          : '';

  if (!modSuffix || !metadataName.endsWith(modSuffix)) {
    return undefined;
  }
  const body = metadataName.slice(0, -modSuffix.length);
  const dot = body.indexOf('.');
  if (dot < 0) {
    return undefined;
  }
  const dumpType = body.slice(0, dot);
  const obj = body.slice(dot + 1);
  const folder = DUMP_TYPE_TO_FOLDER[dumpType];
  if (!folder) {
    return undefined;
  }

  if (kind === 'ObjectModule') {
    return `${folder}/${obj}/Ext/ObjectModule.bsl`;
  }
  if (kind === 'ManagerModule') {
    return `${folder}/${obj}/Ext/ManagerModule.bsl`;
  }
  if (kind === 'RecordSetModule') {
    return undefined;
  }
  return undefined;
}

/**
 * Internal single-root implementation of resolveBslPathFromRdbgModule.
 */
async function resolveBslPathForRoot(
  moduleId: RdbgModuleId,
  configRoot: string
): Promise<string | undefined> {
  if (!configRoot || !moduleId.objectId || !moduleId.propertyId) {
    return undefined;
  }
  const kind = PROPERTY_ID_TO_KIND[moduleId.propertyId];
  if (!kind) {
    return undefined;
  }
  const entries = await loadConfigDumpMetadataList(configRoot);
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const metadataName = findDumpMetadataName(moduleId.objectId, kind, entries);
  if (!metadataName) {
    return undefined;
  }
  const rel = metadataDumpNameToRelativeBslPath(metadataName, kind);
  if (!rel) {
    return undefined;
  }
  const abs = path.join(configRoot, ...rel.split('/'));
  try {
    await fs.promises.access(abs, fs.constants.R_OK);
    return abs;
  } catch {
    return undefined;
  }
}

/**
 * Internal multi-root implementation — selects root by extensionName match.
 */
async function resolveBslPathInternal(
  moduleId: RdbgModuleId,
  configRoots: ResolverConfigRoot[]
): Promise<string | undefined> {
  const extName = moduleId.extensionName ?? '';

  // Find root whose extensionName matches the module's extensionName
  const matched = configRoots.find((r) => r.extensionName === extName);
  if (matched) {
    return resolveBslPathForRoot(moduleId, matched.root);
  }

  // Fallback: try empty extensionName root (main configuration)
  const mainRoot = configRoots.find((r) => r.extensionName === '');
  if (mainRoot) {
    return resolveBslPathForRoot(moduleId, mainRoot.root);
  }

  // Last resort: try all roots in order
  for (const r of configRoots) {
    const result = await resolveBslPathForRoot(moduleId, r.root);
    if (result) {
      return result;
    }
  }

  return undefined;
}

/**
 * Resolve RDBG {@link RdbgModuleId} to an on-disk `.bsl` path.
 * Overload 1: accepts an array of ResolverConfigRoot (multi-root workspace support).
 * Overload 2: accepts a single configRoot string (legacy, backward-compatible).
 */
export function resolveBslPathFromRdbgModule(moduleId: RdbgModuleId, configRoots: ResolverConfigRoot[]): Promise<string | undefined>;
export function resolveBslPathFromRdbgModule(moduleId: RdbgModuleId, configRoot: string): Promise<string | undefined>;
export function resolveBslPathFromRdbgModule(
  moduleId: RdbgModuleId,
  rootsOrSingle: ResolverConfigRoot[] | string
): Promise<string | undefined> {
  if (Array.isArray(rootsOrSingle)) {
    return resolveBslPathInternal(moduleId, rootsOrSingle);
  }
  return resolveBslPathForRoot(moduleId, rootsOrSingle);
}
