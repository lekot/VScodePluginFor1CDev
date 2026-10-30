import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type { CompareTreeNode } from './compareTreeTypes';
import type { AdapterCompareResult } from './adapters/mergeAdapter';
import type { CompareMessage, MatchResult, MetadataIdentity } from './domain/compareContracts';
import type { ArtifactUnit, ConfigurationInventory } from './inventory/configurationInventory';
import { MISSING_TARGET_HASH, type MergeCandidate, type MergeFileWitness } from './merge/mergePreview';
import { captureMergePath } from './merge/mergeSnapshot';
import { elementChildren, parseXmlDocument, textContent } from './xml/xmlDom';
import { namespaceUriForName, attributeByLocalName } from './adapters/semanticXml/semanticXmlIdentity';
import { blocked, canonicalRelativePath, finalName, hashBuffer, normalizeAbsolutePath, normalizePath, stripHash, uniqueWitnesses } from './linkedDesignerUtils';
import { requiredLinkedDesignerBodyPath } from './linkedDesignerPackageRules';
import { createCapturedOutputCandidate } from './linkedDesignerPackageWrites';
import type {
  LinkedDesignerMaterializerContext,
  LinkedTemplateTypeTransition,
  LinkedTemplateTypeTransitionBinding,
  LinkedTemplateTypeTransitionCandidate,
} from './linkedDesignerTypes';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export async function captureLinkedTemplateTypeTransitions(input: {
  readonly metadata: MatchResult;
  readonly leftInventory: ConfigurationInventory;
  readonly rightInventory: ConfigurationInventory;
  readonly leftRootPath: string;
  readonly rightRootPath: string;
}): Promise<readonly LinkedTemplateTypeTransitionCandidate[]> {
  const result: LinkedTemplateTypeTransitionCandidate[] = [];
  for (const match of input.metadata.matches) {
    const metadataType = match.left.metadataType;
    if ((metadataType !== 'Template' && metadataType !== 'CommonTemplate')
      || match.right.metadataType !== metadataType
      || !sameQualifiedName(match.left.qualifiedName, match.right.qualifiedName)) {continue;}

    const targetDescriptorRelativePath = canonicalRelativePath(input.leftRootPath, match.left.filePath);
    const sourceDescriptorRelativePath = canonicalRelativePath(input.rightRootPath, match.right.filePath);
    if (!targetDescriptorRelativePath || !sourceDescriptorRelativePath) {continue;}

    const transitionId = `template-type-transition:${encodeURIComponent(match.left.qualifiedName)}`;
    const targetDescriptorArtifact = findDescriptorArtifact(input.leftInventory, match.left);
    const sourceDescriptorArtifact = findDescriptorArtifact(input.rightInventory, match.right);
    const [targetDescriptor, sourceDescriptor] = await Promise.all([
      captureDescriptor(match.left.filePath, targetDescriptorArtifact),
      captureDescriptor(match.right.filePath, sourceDescriptorArtifact),
    ]);
    const targetInfo = targetDescriptor?.content ? readTemplateIdentity(targetDescriptor.content) : undefined;
    const sourceInfo = sourceDescriptor?.content ? readTemplateIdentity(sourceDescriptor.content) : undefined;
    const fallbackTypes = { target: targetInfo?.templateType, incoming: sourceInfo?.templateType };
    const knownTargetPaths = uniquePaths([
      targetInfo && targetDescriptor
        ? requiredLinkedDesignerBodyPath('Template', targetDescriptorRelativePath, targetDescriptor.content)
        : undefined,
      sourceInfo && sourceDescriptor
        ? requiredLinkedDesignerBodyPath('Template', targetDescriptorRelativePath, sourceDescriptor.content)
        : undefined,
    ].filter((value): value is string => Boolean(value)));
    const blocker = (reason: string, bodyPaths: readonly string[] = []): void => {
      result.push({
        transitionId,
        metadataType,
        qualifiedName: match.left.qualifiedName,
        targetDescriptorRelativePath,
        sourceDescriptorRelativePath,
        ...(fallbackTypes.target ? { targetTemplateType: fallbackTypes.target } : {}),
        ...(fallbackTypes.incoming ? { incomingTemplateType: fallbackTypes.incoming } : {}),
        targetBodyRelativePaths: uniquePaths(bodyPaths),
        reason,
      });
    };

    if (!targetDescriptorArtifact || !sourceDescriptorArtifact || !targetDescriptor || !sourceDescriptor
      || !targetInfo || !sourceInfo) {
      blocker('Не удалось подтвердить оба дескриптора Template для связанного изменения типа.', knownTargetPaths);
      continue;
    }
    if (!matchesIdentity(targetInfo, match.left) || !matchesIdentity(sourceInfo, match.right)
      || targetInfo.metadataType !== metadataType || sourceInfo.metadataType !== metadataType) {
      blocker('Идентичность одного из дескрипторов Template не совпадает с captured metadata match.', knownTargetPaths);
      continue;
    }
    if (!match.left.uuid || !match.right.uuid || !sameIdentity(match.left.uuid, match.right.uuid)
      || !sameIdentity(targetInfo.uuid, sourceInfo.uuid)) {
      blocker('Для связанного изменения TemplateType требуется однозначная пара дескрипторов с одинаковым UUID.', knownTargetPaths);
      continue;
    }
    if (targetInfo.templateType === sourceInfo.templateType) {continue;}

    const oldTargetBodyRelativePath = requiredLinkedDesignerBodyPath('Template', targetDescriptorRelativePath, targetDescriptor.content);
    const incomingSourceBodyRelativePath = requiredLinkedDesignerBodyPath('Template', sourceDescriptorRelativePath, sourceDescriptor.content);
    const incomingTargetBodyRelativePath = requiredLinkedDesignerBodyPath('Template', targetDescriptorRelativePath, sourceDescriptor.content);
    if (!oldTargetBodyRelativePath || !incomingSourceBodyRelativePath || !incomingTargetBodyRelativePath) {
      blocker('Тип одного из макетов неизвестен; безопасно связать TemplateType с обязательным телом нельзя.', knownTargetPaths);
      continue;
    }

    const sourceBodyArtifact = findUniqueArtifact(input.rightInventory, match.right, incomingSourceBodyRelativePath);
    const [incomingBody, oldTargetBody, incomingTargetBody] = await Promise.all([
      captureSourceBody(input.rightRootPath, incomingSourceBodyRelativePath, sourceBodyArtifact),
      captureTargetBody(input.leftRootPath, oldTargetBodyRelativePath, input.leftInventory, match.left),
      captureTargetBody(input.leftRootPath, incomingTargetBodyRelativePath, input.leftInventory, match.left),
    ]);
    if (!sourceBodyArtifact || !incomingBody || !oldTargetBody || !incomingTargetBody) {
      blocker('Не удалось захватить или подтвердить точные исходное и целевое тела макета.', knownTargetPaths);
      continue;
    }

    const transition: LinkedTemplateTypeTransition = {
      transitionId,
      metadataType,
      qualifiedName: match.left.qualifiedName,
      uuid: targetInfo.uuid,
      targetSourceId: match.left.sourceId,
      sourceId: match.right.sourceId,
      targetDescriptorRelativePath,
      targetDescriptorHash: targetDescriptor.hash,
      sourceDescriptorRelativePath,
      sourceDescriptorHash: sourceDescriptor.hash,
      targetTemplateType: targetInfo.templateType,
      incomingTemplateType: sourceInfo.templateType,
      oldTargetBodyRelativePath,
      oldTargetBodyHash: oldTargetBody.expectedHash,
      incomingSourceBodyRelativePath,
      incomingSourceBodyHash: incomingBody.hash,
      incomingSourceBodyContent: incomingBody.content,
      incomingTargetBodyRelativePath,
      incomingTargetBodyExpectedHash: incomingTargetBody.expectedHash,
    };
    result.push({
      transitionId,
      metadataType,
      qualifiedName: match.left.qualifiedName,
      targetDescriptorRelativePath,
      sourceDescriptorRelativePath,
      targetTemplateType: targetInfo.templateType,
      incomingTemplateType: sourceInfo.templateType,
      targetBodyRelativePaths: uniquePaths([oldTargetBodyRelativePath, incomingTargetBodyRelativePath]),
      transition,
    });
  }
  return result;
}

export function bindLinkedTemplateTypeTransitionNodes(input: {
  readonly results: readonly AdapterCompareResult[];
  readonly candidates: readonly LinkedTemplateTypeTransitionCandidate[];
  readonly targetRootPath: string;
}): {
  readonly results: readonly AdapterCompareResult[];
  readonly transitionsByNodeId: ReadonlyMap<string, LinkedTemplateTypeTransitionBinding>;
} {
  const results = input.results.map((result) => ({
    ...result,
    nodes: [...result.nodes],
    candidateFactories: new Map(result.candidateFactories),
  }));
  const transitionsByNodeId = new Map<string, LinkedTemplateTypeTransitionBinding>();
  for (const candidate of input.candidates) {
    const descriptorPath = path.join(input.targetRootPath, ...candidate.targetDescriptorRelativePath.split('/'));
    const normalizedDescriptor = normalizeAbsolutePath(descriptorPath);
    const scalarMatches = results.flatMap((result) => collectNodes(result.nodes)
      .filter((node) => node.kind === 'xmlProperty' && node.label === 'TemplateType'
        && node.mergeState?.targetFilePath !== undefined
        && normalizeAbsolutePath(node.mergeState.targetFilePath) === normalizedDescriptor));
    const scalar = scalarMatches.length === 1 ? scalarMatches[0] : undefined;
    const scalarFactory = scalar
      ? results.find((result) => result.candidateFactories.has(scalar.id))?.candidateFactories.get(scalar.id)
      : undefined;
    const reason = candidate.reason ?? (scalarMatches.length !== 1
      ? 'Связанное изменение TemplateType неоднозначно в XML-проекции.'
      : !candidate.transition ? 'Не удалось подтвердить обязательные файлы linked Template.'
        : !scalarFactory ? 'Исходный TemplateType не имеет host-side XML candidate.' : undefined);
    const scalarNodeId = scalar?.id ?? `templateType:${candidate.transitionId}`;
    const bundleNodeId = candidate.transitionId;
    const displayTargetType = candidate.targetTemplateType ?? scalar?.leftValue?.trim() ?? '?';
    const displayIncomingType = candidate.incomingTemplateType ?? scalar?.rightValue?.trim() ?? '?';
    const bundleNode: CompareTreeNode = {
      id: bundleNodeId,
      label: `Тип макета и содержимое: ${displayTargetType} → ${displayIncomingType}`,
      kind: 'linkedTemplateTypeTransition',
      status: 'changed',
      leftValue: displayTargetType,
      rightValue: displayIncomingType,
      mergeable: !reason && Boolean(candidate.transition && scalar),
      payloadRef: `linkedTemplateType:${candidate.transitionId}`,
      mergeState: reason || !scalar
        ? { state: 'blocked', reason: reason ?? 'Узел TemplateType отсутствует в captured XML-проекции.', targetFilePath: descriptorPath }
        : { state: 'ready', targetFilePath: descriptorPath },
      children: scalar ? [{
        ...scalar,
        mergeable: false,
        destructive: undefined,
        mergeState: {
          state: 'readOnly',
          reason: 'TemplateType переносится только вместе с обязательным телом макета.',
          targetFilePath: descriptorPath,
        },
      }] : [],
    };

    for (const result of results) {
      result.nodes = replaceNodeWithBundle(result.nodes, scalarNodeId, bundleNode);
      if (scalar) {result.candidateFactories.delete(scalar.id);}
      for (const bodyPath of candidate.targetBodyRelativePaths) {
        const absolute = normalizeAbsolutePath(path.join(input.targetRootPath, ...bodyPath.split('/')));
        disableBodyNodes(result.nodes, absolute);
        for (const node of collectNodes(result.nodes)) {
          if (node.kind === 'fileArtifact' && node.mergeState?.targetFilePath
            && normalizeAbsolutePath(node.mergeState.targetFilePath) === absolute) {
            result.candidateFactories.delete(node.id);
          }
        }
      }
      if (candidate.transition && scalar && !reason && scalarFactory) {
        result.candidateFactories.set(bundleNodeId, scalarFactory);
        transitionsByNodeId.set(bundleNodeId, { nodeId: bundleNodeId, templateTypeNodeId: scalar.id, transition: candidate.transition });
      }
    }
  }
  return { results, transitionsByNodeId };
}

export function templateTransitionWitnesses(transition: LinkedTemplateTypeTransition): MergeFileWitness[] {
  return [
    { sourceId: transition.targetSourceId, relativePath: transition.targetDescriptorRelativePath, expectedHash: transition.targetDescriptorHash, kind: 'file' },
    { sourceId: transition.sourceId, relativePath: transition.sourceDescriptorRelativePath, expectedHash: transition.sourceDescriptorHash, kind: 'file' },
    { sourceId: transition.sourceId, relativePath: transition.incomingSourceBodyRelativePath, expectedHash: transition.incomingSourceBodyHash, kind: 'file' },
    { sourceId: transition.targetSourceId, relativePath: transition.oldTargetBodyRelativePath, expectedHash: transition.oldTargetBodyHash, kind: 'file' },
    { sourceId: transition.targetSourceId, relativePath: transition.incomingTargetBodyRelativePath, expectedHash: transition.incomingTargetBodyExpectedHash, kind: 'file' },
  ];
}

export async function materializeLinkedTemplateTypeTransition(input: {
  readonly context: LinkedDesignerMaterializerContext;
  readonly binding: LinkedTemplateTypeTransitionBinding;
  readonly scalarCandidate: MergeCandidate;
}): Promise<{ readonly candidates: readonly MergeCandidate[] } | { readonly diagnostic: CompareMessage }> {
  const { context, binding, scalarCandidate } = input;
  const transition = binding.transition;
  let scalarTargetPath = scalarCandidate.xmlPatch?.target.filePath ?? '';
  try {scalarTargetPath = fileURLToPath(scalarTargetPath);} catch { /* already a filesystem path */ }
  if (!scalarCandidate.xmlPatch
    || normalizeAbsolutePath(scalarTargetPath) !== normalizeAbsolutePath(
      path.join(context.targetRootPath, ...transition.targetDescriptorRelativePath.split('/'))
    )) {
    return { diagnostic: blocked('TemplateType bundle не содержит ожидаемый XML candidate для дескриптора.', context.sourceId, binding.nodeId) };
  }
  if (hashBuffer(transition.incomingSourceBodyContent) !== transition.incomingSourceBodyHash) {
    return { diagnostic: blocked('Захваченные байты тела Template не совпадают с inventory hash.', context.sourceId, binding.nodeId) };
  }
  const witnesses = uniqueWitnesses(templateTransitionWitnesses(transition));
  const sourceXmlWitnesses = witnesses.filter((witness) => witness.sourceId === transition.sourceId
    && witness.expectedHash !== MISSING_TARGET_HASH);
  const scalar: MergeCandidate = {
    ...scalarCandidate,
    nodeId: binding.nodeId,
    sourceWitnesses: uniqueWitnesses([...(scalarCandidate.sourceWitnesses ?? []), ...witnesses]),
    xmlPatch: {
      ...scalarCandidate.xmlPatch,
      sourceWitnesses: uniqueWitnesses([...(scalarCandidate.xmlPatch.sourceWitnesses ?? []), ...sourceXmlWitnesses]),
    },
  };
  const write = await createCapturedOutputCandidate(context, {
    nodeId: binding.nodeId,
    targetRelativePath: transition.incomingTargetBodyRelativePath,
    expectedTargetHash: transition.incomingTargetBodyExpectedHash,
    content: transition.incomingSourceBodyContent,
    witnesses,
  });
  const candidates: MergeCandidate[] = [scalar, { ...write, sourceWitnesses: witnesses }];
  if (!sameRelativePath(transition.oldTargetBodyRelativePath, transition.incomingTargetBodyRelativePath)
    && transition.oldTargetBodyHash !== MISSING_TARGET_HASH) {
    const oldPath = path.join(context.targetRootPath, ...transition.oldTargetBodyRelativePath.split('/'));
    const targetUri = pathToFileURL(oldPath).toString();
    candidates.push({
      kind: 'fileDelete',
      sourceId: context.sourceId,
      snapshotId: context.rightSnapshotId,
      nodeId: binding.nodeId,
      targetUri,
      expectedOldHash: transition.oldTargetBodyHash,
      sourceWitnesses: witnesses,
      fileOperation: {
        kind: 'fileDelete',
        targetPath: targetUri,
        expectedOldHash: transition.oldTargetBodyHash,
        destructive: true,
      },
    });
  }
  return { candidates };
}

function findDescriptorArtifact(inventory: ConfigurationInventory, identity: MetadataIdentity): ArtifactUnit | undefined {
  const object = inventory.objects.find((item) => normalizeAbsolutePath(item.descriptorPath) === normalizeAbsolutePath(identity.filePath));
  const matches = object ? inventory.artifactsByObjectId.get(object.objectId)?.filter((item) =>
    item.kind === 'metadataXml' && normalizeAbsolutePath(item.filePath) === normalizeAbsolutePath(identity.filePath)
  ) : [];
  return matches?.length === 1 ? matches[0] : undefined;
}

function findUniqueArtifact(inventory: ConfigurationInventory, identity: MetadataIdentity, relativePath: string): ArtifactUnit | undefined {
  const object = inventory.objects.find((item) => normalizeAbsolutePath(item.descriptorPath) === normalizeAbsolutePath(identity.filePath));
  const matches = object ? inventory.artifactsByObjectId.get(object.objectId)?.filter((item) => sameRelativePath(item.relativePath, relativePath)) : [];
  return matches?.length === 1 ? matches[0] : undefined;
}

async function captureDescriptor(filePath: string, artifact: ArtifactUnit | undefined): Promise<{ hash: string; content: Buffer } | undefined> {
  if (!artifact || normalizeAbsolutePath(artifact.filePath) !== normalizeAbsolutePath(filePath)) {return undefined;}
  const snapshot = await captureMergePath(filePath, { retainContent: true }).catch(() => undefined);
  if (snapshot?.state !== 'file' || !snapshot.contentBase64 || snapshot.hash !== stripHash(artifact.contentHash)) {return undefined;}
  return { hash: snapshot.hash, content: Buffer.from(snapshot.contentBase64, 'base64') };
}

async function captureSourceBody(
  rootPath: string,
  relativePath: string,
  artifact: ArtifactUnit | undefined,
): Promise<{ hash: string; content: Buffer } | undefined> {
  if (!artifact || !sameRelativePath(artifact.relativePath, relativePath)) {return undefined;}
  const snapshot = await captureMergePath(path.join(rootPath, ...relativePath.split('/')), { retainContent: true }).catch(() => undefined);
  if (snapshot?.state !== 'file' || !snapshot.contentBase64 || snapshot.hash !== stripHash(artifact.contentHash)) {return undefined;}
  return { hash: snapshot.hash, content: Buffer.from(snapshot.contentBase64, 'base64') };
}

async function captureTargetBody(
  rootPath: string,
  relativePath: string,
  inventory: ConfigurationInventory,
  identity: MetadataIdentity,
): Promise<{ expectedHash: string } | undefined> {
  const artifactMatches = inventory.objects
    .filter((object) => normalizeAbsolutePath(object.descriptorPath) === normalizeAbsolutePath(identity.filePath))
    .flatMap((object) => inventory.artifactsByObjectId.get(object.objectId) ?? [])
    .filter((artifact) => sameRelativePath(artifact.relativePath, relativePath));
  if (artifactMatches.length > 1) {return undefined;}
  const snapshot = await captureMergePath(path.join(rootPath, ...relativePath.split('/')), { retainContent: false }).catch(() => undefined);
  if (!snapshot) {return undefined;}
  if (snapshot.state === 'missing') {
    return artifactMatches.length === 0 ? { expectedHash: MISSING_TARGET_HASH } : undefined;
  }
  if (snapshot.state !== 'file' || artifactMatches.length !== 1 || snapshot.hash !== stripHash(artifactMatches[0]!.contentHash)) {return undefined;}
  return { expectedHash: snapshot.hash };
}

function readTemplateIdentity(content: Buffer): {
  metadataType: 'Template' | 'CommonTemplate'; name: string; uuid: string; templateType: string;
} | undefined {
  try {
    const root = parseXmlDocument(content.toString('utf8')).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return undefined;}
    const owners = elementChildren(root).filter((element) =>
      (element.localName === 'Template' || element.localName === 'CommonTemplate')
        && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    if (owners.length !== 1) {return undefined;}
    const owner = owners[0]!;
    const metadataType = owner.localName;
    const uuid = attributeByLocalName(owner, 'uuid');
    const properties = elementChildren(owner).filter((element) => element.localName === 'Properties'
      && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    if (!uuid || properties.length !== 1) {return undefined;}
    const names = elementChildren(properties[0]!).filter((element) => element.localName === 'Name'
      && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    const types = elementChildren(properties[0]!).filter((element) => element.localName === 'TemplateType'
      && namespaceUriForName(element) === MDCLASSES_NAMESPACE);
    if (names.length !== 1 || types.length !== 1) {return undefined;}
    const name = textContent(names[0]!).trim();
    const templateType = textContent(types[0]!).trim();
    if (!name || !templateType) {return undefined;}
    return { metadataType: metadataType as 'Template' | 'CommonTemplate', name, uuid, templateType };
  } catch {
    return undefined;
  }
}

function matchesIdentity(parsed: NonNullable<ReturnType<typeof readTemplateIdentity>>, identity: MetadataIdentity): boolean {
  return parsed.name.normalize('NFC') === finalName(identity.qualifiedName).normalize('NFC')
    && Boolean(identity.uuid) && sameIdentity(parsed.uuid, identity.uuid!);
}

function replaceNodeWithBundle(nodes: CompareTreeNode[], scalarNodeId: string, bundle: CompareTreeNode): CompareTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.id === scalarNodeId) {return [bundle];}
    const children = replaceNodeWithBundle(node.children, scalarNodeId, bundle);
    return children === node.children ? [node] : [{ ...node, children }];
  });
}

function disableBodyNodes(nodes: CompareTreeNode[], targetPath: string): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.mergeState?.targetFilePath && normalizeAbsolutePath(node.mergeState.targetFilePath) === targetPath
      && node.kind === 'fileArtifact') {
      nodes[index] = {
        ...node,
        mergeable: false,
        mergeState: { state: 'readOnly', reason: 'Тело макета переносится только вместе с TemplateType.', targetFilePath: node.mergeState.targetFilePath },
      };
    } else {
      const children = [...node.children];
      disableBodyNodes(children, targetPath);
      if (children.some((child, childIndex) => child !== node.children[childIndex])) {nodes[index] = { ...node, children };}
    }
  }
}

function collectNodes(nodes: readonly CompareTreeNode[]): CompareTreeNode[] {
  return nodes.flatMap((node) => [node, ...collectNodes(node.children)]);
}

function uniquePaths(values: readonly string[]): string[] {return [...new Set(values.map((value) => value.replace(/\\/gu, '/')))];}
function sameIdentity(left: string, right: string): boolean {return left.normalize('NFC').toLocaleLowerCase('en-US') === right.normalize('NFC').toLocaleLowerCase('en-US');}
function sameQualifiedName(left: string, right: string): boolean {return left.normalize('NFC') === right.normalize('NFC');}
function sameRelativePath(left: string, right: string): boolean {return normalizePath(left) === normalizePath(right);}
