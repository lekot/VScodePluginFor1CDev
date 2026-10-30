import * as path from 'path';
import { validateElementName } from '../../utils/elementNameValidator';

import type { CompareTreeNode } from '../compareTreeTypes';
import type { LinkedTemplateTypeTransition, LinkedTemplateTypeTransitionCandidate } from '../linkedDesignerTypes';
import { MISSING_TARGET_HASH, type MergeFileWitness } from '../merge/mergePreview';
import { captureMergePath } from '../merge/mergeSnapshot';
import { requiredLinkedDesignerBodyPath } from '../linkedDesignerPackageRules';
import { elementChildren, parseXmlDocument, textContent } from '../xml/xmlDom';
import { namespaceUriForName } from '../adapters/semanticXml/semanticXmlIdentity';
import { hashBuffer, stripHash, uniqueWitnesses } from '../linkedDesignerUtils';
import type { ExtensionCapturedFile, ExtensionIndexedObject, ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionSemanticSelection, ExtensionTransferRow } from './extensionTransfer';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';

export interface ExtensionLinkedTemplateTypeTransitionCandidate extends LinkedTemplateTypeTransitionCandidate {
  readonly targetDescriptorContent?: Buffer;
  readonly sourceDescriptorContent?: Buffer;
  readonly targetIdentity?: { readonly type: 'Template' | 'CommonTemplate'; readonly name: string; readonly uuid: string };
  readonly sourceIdentity?: { readonly type: 'Template' | 'CommonTemplate'; readonly name: string; readonly uuid: string };
}

/** Captures supported own TemplateType transitions within one matched CFE owner row. */
export async function captureExtensionLinkedTemplateTransitions(input: {
  readonly row: ExtensionTransferRow;
  readonly targetRoot: ExtensionMetadataIndex;
  readonly incomingRoot: ExtensionMetadataIndex;
}): Promise<readonly ExtensionLinkedTemplateTypeTransitionCandidate[]> {
  const { row, targetRoot, incomingRoot } = input;
  const targetOwner = row.target;
  const sourceOwner = row.incoming;
  if (!targetOwner || !sourceOwner || targetRoot.rootKind !== 'cfe' || incomingRoot.rootKind !== 'cfe'
      || targetOwner.identity?.ownership !== 'own' || sourceOwner.identity?.ownership !== 'own'
      || targetOwner.identity.type !== sourceOwner.identity.type
      || targetOwner.identity.uuid.toLowerCase() !== sourceOwner.identity.uuid.toLowerCase()
      || targetOwner.metadataType !== sourceOwner.metadataType
      || targetOwner.qualifiedName !== sourceOwner.qualifiedName) {
    return [];
  }

  const descriptorPairs: Array<{
    metadataType: 'Template' | 'CommonTemplate';
    qualifiedName: string;
    expectedName: string;
    expectedTargetUuid?: string;
    expectedSourceUuid?: string;
    targetPath: string;
    sourcePath: string;
    targetFile?: ExtensionCapturedFile;
    sourceFile?: ExtensionCapturedFile;
    rootTarget?: ExtensionIndexedObject;
    rootSource?: ExtensionIndexedObject;
    ownerTarget: ExtensionIndexedObject;
    ownerSource: ExtensionIndexedObject;
  }> = [];

  if (targetOwner.metadataType === 'CommonTemplate') {
    if (targetOwner.descriptorRelativePath && sourceOwner.descriptorRelativePath) {
      descriptorPairs.push({
        metadataType: 'CommonTemplate',
        qualifiedName: row.qualifiedName,
        expectedName: targetOwner.name,
        expectedTargetUuid: targetOwner.identity.uuid,
        expectedSourceUuid: sourceOwner.identity.uuid,
        targetPath: targetOwner.descriptorRelativePath,
        sourcePath: sourceOwner.descriptorRelativePath,
        rootTarget: targetOwner,
        rootSource: sourceOwner,
        ownerTarget: targetOwner,
        ownerSource: sourceOwner,
      });
    }
  } else {
    const targetNames = readDirectTemplateRegistrations(targetOwner);
    const sourceNames = readDirectTemplateRegistrations(sourceOwner);
    if (targetNames && sourceNames) {
      const sharedNames = [...new Set(targetNames.filter((name) => sourceNames.includes(name)))];
      for (const name of sharedNames) {
        if (!targetOwner.sidecarRelativePath || !sourceOwner.sidecarRelativePath) {continue;}
        const targetPath = `${targetOwner.sidecarRelativePath.replace(/\\/gu, '/')}/Templates/${name}.xml`;
        const sourcePath = `${sourceOwner.sidecarRelativePath.replace(/\\/gu, '/')}/Templates/${name}.xml`;
        const targetFiles = targetOwner.sidecarFiles.filter((file) => samePath(file.relativePath, targetPath));
        const sourceFiles = sourceOwner.sidecarFiles.filter((file) => samePath(file.relativePath, sourcePath));
        descriptorPairs.push({
          metadataType: 'Template',
          qualifiedName: `${row.qualifiedName}.Template.${name}`,
          expectedName: name,
          targetPath,
          sourcePath,
          ...(targetFiles.length === 1 ? { targetFile: targetFiles[0] } : {}),
          ...(sourceFiles.length === 1 ? { sourceFile: sourceFiles[0] } : {}),
          ownerTarget: targetOwner,
          ownerSource: sourceOwner,
        });
      }
    }
  }

  const result: ExtensionLinkedTemplateTypeTransitionCandidate[] = [];
  for (const pair of descriptorPairs) {
    const [targetDescriptor, sourceDescriptor] = await Promise.all([
      captureDescriptor(targetRoot, pair.targetPath, pair.rootTarget, pair.targetFile),
      captureDescriptor(incomingRoot, pair.sourcePath, pair.rootSource, pair.sourceFile),
    ]);
    const transitionId = `template-type-transition:${encodeURIComponent(pair.qualifiedName)}`;
    const targetInfo = targetDescriptor?.content ? readTemplateIdentity(targetDescriptor.content, pair.metadataType) : undefined;
    const sourceInfo = sourceDescriptor?.content ? readTemplateIdentity(sourceDescriptor.content, pair.metadataType) : undefined;
    if (!targetDescriptor || !sourceDescriptor) {
      continue;
    }
    if (!targetInfo || !sourceInfo) {
      result.push({
        transitionId,
        metadataType: pair.metadataType,
        qualifiedName: pair.qualifiedName,
        targetDescriptorRelativePath: pair.targetPath,
        sourceDescriptorRelativePath: pair.sourcePath,
        targetBodyRelativePaths: [],
        ...(targetDescriptor ? { targetDescriptorContent: targetDescriptor.content } : {}),
        ...(sourceDescriptor ? { sourceDescriptorContent: sourceDescriptor.content } : {}),
        reason: 'Дескриптор Template не прошёл проверку MDClasses identity; TemplateType доступен только для чтения.',
      });
      continue;
    }
    if (targetInfo.templateType === sourceInfo.templateType) {continue;}

    const targetBodyPath = requiredLinkedDesignerBodyPath('Template', pair.targetPath, targetDescriptor.content);
    const sourceBodyPath = requiredLinkedDesignerBodyPath('Template', pair.sourcePath, sourceDescriptor.content);
    const incomingTargetBodyPath = requiredLinkedDesignerBodyPath('Template', pair.targetPath, sourceDescriptor.content);
    const targetBodyRelativePaths = uniquePaths([targetBodyPath, incomingTargetBodyPath]);
    const blocker = (reason: string): void => {
      result.push({
        transitionId,
        metadataType: pair.metadataType,
        qualifiedName: pair.qualifiedName,
        targetDescriptorRelativePath: pair.targetPath,
        sourceDescriptorRelativePath: pair.sourcePath,
        targetTemplateType: targetInfo.templateType,
        incomingTemplateType: sourceInfo.templateType,
        targetBodyRelativePaths,
        targetDescriptorContent: targetDescriptor.content,
        sourceDescriptorContent: sourceDescriptor.content,
        targetIdentity: { type: pair.metadataType, name: targetInfo.name, uuid: targetInfo.uuid },
        sourceIdentity: { type: pair.metadataType, name: sourceInfo.name, uuid: sourceInfo.uuid },
        reason,
      });
    };
    if (targetInfo.name !== pair.expectedName || sourceInfo.name !== pair.expectedName
        || targetInfo.name !== sourceInfo.name || targetInfo.uuid.toLowerCase() !== sourceInfo.uuid.toLowerCase()
        || pair.expectedTargetUuid !== undefined && targetInfo.uuid.toLowerCase() !== pair.expectedTargetUuid.toLowerCase()
        || pair.expectedSourceUuid !== undefined && sourceInfo.uuid.toLowerCase() !== pair.expectedSourceUuid.toLowerCase()) {
      blocker('TemplateType нельзя связать: вложенные дескрипторы не имеют одной подтверждённой identity.');
      continue;
    }
    if (!targetBodyPath || !sourceBodyPath || !incomingTargetBodyPath) {
      blocker('TemplateType не имеет подтверждённого обязательного тела для обоих типов.');
      continue;
    }

    const [incomingSourceBody, oldTargetBody, incomingTargetBody] = await Promise.all([
      captureSourceBody(incomingRoot, pair.ownerSource, sourceBodyPath),
      captureTargetBody(targetRoot, pair.ownerTarget, targetBodyPath),
      captureTargetBody(targetRoot, pair.ownerTarget, incomingTargetBodyPath),
    ]);
    if (!incomingSourceBody || !oldTargetBody || !incomingTargetBody) {
      blocker('Обязательное тело одного из макетов отсутствует, неоднозначно или изменилось после compare.');
      continue;
    }

    const transition: LinkedTemplateTypeTransition = {
      transitionId,
      metadataType: pair.metadataType,
      qualifiedName: pair.qualifiedName,
      uuid: targetInfo.uuid,
      targetSourceId: targetRoot.sourceId,
      sourceId: incomingRoot.sourceId,
      targetDescriptorRelativePath: pair.targetPath,
      targetDescriptorHash: targetDescriptor.hash,
      sourceDescriptorRelativePath: pair.sourcePath,
      sourceDescriptorHash: sourceDescriptor.hash,
      targetTemplateType: targetInfo.templateType,
      incomingTemplateType: sourceInfo.templateType,
      oldTargetBodyRelativePath: targetBodyPath,
      oldTargetBodyHash: oldTargetBody.hash,
      incomingSourceBodyRelativePath: sourceBodyPath,
      incomingSourceBodyHash: incomingSourceBody.hash,
      incomingSourceBodyContent: incomingSourceBody.content,
      incomingTargetBodyRelativePath: incomingTargetBodyPath,
      incomingTargetBodyExpectedHash: incomingTargetBody.hash,
    };
    result.push({
      transitionId,
      metadataType: pair.metadataType,
      qualifiedName: pair.qualifiedName,
      targetDescriptorRelativePath: pair.targetPath,
      sourceDescriptorRelativePath: pair.sourcePath,
      targetTemplateType: targetInfo.templateType,
      incomingTemplateType: sourceInfo.templateType,
      targetBodyRelativePaths,
      targetDescriptorContent: targetDescriptor.content,
      sourceDescriptorContent: sourceDescriptor.content,
      targetIdentity: { type: pair.metadataType, name: targetInfo.name, uuid: targetInfo.uuid },
      sourceIdentity: { type: pair.metadataType, name: sourceInfo.name, uuid: sourceInfo.uuid },
      transition,
    });
  }
  return result;
}

/** Replaces one TemplateType leaf with its bundle while retaining its captured adapter factory. */
export function bindExtensionLinkedTemplateTransition(input: {
  readonly nodes: readonly CompareTreeNode[];
  readonly selections: Map<string, ExtensionSemanticSelection>;
  readonly candidate: ExtensionLinkedTemplateTypeTransitionCandidate;
  readonly targetRootPath: string;
}): CompareTreeNode[] {
  const scalarNodes = collectNodes(input.nodes).filter((node) => node.kind === 'xmlProperty'
    && node.label === 'TemplateType'
    && sameTargetPath(input.targetRootPath, node.mergeState?.targetFilePath ?? '', input.candidate.targetDescriptorRelativePath));
  const scalar = scalarNodes.length === 1 ? scalarNodes[0] : undefined;
  const scalarSelection = scalar ? input.selections.get(scalar.id) : undefined;
  const reason = input.candidate.reason
    ?? (scalarNodes.length !== 1 ? 'Связанное изменение TemplateType неоднозначно в XML-проекции.' : undefined)
    ?? (!scalarSelection ? 'TemplateType transition не имеет captured candidate factory.' : undefined);
  const nodeId = input.candidate.transitionId;
  const bundle: CompareTreeNode = {
    id: nodeId,
    label: `Тип макета и содержимое: ${input.candidate.targetTemplateType ?? scalar?.leftValue?.trim() ?? '?'} → ${input.candidate.incomingTemplateType ?? scalar?.rightValue?.trim() ?? '?'}`,
    kind: 'linkedTemplateTypeTransition',
    status: 'changed',
    leftValue: input.candidate.targetTemplateType ?? scalar?.leftValue,
    rightValue: input.candidate.incomingTemplateType ?? scalar?.rightValue,
    mergeable: !reason && Boolean(input.candidate.transition),
    payloadRef: `linkedTemplateType:${input.candidate.transitionId}`,
    mergeState: reason || !input.candidate.transition
      ? { state: 'blocked', reason: reason ?? 'Linked TemplateType capture отсутствует.', targetFilePath: input.candidate.targetDescriptorRelativePath }
      : { state: 'ready', targetFilePath: input.candidate.targetDescriptorRelativePath },
    children: scalar ? [{
      ...scalar,
      mergeable: false,
      destructive: undefined,
      mergeState: {
        state: 'readOnly',
        reason: 'TemplateType переносится только вместе с обязательным телом макета.',
        targetFilePath: input.candidate.targetDescriptorRelativePath,
      },
    }] : [],
  };

  let nodes = [...input.nodes];
  if (scalar) {nodes = replaceNode(nodes, scalar.id, bundle);}
  if (input.candidate.transition && scalar && !reason && scalarSelection) {
    input.selections.delete(scalar.id);
    const witnessList = transitionWitnesses(input.candidate.transition);
    input.selections.set(nodeId, {
      ...scalarSelection,
      nodeId,
      dependencyWitnesses: uniqueWitnesses([...(scalarSelection.dependencyWitnesses ?? []), ...witnessList]),
      linkedTemplateTypeTransition: input.candidate.transition,
    });
  }

  for (const bodyPath of input.candidate.targetBodyRelativePaths) {
    for (const [selectionId, selection] of input.selections) {
      if (!samePath(selection.targetRelativePath, bodyPath)) {continue;}
      input.selections.delete(selectionId);
    }
    nodes = disableBodyNodes(nodes, input.targetRootPath, bodyPath);
  }
  return nodes;
}

export function materializeExtensionLinkedTemplateTransition(
  transition: LinkedTemplateTypeTransition,
): { readonly write: { readonly relativePath: string; readonly content: Buffer; readonly sourceWitnesses: readonly MergeFileWitness[] }; readonly deletePath?: string } | { readonly reason: string } {
  if (hashBuffer(transition.incomingSourceBodyContent) !== stripHash(transition.incomingSourceBodyHash)) {
    return { reason: 'Захваченное тело incoming Template не совпадает с captured hash.' };
  }
  const sourceWitnesses = transitionWitnesses(transition);
  const deletePath = !samePath(transition.oldTargetBodyRelativePath, transition.incomingTargetBodyRelativePath)
      && transition.oldTargetBodyHash !== MISSING_TARGET_HASH
    ? transition.oldTargetBodyRelativePath
    : undefined;
  return {
    write: {
      relativePath: transition.incomingTargetBodyRelativePath,
      content: Buffer.from(transition.incomingSourceBodyContent),
      sourceWitnesses,
    },
    ...(deletePath ? { deletePath } : {}),
  };
}

function transitionWitnesses(transition: LinkedTemplateTypeTransition): MergeFileWitness[] {
  return uniqueWitnesses([
    { sourceId: transition.targetSourceId, relativePath: transition.targetDescriptorRelativePath, expectedHash: transition.targetDescriptorHash, kind: 'file' },
    { sourceId: transition.sourceId, relativePath: transition.sourceDescriptorRelativePath, expectedHash: transition.sourceDescriptorHash, kind: 'file' },
    { sourceId: transition.sourceId, relativePath: transition.incomingSourceBodyRelativePath, expectedHash: transition.incomingSourceBodyHash, kind: 'file' },
    { sourceId: transition.targetSourceId, relativePath: transition.oldTargetBodyRelativePath, expectedHash: transition.oldTargetBodyHash, kind: 'file' },
    { sourceId: transition.targetSourceId, relativePath: transition.incomingTargetBodyRelativePath, expectedHash: transition.incomingTargetBodyExpectedHash, kind: 'file' },
  ]);
}

async function captureDescriptor(
  root: ExtensionMetadataIndex,
  relativePath: string,
  object?: ExtensionIndexedObject,
  file?: ExtensionCapturedFile,
): Promise<{ readonly content: Buffer; readonly hash: string } | undefined> {
  const expectedHash = object?.descriptorHash ?? file?.hash;
  if (!expectedHash) {return undefined;}
  return captureExactFile(root, relativePath, expectedHash);
}

async function captureSourceBody(
  root: ExtensionMetadataIndex,
  owner: ExtensionIndexedObject,
  relativePath: string,
): Promise<{ readonly content: Buffer; readonly hash: string } | undefined> {
  const matches = owner.sidecarFiles.filter((file) => samePath(file.relativePath, relativePath));
  if (matches.length !== 1) {return undefined;}
  return captureExactFile(root, relativePath, matches[0]!.hash);
}

async function captureTargetBody(
  root: ExtensionMetadataIndex,
  owner: ExtensionIndexedObject,
  relativePath: string,
): Promise<{ readonly hash: string } | undefined> {
  const matches = owner.sidecarFiles.filter((file) => samePath(file.relativePath, relativePath));
  if (matches.length > 1) {return undefined;}
  const snapshot = await captureMergePath(path.join(root.canonicalRootPath ?? root.rootPath, relativePath), { retainContent: false }).catch(() => undefined);
  if (!snapshot) {return undefined;}
  if (snapshot.state === 'missing') {return matches.length === 0 ? { hash: MISSING_TARGET_HASH } : undefined;}
  if (snapshot.type !== 'file' || matches.length !== 1 || stripHash(matches[0]!.hash) !== stripHash(snapshot.hash)) {return undefined;}
  return { hash: stripHash(snapshot.hash) };
}

async function captureExactFile(
  root: ExtensionMetadataIndex,
  relativePath: string,
  expectedHash: string,
): Promise<{ readonly content: Buffer; readonly hash: string } | undefined> {
  const snapshot = await captureMergePath(path.join(root.canonicalRootPath ?? root.rootPath, relativePath), { retainContent: true }).catch(() => undefined);
  if (snapshot?.state !== 'file' || snapshot.contentBase64 === undefined || stripHash(snapshot.hash) !== stripHash(expectedHash)) {return undefined;}
  return { content: Buffer.from(snapshot.contentBase64, 'base64'), hash: stripHash(snapshot.hash) };
}

function readDirectTemplateRegistrations(owner: ExtensionIndexedObject): string[] | undefined {
  if (!owner.descriptorContent) {return undefined;}
  try {
    const root = parseXmlDocument(owner.descriptorContent.toString('utf8')).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return undefined;}
    const ownerElements = elementChildren(root);
    if (ownerElements.length !== 1 || ownerElements[0]!.localName !== owner.metadataType
        || namespaceUriForName(ownerElements[0]!) !== MDCLASSES_NAMESPACE) {return undefined;}
    const containers = elementChildren(ownerElements[0]!).filter((item) => item.localName === 'ChildObjects'
      && namespaceUriForName(item) === MDCLASSES_NAMESPACE);
    if (containers.length > 1) {return undefined;}
    if (containers.length === 0) {return [];}
    const values = elementChildren(containers[0]!).filter((item) => item.localName === 'Template'
      && namespaceUriForName(item) === MDCLASSES_NAMESPACE).map((item) => textContent(item).trim().normalize('NFC'));
    return values.every((value) => Boolean(value) && validateElementName(value, []) === null)
      && new Set(values).size === values.length ? values : undefined;
  } catch {
    return undefined;
  }
}

function readTemplateIdentity(
  content: Buffer,
  expectedType: 'Template' | 'CommonTemplate',
): { readonly name: string; readonly uuid: string; readonly templateType: string } | undefined {
  try {
    const root = parseXmlDocument(content.toString('utf8')).root;
    if (root.localName !== 'MetaDataObject' || namespaceUriForName(root) !== MDCLASSES_NAMESPACE) {return undefined;}
    const objects = elementChildren(root);
    if (objects.length !== 1 || objects[0]!.localName !== expectedType
        || namespaceUriForName(objects[0]!) !== MDCLASSES_NAMESPACE) {return undefined;}
    const properties = elementChildren(objects[0]!).filter((item) => item.localName === 'Properties'
      && namespaceUriForName(item) === MDCLASSES_NAMESPACE);
    if (properties.length !== 1) {return undefined;}
    const names = elementChildren(properties[0]!).filter((item) => item.localName === 'Name'
      && namespaceUriForName(item) === MDCLASSES_NAMESPACE);
    const types = elementChildren(properties[0]!).filter((item) => item.localName === 'TemplateType'
      && namespaceUriForName(item) === MDCLASSES_NAMESPACE);
    const uuid = objects[0]!.attributes.filter((item) => item.localName === 'uuid').map((item) => item.value.trim());
    if (names.length !== 1 || types.length !== 1 || uuid.length !== 1 || !uuid[0]) {return undefined;}
    const name = textContent(names[0]!).trim().normalize('NFC');
    const templateType = textContent(types[0]!).trim();
    if (!name || !templateType) {return undefined;}
    return { name, uuid: uuid[0]!, templateType };
  } catch {
    return undefined;
  }
}

function replaceNode(nodes: readonly CompareTreeNode[], nodeId: string, replacement: CompareTreeNode): CompareTreeNode[] {
  return nodes.map((node) => node.id === nodeId ? replacement : { ...node, children: replaceNode(node.children, nodeId, replacement) });
}

function disableBodyNodes(nodes: readonly CompareTreeNode[], targetRootPath: string, bodyPath: string): CompareTreeNode[] {
  return nodes.map((node) => {
    const targetPath = node.mergeState?.targetFilePath;
    if (targetPath && sameTargetPath(targetRootPath, targetPath, bodyPath)) {
      return {
        ...node,
        mergeable: false,
        mergeState: { state: 'readOnly', reason: 'Тело макета переносится только вместе с изменением TemplateType.', targetFilePath: targetPath },
        children: disableBodyNodes(node.children, targetRootPath, bodyPath),
      };
    }
    return { ...node, children: disableBodyNodes(node.children, targetRootPath, bodyPath) };
  });
}

function collectNodes(nodes: readonly CompareTreeNode[]): CompareTreeNode[] {
  return nodes.flatMap((node) => [node, ...collectNodes(node.children)]);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => path.normalize(value).replace(/\\/gu, '/');
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function sameTargetPath(targetRootPath: string, candidatePath: string, relativePath: string): boolean {
  const left = path.isAbsolute(candidatePath) ? candidatePath : path.join(targetRootPath, candidatePath);
  const right = path.isAbsolute(relativePath) ? relativePath : path.join(targetRootPath, relativePath);
  return samePath(left, right);
}

function uniquePaths(paths: readonly (string | undefined)[]): string[] {
  const result = new Map<string, string>();
  for (const item of paths) {
    if (!item) {continue;}
    const key = process.platform === 'win32' ? item.toLocaleLowerCase('en-US') : item;
    if (!result.has(key)) {result.set(key, item);}
  }
  return [...result.values()];
}
