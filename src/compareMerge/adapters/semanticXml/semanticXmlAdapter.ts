import type { CompareTreeNode, CompareTreeStatus } from '../../compareTreeTypes';
import type { CompareMessage } from '../../domain/compareContracts';
import {
  captureXmlSubtree,
  parseXmlDocument as parseDomXmlDocument,
  type XmlElement,
} from '../../xml/xmlDom';
import { hashXmlText } from '../../xml/xmlPatch';
import {
  expandedXmlName,
  localXmlName as localName,
  namespaceUriForName,
} from './semanticXmlIdentity';
import {
  HARD_DIAGNOSTIC_CODES,
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
} from './semanticXmlMetadataReferences';
import { metadataReferencesInXml } from './semanticXmlMetadataScan';
import { roleRightsMetadataReferences } from './semanticXmlRights';
import { hasMetadataSiblingNameCollision } from './semanticXmlMetadataIdentity';
import { hasUnsupportedChangedAttributes, isFormEventElement, unsupportedSubtreeReason, wrapXmlElement } from './semanticXmlSubtreeSafety';
import { buildFormPlacementProjection, type FormPlacementProjection } from './semanticXmlFormPlacement';
import { formPlacementContainerNode, formPlacementNode } from './semanticXmlFormPlacementNodes';
import { enumValueOrderNodes, isSupportedEnumValueStructure, projectEnumValueOrder } from './semanticXmlEnumValueOrder';
import { changedKindsInOrder, hasCrossKindOrderChange, orderScopeForInsertion, projectOrderedCollectionChanges } from './semanticXmlOrderedCollections';
import { childLocation, locationForElement, locationForRoot, type Location } from './semanticXmlLocation';
import { readOnlyContainerGroup } from './semanticXmlAdapterContainers';
import {
  elementDisplayName,
  linkedDefaultObjectFormAllowed,
  linkedEventHandlerAllowed,
  linkedMetadataRegistrationAllowed,
} from './semanticXmlAdapterLabels';
export { childText, elementDisplayName } from './semanticXmlAdapterLabels';
import { insertionPosition, type XmlInsertionPosition } from './semanticXmlInsertion';
import {
  canSynthesizeMetadataChildObjects,
  metadataRegistrationCandidateNode,
  missingMetadataRegistrationContainer,
} from './semanticXmlMetadataRegistration';
import { validateSemanticXmlMerge, type SemanticXmlKind } from './semanticXmlValidator';
import type {
  AdapterCompareInput,
  AdapterCompareResult,
  ExecutableCandidateFactory,
  MergeAdapter,
  XmlPatchPayload,
} from '../mergeAdapter';
import { LINKED_FORM_REFERENCE_PROPERTIES } from '../../linkedDesignerUtils';
import {
  hasReorder,
  indexChildren,
  isPropertyLeaf,
  localFilePath,
  rightSnapshotId,
  rightSourceId,
  semanticKind,
  shouldShowStatus,
  stableNodePrefix,
  targetDescriptorPath,
  targetUri,
} from './semanticXmlAdapterUtils';
import {
  compareAttributes,
  propertyNode,
  readOnlyNode,
  readOnlyOrderNode,
  readOnlyPropertyNode,
  subtreeNode,
} from './semanticXmlAdapterNodes';

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

export interface IndexedChild {
  element: XmlElementNode;
  selector: string;
  key: string;
  position: number;
}

export interface CompareContext {
  input: AdapterCompareInput;
  options: XmlAdapterProjectionOptions;
  kind: SemanticXmlKind;
  expectedOldHash: string;
  sourceId: string;
  snapshotId: string;
  leftRoot: XmlElementNode;
  rightRoot: XmlElementNode;
  candidateFactories: Map<string, ExecutableCandidateFactory>;
  diagnostics: CompareMessage[];
  sourceWitnesses: NonNullable<XmlPatchPayload['sourceWitnesses']>;
  semanticContext: XmlPatchPayload['semanticContext'];
  formPlacement?: FormPlacementProjection;
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
        if (name === 'EnumValue') {
          return isSupportedEnumValueStructure(element);
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

  const expectedRoot = kind === 'metadataXml' ? 'MetaDataObject' : kind === 'formXml' ? 'Form'
    : kind === 'predefinedXml' ? 'PredefinedData' : kind === 'roleRightsXml' ? 'Rights' : 'DataCompositionSchema';
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
    kind === 'metadataXml' || kind === 'formXml' ? metadataReferencesInXml(left, right)
      : kind === 'roleRightsXml'
        ? [...new Set([...roleRightsMetadataReferences(left.dom), ...roleRightsMetadataReferences(right.dom)])]
        : []
  );
  const context: CompareContext = {
    input,
    options,
    kind,
    expectedOldHash: hashXmlText(input.snapshots.left),
    sourceId: rightSourceId(input),
    snapshotId: rightSnapshotId(input),
    leftRoot: left,
    rightRoot: right,
    candidateFactories: factories,
    diagnostics,
    sourceWitnesses: witnesses.sourceWitnesses,
    semanticContext: witnesses.semanticContext,
    formPlacement: kind === 'formXml' ? buildFormPlacementProjection(left, right) : undefined,
  };
  for (const placement of context.formPlacement?.placementsByRight.values() ?? []) {
    if (placement.reason) {
      diagnostics.push({
        severity: 'warning',
        code: 'XML_FORM_PLACEMENT_OWNER_UNRESOLVED',
        phase: 'compare',
        sourceId: context.sourceId,
        path: options.targetFilePath,
        blocking: false,
        suggestedAction: placement.reason,
      });
    }
  }
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
    const localLeft = leftIndex.map.get(key);
    const r = rightIndex.map.get(key);
    if (!r && localLeft && context.formPlacement?.rightByLeft.has(localLeft.element)) {
      continue;
    }
    const globalLeft = !localLeft && r ? context.formPlacement?.leftByRight.get(r.element) : undefined;
    const leftElement = localLeft?.element ?? globalLeft;
    const element = r?.element ?? leftElement;
    if (!element) {
      continue;
    }
    const status: CompareTreeStatus = !leftElement ? 'rightOnly' : !r ? 'leftOnly' : 'changed';
    if (!shouldShowStatus(status, context.input.strategy)) {
      continue;
    }
    if (!localLeft && r && canSynthesizeMetadataChildObjects({
      leftOwner: leftParent,
      rightOwner: rightParent,
      container: r.element,
      leftRoot: context.leftRoot,
      rightRoot: context.rightRoot,
      kind: context.kind,
    })) {
      nodes.push(missingMetadataRegistrationContainer({
        container: r.element,
        parentLocation: locationForElement(leftParent),
        targetFilePath: context.options.targetFilePath,
        nodeIdPrefix: context.options.nodeIdPrefix,
        canMerge: (candidate) => linkedMetadataRegistrationAllowed(candidate, context.input) &&
          (namespaceUriForName(candidate.dom) ?? '') === (namespaceUriForName(leftParent.dom) ?? '') &&
          isSupportedElementNamespace(candidate.dom) &&
          !unsupportedSubtreeReason(candidate, r.element, depth + 1, context.kind, context.options.knownComplexElement),
        buildCandidate: (candidate) => metadataRegistrationCandidateNode({
          ...candidate,
          input: context.input,
          nodeIdPrefix: context.options.nodeIdPrefix,
          targetFilePath: context.options.targetFilePath,
          targetUri: targetUri(context.options.targetFilePath),
          expectedOldHash: context.expectedOldHash,
          sourceId: context.sourceId,
          snapshotId: context.snapshotId,
          sourceWitnesses: context.sourceWitnesses,
          semanticContext: context.semanticContext,
          candidateFactories: context.candidateFactories,
        }),
        buildReadOnly: (candidate, location) => readOnlyNode(
          candidate,
          undefined,
          'rightOnly',
          location,
          context,
          depth + 1,
          'Для переноса регистрации требуется подтверждённый пакет формы, макета или команды.',
        ),
      }));
      continue;
    }
    if (!leftElement && r && context.kind === 'metadataXml' && hasMetadataSiblingNameCollision(leftParent.dom, r.element.dom)) {
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
    const synthesizedPlacements = !localLeft && r && context.kind === 'formXml' && localName(r.element.name) === 'ChildItems'
      ? (context.formPlacement?.placementsByRightParent.get(r.element) ?? [])
        .filter((placement) => placement.destinationOwner === leftParent && placement.createDestinationChildItems === true)
      : [];
    if (synthesizedPlacements.length > 0) {
      nodes.push(formPlacementContainerNode(r!.element, synthesizedPlacements, context));
      continue;
    }
    if (!localLeft && r && context.kind === 'formXml' && localName(r.element.name) === 'Events' &&
        namespaceUriForName(r.element.dom) === namespaceUriForName(context.leftRoot.dom) &&
        !leftParent.children.some((child) => localName(child.name) === 'Events')) {
      nodes.push(missingFormEventsGroup(r.element, childLocation(parentLocation, r.element, r.selector), context, depth));
      continue;
    }
    const node = compareElement({
      left: leftElement,
      right: r?.element,
      parent: rightParent,
      location: leftElement
        ? locationForElement(leftElement)
        : childLocation(parentLocation, element, r?.selector ?? '0'),
      status,
      insertion: !leftElement && r
        ? insertionPosition(
          rightParent,
          r.element,
          context.leftRoot,
          targetUri(context.options.targetFilePath),
          context.kind,
          orderScopeForInsertion(leftParent, rightParent, r.element, context),
        )
        : undefined,
      context,
      depth,
    });
    if (node) {
      nodes.push(node);
    }
  }
  const placements = context.formPlacement?.placementsByRightParent.get(rightParent) ?? [];
  if (placements.length > 0 && localName(rightParent.name) === 'ChildItems') {
    nodes.push(...placements.map((placement) => formPlacementNode(placement, leftParent, context)));
  }
  const enumMoves = context.kind === 'metadataXml' && context.input.allowMetadataChildOrder !== false &&
      localName(leftParent.name) === 'ChildObjects' &&
      localName(rightParent.name) === 'ChildObjects'
    ? projectEnumValueOrder(context.leftRoot, context.rightRoot, leftParent, rightParent)
    : undefined;
  if (enumMoves?.length) {
    nodes.push(...enumValueOrderNodes(enumMoves, leftParent, context));
  }
  const orderedProjection = projectOrderedCollectionChanges(context.leftRoot, context.rightRoot, leftParent, rightParent, context);
  nodes.push(...orderedProjection.nodes);
  const changedKinds = changedKindsInOrder(leftIndex.ordered, rightIndex.ordered);
  const enumChanged = changedKinds.has('EnumValue');
  const unsupportedKinds = new Set(orderedProjection.unsupportedKinds);
  if (enumChanged && enumMoves?.length) {unsupportedKinds.delete('EnumValue');}
  const withinKindsHandled = changedKinds.size > 0 && [...changedKinds].every((kind) => kind === 'EnumValue'
    ? enumMoves !== undefined && enumMoves.length > 0
    : orderedProjection.changedKinds.has(kind) && !unsupportedKinds.has(kind));
  const crossKindChange = context.kind === 'metadataXml' && localName(leftParent.name) === 'ChildObjects' &&
    hasCrossKindOrderChange(leftIndex.ordered, rightIndex.ordered);
  if (hasReorder(leftIndex.ordered, rightIndex.ordered) && placements.length === 0 &&
      (crossKindChange || !withinKindsHandled)) {
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
  insertion?: XmlInsertionPosition;
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
  if (
    input.status === 'leftOnly' && input.left && !input.right &&
    ((input.context.kind === 'metadataXml' && localName(element.name) === 'ChildObjects' &&
      element.children.some((child) => ['Form', 'Template', 'Command'].includes(localName(child.name)))) ||
      (input.context.kind === 'formXml' && localName(element.name) === 'Events'))
  ) {
    return absentContainerGroup(input.left, input.location, input.context, input.depth);
  }
  if (input.context.kind === 'formXml' && input.right && isFormEventElement(element) && element.text?.trim() &&
      !linkedEventHandlerAllowed(element, input.context.input)) {
    return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, 'Обработчик события зависит от BSL-модуля формы; без проверки модуля его изменение доступно только для чтения.');
  }
  if (!input.left && input.context.formPlacement?.hasRelocatedDescendant(element)) {
    return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, 'Контейнер назначения для существующего элемента формы отсутствует в целевой форме; перенос доступен только для чтения.');
  }
  if (isFileBackedMetadataRegistration(input.context.kind, element, input.parent)) {
    if (!linkedMetadataRegistrationAllowed(element, input.context.input)) {
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
    if (input.status === 'leftOnly' || input.status === 'rightOnly') {
      const registration = input.right ?? input.left;
      if (registration) {
        const unsafeRegistration = unsupportedSubtreeReason(
          registration,
          input.parent,
          input.depth,
          input.context.kind,
          input.context.options.knownComplexElement,
        );
        if (unsafeRegistration) {
          return readOnlyNode(element, input.left, input.status, input.location, input.context, input.depth, unsafeRegistration);
        }
        return subtreeNode(registration, input.status, input.location, input.context, input.depth, input.insertion, input.parent);
      }
    }
  }
  if (isDefaultObjectFormReference(input.context.kind, element, input.parent)) {
    const elementNamespace = namespaceUriForName(element.dom);
    const parentNamespace = namespaceUriForName(input.parent.dom);
    const exactMetadataNamespace = elementNamespace === 'http://v8.1c.ru/8.3/MDClasses' &&
      parentNamespace === 'http://v8.1c.ru/8.3/MDClasses';
    const supportedClearNamespace = exactMetadataNamespace || (!elementNamespace && !parentNamespace);
    const clearsReference = supportedClearNamespace && Boolean(input.left) && (!input.right || !input.right.text?.trim());
    if (!clearsReference && (!exactMetadataNamespace || !input.right || !linkedDefaultObjectFormAllowed(element, input.context.input))) {
      return readOnlyPropertyNode(
        element,
        input.status,
        input.location,
        input.context,
        'Ссылка на форму доступна только для чтения, пока не подтверждён перенос целевой формы вместе с файлами.'
      );
    }
  }
  if (!input.left || !input.right) {
    const unsafeNewLeaf = unsupportedSubtreeReason(
      element,
      input.parent,
      input.depth,
      input.context.kind,
      input.context.options.knownComplexElement,
      (candidate) => !input.right || linkedEventHandlerAllowed(candidate, input.context.input),
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
        input.context.options.knownComplexElement,
        (candidate) => linkedEventHandlerAllowed(candidate, input.context.input),
      ) ?? unsupportedSubtreeReason(
        input.left,
        input.left.parent,
        input.depth,
        input.context.kind,
        input.context.options.knownComplexElement,
        () => true,
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
      input.context.options.knownComplexElement,
      (candidate) => !input.right || linkedEventHandlerAllowed(candidate, input.context.input),
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

/** Keeps package and event deletes individually selectable when the source omits their wrapper. */
function absentContainerGroup(
  left: XmlElementNode,
  location: Location,
  context: CompareContext,
  depth: number,
): CompareTreeNode {
  return readOnlyContainerGroup({
    element: left,
    location,
    kind: context.kind,
    status: 'leftOnly',
    depth,
    options: context.options,
    isSelectableChild: (child) => (context.kind === 'metadataXml' && isFileBackedMetadataRegistration(context.kind, child, left)) ||
      (context.kind === 'formXml' && isFormEventElement(child)),
    projectChild: (child, childLocationValue, selectable) => selectable
      ? compareElement({
          left: child,
          parent: left,
          location: childLocationValue,
          status: 'leftOnly',
          context,
          depth: depth + 1,
        })!
      : readOnlyNode(
          child,
          undefined,
          'leftOnly',
          childLocationValue,
          context,
          depth + 1,
          'Вложенный раздел не подтверждён для отдельного удаления; остальные элементы сохранены.'
        ),
  });
}

function missingFormEventsGroup(
  sourceEvents: XmlElementNode,
  eventsLocation: Location,
  context: CompareContext,
  depth: number,
): CompareTreeNode {
  return readOnlyContainerGroup({
    element: sourceEvents,
    location: eventsLocation,
    kind: context.kind,
    status: 'rightOnly',
    depth,
    options: context.options,
    isSelectableChild: (child) => isFormEventElement(child) &&
      namespaceUriForName(child.dom) === namespaceUriForName(context.leftRoot.dom),
    projectChild: (child, location, selectable) => selectable
      ? compareElement({
          right: child,
          parent: sourceEvents,
          location,
          status: 'rightOnly',
          insertion: {
            destinationParent: {
              filePath: targetUri(context.options.targetFilePath),
              pointer: eventsLocation.pointer,
              displayPath: eventsLocation.displayPath,
            },
            createDestinationEvents: true,
            insertPosition: 'append',
            insertOrder: child.parent?.dom.children.indexOf(child.dom) ?? 0,
          },
          context,
          depth: depth + 1,
        }) ?? readOnlyNode(child, undefined, 'rightOnly', location, context, depth + 1, 'Событие недоступно для отдельного переноса.')
      : readOnlyNode(
          child,
          undefined,
          'rightOnly',
          location,
          context,
          depth + 1,
          'Вложенный раздел Events не подтверждён для отдельного переноса; остальные элементы сохранены.'
        ),
  });
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
    LINKED_FORM_REFERENCE_PROPERTIES.includes(localName(element.name) as typeof LINKED_FORM_REFERENCE_PROPERTIES[number]);
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
