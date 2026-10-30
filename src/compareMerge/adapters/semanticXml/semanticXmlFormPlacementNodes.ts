import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type { CompareTreeNode } from '../../compareTreeTypes';
import type { MergeCandidate } from '../../merge/mergePreview';
import { applyXmlPatch, hashXmlText } from '../../xml/xmlPatch';
import type {
  AdapterCompareInput,
  ExecutableCandidateFactory,
  XmlPatchPayload,
} from '../mergeAdapter';
import type { XmlElementNode } from './semanticXmlAdapter';
import { locationForElement } from './semanticXmlLocation';
import type { FormPlacementEntry } from './semanticXmlFormPlacement';
import { localXmlName } from './semanticXmlIdentity';

export interface FormPlacementNodeContext {
  input: AdapterCompareInput;
  options: { nodeIdPrefix: string; targetFilePath: string };
  expectedOldHash: string;
  sourceId: string;
  snapshotId: string;
  candidateFactories: Map<string, ExecutableCandidateFactory>;
  sourceWitnesses: NonNullable<XmlPatchPayload['sourceWitnesses']>;
  semanticContext: XmlPatchPayload['semanticContext'];
}

export function formPlacementNode(
  placement: FormPlacementEntry,
  leftParent: XmlElementNode,
  context: FormPlacementNodeContext,
): CompareTreeNode {
  const location = locationForElement(placement.target);
  const id = context.options.nodeIdPrefix + ':placement:' + encodeURIComponent(location.pointer);
  const reason = placement.reason ?? (
    placement.destinationParent === leftParent ||
    (placement.createDestinationChildItems === true && placement.destinationOwner === leftParent)
      ? undefined
      : 'Контейнер назначения не совпадает с уникальным целевым ChildItems.'
  );
  if (reason) {
    return {
      id,
      label: 'Размещение: ' + displayName(placement.source),
      kind: 'formPlacement',
      status: 'changed',
      leftValue: currentPlacement(placement.target),
      rightValue: desiredPlacement(placement),
      mergeable: false,
      payloadRef: 'xmlPatch:' + location.pointer,
      mergeState: { state: 'readOnly', reason, targetFilePath: context.options.targetFilePath },
      children: [],
    };
  }

  context.candidateFactories.set(id, candidateFactory(context, id, () => makeMovePatch(placement, context)));
  return {
    id,
    label: 'Размещение: ' + displayName(placement.source),
    kind: 'formPlacement',
    status: 'changed',
    leftValue: currentPlacement(placement.target),
    rightValue: desiredPlacement(placement),
    mergeable: true,
    payloadRef: 'xmlPatch:' + location.pointer,
    mergeState: { state: 'ready', targetFilePath: context.options.targetFilePath },
    children: [],
  };
}

export function formPlacementContainerNode(
  sourceContainer: XmlElementNode,
  placements: readonly FormPlacementEntry[],
  context: FormPlacementNodeContext,
): CompareTreeNode {
  const location = locationForElement(sourceContainer);
  return {
    id: context.options.nodeIdPrefix + ':placement-container:' + encodeURIComponent(location.pointer),
    label: 'Элементы формы',
    kind: 'formChildItems',
    status: 'changed',
    mergeable: false,
    payloadRef: 'xmlPatch:' + location.pointer,
    mergeState: {
      state: 'readOnly',
      reason: 'Пустой контейнер ChildItems будет создан вместе с выбранным переносом.',
      targetFilePath: context.options.targetFilePath,
    },
    children: placements.map((placement) => formPlacementNode(placement, placement.destinationOwner!, context)),
  };
}

function candidateFactory(
  context: FormPlacementNodeContext,
  nodeId: string,
  buildPatch: () => XmlPatchPayload,
): ExecutableCandidateFactory {
  return async () => {
    const xmlPatch = buildPatch();
    const candidate: PlannedXmlMergeCandidate = {
      kind: 'xmlNodeMove',
      sourceId: context.sourceId,
      snapshotId: context.snapshotId,
      nodeId,
      targetUri: targetUri(context.options.targetFilePath),
      previewEffect: 'replace',
      expectedOldHash: xmlPatch.expectedOldHash,
      newHash: xmlPatch.newHash,
      xmlPatch,
    };
    return { ok: true, candidate };
  };
}

interface PlannedXmlMergeCandidate extends MergeCandidate {
  xmlPatch: XmlPatchPayload;
}

function makeMovePatch(placement: FormPlacementEntry, context: FormPlacementNodeContext): XmlPatchPayload {
  if (!placement.destinationParent && !placement.destinationOwner) {
    throw new Error('Form placement destination is not available');
  }
  const filePath = targetUri(context.options.targetFilePath);
  const destinationParent = placement.destinationParent
    ? xmlAddress(placement.destinationParent, filePath)
    : virtualChildItemsAddress(placement.destinationOwner!, filePath);
  const patch: XmlPatchPayload = {
    kind: 'moveNode',
    target: xmlAddress(placement.target, filePath),
    destinationParent,
    createDestinationChildItems: placement.createDestinationChildItems,
    insertBefore: placement.anchor ? xmlAddress(placement.anchor, filePath) : undefined,
    insertPosition: placement.anchor ? undefined : 'append',
    insertOrder: placement.sourceOrder,
    expectedOldHash: context.expectedOldHash,
    newHash: '',
    semanticKind: 'formXml',
    sourceWitnesses: context.sourceWitnesses,
    semanticContext: context.semanticContext,
  };
  return { ...patch, newHash: hashXmlText(applyXmlPatch(context.input.snapshots.left, patch)) };
}

function xmlAddress(element: XmlElementNode, filePath: string): NonNullable<XmlPatchPayload['target']> {
  return { filePath, ...locationForElement(element) };
}

function virtualChildItemsAddress(owner: XmlElementNode, filePath: string): NonNullable<XmlPatchPayload['target']> {
  const address = xmlAddress(owner, filePath);
  return {
    ...address,
    pointer: address.pointer + '/ChildItems[0]',
    displayPath: address.displayPath + '/ChildItems[0]',
    identityKey: undefined,
  };
}

function targetUri(filePath: string): string {
  const normalized = filePath.startsWith('file:') ? fileURLToPath(filePath) : filePath;
  return path.isAbsolute(normalized) ? pathToFileURL(normalized).toString() : normalized;
}

function displayName(element: XmlElementNode): string {
  const properties = element.children.find((child) => localXmlName(child.name) === 'Properties');
  const name = element.children.find((child) => localXmlName(child.name) === 'Name')?.text ??
    properties?.children.find((child) => localXmlName(child.name) === 'Name')?.text;
  return name ?? element.attributes.name ?? element.attributes.Name ?? element.attributes.id ??
    element.attributes.ID ?? element.attributes.uuid ?? element.attributes.UUID ?? element.name;
}

function currentPlacement(element: XmlElementNode): string {
  const container = element.parent;
  const owner = container?.parent;
  if (!container || !owner) {return '';}
  const siblings = container.children;
  const index = siblings.indexOf(element);
  return `${displayName(owner)} → позиция ${index + 1}`;
}

function desiredPlacement(placement: FormPlacementEntry): string {
  const sourceContainer = placement.source.parent;
  const owner = placement.destinationParent?.parent ?? placement.destinationOwner;
  if (!sourceContainer || !owner) {return '';}
  const ownerName = displayName(owner);
  if (placement.anchor && placement.anchor.parent === placement.destinationParent) {
    return `${ownerName} → перед ${displayName(placement.anchor)}`;
  }
  return `${ownerName} → позиция ${placement.sourceOrder + 1}`;
}
