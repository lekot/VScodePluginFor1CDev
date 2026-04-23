/**
 * Path scoring for «reveal active file in metadata tree» — which TreeNode best matches a filesystem path.
 */
import * as path from 'path';
import { TreeNode, MetadataType } from '../models/treeNode';
import { getFormPaths } from '../formEditor/formPaths';
import { CONFIGURATION_XML } from '../constants/fileNames';

/** Score boost for an exact file/directory path match in {@link scoreNodeAgainstTarget}. */
export const EXACT_FILE_PATH_SCORE_BASE = 10_000_000;

export function normalizePathForMatch(filePath: string): string {
  return path.resolve(path.normalize(filePath)).toLowerCase();
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => p.length > 0))];
}

/**
 * Collect filesystem paths that identify this node (exact or directory prefix) for the active file.
 */
export function collectNodeIdentityPaths(
  node: TreeNode,
  getConfigPathForNode: (n: TreeNode) => string | null
): string[] {
  const out: string[] = [];
  if (node.filePath?.trim()) {
    out.push(path.resolve(path.normalize(node.filePath.trim())));
  }
  if (node.parentFilePath?.trim()) {
    out.push(path.resolve(path.normalize(node.parentFilePath.trim())));
  }
  if (node.type === MetadataType.Form && node.filePath) {
    try {
      const fp = getFormPaths(node.filePath);
      out.push(
        path.resolve(path.normalize(fp.formDirectory)),
        path.resolve(path.normalize(fp.formXmlPath)),
        path.resolve(path.normalize(fp.modulePath))
      );
    } catch {
      // ignore
    }
  }
  if (node.type === MetadataType.Configuration) {
    const d = getConfigPathForNode(node);
    if (d) {
      out.push(path.resolve(path.normalize(path.join(d, CONFIGURATION_XML))));
    }
  }
  return dedupe(out);
}

function directoryPrefixForUnderMatch(normalizedPath: string): string {
  const n = path.normalize(normalizedPath);
  const ex = path.extname(n);
  if (ex && n.toLowerCase().endsWith(ex.toLowerCase())) {
    return path.resolve(path.dirname(n));
  }
  return path.resolve(n);
}

/**
 * Returns a non-negative score; 0 = no match. Higher = more specific (best node wins).
 */
export function scoreNodeAgainstTarget(
  targetNorm: string,
  node: TreeNode,
  getConfigPathForNode: (n: TreeNode) => string | null
): number {
  const paths = collectNodeIdentityPaths(node, getConfigPathForNode);
  let best = 0;
  for (const p of paths) {
    const n = path.resolve(p).toLowerCase();
    if (targetNorm === n) {
      best = Math.max(best, EXACT_FILE_PATH_SCORE_BASE + n.length);
      continue;
    }
    const base = directoryPrefixForUnderMatch(p).toLowerCase();
    if (base && targetNorm.length > base.length && (targetNorm.startsWith(base + path.sep) || targetNorm.startsWith(`${base}/`))) {
      best = Math.max(best, base.length);
    }
  }
  return best;
}

/** True when the score from {@link scoreNodeAgainstTarget} indicates a full path match (not a directory prefix). */
export function isExactFilePathMatchScore(score: number): boolean {
  return score >= EXACT_FILE_PATH_SCORE_BASE;
}

function getTreeNodeDepthToRoot(n: TreeNode | null | undefined): number {
  let d = 0;
  let p: TreeNode | undefined = n ?? undefined;
  while (p) {
    d += 1;
    p = p.parent;
  }
  return d;
}

/**
 * If scores tie, prefer a more specific node: longer `filePath`, then deeper in the tree, then `id` (stability).
 */
export function compareFileRevealNodes(
  a: TreeNode,
  b: TreeNode,
  targetNorm: string,
  getConfigPathForNode: (n: TreeNode) => string | null
): number {
  const sa = scoreNodeAgainstTarget(targetNorm, a, getConfigPathForNode);
  const sb = scoreNodeAgainstTarget(targetNorm, b, getConfigPathForNode);
  if (sa !== sb) {return sa - sb;}
  if (sa <= 0) {return 0;}
  const al = a.filePath?.length ?? 0;
  const bl = b.filePath?.length ?? 0;
  if (al !== bl) {return al - bl;}
  return getTreeNodeDepthToRoot(a) - getTreeNodeDepthToRoot(b) || a.id.localeCompare(b.id, undefined, { sensitivity: 'base' });
}

/**
 * Top-level metadata directories on disk (1C: EDT/Designer) for «короткий» reveal:
 * `…/Documents/гк_Договор/…` → type folder + object name, without обхода всей конфигурации.
 * Должно пересекаться с `moduleIdResolver` TOP_LEVEL_TYPE_FOLDERS и typeDirName из дерева.
 */
export const REVEAL_METADATA_TYPE_FOLDERS: ReadonlySet<string> = new Set([
  'Catalogs',
  'Documents',
  'DataProcessors',
  'Reports',
  'InformationRegisters',
  'AccumulationRegisters',
  'AccountingRegisters',
  'CalculationRegisters',
  'ChartsOfAccounts',
  'ChartsOfCharacteristicTypes',
  'ChartsOfCalculationTypes',
  'Tasks',
  'BusinessProcesses',
  'Enums',
  'ExchangePlans',
  'DocumentJournals',
  'DocumentNumerators',
  'Sequences',
  'ScheduledJobs',
  'FilterCriteria',
  'SettingsStorages',
  'FunctionalOptions',
  'FunctionalOptionsParameters',
  'Constants',
  'HTTPServices',
  'WebServices',
  'IntegrationServices',
  'CommonModules',
  'Subsystems',
  'CommonAttributes',
  'SessionParameters',
  'Roles',
  'EventSubscriptions',
  'ExternalDataSources',
  'DefinedTypes',
  'CommandGroups',
  'CommonCommands',
  'CommonForms',
  'CommonTemplates',
  'CommonPictures',
  'XDTOPackages',
  'StyleItems',
  'Styles',
  'Languages',
  'WSReferences',
]);

/**
 * From an absolute file path, take the rightmost `…/TypeDir/ObjectName/…` where TypeDir is a
 * known metadata folder (e.g. Documents, Catalogs). Picks the last such pair in the path.
 */
export function parseRevealTypeFolderObjectFromFilePath(absoluteFilePath: string): {
  typeFolder: string;
  objectName: string;
} | null {
  if (!absoluteFilePath?.trim()) {
    return null;
  }
  const resolved = path.resolve(path.normalize(absoluteFilePath));
  const parts = resolved
    .replace(/\\/g, path.sep)
    .split(path.sep)
    .filter((s) => s.length > 0);
  if (parts.length < 2) {
    return null;
  }
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const typeFolder = parts[i] as string;
    if (!REVEAL_METADATA_TYPE_FOLDERS.has(typeFolder)) {
      continue;
    }
    const objectName = parts[i + 1] as string;
    if (objectName.length === 0) {
      continue;
    }
    return {typeFolder, objectName};
  }
  return null;
}
