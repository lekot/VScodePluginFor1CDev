import * as fs from 'fs/promises';

import { blocked, canonicalRelativePath, finalName, hashBuffer, normalizeAbsolutePath, normalizePath, stripHash } from './linkedDesignerUtils';
import { captureMergePath } from './merge/mergeSnapshot';
import type { CompareMessage, MetadataIdentity, MatchResult } from './domain/compareContracts';
import type { ArtifactUnit, ConfigurationInventory, MetadataObjectUnit } from './inventory/configurationInventory';
import type { ConfigurationFileManifest } from './inventory/configurationFileManifest';
import type { LinkedDesignerKind, LinkedDesignerPackageMemberReference, LinkedDesignerPackageReference, LinkedDesignerPackageReferenceIndex, LinkedDesignerRootConfigurationSnapshot } from './linkedDesignerTypes';
import { requiredLinkedDesignerBodyPath } from './linkedDesignerPackageRules';
import { metadataDescriptorPathKey, metadataManifestRelativePathKey } from './metadataObjectLookup';
import { buildWholeObjectCopyRecipes } from './linkedDesignerWholeObjectRecipes';
import { captureRootConfigurationSnapshot, rootRegistrationIsAvailable, type RootConfigurationCapture } from './linkedDesignerRootConfiguration';
import {
  type UnmatchedPackageIdentity,
  DESIGNER_TYPES,
  addCounterpartCandidate,
  artifactsByNormalizedPath,
  countIdentityNames,
  fileObjectNodeIdForIdentity,
  nestedOwnerQualifiedName,
  packageIdFor,
  sameRelativePath,
  uniqueCounterpart,
  unmatchedPackageIdentities,
} from './linkedDesignerPackageIndexSupport';

type ReferenceIndexInput = Parameters<typeof buildLinkedDesignerPackageReferenceIndex>[0];

interface ReferenceIndexState {
  readonly input: ReferenceIndexInput;
  readonly diagnostics: CompareMessage[];
  readonly packageReferences: LinkedDesignerPackageReference[];
  readonly blockedPresenceNodeIds: Map<string, string>;
  readonly seen: Set<string>;
  identityCounts: Map<string, number>;
  matchedOwnerNames: Set<string>;
  firstMatchedOwnerByName: Map<string, MatchResult['matches'][number]>;
  counterpartCandidatesByName: Map<string, MetadataIdentity[]>;
  leftArtifactsByPath: Map<string, ArtifactUnit[]>;
  rightArtifactsByPath: Map<string, ArtifactUnit[]>;
}

interface ReferenceIndexItemContext {
  readonly state: ReferenceIndexState;
  readonly item: UnmatchedPackageIdentity;
  readonly kind: LinkedDesignerKind;
  readonly isRootObject: boolean;
  readonly ownerQualifiedName?: string;
  readonly presenceNodeId: string;
}

interface ReferencePackageInventoryContext {
  readonly sourceManifest: ConfigurationFileManifest;
  readonly targetManifest: ConfigurationFileManifest;
  readonly sourceArtifactsByPath: Map<string, ArtifactUnit[]>;
  readonly targetArtifactsByPath: Map<string, ArtifactUnit[]>;
  readonly sourceObject: MetadataObjectUnit;
  readonly targetEntriesByRelativePath: Map<string, ConfigurationFileManifest['entries'][number]>;
}

interface PreparedReferencePackage extends ReferencePackageInventoryContext {
  readonly descriptor: ArtifactUnit;
  readonly requiredBodyPath: string;
  readonly sourceEntries: ConfigurationFileManifest['entries'];
}

/** Creates immutable path references without retaining sidecar bytes or package recipes. */
export async function buildLinkedDesignerPackageReferenceIndex(input: {
  readonly metadata: MatchResult;
  readonly leftInventory: ConfigurationInventory;
  readonly rightInventory: ConfigurationInventory;
  readonly leftManifest: ConfigurationFileManifest;
  readonly rightManifest: ConfigurationFileManifest;
  readonly leftRootPath: string;
  readonly rightRootPath: string;
  readonly strategy: 'left' | 'right' | 'full';
  readonly rootConfigurationCapture?: RootConfigurationCapture;
}): Promise<LinkedDesignerPackageReferenceIndex> {
  const state = createReferenceIndexState(input);
  initializeReferenceIndex(state);
  const unmatched = unmatchedPackageIdentities(input.metadata, input.strategy);
  state.leftArtifactsByPath = artifactsByNormalizedPath(input.leftInventory);
  state.rightArtifactsByPath = artifactsByNormalizedPath(input.rightInventory);
  for (const item of unmatched) {await processReferenceIndexItem(state, item);}
  return finalizeReferenceIndex(state);
}

function createReferenceIndexState(input: ReferenceIndexInput): ReferenceIndexState {
  return {
    input,
    diagnostics: [],
    packageReferences: [],
    blockedPresenceNodeIds: new Map(),
    seen: new Set(),
    identityCounts: new Map(),
    matchedOwnerNames: new Set(),
    firstMatchedOwnerByName: new Map(),
    counterpartCandidatesByName: new Map(),
    leftArtifactsByPath: new Map(),
    rightArtifactsByPath: new Map(),
  };
}

function initializeReferenceIndex(state: ReferenceIndexState): void {
  const { metadata } = state.input;
  const allIdentities = [
    ...metadata.matches.flatMap((match) => [match.left, match.right]),
    ...metadata.unmatchedLeft,
    ...metadata.unmatchedRight,
  ];
  state.identityCounts = countIdentityNames(allIdentities);
  state.matchedOwnerNames = new Set(metadata.matches
    .filter((match) => match.left.qualifiedName === match.right.qualifiedName)
    .map((match) => match.left.qualifiedName));
  for (const match of metadata.matches) {
    if (!state.firstMatchedOwnerByName.has(match.left.qualifiedName)) {
      state.firstMatchedOwnerByName.set(match.left.qualifiedName, match);
    }
    addCounterpartCandidate(state.counterpartCandidatesByName, match.left);
    addCounterpartCandidate(state.counterpartCandidatesByName, match.right);
  }
  for (const identity of metadata.unmatchedLeft) {addCounterpartCandidate(state.counterpartCandidatesByName, identity);}
  for (const identity of metadata.unmatchedRight) {addCounterpartCandidate(state.counterpartCandidatesByName, identity);}
}

async function processReferenceIndexItem(state: ReferenceIndexState, item: UnmatchedPackageIdentity): Promise<void> {
  const kind = DESIGNER_TYPES.get(item.identity.metadataType);
  if (!kind) {return;}
  const isRootObject = item.identity.metadataType.startsWith('Common');
  const ownerQualifiedName = isRootObject ? undefined : nestedOwnerQualifiedName(item.identity);
  const context: ReferenceIndexItemContext = {
    state,
    item,
    kind,
    isRootObject,
    ...(ownerQualifiedName ? { ownerQualifiedName } : {}),
    presenceNodeId: fileObjectNodeIdForIdentity(item.identity, item.action),
  };
  if (!isRootObject && (!ownerQualifiedName || !state.matchedOwnerNames.has(ownerQualifiedName))) {
    setReferencePresenceBlock(context, 'Вложенный Designer-объект нельзя переносить отдельно от регистрации владельца.');
    return;
  }
  setReferencePresenceBlock(context, 'Linked Designer package не прошёл проверку захваченного inventory.');
  if (!validateReferenceIndexIdentity(context)) {return;}
  const inventories = resolveReferencePackageInventories(context);
  if (!inventories) {return;}
  const descriptor = await captureReferencePackageDescriptor(context, inventories);
  if (!descriptor) {return;}
  const memberReferences = createReferencePackageMembers(context, inventories, descriptor);
  const ownerDescriptorReference = resolveReferenceOwnerDescriptor(context);
  if (ownerDescriptorReference === null) {return;}
  if (appendPackageReference(context, inventories, descriptor, memberReferences, ownerDescriptorReference)) {
    state.blockedPresenceNodeIds.delete(context.presenceNodeId);
  }
}

function validateReferenceIndexIdentity(context: ReferenceIndexItemContext): boolean {
  const { state, item } = context;
  const identityKey = `${item.action}\0${item.identity.qualifiedName.toLocaleLowerCase('en-US')}`;
  const sourceIdentityKey = `${item.identity.sourceId}\0${item.identity.qualifiedName.normalize('NFC').toLocaleLowerCase('en-US')}`;
  if (!state.seen.has(identityKey) && state.identityCounts.get(sourceIdentityKey) === 1) {
    state.seen.add(identityKey);
    return true;
  }
  failReferenceIndexItem(context, 'Имя связанного Designer-пакета неоднозначно; обновите сравнение и устраните дубликаты.');
  return false;
}

function failReferenceIndexItem(context: ReferenceIndexItemContext, message: string): void {
  const { item } = context;
  context.state.diagnostics.push(blocked(message, item.identity.sourceId, item.identity.qualifiedName));
  setReferencePresenceBlock(context, message);
}

function setReferencePresenceBlock(context: ReferenceIndexItemContext, message: string): void {
  context.state.blockedPresenceNodeIds.set(context.presenceNodeId, message);
}

function resolveReferencePackageInventories(
  context: ReferenceIndexItemContext,
): ReferencePackageInventoryContext | undefined {
  const { state, item } = context;
  const sourceSide = item.action === 'copy' ? 'right' : 'left';
  const sourceManifest = sourceSide === 'right' ? state.input.rightManifest : state.input.leftManifest;
  const targetManifest = sourceSide === 'right' ? state.input.leftManifest : state.input.rightManifest;
  const sourceArtifactsByPath = sourceSide === 'right' ? state.rightArtifactsByPath : state.leftArtifactsByPath;
  const targetArtifactsByPath = sourceSide === 'right' ? state.leftArtifactsByPath : state.rightArtifactsByPath;
  const sourceObject = sourceManifest.objectsByDescriptorPath.get(metadataDescriptorPathKey(item.identity.filePath));
  if (!sourceObject) {
    failReferenceIndexItem(context, 'Дескриптор связанного Designer-пакета отсутствует в captured inventory.');
    return undefined;
  }
  const targetIdentity = item.action === 'copy'
    ? uniqueCounterpart(state.counterpartCandidatesByName, item.identity.qualifiedName, 'left')
    : item.identity;
  if (item.action === 'copy' && targetIdentity?.uuid && item.identity.uuid
    && targetIdentity.uuid.toLocaleLowerCase('en-US') !== item.identity.uuid.toLocaleLowerCase('en-US')) {
    failReferenceIndexItem(context, 'В target уже существует Designer-объект с тем же именем и другим UUID; связанный перенос заблокирован.');
    return undefined;
  }
  const targetObjectId = targetIdentity
    ? targetManifest.objectsByDescriptorPath.get(metadataDescriptorPathKey(targetIdentity.filePath))?.objectId
    : undefined;
  const targetEntriesByRelativePath = indexTargetPackageEntries(targetManifest, targetObjectId);
  return {
    sourceManifest,
    targetManifest,
    sourceArtifactsByPath,
    targetArtifactsByPath,
    sourceObject,
    targetEntriesByRelativePath,
  };
}

function indexTargetPackageEntries(
  targetManifest: ConfigurationFileManifest,
  targetObjectId: string | undefined,
): Map<string, ConfigurationFileManifest['entries'][number]> {
  const entriesByRelativePath = new Map<string, ConfigurationFileManifest['entries'][number]>();
  if (targetObjectId) {
    for (const entry of targetManifest.entriesByOwnerObjectId.get(targetObjectId) ?? []) {
      const key = normalizePath(entry.relativePath);
      if (!entriesByRelativePath.has(key)) {entriesByRelativePath.set(key, entry);}
    }
  }
  return entriesByRelativePath;
}

async function captureReferencePackageDescriptor(
  context: ReferenceIndexItemContext,
  inventories: ReferencePackageInventoryContext,
): Promise<Pick<PreparedReferencePackage, 'descriptor' | 'requiredBodyPath' | 'sourceEntries'> | undefined> {
  const { item } = context;
  const descriptor = inventories.sourceArtifactsByPath.get(normalizeAbsolutePath(item.identity.filePath))
    ?.find((artifact) => artifact.kind === 'metadataXml');
  if (!descriptor) {
    failReferenceIndexItem(context, 'Дескриптор linked Designer-пакета отсутствует в captured inventory.');
    return undefined;
  }
  const descriptorSnapshot = await captureMergePath(descriptor.filePath, { retainContent: false }).catch(() => undefined);
  if (descriptorSnapshot?.state !== 'file' || descriptorSnapshot.hash !== stripHash(descriptor.contentHash)) {
    failReferenceIndexItem(context, `Дескриптор Designer-пакета изменился после сравнения: ${descriptor.relativePath}`);
    return undefined;
  }
  const descriptorBytes = await fs.readFile(descriptor.filePath).catch(() => undefined);
  if (!descriptorBytes || hashBuffer(descriptorBytes) !== stripHash(descriptor.contentHash)) {
    failReferenceIndexItem(context, `Дескриптор Designer-пакета изменился после сравнения: ${descriptor.relativePath}`);
    return undefined;
  }
  const requiredBodyPath = requiredLinkedDesignerBodyPath(context.kind, descriptor.relativePath, descriptorBytes);
  const sourceEntries = inventories.sourceManifest.entriesByOwnerObjectId.get(inventories.sourceObject.objectId) ?? [];
  if (!requiredBodyPath || !sourceEntries.some((entry) => sameRelativePath(entry.relativePath, requiredBodyPath))) {
    failReferenceIndexItem(context, `Пакет ${item.identity.qualifiedName} не содержит обязательный descriptor или точный sidecar: ${requiredBodyPath ?? 'тип тела не определён'}.`);
    return undefined;
  }
  return { descriptor, requiredBodyPath, sourceEntries };
}

function createReferencePackageMembers(
  context: ReferenceIndexItemContext,
  inventories: ReferencePackageInventoryContext,
  descriptor: Pick<PreparedReferencePackage, 'descriptor' | 'requiredBodyPath' | 'sourceEntries'>,
): LinkedDesignerPackageMemberReference[] {
  const { item } = context;
  return descriptor.sourceEntries.map((entry) => {
    const sourceArtifact = inventories.sourceArtifactsByPath.get(normalizeAbsolutePath(entry.filePath))?.[0];
    const targetEntry = inventories.targetEntriesByRelativePath.get(normalizePath(entry.relativePath));
    const targetArtifact = referenceTargetArtifact(item.action, sourceArtifact, targetEntry, inventories);
    return {
      relativePath: entry.relativePath,
      artifactKindHint: entry.artifactKindHint,
      ...(sourceArtifact ? { sourceHashAtCompare: stripHash(sourceArtifact.contentHash) } : {}),
      ...(targetArtifact ? { targetHashAtCompare: stripHash(targetArtifact.contentHash) } : {}),
      targetPresentAtCompare: item.action === 'delete' ? true : Boolean(targetEntry),
      required: entry.isDescriptor || sameRelativePath(entry.relativePath, descriptor.requiredBodyPath),
    };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function referenceTargetArtifact(
  action: 'copy' | 'delete',
  sourceArtifact: ArtifactUnit | undefined,
  targetEntry: ConfigurationFileManifest['entries'][number] | undefined,
  inventories: ReferencePackageInventoryContext,
): ArtifactUnit | undefined {
  if (action === 'delete') {return sourceArtifact;}
  if (!targetEntry) {return undefined;}
  const matches = inventories.targetArtifactsByPath.get(normalizeAbsolutePath(targetEntry.filePath));
  return matches?.length === 1 ? matches[0] : undefined;
}

function resolveReferenceOwnerDescriptor(
  context: ReferenceIndexItemContext,
): LinkedDesignerPackageReference['ownerDescriptorReference'] | null | undefined {
  const ownerQualifiedName = context.ownerQualifiedName;
  if (!ownerQualifiedName) {return undefined;}
  const state = context.state;
  const ownerMatch = state.firstMatchedOwnerByName.get(ownerQualifiedName);
  const ownerObject = ownerMatch
    ? state.input.leftManifest.objectsByDescriptorPath.get(metadataDescriptorPathKey(ownerMatch.left.filePath))
    : undefined;
  const ownerDescriptor = ownerObject
    ? state.leftArtifactsByPath.get(normalizeAbsolutePath(ownerObject.descriptorPath))?.find((artifact) => artifact.kind === 'metadataXml')
    : undefined;
  const ownerRelativePath = ownerDescriptor && canonicalRelativePath(state.input.leftInventory.rootPath, ownerDescriptor.filePath);
  if (!ownerDescriptor || !ownerRelativePath || ownerDescriptor.kind !== 'metadataXml') {
    failReferenceIndexItem(context, `Дескриптор владельца ${ownerQualifiedName} не удалось подтвердить для linked package.`);
    return null;
  }
  return { targetRelativePath: ownerRelativePath, targetHash: stripHash(ownerDescriptor.contentHash) };
}

function appendPackageReference(
  context: ReferenceIndexItemContext,
  inventories: ReferencePackageInventoryContext,
  descriptor: Pick<PreparedReferencePackage, 'descriptor' | 'requiredBodyPath' | 'sourceEntries'>,
  memberReferences: LinkedDesignerPackageMemberReference[],
  ownerDescriptorReference: LinkedDesignerPackageReference['ownerDescriptorReference'] | undefined,
): boolean {
  const { state, item } = context;
  const sourceContainerRelativePath = canonicalRelativePath(inventories.sourceManifest.rootPath, inventories.sourceObject.containerPath);
  if (!sourceContainerRelativePath) {
    failReferenceIndexItem(context, `Каталог linked Designer-пакета ${item.identity.qualifiedName} не ограничен корнем source.`);
    return false;
  }
  const sourceContainerPathKey = metadataManifestRelativePathKey(sourceContainerRelativePath);
  const sourceContainerFileCount = inventories.sourceManifest.subtreeFileCountsByDirectory.get(sourceContainerPathKey) ?? 0;
  const sourceContainerDirectoryCount = inventories.sourceManifest.subtreeDirectoryCountsByDirectory.get(sourceContainerPathKey) ?? 0;
  const packageId = packageIdFor(context.kind, item.identity.qualifiedName);
  state.packageReferences.push({
    packageId,
    action: item.action,
    kind: context.kind,
    qualifiedName: item.identity.qualifiedName,
    sourceObjectId: inventories.sourceObject.objectId,
    sourceContainerRelativePath,
    sourceContainerFileCount,
    sourceContainerDirectoryCount,
    sourceDescriptorRelativePath: descriptor.descriptor.relativePath,
    sourceDescriptorHash: stripHash(descriptor.descriptor.contentHash),
    ...(context.ownerQualifiedName ? { ownerQualifiedName: context.ownerQualifiedName } : {}),
    ...(ownerDescriptorReference ? { ownerDescriptorReference } : {}),
    ...(context.ownerQualifiedName ? {
      ownerTargetRelativePath: canonicalRelativePath(
        state.input.leftRootPath,
        state.firstMatchedOwnerByName.get(context.ownerQualifiedName)?.left.filePath ?? ''
      ),
    } : {}),
    ...(context.isRootObject ? { rootRegistration: { rootTag: item.identity.metadataType, objectName: finalName(item.identity.qualifiedName) } } : {}),
    memberReferences,
  });
  return true;
}

async function finalizeReferenceIndex(state: ReferenceIndexState): Promise<LinkedDesignerPackageReferenceIndex> {
  const { input } = state;
  const rootConfigurationCapture = input.rootConfigurationCapture
    ?? await captureRootConfigurationSnapshot(input.leftRootPath, input.rightRootPath);
  const rootConfiguration = rootConfigurationCapture.snapshot;
  const validPackageReferences = filterRegisteredReferences(
    state.packageReferences,
    rootConfiguration,
    state.diagnostics,
    state.blockedPresenceNodeIds,
  );
  const wholeObjectCopiesByNodeId = await buildWholeObjectCopyRecipes({
    strategy: input.strategy,
    metadata: input.metadata,
    rightInventory: input.rightInventory,
    rootConfiguration,
    rootConfigurationCapture,
    identityCounts: state.identityCounts,
    diagnostics: state.diagnostics,
    blockedPresenceNodeIds: state.blockedPresenceNodeIds,
  });
  return {
    packageReferences: validPackageReferences,
    diagnostics: state.diagnostics,
    blockedPresenceNodeIds: state.blockedPresenceNodeIds,
    ...(rootConfiguration ? { rootConfiguration } : {}),
    rootConfigurationStates: {
      target: rootConfigurationCapture.targetState,
      source: rootConfigurationCapture.sourceState,
    },
    ...(wholeObjectCopiesByNodeId.size > 0 ? { wholeObjectCopiesByNodeId } : {}),
  };
}

function filterRegisteredReferences(
  references: readonly LinkedDesignerPackageReference[],
  rootConfiguration: LinkedDesignerRootConfigurationSnapshot | undefined,
  diagnostics: CompareMessage[],
  blockedPresenceNodeIds: Map<string, string>,
): LinkedDesignerPackageReference[] {
  for (const reference of references) {
    if (reference.rootRegistration && !rootRegistrationIsAvailable(reference, rootConfiguration)) {
      diagnostics.push(blocked(`Root Configuration.xml не подтверждает регистрацию пакета ${reference.qualifiedName}.`, 'right-source', reference.qualifiedName));
    }
  }
  return references.filter((reference) => {
    if (!reference.rootRegistration || rootRegistrationIsAvailable(reference, rootConfiguration)) {return true;}
    const nodeId = `fileObject:${reference.action === 'copy' ? 'rightOnly' : 'leftOnly'}:${encodeURIComponent(reference.qualifiedName)}`;
    blockedPresenceNodeIds.set(nodeId, 'Root Configuration.xml не подтверждает регистрацию Designer-пакета.');
    return false;
  });
}
