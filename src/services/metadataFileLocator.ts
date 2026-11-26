/**
 * Metadata path mapping with filesystem-aware root selection for editor and workspace paths.
 * The shared metadata grammar is path-based; manifest callers can use the pure within-root entry point.
 */

import * as path from 'path';
import { canonicalizeFsPath, isSamePath, isSameOrDescendantPath } from '../utils/configurationPathIdentity';
import { getStandardModuleByFileName, type StandardModuleKind } from '../constants/metadataModuleDescriptors';
import { METADATA_TYPE_DESCRIPTORS } from '../constants/metadataTypeDescriptors';

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
const TOP_LEVEL_TYPE_FOLDERS: ReadonlySet<string> = new Set(
  METADATA_TYPE_DESCRIPTORS
    .filter((item) => item.moduleCapabilities.includes('debug-path'))
    .map((item) => item.designerFolder)
);

const FLAT_XML_TYPE_FOLDERS: ReadonlySet<string> = new Set(
  METADATA_TYPE_DESCRIPTORS
    .filter((item) =>
      !item.moduleCapabilities.includes('debug-path') && item.designerFolder !== 'Subsystems'
    )
    .map((item) => item.designerFolder)
);

// All supported object types — hierarchical (from moduleIdResolver) + flat XML + Subsystems (dedicated branch)
const ALL_SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  ...METADATA_TYPE_DESCRIPTORS.map((item) => item.designerFolder),
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
  let bestRel: string | undefined;
  let bestCanonicalRoot: string | undefined;
  let bestCanonicalRel: string | undefined;

  for (const root of configRoots) {
    const normalizedRoot = path.normalize(root);
    const canonicalRoot = canonicalizeFsPath(normalizedRoot);
    const canonicalFile = canonicalizeFsPath(normalizedFile);
    let rel = path.relative(normalizedRoot, normalizedFile);
    const canonicalRel = path.relative(canonicalRoot, canonicalFile);

    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      if (!canonicalRel.startsWith('..') && !path.isAbsolute(canonicalRel)) {
        rel = canonicalRel;
      }
    }
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      continue;
    }

    let isBetter = false;
    if (bestRoot === undefined || bestCanonicalRoot === undefined || bestCanonicalRel === undefined) {
      isBetter = true;
    } else if (isSameOrDescendantPath(bestCanonicalRoot, canonicalRoot) && !isSamePath(bestCanonicalRoot, canonicalRoot)) {
      // canonicalRoot is strictly deeper in the filesystem hierarchy
      isBetter = true;
    } else if (isSameOrDescendantPath(canonicalRoot, bestCanonicalRoot) && !isSamePath(canonicalRoot, bestCanonicalRoot)) {
      // bestCanonicalRoot is strictly deeper in the filesystem hierarchy
      isBetter = false;
    } else {
      const candidateSegments = canonicalRel.split(path.sep).filter(Boolean).length;
      const bestSegments = bestCanonicalRel.split(path.sep).filter(Boolean).length;
      if (candidateSegments < bestSegments) {
        isBetter = true;
      } else if (candidateSegments === bestSegments && canonicalRel.length < bestCanonicalRel.length) {
        isBetter = true;
      }
    }

    if (isBetter) {
      bestRoot = root;
      bestRel = rel;
      bestCanonicalRoot = canonicalRoot;
      bestCanonicalRel = canonicalRel;
    }
  }


  if (bestRoot === undefined || bestRel === undefined) {
    return null;
  }

  return parseMetadataLocation(bestRoot, bestRel);
}

/**
 * Locate a metadata file beneath one known root using lexical paths only.
 * The file and root must use the same path spelling; aliases and root selection are not resolved here.
 */
export function locateMetadataFileWithinRoot(
  filePath: string,
  configRoot: string
): MetadataLocation | null {
  const normalizedRoot = path.normalize(configRoot);
  const normalizedFile = path.normalize(filePath);
  const relativePath = path.relative(normalizedRoot, normalizedFile);
  if (relativePath.length === 0 || isOutsideRootRelativePath(relativePath)) {
    return null;
  }

  return parseMetadataLocation(configRoot, relativePath);
}

function isOutsideRootRelativePath(relativePath: string): boolean {
  return path.isAbsolute(relativePath)
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`);
}

function parseMetadataLocation(configRoot: string, relativePath: string): MetadataLocation | null {
  const normalizedRoot = path.normalize(configRoot);
  let segments = relativePath.split(path.sep);

  let extensionName = getExtensionNameFromRoot(normalizedRoot);

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
    configRoot,
    objectType,
    ...(extensionName !== undefined ? { extensionName } : {}),
  };

  return parseMetadataTypePath(base, objectType, rest);
}

type MetadataLocationBase = Omit<MetadataLocation, 'objectName' | 'subPath' | 'hierarchy'>;

function parseMetadataTypePath(
  base: MetadataLocationBase,
  objectType: string,
  rest: string[]
): MetadataLocation | null {
  switch (objectType) {
    case 'Subsystems':
      return parseSubsystemPath(base, rest);
    case 'CommonModules':
    case 'Constants':
      return parseCommonModuleOrConstantPath(base, rest);
    case 'Roles':
      return parseRolePath(base, rest);
    case 'CommonForms':
      return parseCommonFormPath(base, rest);
    case 'CommonCommands':
      return parseCommonCommandPath(base, rest);
    default:
      return parseHierarchicalOrFlatPath(base, objectType, rest);
  }
}

function parseSubsystemPath(base: MetadataLocationBase, rest: string[]): MetadataLocation | null {
  const hierarchy = parseSubsystemHierarchy(rest);
  if (hierarchy === null) {
    return null;
  }
  return { ...base, objectName: hierarchy[0], hierarchy };
}

function parseCommonModuleOrConstantPath(
  base: MetadataLocationBase,
  rest: string[]
): MetadataLocation | null {
  if (rest.length === 1 && rest[0].toLowerCase().endsWith('.xml')) {
    return parseSingleObjectXml(base, rest);
  }
  if (rest.length === 3 && rest[1] === 'Ext') {
    const subPath = resolveStandardModuleSubPath(base.objectType, rest[2]);
    return subPath ? { ...base, objectName: rest[0], subPath } : null;
  }
  return null;
}

function parseRolePath(base: MetadataLocationBase, rest: string[]): MetadataLocation | null {
  if (rest.length === 1 && rest[0].toLowerCase().endsWith('.xml')) {
    return parseSingleObjectXml(base, rest);
  }
  if (rest.length === 3 && rest[1] === 'Ext' && rest[2] === 'Rights.xml') {
    return { ...base, objectName: rest[0], subPath: { kind: 'rights' } };
  }
  return null;
}

function parseCommonFormPath(base: MetadataLocationBase, rest: string[]): MetadataLocation | null {
  if (rest.length === 1 && rest[0].toLowerCase().endsWith('.xml')) {
    return parseSingleObjectXml(base, rest);
  }
  if (rest.length === 3 && rest[1] === 'Ext' && rest[2] === 'Form.xml') {
    const formName = rest[0];
    return { ...base, objectName: formName, subPath: { kind: 'form', name: formName, subFile: 'container' } };
  }
  if (rest.length === 4 && rest[1] === 'Ext' && rest[2] === 'Form' && rest[3] === 'Module.bsl') {
    const formName = rest[0];
    return { ...base, objectName: formName, subPath: { kind: 'form', name: formName, subFile: 'module' } };
  }
  return null;
}

function parseCommonCommandPath(base: MetadataLocationBase, rest: string[]): MetadataLocation | null {
  if (rest.length === 1 && rest[0].toLowerCase().endsWith('.xml')) {
    return parseSingleObjectXml(base, rest);
  }
  if (rest.length === 3 && rest[1] === 'Ext' && rest[2] === 'CommandModule.bsl') {
    return { ...base, objectName: rest[0], subPath: { kind: 'command', name: rest[0], subFile: 'module' } };
  }
  return null;
}

function parseSingleObjectXml(base: MetadataLocationBase, rest: string[]): MetadataLocation {
  return { ...base, objectName: stripXmlExt(rest[0]) };
}

function parseHierarchicalOrFlatPath(
  base: MetadataLocationBase,
  objectType: string,
  rest: string[]
): MetadataLocation | null {
  if (FLAT_XML_TYPE_FOLDERS.has(objectType) && !TOP_LEVEL_TYPE_FOLDERS.has(objectType)) {
    return rest.length === 1 && rest[0].toLowerCase().endsWith('.xml')
      ? parseSingleObjectXml(base, rest)
      : null;
  }
  return TOP_LEVEL_TYPE_FOLDERS.has(objectType) ? parseHierarchicalObject(base, rest) : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripXmlExt(segment: string): string {
  return path.basename(segment, path.extname(segment));
}

function getExtensionNameFromRoot(normalizedRoot: string): string | undefined {
  const rootSegments = normalizedRoot.split(path.sep).filter((segment) => segment.length > 0);
  const extensionFolderIndex = rootSegments.lastIndexOf('ConfigurationExtensions');
  if (extensionFolderIndex < 0 || extensionFolderIndex + 1 >= rootSegments.length) {
    return undefined;
  }

  return rootSegments[extensionFolderIndex + 1];
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
  const standardModule = resolveStandardModuleSubPath(base.objectType, fileName);
  if (standardModule) {
    return { ...base, objectName, subPath: standardModule };
  }
  if (fileName === 'PredefinedData.xml') {
    return { ...base, objectName, subPath: { kind: 'predefinedData' } };
  }
  return null;
}

function resolveStandardModuleSubPath(
  objectType: string,
  fileName: string
): MetadataFileSubPath | undefined {
  const metadataType = METADATA_TYPE_DESCRIPTORS.find((descriptor) => descriptor.designerFolder === objectType)?.type;
  if (!metadataType) {
    return undefined;
  }
  const descriptor = getStandardModuleByFileName(metadataType, fileName);
  if (!descriptor) {
    return undefined;
  }
  const kind = standardModuleSubPathKind(descriptor.kind);
  return kind ? { kind } : undefined;
}

function standardModuleSubPathKind(
  kind: StandardModuleKind
): Extract<MetadataFileSubPath, { kind: 'objectModule' | 'managerModule' | 'recordSetModule' | 'valueManagerModule' | 'commonModule' }>['kind'] | undefined {
  switch (kind) {
    case 'ObjectModule':
      return 'objectModule';
    case 'ManagerModule':
      return 'managerModule';
    case 'RecordSetModule':
      return 'recordSetModule';
    case 'ValueManagerModule':
      return 'valueManagerModule';
    case 'CommonModule':
      return 'commonModule';
    case 'ManagedApplicationModule':
      return undefined;
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
