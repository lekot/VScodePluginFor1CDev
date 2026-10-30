import { FORM_VISUAL_ELEMENT_SET } from './formXmlElementPolicy';
import type { XmlAddress } from './xmlAddress';
import { parseXmlAddressPointer } from './xmlAddress';
import {
  elementChildren,
  getXmlElementIdentityKey,
  type XmlAttribute,
  type XmlDocument,
  type XmlElement,
} from './xmlDom';
import type { XmlPatchPayload } from './xmlPatch';
import {
  isXmlOrderScope,
  metadataAppendBoundary,
  metadataAppendRank,
  scopedOrderIdentity,
  supportsFormSectionOrderScope,
  supportsMetadataOrderScope,
} from './xmlPatchOrderScope';

const LOGFORM_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';
const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const SYNTHESIZABLE_VISUAL_OWNERS = new Set([
  'UsualGroup', 'Pages', 'Page', 'Table', 'CommandBar', 'ButtonGroup', 'Popup', 'AutoCommandBar',
]);

export interface ResolvedXmlMove {
  patch: XmlPatchPayload;
  target: XmlElement;
  sourceParent: XmlElement;
  destinationParent: XmlElement;
  anchor?: XmlElement;
  originalIndex: number;
  syntheticDestinationOwner?: XmlElement;
}

export interface ResolvedXmlInsertion {
  patch: XmlPatchPayload;
  parent: XmlElement;
  parentPointer: string;
  replacement: XmlElement;
  anchor?: XmlElement;
  originalIndex: number;
}

export function resolveXmlMoveBatch(document: XmlDocument, patches: readonly XmlPatchPayload[]): ResolvedXmlMove[] {
  const syntheticDestinations = new Map<XmlElement, XmlElement>();
  return patches
    .map((patch, index) => patch.kind === 'moveNode'
      ? resolveMove(document, patch, index, syntheticDestinations)
      : undefined)
    .filter((move): move is ResolvedXmlMove => move !== undefined);
}

export function validateXmlMoveBatch(moves: readonly ResolvedXmlMove[], patches: readonly XmlPatchPayload[]): void {
  const moveByTarget = new Map<XmlElement, ResolvedXmlMove>();
  for (const move of moves) {
    if (moveByTarget.has(move.target)) {
      throw new Error('XML element cannot be moved more than once in a patch batch');
    }
    moveByTarget.set(move.target, move);
  }

  for (const move of moves) {
    if (!move.anchor) {continue;}
    const anchorMove = moveByTarget.get(move.anchor);
    if (anchorMove) {
      if (anchorMove.destinationParent !== move.destinationParent) {
        throw new Error('XML move anchor is moved to a different destination parent');
      }
    } else if (move.anchor.parent !== move.destinationParent) {
      throw new Error('XML move-before anchor must be in the destination parent or move there in this batch');
    }
  }

  const completedAnchorWalks = new Set<ResolvedXmlMove>();
  const activeAnchorWalks = new Set<ResolvedXmlMove>();
  const validateAnchorWalk = (move: ResolvedXmlMove): void => {
    if (completedAnchorWalks.has(move)) {return;}
    if (activeAnchorWalks.has(move)) {throw new Error('XML move anchors form a placement cycle');}
    activeAnchorWalks.add(move);
    const anchorMove = move.anchor ? moveByTarget.get(move.anchor) : undefined;
    if (anchorMove) {validateAnchorWalk(anchorMove);}
    activeAnchorWalks.delete(move);
    completedAnchorWalks.add(move);
  };
  for (const move of moves) {validateAnchorWalk(move);}

  // A locally valid destination may become a descendant after other moves. Check
  // the prospective parent graph before any target is detached.
  for (const move of moves) {
    const visited = new Set<XmlElement>();
    let current: XmlElement | undefined = move.target;
    while (current) {
      if (visited.has(current)) {
        throw new Error('XML move batch creates a cycle in the final parent graph');
      }
      visited.add(current);
      current = moveByTarget.get(current)?.destinationParent ?? current.parent;
    }
  }

  for (const move of moves) {
    if (!move.syntheticDestinationOwner || !move.patch.destinationParent) {continue;}
    const destinationPointer = move.patch.destinationParent.pointer;
    for (const patch of patches) {
      if (patch.kind === 'insertNode' &&
          patch.target.filePath === move.patch.destinationParent.filePath &&
          isXmlPointerAncestorOrEqual(destinationPointer, patch.target.pointer)) {
        throw new Error('XML move cannot combine an explicit insert with the synthesized ChildItems destination');
      }
    }
  }

  const removals = patches.filter((patch) => patch.kind === 'deleteNode' || patch.kind === 'replaceNode');
  for (const removal of removals) {
    if (isAttributePointer(removal.target.pointer)) {continue;}
    for (const move of moves) {
      for (const participant of [move.target, move.destinationParent, move.anchor]) {
        if (!participant) {continue;}
        const address = participant === move.target
          ? move.patch.target
          : participant === move.destinationParent
            ? move.patch.destinationParent!
            : move.patch.insertBefore!;
        if (removal.target.filePath === address.filePath &&
            isXmlPointerAncestorOrEqual(removal.target.pointer, address.pointer)) {
          throw new Error('XML move target, destination owner, or anchor is removed by another patch');
        }
      }
    }
  }
}

export function applyXmlMoveBatch(
  moves: readonly ResolvedXmlMove[],
  insertions: readonly ResolvedXmlInsertion[] = [],
): void {
  if (moves.length === 0 && insertions.length === 0) {return;}
  attachSyntheticChildItems(moves);
  for (const move of moves) {
    if (move.sourceParent !== move.destinationParent) {materializeInheritedNamespaces(move.target);}
  }
  for (const move of moves) {
    const index = move.sourceParent.children.indexOf(move.target);
    if (index < 0) {throw new Error('XML move target is no longer a child of its original parent');}
    move.sourceParent.children.splice(index, 1);
    move.target.parent = undefined;
  }

  const groups = new Map<XmlElement, PlacementEntry[]>();
  for (const move of moves) {
    groups.set(move.destinationParent, [...(groups.get(move.destinationParent) ?? []), {
      patch: move.patch,
      element: move.target,
      parent: move.destinationParent,
      parentPointer: move.patch.destinationParent!.pointer,
      anchor: move.anchor,
      originalIndex: move.originalIndex,
      move,
    }]);
  }
  for (const insertion of insertions) {
    groups.set(insertion.parent, [...(groups.get(insertion.parent) ?? []), {
      patch: insertion.patch,
      element: insertion.replacement,
      parent: insertion.parent,
      parentPointer: insertion.parentPointer,
      anchor: insertion.anchor,
      originalIndex: insertion.originalIndex,
      insertion,
    }]);
  }

  const moveByTarget = new Map(moves.map((move) => [move.target, move]));
  const orderedGroups = [...groups.entries()].sort((left, right) =>
    compareText(left[1][0]!.parentPointer, right[1][0]!.parentPointer));
  for (const [parent, placements] of orderedGroups) {
    const completed = new Set<PlacementEntry>();
    const activeMoves = new Set<ResolvedXmlMove>();
    const activeAnchors = new Set<XmlElement>();
    const beforeAnchor = new Map<XmlElement, PlacementEntry[]>();
    const anchorPointers = new Map<XmlElement, string>();
    const append: PlacementEntry[] = [];
    for (const placement of placements) {
      if (placement.anchor) {
        beforeAnchor.set(placement.anchor, [...(beforeAnchor.get(placement.anchor) ?? []), placement]);
        anchorPointers.set(placement.anchor, placement.patch.insertBefore!.pointer);
      } else {
        append.push(placement);
      }
    }

    const attach = (placement: PlacementEntry, anchor?: XmlElement): void => {
      if (completed.has(placement)) {return;}
      const insertIndex = anchor ? parent.children.indexOf(anchor) : parent.children.length;
      if (insertIndex < 0) {throw new Error('XML placement anchor is not present in the final parent');}
      placement.element.parent = parent;
      parent.children.splice(insertIndex, 0, placement.element);
      completed.add(placement);
    };

    let appendState: 'idle' | 'active' | 'complete' = 'idle';
    const placeAppendGroup = (): void => {
      if (appendState === 'complete') {return;}
      if (appendState === 'active') {throw new Error('XML append placement ordering contains a cycle');}
      appendState = 'active';
      const appendPlacements = [...append].sort((left, right) => {
        const leftRank = left.patch.orderScope?.kind === 'metadataChildObjects'
          ? metadataAppendRank(parent, left.patch.orderScope.elementKind)
          : undefined;
        const rightRank = right.patch.orderScope?.kind === 'metadataChildObjects'
          ? metadataAppendRank(parent, right.patch.orderScope.elementKind)
          : undefined;
        if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) {return rightRank - leftRank;}
        if (leftRank !== undefined && rightRank === undefined) {return -1;}
        if (leftRank === undefined && rightRank !== undefined) {return 1;}
        return comparePlacementSourceOrder(left, right);
      });
      for (const placement of appendPlacements) {
        if (placement.patch.orderScope?.kind === 'metadataChildObjects') {
          const boundary = metadataAppendBoundary(parent, placement.patch.orderScope.elementKind);
          attach(placement, boundary);
        } else {
          attach(placement);
        }
      }
      appendState = 'complete';
    };

    const placeMove = (move: ResolvedXmlMove): void => {
      const placement = placements.find((candidate) => candidate.move === move);
      if (!placement || completed.has(placement)) {return;}
      if (activeMoves.has(move)) {throw new Error('XML move anchor ordering contains a cycle');}
      activeMoves.add(move);
      if (move.anchor) {
        placeAnchorGroup(move.anchor);
      } else {
        placeAppendGroup();
      }
      activeMoves.delete(move);
      if (!completed.has(placement)) {
        throw new Error('XML move was not placed by its validated anchor or append group');
      }
    };

    const placeAnchorGroup = (anchor: XmlElement): void => {
      if (activeAnchors.has(anchor)) {throw new Error('XML move anchor ordering contains a cycle');}
      const group = beforeAnchor.get(anchor);
      if (!group || group.every((placement) => completed.has(placement))) {return;}
      activeAnchors.add(anchor);
      const anchorMove = moveByTarget.get(anchor);
      if (anchorMove && !completed.has(placements.find((placement) => placement.move === anchorMove)!)) {
        placeMove(anchorMove);
      } else if (!anchorMove && anchor.parent !== parent) {
        throw new Error('XML placement anchor is not in its validated final parent');
      }
      for (const placement of [...group].sort(comparePlacementSourceOrder)) {attach(placement, anchor);}
      activeAnchors.delete(anchor);
    };

    const anchorGroups = [...beforeAnchor.keys()].sort((left, right) =>
      compareText(anchorPointers.get(left) ?? '', anchorPointers.get(right) ?? ''));
    for (const anchor of anchorGroups) {placeAnchorGroup(anchor);}
    if (append.length > 0) {placeAppendGroup();}
    if (completed.size !== placements.length) {
      throw new Error('XML placement batch contains an unresolved destination or anchor');
    }
  }
}

interface PlacementEntry {
  patch: XmlPatchPayload;
  element: XmlElement;
  parent: XmlElement;
  parentPointer: string;
  anchor?: XmlElement;
  originalIndex: number;
  move?: ResolvedXmlMove;
  insertion?: ResolvedXmlInsertion;
}

function resolveMove(
  document: XmlDocument,
  patch: XmlPatchPayload,
  originalIndex: number,
  syntheticDestinations: Map<XmlElement, XmlElement>,
): ResolvedXmlMove {
  if (patch.kind !== 'moveNode') {throw new Error('XML move resolver received a non-move patch');}
  const destinationAddress = patch.destinationParent;
  if (!destinationAddress) {throw new Error('XML move requires a destination parent');}
  if (patch.replacementXml !== undefined) {throw new Error('XML move cannot contain replacementXml');}
  if ((patch.insertBefore === undefined) === (patch.insertPosition === undefined)) {
    throw new Error('XML move requires exactly one of insertBefore or insertPosition: append');
  }
  if (patch.insertPosition !== undefined && patch.insertPosition !== 'append') {
    throw new Error('XML move position is invalid');
  }
  if (patch.insertOrder !== undefined && (!Number.isSafeInteger(patch.insertOrder) || patch.insertOrder < 0)) {
    throw new Error('XML move source order is invalid');
  }
  if (patch.target.filePath !== destinationAddress.filePath ||
      (patch.insertBefore && patch.insertBefore.filePath !== patch.target.filePath)) {
    throw new Error('XML move addresses must be in the same file');
  }
  if (isAttributePointer(patch.target.pointer) || isAttributePointer(destinationAddress.pointer) ||
      (patch.insertBefore && isAttributePointer(patch.insertBefore.pointer))) {
    throw new Error('XML move addresses must identify elements');
  }

  const target = findElementByPointer(document, patch.target.pointer);
  if (patch.orderScope !== undefined) {
    return resolveScopedOrderMove(document, patch, target, destinationAddress, originalIndex);
  }
  if (patch.semanticKind === 'metadataXml') {
    return resolveEnumValueMove(document, patch, target, destinationAddress, originalIndex);
  }
  if (patch.semanticKind !== 'formXml') {throw new Error('XML move is only supported for form XML or scoped EnumValue order');}

  const syntheticDestination = patch.createDestinationChildItems === true
    ? resolveSyntheticChildItems(document, destinationAddress, syntheticDestinations)
    : undefined;
  if (patch.createDestinationChildItems !== undefined && patch.createDestinationChildItems !== true) {
    throw new Error('XML move destination synthesis flag is invalid');
  }
  if (patch.createDestinationChildObjects !== undefined || patch.createDestinationEvents !== undefined) {
    throw new Error('Form moves cannot use metadata or Events synthesis flags');
  }
  const destinationParent = syntheticDestination?.container ?? findElementByPointer(document, destinationAddress.pointer);
  const sourceParent = target.parent;
  if (isInsideBaseForm(target) || isInsideBaseForm(destinationParent)) {
    throw new Error('XML move cannot move elements into, out of, or within BaseForm');
  }
  const rootNamespace = namespaceUriForElement(document.root);
  if (document.root.localName !== 'Form' || (rootNamespace && rootNamespace !== LOGFORM_NAMESPACE)) {
    throw new Error('XML move requires a Form document in the logform namespace');
  }
  if (!isExpectedFormNamespace(target, rootNamespace) || !FORM_VISUAL_ELEMENT_SET.has(target.localName)) {
    throw new Error('XML move target is not a supported logform visual element');
  }
  if (!sourceParent || sourceParent.localName !== 'ChildItems') {
    throw new Error('XML move target must be a direct child of a ChildItems container');
  }
  if (!isExpectedFormNamespace(sourceParent, rootNamespace) ||
      !isAllowedVisualOwner(sourceParent.parent, document.root, rootNamespace)) {
    throw new Error('XML move source must be a ChildItems container of a supported form owner');
  }
  if (destinationParent.localName !== 'ChildItems' || !isExpectedFormNamespace(destinationParent, rootNamespace) ||
      !isAllowedVisualOwner(destinationParent.parent, document.root, rootNamespace)) {
    throw new Error('XML move destination must be a ChildItems container');
  }
  if (!hasStableUniqueFormId(document.root, target)) {throw new Error('XML move target must have a stable form element id');}
  if (target === destinationParent || isDescendantOf(destinationParent, target)) {
    throw new Error('XML move would create a cycle by moving an element into its descendant');
  }

  const anchor = patch.insertBefore ? findElementByPointer(document, patch.insertBefore.pointer) : undefined;
  if (anchor === target) {throw new Error('XML move cannot use the target element as its own anchor');}
  if (anchor && isInsideBaseForm(anchor)) {throw new Error('XML move cannot use a BaseForm element as an anchor');}
  if (anchor && (!isExpectedFormNamespace(anchor, rootNamespace) || !FORM_VISUAL_ELEMENT_SET.has(anchor.localName) ||
      !hasStableUniqueFormId(document.root, anchor))) {
    throw new Error('XML move anchor must be a supported logform visual element');
  }
  return {
    patch, target, sourceParent, destinationParent, anchor, originalIndex,
    syntheticDestinationOwner: syntheticDestination?.owner,
  };
}

function resolveScopedOrderMove(
  document: XmlDocument,
  patch: XmlPatchPayload,
  target: XmlElement,
  destinationAddress: XmlAddress,
  originalIndex: number,
): ResolvedXmlMove {
  const scope = patch.orderScope;
  if (!isXmlOrderScope(scope)) {throw new Error('XML order scope is malformed or contains unsupported fields');}
  if (patch.createDestinationChildItems !== undefined || patch.createDestinationChildObjects !== undefined ||
      patch.createDestinationEvents !== undefined) {
    throw new Error('Scoped XML order cannot synthesize a destination container');
  }
  if ((scope.kind === 'metadataChildObjects' && patch.semanticKind !== 'metadataXml') ||
      (scope.kind === 'formSection' && patch.semanticKind !== 'formXml')) {
    throw new Error('XML order scope does not match its semantic XML kind');
  }
  const sourceParent = target.parent;
  const destinationParent = findElementByPointer(document, destinationAddress.pointer);
  if (!sourceParent || sourceParent !== destinationParent || destinationAddress.pointer !== patch.target.pointer.slice(0, patch.target.pointer.lastIndexOf('/'))) {
    throw new Error('Scoped XML order must remain in the original direct collection');
  }

  const root = document.root;
  let localName: string;
  if (scope.kind === 'metadataChildObjects') {
    localName = scope.elementKind;
    if (sourceParent.localName !== 'ChildObjects' || !supportsMetadataOrderScope(sourceParent, localName)) {
      throw new Error('Metadata order scope is not supported for this exact owner and child kind');
    }
    if (patch.insertPosition === 'append' && metadataAppendRank(sourceParent, localName) === undefined) {
      throw new Error('Metadata order scope has no verified schema position');
    }
  } else {
    const sectionChildren: Record<string, string> = { Attributes: 'Attribute', Commands: 'Command', Parameters: 'Parameter' };
    localName = sectionChildren[scope.section]!;
    if (!supportsFormSectionOrderScope(root, sourceParent, scope.section, localName)) {
      throw new Error('Form section order scope is not supported for this exact Form section');
    }
  }

  if (target.localName !== localName) {throw new Error('Scoped XML order target has a different element kind');}
  const identities = new Set<string>();
  for (const sibling of elementChildren(sourceParent).filter((child) => child.localName === localName)) {
    const identity = scopedOrderIdentity(sibling, scope);
    if (!identity || identities.has(identity)) {
      throw new Error('Scoped XML order collection has missing, foreign, or ambiguous identity');
    }
    identities.add(identity);
  }
  const targetIdentity = scopedOrderIdentity(target, scope);
  if (!targetIdentity || !identities.has(targetIdentity)) {throw new Error('Scoped XML order target has no stable unique identity');}

  const anchor = patch.insertBefore ? findElementByPointer(document, patch.insertBefore.pointer) : undefined;
  if (anchor === target) {throw new Error('Scoped XML order cannot use the target as its own anchor');}
  if (anchor && (anchor.parent !== sourceParent || anchor.localName !== localName ||
      !scopedOrderIdentity(anchor, scope) || !identities.has(scopedOrderIdentity(anchor, scope)!))) {
    throw new Error('Scoped XML order anchor must be a direct same-kind item in the same collection');
  }
  return { patch, target, sourceParent, destinationParent, anchor, originalIndex };
}

function resolveEnumValueMove(
  document: XmlDocument,
  patch: XmlPatchPayload,
  target: XmlElement,
  destinationAddress: XmlAddress,
  originalIndex: number,
): ResolvedXmlMove {
  if (patch.createDestinationChildItems !== undefined || patch.createDestinationChildObjects !== undefined ||
      patch.createDestinationEvents !== undefined) {
    throw new Error('EnumValue moves cannot synthesize containers');
  }
  const namespace = namespaceUriForElement(document.root) ?? '';
  if (document.root.localName !== 'MetaDataObject' || namespace !== MDCLASSES_NAMESPACE) {
    throw new Error('EnumValue move requires a metadata descriptor in the exact MDClasses namespace');
  }
  const owner = target.parent?.parent;
  const sourceParent = target.parent;
  const destinationParent = findElementByPointer(document, destinationAddress.pointer);
  if (!sourceParent || sourceParent !== destinationParent || sourceParent.localName !== 'ChildObjects' ||
      owner?.localName !== 'Enum' || owner.parent !== document.root) {
    throw new Error('EnumValue move must stay in the same direct Enum ChildObjects parent');
  }
  if (!hasNamespace(target, namespace) || !hasNamespace(sourceParent, namespace) || !hasNamespace(owner, namespace) ||
      target.localName !== 'EnumValue') {
    throw new Error('EnumValue move participants must use the descriptor namespace and exact element types');
  }
  const directContainers = elementChildren(owner).filter((child) => child.localName === 'ChildObjects' && hasNamespace(child, namespace));
  if (directContainers.length !== 1 || directContainers[0] !== sourceParent) {
    throw new Error('EnumValue move requires one unique direct Enum ChildObjects container');
  }
  const rootOwners = elementChildren(document.root).filter((child) => hasNamespace(child, namespace));
  if (rootOwners.length !== 1 || rootOwners[0] !== owner) {
    throw new Error('EnumValue move requires one unique metadata object owner in MetaDataObject');
  }
  const ownerUuid = uuidValue(owner);
  if (!ownerUuid || !UUID_PATTERN.test(ownerUuid) || countMatchingUuid(document.root, 'Enum', ownerUuid, namespace) !== 1) {
    throw new Error('EnumValue move requires a unique valid Enum owner UUID');
  }
  const valueUuids = new Set<string>();
  for (const child of elementChildren(sourceParent).filter((element) => element.localName === 'EnumValue' && hasNamespace(element, namespace))) {
    const uuid = uuidValue(child);
    if (!uuid || !UUID_PATTERN.test(uuid) || valueUuids.has(uuid.toLowerCase())) {
      throw new Error('EnumValue order contains a missing, invalid, or duplicate UUID identity');
    }
    valueUuids.add(uuid.toLowerCase());
  }
  const targetUuid = uuidValue(target);
  if (!targetUuid || !valueUuids.has(targetUuid.toLowerCase())) {
    throw new Error('EnumValue move target must have one unique valid UUID identity');
  }
  const anchor = patch.insertBefore ? findElementByPointer(document, patch.insertBefore.pointer) : undefined;
  if (anchor === target) {throw new Error('XML move cannot use the target element as its own anchor');}
  if (anchor && (anchor.parent !== sourceParent || anchor.localName !== 'EnumValue' || !hasNamespace(anchor, namespace))) {
    throw new Error('EnumValue move anchor must be a direct EnumValue in the same ChildObjects container');
  }
  if (anchor && !valueUuids.has((uuidValue(anchor) ?? '').toLowerCase())) {
    throw new Error('EnumValue move anchor must have a unique valid UUID identity');
  }
  return { patch, target, sourceParent, destinationParent, anchor, originalIndex };
}

function countMatchingUuid(root: XmlElement, localName: string, uuid: string, namespace: string): number {
  let count = 0;
  const visit = (element: XmlElement): void => {
    if (element.localName === localName && hasNamespace(element, namespace) && uuidValue(element)?.toLowerCase() === uuid.toLowerCase()) {
      count += 1;
    }
    for (const child of elementChildren(element)) {visit(child);}
  };
  visit(root);
  return count;
}

function uuidValue(element: XmlElement): string | undefined {
  return element.attributes.find((attribute) => attribute.name === 'uuid')?.value.trim();
}

function hasNamespace(element: XmlElement, namespace: string): boolean {
  return (namespaceUriForElement(element) ?? '') === namespace;
}

function resolveSyntheticChildItems(
  document: XmlDocument,
  address: XmlAddress,
  prepared: Map<XmlElement, XmlElement>,
): { owner: XmlElement; container: XmlElement } {
  const segments = parseXmlAddressPointer(address.pointer);
  const last = segments[segments.length - 1];
  if (!last || last.localName !== 'ChildItems' || last.selector !== '0' || segments.length < 2) {
    throw new Error('Synthesized XML move destination must be the virtual ChildItems[0] of an existing owner');
  }
  const ownerPointer = address.pointer.slice(0, address.pointer.lastIndexOf('/'));
  const owner = findElementByPointer(document, ownerPointer);
  const isFormRoot = owner === document.root && owner.localName === 'Form';
  const isVisualOwner = SYNTHESIZABLE_VISUAL_OWNERS.has(owner.localName);
  if (isInsideBaseForm(owner)) {throw new Error('XML move cannot synthesize ChildItems inside BaseForm');}
  if ((!isFormRoot && !isVisualOwner) || namespaceUriForElement(owner) !== LOGFORM_NAMESPACE) {
    throw new Error('XML move ChildItems synthesis owner is not a supported logform container');
  }
  if (elementChildren(owner).some((child) => child.localName === 'ChildItems')) {
    throw new Error('XML move ChildItems synthesis owner already has a ChildItems container or duplicate containers');
  }
  const existing = prepared.get(owner);
  if (existing) {return { owner, container: existing };}
  const prefix = owner.name.includes(':') ? owner.name.slice(0, owner.name.indexOf(':')) : undefined;
  const container: XmlElement = {
    kind: 'element', name: prefix ? `${prefix}:ChildItems` : 'ChildItems', localName: 'ChildItems',
    attributes: [], children: [], parent: owner,
  };
  prepared.set(owner, container);
  return { owner, container };
}

function attachSyntheticChildItems(moves: readonly ResolvedXmlMove[]): void {
  const containers = new Map<XmlElement, XmlElement>();
  for (const move of moves) {
    if (move.syntheticDestinationOwner) {containers.set(move.syntheticDestinationOwner, move.destinationParent);}
  }
  for (const [owner, container] of containers) {
    if (elementChildren(owner).some((child) => child.localName === 'ChildItems')) {
      throw new Error('XML move ChildItems synthesis owner changed before attachment');
    }
    const index = owner === rootOf(owner) ? formChildItemsInsertIndex(owner) : owner.children.length;
    owner.children.splice(index, 0, container);
    container.parent = owner;
  }
}

function formChildItemsInsertIndex(owner: XmlElement): number {
  const formStructuralBefore = new Set(['Attributes', 'Commands', 'Parameters', 'CommandInterface', 'BaseForm']);
  const afterVisualSection = new Set(['AutoCommandBar', 'Events']);
  let lastVisualIndex = -1;
  let firstStructuralIndex = -1;
  owner.children.forEach((child, index) => {
    if (child.kind !== 'element') {return;}
    if (afterVisualSection.has(child.localName)) {lastVisualIndex = index;}
    if (firstStructuralIndex < 0 && formStructuralBefore.has(child.localName)) {firstStructuralIndex = index;}
  });
  if (lastVisualIndex >= 0) {
    return firstStructuralIndex >= 0 ? Math.min(lastVisualIndex + 1, firstStructuralIndex) : lastVisualIndex + 1;
  }
  return firstStructuralIndex >= 0 ? firstStructuralIndex : owner.children.length;
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

function isExpectedFormNamespace(element: XmlElement, expectedNamespace: string | undefined): boolean {
  return (namespaceUriForElement(element) ?? '') === (expectedNamespace ?? '');
}

function isAllowedVisualOwner(owner: XmlElement | undefined, formRoot: XmlElement, expectedNamespace: string | undefined): boolean {
  if (!owner || !isExpectedFormNamespace(owner, expectedNamespace)) {return false;}
  return owner === formRoot ? owner.localName === 'Form' : SYNTHESIZABLE_VISUAL_OWNERS.has(owner.localName);
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

function comparePlacementSourceOrder(left: PlacementEntry, right: PlacementEntry): number {
  const leftOrder = left.patch.insertOrder;
  const rightOrder = right.patch.insertOrder;
  if (leftOrder !== undefined || rightOrder !== undefined) {
    const difference = (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
    if (difference !== 0) {return difference;}
  }
  return left.originalIndex - right.originalIndex || compareText(left.patch.target.pointer, right.patch.target.pointer);
}

function compareText(left: string, right: string): number {return left < right ? -1 : left > right ? 1 : 0;}

function materializeInheritedNamespaces(element: XmlElement): void {
  const declarations = new Map<string, XmlAttribute>();
  let current: XmlElement | undefined = element;
  while (current) {
    for (const attribute of current.attributes) {
      if ((attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) && !declarations.has(attribute.name)) {
        declarations.set(attribute.name, attribute);
      }
    }
    current = current.parent;
  }
  for (const declaration of declarations.values()) {
    if (!element.attributes.some((attribute) => attribute.name === declaration.name)) {element.attributes.push({ ...declaration });}
  }
}

function isInsideBaseForm(element: XmlElement): boolean {
  let current: XmlElement | undefined = element;
  while (current) {
    if (current.localName === 'BaseForm') {return true;}
    current = current.parent;
  }
  return false;
}

function isDescendantOf(element: XmlElement, ancestor: XmlElement): boolean {
  let current = element.parent;
  while (current) {
    if (current === ancestor) {return true;}
    current = current.parent;
  }
  return false;
}

function isXmlPointerAncestorOrEqual(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}/`);
}

function isAttributePointer(pointer: string): boolean {return pointer.split('/').pop()?.startsWith('@') ?? false;}

function findElementByPointer(document: XmlDocument, pointer: string): XmlElement {
  const segments = parseXmlAddressPointer(pointer);
  let current = document.root;
  for (const [index, segment] of segments.entries()) {
    if (index === 0) {
      const selectorMatches = /^\d+$/u.test(segment.selector)
        ? Number(segment.selector) === 0
        : getXmlElementIdentityKey(current) === segment.selector;
      if (current.localName !== segment.localName || !selectorMatches) {throw new Error(`XML address root mismatch: ${pointer}`);}
      continue;
    }
    const candidates = elementChildren(current).filter((child) => child.localName === segment.localName);
    if (/^\d+$/u.test(segment.selector)) {
      const next = candidates[Number(segment.selector)];
      if (!next) {throw new Error(`XML address not found: ${pointer}`);}
      current = next;
      continue;
    }
    const matching = candidates.filter((child) => getXmlElementIdentityKey(child) === segment.selector);
    if (matching.length > 1) {throw new Error(`XML address is ambiguous: ${segment.localName}[${segment.selector}]`);}
    if (!matching[0]) {throw new Error(`XML address not found: ${pointer}`);}
    current = matching[0];
  }
  return current;
}

function rootOf(element: XmlElement): XmlElement {
  let root = element;
  while (root.parent) {root = root.parent;}
  return root;
}
