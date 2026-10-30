import type { CompareTreeNode, CompareTreeStatus } from '../../compareTreeTypes';
import type { ExecutableCandidateFactory, XmlPatchPayload } from '../mergeAdapter';
import type { MergeCandidate } from '../../merge/mergePreview';
import { compareCodeUnits } from '../../../utils/compareCodeUnits';
import { encodeXmlAddressComponent } from '../../xml/xmlAddress';
import { applyXmlPatch, hashXmlText } from '../../xml/xmlPatch';
import { captureXmlSubtree } from '../../xml/xmlDom';
import { isProtectedXmlAttribute, isSupportedAttributeNamespace } from './semanticXmlPolicy';
import { elementDisplayName } from './semanticXmlAdapterLabels';
import { isFormEventElement } from './semanticXmlSubtreeSafety';
import { metadataRegistrationLabel } from './semanticXmlMetadataRegistration';
import { shouldShowStatus, targetUri } from './semanticXmlAdapterUtils';
import type { CompareContext, XmlElementNode } from './semanticXmlAdapter';
import type { Location } from './semanticXmlLocation';
import type { XmlInsertionPosition } from './semanticXmlInsertion';
import type { SemanticXmlKind } from './semanticXmlValidator';

export function compareAttributes(
  left: XmlElementNode,
  right: XmlElementNode,
  parentLocation: Location,
  context: CompareContext
): CompareTreeNode[] {
  const names = [...new Set([...Object.keys(left.attributes), ...Object.keys(right.attributes)])].sort(compareCodeUnits);
  const result: CompareTreeNode[] = [];
  for (const name of names) {
    const leftValue = left.attributes[name];
    const rightValue = right.attributes[name];
    if (leftValue === rightValue) {continue;}
    const status: CompareTreeStatus = leftValue === undefined ? 'rightOnly' : rightValue === undefined ? 'leftOnly' : 'changed';
    if (!shouldShowStatus(status, context.input.strategy)) {continue;}
    const location: Location = {
      pointer: parentLocation.pointer + '/@' + encodeXmlAddressComponent(name),
      displayPath: parentLocation.displayPath + '/@' + name,
      identityKey: parentLocation.identityKey,
    };
    const attributeNode: XmlElementNode = {
      name: '@' + name,
      attributes: {},
      children: [],
      text: rightValue ?? leftValue ?? '',
      dom: right.dom,
      parent: right.parent,
    };
    result.push(
      isProtectedXmlAttribute(name, context.kind)
        ? readOnlyPropertyNode(attributeNode, status, location, context, 'Атрибут определяет идентичность или формат XML и не редактируется отдельно.')
        : !isSupportedAttributeNamespace(right.dom, name)
          ? readOnlyPropertyNode(attributeNode, status, location, context, 'Атрибут использует неподдерживаемое пространство имён и доступен только для чтения.')
        : propertyNode({ element: attributeNode, leftValue: leftValue ?? '', rightValue: rightValue ?? '', status, location, context })
    );
  }
  return result;
}

export function propertyNode(input: {
  element: XmlElementNode;
  leftValue: string;
  rightValue: string;
  status: CompareTreeStatus;
  location: Location;
  context: CompareContext;
  insertion?: XmlInsertionPosition;
}): CompareTreeNode {
  const id = input.context.options.nodeIdPrefix + ':property:' + encodeURIComponent(input.location.pointer);
  input.context.candidateFactories.set(id, candidateFactory(input.context, id, () => makePatch({
    element: input.element, rightValue: input.rightValue, status: input.status, location: input.location,
    context: input.context, insertion: input.insertion,
  })));
  return {
    id,
    label: isFormEventElement(input.element) ? elementDisplayName(input.element) : input.element.name,
    kind: 'xmlProperty',
    status: input.status,
    leftValue: input.leftValue,
    rightValue: input.rightValue,
    mergeable: true,
    destructive: input.status === 'leftOnly' ? true : undefined,
    payloadRef: 'xmlPatch:' + input.location.pointer,
    mergeState: { state: 'ready', targetFilePath: input.context.options.targetFilePath },
    children: [],
  };
}

export function readOnlyPropertyNode(
  element: XmlElementNode,
  status: CompareTreeStatus,
  location: Location,
  context: CompareContext,
  reason: string
): CompareTreeNode {
  return {
    id: context.options.nodeIdPrefix + ':property:' + encodeURIComponent(location.pointer),
    label: element.name,
    kind: 'xmlProperty',
    status,
    leftValue: status === 'leftOnly' ? element.text ?? '' : '',
    rightValue: status === 'rightOnly' || status === 'changed' ? element.text ?? '' : '',
    mergeable: false,
    payloadRef: 'xmlPatch:' + location.pointer,
    mergeState: { state: 'readOnly', reason, targetFilePath: context.options.targetFilePath },
    children: [],
  };
}

export function subtreeNode(
  element: XmlElementNode,
  status: 'leftOnly' | 'rightOnly',
  location: Location,
  context: CompareContext,
  depth: number,
  insertion?: XmlInsertionPosition,
  parent?: XmlElementNode
): CompareTreeNode {
  const id = context.options.nodeIdPrefix + ':element:' + encodeURIComponent(location.pointer);
  const linkedRegistration = Boolean(parent && isFileBackedMetadataRegistration(context.kind, element, parent));
  context.candidateFactories.set(id, candidateFactory(context, id, () => makePatch({
    element, rightValue: status === 'rightOnly' ? element.text ?? '' : '', status, location, context, insertion,
  })));
  return {
    id,
    label: linkedRegistration ? metadataRegistrationLabel(element) : elementDisplayName(element),
    kind: elementKind(context, element, parent, depth),
    status,
    leftValue: linkedRegistration && status === 'leftOnly' ? captureXmlSubtree(element.dom) : undefined,
    rightValue: linkedRegistration && status === 'rightOnly' ? captureXmlSubtree(element.dom) : undefined,
    mergeable: true,
    destructive: status === 'leftOnly' ? true : undefined,
    payloadRef: 'xmlPatch:' + location.pointer,
    mergeState: { state: 'ready', targetFilePath: context.options.targetFilePath },
    children: [],
  };
}

export function readOnlyNode(
  right: XmlElementNode,
  left: XmlElementNode | undefined,
  status: CompareTreeStatus,
  location: Location,
  context: CompareContext,
  depth: number,
  reason: string
): CompareTreeNode {
  return {
    id: context.options.nodeIdPrefix + ':element:' + encodeURIComponent(location.pointer),
    label: isFileBackedMetadataRegistration(context.kind, right, right.parent ?? right)
      ? metadataRegistrationLabel(right)
      : elementDisplayName(right),
    kind: elementKind(context, right, right.parent, depth),
    status,
    leftValue: left ? captureXmlSubtree(left.dom) : '',
    rightValue: status === 'leftOnly' ? '' : captureXmlSubtree(right.dom),
    mergeable: false,
    payloadRef: 'xmlPatch:' + location.pointer,
    mergeState: { state: 'readOnly', reason, targetFilePath: context.options.targetFilePath },
    children: [],
  };
}

export function readOnlyOrderNode(location: Location, context: CompareContext): CompareTreeNode {
  return {
    id: context.options.nodeIdPrefix + ':order:' + encodeURIComponent(location.pointer),
    label: 'Порядок XML-элементов',
    kind: 'xmlOrder',
    status: 'changed',
    mergeable: false,
    mergeState: {
      state: 'readOnly',
      reason: 'Переупорядочивание существующих XML-элементов не поддерживается.',
      targetFilePath: context.options.targetFilePath,
    },
    children: [],
  };
}

function candidateFactory(context: CompareContext, nodeId: string, buildPatch: () => XmlPatchPayload): ExecutableCandidateFactory {
  return async () => {
    const xmlPatch = buildPatch();
    const candidate: PlannedXmlMergeCandidate = {
      kind: xmlPatch.kind === 'replaceNode' ? 'xmlNodeReplace'
        : xmlPatch.kind === 'insertNode' ? 'xmlNodeInsert'
        : xmlPatch.kind === 'moveNode' ? 'xmlNodeMove'
        : 'xmlNodeDelete',
      sourceId: context.sourceId,
      snapshotId: context.snapshotId,
      nodeId,
      targetUri: targetUri(context.options.targetFilePath),
      previewEffect: xmlPatch.kind === 'moveNode' ? 'replace' : undefined,
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

function makePatch(input: {
  element: XmlElementNode;
  rightValue: string;
  status: CompareTreeStatus;
  location: Location;
  context: CompareContext;
  insertion?: XmlInsertionPosition;
}): XmlPatchPayload {
  const kind = input.status === 'rightOnly' ? 'insertNode' : input.status === 'leftOnly' ? 'deleteNode' : 'replaceNode';
  const isAttribute = input.location.pointer.split('/').pop()?.startsWith('@') ?? false;
  const replacementXml = kind === 'deleteNode' ? undefined
    : isAttribute ? input.rightValue : captureXmlSubtree(input.element.dom);
  const payload: XmlPatchPayload = {
    kind,
    target: {
      filePath: targetUri(input.context.options.targetFilePath),
      pointer: input.location.pointer,
      displayPath: input.location.displayPath,
      identityKey: input.location.identityKey,
    },
    destinationParent: input.insertion?.destinationParent,
    createDestinationChildObjects: input.insertion?.createDestinationChildObjects,
    createDestinationEvents: input.insertion?.createDestinationEvents,
    orderScope: input.insertion?.orderScope,
    expectedOldHash: input.context.expectedOldHash,
    newHash: '',
    replacementXml,
    insertBefore: input.insertion?.insertBefore,
    insertPosition: input.insertion?.insertPosition,
    insertOrder: input.insertion?.insertOrder,
    semanticKind: input.context.kind,
    sourceWitnesses: input.context.sourceWitnesses,
    semanticContext: input.context.semanticContext,
  };
  return { ...payload, newHash: hashXmlText(applyXmlPatch(input.context.input.snapshots.left, payload)) };
}

function isFileBackedMetadataRegistration(kind: SemanticXmlKind, element: XmlElementNode, parent: XmlElementNode): boolean {
  return kind === 'metadataXml' && parent.name.split(':').pop() === 'ChildObjects' &&
    ['Form', 'Template', 'Command'].includes(element.name.split(':').pop() ?? '');
}

function elementKind(context: CompareContext, element: XmlElementNode, parent: XmlElementNode | undefined, depth: number): string {
  return context.options.elementKind?.({ element, parent, depth }) ?? 'xmlElement';
}
