import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { compareCodeUnits } from '../../../utils/compareCodeUnits';
import type { CompareTreeNode, CompareTreeStatus } from '../../compareTreeTypes';
import type { CompareMessage } from '../../domain/compareContracts';
import type { MergeCandidate } from '../../merge/mergePreview';
import { encodeXmlAddressComponent } from '../../xml/xmlAddress';
import {
  captureXmlSubtree,
  getXmlElementIdentityKey,
  parseXmlDocument as parseDomXmlDocument,
  type XmlElement,
} from '../../xml/xmlDom';
import { applyXmlPatch, hashXmlText } from '../../xml/xmlPatch';
import {
  expandedXmlName,
  localXmlName as localName,
  semanticXmlIdentityKey,
} from './semanticXmlIdentity';
import {
  HARD_DIAGNOSTIC_CODES,
  isProtectedXmlAttribute,
  isSupportedAttributeNamespace,
  isSupportedElementNamespace,
  isSupportedRootNamespace,
  isKnownMetadataStructure,
  QUALIFIER_NAMES,
} from './semanticXmlPolicy';
import { buildXmlSourceWitnesses } from './semanticXmlSourceWitnesses';
import {
  findIdentityMismatches,
  identityMismatchCode,
  identityMismatchMessage,
  isProtectedIdentityMismatch,
  isProtectedLeaf,
} from './semanticXmlIdentityPolicy';
import {
  isMetadataObjectRefItem,
  knownRootPropertyReferencesInXml,
  metadataReferenceFromType,
  metadataReferencesInSubsystemContent,
} from './semanticXmlMetadataReferences';
import { hasMetadataSiblingNameCollision } from './semanticXmlMetadataIdentity';
import { hasUnsupportedChangedAttributes, isFormEventElement, unsupportedSubtreeReason, wrapXmlElement } from './semanticXmlSubtreeSafety';
import { validateSemanticXmlMerge, type SemanticXmlKind } from './semanticXmlValidator';
import type {
  AdapterCompareInput,
  AdapterCompareResult,
  ExecutableCandidateFactory,
  MergeAdapter,
  MetadataObjectUnit,
  XmlPatchPayload,
} from '../mergeAdapter';

const FALLBACK_RIGHT_SOURCE_ID = 'right-source';

export interface XmlElementNode {
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: readonly XmlElementNode[];
  text?: string;
  dom: XmlElement;
  parent?: XmlElementNode;
}

export interface XmlElementKindInput {
  element: XmlElementNode;
  parent?: XmlElementNode;
  depth: number;
}

export interface XmlAdapterProjectionOptions {
  adapterKind: string;
  rootLabel: string;
  rootKind: string;
  nodeIdPrefix: string;
  targetFilePath: string;
  sourceFilePath?: string;
  semanticKind?: SemanticXmlKind;
  elementKind?: (input: XmlElementKindInput) => string;
  knownComplexElement?: (input: XmlElementKindInput) => boolean;
}

interface Location {
  pointer: string;
  displayPath: string;
  identityKey?: string;
}

interface IndexedChild {
  element: XmlElementNode;
  selector: string;
  key: string;
  position: number;
}

interface InsertionPosition {
  insertBefore?: XmlPatchPayload['insertBefore'];
  insertPosition?: XmlPatchPayload['insertPosition'];
  insertOrder?: number;
}

interface CompareContext {
  input: AdapterCompareInput;
  options: XmlAdapterProjectionOptions;
  kind: SemanticXmlKind;
  expectedOldHash: string;
  sourceId: string;
  snapshotId: string;
  leftRoot: XmlElementNode;
  candidateFactories: Map<string, ExecutableCandidateFactory>;
  diagnostics: CompareMessage[];
  sourceWitnesses: NonNullable<XmlPatchPayload['sourceWitnesses']>;
  semanticContext: XmlPatchPayload['semanticContext'];
}

export const metadataXmlAdapter: MergeAdapter = {
  kind: 'metadataXml',
  async compare(input: AdapterCompareInput): Promise<AdapterCompareResult> {
    return buildXmlAdapterResult(input, {
      adapterKind: 'metadataXml',
      rootLabel: 'Descriptor XML',
      rootKind: 'metadataXml',
      nodeIdPrefix: 'metadataXml',
      targetFilePath: targetDescriptorPath(input.match.left, input.match.right),
      sourceFilePath: input.match.right?.descriptorPath,
      semanticKind: 'metadataXml',
      knownComplexElement: ({ element, parent }) => {
        const name = localName(element.name);
        if (name === 'Content') {
          return localName(parent?.name ?? '') === 'Properties' && localName(parent?.parent?.name ?? '') === 'Subsystem';
        }
        if (name === 'Item') {
          return localName(parent?.name ?? '') === 'Content' && isMetadataObjectRefItem(element.dom);
        }
        return isKnownMetadataStructure(name);
      },
    });
  },
};

export function buildXmlAdapterResult(
  input: AdapterCompareInput,
  requestedOptions: XmlAdapterProjectionOptions
): AdapterCompareResult {
  const targetFilePath = localFilePath(input.artifactPaths?.left ?? requestedOptions.targetFilePath);
  const sourcePath = input.artifactPaths?.right ?? requestedOptions.sourceFilePath;
  const sourceFilePath = sourcePath ? localFilePath(sourcePath) : undefined;
  const options = {
    ...requestedOptions,
    targetFilePath,
    sourceFilePath,
    nodeIdPrefix: stableNodePrefix(requestedOptions.nodeIdPrefix, targetFilePath),
  };
  const factories = new Map<string, ExecutableCandidateFactory>();
  const diagnostics: CompareMessage[] = [];
  const kind = options.semanticKind ?? semanticKind(options.adapterKind);
  let left: XmlElementNode;
  let right: XmlElementNode;
  try {
    left = wrapXmlElement(parseDomXmlDocument(input.snapshots.left).root);
    right = wrapXmlElement(parseDomXmlDocument(input.snapshots.right).root);
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'XML_ADAPTER_PARSE_FAILED',
      phase: 'compare',
      sourceId: rightSourceId(input),
      path: targetFilePath,
      blocking: true,
      suggestedAction: error instanceof Error ? error.message : String(error),
    });
    return { nodes: [], candidateFactories: factories, diagnostics };
  }

  const expectedRoot = kind === 'metadataXml' ? 'MetaDataObject' : kind === 'formXml' ? 'Form' : 'PredefinedData';
  if (localName(left.name) !== expectedRoot || localName(right.name) !== expectedRoot ||
    !isSupportedRootNamespace(left.dom, kind) || !isSupportedRootNamespace(right.dom, kind)) {
    diagnostics.push({
      severity: 'error',
      code: 'XML_ROOT_KIND_MISMATCH',
      phase: 'compare',
      sourceId: rightSourceId(input),
      path: targetFilePath,
      blocking: true,
      suggestedAction: 'Корневой элемент XML не соответствует типу сравниваемого артефакта.',
    });
    return { nodes: [], candidateFactories: factories, diagnostics };
  }

  const semanticContext = input.semanticValidationContext ?? {};
  const semanticErrors = [
    ...validateSemanticXmlMerge(input.snapshots.left, kind, semanticContext).diagnostics,
    ...validateSemanticXmlMerge(input.snapshots.right, kind, { ...semanticContext, baselineSource: input.snapshots.left }).diagnostics,
  ].filter((item) => HARD_DIAGNOSTIC_CODES.has(item.code));
  for (const item of semanticErrors) {
    diagnostics.push({
      severity: 'error',
      code: item.code,
      phase: 'compare',
      sourceId: rightSourceId(input),
      path: targetFilePath,
      blocking: true,
      suggestedAction: item.message + (item.pointer ? ' XML-узел: ' + item.pointer : ''),
    });
  }

  const identityErrors = findIdentityMismatches(left, right, kind);
  for (const message of identityErrors) {
    diagnostics.push({
      severity: 'error',
      code: identityMismatchCode(kind),
      phase: 'compare',
      sourceId: rightSourceId(input),
      path: targetFilePath,
      blocking: true,
      suggestedAction: message,
    });
  }
  if (semanticErrors.length > 0 || identityErrors.length > 0) {
    return { nodes: [], candidateFactories: factories, diagnostics };
  }

  const witnesses = buildXmlSourceWitnesses(
    input,
    { left: options.targetFilePath, right: options.sourceFilePath },
    kind,
    kind === 'metadataXml' || kind === 'formXml' ? metadataReferencesInXml(left, right) : []
  );
  const context: CompareContext = {
    input,
    options,
    kind,
    expectedOldHash: hashXmlText(input.snapshots.left),
    sourceId: rightSourceId(input),
    snapshotId: rightSnapshotId(input),
    leftRoot: left,
    candidateFactories: factories,
    diagnostics,
    sourceWitnesses: witnesses.sourceWitnesses,
    semanticContext: witnesses.semanticContext,
  };
  const children = compareChildren(left, right, locationForRoot(left), context, 1);
  if (children.length === 0) {
    return { nodes: [], candidateFactories: factories, diagnostics };
  }
  return {
    nodes: [{
      id: options.nodeIdPrefix + ':root',
      label: options.rootLabel,
      kind: options.rootKind,
      status: children.some((child) => child.status !== 'equal') ? 'changed' : 'equal',
      children,
    }],
    candidateFactories: factories,
    diagnostics,
  };
}

export function parseXmlDocument(source: string): XmlElementNode {
  return wrapXmlElement(parseDomXmlDocument(source).root);
}

export function childText(element: XmlElementNode | undefined, childName: string): string | undefined {
  return element?.children.find((child) => localName(child.name) === childName)?.text;
}

export function elementDisplayName(element: XmlElementNode): string {
  const properties = element.children.find((child) => localName(child.name) === 'Properties');
  return childText(element, 'Name') ??
    childText(properties, 'Name') ??
    element.attributes.name ??
    element.attributes.Name ??
    element.attributes.id ??
    element.attributes.ID ??
    element.attributes.uuid ??
    element.attributes.UUID ??
    element.name;
}

function compareChildren(
  leftParent: XmlElementNode,
  rightParent: XmlElementNode,
  parentLocation: Location,
  context: CompareContext,
  depth: number
): CompareTreeNode[] {
  const leftIndex = indexChildren(leftParent.children, leftParent, context.kind);
  const rightIndex = indexChildren(rightParent.children, rightParent, context.kind);
  const keys = [
    ...rightIndex.ordered.map((item) => item.key),
    ...leftIndex.ordered.map((item) => item.key).filter((key) => !rightIndex.map.has(key)),
  ];
  const nodes = compareAttributes(leftParent, rightParent, parentLocation, context);
  for (const key of keys) {
    const l = leftIndex.map.get(key);
    const r = rightIndex.map.get(key);
    const element = r?.element ?? l?.element;
    if (!element) {
      continue;
    }
    const status: CompareTreeStatus = !l ? 'rightOnly' : !r ? 'leftOnly' : 'changed';
    if (!shouldShowStatus(status, context.input.strategy)) {
      continue;
    }
    if (!l && r && context.kind === 'metadataXml' && hasMetadataSiblingNameCollision(leftParent.dom, r.element.dom)) {
      nodes.push(readOnlyNode(
        r.element,
        undefined,
        status,
        childLocation(parentLocation, r.element, r.selector),
        context,
        depth,
        'В целевом списке уже есть объект того же типа с таким именем и другим UUID; добавление создаст неоднозначную идентичность.'
      ));
      continue;
    }
    const node = compareElement({
      left: l?.element,
      right: r?.element,
      parent: rightParent,
      location: childLocation(parentLocation, element, l?.selector ?? r?.selector ?? '0'),
      status,
      insertion: !l && r ? insertionPosition(rightParent, r.element, context) : undefined,
      context,
      depth,
    });
    if (node) {
      nodes.push(node);
    }
  }
  if (hasReorder(leftIndex.ordered, rightIndex.ordered)) {
    nodes.push(readOnlyOrderNode(parentLocation, context));
  }
  return nodes;
}

function compareElement(input: {
  left?: XmlElementNode;
  right?: XmlElementNode;
  parent: XmlElementNode;
  location: Location;
  status: CompareTreeStatus;
  insertion?: InsertionPosition;
  context: CompareContext;
  depth: number;
}): CompareTreeNode | undefined {
  const element = input.right ?? input.left;
  if (!element) {
    return undefined;
  }
  if (input.left && input.right && captureXmlSubtree(input.left.dom) === captureXmlSubtree(input.right.dom)) {
    return undefined;
  }
  if (!isSupportedElementNamespace(element.dom)) {
    return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, 'XML-раздел использует неподдерживаемое пространство имён и доступен только для чтения.');
  }
  if (input.left && input.right && hasUnsupportedChangedAttributes(input.left.dom, input.right.dom)) {
    return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, 'Изменённый атрибут или его пространство имён не поддерживается и доступен только для чтения.');
  }
  if (input.context.kind === 'formXml' && localName(element.name) === 'BaseForm') {
    return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, 'Снимок унаследованной части BaseForm доступен только для чтения.');
  }
  if (input.context.kind === 'formXml' && isFormEventElement(element)) {
    return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, 'Обработчик события зависит от BSL-модуля формы; без проверки модуля его изменение доступно только для чтения.');
  }
  if (isFileBackedMetadataRegistration(input.context.kind, element, input.parent)) {
    return readOnlyNode(
      element,
      input.left,
      input.status,
      input.location,
      input.context,
      input.depth,
      'Переносите форму, макет или команду целиком вместе с дескриптором и файлами.'
    );
  }
  if (isDefaultObjectFormReference(input.context.kind, element, input.parent)) {
    return readOnlyPropertyNode(
      element,
      input.status,
      input.location,
      input.context,
      'Ссылка на форму доступна только для чтения, пока не подтверждён перенос целевой формы вместе с файлами.'
    );
  }
  if (!input.left || !input.right) {
    const unsafeNewLeaf = unsupportedSubtreeReason(
      element,
      input.parent,
      input.depth,
      input.context.kind,
      input.context.options.knownComplexElement
    );
    if (unsafeNewLeaf) {
      return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, unsafeNewLeaf);
    }
  }
  if (input.left && input.right) {
    if (expandedXmlName(input.left.dom) !== expandedXmlName(input.right.dom)) {
      input.context.diagnostics.push({
        severity: 'error',
        code: identityMismatchCode(input.context.kind),
        phase: 'compare',
        sourceId: input.context.sourceId,
        path: input.context.options.targetFilePath,
        blocking: true,
        suggestedAction: 'XML-узел изменил пространство имён; безопасное сопоставление невозможно.',
      });
      input.context.candidateFactories.clear();
      return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, 'XML-узел изменил пространство имён и доступен только для чтения.');
    }
    if (isProtectedIdentityMismatch(input.left, input.right, input.context.kind)) {
      input.context.diagnostics.push({
        severity: 'error',
        code: identityMismatchCode(input.context.kind),
        phase: 'compare',
        sourceId: input.context.sourceId,
        path: input.context.options.targetFilePath,
        blocking: true,
        suggestedAction: identityMismatchMessage(input.context.kind),
      });
      input.context.candidateFactories.clear();
      return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, 'Идентификатор или имя объекта изменены; безопасное переименование не поддерживается.');
    }
    if (QUALIFIER_NAMES.has(localName(element.name))) {
      if (captureXmlSubtree(input.left.dom) === captureXmlSubtree(input.right.dom)) {
        return undefined;
      }
      const unsafeQualifier = unsupportedSubtreeReason(
        input.right,
        input.parent,
        input.depth,
        input.context.kind,
        input.context.options.knownComplexElement
      ) ?? unsupportedSubtreeReason(
        input.left,
        input.left.parent,
        input.depth,
        input.context.kind,
        input.context.options.knownComplexElement
      );
      if (unsafeQualifier) {
        return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, unsafeQualifier);
      }
      return propertyNode({
        element: input.right,
        leftValue: captureXmlSubtree(input.left.dom),
        rightValue: captureXmlSubtree(input.right.dom),
        status: input.status,
        location: input.location,
        context: input.context,
      });
    }
  }

  if (isPropertyLeaf(input.left, input.right)) {
    if (isProtectedLeaf(input.left, input.right, input.parent, input.context.kind)) {
      return readOnlyPropertyNode(element, input.status, input.location, input.context, 'Поле является частью идентичности объекта и не редактируется отдельно.');
    }
    return propertyNode({
      element,
      leftValue: input.left?.text ?? '',
      rightValue: input.right?.text ?? '',
      status: input.status,
      location: input.location,
      context: input.context,
      insertion: input.insertion,
    });
  }

  if (!input.left || !input.right) {
    const unsafeSubtree = unsupportedSubtreeReason(
      element,
      input.parent,
      input.depth,
      input.context.kind,
      input.context.options.knownComplexElement
    );
    if (unsafeSubtree) {
      return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, unsafeSubtree);
    }
    if (element.children.length > 0 && !knownComplex(input.parent, element, input.depth, input.context.options)) {
      return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, 'Структура XML не подтверждена; этот раздел доступен только для чтения.');
    }
    const subtreeStatus = input.left ? 'leftOnly' : 'rightOnly';
    return subtreeNode(element, subtreeStatus, input.location, input.context, input.depth, input.insertion, input.parent);
  }

  if (
    input.left.children.length > 0 &&
    !knownComplex(input.parent, input.right, input.depth, input.context.options) &&
    captureXmlSubtree(input.left.dom) !== captureXmlSubtree(input.right.dom)
  ) {
    return readOnlyNode(input.right, input.left, input.status, input.location, input.context, input.depth, 'Структура XML не подтверждена; этот раздел доступен только для чтения.');
  }

  const children = compareChildren(input.left, input.right, input.location, input.context, input.depth + 1);
  if (children.length === 0) {
    return undefined;
  }
  return {
    id: input.context.options.nodeIdPrefix + ':element:' + encodeURIComponent(input.location.pointer),
    label: elementDisplayName(element),
    kind: elementKind(input.context.options, element, input.parent, input.depth),
    status: children.some((child) => child.status !== 'equal') ? 'changed' : 'equal',
    children,
  };
}

function compareAttributes(
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
    if (leftValue === rightValue) {
      continue;
    }
    const status: CompareTreeStatus = leftValue === undefined ? 'rightOnly' : rightValue === undefined ? 'leftOnly' : 'changed';
    if (!shouldShowStatus(status, context.input.strategy)) {
      continue;
    }
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
        : propertyNode({
            element: attributeNode,
            leftValue: leftValue ?? '',
            rightValue: rightValue ?? '',
            status,
            location,
            context,
          })
    );
  }
  return result;
}

function propertyNode(input: {
  element: XmlElementNode;
  leftValue: string;
  rightValue: string;
  status: CompareTreeStatus;
  location: Location;
  context: CompareContext;
  insertion?: InsertionPosition;
}): CompareTreeNode {
  const id = input.context.options.nodeIdPrefix + ':property:' + encodeURIComponent(input.location.pointer);
  input.context.candidateFactories.set(id, candidateFactory(input.context, id, () => makePatch({
    element: input.element,
    rightValue: input.rightValue,
    status: input.status,
    location: input.location,
    context: input.context,
    insertion: input.insertion,
  })));
  return {
    id,
    label: input.element.name,
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

function readOnlyPropertyNode(
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

function subtreeNode(
  element: XmlElementNode,
  status: 'leftOnly' | 'rightOnly',
  location: Location,
  context: CompareContext,
  depth: number,
  insertion?: InsertionPosition,
  parent?: XmlElementNode
): CompareTreeNode {
  const id = context.options.nodeIdPrefix + ':element:' + encodeURIComponent(location.pointer);
  context.candidateFactories.set(id, candidateFactory(context, id, () => makePatch({
    element,
    rightValue: status === 'rightOnly' ? element.text ?? '' : '',
    status,
    location,
    context,
    insertion,
  })));
  return {
    id,
    label: elementDisplayName(element),
    kind: elementKind(context.options, element, parent, depth),
    status,
    mergeable: true,
    destructive: status === 'leftOnly' ? true : undefined,
    payloadRef: 'xmlPatch:' + location.pointer,
    mergeState: { state: 'ready', targetFilePath: context.options.targetFilePath },
    children: [],
  };
}

function readOnlyNode(
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
    label: elementDisplayName(right),
    kind: elementKind(context.options, right, right.parent, depth),
    status,
    leftValue: left ? captureXmlSubtree(left.dom) : '',
    rightValue: status === 'leftOnly' ? '' : captureXmlSubtree(right.dom),
    mergeable: false,
    payloadRef: 'xmlPatch:' + location.pointer,
    mergeState: { state: 'readOnly', reason, targetFilePath: context.options.targetFilePath },
    children: [],
  };
}

function readOnlyOrderNode(location: Location, context: CompareContext): CompareTreeNode {
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

function candidateFactory(
  context: CompareContext,
  nodeId: string,
  buildPatch: () => XmlPatchPayload
): ExecutableCandidateFactory {
  return async () => {
    const xmlPatch = buildPatch();
    const candidate: PlannedXmlMergeCandidate = {
      kind: xmlPatch.kind === 'replaceNode' ? 'xmlNodeReplace' : xmlPatch.kind === 'insertNode' ? 'xmlNodeInsert' : 'xmlNodeDelete',
      sourceId: context.sourceId,
      snapshotId: context.snapshotId,
      nodeId,
      targetUri: targetUri(context.options.targetFilePath),
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
  insertion?: InsertionPosition;
}): XmlPatchPayload {
  const kind = input.status === 'rightOnly' ? 'insertNode' : input.status === 'leftOnly' ? 'deleteNode' : 'replaceNode';
  const isAttribute = input.location.pointer.split('/').pop()?.startsWith('@') ?? false;
  const replacementXml = kind === 'deleteNode'
    ? undefined
    : isAttribute
      ? input.rightValue
      : captureXmlSubtree(input.element.dom);
  const payload: XmlPatchPayload = {
    kind,
    target: {
      filePath: targetUri(input.context.options.targetFilePath),
      pointer: input.location.pointer,
      displayPath: input.location.displayPath,
      identityKey: input.location.identityKey,
    },
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
  const result = applyXmlPatch(input.context.input.snapshots.left, payload);
  return { ...payload, newHash: hashXmlText(result) };
}

function insertionPosition(
  rightParent: XmlElementNode,
  inserted: XmlElementNode,
  context: CompareContext
): InsertionPosition {
  const rightIndex = indexChildren(rightParent.children, rightParent, context.kind);
  const item = rightIndex.ordered.find((candidate) => candidate.element === inserted);
  if (!item) {
    return { insertPosition: 'append' };
  }
  const leftParent = findCorrespondingLeft(rightParent, context);
  if (!leftParent) {
    return { insertPosition: 'append', insertOrder: item.position };
  }
  const leftIndex = indexChildren(leftParent.children, leftParent, context.kind);
  const position = rightIndex.ordered.indexOf(item);
  for (let index = position + 1; index < rightIndex.ordered.length; index += 1) {
    const candidate = rightIndex.ordered[index]!;
    const targetAnchor = leftIndex.map.get(candidate.key);
    if (targetAnchor) {
      const anchorLocation = locationForElement(targetAnchor.element);
      return {
        insertBefore: {
          filePath: targetUri(context.options.targetFilePath),
          pointer: anchorLocation.pointer,
          displayPath: anchorLocation.displayPath,
          identityKey: anchorLocation.identityKey,
        },
        insertOrder: item.position,
      };
    }
  }
  return { insertPosition: 'append', insertOrder: item.position };
}

function findCorrespondingLeft(source: XmlElementNode, context: CompareContext): XmlElementNode | undefined {
  const sourcePath = ancestors(source);
  let current = context.leftRoot;
  for (let index = 1; index < sourcePath.length; index += 1) {
    const part = sourcePath[index]!;
    const sourceIdentity = semanticXmlIdentityKey(part.dom, part.parent?.dom, context.kind);
    const sameName = current.children.filter((child) => localName(child.name) === localName(part.name));
    const match = sourceIdentity
      ? sameName.find((child) => semanticXmlIdentityKey(child.dom, current.dom, context.kind) === sourceIdentity)
      : sameName[ordinal(part)];
    if (!match) {
      return undefined;
    }
    current = match;
  }
  return current;
}

function isFileBackedMetadataRegistration(
  kind: SemanticXmlKind,
  element: XmlElementNode,
  parent: XmlElementNode
): boolean {
  return kind === 'metadataXml' &&
    localName(parent.name) === 'ChildObjects' &&
    ['Form', 'Template', 'Command'].includes(localName(element.name));
}

function isDefaultObjectFormReference(
  kind: SemanticXmlKind,
  element: XmlElementNode,
  parent: XmlElementNode
): boolean {
  return kind === 'metadataXml' &&
    localName(parent.name) === 'Properties' &&
    localName(element.name) === 'DefaultObjectForm';
}

function knownComplex(
  parent: XmlElementNode,
  element: XmlElementNode,
  depth: number,
  options: XmlAdapterProjectionOptions
): boolean {
  return options.knownComplexElement?.({ element, parent, depth }) ?? false;
}

function elementKind(
  options: XmlAdapterProjectionOptions,
  element: XmlElementNode,
  parent: XmlElementNode | undefined,
  depth: number
): string {
  return options.elementKind?.({ element, parent, depth }) ?? 'xmlElement';
}

function metadataReferencesInXml(...roots: readonly XmlElementNode[]): string[] {
  const references = new Set<string>();
  for (const root of roots) {
    for (const reference of metadataReferencesInSubsystemContent(root.dom)) {
      references.add(reference);
    }
    for (const reference of knownRootPropertyReferencesInXml(root.dom).references) {
      references.add(reference.qualifiedName);
    }
    walk(root, (subsystem) => {
      const metadataReference = metadataReferenceFromType(subsystem.dom);
      if (metadataReference?.qualifiedName) {
        references.add(metadataReference.qualifiedName);
      }
    });
  }
  return [...references];
}

function hasReorder(left: readonly IndexedChild[], right: readonly IndexedChild[]): boolean {
  const leftCommon = left.map((item) => item.key).filter((key) => right.some((candidate) => candidate.key === key));
  const rightCommon = right.map((item) => item.key).filter((key) => left.some((candidate) => candidate.key === key));
  return leftCommon.length > 1 && leftCommon.some((key, index) => key !== rightCommon[index]);
}

function selector(element: XmlElementNode): string {
  return getXmlElementIdentityKey(element.dom) ?? String(ordinal(element));
}

function ordinal(element: XmlElementNode): number {
  return element.parent
    ? element.parent.children.filter((child) => localName(child.name) === localName(element.name)).indexOf(element)
    : 0;
}

function indexChildren(children: readonly XmlElementNode[], parent: XmlElementNode, kind: SemanticXmlKind): {
  map: Map<string, IndexedChild>;
  ordered: IndexedChild[];
} {
  const ordinals = new Map<string, number>();
  const map = new Map<string, IndexedChild>();
  const ordered: IndexedChild[] = [];
  for (const element of children) {
    const name = localName(element.name);
    const position = ordinals.get(name) ?? 0;
    ordinals.set(name, position + 1);
    const identity = semanticXmlIdentityKey(element.dom, parent.dom, kind);
    const addressIdentity = getXmlElementIdentityKey(element.dom);
    const childSelector = addressIdentity ?? String(position);
    const key = name + ':' + (identity ?? '#' + position);
    const item = {
      element,
      selector: childSelector,
      key,
      position: element.parent?.dom.children.indexOf(element.dom) ?? position,
    };
    map.set(key, item);
    ordered.push(item);
  }
  return { map, ordered };
}

function locationForRoot(element: XmlElementNode): Location {
  return {
    pointer: '/' + encodeXmlAddressComponent(localName(element.name)) + '[0]',
    displayPath: element.name,
    identityKey: getXmlElementIdentityKey(element.dom),
  };
}

function locationForElement(element: XmlElementNode): Location {
  const path = ancestors(element);
  let location = locationForRoot(path[0]!);
  for (let index = 1; index < path.length; index += 1) {
    const child = path[index]!;
    location = childLocation(location, child, selector(child));
  }
  return location;
}

function childLocation(parent: Location, element: XmlElementNode, selectorValue: string): Location {
  return {
    pointer: parent.pointer + '/' + encodeXmlAddressComponent(localName(element.name)) + '[' + encodeXmlAddressComponent(selectorValue) + ']',
    displayPath: parent.displayPath + '/' + element.name + '[' + selectorValue + ']',
    identityKey: selectorValue,
  };
}

function ancestors(element: XmlElementNode): XmlElementNode[] {
  const result: XmlElementNode[] = [];
  let current: XmlElementNode | undefined = element;
  while (current) {
    result.unshift(current);
    current = current.parent;
  }
  return result;
}

function isPropertyLeaf(left?: XmlElementNode, right?: XmlElementNode): boolean {
  return Boolean(
    (!left || left.children.length === 0) &&
    (!right || right.children.length === 0) &&
    (left?.text ?? '') !== (right?.text ?? '')
  );
}

function shouldShowStatus(status: CompareTreeStatus, strategy: AdapterCompareInput['strategy']): boolean {
  if (status === 'changed') {
    return true;
  }
  if (strategy === 'full') {
    return status === 'rightOnly' || status === 'leftOnly';
  }
  return strategy === 'left' ? status === 'leftOnly' : status === 'rightOnly';
}

function sourceId(input: AdapterCompareInput, side: 'left' | 'right'): string {
  return input.session.state.sources.find((source) => source.side === side)?.sourceId ??
    (side === 'left' ? 'left-source' : FALLBACK_RIGHT_SOURCE_ID);
}

function rightSourceId(input: AdapterCompareInput): string {
  return sourceId(input, 'right');
}

function rightSnapshotId(input: AdapterCompareInput): string {
  const source = input.session.state.sources.find((entry) => entry.side === 'right');
  return source?.snapshotId ??
    input.session.state.snapshots.find((snapshot) => snapshot.readOnly)?.snapshotId ??
    'snapshot-right';
}

function targetDescriptorPath(left: MetadataObjectUnit | undefined, right: MetadataObjectUnit | undefined): string {
  return left?.descriptorPath ?? right?.descriptorPath ?? 'unknown.xml';
}

function stableNodePrefix(prefix: string, filePath: string): string {
  return prefix + ':' + encodeURIComponent(path.resolve(localFilePath(filePath)).replace(/\\/g, '/'));
}

function targetUri(filePath: string): string {
  const normalized = localFilePath(filePath);
  return path.isAbsolute(normalized) ? pathToFileURL(normalized).toString() : normalized;
}

function localFilePath(value: string): string {
  return value.startsWith('file:') ? fileURLToPath(value) : value;
}

function semanticKind(adapterKind: string): SemanticXmlKind {
  return adapterKind === 'formXml' || adapterKind === 'predefinedXml' ? adapterKind : 'metadataXml';
}

function walk(root: XmlElementNode, visit: (element: XmlElementNode) => void): void {
  visit(root);
  for (const child of root.children) {
    walk(child, visit);
  }
}
