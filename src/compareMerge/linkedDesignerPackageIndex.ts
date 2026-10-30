import * as path from 'path';

import { captureMergePath, mergeSnapshotHash } from './merge/mergeSnapshot';
import { MISSING_TARGET_HASH } from './merge/mergePreview';
import { parseXmlDocument, elementChildren, textContent } from './xml/xmlDom';
import type { CompareMessage, MetadataIdentity, MatchResult } from './domain/compareContracts';
import type { ConfigurationInventory, MetadataObjectUnit, ArtifactUnit } from './inventory/configurationInventory';
import type { AdapterCompareResult } from './adapters/mergeAdapter';
import { namespaceUriForName } from './adapters/semanticXml/semanticXmlIdentity';
import type { CompareTreeNode } from './compareTreeTypes';
import { blocked, canonicalRelativePath, finalName, normalizeAbsolutePath, normalizePath, stripHash } from './linkedDesignerUtils';
import type { LinkedDesignerCompareIndex, LinkedDesignerKind, LinkedDesignerPackageRecipe, LinkedDesignerPackageMember, IndexedPackageObject, LinkedDesignerRootConfigurationSnapshot, LinkedOwnerDescriptorSnapshot } from './linkedDesignerTypes';
import { requiredLinkedDesignerBodyPath } from './linkedDesignerPackageRules';
import { findInventoryObjectByDescriptor } from './metadataObjectLookup';

const DESIGNER_TYPES = new Map<string, LinkedDesignerKind>([
  ['Form', 'Form'],
  ['Template', 'Template'],
  ['Command', 'Command'],
  ['CommonForm', 'Form'],
  ['CommonTemplate', 'Template'],
  ['CommonCommand', 'Command'],
]);

/** Builds package links only from uniquely indexed metadata and compare-time inventory hashes. */
export async function buildLinkedDesignerCompareIndex(input: {
  readonly metadata: MatchResult;
  readonly leftInventory: ConfigurationInventory;
  readonly rightInventory: ConfigurationInventory;
  readonly leftRootPath: string;
  readonly rightRootPath: string;
  readonly strategy: 'left' | 'right' | 'full';
}): Promise<LinkedDesignerCompareIndex> {
  const diagnostics: CompareMessage[] = [];
  const packages: LinkedDesignerPackageRecipe[] = [];
  const blockedPresenceNodeIds = new Map<string, string>();
  const seen = new Set<string>();
  const ownerDescriptorCache = new Map<string, LinkedOwnerDescriptorSnapshot | null>();
  const unmatched = [
    ...input.metadata.unmatchedRight.map((identity) => ({ identity, action: 'copy' as const })),
    ...(input.strategy === 'full'
      ? input.metadata.unmatchedLeft.map((identity) => ({ identity, action: 'delete' as const }))
      : []),
  ];
  const allIdentities = [
    ...input.metadata.matches.flatMap((match) => [match.left, match.right]),
    ...input.metadata.unmatchedLeft,
    ...input.metadata.unmatchedRight,
  ];
  const identityCounts = countIdentityNames(allIdentities);

  for (const item of unmatched) {
    const kind = DESIGNER_TYPES.get(item.identity.metadataType);
    if (!kind) {continue;}
    const isRootObject = item.identity.metadataType.startsWith('Common');
    const ownerQualifiedName = isRootObject ? undefined : nestedOwnerQualifiedName(item.identity);
    const presenceNodeId = fileObjectNodeIdForIdentity(item.identity, item.action);
    const presenceBlock = (message: string): void => { blockedPresenceNodeIds.set(presenceNodeId, message); };
    if (!isRootObject && (!ownerQualifiedName || !hasMatchedOwner(input.metadata, ownerQualifiedName))) {
      presenceBlock('Вложенный Designer-объект нельзя переносить отдельно от регистрации владельца.');
      continue;
    }
    presenceBlock('Linked Designer package не прошёл проверку захваченного inventory.');
    const identityKey = `${item.action}\0${item.identity.qualifiedName.toLocaleLowerCase('en-US')}`;
    const sourceIdentityKey = `${item.identity.sourceId}\0${item.identity.qualifiedName.normalize('NFC').toLocaleLowerCase('en-US')}`;
    if (seen.has(identityKey) || identityCounts.get(sourceIdentityKey) !== 1) {
      const message = 'Имя связанного Designer-пакета неоднозначно; обновите сравнение и устраните дубликаты.';
      diagnostics.push(blocked(message, item.identity.sourceId, item.identity.qualifiedName));
      presenceBlock(message);
      continue;
    }
    seen.add(identityKey);
    const sourceSide = item.action === 'copy' ? 'right' : 'left';
    const sourceInventory = sourceSide === 'right' ? input.rightInventory : input.leftInventory;
    const targetInventory = sourceSide === 'right' ? input.leftInventory : input.rightInventory;
    const indexed = findIndexedPackageObject(item.identity, sourceInventory);
    if (!indexed) {
      const message = 'Дескриптор связанного Designer-пакета отсутствует в captured inventory.';
      diagnostics.push(blocked(message, item.identity.sourceId, item.identity.qualifiedName));
      presenceBlock(message);
      continue;
    }
    const targetIdentity = item.action === 'copy'
      ? counterpartIdentity(input.metadata, item.identity.qualifiedName, 'left')
      : item.identity;
    if (item.action === 'copy' && targetIdentity?.uuid && item.identity.uuid
      && targetIdentity.uuid.toLocaleLowerCase('en-US') !== item.identity.uuid.toLocaleLowerCase('en-US')) {
      const message = 'В target уже существует Designer-объект с тем же именем и другим UUID; связанный перенос заблокирован.';
      diagnostics.push(blocked(message, item.identity.sourceId, item.identity.qualifiedName));
      presenceBlock(message);
      continue;
    }
    const targetObject = targetIdentity ? findInventoryObject(targetInventory, targetIdentity.filePath) : undefined;
    const sourceArtifacts = artifactsFor(indexed.inventory, indexed.object);
    const descriptor = sourceArtifacts.find((artifact) => artifact.kind === 'metadataXml' && samePath(artifact.filePath, item.identity.filePath));
    if (!descriptor) {
      const message = 'Дескриптор linked Designer-пакета отсутствует в captured inventory.';
      diagnostics.push(blocked(message, item.identity.sourceId, item.identity.qualifiedName));
      presenceBlock(message);
      continue;
    }
    const targetArtifacts = targetObject ? artifactsFor(targetInventory, targetObject) : [];
    const memberArtifacts = [descriptor, ...sourceArtifacts.filter((artifact) => artifact.kind !== 'metadataXml')];
    const descriptorSnapshot = await captureMergePath(descriptor.filePath, { retainContent: true }).catch(() => undefined);
    if (descriptorSnapshot?.state !== 'file' || descriptorSnapshot.hash !== stripHash(descriptor.contentHash) || !descriptorSnapshot.contentBase64) {
      const message = `Дескриптор Designer-пакета изменился после сравнения: ${descriptor.relativePath}`;
      diagnostics.push(blocked(message, item.identity.sourceId, item.identity.qualifiedName));
      presenceBlock(message);
      continue;
    }
    const requiredBodyPath = requiredLinkedDesignerBodyPath(
      kind,
      descriptor.relativePath,
      Buffer.from(descriptorSnapshot.contentBase64, 'base64'),
    );
    if (!requiredBodyPath || !memberArtifacts.some((artifact) => sameRelativePath(artifact.relativePath, requiredBodyPath))) {
      const message = `Пакет ${item.identity.qualifiedName} не содержит обязательный descriptor или точный sidecar: ${requiredBodyPath ?? 'тип тела не определён'}.`;
      diagnostics.push(blocked(message, item.identity.sourceId, item.identity.qualifiedName));
      presenceBlock(message);
      continue;
    }
    let targetDirectoryWitness: import('./merge/mergePreview').MergeFileWitness | undefined;
    if (item.action === 'delete') {
      const directoryRelativePath = canonicalRelativePath(sourceInventory.rootPath, indexed.object.containerPath);
      const directorySnapshot = directoryRelativePath
        ? await captureMergePath(path.join(sourceInventory.rootPath, ...directoryRelativePath.split('/')), { retainContent: false }).catch(() => undefined)
        : undefined;
      if (!directoryRelativePath || directorySnapshot?.state !== 'directory') {
        const message = `Каталог sidecar-пакета ${item.identity.qualifiedName} отсутствует или не подтверждён.`;
        diagnostics.push(blocked(message, item.identity.sourceId, item.identity.qualifiedName));
        presenceBlock(message);
        continue;
      }
      targetDirectoryWitness = {
        sourceId: item.identity.sourceId,
        relativePath: directoryRelativePath,
        expectedHash: mergeSnapshotHash(directorySnapshot),
        kind: 'directory',
      };
    }
    const members: LinkedDesignerPackageMember[] = [];
    let failed = false;
    for (const artifact of memberArtifacts) {
      const sourceRelativePath = canonicalRelativePath(sourceInventory.rootPath, artifact.filePath);
      if (!sourceRelativePath) {failed = true;break;}
      const targetRelativePath = item.action === 'copy'
        ? sourceRelativePath
        : canonicalRelativePath(sourceInventory.rootPath, artifact.filePath);
      if (!targetRelativePath) {failed = true;break;}
      const memberTargetArtifact = item.action === 'copy' && targetObject
        ? matchPackageArtifact(artifact, indexed.object, targetArtifacts, targetObject)
        : item.action === 'delete' ? artifact : undefined;
      const expectedTargetHash = memberTargetArtifact
        ? stripHash(memberTargetArtifact.contentHash)
        : MISSING_TARGET_HASH;
      let content: Buffer | undefined;
      if (item.action === 'copy') {
        const snapshot = samePath(artifact.filePath, descriptor.filePath)
          ? descriptorSnapshot
          : await captureMergePath(path.join(sourceInventory.rootPath, sourceRelativePath), { retainContent: true }).catch(() => undefined);
        if (snapshot?.state !== 'file' || snapshot.contentBase64 === undefined || snapshot.hash !== stripHash(artifact.contentHash)) {
          diagnostics.push(blocked(`Исходный Designer-файл изменился после сравнения: ${sourceRelativePath}`, item.identity.sourceId, item.identity.qualifiedName));
          failed = true;
          break;
        }
        content = Buffer.from(snapshot.contentBase64, 'base64');
      }
      members.push({
        targetRelativePath,
        ...(item.action === 'copy' ? { sourceRelativePath, sourceHash: stripHash(artifact.contentHash), content } : {}),
        expectedTargetHash,
        required: artifact.kind === 'metadataXml' || sameRelativePath(artifact.relativePath, requiredBodyPath),
      });
    }
    if (failed || (item.action === 'copy' && members.some((member) => member.required && (!member.sourceHash || !member.content)))) {
      presenceBlock('Не удалось захватить все обязательные файлы linked Designer-пакета.');
      continue;
    }
    let ownerDescriptorSnapshot: LinkedOwnerDescriptorSnapshot | undefined;
    if (ownerQualifiedName) {
      const ownerKey = normalizePath(ownerQualifiedName);
      if (!ownerDescriptorCache.has(ownerKey)) {
        const ownerMatch = input.metadata.matches.find((match) => match.left.qualifiedName === ownerQualifiedName);
        const ownerObject = ownerMatch ? findInventoryObject(input.leftInventory, ownerMatch.left.filePath) : undefined;
        const ownerDescriptor = ownerObject && artifactsFor(input.leftInventory, ownerObject)
          .find((artifact) => artifact.kind === 'metadataXml' && samePath(artifact.filePath, ownerObject.descriptorPath));
        const ownerRelativePath = ownerDescriptor && canonicalRelativePath(input.leftInventory.rootPath, ownerDescriptor.filePath);
        const ownerCapture = ownerRelativePath
          ? await captureMergePath(ownerDescriptor!.filePath, { retainContent: true }).catch(() => undefined)
          : undefined;
        const ownerBytes = ownerCapture?.state === 'file' && ownerCapture.contentBase64
          ? Buffer.from(ownerCapture.contentBase64, 'base64')
          : undefined;
        ownerDescriptorCache.set(ownerKey,
          ownerDescriptor && ownerRelativePath && ownerCapture?.state === 'file' && ownerBytes
            && ownerCapture.hash === stripHash(ownerDescriptor.contentHash)
            ? { targetRelativePath: ownerRelativePath, targetHash: ownerCapture.hash, targetContent: ownerBytes.toString('utf8') }
            : null
        );
      }
      const cached = ownerDescriptorCache.get(ownerKey);
      if (!cached) {
        const message = `Дескриптор владельца ${ownerQualifiedName} не удалось подтвердить для linked package.`;
        diagnostics.push(blocked(message, item.identity.sourceId, item.identity.qualifiedName));
        presenceBlock(message);
        continue;
      }
      ownerDescriptorSnapshot = cached;
    }
    const packageId = packageIdFor(kind, item.identity.qualifiedName);
    packages.push({
      packageId,
      action: item.action,
      kind,
      qualifiedName: item.identity.qualifiedName,
      ...(ownerQualifiedName ? { ownerQualifiedName } : {}),
      ...(targetDirectoryWitness ? { targetDirectoryWitness } : {}),
      ...(ownerDescriptorSnapshot ? { ownerDescriptorSnapshot } : {}),
      ...(isRootObject ? { rootRegistration: { rootTag: item.identity.metadataType, objectName: finalName(item.identity.qualifiedName) } } : {}),
      ...(ownerQualifiedName ? {
        ownerTargetRelativePath: canonicalRelativePath(
          input.leftInventory.rootPath,
          input.metadata.matches.find((match) => match.left.qualifiedName === ownerQualifiedName)?.left.filePath ?? ''
        ),
      } : {}),
      members,
    });
    blockedPresenceNodeIds.delete(presenceNodeId);
  }

  const rootConfiguration = await captureRootConfigurationSnapshot(input.leftRootPath, input.rightRootPath);
  for (const recipe of packages) {
    if (recipe.rootRegistration && !rootRegistrationIsAvailable(recipe, rootConfiguration)) {
      diagnostics.push(blocked(`Root Configuration.xml не подтверждает регистрацию пакета ${recipe.qualifiedName}.`, 'right-source', recipe.qualifiedName));
      continue;
    }
  }
  const validPackages = packages.filter((recipe) => {
    if (!recipe.rootRegistration || rootRegistrationIsAvailable(recipe, rootConfiguration)) {return true;}
    const nodeId = `fileObject:${recipe.action === 'copy' ? 'rightOnly' : 'leftOnly'}:${encodeURIComponent(recipe.qualifiedName)}`;
    blockedPresenceNodeIds.set(nodeId, 'Root Configuration.xml не подтверждает регистрацию Designer-пакета.');
    return false;
  });
  return { packages: validPackages, diagnostics, blockedPresenceNodeIds, ...(rootConfiguration ? { rootConfiguration } : {}) };
}

/** Associates enabled registration or object-presence nodes with their host-owned package recipes. */
export function bindLinkedDesignerPackageNodes(input: {
  readonly results: readonly AdapterCompareResult[];
  readonly packages: readonly LinkedDesignerPackageRecipe[];
  readonly blockedPresenceNodeIds?: ReadonlyMap<string, string>;
}): { packagesByNodeId: ReadonlyMap<string, LinkedDesignerPackageRecipe>; results: readonly AdapterCompareResult[] } {
  const packagesByNodeId = new Map<string, LinkedDesignerPackageRecipe>();
  const byOwnerAndRegistration = new Map<string, LinkedDesignerPackageRecipe[]>();
  for (const recipe of input.packages) {
    if (recipe.rootRegistration) {continue;}
    const key = `${normalizePath(recipe.ownerTargetRelativePath ?? '')}\0${recipe.kind}\0${finalName(recipe.qualifiedName).normalize('NFC').toLocaleLowerCase('en-US')}`;
    byOwnerAndRegistration.set(key, [...(byOwnerAndRegistration.get(key) ?? []), recipe]);
  }

  const nextResults = input.results.map((result) => ({
    ...result,
    nodes: [...result.nodes],
    candidateFactories: new Map(result.candidateFactories),
  }));
  for (const recipe of input.packages) {
    if (recipe.rootRegistration) {
      const status = recipe.action === 'copy' ? 'rightOnly' : 'leftOnly';
      const nodeId = `fileObject:${status}:${encodeURIComponent(recipe.qualifiedName)}`;
      const result = nextResults.find((item) => item.candidateFactories.has(nodeId) || findNode(item.nodes, nodeId));
      if (result && findNode(result.nodes, nodeId)) {
        packagesByNodeId.set(nodeId, recipe);
        recipe.registrationNodeId = nodeId;
      }
      continue;
    }
    const ownerRelative = recipe.ownerTargetRelativePath ?? '';
    const ownerKey = `${normalizePath(ownerRelative)}\0${recipe.kind}\0${finalName(recipe.qualifiedName).normalize('NFC').toLocaleLowerCase('en-US')}`;
    const candidate = nextResults
      .flatMap((result) => collectNodes(result.nodes))
      .find((node) => {
        if (!node.mergeable || node.kind !== 'xmlElement' || node.status !== (recipe.action === 'copy' ? 'rightOnly' : 'leftOnly')) {return false;}
        const xml = recipe.action === 'copy' ? node.rightValue : node.leftValue;
        const registration = readRegistration(xml, node.label, recipe.kind);
        const targetPath = node.mergeState?.targetFilePath;
        const relative = targetPath ? relativePathFromPackagePath(targetPath, recipe.ownerTargetRelativePath) : undefined;
        return registration?.kind === recipe.kind && registration.name.normalize('NFC').toLocaleLowerCase('en-US') === finalName(recipe.qualifiedName).normalize('NFC').toLocaleLowerCase('en-US') && relative !== undefined && normalizePath(relative) === normalizePath(ownerRelative);
      });
    if (candidate) {
      const duplicate = byOwnerAndRegistration.get(ownerKey) ?? [];
      if (duplicate.length === 1) {
        packagesByNodeId.set(candidate.id, recipe);
        recipe.registrationNodeId = candidate.id;
      }
    }
  }

  for (const result of nextResults) {
    result.nodes = result.nodes.filter((node) => {
      const recipe = input.packages.find((item) => !item.rootRegistration && (item.action === 'copy' ? node.id === fileObjectNodeId(item, 'rightOnly') : node.id === fileObjectNodeId(item, 'leftOnly')));
      if (!recipe) {return true;}
      result.candidateFactories.delete(node.id);
      return false;
    });
  }
  for (const [nodeId, reason] of input.blockedPresenceNodeIds ?? []) {
    for (const result of nextResults) {
      if (!findNode(result.nodes, nodeId)) {continue;}
      result.candidateFactories.delete(nodeId);
      result.nodes = result.nodes.map((node) => disableNode(node, nodeId, reason));
    }
  }
  return { packagesByNodeId, results: nextResults };
}

function disableNode(node: CompareTreeNode, id: string, reason: string): CompareTreeNode {
  if (node.id === id) {
    return { ...node, mergeable: false, conflict: { kind: 'unsupported', message: reason, blocking: true }, mergeState: { state: 'blocked', reason }, children: [] };
  }
  return { ...node, children: node.children.map((child) => disableNode(child, id, reason)) };
}

function fileObjectNodeIdForIdentity(identity: MetadataIdentity, action: 'copy' | 'delete'): string {
  return `fileObject:${action === 'copy' ? 'rightOnly' : 'leftOnly'}:${encodeURIComponent(identity.qualifiedName)}`;
}

function countIdentityNames(identities: readonly MetadataIdentity[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const identity of identities) {
    const key = `${identity.sourceId}\0${identity.qualifiedName.normalize('NFC').toLocaleLowerCase('en-US')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function nestedOwnerQualifiedName(identity: MetadataIdentity): string | undefined {
  const parts = identity.qualifiedName.split('.');
  if (parts.length < 4) {return undefined;}
  const nestedTypeIndex = parts.lastIndexOf(identity.metadataType);
  if (nestedTypeIndex < 2 || nestedTypeIndex !== parts.length - 2) {return undefined;}
  return parts.slice(0, nestedTypeIndex).join('.');
}

function hasMatchedOwner(metadata: MatchResult, ownerQualifiedName: string): boolean {
  return metadata.matches.some((match) =>
    match.left.qualifiedName === ownerQualifiedName && match.right.qualifiedName === ownerQualifiedName
  );
}

function findIndexedPackageObject(
  identity: MetadataIdentity,
  inventory: ConfigurationInventory,
): IndexedPackageObject | undefined {
  const object = findInventoryObject(inventory, identity.filePath);
  return object ? { identity, object, inventory } : undefined;
}

function findInventoryObject(inventory: ConfigurationInventory, descriptorPath: string): MetadataObjectUnit | undefined {
  return findInventoryObjectByDescriptor(inventory, descriptorPath);
}

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

function artifactsFor(inventory: ConfigurationInventory, object: MetadataObjectUnit): ArtifactUnit[] {
  return inventory.artifactsByObjectId.get(object.objectId) ?? [];
}

function samePath(left: string, right: string): boolean {
  const a = normalizeAbsolutePath(left);
  const b = normalizeAbsolutePath(right);
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

function sameRelativePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
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

function packageIdFor(kind: LinkedDesignerKind, qualifiedName: string): string {
  return `designer:${kind}:${encodeURIComponent(qualifiedName)}`;
}

function collectNodes(nodes: readonly CompareTreeNode[]): CompareTreeNode[] {
  const result: CompareTreeNode[] = [];
  for (const node of nodes) {
    result.push(node, ...collectNodes(node.children));
  }
  return result;
}

function findNode(nodes: readonly CompareTreeNode[], nodeId: string): CompareTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) {return node;}
    const nested = findNode(node.children, nodeId);
    if (nested) {return nested;}
  }
  return undefined;
}

function readRegistration(xml: string | undefined, label: string, expectedKind: LinkedDesignerKind): { kind: LinkedDesignerKind; name: string } | undefined {
  if (xml) {
    try {
      const root = parseXmlDocument(xml).root;
      const kind = root.localName;
      if (kind === 'Form' || kind === 'Template' || kind === 'Command') {
        return { kind, name: textContent(root).trim() };
      }
    } catch {
      // Some host projections expose only scalar text instead of the captured subtree.
    }
  }
  const kindMatch = /^(Form|Template|Command)\s*:\s*(.+)$/u.exec(label.trim());
  if (kindMatch) {return { kind: kindMatch[1] as LinkedDesignerKind, name: kindMatch[2]!.trim() };}
  // Semantic XML tree labels contain the exact metadata Name value; the package recipe
  // supplies the registration kind while this fallback binds by owner path and name.
  return label.trim() ? { kind: expectedKind, name: label.trim() } : undefined;
}

function relativePathFromPackagePath(targetPath: string, ownerRelativePath: string | undefined): string | undefined {
  if (!ownerRelativePath) {return undefined;}
  const normalizedTarget = normalizePath(targetPath);
  const normalizedOwner = normalizePath(ownerRelativePath);
  return normalizedTarget.endsWith(normalizedOwner) ? ownerRelativePath : undefined;
}

function fileObjectNodeId(recipe: LinkedDesignerPackageRecipe, status: 'leftOnly' | 'rightOnly'): string {
  return `fileObject:${status}:${encodeURIComponent(recipe.qualifiedName)}`;
}

async function captureRootConfigurationSnapshot(
  leftRootPath: string,
  rightRootPath: string,
): Promise<LinkedDesignerRootConfigurationSnapshot | undefined> {
  const [target, source] = await Promise.all([
    captureMergePath(path.join(leftRootPath, 'Configuration.xml'), { retainContent: true }),
    captureMergePath(path.join(rightRootPath, 'Configuration.xml'), { retainContent: true }),
  ]);
  if (target.state !== 'file' || source.state !== 'file' || !target.contentBase64 || !source.contentBase64) {return undefined;}
  const targetContent = Buffer.from(target.contentBase64, 'base64');
  const sourceContent = Buffer.from(source.contentBase64, 'base64');
  return {
    targetHash: target.hash,
    targetContent,
    sourceHash: source.hash,
    sourceContent,
    targetHasRegistrations: readRootRegistrations(targetContent),
    sourceHasRegistrations: readRootRegistrations(sourceContent),
  };
}

function readRootRegistrations(content: Buffer): Set<string> {
  try {
    const root = parseXmlDocument(content.toString('utf8')).root;
    const metadataNamespace = 'http://v8.1c.ru/8.3/MDClasses';
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== metadataNamespace) {return new Set();}
    const owners = elementChildren(root);
    if (owners.length !== 1 || owners[0]!.localName !== 'Configuration' || namespaceUriForName(owners[0]!) !== metadataNamespace) {return new Set();}
    const childContainers = elementChildren(owners[0]!).filter((element) => element.localName === 'ChildObjects' && namespaceUriForName(element) === metadataNamespace);
    if (childContainers.length !== 1) {return new Set();}
    const childObjects = childContainers[0]!;
    const result = new Set<string>();
    for (const parent of childObjects ? elementChildren(childObjects) : []) {
      if (namespaceUriForName(parent) !== metadataNamespace) {continue;}
      for (const item of elementChildren(parent)) {
        if (namespaceUriForName(item) !== metadataNamespace) {continue;}
        const value = textContent(item).trim();
        if (value) {result.add(`${parent.localName}\0${value}`);}
      }
      if (elementChildren(parent).length === 0) {
        const value = textContent(parent).trim();
        if (value) {result.add(`${parent.localName}\0${value}`);}
      }
    }
    return result;
  } catch {
    return new Set();
  }
}

export function rootRegistrationIsAvailable(
  recipe: LinkedDesignerPackageRecipe,
  snapshot: LinkedDesignerRootConfigurationSnapshot | undefined,
): boolean {
  if (!snapshot || !recipe.rootRegistration) {return false;}
  const key = `${recipe.rootRegistration.rootTag}\0${recipe.rootRegistration.objectName}`;
  return recipe.action === 'copy'
    ? snapshot.sourceHasRegistrations.has(key) && !snapshot.targetHasRegistrations.has(key)
    : snapshot.targetHasRegistrations.has(key) && !snapshot.sourceHasRegistrations.has(key);
}
