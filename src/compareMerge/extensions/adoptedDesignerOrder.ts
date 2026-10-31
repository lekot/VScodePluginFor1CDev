import { buildXmlAddress, elementChildren, type XmlElement } from '../xml/xmlDom';
import {
  allocateAdoptedChildUuid,
  createNewAdoptedChildOverlay,
  ensureAdoptedChildComment,
  normalizeAdoptedIdentity,
  setAdoptedChildOwnership,
} from './adoptedDesignerChildIdentity';
import {
  attach,
  cloneWithNamespaces,
  makeElement,
  prefixForNamespace,
  remove,
} from './adoptedDesignerXml';
import {
  childText,
  direct,
  inMetadataNamespace,
} from './adoptedDesignerMetadataXml';
import {
  metadataAppendBoundary,
  metadataAppendRank,
  scopedOrderIdentity,
  supportsMetadataOrderScope,
} from '../xml/xmlPatchOrderScope';
import type { XmlOrderScope } from '../xml/xmlPatchTypes';
import type { AdoptedDesignerProjectionIssue } from './adoptedDesignerProjection';

type MetadataOrderKind = Extract<XmlOrderScope, { kind: 'metadataChildObjects' }>['elementKind'];

interface ProjectedOrderEntry {
  readonly logical: XmlElement;
  readonly baseIndex?: number;
}

export interface AdoptedDesignerMetadataOrderProjectionInput {
  readonly baseParent: XmlElement;
  readonly physicalParent: XmlElement;
  readonly logicalParent: XmlElement;
  readonly side: 'target' | 'source';
  readonly ownerKey: string;
  readonly issues: AdoptedDesignerProjectionIssue[];
}

export interface AdoptedDesignerMetadataOrderEncodingInput {
  readonly baseParent: XmlElement;
  readonly physicalParent: XmlElement;
  readonly initialParent: XmlElement;
  readonly selectedParent: XmlElement;
  readonly ownerScope: string;
  readonly adoptedChildUuidByAnchor?: ReadonlyMap<string, string>;
  readonly targetChildUuids: Set<string>;
  readonly issues: readonly AdoptedDesignerProjectionIssue[];
}

/** Projects explicit full overlay order, while leaving ambiguous partial sequences inherited and read-only. */
export function projectAdoptedMetadataOrder(input: AdoptedDesignerMetadataOrderProjectionInput): void {
  const baseContainers = direct(input.baseParent, 'ChildObjects');
  const physicalContainers = direct(input.physicalParent, 'ChildObjects');
  const logicalContainers = direct(input.logicalParent, 'ChildObjects');
  if (physicalContainers.length !== 1 || logicalContainers.length !== 1 || baseContainers.length > 1) { return; }
  const physicalContainer = physicalContainers[0]!;
  const logicalContainer = logicalContainers[0]!;
    const baseContainerForScope = baseContainers[0] ?? logicalContainer;
  const kinds = new Set([
    ...metadataElements(baseContainerForScope).map((element) => element.localName),
    ...metadataElements(physicalContainer).map((element) => element.localName),
    ...metadataElements(logicalContainer).map((element) => element.localName),
  ]);

  for (const kind of kinds) {
    if (!supportsMetadataOrderScope(baseContainerForScope, kind) || !supportsMetadataOrderScope(logicalContainer, kind)) { continue; }
    const scope = metadataOrderScope(kind);
    if (!scope) { continue; }
    const baseElements = baseContainers[0] ? metadataElements(baseContainers[0], kind) : [];
    const physicalElements = metadataElements(physicalContainer, kind);
    if (physicalElements.length === 0) { continue; }
    const logicalElements = metadataElements(logicalContainer, kind);
    const baseByKey = indexByOrderIdentity(baseElements, kind);
    const logicalByKey = indexByOrderIdentity(logicalElements, kind);
    if (!baseByKey || !logicalByKey) {
      addOrderOnlyIssue(input, logicalContainer, kind, 'У элементов коллекции неоднозначные UUID identity; порядок остаётся read-only.');
      continue;
    }
    const baseOrder = baseElements.map((element) => metadataOrderIdentity(element, kind)!.slice(5));
    const parsed = parseOverlayOrder(physicalElements, kind, baseByKey, logicalByKey);
    if (!parsed) {
      addOrderOnlyIssue(input, logicalContainer, kind, 'Физический overlay содержит неоднозначные anchors или own identities; порядок остаётся read-only.');
      continue;
    }

    const anchors = parsed.map((entry) => entry.baseIndex);
    const complete = anchors.filter((index) => index !== undefined).length === baseElements.length;
    let lastBaseIndex = -1;
    let ownTailStarted = false;
    let ambiguous = false;
    for (const index of anchors) {
      if (index === undefined) { ownTailStarted = true; continue; }
      if (ownTailStarted || index <= lastBaseIndex) { ambiguous = true; break; }
      lastBaseIndex = index;
    }
    if (!complete && ambiguous) {
      addOrderOnlyIssue(input, logicalContainer, kind, 'Частичный overlay меняет порядок base anchors или перемежает их own members; отсутствующие элементы не позволяют восстановить позиции.');
      continue;
    }

    const desired = complete
      ? parsed.map(({ logical }) => logical)
      : [
        ...baseOrder.map((key) => logicalByKey.get(key)!),
        ...parsed.filter((entry) => entry.baseIndex === undefined).map(({ logical }) => logical),
      ];
    if (desired.some((element) => element === undefined) || !placeLogicalKindGroup(logicalContainer, kind, desired)) {
      addOrderOnlyIssue(input, logicalContainer, kind, 'Логическую коллекцию нельзя разместить в безопасной schema-группе; порядок остаётся read-only.');
    }
  }
}

/** Returns a scoped failure only when a selected same-kind move cannot be encoded exactly. */
export function encodeAdoptedMetadataOrder(input: AdoptedDesignerMetadataOrderEncodingInput): string | undefined {
  const initialContainers = direct(input.initialParent, 'ChildObjects');
  const selectedContainers = direct(input.selectedParent, 'ChildObjects');
  if (initialContainers.length !== 1 || selectedContainers.length !== 1) { return undefined; }
  const initialContainer = initialContainers[0]!;
  const selectedContainer = selectedContainers[0]!;
  const changedKinds = changedMetadataOrderKinds(initialContainer, selectedContainer);
  if (changedKinds.length === 0) { return undefined; }
  const baseContainers = direct(input.baseParent, 'ChildObjects');
  if (baseContainers.length > 1) { return 'Повторный base ChildObjects не позволяет кодировать metadata order.'; }
  const baseContainerForScope = baseContainers[0] ?? selectedContainer;
  const physicalContainers = direct(input.physicalParent, 'ChildObjects');
  if (physicalContainers.length > 1) { return 'Повторный target ChildObjects не позволяет кодировать metadata order.'; }
  const physicalContainer = physicalContainers[0] ?? createPhysicalChildObjects(input.physicalParent);

  for (const kind of changedKinds) {
    const scope = metadataOrderScope(kind);
    if (!scope || !supportsMetadataOrderScope(baseContainerForScope, kind)
      || !supportsMetadataOrderScope(selectedContainer, kind)
      || !supportsMetadataOrderScope(initialContainer, kind)) {
      return `Порядок ${kind} не входит в подтверждённый metadata order scope.`;
    }
    const pointer = buildXmlAddress('', selectedContainer).pointer;
    if (input.issues.some((issue) => issue.orderOnly
      && issue.orderScopePointer === pointer && issue.orderElementKind === kind)) {
      return `Неоднозначный partial order ${kind} нельзя кодировать без определения позиций отсутствующих элементов.`;
    }

    const baseElements = baseContainers[0] ? metadataElements(baseContainers[0], kind) : [];
    const initialElements = metadataElements(initialContainer, kind);
    const selectedElements = metadataElements(selectedContainer, kind);
    const physicalElements = metadataElements(physicalContainer, kind);
    const baseByKey = indexByOrderIdentity(baseElements, kind);
    const initialByKey = indexByOrderIdentity(initialElements, kind);
    const selectedByKey = indexByOrderIdentity(selectedElements, kind);
    if (!baseByKey || !initialByKey || !selectedByKey) { return `Коллекция ${kind} содержит неоднозначные UUID identity.`; }

    for (const key of baseByKey.keys()) {
      if (!selectedByKey.has(key)) { return `Удаление унаследованного ${kind} ${key} невозможно выразить metadata order.`; }
    }

    const physicalByKey = new Map<string, XmlElement>();
    for (const element of physicalElements) {
      const key = physicalOrderKey(element, kind, baseByKey);
      if (!key) { return `Target physical ${kind} содержит непрозрачный элемент в изменяемой order-группе.`; }
      if (physicalByKey.has(key)) { return `Target physical ${kind} identity ${key} повторяется.`; }
      physicalByKey.set(key, element);
    }

    const orderedPhysical: XmlElement[] = [];
    for (const [identity, selectedElement] of selectedByKey) {
      const base = baseByKey.get(identity);
      let physical = physicalByKey.get(identity);
      if (base) {
        if (physical && !isAdoptedShellFor(physical, base)) {
          return `Target physical ${kind} ${identity} не имеет точного Adopted anchor.`;
        }
        if (!physical) {
          const allocation = allocateAdoptedChildUuid(input, input.ownerScope, base);
          if (!allocation.ok) { return allocation.reason; }
          physical = createNewAdoptedChildOverlay(base, allocation.uuid);
          setAdoptedChildOwnership(physical, base, physical);
          const properties = direct(physical, 'Properties')[0];
          const baseProperties = direct(base, 'Properties')[0];
          if (!properties || !baseProperties) { return `Borrowed ${kind} ${identity} lacks metadata Properties.`; }
          ensureAdoptedChildComment(properties, baseProperties);
        }
      } else if (!physical) {
        if (initialByKey.has(identity)) { return `Target own ${kind} ${identity} исчез из physical ChildObjects.`; }
        physical = cloneMetadataElement(selectedElement);
      } else if (childHasAdoptedAnchor(physical)) {
        return `Target own ${kind} ${identity} неожиданно содержит adopted ownership marker.`;
      }
      orderedPhysical.push(physical);
    }

    for (const [identity, physical] of physicalByKey) {
      if (selectedByKey.has(identity)) { continue; }
      if (!initialByKey.has(identity) || childHasAdoptedAnchor(physical)) {
        return `Target physical ${kind} содержит непредставленную или inherited identity ${identity}.`;
      }
    }
    if (!placePhysicalKindGroup(physicalContainer, selectedContainer, kind, orderedPhysical)) {
      return `Physical ${kind} order не помещается в подтверждённую schema-группу.`;
    }
  }
  return undefined;
}

export function hasAdoptedMetadataOrderChange(initial: XmlElement, selected: XmlElement): boolean {
  return changedMetadataOrderKinds(initial, selected).length > 0;
}

function changedMetadataOrderKinds(initial: XmlElement, selected: XmlElement): string[] {
  if (!supportsAnyMetadataOrderScope(initial) || !supportsAnyMetadataOrderScope(selected)) { return []; }
  const kinds = new Set([
    ...metadataElements(initial).map((element) => element.localName),
    ...metadataElements(selected).map((element) => element.localName),
  ]);
  const changed: string[] = [];
  for (const kind of kinds) {
    if (!supportsMetadataOrderScope(initial, kind) || !supportsMetadataOrderScope(selected, kind)) { continue; }
    const before = orderIdentitySequence(metadataElements(initial, kind), kind);
    const after = orderIdentitySequence(metadataElements(selected, kind), kind);
    if (!before || !after) { continue; }
    const afterSet = new Set(after);
    const beforeSet = new Set(before);
    const commonBefore = before.filter((identity) => afterSet.has(identity));
    const commonAfter = after.filter((identity) => beforeSet.has(identity));
    if (commonBefore.length > 1 && commonBefore.some((identity, index) => identity !== commonAfter[index])) { changed.push(kind); }
  }
  return changed;
}

function supportsAnyMetadataOrderScope(container: XmlElement): boolean {
  return metadataElements(container).some((element) => supportsMetadataOrderScope(container, element.localName));
}

function orderIdentitySequence(elements: readonly XmlElement[], kind: string): string[] | undefined {
  const values = elements.map((element) => metadataOrderIdentity(element, kind));
  if (values.some((value) => value === undefined)) { return undefined; }
  const result = values as string[];
  return new Set(result).size === result.length ? result : undefined;
}

function parseOverlayOrder(
  elements: readonly XmlElement[],
  kind: string,
  baseByKey: ReadonlyMap<string, XmlElement>,
  logicalByKey: ReadonlyMap<string, XmlElement>,
): ProjectedOrderEntry[] | undefined {
  const seenBase = new Set<string>();
  const seenOwn = new Set<string>();
  const result: ProjectedOrderEntry[] = [];
  for (const element of elements) {
    const properties = direct(element, 'Properties');
    if (properties.length !== 1) { return undefined; }
    const belongingNodes = direct(properties[0]!, 'ObjectBelonging');
    const anchorNodes = direct(properties[0]!, 'ExtendedConfigurationObject');
    if (belongingNodes.length > 1 || anchorNodes.length > 1) { return undefined; }
    const belonging = childText(properties[0]!, 'ObjectBelonging');
    const anchor = childText(properties[0]!, 'ExtendedConfigurationObject');
    if (belonging === 'Adopted' || anchor !== undefined) {
      if (belonging !== 'Adopted' || !anchor) { return undefined; }
      const key = normalizeAdoptedIdentity(anchor);
      const base = baseByKey.get(key);
      const logical = logicalByKey.get(key);
      const localIdentity = metadataOrderIdentity(element, kind);
      if (!base || !logical || !localIdentity || localIdentity.slice(5) === key || seenBase.has(key)) { return undefined; }
      seenBase.add(key);
      result.push({ logical, baseIndex: indexInOrderMap(baseByKey, key) });
      continue;
    }
    if ((belonging !== undefined && belonging !== 'Own') || anchorNodes.length > 0) { return undefined; }
    const identity = metadataOrderIdentity(element, kind);
    if (!identity) { return undefined; }
    const key = identity.slice(5);
    const logical = logicalByKey.get(key);
    if (!logical || baseByKey.has(key) || seenOwn.has(key)) { return undefined; }
    seenOwn.add(key);
    result.push({ logical });
  }
  return result;
}

function indexInOrderMap(map: ReadonlyMap<string, XmlElement>, identity: string): number | undefined {
  let index = 0;
  for (const key of map.keys()) {
    if (key === identity) { return index; }
    index++;
  }
  return undefined;
}

function indexByOrderIdentity(elements: readonly XmlElement[], kind: string): Map<string, XmlElement> | undefined {
  const result = new Map<string, XmlElement>();
  for (const element of elements) {
    const identity = metadataOrderIdentity(element, kind);
    if (!identity) { return undefined; }
    const key = identity.slice(5);
    if (result.has(key)) { return undefined; }
    result.set(key, element);
  }
  return result;
}

function metadataElements(container: XmlElement, kind?: string): XmlElement[] {
  return elementChildren(container).filter((element) => inMetadataNamespace(element) && (kind === undefined || element.localName === kind));
}

function metadataOrderIdentity(element: XmlElement, kind: string): string | undefined {
  const scope = metadataOrderScope(kind);
  return scope ? scopedOrderIdentity(element, scope) : undefined;
}

function metadataOrderScope(kind: string): Extract<XmlOrderScope, { kind: 'metadataChildObjects' }> | undefined {
  const supported = new Set<MetadataOrderKind>([
    'EnumValue', 'Attribute', 'TabularSection', 'Dimension', 'Resource', 'AddressingAttribute',
    'AccountingFlag', 'ExtDimensionAccountingFlag', 'URLTemplate', 'Method', 'Operation', 'Parameter',
  ]);
  return supported.has(kind as MetadataOrderKind)
    ? { kind: 'metadataChildObjects', elementKind: kind as MetadataOrderKind }
    : undefined;
}

function physicalOrderKey(element: XmlElement, kind: string, baseByKey: ReadonlyMap<string, XmlElement>): string | undefined {
  const properties = direct(element, 'Properties');
  if (properties.length !== 1) { return undefined; }
  const belongingNodes = direct(properties[0]!, 'ObjectBelonging');
  const anchorNodes = direct(properties[0]!, 'ExtendedConfigurationObject');
  if (belongingNodes.length > 1 || anchorNodes.length > 1) { return undefined; }
  const belonging = childText(properties[0]!, 'ObjectBelonging');
  const anchor = childText(properties[0]!, 'ExtendedConfigurationObject');
  if (belonging === 'Adopted' || anchor !== undefined) {
    if (belonging !== 'Adopted' || !anchor) { return undefined; }
    const key = normalizeAdoptedIdentity(anchor);
    const localIdentity = metadataOrderIdentity(element, kind);
    return baseByKey.has(key) && localIdentity && localIdentity.slice(5) !== key ? key : undefined;
  }
  if ((belonging !== undefined && belonging !== 'Own') || anchorNodes.length > 0) { return undefined; }
  const identity = metadataOrderIdentity(element, kind);
  if (!identity || baseByKey.has(identity.slice(5))) { return undefined; }
  return identity.slice(5);
}

function isAdoptedShellFor(element: XmlElement, base: XmlElement): boolean {
  const properties = direct(element, 'Properties');
  if (properties.length !== 1) { return false; }
  const anchor = childText(properties[0]!, 'ExtendedConfigurationObject');
  const localIdentity = metadataOrderIdentity(element, element.localName);
  const baseIdentity = metadataOrderIdentity(base, base.localName);
  return childText(properties[0]!, 'ObjectBelonging') === 'Adopted'
    && anchor !== undefined
    && baseIdentity !== undefined
    && normalizeAdoptedIdentity(anchor) === baseIdentity.slice(5)
    && localIdentity !== undefined
    && localIdentity.slice(5) !== baseIdentity.slice(5);
}

function childHasAdoptedAnchor(element: XmlElement): boolean {
  const properties = direct(element, 'Properties')[0];
  return childText(properties ?? element, 'ObjectBelonging') === 'Adopted'
    || childText(properties ?? element, 'ExtendedConfigurationObject') !== undefined;
}

function placeLogicalKindGroup(container: XmlElement, kind: string, desired: readonly XmlElement[]): boolean {
  let boundary: XmlElement | undefined;
  try { boundary = metadataAppendBoundary(container, kind); } catch { return false; }
  if (boundary && !container.children.includes(boundary)) { return false; }
  for (const element of metadataElements(container, kind)) { remove(container, element); }
  let index = boundary ? container.children.indexOf(boundary) : container.children.length;
  if (index < 0) { return false; }
  for (const element of desired) {
    element.parent = container;
    container.children.splice(index++, 0, element);
  }
  return true;
}

function placePhysicalKindGroup(
  physicalContainer: XmlElement,
  selectedContainer: XmlElement,
  kind: string,
  desired: readonly XmlElement[],
): boolean {
  const selected = new Set(desired);
  for (const element of metadataElements(physicalContainer, kind)) {
    if (!selected.has(element)) { remove(physicalContainer, element); }
  }
  const slots = physicalContainer.children.flatMap((child, index) =>
    child.kind === 'element' && child.localName === kind && inMetadataNamespace(child) ? [index] : []);
  const slotCount = Math.min(slots.length, desired.length);
  for (let index = 0; index < slotCount; index++) {
    const element = desired[index]!;
    physicalContainer.children[slots[index]!] = element;
    element.parent = physicalContainer;
  }
  if (desired.length <= slots.length) { return true; }
  const extra = desired.slice(slotCount);
  let insertion: number;
  if (slots.length > 0) {
    insertion = slots[slots.length - 1]! + 1;
  } else {
    try { insertion = physicalOrderInsertionIndex(physicalContainer, selectedContainer, kind); }
    catch { return false; }
  }
  for (const element of extra) {
    element.parent = physicalContainer;
    physicalContainer.children.splice(insertion++, 0, element);
  }
  return true;
}

function physicalOrderInsertionIndex(container: XmlElement, logicalContainer: XmlElement, kind: string): number {
  const rank = metadataAppendRank(logicalContainer, kind);
  if (rank === undefined) { throw new Error(`Metadata order ${kind} has no safe schema rank.`); }
  for (const child of elementChildren(container)) {
    if (!inMetadataNamespace(child)) { return container.children.indexOf(child); }
    const childRank = metadataAppendRank(logicalContainer, child.localName);
    if (childRank === undefined || childRank > rank) { return container.children.indexOf(child); }
  }
  return container.children.length;
}

function createPhysicalChildObjects(parent: XmlElement): XmlElement {
  const prefix = prefixForNamespace(parent, 'http://v8.1c.ru/8.3/MDClasses', 'md');
  const container = makeElement(`${prefix}:ChildObjects`);
  const structural = elementChildren(parent).filter((element) => ['Properties', 'InternalInfo'].includes(element.localName));
  const lastStructural = structural[structural.length - 1];
  if (!lastStructural) { attach(parent, container); return container; }
  const index = parent.children.indexOf(lastStructural) + 1;
  parent.children.splice(index, 0, container);
  container.parent = parent;
  return container;
}

function addOrderOnlyIssue(
  input: AdoptedDesignerMetadataOrderProjectionInput,
  logicalContainer: XmlElement,
  kind: string,
  reason: string,
): void {
  input.issues.push({
    side: input.side,
    identityKey: input.ownerKey,
    reason: `${kind}: ${reason}`,
    orderOnly: true,
    orderScopePointer: buildXmlAddress('', logicalContainer).pointer,
    orderElementKind: kind,
  });
}

function cloneMetadataElement(element: XmlElement): XmlElement {
  return cloneWithNamespaces(element);
}
