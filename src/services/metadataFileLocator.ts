/**
 * Pure path-based locator: maps an absolute file path to a MetadataLocation descriptor.
 * No file I/O — works entirely with string operations.
 */

import * as path from 'path';
import { TOP_LEVEL_TYPE_FOLDERS } from '../debug/moduleIdResolver';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MetadataFileSubPath =
  | { kind: 'objectModule' }
  | { kind: 'managerModule' }
  | { kind: 'recordSetModule' }
  | { kind: 'commonModule' }
  | { kind: 'valueManagerModule' }
  | { kind: 'form'; name: string; subFile: 'xml' | 'module' | 'container' }
  | { kind: 'command'; name: string; subFile: 'xml' | 'module' }
  | { kind: 'template'; name: string }
  | { kind: 'rights' }
  | { kind: 'predefinedData' };

export interface MetadataLocation {
  configRoot: string;
  objectType: string;
  objectName: string;
  /** Subsystem nesting chain, e.g. ['Sales', 'Orders'] for Subsystems/Sales/Subsystems/Orders.xml */
  hierarchy?: string[];
  subPath?: MetadataFileSubPath;
  extensionName?: string;
}

// ---------------------------------------------------------------------------
// Supported type sets
// ---------------------------------------------------------------------------

/**
 * Types that live as flat XML files with no per-object subdirectory
 * (or with special handling like Roles having Ext/Rights.xml).
 * These are NOT in TOP_LEVEL_TYPE_FOLDERS (which covers only hierarchical objects + CommonModules).
 */
const FLAT_XML_TYPE_FOLDERS = new Set([
  'Roles',
  'Subsystems',
  'XDTOPackages',
  'StyleItems',
  'CommonPictures',
  'CommonAttributes',
  'CommonForms',
  'CommonCommands',
  'CommonTemplates',
  'Languages',
  'SessionParameters',
  'EventSubscriptions',
  // Additional types from MetadataTypeMapper that are parsed as flat XML
  'DefinedTypes',
  'DocumentNumerators',
  'WSReferences',
  'Styles',
  'Interfaces',
  'CommandGroups',
  'FunctionalOptionsParameters',
  'CalculationRegisters',
  'ExternalDataSources',
  'Sequences',
  'FilterCriteria',
]);

// All supported object types — hierarchical (from moduleIdResolver) + flat XML
const ALL_SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  ...TOP_LEVEL_TYPE_FOLDERS,
  ...FLAT_XML_TYPE_FOLDERS,
]);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Locate a metadata file within one of the provided config roots.
 * Returns null when the path is outside all roots or uses an unrecognised type.
 */
export function locateMetadataFile(
  filePath: string,
  configRoots: readonly string[]
): MetadataLocation | null {
  const normalizedFile = path.normalize(filePath);

  // Find the longest matching config root prefix
  let bestRoot: string | undefined;
  for (const root of configRoots) {
    const normalizedRoot = path.normalize(root);
    // path.relative returns a path without leading .. when file is under root
    const rel = path.relative(normalizedRoot, normalizedFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      continue; // not under this root
    }
    if (bestRoot === undefined || normalizedRoot.length > path.normalize(bestRoot).length) {
      bestRoot = root;
    }
  }

  if (bestRoot === undefined) {
    return null;
  }

  const normalizedRoot = path.normalize(bestRoot);
  const relative = path.relative(normalizedRoot, normalizedFile);
  let segments = relative.split(path.sep);

  let extensionName: string | undefined;

  // Strip ConfigurationExtensions/<ExtName>/ prefix
  if (segments[0] === 'ConfigurationExtensions' && segments.length >= 3) {
    extensionName = segments[1];
    segments = segments.slice(2);
  }

  if (segments.length === 0) {
    return null;
  }

  const objectType = segments[0];

  if (!ALL_SUPPORTED_TYPES.has(objectType)) {
    return null;
  }

  const rest = segments.slice(1);

  const base: Omit<MetadataLocation, 'objectName' | 'subPath' | 'hierarchy'> = {
    configRoot: bestRoot,
    objectType,
    ...(extensionName !== undefined ? { extensionName } : {}),
  };

  // --- Subsystems (recursive nesting: Subsystems/A/Subsystems/B/Subsystems/C.xml) ---
  if (objectType === 'Subsystems') {
    const hierarchy = parseSubsystemHierarchy(rest);
    if (hierarchy === null) {
      return null;
    }
    const objectName = hierarchy[0];
    return {
      ...base,
      objectName,
      hierarchy,
    };
  }

  // --- CommonModules ---
  if (objectType === 'CommonModules') {
    // CommonModules/X.xml → object itself
    // CommonModules/X/Ext/Module.bsl → commonModule
    if (rest.length === 1 && rest[0].toLowerCase().endsWith('.xml')) {
      const objectName = stripXmlExt(rest[0]);
      return { ...base, objectName };
    }
    if (rest.length === 3 && rest[1] === 'Ext' && rest[2] === 'Module.bsl') {
      return { ...base, objectName: rest[0], subPath: { kind: 'commonModule' } };
    }
    return null;
  }

  // --- Constants ---
  if (objectType === 'Constants') {
    if (rest.length === 1 && rest[0].toLowerCase().endsWith('.xml')) {
      return { ...base, objectName: stripXmlExt(rest[0]) };
    }
    if (rest.length === 3 && rest[1] === 'Ext' && rest[2] === 'ValueManagerModule.bsl') {
      return { ...base, objectName: rest[0], subPath: { kind: 'valueManagerModule' } };
    }
    return null;
  }

  // --- Roles ---
  if (objectType === 'Roles') {
    if (rest.length === 1 && rest[0].toLowerCase().endsWith('.xml')) {
      return { ...base, objectName: stripXmlExt(rest[0]) };
    }
    // Roles/R/Ext/Rights.xml
    if (rest.length === 3 && rest[1] === 'Ext' && rest[2] === 'Rights.xml') {
      return { ...base, objectName: rest[0], subPath: { kind: 'rights' } };
    }
    return null;
  }

  // --- Flat XML types (single-level: just TypeFolder/Name.xml) ---
  if (FLAT_XML_TYPE_FOLDERS.has(objectType) && objectType !== 'Subsystems' && objectType !== 'Roles') {
    if (rest.length === 1 && rest[0].toLowerCase().endsWith('.xml')) {
      return { ...base, objectName: stripXmlExt(rest[0]) };
    }
    return null;
  }

  // --- Hierarchical objects (Catalogs, Documents, etc.) ---
  if (TOP_LEVEL_TYPE_FOLDERS.has(objectType)) {
    return parseHierarchicalObject(base, rest);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripXmlExt(segment: string): string {
  return segment.slice(0, -4); // removes ".xml"
}

/**
 * Parse Subsystems path segments (after the 'Subsystems' type segment).
 * Valid forms:
 *   A.xml                          → ['A']
 *   A/Subsystems/B.xml             → ['A', 'B']
 *   A/Subsystems/B/Subsystems/C.xml → ['A', 'B', 'C']
 */
function parseSubsystemHierarchy(rest: string[]): string[] | null {
  const hierarchy: string[] = [];

  // First segment: A.xml (root subsystem) or directory A followed by /Subsystems/...
  if (rest.length === 0) {
    return null;
  }

  // Try to consume A.xml at root level
  if (rest.length === 1 && rest[0].toLowerCase().endsWith('.xml')) {
    hierarchy.push(stripXmlExt(rest[0]));
    return hierarchy;
  }

  // Expect alternating pattern: Name / Subsystems / Name / Subsystems / ... / Name.xml
  // Segments: [A, Subsystems, B, Subsystems, C.xml]  (lengths: odd)
  // Or: [A, Subsystems, B.xml] (length 3)
  let i = 0;
  while (i < rest.length) {
    const seg = rest[i];
    if (i === rest.length - 1) {
      // Last segment must be Name.xml
      if (!seg.toLowerCase().endsWith('.xml')) {
        return null;
      }
      hierarchy.push(stripXmlExt(seg));
      i++;
    } else {
      // Not last: must be directory name followed by 'Subsystems'
      hierarchy.push(seg);
      i++;
      if (i >= rest.length || rest[i] !== 'Subsystems') {
        return null;
      }
      i++;
    }
  }

  return hierarchy.length > 0 ? hierarchy : null;
}

function parseHierarchicalObject(
  base: Omit<MetadataLocation, 'objectName' | 'subPath' | 'hierarchy'>,
  rest: string[]
): MetadataLocation | null {
  if (rest.length === 0) {
    return null;
  }

  // TypeFolder/X.xml — flat object XML (no subdirectory)
  if (rest.length === 1 && rest[0].toLowerCase().endsWith('.xml')) {
    return { ...base, objectName: stripXmlExt(rest[0]) };
  }

  // All remaining patterns require at least an object name as first segment
  const objectName = rest[0];
  const sub = rest.slice(1);

  // Catalogs/X/Ext/<module or xml>
  if (sub.length === 2 && sub[0] === 'Ext') {
    return parseExtModule(base, objectName, sub[1]);
  }

  // Catalogs/X/Forms/...
  if (sub.length >= 2 && sub[0] === 'Forms') {
    return parseFormPath(base, objectName, sub.slice(1));
  }

  // Catalogs/X/Commands/...
  if (sub.length >= 2 && sub[0] === 'Commands') {
    return parseCommandPath(base, objectName, sub.slice(1));
  }

  // Catalogs/X/Templates/W.xml
  if (sub.length === 2 && sub[0] === 'Templates' && sub[1].toLowerCase().endsWith('.xml')) {
    const templateName = stripXmlExt(sub[1]);
    return { ...base, objectName, subPath: { kind: 'template', name: templateName } };
  }

  return null;
}

function parseExtModule(
  base: Omit<MetadataLocation, 'objectName' | 'subPath' | 'hierarchy'>,
  objectName: string,
  fileName: string
): MetadataLocation | null {
  switch (fileName) {
    case 'ObjectModule.bsl':
      return { ...base, objectName, subPath: { kind: 'objectModule' } };
    case 'ManagerModule.bsl':
      return { ...base, objectName, subPath: { kind: 'managerModule' } };
    case 'RecordSetModule.bsl':
      return { ...base, objectName, subPath: { kind: 'recordSetModule' } };
    case 'ValueManagerModule.bsl':
      return { ...base, objectName, subPath: { kind: 'valueManagerModule' } };
    case 'PredefinedData.xml':
      return { ...base, objectName, subPath: { kind: 'predefinedData' } };
    default:
      return null;
  }
}

function parseFormPath(
  base: Omit<MetadataLocation, 'objectName' | 'subPath' | 'hierarchy'>,
  objectName: string,
  formRest: string[]
): MetadataLocation | null {
  // Forms/Y.xml — flat form XML
  if (formRest.length === 1 && formRest[0].toLowerCase().endsWith('.xml')) {
    const formName = stripXmlExt(formRest[0]);
    return { ...base, objectName, subPath: { kind: 'form', name: formName, subFile: 'xml' } };
  }

  // Forms/Y/Ext/Form.xml — form container node
  if (
    formRest.length === 3 &&
    formRest[1] === 'Ext' &&
    formRest[2] === 'Form.xml'
  ) {
    const formName = formRest[0];
    return { ...base, objectName, subPath: { kind: 'form', name: formName, subFile: 'container' } };
  }

  // Forms/Y/Ext/Form/Module.bsl — form module
  if (
    formRest.length === 4 &&
    formRest[1] === 'Ext' &&
    formRest[2] === 'Form' &&
    formRest[3] === 'Module.bsl'
  ) {
    const formName = formRest[0];
    return { ...base, objectName, subPath: { kind: 'form', name: formName, subFile: 'module' } };
  }

  return null;
}

function parseCommandPath(
  base: Omit<MetadataLocation, 'objectName' | 'subPath' | 'hierarchy'>,
  objectName: string,
  cmdRest: string[]
): MetadataLocation | null {
  // Commands/Z.xml — flat command XML
  if (cmdRest.length === 1 && cmdRest[0].toLowerCase().endsWith('.xml')) {
    const cmdName = stripXmlExt(cmdRest[0]);
    return { ...base, objectName, subPath: { kind: 'command', name: cmdName, subFile: 'xml' } };
  }

  // Commands/Z/Ext/CommandModule.bsl
  if (
    cmdRest.length === 3 &&
    cmdRest[1] === 'Ext' &&
    cmdRest[2] === 'CommandModule.bsl'
  ) {
    const cmdName = cmdRest[0];
    return { ...base, objectName, subPath: { kind: 'command', name: cmdName, subFile: 'module' } };
  }

  return null;
}
