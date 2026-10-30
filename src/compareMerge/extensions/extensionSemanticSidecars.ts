import * as path from 'path';

import type { CompareTreeNode } from '../compareTreeTypes';
import type { ExtensionIndexedObject } from './extensionMetadataIndex';
import type { ExtensionTransferRow } from './extensionTransfer';

export interface AdoptedRoleRightsBlocker {
  readonly targetRelativePath: string;
  readonly sourceRelativePath?: string;
  readonly ambiguous: boolean;
}

export function pairedXmlSidecars(
  target: ExtensionIndexedObject,
  incoming: ExtensionIndexedObject,
): {
  pairs: { kind: 'formXml' | 'predefinedXml' | 'roleRightsXml' | 'dcsXml'; relativePath: string; target: ExtensionIndexedObject['sidecarFiles'][number]; source: ExtensionIndexedObject['sidecarFiles'][number] }[];
  duplicatePaths: string[];
} {
  const targetFiles = xmlSidecarsByOwnerPath(target);
  const sourceFiles = xmlSidecarsByOwnerPath(incoming);
  const pairs: { kind: 'formXml' | 'predefinedXml' | 'roleRightsXml' | 'dcsXml'; relativePath: string; target: ExtensionIndexedObject['sidecarFiles'][number]; source: ExtensionIndexedObject['sidecarFiles'][number] }[] = [];
  for (const [key, targetFile] of targetFiles.files) {
    const sourceFile = sourceFiles.files.get(key);
    if (!sourceFile) {continue;}
    const kind = semanticSidecarKind(targetFile);
    if (!kind || semanticSidecarKind(sourceFile) !== kind) {continue;}
    pairs.push({ kind, relativePath: ownerRelativePath(target, targetFile.relativePath), target: targetFile, source: sourceFile });
  }
  return {
    pairs: pairs.sort((left, right) => left.target.relativePath.toLowerCase().localeCompare(right.target.relativePath.toLowerCase())),
    duplicatePaths: [...targetFiles.duplicatePaths, ...sourceFiles.duplicatePaths],
  };
}

export function hasAdoptedRoleIdentity(row: ExtensionTransferRow): boolean {
  if (row.target?.metadataType !== 'Role' || row.incoming?.metadataType !== 'Role') {return false;}
  return [row.target.identity, row.incoming.identity].some((identity) =>
    identity?.ownership === 'adopted' && Boolean(identity.sourceUuid),
  );
}

export function adoptedRoleRightsBlockers(row: ExtensionTransferRow): AdoptedRoleRightsBlocker[] {
  const target = row.target!;
  const incoming = row.incoming!;
  const baseRoots = [row.targetBase, row.incomingBase].filter((root): root is import('./extensionMetadataIndex').ExtensionMetadataIndex => Boolean(root));
  const adoptedAnchor = [target.identity, incoming.identity]
    .find((identity) => identity?.ownership === 'adopted')?.sourceUuid?.toLowerCase();
  const baseObjects = baseRoots.flatMap((root) => root.objects.filter((object) =>
    object.metadataType === 'Role'
      && object.qualifiedName.normalize('NFC').toLocaleLowerCase('en-US') === row.qualifiedName.normalize('NFC').toLocaleLowerCase('en-US')
      && object.identity?.ownership === 'own'
      && (!adoptedAnchor || object.identity.uuid.toLowerCase() === adoptedAnchor),
  ));
  const targetFiles = roleRightsSidecars(target);
  const sourceFiles = roleRightsSidecars(incoming);
  const baseFiles = baseObjects.flatMap((object) => [...roleRightsSidecars(object)].map(([key, value]) => ({ key, ...value })));
  const keys = new Set([...targetFiles.keys(), ...sourceFiles.keys(), ...baseFiles.map((entry) => entry.key)]);
  const result: AdoptedRoleRightsBlocker[] = [];
  for (const key of keys) {
    const targetFile = targetFiles.get(key);
    const sourceFile = sourceFiles.get(key);
    const baseMatches = baseFiles.filter((entry) => entry.key === key);
    if (!targetFile && !sourceFile && baseMatches.length === 0) {continue;}
    const relative = targetFile?.relative ?? sourceFile?.relative ?? baseMatches[0]!.relative;
    const targetRelativePath = targetFile?.file.relativePath
      ?? path.posix.join((target.sidecarRelativePath ?? '').replace(/\\/gu, '/'), relative);
    result.push({
      targetRelativePath,
      ...(sourceFile ? { sourceRelativePath: sourceFile.file.relativePath } : {}),
      ambiguous: Boolean(targetFile?.duplicate || sourceFile?.duplicate || baseMatches.length > 1),
    });
  }
  return result.sort((left, right) => normalizeArtifactPath(left.targetRelativePath).localeCompare(normalizeArtifactPath(right.targetRelativePath)));
}

export function adoptedRoleRightsNode(row: ExtensionTransferRow, blocker: AdoptedRoleRightsBlocker): CompareTreeNode {
  const reason = blocker.ambiguous
    ? 'Несколько Rights.xml соответствуют одному пути заимствованной роли; семантическое сопоставление невозможно.'
    : 'Rights.xml заимствованной роли содержит наследуемые и собственные значения. Без base-aware перевода состояний inherit/allow/deny сырой XML переносить нельзя.';
  return {
    id: `extension:adopted-role-rights:${row.id}:${encodeURIComponent(blocker.targetRelativePath)}`,
    label: `Права роли: ${blocker.targetRelativePath}`,
    kind: 'roleRightsProjectionBlocker',
    status: 'changed',
    mergeable: false,
    conflict: { kind: 'unsupported', blocking: true, message: reason },
    mergeState: { state: 'blocked', reason, targetFilePath: blocker.targetRelativePath },
    children: [],
  };
}

export function roleRightsSidecars(object: ExtensionIndexedObject): Map<string, {
  readonly file: ExtensionIndexedObject['sidecarFiles'][number];
  readonly relative: string;
  readonly duplicate: boolean;
}> {
  const files = new Map<string, { file: ExtensionIndexedObject['sidecarFiles'][number]; relative: string; duplicate: boolean }>();
  for (const file of object.sidecarFiles) {
    if (path.posix.basename(file.relativePath.replace(/\\/gu, '/')).toLocaleLowerCase('en-US') !== 'rights.xml') {continue;}
    const relative = ownerRelativePath(object, file.relativePath).replace(/\\/gu, '/');
    const key = normalizeArtifactPath(relative);
    const prior = files.get(key);
    if (prior) {
      files.set(key, { ...prior, duplicate: true });
    } else {
      files.set(key, { file, relative, duplicate: false });
    }
  }
  return files;
}

function xmlSidecarsByOwnerPath(object: ExtensionIndexedObject): {
  files: Map<string, ExtensionIndexedObject['sidecarFiles'][number]>;
  duplicatePaths: string[];
} {
  const result = new Map<string, ExtensionIndexedObject['sidecarFiles'][number]>();
  const duplicates = new Set<string>();
  for (const file of object.sidecarFiles) {
    const relative = ownerRelativePath(object, file.relativePath).replace(/\\/gu, '/');
    if (!semanticSidecarKind(file)) {continue;}
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (result.has(key)) {
      result.delete(key);
      duplicates.add(key);
    } else if (!duplicates.has(key)) {
      result.set(key, file);
    }
  }
  return { files: result, duplicatePaths: [...duplicates] };
}

function semanticSidecarKind(file: ExtensionIndexedObject['sidecarFiles'][number]): 'formXml' | 'predefinedXml' | 'roleRightsXml' | 'dcsXml' | undefined {
  const name = path.posix.basename(file.relativePath.replace(/\\/gu, '/')).toLocaleLowerCase('en-US');
  if (name === 'form.xml') {return 'formXml';}
  if (name === 'predefined.xml') {return 'predefinedXml';}
  if (name === 'rights.xml' && file.rootExpandedName === '{http://v8.1c.ru/8.2/roles}Rights') {return 'roleRightsXml';}
  if (name === 'template.xml' && file.rootExpandedName === '{http://v8.1c.ru/8.1/data-composition-system/schema}DataCompositionSchema') {return 'dcsXml';}
  return undefined;
}

export function ownerRelativePath(object: ExtensionIndexedObject, relativePath: string): string {
  const prefix = (object.sidecarRelativePath ?? '').replace(/\\/gu, '/').replace(/\/$/u, '');
  const candidate = relativePath.replace(/\\/gu, '/');
  const parent = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const expectedPrefix = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
  return expectedPrefix && parent.startsWith(`${expectedPrefix}/`)
    ? candidate.slice(prefix.length + 1)
    : candidate;
}

export function normalizeArtifactPath(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
