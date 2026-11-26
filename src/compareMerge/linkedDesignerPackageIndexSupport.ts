import type { ArtifactUnit, ConfigurationInventory, MetadataObjectUnit } from './inventory/configurationInventory';
import type { MetadataIdentity, MatchResult } from './domain/compareContracts';
import type { IndexedPackageObject, LinkedDesignerKind } from './linkedDesignerTypes';
import { findInventoryObjectByDescriptor } from './metadataObjectLookup';
import { normalizeAbsolutePath, normalizePath } from './linkedDesignerUtils';

export const DESIGNER_TYPES = new Map<string, LinkedDesignerKind>([
  ['Form', 'Form'],
  ['Template', 'Template'],
  ['Command', 'Command'],
  ['CommonForm', 'Form'],
  ['CommonTemplate', 'Template'],
  ['CommonCommand', 'Command'],
]);

export interface UnmatchedPackageIdentity {
  readonly identity: MetadataIdentity;
  readonly action: 'copy' | 'delete';
}

export function unmatchedPackageIdentities(
  metadata: MatchResult,
  strategy: 'left' | 'right' | 'full',
): UnmatchedPackageIdentity[] {
  return [
    ...metadata.unmatchedRight.map((identity) => ({ identity, action: 'copy' as const })),
    ...(strategy === 'full'
      ? metadata.unmatchedLeft.map((identity) => ({ identity, action: 'delete' as const }))
      : []),
  ];
}

export function fileObjectNodeIdForIdentity(identity: MetadataIdentity, action: 'copy' | 'delete'): string {
  return `fileObject:${action === 'copy' ? 'rightOnly' : 'leftOnly'}:${encodeURIComponent(identity.qualifiedName)}`;
}

export function countIdentityNames(identities: readonly MetadataIdentity[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const identity of identities) {
    const key = `${identity.sourceId}\0${identity.qualifiedName.normalize('NFC').toLocaleLowerCase('en-US')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function nestedOwnerQualifiedName(identity: MetadataIdentity): string | undefined {
  const parts = identity.qualifiedName.split('.');
  if (parts.length < 4) {return undefined;}
  const nestedTypeIndex = parts.lastIndexOf(identity.metadataType);
  if (nestedTypeIndex < 2 || nestedTypeIndex !== parts.length - 2) {return undefined;}
  return parts.slice(0, nestedTypeIndex).join('.');
}

export function hasMatchedOwner(metadata: MatchResult, ownerQualifiedName: string): boolean {
  return metadata.matches.some((match) =>
    match.left.qualifiedName === ownerQualifiedName && match.right.qualifiedName === ownerQualifiedName
  );
}

export function addCounterpartCandidate(index: Map<string, MetadataIdentity[]>, identity: MetadataIdentity): void {
  const key = normalizedQualifiedName(identity.qualifiedName);
  const candidates = index.get(key) ?? [];
  candidates.push(identity);
  index.set(key, candidates);
}

export function uniqueCounterpart(
  index: ReadonlyMap<string, readonly MetadataIdentity[]>,
  qualifiedName: string,
  side: 'left' | 'right',
): MetadataIdentity | undefined {
  const candidates = (index.get(normalizedQualifiedName(qualifiedName)) ?? [])
    .filter((identity) => identity.side === side);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function normalizedQualifiedName(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

export function artifactsByNormalizedPath(inventory: ConfigurationInventory): Map<string, ArtifactUnit[]> {
  const result = new Map<string, ArtifactUnit[]>();
  for (const artifacts of inventory.artifactsByObjectId.values()) {
    for (const artifact of artifacts) {
      const key = normalizeAbsolutePath(artifact.filePath);
      const matches = result.get(key) ?? [];
      matches.push(artifact);
      result.set(key, matches);
    }
  }
  return result;
}

export function findIndexedPackageObject(
  identity: MetadataIdentity,
  inventory: ConfigurationInventory,
): IndexedPackageObject | undefined {
  const object = findInventoryObject(inventory, identity.filePath);
  return object ? { identity, object, inventory } : undefined;
}

export function findInventoryObject(inventory: ConfigurationInventory, descriptorPath: string): MetadataObjectUnit | undefined {
  return findInventoryObjectByDescriptor(inventory, descriptorPath);
}

export function artifactsFor(inventory: ConfigurationInventory, object: MetadataObjectUnit): ArtifactUnit[] {
  return inventory.artifactsByObjectId.get(object.objectId) ?? [];
}

export function samePath(left: string, right: string): boolean {
  const a = normalizeAbsolutePath(left);
  const b = normalizeAbsolutePath(right);
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

export function sameRelativePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

export function packageIdFor(kind: LinkedDesignerKind, qualifiedName: string): string {
  return `designer:${kind}:${encodeURIComponent(qualifiedName)}`;
}
