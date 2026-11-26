import * as path from 'path';

import { captureMergePath, mergeSnapshotHash } from './merge/mergeSnapshot';
import { MISSING_TARGET_HASH } from './merge/mergePreview';
import type { CompareMessage, MetadataIdentity, MatchResult } from './domain/compareContracts';
import type { ConfigurationInventory, MetadataObjectUnit, ArtifactUnit } from './inventory/configurationInventory';
import type { ConfigurationFileManifest } from './inventory/configurationFileManifest';
import { blocked, canonicalRelativePath, finalName, normalizePath, stripHash } from './linkedDesignerUtils';
import type { LinkedDesignerCompareIndex, LinkedDesignerKind, LinkedDesignerPackageMember, LinkedDesignerPackageRecipe, IndexedPackageObject, LinkedDesignerRootConfigurationSnapshot, LinkedOwnerDescriptorSnapshot } from './linkedDesignerTypes';
import { requiredLinkedDesignerBodyPath } from './linkedDesignerPackageRules';
import { metadataDescriptorPathKey } from './metadataObjectLookup';
import {
  type UnmatchedPackageIdentity,
  DESIGNER_TYPES,
  artifactsFor,
  countIdentityNames,
  fileObjectNodeIdForIdentity,
  findIndexedPackageObject,
  findInventoryObject,
  hasMatchedOwner,
  nestedOwnerQualifiedName,
  packageIdFor,
  samePath,
  sameRelativePath,
  unmatchedPackageIdentities,
} from './linkedDesignerPackageIndexSupport';
import { buildWholeObjectCopyRecipes } from './linkedDesignerWholeObjectRecipes';
import { captureRootConfigurationSnapshot, rootRegistrationIsAvailable } from './linkedDesignerRootConfiguration';



export interface UnmatchedLinkedDesignerBslPathSet {
  readonly left: ReadonlySet<string>;
  readonly right: ReadonlySet<string>;
}

type CompareIndexInput = Parameters<typeof buildLinkedDesignerCompareIndex>[0];

interface CompareIndexState {
  readonly input: CompareIndexInput;
  readonly diagnostics: CompareMessage[];
  readonly packages: LinkedDesignerPackageRecipe[];
  readonly blockedPresenceNodeIds: Map<string, string>;
  readonly seen: Set<string>;
  readonly ownerDescriptorCache: Map<string, LinkedOwnerDescriptorSnapshot | null>;
  identityCounts: Map<string, number>;
}

interface CompareIndexItemContext {
  readonly state: CompareIndexState;
  readonly item: UnmatchedPackageIdentity;
  readonly kind: LinkedDesignerKind;
  readonly isRootObject: boolean;
  readonly ownerQualifiedName?: string;
  readonly presenceNodeId: string;
}

type CapturedFile = Extract<Awaited<ReturnType<typeof captureMergePath>>, { state: 'file' }>;

interface PreparedCompareIndexPackage {
  readonly indexed: IndexedPackageObject;
  readonly targetObject?: MetadataObjectUnit;
  readonly descriptor: ArtifactUnit;
  readonly descriptorSnapshot: CapturedFile;
  readonly sourceArtifacts: ArtifactUnit[];
  readonly targetArtifacts: ArtifactUnit[];
  readonly memberArtifacts: ArtifactUnit[];
  readonly requiredBodyPath: string;
  readonly targetDirectoryWitness?: import('./merge/mergePreview').MergeFileWitness;
}

interface CompareIndexPackageBase {
  readonly indexed: IndexedPackageObject;
  readonly targetObject?: MetadataObjectUnit;
  readonly descriptor: ArtifactUnit;
  readonly sourceArtifacts: ArtifactUnit[];
  readonly targetArtifacts: ArtifactUnit[];
  readonly memberArtifacts: ArtifactUnit[];
}

/** Finds BSL members whose unmatched Designer package owns their first content capture. */
export function collectUnmatchedLinkedDesignerBslPaths(input: {
  readonly metadata: MatchResult;
  readonly leftManifest: ConfigurationFileManifest;
  readonly rightManifest: ConfigurationFileManifest;
  readonly strategy: 'left' | 'right' | 'full';
}): UnmatchedLinkedDesignerBslPathSet {
  const left = new Set<string>();
  const right = new Set<string>();
  const unmatched = [
    ...input.metadata.unmatchedRight.map((identity) => ({ identity, side: 'right' as const })),
    ...(input.strategy === 'full'
      ? input.metadata.unmatchedLeft.map((identity) => ({ identity, side: 'left' as const }))
      : []),
  ];
  for (const item of unmatched) {
    if (!DESIGNER_TYPES.has(item.identity.metadataType)) {continue;}
    const manifest = item.side === 'right' ? input.rightManifest : input.leftManifest;
    const object = manifest.objectsByDescriptorPath.get(metadataDescriptorPathKey(item.identity.filePath));
    if (!object) {continue;}
    const destination = item.side === 'right' ? right : left;
    for (const entry of manifest.entriesByOwnerObjectId.get(object.objectId) ?? []) {
      if (entry.artifactKindHint === 'bslModule') {destination.add(entry.filePath);}
    }
  }
  return { left, right };
}

/** Builds package links only from uniquely indexed metadata and compare-time inventory hashes. */
export async function buildLinkedDesignerCompareIndex(input: {
  readonly metadata: MatchResult;
  readonly leftInventory: ConfigurationInventory;
  readonly rightInventory: ConfigurationInventory;
  readonly leftRootPath: string;
  readonly rightRootPath: string;
  readonly strategy: 'left' | 'right' | 'full';
}): Promise<LinkedDesignerCompareIndex> {
  const state = createCompareIndexState(input);
  const unmatched = unmatchedPackageIdentities(input.metadata, input.strategy);
  const allIdentities = [
    ...input.metadata.matches.flatMap((match) => [match.left, match.right]),
    ...input.metadata.unmatchedLeft,
    ...input.metadata.unmatchedRight,
  ];
  state.identityCounts = countIdentityNames(allIdentities);
  for (const item of unmatched) {await processCompareIndexItem(state, item);}
  return finalizeCompareIndex(state);
}

function createCompareIndexState(input: CompareIndexInput): CompareIndexState {
  return {
    input,
    diagnostics: [],
    packages: [],
    blockedPresenceNodeIds: new Map(),
    seen: new Set(),
    ownerDescriptorCache: new Map(),
    identityCounts: new Map(),
  };
}

async function processCompareIndexItem(state: CompareIndexState, item: UnmatchedPackageIdentity): Promise<void> {
  const kind = DESIGNER_TYPES.get(item.identity.metadataType);
  if (!kind) {return;}
  const isRootObject = item.identity.metadataType.startsWith('Common');
  const ownerQualifiedName = isRootObject ? undefined : nestedOwnerQualifiedName(item.identity);
  const context: CompareIndexItemContext = {
    state,
    item,
    kind,
    isRootObject,
    ...(ownerQualifiedName ? { ownerQualifiedName } : {}),
    presenceNodeId: fileObjectNodeIdForIdentity(item.identity, item.action),
  };
  if (!isRootObject && (!ownerQualifiedName || !hasMatchedOwner(state.input.metadata, ownerQualifiedName))) {
    setComparePresenceBlock(context, 'Вложенный Designer-объект нельзя переносить отдельно от регистрации владельца.');
    return;
  }
  setComparePresenceBlock(context, 'Linked Designer package не прошёл проверку захваченного inventory.');
  if (!validateCompareIndexIdentity(context)) {return;}
  const prepared = await prepareCompareIndexPackage(context);
  if (!prepared) {return;}
  const members = await captureComparePackageMembers(context, prepared);
  if (!members) {
    setComparePresenceBlock(context, 'Не удалось захватить все обязательные файлы linked Designer-пакета.');
    return;
  }
  const ownerDescriptorSnapshot = await resolveCompareOwnerDescriptor(context);
  if (ownerDescriptorSnapshot === null) {return;}
  appendComparePackage(context, prepared, members, ownerDescriptorSnapshot);
  state.blockedPresenceNodeIds.delete(context.presenceNodeId);
}

function validateCompareIndexIdentity(context: CompareIndexItemContext): boolean {
  const { state, item } = context;
  const identityKey = `${item.action}\0${item.identity.qualifiedName.toLocaleLowerCase('en-US')}`;
  const sourceIdentityKey = `${item.identity.sourceId}\0${item.identity.qualifiedName.normalize('NFC').toLocaleLowerCase('en-US')}`;
  if (!state.seen.has(identityKey) && state.identityCounts.get(sourceIdentityKey) === 1) {
    state.seen.add(identityKey);
    return true;
  }
  failCompareIndexItem(context, 'Имя связанного Designer-пакета неоднозначно; обновите сравнение и устраните дубликаты.');
  return false;
}

function failCompareIndexItem(context: CompareIndexItemContext, message: string): void {
  const { item } = context;
  context.state.diagnostics.push(blocked(message, item.identity.sourceId, item.identity.qualifiedName));
  setComparePresenceBlock(context, message);
}

function setComparePresenceBlock(context: CompareIndexItemContext, message: string): void {
  context.state.blockedPresenceNodeIds.set(context.presenceNodeId, message);
}

async function prepareCompareIndexPackage(
  context: CompareIndexItemContext,
): Promise<PreparedCompareIndexPackage | undefined> {
  const base = resolveCompareIndexPackageBase(context);
  if (!base) {return undefined;}
  const descriptorDetails = await captureCompareIndexPackageDescriptor(context, base);
  if (!descriptorDetails) {return undefined;}
  const sourceInventory = context.item.action === 'copy' ? context.state.input.rightInventory : context.state.input.leftInventory;
  const targetDirectoryWitness = await captureCompareDeleteDirectory(context, sourceInventory, base.indexed.object);
  if (context.item.action === 'delete' && !targetDirectoryWitness) {return undefined;}
  return {
    ...base,
    ...descriptorDetails,
    ...(targetDirectoryWitness ? { targetDirectoryWitness } : {}),
  };
}

function resolveCompareIndexPackageBase(context: CompareIndexItemContext): CompareIndexPackageBase | undefined {
  const { state, item } = context;
  const sourceSide = item.action === 'copy' ? 'right' : 'left';
  const sourceInventory = sourceSide === 'right' ? state.input.rightInventory : state.input.leftInventory;
  const targetInventory = sourceSide === 'right' ? state.input.leftInventory : state.input.rightInventory;
  const indexed = findIndexedPackageObject(item.identity, sourceInventory);
  if (!indexed) {
    failCompareIndexItem(context, 'Дескриптор связанного Designer-пакета отсутствует в captured inventory.');
    return undefined;
  }
  const targetIdentity = item.action === 'copy'
    ? counterpartIdentity(state.input.metadata, item.identity.qualifiedName, 'left')
    : item.identity;
  if (item.action === 'copy' && targetIdentity?.uuid && item.identity.uuid
    && targetIdentity.uuid.toLocaleLowerCase('en-US') !== item.identity.uuid.toLocaleLowerCase('en-US')) {
    failCompareIndexItem(context, 'В target уже существует Designer-объект с тем же именем и другим UUID; связанный перенос заблокирован.');
    return undefined;
  }
  const targetObject = targetIdentity ? findInventoryObject(targetInventory, targetIdentity.filePath) : undefined;
  const sourceArtifacts = artifactsFor(indexed.inventory, indexed.object);
  const descriptor = sourceArtifacts.find((artifact) => artifact.kind === 'metadataXml' && samePath(artifact.filePath, item.identity.filePath));
  if (!descriptor) {
    failCompareIndexItem(context, 'Дескриптор linked Designer-пакета отсутствует в captured inventory.');
    return undefined;
  }
  const targetArtifacts = targetObject ? artifactsFor(targetInventory, targetObject) : [];
  const memberArtifacts = [descriptor, ...sourceArtifacts.filter((artifact) => artifact.kind !== 'metadataXml')];
  return {
    indexed,
    ...(targetObject ? { targetObject } : {}),
    descriptor,
    sourceArtifacts,
    targetArtifacts,
    memberArtifacts,
  };
}

async function captureCompareIndexPackageDescriptor(
  context: CompareIndexItemContext,
  base: CompareIndexPackageBase,
): Promise<Pick<PreparedCompareIndexPackage, 'descriptorSnapshot' | 'requiredBodyPath'> | undefined> {
  const { item } = context;
  const { descriptor, memberArtifacts } = base;
  const descriptorSnapshot = await captureMergePath(descriptor.filePath, { retainContent: true }).catch(() => undefined);
  if (descriptorSnapshot?.state !== 'file' || descriptorSnapshot.hash !== stripHash(descriptor.contentHash) || !descriptorSnapshot.contentBase64) {
    failCompareIndexItem(context, `Дескриптор Designer-пакета изменился после сравнения: ${descriptor.relativePath}`);
    return undefined;
  }
  const requiredBodyPath = requiredLinkedDesignerBodyPath(
    context.kind,
    descriptor.relativePath,
    Buffer.from(descriptorSnapshot.contentBase64, 'base64'),
  );
  if (!requiredBodyPath || !memberArtifacts.some((artifact) => sameRelativePath(artifact.relativePath, requiredBodyPath))) {
    failCompareIndexItem(context, `Пакет ${item.identity.qualifiedName} не содержит обязательный descriptor или точный sidecar: ${requiredBodyPath ?? 'тип тела не определён'}.`);
    return undefined;
  }
  return {
    descriptorSnapshot,
    requiredBodyPath,
  };
}

async function captureCompareDeleteDirectory(
  context: CompareIndexItemContext,
  sourceInventory: ConfigurationInventory,
  sourceObject: MetadataObjectUnit,
): Promise<import('./merge/mergePreview').MergeFileWitness | undefined> {
  const { item } = context;
  if (item.action !== 'delete') {return undefined;}
  const directoryRelativePath = canonicalRelativePath(sourceInventory.rootPath, sourceObject.containerPath);
  const directorySnapshot = directoryRelativePath
    ? await captureMergePath(path.join(sourceInventory.rootPath, ...directoryRelativePath.split('/')), { retainContent: false }).catch(() => undefined)
    : undefined;
  if (!directoryRelativePath || directorySnapshot?.state !== 'directory') {
    failCompareIndexItem(context, `Каталог sidecar-пакета ${item.identity.qualifiedName} отсутствует или не подтверждён.`);
    return undefined;
  }
  return {
    sourceId: item.identity.sourceId,
    relativePath: directoryRelativePath,
    expectedHash: mergeSnapshotHash(directorySnapshot),
    kind: 'directory',
  };
}

async function captureComparePackageMembers(
  context: CompareIndexItemContext,
  prepared: PreparedCompareIndexPackage,
): Promise<LinkedDesignerPackageMember[] | undefined> {
  const members: LinkedDesignerPackageMember[] = [];
  for (const artifact of prepared.memberArtifacts) {
    const member = await captureComparePackageMember(context, prepared, artifact);
    if (!member) {return undefined;}
    members.push(member);
  }
  if (context.item.action === 'copy' && members.some((member) => member.required && (!member.sourceHash || !member.content))) {
    return undefined;
  }
  return members;
}

async function captureComparePackageMember(
  context: CompareIndexItemContext,
  prepared: PreparedCompareIndexPackage,
  artifact: ArtifactUnit,
): Promise<LinkedDesignerPackageMember | undefined> {
  const { item } = context;
  const sourceRootPath = prepared.indexed.inventory.rootPath;
  const sourceRelativePath = canonicalRelativePath(sourceRootPath, artifact.filePath);
  if (!sourceRelativePath) {return undefined;}
  const targetRelativePath = item.action === 'copy'
    ? sourceRelativePath
    : canonicalRelativePath(sourceRootPath, artifact.filePath);
  if (!targetRelativePath) {return undefined;}
  const memberTargetArtifact = item.action === 'copy' && prepared.targetObject
    ? matchPackageArtifact(artifact, prepared.indexed.object, prepared.targetArtifacts, prepared.targetObject)
    : item.action === 'delete' ? artifact : undefined;
  const expectedTargetHash = memberTargetArtifact
    ? stripHash(memberTargetArtifact.contentHash)
    : MISSING_TARGET_HASH;
  const content = await captureComparePackageMemberContent(context, prepared, artifact, sourceRelativePath);
  if (item.action === 'copy' && !content) {return undefined;}
  return {
    targetRelativePath,
    ...(item.action === 'copy' ? { sourceRelativePath, sourceHash: stripHash(artifact.contentHash), content } : {}),
    expectedTargetHash,
    required: artifact.kind === 'metadataXml' || sameRelativePath(artifact.relativePath, prepared.requiredBodyPath),
  };
}

async function captureComparePackageMemberContent(
  context: CompareIndexItemContext,
  prepared: PreparedCompareIndexPackage,
  artifact: ArtifactUnit,
  sourceRelativePath: string,
): Promise<Buffer | undefined> {
  if (context.item.action !== 'copy') {return undefined;}
  const snapshot = samePath(artifact.filePath, prepared.descriptor.filePath)
    ? prepared.descriptorSnapshot
    : await captureMergePath(path.join(prepared.indexed.inventory.rootPath, sourceRelativePath), { retainContent: true }).catch(() => undefined);
  if (snapshot?.state !== 'file' || snapshot.contentBase64 === undefined || snapshot.hash !== stripHash(artifact.contentHash)) {
    context.state.diagnostics.push(blocked(`Исходный Designer-файл изменился после сравнения: ${sourceRelativePath}`, context.item.identity.sourceId, context.item.identity.qualifiedName));
    return undefined;
  }
  return Buffer.from(snapshot.contentBase64, 'base64');
}

async function resolveCompareOwnerDescriptor(
  context: CompareIndexItemContext,
): Promise<LinkedOwnerDescriptorSnapshot | undefined | null> {
  const ownerQualifiedName = context.ownerQualifiedName;
  if (!ownerQualifiedName) {return undefined;}
  const { state } = context;
  const ownerKey = normalizePath(ownerQualifiedName);
  if (!state.ownerDescriptorCache.has(ownerKey)) {
    state.ownerDescriptorCache.set(ownerKey, await captureCompareOwnerDescriptor(state, ownerQualifiedName));
  }
  const cached = state.ownerDescriptorCache.get(ownerKey);
  if (cached) {return cached;}
  failCompareIndexItem(context, `Дескриптор владельца ${ownerQualifiedName} не удалось подтвердить для linked package.`);
  return null;
}

async function captureCompareOwnerDescriptor(
  state: CompareIndexState,
  ownerQualifiedName: string,
): Promise<LinkedOwnerDescriptorSnapshot | null> {
  const ownerMatch = state.input.metadata.matches.find((match) => match.left.qualifiedName === ownerQualifiedName);
  const ownerObject = ownerMatch ? findInventoryObject(state.input.leftInventory, ownerMatch.left.filePath) : undefined;
  const ownerDescriptor = ownerObject && artifactsFor(state.input.leftInventory, ownerObject)
    .find((artifact) => artifact.kind === 'metadataXml' && samePath(artifact.filePath, ownerObject.descriptorPath));
  const ownerRelativePath = ownerDescriptor && canonicalRelativePath(state.input.leftInventory.rootPath, ownerDescriptor.filePath);
  const ownerCapture = ownerRelativePath
    ? await captureMergePath(ownerDescriptor!.filePath, { retainContent: true }).catch(() => undefined)
    : undefined;
  const ownerBytes = ownerCapture?.state === 'file' && ownerCapture.contentBase64
    ? Buffer.from(ownerCapture.contentBase64, 'base64')
    : undefined;
  return ownerDescriptor && ownerRelativePath && ownerCapture?.state === 'file' && ownerBytes
    && ownerCapture.hash === stripHash(ownerDescriptor.contentHash)
    ? { targetRelativePath: ownerRelativePath, targetHash: ownerCapture.hash, targetContent: ownerBytes.toString('utf8') }
    : null;
}

function appendComparePackage(
  context: CompareIndexItemContext,
  prepared: PreparedCompareIndexPackage,
  members: LinkedDesignerPackageMember[],
  ownerDescriptorSnapshot: LinkedOwnerDescriptorSnapshot | undefined,
): void {
  const { item, state } = context;
  state.packages.push({
    packageId: packageIdFor(context.kind, item.identity.qualifiedName),
    action: item.action,
    kind: context.kind,
    qualifiedName: item.identity.qualifiedName,
    ...(context.ownerQualifiedName ? { ownerQualifiedName: context.ownerQualifiedName } : {}),
    ...(prepared.targetDirectoryWitness ? { targetDirectoryWitness: prepared.targetDirectoryWitness } : {}),
    ...(ownerDescriptorSnapshot ? { ownerDescriptorSnapshot } : {}),
    ...(context.isRootObject ? { rootRegistration: { rootTag: item.identity.metadataType, objectName: finalName(item.identity.qualifiedName) } } : {}),
    ...(context.ownerQualifiedName ? {
      ownerTargetRelativePath: canonicalRelativePath(
        state.input.leftInventory.rootPath,
        state.input.metadata.matches.find((match) => match.left.qualifiedName === context.ownerQualifiedName)?.left.filePath ?? ''
      ),
    } : {}),
    members,
  });
}

async function finalizeCompareIndex(state: CompareIndexState): Promise<LinkedDesignerCompareIndex> {
  const { input } = state;
  const rootConfigurationCapture = await captureRootConfigurationSnapshot(input.leftRootPath, input.rightRootPath);
  const rootConfiguration = rootConfigurationCapture.snapshot;
  const validPackages = filterRegisteredPackages(state.packages, rootConfiguration, state.diagnostics, state.blockedPresenceNodeIds);
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
    packages: validPackages,
    diagnostics: state.diagnostics,
    blockedPresenceNodeIds: state.blockedPresenceNodeIds,
    ...(rootConfiguration ? { rootConfiguration } : {}),
    ...(wholeObjectCopiesByNodeId.size > 0 ? { wholeObjectCopiesByNodeId } : {}),
  };
}

function filterRegisteredPackages(
  packages: readonly LinkedDesignerPackageRecipe[],
  rootConfiguration: LinkedDesignerRootConfigurationSnapshot | undefined,
  diagnostics: CompareMessage[],
  blockedPresenceNodeIds: Map<string, string>,
): LinkedDesignerPackageRecipe[] {
  for (const recipe of packages) {
    if (recipe.rootRegistration && !rootRegistrationIsAvailable(recipe, rootConfiguration)) {
      diagnostics.push(blocked(`Root Configuration.xml не подтверждает регистрацию пакета ${recipe.qualifiedName}.`, 'right-source', recipe.qualifiedName));
    }
  }
  return packages.filter((recipe) => {
    if (!recipe.rootRegistration || rootRegistrationIsAvailable(recipe, rootConfiguration)) {return true;}
    const nodeId = `fileObject:${recipe.action === 'copy' ? 'rightOnly' : 'leftOnly'}:${encodeURIComponent(recipe.qualifiedName)}`;
    blockedPresenceNodeIds.set(nodeId, 'Root Configuration.xml не подтверждает регистрацию Designer-пакета.');
    return false;
  });
}

export { bindLinkedDesignerPackageNodes } from './linkedDesignerPackageBinding';

function counterpartIdentity(
  metadata: MatchResult,
  qualifiedName: string,
  side: 'left' | 'right',
): MetadataIdentity | undefined {
  const candidates = [
    ...metadata.matches.map((match) => side === 'left' ? match.left : match.right),
    ...(side === 'left' ? metadata.unmatchedLeft : metadata.unmatchedRight),
  ].filter((identity) => identity.qualifiedName.normalize('NFC').toLocaleLowerCase('en-US') === qualifiedName.normalize('NFC').toLocaleLowerCase('en-US'));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function matchPackageArtifact(
  sourceArtifact: ArtifactUnit,
  _sourceObject: MetadataObjectUnit,
  targetArtifacts: readonly ArtifactUnit[],
  _targetObject: MetadataObjectUnit,
): ArtifactUnit | undefined {
  const normalized = normalizePath(sourceArtifact.relativePath);
  const matches = targetArtifacts.filter((artifact) => normalizePath(artifact.relativePath) === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

export { buildLinkedDesignerPackageReferenceIndex } from './linkedDesignerPackageReferenceIndex';
export { captureLinkedRootConfiguration, rootRegistrationIsAvailable } from './linkedDesignerRootConfiguration';
export type { RootConfigurationCapture } from './linkedDesignerRootConfiguration';
