import * as path from 'path';

import type { CompareMessage } from '../domain/compareContracts';
import type { CompareSession } from '../domain/compareSession';
import type { CompareTreeNode } from '../compareTreeTypes';
import { throwIfCompareCancelled, type CompareCancellationToken } from '../compareCancellation';
import { metadataXmlAdapter } from '../adapters/xmlMetadataAdapter';
import type { AdapterCompareInput, ConfigurationInventory, MetadataObjectUnit } from '../adapters/mergeAdapter';
import { captureMergePath } from '../merge/mergeSnapshot';
import { elementChildren, parseXmlDocument, serializeXmlDocument, textContent, type XmlChildNode, type XmlElement } from '../xml/xmlDom';
import type { ExtensionMetadataIndex } from './extensionMetadataIndex';
import type { ExtensionRootPurposeSelection } from './extensionTransfer';

const ROOT_PURPOSE_NODE_ID = 'extension:root-purpose';
const CONFIGURATION_XML = 'Configuration.xml';
const VALID_PURPOSES = new Set(['Customization', 'Patch', 'AddOn']);

export interface ExtensionRootPurposeProjection {
  readonly node?: CompareTreeNode;
  readonly selection?: ExtensionRootPurposeSelection;
  readonly diagnostics: readonly CompareMessage[];
}

export async function projectExtensionRootPurpose(input: {
  target: ExtensionMetadataIndex;
  incoming: ExtensionMetadataIndex;
  session: CompareSession;
  globalBlockReason?: string;
  cancellation?: CompareCancellationToken;
}): Promise<ExtensionRootPurposeProjection> {
  const { target, incoming } = input;
  if (target.rootKind !== 'cfe' || incoming.rootKind !== 'cfe') {
    return { diagnostics: [] };
  }
  const valid = VALID_PURPOSES.has(target.purpose ?? '') && VALID_PURPOSES.has(incoming.purpose ?? '');
  if (valid && target.purpose === incoming.purpose) {return { diagnostics: [] };}

  const display = (value: string | undefined): string => value && VALID_PURPOSES.has(value)
    ? ({ Customization: 'Адаптация', Patch: 'Исправление', AddOn: 'Дополнение' } as const)[value as 'Customization' | 'Patch' | 'AddOn']
    : value ? `Недопустимое назначение: ${value}` : 'Не задано';
  const leftValue = display(target.purpose);
  const rightValue = display(incoming.purpose);
  const readOnly = (reason: string): ExtensionRootPurposeProjection => ({
    node: {
      id: ROOT_PURPOSE_NODE_ID,
      label: 'Назначение расширения',
      kind: 'extensionRootProperty',
      status: 'changed',
      leftValue,
      rightValue,
      mergeable: false,
      conflict: { kind: 'unsupported', message: reason, blocking: true },
      mergeState: { state: 'blocked', reason, targetFilePath: CONFIGURATION_XML },
      children: [],
    },
    diagnostics: [],
  });
  if (!valid) {
    return readOnly('Семантическое изменение назначения доступно только для двух CFE с поддерживаемыми значениями Customization, Patch или AddOn.');
  }
  if (input.globalBlockReason) {return readOnly(input.globalBlockReason);}

  const targetRoot = target.canonicalRootPath ?? target.rootPath;
  const incomingRoot = incoming.canonicalRootPath ?? incoming.rootPath;
  throwIfCompareCancelled(input.cancellation);
  const [targetSnapshot, sourceSnapshot] = await Promise.all([
    captureMergePath(path.join(targetRoot, CONFIGURATION_XML), { retainContent: true }),
    captureMergePath(path.join(incomingRoot, CONFIGURATION_XML), { retainContent: true }),
  ]);
  throwIfCompareCancelled(input.cancellation);
  if (targetSnapshot.state !== 'file' || sourceSnapshot.state !== 'file' ||
      targetSnapshot.hash !== target.configurationHash || sourceSnapshot.hash !== incoming.configurationHash ||
      targetSnapshot.contentBase64 === undefined || sourceSnapshot.contentBase64 === undefined) {
    return readOnly('Не удалось подтвердить исходные байты Configuration.xml для сравнения назначения.');
  }

  const targetObject = rootConfigurationObject(target, targetRoot);
  const sourceObject = rootConfigurationObject(incoming, incomingRoot);
  if (!targetObject || !sourceObject) {
    return readOnly('Configuration.xml не содержит проверяемую identity корневой конфигурации.');
  }
  const leftInventory = rootInventory(targetRoot, targetObject);
  const rightInventory = rootInventory(incomingRoot, sourceObject);
  const leftText = Buffer.from(targetSnapshot.contentBase64, 'base64').toString('utf8');
  const rawRightText = Buffer.from(sourceSnapshot.contentBase64, 'base64').toString('utf8');
  const rightText = alignRootIdentity(rawRightText, target.configurationUuid, target.configurationName);
  if (!rightText) {
    return readOnly('Не удалось выровнять только корневые identity-поля Configuration.xml для сравнения назначения.');
  }
  const compareInput: AdapterCompareInput = {
    strategy: 'full',
    leftInventory,
    rightInventory,
    match: { left: targetObject, right: sourceObject },
    session: input.session,
    artifactPaths: {
      left: path.join(targetRoot, CONFIGURATION_XML),
      right: path.join(incomingRoot, CONFIGURATION_XML),
    },
    snapshots: { left: leftText, right: rightText },
  };
  const result = await metadataXmlAdapter.compare(compareInput);
  throwIfCompareCancelled(input.cancellation);
  const purposeNodes = result.nodes.flatMap((node) => findNodes(node, 'ConfigurationExtensionPurpose'));
  if (purposeNodes.length !== 1 || !purposeNodes[0]!.mergeable) {
    const reason = result.diagnostics[0]?.suggestedAction ?? 'Назначение не представлено одним безопасно сопоставленным XML-свойством.';
    return readOnly(reason);
  }
  const node = purposeNodes[0]!;
  const candidateFactory = result.candidateFactories.get(node.id);
  if (!candidateFactory) {
    return readOnly('Не удалось подготовить проверяемое XML-изменение назначения.');
  }
  return {
    node: {
      id: ROOT_PURPOSE_NODE_ID,
      label: 'Назначение расширения',
      kind: 'extensionRootProperty',
      status: 'changed',
      leftValue,
      rightValue,
      mergeable: true,
      mergeState: { state: 'ready', targetFilePath: CONFIGURATION_XML },
      children: [],
    },
    selection: {
      nodeId: ROOT_PURPOSE_NODE_ID,
      targetHash: target.configurationHash!,
      sourceHash: incoming.configurationHash!,
      candidateFactory,
    },
    diagnostics: [],
  };
}

function rootConfigurationObject(index: ExtensionMetadataIndex, root: string): MetadataObjectUnit | undefined {
  if (!index.configurationUuid || !index.configurationName) {return undefined;}
  const descriptorPath = path.join(root, CONFIGURATION_XML);
  return {
    objectId: `${index.sourceId}:root-configuration`,
    qualifiedName: 'Configuration',
    metadataType: 'Configuration',
    uuid: index.configurationUuid,
    descriptorPath,
    containerPath: root,
  };
}

function rootInventory(rootPath: string, object: MetadataObjectUnit): ConfigurationInventory {
  return { rootPath, objects: [object], artifactsByObjectId: new Map([[object.objectId, []]]) };
}

function alignRootIdentity(source: string, uuid: string | undefined, name: string | undefined): string | undefined {
  if (!uuid || !name) {return undefined;}
  try {
    const document = parseXmlDocument(source);
    const configuration = elementChildren(document.root).find((element) => element.localName === 'Configuration');
    const uuidAttribute = configuration?.attributes.find((attribute) => attribute.localName === 'uuid');
    const properties = configuration && elementChildren(configuration).find((element) => element.localName === 'Properties');
    const nameElement = properties && elementChildren(properties).find((element) => element.localName === 'Name');
    if (!uuidAttribute || !nameElement || textContent(nameElement).trim() === '') {return undefined;}
    uuidAttribute.value = uuid;
    setText(nameElement, name);
    return serializeXmlDocument(document);
  } catch {
    return undefined;
  }
}

function setText(element: XmlElement, value: string): void {
  const children: XmlChildNode[] = [];
  let written = false;
  for (const child of element.children) {
    if (child.kind !== 'text') {children.push(child); continue;}
    if (written) {continue;}
    written = true;
    children.push({ kind: 'text', text: value });
  }
  if (!written) {children.unshift({ kind: 'text', text: value });}
  element.children = children;
}

function findNodes(node: CompareTreeNode, label: string): CompareTreeNode[] {
  return [...(node.label === label ? [node] : []), ...node.children.flatMap((child) => findNodes(child, label))];
}
