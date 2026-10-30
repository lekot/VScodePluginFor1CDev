import { createHash } from 'crypto';

import type { MergeFileWitness } from '../merge/mergePreview';
import type { XmlOrderScope } from './xmlPatchTypes';
import { getMetadataTypeDescriptorByRootTag } from '../../constants/metadataTypeDescriptors';
import { FORM_VISUAL_ELEMENT_SET } from './formXmlElementPolicy';
import type { XmlAddress } from './xmlAddress';
import { parseXmlAddressPointer } from './xmlAddress';
import {
  isXmlOrderScope,
  metadataAppendRank,
  scopedOrderIdentity,
  supportsFormSectionOrderScope,
  supportsMetadataOrderScope,
} from './xmlPatchOrderScope';
import {
  applyXmlMoveBatch,
  resolveXmlMoveBatch,
  validateXmlMoveBatch,
  type ResolvedXmlMove,
  type ResolvedXmlInsertion,
} from './xmlPatchMoveBatch';
import {
  cloneXmlElement,
  elementChildren,
  getXmlElementIdentityKey,
  parseXmlDocument,
  serializeXmlDocument,
  textContent,
  type XmlDocument,
  type XmlChildNode,
  type XmlElement,
} from './xmlDom';

const LOGFORM_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';

export interface XmlPatchPayload {
  kind: 'replaceNode' | 'insertNode' | 'deleteNode' | 'moveNode';
  target: XmlAddress;
  destinationParent?: XmlAddress;
  createDestinationChildItems?: true;
  createDestinationChildObjects?: true;
  createDestinationEvents?: true;
  orderScope?: XmlOrderScope;
  insertBefore?: XmlAddress;
  insertPosition?: 'append';
  insertOrder?: number;
  semanticKind?: 'metadataXml' | 'formXml' | 'predefinedXml' | 'roleRightsXml' | 'dcsXml';
  semanticContext?: {
    availableFormReferences?: {
      attributes?: readonly string[];
      commands?: readonly string[];
      elements?: readonly string[];
    };
    availableMetadataReferences?: readonly string[];
    configurationName?: string;
    ownerDescriptorVersions?: { target: string; incoming: string };
  };
  expectedOldHash: string;
  newHash: string;
  replacementXml?: string;
  sourceWitnesses?: readonly MergeFileWitness[];
}

export function applyXmlPatch(source: string, patch: XmlPatchPayload): string {
  return applyXmlPatchBatch(source, [patch]);
}

export function applyXmlPatchBatch(source: string, patches: readonly XmlPatchPayload[]): string {
  const sourceHash = hashXmlText(source);
  for (const patch of patches) {
    if (patch.kind === 'moveNode' && sourceHash !== patch.expectedOldHash) {
      throw new Error(`XML move hash guard failed for ${patch.target.filePath}`);
    }
    if (patch.expectedOldHash && sourceHash !== patch.expectedOldHash) {
      throw new Error(`XML patch hash guard failed for ${patch.target.filePath}`);
    }
  }

  const document = parseXmlDocument(source);
  const moves = resolveXmlMoveBatch(document, patches);
  validateXmlMoveBatch(moves, patches);
  const insertions = prepareDeferredElementInsertions(document, patches);
  validateDeferredElementInsertions(document, insertions, moves, patches);
  const positionedInsertions = insertions.filter((insertion) =>
    insertion.anchor !== undefined || insertion.patch.insertPosition === 'append');
  const schemaInsertions = insertions.filter((insertion) =>
    insertion.anchor === undefined && insertion.patch.insertPosition !== 'append');
  const synthesizedChildObjects = prepareSyntheticChildObjects(document, patches);
  const synthesizedEvents = prepareSyntheticEvents(document, patches);

  for (const patch of patches) {
    if (patch.kind === 'moveNode' || isDeferredElementInsertion(patch) ||
        patch.createDestinationChildObjects === true || patch.createDestinationEvents === true) {
      continue;
    }
    applyNonMovePatch(document, patch);
  }
  applyXmlMoveBatch(moves, positionedInsertions);
  attachSyntheticChildObjects(synthesizedChildObjects);
  attachSyntheticEvents(synthesizedEvents);
  applyDeferredElementInsertions(schemaInsertions);

  return serializeXmlDocument(document);
}

export function hashXmlText(source: string): string {
  return createHash('sha256')
    .update(source.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
    .digest('hex');
}

function applyNonMovePatch(document: XmlDocument, patch: XmlPatchPayload): void {
  switch (patch.kind) {
    case 'replaceNode':
      replaceNode(document, patch);
      break;
    case 'insertNode':
      insertNode(document, patch);
      break;
    case 'deleteNode':
      deleteNode(document, patch);
      break;
  }
}

interface PreparedElementInsertion extends ResolvedXmlInsertion {
  parent: XmlElement;
  parentPointer: string;
}

function isDeferredElementInsertion(patch: XmlPatchPayload): boolean {
  return patch.kind === 'insertNode' && !isAttributePointer(patch.target.pointer) &&
    patch.createDestinationChildObjects !== true && patch.createDestinationEvents !== true;
}

function prepareDeferredElementInsertions(
  document: XmlDocument,
  patches: readonly XmlPatchPayload[],
): PreparedElementInsertion[] {
  const result: PreparedElementInsertion[] = [];
  patches.forEach((patch, originalIndex) => {
    if (!isDeferredElementInsertion(patch)) {return;}
    if (patch.insertBefore && patch.insertPosition) {
      throw new Error('insertBefore and insertPosition cannot be used together');
    }
    const segments = parseXmlAddressPointer(patch.target.pointer);
    if (segments.length < 2) {throw new Error('Cannot insert XML root node');}
    const parentPointer = patch.target.pointer.slice(0, patch.target.pointer.lastIndexOf('/'));
    const parent = findElementByPointer(document, parentPointer);
    const anchor = patch.insertBefore
      ? resolveInsertionAnchor(document, patch)
      : undefined;
    result.push({
      patch,
      parent,
      parentPointer,
      replacement: parseReplacement(patch),
      anchor,
      originalIndex,
    });
  });
  return result;
}

function resolveInsertionAnchor(document: XmlDocument, patch: XmlPatchPayload): XmlElement {
  if (!patch.insertBefore || patch.insertBefore.filePath !== patch.target.filePath ||
      isAttributePointer(patch.insertBefore.pointer)) {
    throw new Error('XML insert-before anchor must identify an element in the same file');
  }
  return findElementByPointer(document, patch.insertBefore.pointer);
}

function validateDeferredElementInsertions(
  document: XmlDocument,
  insertions: readonly PreparedElementInsertion[],
  moves: readonly ResolvedXmlMove[],
  patches: readonly XmlPatchPayload[],
): void {
  if (insertions.length === 0) {return;}
  const moveByTarget = new Map(moves.map((move) => [move.target, move]));
  const removals = patches
    .filter((patch) => (patch.kind === 'deleteNode' || patch.kind === 'replaceNode') && !isAttributePointer(patch.target.pointer))
    .map((patch) => ({ patch, target: findElementByPointer(document, patch.target.pointer) }));

  for (const insertion of insertions) {
    validateScopedInsertion(insertion);
    if (insertion.anchor) {
      const anchorMove = moveByTarget.get(insertion.anchor);
      const finalAnchorParent = anchorMove?.destinationParent ?? insertion.anchor.parent;
      if (finalAnchorParent !== insertion.parent) {
        throw new Error('XML insertion anchor and destination must resolve to the same final parent');
      }
    }
    for (const removal of removals) {
      if (removal.patch.target.filePath !== insertion.patch.target.filePath) {continue;}
      if (isSameOrDescendant(insertion.parent, removal.target) ||
          (insertion.anchor && isSameOrDescendant(insertion.anchor, removal.target))) {
        throw new Error('XML insertion parent or anchor is removed by another patch');
      }
    }
  }
}

function validateScopedInsertion(insertion: PreparedElementInsertion): void {
  const { patch, parent, replacement, anchor } = insertion;
  if (patch.orderScope === undefined) {return;}
  const scope = patch.orderScope;
  if (!isXmlOrderScope(scope) || patch.kind !== 'insertNode' ||
      (scope.kind === 'metadataChildObjects' && patch.semanticKind !== 'metadataXml') ||
      (scope.kind === 'formSection' && patch.semanticKind !== 'formXml') ||
      patch.createDestinationChildItems !== undefined || patch.createDestinationChildObjects !== undefined ||
      patch.createDestinationEvents !== undefined) {
    throw new Error('XML insertion order scope is malformed or incompatible with its operation');
  }

  let childKind: string;
  if (scope.kind === 'metadataChildObjects') {
    childKind = scope.elementKind;
    if (parent.localName !== 'ChildObjects' || replacement.localName !== childKind ||
        !supportsMetadataOrderScope(parent, childKind) ||
        (patch.insertPosition === 'append' && metadataAppendRank(parent, childKind) === undefined)) {
      throw new Error('Metadata insertion order scope is not supported for this exact owner and child kind');
    }
  } else {
    const sectionChildren: Record<string, string> = { Attributes: 'Attribute', Commands: 'Command', Parameters: 'Parameter' };
    childKind = sectionChildren[scope.section]!;
    const section = parent;
    const root = rootElement(section);
    if (replacement.localName !== childKind || !supportsFormSectionOrderScope(root, section, scope.section, childKind)) {
      throw new Error('Form insertion order scope is not supported for this exact Form section');
    }
  }

  const identities = new Set<string>();
  for (const sibling of elementChildren(parent).filter((element) => element.localName === childKind)) {
    const identity = scopedOrderIdentity(sibling, scope);
    if (!identity || identities.has(identity)) {throw new Error('XML insertion collection has missing or ambiguous same-kind identity');}
    identities.add(identity);
  }
  const newIdentity = scopedOrderIdentity(replacement, scope);
  if (!newIdentity || identities.has(newIdentity)) {throw new Error('XML insertion has a missing or duplicate scoped identity');}
  if (anchor && (anchor.parent !== parent || anchor.localName !== childKind ||
      !scopedOrderIdentity(anchor, scope) || !identities.has(scopedOrderIdentity(anchor, scope)!))) {
    throw new Error('XML insertion anchor must be a direct same-kind item in the same scoped collection');
  }
}

function rootElement(element: XmlElement): XmlElement {
  let current = element;
  while (current.parent) {current = current.parent;}
  return current;
}

function isSameOrDescendant(element: XmlElement, ancestor: XmlElement): boolean {
  let current: XmlElement | undefined = element;
  while (current) {
    if (current === ancestor) {return true;}
    current = current.parent;
  }
  return false;
}

function applyDeferredElementInsertions(insertions: readonly PreparedElementInsertion[]): void {
  const ordered = [...insertions].sort(comparePreparedInsertions);
  for (const insertion of ordered) {
    let index: number;
    if (insertion.anchor) {
      if (insertion.anchor.parent !== insertion.parent) {
        throw new Error('XML insertion anchor left its validated final parent');
      }
      index = insertion.parent.children.indexOf(insertion.anchor);
      if (index < 0) {throw new Error('XML insert-before anchor is no longer a child of the target parent');}
    } else if (insertion.patch.insertPosition === 'append') {
      index = insertion.parent.children.length;
    } else {
      index = findInsertIndex(insertion.parent, insertion.replacement.localName);
    }
    insertion.replacement.parent = insertion.parent;
    insertion.parent.children.splice(index, 0, insertion.replacement);
  }
}

function comparePreparedInsertions(left: PreparedElementInsertion, right: PreparedElementInsertion): number {
  const parentOrder = compareText(left.parentPointer, right.parentPointer);
  if (parentOrder !== 0) {return parentOrder;}
  const leftOrder = left.patch.insertOrder;
  const rightOrder = right.patch.insertOrder;
  if (leftOrder !== undefined || rightOrder !== undefined) {
    const sourceOrder = (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
    if (sourceOrder !== 0) {return sourceOrder;}
  }
  return left.originalIndex - right.originalIndex;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface SyntheticChildObjectsRegistration {
  patch: XmlPatchPayload;
  replacement: XmlElement;
  identity: string;
  insertOrder: number;
}

interface SyntheticChildObjectsGroup {
  owner: XmlElement;
  ownerPointer: string;
  destinationPointer: string;
  container: XmlElement;
  registrations: SyntheticChildObjectsRegistration[];
}

function prepareSyntheticChildObjects(
  document: XmlDocument,
  patches: readonly XmlPatchPayload[],
): SyntheticChildObjectsGroup[] {
  const syntheticPatches = patches.filter((patch) => patch.createDestinationChildObjects === true);
  if (syntheticPatches.length === 0) {
    return [];
  }

  const groupsByOwner = new Map<XmlElement, SyntheticChildObjectsGroup>();
  for (const patch of syntheticPatches) {
    if (patch.kind !== 'insertNode' || patch.semanticKind !== 'metadataXml' ||
        !patch.destinationParent || !patch.replacementXml || patch.createDestinationChildItems !== undefined ||
        patch.insertBefore !== undefined || patch.insertPosition !== 'append' ||
        !Number.isSafeInteger(patch.insertOrder) || patch.insertOrder! < 0 ||
        patch.target.filePath !== patch.destinationParent.filePath || isAttributePointer(patch.target.pointer) ||
        isAttributePointer(patch.destinationParent.pointer)) {
      throw new Error('Synthetic ChildObjects insertion payload is invalid');
    }

    const destinationSegments = parseXmlAddressPointer(patch.destinationParent.pointer);
    const targetSegments = parseXmlAddressPointer(patch.target.pointer);
    const destination = destinationSegments[destinationSegments.length - 1];
    const target = targetSegments[targetSegments.length - 1];
    if (!destination || destination.localName !== 'ChildObjects' || destination.selector !== '0' ||
        !target || !SYNTHESIZABLE_METADATA_REGISTRATIONS.has(target.localName) || !/^\d+$/u.test(target.selector) ||
        targetSegments.length !== destinationSegments.length + 1 ||
        patch.target.pointer.slice(0, patch.target.pointer.lastIndexOf('/')) !== patch.destinationParent.pointer) {
      throw new Error('Synthetic ChildObjects insertion target must be one registration directly under virtual ChildObjects[0]');
    }

    const ownerPointer = patch.destinationParent.pointer.slice(0, patch.destinationParent.pointer.lastIndexOf('/'));
    const owner = findElementByPointer(document, ownerPointer);
    validateSyntheticMetadataOwner(document, owner);
    if (elementChildren(owner).some((child) => child.localName === 'ChildObjects')) {
      throw new Error('Synthetic ChildObjects owner already has a ChildObjects container');
    }

    let group = groupsByOwner.get(owner);
    if (!group) {
      const ownerPrefix = owner.name.includes(':') ? owner.name.slice(0, owner.name.indexOf(':')) : undefined;
      const container: XmlElement = {
        kind: 'element',
        name: ownerPrefix ? `${ownerPrefix}:ChildObjects` : 'ChildObjects',
        localName: 'ChildObjects',
        attributes: [],
        children: [],
        parent: owner,
      };
      group = {
        owner,
        ownerPointer,
        destinationPointer: patch.destinationParent.pointer,
        container,
        registrations: [],
      };
      groupsByOwner.set(owner, group);
    } else if (group.destinationPointer !== patch.destinationParent.pointer) {
      throw new Error('Synthetic ChildObjects registrations disagree about their virtual destination');
    }

    const replacement = parseReplacement(patch);
    const ownerNamespace = namespaceUriForElement(owner) ?? '';
    if (replacement.localName !== target.localName || (namespaceUriForElement(replacement) ?? '') !== ownerNamespace) {
      throw new Error('Synthetic metadata registration kind or namespace does not match its target address');
    }
    const identity = normalizeSyntheticRegistrationIdentity(textContent(replacement));
    if (!identity) {
      throw new Error('Synthetic metadata registration is missing its stable identity');
    }
    if (group.registrations.some((registration) =>
      registration.patch.target.pointer === patch.target.pointer ||
      (registration.replacement.localName === replacement.localName && registration.identity === identity) ||
      registration.insertOrder === patch.insertOrder)) {
      throw new Error('Synthetic ChildObjects batch contains a duplicate registration identity or source order');
    }
    group.registrations.push({
      patch,
      replacement,
      identity,
      insertOrder: patch.insertOrder!,
    });
  }

  const groups = [...groupsByOwner.values()].sort((left, right) => compareText(left.ownerPointer, right.ownerPointer));
  validateSyntheticChildObjectsInteractions(groups, patches);
  return groups;
}

const MD_CLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const SYNTHESIZABLE_METADATA_REGISTRATIONS = new Set(['Form', 'Template', 'Command']);

function validateSyntheticMetadataOwner(document: XmlDocument, owner: XmlElement): void {
  const root = document.root;
  const namespace = namespaceUriForElement(root) ?? '';
  const descriptor = getMetadataTypeDescriptorByRootTag(owner.localName);
  const sameKindOwners = elementChildren(root).filter((child) =>
    child.localName === owner.localName && (namespaceUriForElement(child) ?? '') === namespace,
  );
  if (root.localName !== 'MetaDataObject' || (namespace !== '' && namespace !== MD_CLASSES_NAMESPACE) ||
      owner.parent !== root || (namespaceUriForElement(owner) ?? '') !== namespace ||
      !descriptor?.structure.hasChildObjects || sameKindOwners.length !== 1) {
    throw new Error('Synthetic ChildObjects owner is not a unique supported metadata descriptor');
  }
}

function normalizeSyntheticRegistrationIdentity(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').normalize('NFC');
}

function validateSyntheticChildObjectsInteractions(
  groups: readonly SyntheticChildObjectsGroup[],
  patches: readonly XmlPatchPayload[],
): void {
  for (const group of groups) {
    for (const patch of patches) {
      if (patch.createDestinationChildObjects === true) {
        continue;
      }
      if (patch.target.filePath !== group.registrations[0]!.patch.target.filePath) {
        continue;
      }
      const targetsVirtualContainer = patch.target.pointer === group.destinationPointer ||
        patch.target.pointer.startsWith(`${group.destinationPointer}/`);
      if (targetsVirtualContainer) {
        throw new Error('Synthetic ChildObjects cannot be combined with an explicit patch under its virtual destination');
      }
      if ((patch.kind === 'deleteNode' || patch.kind === 'replaceNode') &&
          isXmlPointerAncestorOrEqual(patch.target.pointer, group.ownerPointer)) {
        throw new Error('Synthetic ChildObjects owner cannot be removed or replaced by another patch');
      }
    }
  }
}

function attachSyntheticChildObjects(groups: readonly SyntheticChildObjectsGroup[]): void {
  for (const group of groups) {
    if (elementChildren(group.owner).some((child) => child.localName === 'ChildObjects')) {
      throw new Error('Synthetic ChildObjects owner changed before container attachment');
    }
    const ordered = [...group.registrations].sort((left, right) => left.insertOrder - right.insertOrder);
    for (const registration of ordered) {
      registration.replacement.parent = group.container;
      group.container.children.push(registration.replacement);
    }
    const insertIndex = metadataChildObjectsInsertIndex(group.owner);
    group.owner.children.splice(insertIndex, 0, group.container);
    group.container.parent = group.owner;
  }
}

interface SyntheticEventInsertion {
  patch: XmlPatchPayload;
  replacement: XmlElement;
  identity: string;
  insertOrder: number;
}

interface SyntheticEventsGroup {
  owner: XmlElement;
  ownerPointer: string;
  destinationPointer: string;
  container: XmlElement;
  events: SyntheticEventInsertion[];
}

function prepareSyntheticEvents(
  document: XmlDocument,
  patches: readonly XmlPatchPayload[],
): SyntheticEventsGroup[] {
  const syntheticPatches = patches.filter((patch) => patch.createDestinationEvents === true);
  if (syntheticPatches.length === 0) {
    return [];
  }

  const groupsByOwner = new Map<XmlElement, SyntheticEventsGroup>();
  for (const patch of syntheticPatches) {
    if (patch.kind !== 'insertNode' || patch.semanticKind !== 'formXml' ||
        !patch.destinationParent || !patch.replacementXml || patch.createDestinationChildItems !== undefined ||
        patch.createDestinationChildObjects !== undefined || patch.insertBefore !== undefined ||
        patch.insertPosition !== 'append' || !Number.isSafeInteger(patch.insertOrder) || patch.insertOrder! < 0 ||
        patch.target.filePath !== patch.destinationParent.filePath || isAttributePointer(patch.target.pointer) ||
        isAttributePointer(patch.destinationParent.pointer)) {
      throw new Error('Synthetic Events insertion payload is invalid');
    }

    const destinationSegments = parseXmlAddressPointer(patch.destinationParent.pointer);
    const targetSegments = parseXmlAddressPointer(patch.target.pointer);
    const destination = destinationSegments[destinationSegments.length - 1];
    const target = targetSegments[targetSegments.length - 1];
    if (!destination || destination.localName !== 'Events' || destination.selector !== '0' ||
        !target || target.localName !== 'Event' || !/^name=.+$/u.test(target.selector) ||
        targetSegments.length !== destinationSegments.length + 1 ||
        patch.target.pointer.slice(0, patch.target.pointer.lastIndexOf('/')) !== patch.destinationParent.pointer) {
      throw new Error('Synthetic Events insertion target must be one named Event directly under virtual Events[0]');
    }

    const ownerPointer = patch.destinationParent.pointer.slice(0, patch.destinationParent.pointer.lastIndexOf('/'));
    const owner = findElementByPointer(document, ownerPointer);
    validateSyntheticEventsOwner(document, owner);
    if (elementChildren(owner).some((child) => child.localName === 'Events')) {
      throw new Error('Synthetic Events owner already has an Events container or a namespace lookalike');
    }

    let group = groupsByOwner.get(owner);
    if (!group) {
      const prefix = owner.name.includes(':') ? owner.name.slice(0, owner.name.indexOf(':')) : undefined;
      const container: XmlElement = {
        kind: 'element',
        name: prefix ? `${prefix}:Events` : 'Events',
        localName: 'Events',
        attributes: [],
        children: [],
        parent: owner,
      };
      group = {
        owner,
        ownerPointer,
        destinationPointer: patch.destinationParent.pointer,
        container,
        events: [],
      };
      groupsByOwner.set(owner, group);
    } else if (group.destinationPointer !== patch.destinationParent.pointer) {
      throw new Error('Synthetic Events entries disagree about their virtual destination');
    }

    const replacement = parseReplacement(patch);
    const ownerNamespace = namespaceUriForElement(owner) ?? '';
    if (replacement.localName !== 'Event' || (namespaceUriForElement(replacement) ?? '') !== ownerNamespace) {
      throw new Error('Synthetic Event kind or namespace does not match its destination owner');
    }
    const eventName = replacement.attributes.find((attribute) => attribute.name === 'name')?.value;
    const identity = eventName?.trim().normalize('NFC');
    if (!identity || target.selector !== `name=${identity}`) {
      throw new Error('Synthetic Event target selector does not match its stable name identity');
    }
    if (group.events.some((event) => event.identity === identity || event.insertOrder === patch.insertOrder)) {
      throw new Error('Synthetic Events batch contains a duplicate Event identity or source order');
    }
    group.events.push({ patch, replacement, identity, insertOrder: patch.insertOrder! });
  }

  const groups = [...groupsByOwner.values()].sort((left, right) => compareText(left.ownerPointer, right.ownerPointer));
  validateSyntheticEventsInteractions(groups, patches);
  return groups;
}

function validateSyntheticEventsOwner(document: XmlDocument, owner: XmlElement): void {
  const root = document.root;
  const namespace = namespaceUriForElement(root) ?? '';
  const isFormRoot = owner === root && owner.localName === 'Form';
  const isVisualOwner = FORM_VISUAL_ELEMENT_SET.has(owner.localName);
  if (root.localName !== 'Form' || namespace !== LOGFORM_NAMESPACE ||
      (namespaceUriForElement(owner) ?? '') !== namespace || isInsideBaseForm(owner) ||
      (!isFormRoot && (!isVisualOwner || !hasStableUniqueFormId(root, owner)))) {
    throw new Error('Synthetic Events owner is not a unique supported logform Form or visual container');
  }
}

function validateSyntheticEventsInteractions(
  groups: readonly SyntheticEventsGroup[],
  patches: readonly XmlPatchPayload[],
): void {
  for (const group of groups) {
    for (const patch of patches) {
      if (patch.createDestinationEvents === true ||
          patch.target.filePath !== group.events[0]!.patch.target.filePath) {
        continue;
      }
      if (patch.target.pointer === group.destinationPointer ||
          patch.target.pointer.startsWith(`${group.destinationPointer}/`)) {
        throw new Error('Synthetic Events cannot be combined with an explicit patch under its virtual destination');
      }
      if ((patch.kind === 'deleteNode' || patch.kind === 'replaceNode') &&
          isXmlPointerAncestorOrEqual(patch.target.pointer, group.ownerPointer)) {
        throw new Error('Synthetic Events owner cannot be removed or replaced by another patch');
      }
    }
  }
}

function attachSyntheticEvents(groups: readonly SyntheticEventsGroup[]): void {
  for (const group of groups) {
    if (elementChildren(group.owner).some((child) => child.localName === 'Events')) {
      throw new Error('Synthetic Events owner changed before container attachment');
    }
    for (const event of [...group.events].sort((left, right) => left.insertOrder - right.insertOrder)) {
      event.replacement.parent = group.container;
      group.container.children.push(event.replacement);
    }
    const index = group.owner === rootOf(group.owner)
      ? formEventsInsertIndex(group.owner)
      : trailingFormattingIndex(group.owner.children);
    group.owner.children.splice(index, 0, group.container);
    group.container.parent = group.owner;
  }
}

function formEventsInsertIndex(owner: XmlElement): number {
  const children = owner.children;
  const autoCommandBarIndex = children
    .map((child, index) => ({ child, index }))
    .filter((item) => item.child.kind === 'element' && item.child.localName === 'AutoCommandBar')
    .pop()?.index;
  if (autoCommandBarIndex !== undefined) {
    return autoCommandBarIndex + 1;
  }
  const firstStructuralIndex = children.findIndex((child) => child.kind === 'element' &&
    ['ChildItems', 'Attributes', 'Commands', 'Parameters', 'CommandInterface', 'BaseForm'].includes(child.localName));
  return firstStructuralIndex < 0 ? trailingFormattingIndex(children) : firstStructuralIndex;
}

function trailingFormattingIndex(children: readonly XmlChildNode[]): number {
  let index = children.length;
  while (index > 0) {
    const child = children[index - 1]!;
    if (child.kind !== 'text' || child.text.trim().length !== 0) {
      break;
    }
    index -= 1;
  }
  return index;
}

function metadataChildObjectsInsertIndex(owner: XmlElement): number {
  const afterProperties = owner.children
    .map((child, index) => ({ child, index }))
    .filter((item) => item.child.kind === 'element' && item.child.localName === 'Properties')
    .pop();
  if (afterProperties) {
    return afterProperties.index + 1;
  }
  const internalInfo = owner.children
    .map((child, index) => ({ child, index }))
    .filter((item) => item.child.kind === 'element' && item.child.localName === 'InternalInfo')
    .pop();
  if (internalInfo) {
    return internalInfo.index + 1;
  }
  const firstElementIndex = owner.children.findIndex((child) => child.kind === 'element');
  return firstElementIndex < 0 ? owner.children.length : firstElementIndex;
}

function replaceNode(document: XmlDocument, patch: XmlPatchPayload): void {
  if (isAttributePointer(patch.target.pointer)) {
    replaceAttribute(document, patch);
    return;
  }

  const replacement = parseReplacement(patch);
  const target = findElementByPointer(document, patch.target.pointer);
  if (!target.parent) {
    document.root = replacement;
    return;
  }

  const index = target.parent.children.indexOf(target);
  replacement.parent = target.parent;
  target.parent.children.splice(index, 1, replacement);
}

function insertNode(document: XmlDocument, patch: XmlPatchPayload): void {
  if (isAttributePointer(patch.target.pointer)) {
    if (patch.insertBefore || patch.insertPosition) {
      throw new Error('Cannot use insertion position fields for an XML attribute');
    }
    insertAttribute(document, patch);
    return;
  }
  if (patch.insertBefore && patch.insertPosition) {
    throw new Error('insertBefore and insertPosition cannot be used together');
  }

  const replacement = parseReplacement(patch);
  const segments = parseXmlAddressPointer(patch.target.pointer);
  if (segments.length < 2) {
    throw new Error('Cannot insert XML root node');
  }

  const parentPointer = patch.target.pointer.slice(0, patch.target.pointer.lastIndexOf('/'));
  const parent = findElementByPointer(document, parentPointer);
  replacement.parent = parent;

  const insertIndex = patch.insertBefore
    ? findAnchorInsertIndex(parent, patch.target, patch.insertBefore)
    : patch.insertPosition === 'append'
      ? parent.children.length
      : findInsertIndex(parent, segments[segments.length - 1].localName);
  parent.children.splice(insertIndex, 0, replacement);
}

function findAnchorInsertIndex(
  parent: XmlElement,
  target: XmlAddress,
  anchorAddress: XmlAddress
): number {
  if (target.filePath !== anchorAddress.filePath) {
    throw new Error('XML insert-before anchor must be in the same file');
  }
  if (isAttributePointer(anchorAddress.pointer)) {
    throw new Error('XML insert-before anchor must identify an element');
  }

  const anchor = findElementByPointer({ root: rootOf(parent) }, anchorAddress.pointer);
  if (anchor.parent !== parent) {
    throw new Error('XML insert-before anchor must be in the same parent');
  }

  const index = parent.children.indexOf(anchor);
  if (index < 0) {
    throw new Error('XML insert-before anchor is not a child of the target parent');
  }
  return index;
}

function rootOf(element: XmlElement): XmlElement {
  let root = element;
  while (root.parent) {
    root = root.parent;
  }
  return root;
}

function namespaceUriForElement(element: XmlElement): string | undefined {
  const prefix = element.name.includes(':') ? element.name.slice(0, element.name.indexOf(':')) : '';
  const declarationName = prefix ? `xmlns:${prefix}` : 'xmlns';
  let current: XmlElement | undefined = element;
  while (current) {
    const declaration = current.attributes.find((attribute) => attribute.name === declarationName);
    if (declaration) {return declaration.value || undefined;}
    current = current.parent;
  }
  return undefined;
}

function isInsideBaseForm(element: XmlElement): boolean {
  let current: XmlElement | undefined = element;
  while (current) {
    if (current.localName === 'BaseForm') {return true;}
    current = current.parent;
  }
  return false;
}

function isXmlPointerAncestorOrEqual(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}/`);
}

function hasStableUniqueFormId(formRoot: XmlElement, target: XmlElement): boolean {
  const targetId = target.attributes.find((attribute) => attribute.name.toLowerCase() === 'id')?.value;
  if (!targetId) {return false;}
  const targetKey = `${namespaceUriForElement(target) ?? ''}\0${target.localName}\0${targetId.normalize('NFC')}`;
  let matchCount = 0;
  const visit = (element: XmlElement): void => {
    if (element.localName === 'BaseForm') {return;}
    const id = element.attributes.find((attribute) => attribute.name.toLowerCase() === 'id')?.value;
    if (id && `${namespaceUriForElement(element) ?? ''}\0${element.localName}\0${id.normalize('NFC')}` === targetKey) {matchCount += 1;}
    for (const child of elementChildren(element)) {visit(child);}
  };
  visit(formRoot);
  return matchCount === 1;
}

function deleteNode(document: XmlDocument, patch: XmlPatchPayload): void {
  if (isAttributePointer(patch.target.pointer)) {
    deleteAttribute(document, patch);
    return;
  }

  const target = findElementByPointer(document, patch.target.pointer);
  if (!target.parent) {
    throw new Error('Cannot delete XML root node');
  }

  const index = target.parent.children.indexOf(target);
  target.parent.children.splice(index, 1);
}

function parseReplacement(patch: XmlPatchPayload): XmlElement {
  if (!patch.replacementXml) {
    throw new Error(`XML patch ${patch.kind} requires replacementXml`);
  }

  return cloneXmlElement(parseXmlDocument(patch.replacementXml).root);
}

function replaceAttribute(document: XmlDocument, patch: XmlPatchPayload): void {
  const { parent, attributeName } = findAttributeTarget(document, patch.target.pointer);
  const attribute = parent.attributes.find((candidate) => candidate.name === attributeName);
  if (!attribute) {
    throw new Error(`XML attribute not found: ${patch.target.pointer}`);
  }
  attribute.value = replacementAttributeValue(patch);
}

function insertAttribute(document: XmlDocument, patch: XmlPatchPayload): void {
  const { parent, attributeName } = findAttributeTarget(document, patch.target.pointer);
  if (parent.attributes.some((candidate) => candidate.name === attributeName)) {
    throw new Error(`XML attribute already exists: ${patch.target.pointer}`);
  }
  parent.attributes.push({
    name: attributeName,
    localName: localName(attributeName),
    value: replacementAttributeValue(patch),
    quote: '"',
  });
}

function deleteAttribute(document: XmlDocument, patch: XmlPatchPayload): void {
  const { parent, attributeName } = findAttributeTarget(document, patch.target.pointer);
  const index = parent.attributes.findIndex((candidate) => candidate.name === attributeName);
  if (index < 0) {
    throw new Error(`XML attribute not found: ${patch.target.pointer}`);
  }
  parent.attributes.splice(index, 1);
}

function replacementAttributeValue(patch: XmlPatchPayload): string {
  if (patch.replacementXml === undefined) {
    throw new Error(`XML patch ${patch.kind} requires replacementXml`);
  }
  return patch.replacementXml;
}

function findAttributeTarget(
  document: XmlDocument,
  pointer: string
): { parent: XmlElement; attributeName: string } {
  const attributeSegment = pointer.split('/').pop();
  if (!attributeSegment?.startsWith('@')) {
    throw new Error(`Invalid XML attribute pointer: ${pointer}`);
  }
  const parentPointer = pointer.slice(0, -(attributeSegment.length + 1));
  return {
    parent: findElementByPointer(document, parentPointer),
    attributeName: unescapePointer(attributeSegment.slice(1)),
  };
}

function findElementByPointer(document: XmlDocument, pointer: string): XmlElement {
  const segments = parseXmlAddressPointer(pointer);
  let current = document.root;

  segments.forEach((segment, index) => {
    if (index === 0) {
      const selectorMatches = /^\d+$/.test(segment.selector)
        ? Number(segment.selector) === 0
        : getXmlElementIdentityKey(current) === segment.selector;
      if (current.localName !== segment.localName || !selectorMatches) {
        throw new Error(`XML address root mismatch: ${pointer}`);
      }
      return;
    }

    const next = findChildBySelector(current, segment.localName, segment.selector);
    if (!next) {
      throw new Error(`XML address not found: ${pointer}`);
    }
    current = next;
  });

  return current;
}

function findChildBySelector(
  parent: XmlElement,
  localName: string,
  selector: string
): XmlElement | undefined {
  const candidates = elementChildren(parent).filter((child) => child.localName === localName);
  if (/^\d+$/.test(selector)) {
    return candidates[Number(selector)];
  }

  const matching = candidates.filter((child) => getXmlElementIdentityKey(child) === selector);
  if (matching.length > 1) {
    throw new Error(`XML address is ambiguous: ${localName}[${selector}]`);
  }
  return matching[0];
}

function findInsertIndex(parent: XmlElement, localName: string): number {
  const lastSameLocalName = parent.children
    .map((child, index) => ({ child, index }))
    .filter((item) => item.child.kind === 'element' && item.child.localName === localName)
    .pop();

  return lastSameLocalName ? lastSameLocalName.index + 1 : parent.children.length;
}

function isAttributePointer(pointer: string): boolean {
  return pointer.split('/').pop()?.startsWith('@') ?? false;
}

function localName(name: string): string {
  return name.includes(':') ? (name.split(':').pop() ?? name) : name;
}

function unescapePointer(value: string): string {
  if (/%[\da-f]{2}/i.test(value)) {
    try {
      const encoded = value.replace(/%(?![\da-f]{2})/gi, '%25');
      return decodeURIComponent(encoded);
    } catch {
      throw new Error(`Invalid XML attribute address encoding: ${value}`);
    }
  }
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}
