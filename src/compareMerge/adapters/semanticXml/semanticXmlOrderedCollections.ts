import type { CompareTreeNode } from '../../compareTreeTypes';
import type { MergeCandidate } from '../../merge/mergePreview';
import { applyXmlPatch, hashXmlText, type XmlPatchPayload } from '../../xml/xmlPatch';
import { buildXmlAddress, elementChildren, getXmlElementIdentityKey, type XmlElement } from '../../xml/xmlDom';
import type { XmlOrderScope } from '../../xml/xmlPatchTypes';
import { supportsFormSectionOrderScope, supportsMetadataOrderScope } from '../../xml/xmlPatchOrderScope';
import type { ExecutableCandidateFactory } from '../mergeAdapter';
import { elementDisplayName } from './semanticXmlAdapterLabels';
import type { CompareContext, IndexedChild, XmlElementNode } from './semanticXmlAdapter';
import { expandedXmlName, namespaceUriForName, normalizeReferenceValue } from './semanticXmlIdentity';
import { earliestSourceIncreasingSubsequence } from './semanticXmlEnumValueOrder';
import { locationForElement } from './semanticXmlLocation';
import { targetUri } from './semanticXmlAdapterUtils';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const LOGFORM_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
type FormSection = 'Attributes' | 'Commands' | 'Parameters';
type MetadataOrderKind = Extract<XmlOrderScope, { kind: 'metadataChildObjects' }>['elementKind'];
const METADATA_ORDER_KINDS: readonly MetadataOrderKind[] = [
  'EnumValue', 'Attribute', 'TabularSection', 'Dimension', 'Resource', 'AddressingAttribute',
  'AccountingFlag', 'ExtDimensionAccountingFlag', 'URLTemplate', 'Method', 'Operation', 'Parameter',
];
const FORM_SECTIONS: ReadonlyMap<FormSection, string> = new Map([
  ['Attributes', 'Attribute'],
  ['Commands', 'Command'],
  ['Parameters', 'Parameter'],
] as const);

export interface OrderedCollectionProjection {
  nodes: CompareTreeNode[];
  changedKinds: Set<string>;
  unsupportedKinds: Set<string>;
}

/** Projects only same-parent, exact-namespace Designer collections from the closed profile registry. */
export function projectOrderedCollectionChanges(
  leftRoot: XmlElementNode,
  rightRoot: XmlElementNode,
  leftParent: XmlElementNode,
  rightParent: XmlElementNode,
  context: CompareContext,
): OrderedCollectionProjection {
  if (context.kind === 'metadataXml' && leftParent.name.split(':').pop() === 'ChildObjects' &&
      rightParent.name.split(':').pop() === 'ChildObjects') {
    return projectMetadataOrder(leftRoot, rightRoot, leftParent, rightParent, context);
  }
  if (context.kind === 'formXml') {
    return projectFormSectionOrder(leftRoot, rightRoot, leftParent, rightParent, context);
  }
  return { nodes: [], changedKinds: new Set(), unsupportedKinds: new Set() };
}

/** Returns the collection scope for an incoming child only when its owner and namespace are proven. */
export function orderScopeForInsertion(
  leftParent: XmlElementNode,
  rightParent: XmlElementNode,
  inserted: XmlElementNode,
  context: CompareContext,
): XmlOrderScope | undefined {
  if (context.kind === 'metadataXml' && context.input.allowMetadataChildOrder !== false &&
      rightParent.name.split(':').pop() === 'ChildObjects' && isMetadataContainer(rightParent.dom)) {
    const childKind = inserted.dom.localName;
    if (isAllowedMetadataChild(rightParent.dom, childKind) && identityUuid(inserted.dom) &&
        isAllowedMetadataChild(leftParent.dom, childKind) &&
        exactNamespace(inserted.dom, MDCLASSES_NAMESPACE) &&
        sameMetadataOwner(context.leftRoot.dom, context.rightRoot.dom, leftParent.dom, rightParent.dom)) {
      return { kind: 'metadataChildObjects', elementKind: childKind as Extract<XmlOrderScope, { kind: 'metadataChildObjects' }>['elementKind'] };
    }
  }
  if (context.kind === 'formXml' && context.input.allowFormSectionOrder !== false &&
      !hasDirectBaseForm(leftmostRoot(rightParent)) && isExactFormRoot(leftmostRoot(rightParent))) {
    const section = rightParent.dom.localName as FormSection;
    const childKind = FORM_SECTIONS.get(section);
    if (childKind === inserted.dom.localName && rightParent.parent?.dom === leftmostRoot(rightParent) &&
        exactNamespace(leftParent.dom, LOGFORM_NAMESPACE) && exactNamespace(rightParent.dom, LOGFORM_NAMESPACE) &&
        exactNamespace(inserted.dom, LOGFORM_NAMESPACE) && leftParent.dom.localName === section &&
        uniqueDirectSection(context.leftRoot.dom, section) && uniqueDirectSection(context.rightRoot.dom, section)) {
      return { kind: 'formSection', section };
    }
  }
  return undefined;
}

/** True only when the mixed ChildObjects sequence is unchanged across kind boundaries. */
export function hasCrossKindOrderChange(left: readonly IndexedChild[], right: readonly IndexedChild[]): boolean {
  const rightKeys = new Set(right.map((item) => item.key));
  const leftKeys = new Set(left.map((item) => item.key));
  const leftKinds = left.filter((item) => rightKeys.has(item.key)).map((item) => item.element.dom.localName);
  const rightKinds = right.filter((item) => leftKeys.has(item.key)).map((item) => item.element.dom.localName);
  return leftKinds.length > 1 && leftKinds.some((kind, index) => kind !== rightKinds[index]);
}

export function changedKindsInOrder(left: readonly IndexedChild[], right: readonly IndexedChild[]): Set<string> {
  const kinds = new Set([...left, ...right].map((item) => item.element.dom.localName));
  const changed = new Set<string>();
  for (const kind of kinds) {
    const rightKeys = new Set(right.filter((item) => item.element.dom.localName === kind).map((item) => item.key));
    const leftKeys = new Set(left.filter((item) => item.element.dom.localName === kind).map((item) => item.key));
    const before = left.filter((item) => item.element.dom.localName === kind && rightKeys.has(item.key)).map((item) => item.key);
    const after = right.filter((item) => item.element.dom.localName === kind && leftKeys.has(item.key)).map((item) => item.key);
    if (before.length > 1 && before.some((key, index) => key !== after[index])) {changed.add(kind);}
  }
  return changed;
}

function projectMetadataOrder(
  leftRoot: XmlElementNode,
  rightRoot: XmlElementNode,
  leftContainer: XmlElementNode,
  rightContainer: XmlElementNode,
  context: CompareContext,
): OrderedCollectionProjection {
  const changedKinds = changedKindsInOrder(
    indexByKind(leftContainer.children),
    indexByKind(rightContainer.children),
  );
  if (changedKinds.size === 0 || context.input.allowMetadataChildOrder === false ||
      !isMetadataContainer(leftContainer.dom) || !isMetadataContainer(rightContainer.dom) ||
      !sameMetadataOwner(leftRoot.dom, rightRoot.dom, leftContainer.dom, rightContainer.dom)) {
    return { nodes: [], changedKinds, unsupportedKinds: changedKinds };
  }
  const nodes: CompareTreeNode[] = [];
  const unsupportedKinds = new Set<string>();
  for (const kind of changedKinds) {
    if (kind === 'EnumValue' || !isAllowedMetadataChild(leftContainer.dom, kind) ||
        !isAllowedMetadataChild(rightContainer.dom, kind)) {
      unsupportedKinds.add(kind);
      continue;
    }
    const leftItems = identityItems(leftContainer, kind, MDCLASSES_NAMESPACE);
    const rightItems = identityItems(rightContainer, kind, MDCLASSES_NAMESPACE);
    if (!leftItems || !rightItems) {
      unsupportedKinds.add(kind);
      continue;
    }
    const entries = reorderEntries(leftItems, rightItems);
    if (entries === undefined) {
      unsupportedKinds.add(kind);
      continue;
    }
    nodes.push(...entries.map((entry) => orderMoveNode({
      target: entry.target,
      source: entry.source,
      anchor: entry.anchor,
      sourceOrder: entry.sourceOrder,
      scope: { kind: 'metadataChildObjects', elementKind: kind as Extract<XmlOrderScope, { kind: 'metadataChildObjects' }>['elementKind'] },
      owner: leftContainer.parent,
      context,
    })));
  }
  return { nodes, changedKinds, unsupportedKinds };
}

function projectFormSectionOrder(
  leftRoot: XmlElementNode,
  rightRoot: XmlElementNode,
  leftSection: XmlElementNode,
  rightSection: XmlElementNode,
  context: CompareContext,
): OrderedCollectionProjection {
  const section = leftSection.dom.localName as FormSection;
  const childKind = FORM_SECTIONS.get(section);
  const changedKinds = childKind && rightSection.dom.localName === section
    ? changedKindsInOrder(indexByKind(leftSection.children), indexByKind(rightSection.children))
    : new Set<string>();
  if (!childKind || changedKinds.size === 0 || context.input.allowFormSectionOrder === false ||
      !isExactFormRoot(leftRoot.dom) || !isExactFormRoot(rightRoot.dom) ||
      hasDirectBaseForm(leftRoot.dom) || hasDirectBaseForm(rightRoot.dom) ||
      leftmostRoot(leftSection) !== leftRoot.dom || leftmostRoot(rightSection) !== rightRoot.dom ||
      !uniqueDirectSection(leftRoot.dom, section) || !uniqueDirectSection(rightRoot.dom, section) ||
      expandedXmlName(leftSection.dom) !== `{${LOGFORM_NAMESPACE}}${section}` ||
      expandedXmlName(rightSection.dom) !== `{${LOGFORM_NAMESPACE}}${section}` ||
      !supportsFormSectionOrderScope(leftRoot.dom, leftSection.dom, section, childKind) ||
      !supportsFormSectionOrderScope(rightRoot.dom, rightSection.dom, section, childKind)) {
    return { nodes: [], changedKinds, unsupportedKinds: changedKinds };
  }
  if (changedKinds.size !== 1 || !changedKinds.has(childKind)) {
    return { nodes: [], changedKinds, unsupportedKinds: changedKinds };
  }
  const leftItems = identityItems(leftSection, childKind, LOGFORM_NAMESPACE);
  const rightItems = identityItems(rightSection, childKind, LOGFORM_NAMESPACE);
  if (!leftItems || !rightItems) {
    return { nodes: [], changedKinds, unsupportedKinds: changedKinds };
  }
  const entries = reorderEntries(leftItems, rightItems);
  if (entries === undefined) {return { nodes: [], changedKinds, unsupportedKinds: changedKinds };}
  const nodes = entries.map((entry) => orderMoveNode({
    target: entry.target,
    source: entry.source,
    anchor: entry.anchor,
    sourceOrder: entry.sourceOrder,
    scope: { kind: 'formSection', section },
    owner: leftSection,
    context,
  }));
  return { nodes, changedKinds, unsupportedKinds: new Set() };
}

interface OrderedIdentityItem { element: XmlElementNode; key: string; }
interface OrderedMoveEntry { target: XmlElementNode; source: XmlElementNode; anchor?: XmlElementNode; sourceOrder: number; }

function reorderEntries(leftItems: readonly OrderedIdentityItem[], rightItems: readonly OrderedIdentityItem[]): OrderedMoveEntry[] | undefined {
  const leftByKey = new Map(leftItems.map((item) => [item.key, item.element]));
  const rightByKey = new Map(rightItems.map((item) => [item.key, item.element]));
  const sourceCommon = rightItems.filter((item) => leftByKey.has(item.key));
  const targetCommon = leftItems.filter((item) => rightByKey.has(item.key));
  if (sourceCommon.length < 2 || sourceCommon.every((item, index) => item.key === targetCommon[index]?.key)) {return [];}
  const targetPosition = new Map(targetCommon.map((item, index) => [item.key, index]));
  const sourcePositions = sourceCommon.map((item) => targetPosition.get(item.key)!);
  const stationaryIndices = earliestSourceIncreasingSubsequence(sourcePositions);
  const stationary = new Set([...stationaryIndices].map((index) => sourceCommon[index]!.key));
  const result: OrderedMoveEntry[] = [];
  for (const [sourcePosition, item] of rightItems.entries()) {
    if (!leftByKey.has(item.key) || stationary.has(item.key)) {continue;}
    let anchor: XmlElementNode | undefined;
    for (let index = sourcePosition + 1; index < rightItems.length; index += 1) {
      anchor = leftByKey.get(rightItems[index]!.key);
      if (anchor) {break;}
    }
    result.push({
      target: leftByKey.get(item.key)!,
      source: item.element,
      anchor,
      sourceOrder: item.element.parent?.children.indexOf(item.element) ?? sourcePosition,
    });
  }
  return result;
}

function identityItems(parent: XmlElementNode, kind: string, namespace: string): OrderedIdentityItem[] | undefined {
  const matching = parent.children.filter((child) => child.dom.localName === kind);
  const ids = new Set<string>();
  const result: OrderedIdentityItem[] = [];
  for (const element of matching) {
    if (!exactNamespace(element.dom, namespace)) {return undefined;}
    const identity = namespace === MDCLASSES_NAMESPACE ? identityUuid(element.dom) : formIdentity(element.dom);
    if (!identity || ids.has(identity)) {return undefined;}
    ids.add(identity);
    result.push({ element, key: identity });
  }
  return result;
}

function indexByKind(children: readonly XmlElementNode[]): IndexedChild[] {
  const counts = new Map<string, number>();
  return children.map((element) => {
    const kind = element.dom.localName;
    const position = counts.get(kind) ?? 0;
    counts.set(kind, position + 1);
    const identity = namespaceUriForName(element.dom) === MDCLASSES_NAMESPACE
      ? identityUuid(element.dom)
      : formIdentity(element.dom);
    return { element, key: `${kind}:${identity ?? '#' + position}`, selector: identity ?? String(position), position };
  });
}

function orderMoveNode(input: {
  target: XmlElementNode;
  source: XmlElementNode;
  anchor?: XmlElementNode;
  sourceOrder: number;
  scope: XmlOrderScope;
  owner?: XmlElementNode;
  context: CompareContext;
}): CompareTreeNode {
  const location = locationForElement(input.target);
  const parentLocation = input.owner ? elementDisplayName(input.owner) : 'Коллекция';
  const targetPosition = input.target.parent?.children.indexOf(input.target);
  const currentPosition = targetPosition !== undefined && targetPosition >= 0
    ? String(targetPosition + 1)
    : 'неизвестная позиция';
  const nodeId = input.context.options.nodeIdPrefix + ':scoped-order:' + encodeURIComponent(location.pointer);
  input.context.candidateFactories.set(nodeId, candidateFactory(input.context, nodeId, () => makeMovePatch(input)));
  return {
    id: nodeId,
    label: `Порядок: ${elementDisplayName(input.source)}`,
    kind: 'metadataOrderMove',
    status: 'changed',
    leftValue: `${parentLocation} → позиция ${currentPosition}`,
    rightValue: input.anchor ? `${parentLocation} → перед ${elementDisplayName(input.anchor)}` : `${parentLocation} → в конец группы`,
    mergeable: true,
    payloadRef: 'xmlPatch:' + location.pointer,
    mergeState: { state: 'ready', targetFilePath: input.context.options.targetFilePath },
    children: [],
  };
}

function candidateFactory(context: CompareContext, nodeId: string, buildPatch: () => XmlPatchPayload): ExecutableCandidateFactory {
  return async () => {
    const xmlPatch = buildPatch();
    const candidate: MergeCandidate = {
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

function makeMovePatch(input: {
  target: XmlElementNode;
  source: XmlElementNode;
  anchor?: XmlElementNode;
  sourceOrder: number;
  scope: XmlOrderScope;
  context: CompareContext;
}): XmlPatchPayload {
  const filePath = targetUri(input.context.options.targetFilePath);
  const targetAddress = buildXmlAddress(filePath, input.target.dom);
  const destinationAddress = buildXmlAddress(filePath, input.target.parent!.dom);
  const anchorAddress = input.anchor ? buildXmlAddress(filePath, input.anchor.dom) : undefined;
  const patch: XmlPatchPayload = {
    kind: 'moveNode',
    target: targetAddress,
    destinationParent: destinationAddress,
    insertBefore: anchorAddress,
    insertPosition: anchorAddress ? undefined : 'append',
    insertOrder: input.sourceOrder,
    orderScope: input.scope,
    expectedOldHash: input.context.expectedOldHash,
    newHash: '',
    semanticKind: input.context.kind,
    sourceWitnesses: input.context.sourceWitnesses,
    semanticContext: input.context.semanticContext,
  };
  return { ...patch, newHash: hashXmlText(applyXmlPatch(input.context.input.snapshots.left, patch)) };
}

function sameMetadataOwner(leftRoot: XmlElement, rightRoot: XmlElement, leftContainer: XmlElement, rightContainer: XmlElement): boolean {
  if (!isMetadataContainer(leftContainer) || !isMetadataContainer(rightContainer) ||
      !exactNamespace(leftRoot, MDCLASSES_NAMESPACE) || !exactNamespace(rightRoot, MDCLASSES_NAMESPACE) ||
      leftRoot.localName !== 'MetaDataObject' || rightRoot.localName !== 'MetaDataObject') {return false;}
  const leftOwner = leftContainer.parent;
  const rightOwner = rightContainer.parent;
  if (!leftOwner || !rightOwner || leftOwner.localName !== rightOwner.localName ||
      !sameOwnerPath(leftRoot, leftOwner, rightRoot, rightOwner)) {return false;}
  return uniqueDirectChildObjects(leftOwner) === leftContainer && uniqueDirectChildObjects(rightOwner) === rightContainer;
}

function isAllowedMetadataChild(container: XmlElement, childKind: string): boolean {
  return METADATA_ORDER_KINDS.includes(childKind as MetadataOrderKind) &&
    supportsMetadataOrderScope(container, childKind);
}

function sameOwnerPath(leftRoot: XmlElement, leftOwner: XmlElement, rightRoot: XmlElement, rightOwner: XmlElement): boolean {
  const leftPath = ownerPath(leftRoot, leftOwner);
  const rightPath = ownerPath(rightRoot, rightOwner);
  return Boolean(leftPath && rightPath && leftPath.length === rightPath.length &&
    leftPath.every((item, index) => item.localName === rightPath[index]!.localName && identityUuid(item) === identityUuid(rightPath[index]!)));
}

function ownerPath(root: XmlElement, owner: XmlElement): XmlElement[] | undefined {
  const result: XmlElement[] = [];
  let current: XmlElement | undefined = owner;
  while (current && current !== root) {
    if (current.localName !== 'ChildObjects') {result.unshift(current);}
    current = current.parent;
  }
  if (current !== root || result.length === 0 || result[0]!.parent !== root) {return undefined;}
  return result;
}

function uniqueDirectChildObjects(owner: XmlElement): XmlElement | undefined {
  const containers = elementChildren(owner).filter((child) => child.localName === 'ChildObjects');
  if (containers.length !== 1 || !exactNamespace(containers[0]!, MDCLASSES_NAMESPACE)) {return undefined;}
  return containers.length === 1 ? containers[0] : undefined;
}

function identityUuid(element: XmlElement): string | undefined {
  const uuidAttributes = element.attributes.filter((attribute) => attribute.name === 'uuid' ||
    (attribute.name !== 'xmlns:uuid' && attribute.name.toLowerCase().endsWith(':uuid')));
  if (uuidAttributes.length !== 1 || uuidAttributes[0]!.name !== 'uuid') {return undefined;}
  const value = uuidAttributes[0]!.value.trim();
  return UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

function formIdentity(element: XmlElement): string | undefined {
  const identity = getXmlElementIdentityKey(element);
  if (!identity || (!identity.startsWith('id=') && !identity.startsWith('name='))) {return undefined;}
  const value = identity.slice(identity.indexOf('=') + 1).trim().normalize('NFC');
  return value ? `${identity.slice(0, identity.indexOf('='))}=${normalizeReferenceValue(value)}` : undefined;
}

function exactNamespace(element: XmlElement, namespace: string): boolean {
  return namespaceUriForName(element) === namespace;
}

function isMetadataContainer(container: XmlElement): boolean {
  return METADATA_ORDER_KINDS.some((kind) => supportsMetadataOrderScope(container, kind));
}

function isExactFormRoot(root: XmlElement): boolean {
  return expandedXmlName(root) === `{${LOGFORM_NAMESPACE}}Form`;
}

function hasDirectBaseForm(root: XmlElement): boolean {
  return elementChildren(root).some((child) => child.localName === 'BaseForm');
}

function uniqueDirectSection(root: XmlElement, section: string): boolean {
  return elementChildren(root).filter((child) => child.localName === section && exactNamespace(child, LOGFORM_NAMESPACE)).length === 1 &&
    !elementChildren(root).some((child) => child.localName === section && !exactNamespace(child, LOGFORM_NAMESPACE));
}

function leftmostRoot(element: XmlElementNode): XmlElement {
  let current = element;
  while (current.parent) {current = current.parent;}
  return current.dom;
}
