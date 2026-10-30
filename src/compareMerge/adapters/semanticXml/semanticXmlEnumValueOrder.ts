import type { CompareTreeNode } from '../../compareTreeTypes';
import type { MergeCandidate } from '../../merge/mergePreview';
import { applyXmlPatch, hashXmlText, type XmlPatchPayload } from '../../xml/xmlPatch';
import { elementChildren, type XmlElement } from '../../xml/xmlDom';
import type { ExecutableCandidateFactory } from '../mergeAdapter';
import { elementDisplayName } from './semanticXmlAdapterLabels';
import type { CompareContext, IndexedChild, XmlElementNode } from './semanticXmlAdapter';
import { locationForElement } from './semanticXmlLocation';
import { expandedXmlName, namespaceUriForName } from './semanticXmlIdentity';
import { targetUri } from './semanticXmlAdapterUtils';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

export interface EnumValueOrderEntry {
  target: XmlElementNode;
  source: XmlElementNode;
  anchor?: XmlElementNode;
  sourceOrder: number;
}

/** True only for exact direct EnumValue participants in a supported descriptor namespace. */
export function isEnumValueOrderElement(element: XmlElementNode): boolean {
  const namespace = namespaceUriForName(element.dom) ?? '';
  const container = element.parent;
  const owner = container?.parent;
  return namespace === MDCLASSES_NAMESPACE &&
    element.name.split(':').pop() === 'EnumValue' && container?.name.split(':').pop() === 'ChildObjects' &&
    owner?.name.split(':').pop() === 'Enum' && owner.parent?.name.split(':').pop() === 'MetaDataObject' &&
    (namespaceUriForName(container!.dom) ?? '') === namespace &&
    (namespaceUriForName(owner.dom) ?? '') === namespace;
}

/** Enables scalar edits only for a uniquely addressable direct EnumValue in a native descriptor. */
export function isSupportedEnumValueStructure(element: XmlElementNode): boolean {
  if (!isEnumValueOrderElement(element)) {return false;}
  const container = element.parent!;
  const owner = container.parent!;
  const root = owner.parent!;
  const namespace = MDCLASSES_NAMESPACE;
  const ownerUuid = validUuid(owner.dom);
  const valueUuid = uniqueUuidKey(element, namespace);
  if (!ownerUuid || !valueUuid || expandedXmlName(root.dom) !== rootName(namespace) ||
      countEnumOwnerUuid(root.dom, ownerUuid, namespace) !== 1 ||
      elementChildren(root.dom).filter((child) => namespaceUriForName(child) === namespace).length !== 1 ||
      elementChildren(owner.dom).filter((child) => child.localName === 'ChildObjects' && namespaceUriForName(child) === namespace).length !== 1) {
    return false;
  }
  const siblingValues = elementChildren(container.dom).filter((child) => child.localName === 'EnumValue' && namespaceUriForName(child) === namespace);
  return siblingValues.filter((sibling) => uniqueUuidKeyFromDom(sibling, namespace) === valueUuid).length === 1;
}

export function projectEnumValueOrder(
  leftRoot: XmlElementNode,
  rightRoot: XmlElementNode,
  leftContainer: XmlElementNode,
  rightContainer: XmlElementNode,
): EnumValueOrderEntry[] | undefined {
  const namespace = namespaceUriForName(leftRoot.dom) ?? '';
  if (namespace !== MDCLASSES_NAMESPACE ||
      (namespaceUriForName(rightRoot.dom) ?? '') !== namespace ||
      expandedXmlName(leftRoot.dom) !== rootName(namespace) || expandedXmlName(rightRoot.dom) !== rootName(namespace) ||
      !isDirectEnumContainer(leftRoot, leftContainer, namespace) ||
      !isDirectEnumContainer(rightRoot, rightContainer, namespace)) {
    return undefined;
  }
  const leftOwner = leftContainer.parent!;
  const rightOwner = rightContainer.parent!;
  const leftOwnerUuid = validUuid(leftOwner.dom);
  const rightOwnerUuid = validUuid(rightOwner.dom);
  if (!leftOwnerUuid || !rightOwnerUuid || leftOwnerUuid.toLowerCase() !== rightOwnerUuid.toLowerCase() ||
      countEnumOwnerUuid(leftRoot.dom, leftOwnerUuid, namespace) !== 1 ||
      countEnumOwnerUuid(rightRoot.dom, rightOwnerUuid, namespace) !== 1) {
    return undefined;
  }
  const leftValues = uniqueEnumValues(leftContainer, namespace);
  const rightValues = uniqueEnumValues(rightContainer, namespace);
  if (!leftValues || !rightValues) {return undefined;}

  const commonRightOrder = rightValues.filter((entry) => leftValues.some((candidate) => candidate.key === entry.key));
  const commonLeftOrder = leftValues.filter((entry) => rightValues.some((candidate) => candidate.key === entry.key));
  if (commonRightOrder.length < 2 || commonRightOrder.every((entry, index) => entry.key === commonLeftOrder[index]?.key)) {
    return [];
  }

  const targetPosition = new Map(commonLeftOrder.map((entry, index) => [entry.key, index]));
  const sourcePositions = commonRightOrder.map((entry) => targetPosition.get(entry.key)!);
  const stationaryIndices = earliestSourceIncreasingSubsequence(sourcePositions);
  const stationary = new Set([...stationaryIndices].map((index) => commonRightOrder[index]!.key));
  const targetByKey = new Map(leftValues.map((entry) => [entry.key, entry.element]));
  const entries: EnumValueOrderEntry[] = [];
  for (const sourceEntry of commonRightOrder) {
    if (stationary.has(sourceEntry.key)) {continue;}
    const sourceIndex = rightContainer.children.indexOf(sourceEntry.element);
    let anchor: XmlElementNode | undefined;
    for (let index = sourceIndex + 1; index < rightContainer.children.length; index += 1) {
      const next = rightContainer.children[index]!;
      const nextKey = uniqueUuidKey(next, namespace);
      const targetAnchor = nextKey ? targetByKey.get(nextKey) : undefined;
      if (targetAnchor) {
        anchor = targetAnchor;
        break;
      }
    }
    entries.push({ target: targetByKey.get(sourceEntry.key)!, source: sourceEntry.element, anchor, sourceOrder: sourceIndex });
  }
  return entries;
}

export function enumValueOrderNodes(
  entries: readonly EnumValueOrderEntry[],
  leftContainer: XmlElementNode,
  context: CompareContext,
): CompareTreeNode[] {
  const owner = leftContainer.parent;
  const ownerName = owner ? elementDisplayName(owner) : 'Перечисление';
  return entries.map((entry) => {
    const location = locationForElement(entry.target);
    const nodeId = context.options.nodeIdPrefix + ':metadata-order:' + encodeURIComponent(location.pointer);
    context.candidateFactories.set(nodeId, candidateFactory(context, nodeId, () => makeMovePatch(entry, leftContainer, context)));
    return {
      id: nodeId,
      label: 'Порядок значения: ' + elementDisplayName(entry.source),
      kind: 'metadataOrderMove',
      status: 'changed',
      leftValue: `${ownerName} → позиция ${leftContainer.children.indexOf(entry.target) + 1}`,
      rightValue: entry.anchor
        ? `${ownerName} → перед ${elementDisplayName(entry.anchor)}`
        : `${ownerName} → в конец`,
      mergeable: true,
      payloadRef: 'xmlPatch:' + location.pointer,
      mergeState: { state: 'ready', targetFilePath: context.options.targetFilePath },
      children: [],
    };
  });
}

export function nonEnumOrderChanged(left: readonly IndexedChild[], right: readonly IndexedChild[]): boolean {
  const leftOther = left.filter((entry) => !isEnumValueOrderElement(entry.element));
  const rightOther = right.filter((entry) => !isEnumValueOrderElement(entry.element));
  const leftCommon = leftOther.map((entry) => entry.key).filter((key) => rightOther.some((entry) => entry.key === key));
  const rightCommon = rightOther.map((entry) => entry.key).filter((key) => leftOther.some((entry) => entry.key === key));
  return leftCommon.length > 1 && leftCommon.some((key, index) => key !== rightCommon[index]);
}

function candidateFactory(context: CompareContext, nodeId: string, buildPatch: () => XmlPatchPayload): ExecutableCandidateFactory {
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

function makeMovePatch(entry: EnumValueOrderEntry, container: XmlElementNode, context: CompareContext): XmlPatchPayload {
  const filePath = targetUri(context.options.targetFilePath);
  const targetLocation = locationForElement(entry.target);
  const containerLocation = locationForElement(container);
  const anchorLocation = entry.anchor ? locationForElement(entry.anchor) : undefined;
  const patch: XmlPatchPayload = {
    kind: 'moveNode',
    target: { filePath, ...targetLocation },
    destinationParent: { filePath, ...containerLocation },
    insertBefore: anchorLocation ? { filePath, ...anchorLocation } : undefined,
    insertPosition: anchorLocation ? undefined : 'append',
    insertOrder: entry.sourceOrder,
    orderScope: { kind: 'metadataChildObjects', elementKind: 'EnumValue' },
    expectedOldHash: context.expectedOldHash,
    newHash: '',
    semanticKind: 'metadataXml',
    sourceWitnesses: context.sourceWitnesses,
    semanticContext: context.semanticContext,
  };
  return { ...patch, newHash: hashXmlText(applyXmlPatch(context.input.snapshots.left, patch)) };
}

function isDirectEnumContainer(root: XmlElementNode, container: XmlElementNode, namespace: string): boolean {
  const owner = container.parent;
  const rootOwners = elementChildren(root.dom).filter((child) => namespaceUriForName(child) === namespace);
  return root.name.split(':').pop() === 'MetaDataObject' &&
    container.name.split(':').pop() === 'ChildObjects' && owner?.name.split(':').pop() === 'Enum' &&
    owner.parent === root && namespaceUriForName(container.dom) === (namespace || undefined) &&
    namespaceUriForName(owner.dom) === (namespace || undefined) &&
    rootOwners.length === 1 && rootOwners[0] === owner.dom &&
    elementChildren(owner.dom).filter((child) => child.localName === 'ChildObjects' && namespaceUriForName(child) === (namespace || undefined)).length === 1;
}

function uniqueEnumValues(container: XmlElementNode, namespace: string): { element: XmlElementNode; key: string }[] | undefined {
  const values = container.children.filter((element) => element.name.split(':').pop() === 'EnumValue' &&
    namespaceUriForName(element.dom) === (namespace || undefined));
  const seen = new Set<string>();
  const result: { element: XmlElementNode; key: string }[] = [];
  for (const element of values) {
    const key = uniqueUuidKey(element, namespace);
    if (!key || seen.has(key)) {return undefined;}
    seen.add(key);
    result.push({ element, key });
  }
  return result;
}

function uniqueUuidKey(element: XmlElementNode, namespace: string): string | undefined {
  if (namespaceUriForName(element.dom) !== (namespace || undefined)) {return undefined;}
  const uuid = validUuid(element.dom);
  return uuid ? `uuid=${uuid.toLowerCase()}` : undefined;
}

function uniqueUuidKeyFromDom(element: XmlElement, namespace: string): string | undefined {
  if (namespaceUriForName(element) !== namespace) {return undefined;}
  const uuid = validUuid(element);
  return uuid ? `uuid=${uuid.toLowerCase()}` : undefined;
}

function validUuid(element: XmlElement): string | undefined {
  const uuid = element.attributes.find((attribute) => attribute.name === 'uuid')?.value.trim();
  return uuid && UUID_PATTERN.test(uuid) ? uuid : undefined;
}

function countEnumOwnerUuid(root: XmlElement, uuid: string, namespace: string): number {
  let count = 0;
  const visit = (element: XmlElement): void => {
    if (element.localName === 'Enum' && namespaceUriForName(element) === (namespace || undefined) &&
        validUuid(element)?.toLowerCase() === uuid.toLowerCase()) {count += 1;}
    for (const child of elementChildren(element)) {visit(child);}
  };
  visit(root);
  return count;
}

export function earliestSourceIncreasingSubsequence(values: readonly number[]): Set<number> {
  const longestFrom = new Array<number>(values.length).fill(1);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    for (let next = index + 1; next < values.length; next += 1) {
      if (values[next]! > values[index]!) {
        longestFrom[index] = Math.max(longestFrom[index]!, 1 + longestFrom[next]!);
      }
    }
  }
  let remaining = Math.max(...longestFrom);
  let previous = Number.NEGATIVE_INFINITY;
  const selected = new Set<number>();
  for (let index = 0; index < values.length && remaining > 0; index += 1) {
    if (values[index]! > previous && longestFrom[index]! >= remaining) {
      selected.add(index);
      previous = values[index]!;
      remaining -= 1;
    }
  }
  return selected;
}

function rootName(namespace: string): string {
  return namespace ? `{${namespace}}MetaDataObject` : 'MetaDataObject';
}
