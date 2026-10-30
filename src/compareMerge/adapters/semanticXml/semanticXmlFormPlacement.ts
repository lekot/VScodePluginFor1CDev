import type { XmlElementNode } from './semanticXmlAdapter';
import { expandedXmlName, localXmlName } from './semanticXmlIdentity';
import { FORM_VISUAL_ELEMENT_SET } from '../../xml/formXmlElementPolicy';
const LOGFORM_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/logform';

export interface FormPlacementEntry {
  target: XmlElementNode;
  source: XmlElementNode;
  destinationParent?: XmlElementNode;
  destinationOwner?: XmlElementNode;
  createDestinationChildItems?: true;
  anchor?: XmlElementNode;
  sourceOrder: number;
  reason?: string;
}

export interface FormPlacementProjection {
  leftByRight: Map<XmlElementNode, XmlElementNode>;
  rightByLeft: Map<XmlElementNode, XmlElementNode>;
  placementsByRightParent: Map<XmlElementNode, FormPlacementEntry[]>;
  placementsByRight: Map<XmlElementNode, FormPlacementEntry>;
  hasRelocatedDescendant(element: XmlElementNode): boolean;
}

/** Globally matches stable form visual IDs and identifies parent/order changes. */
export function buildFormPlacementProjection(
  leftRoot: XmlElementNode,
  rightRoot: XmlElementNode,
): FormPlacementProjection {
  const leftByRight = new Map<XmlElementNode, XmlElementNode>();
  const rightByLeft = new Map<XmlElementNode, XmlElementNode>();
  if (expandedXmlName(leftRoot.dom) !== `{${LOGFORM_NAMESPACE}}Form` ||
      expandedXmlName(rightRoot.dom) !== `{${LOGFORM_NAMESPACE}}Form`) {
    return {
      leftByRight,
      rightByLeft,
      placementsByRightParent: new Map(),
      placementsByRight: new Map(),
      hasRelocatedDescendant: () => false,
    };
  }
  const leftVisuals = indexVisuals(leftRoot);
  const rightVisuals = indexVisuals(rightRoot);
  for (const [key, right] of rightVisuals.unique) {
    const left = leftVisuals.unique.get(key);
    if (left) {
      leftByRight.set(right, left);
      rightByLeft.set(left, right);
    }
  }

  const ownerPairs = indexOwners(leftRoot, rightRoot);
  const placementsByRight = new Map<XmlElementNode, FormPlacementEntry>();
  for (const [right, left] of leftByRight) {
    const rightItems = right.parent;
    const rightOwner = rightItems?.parent;
    if (!rightItems || !rightOwner) {
      continue;
    }
    const targetOwner = ownerPairs.get(rightOwner);
    const destinationParent = targetOwner ? uniqueChildItems(targetOwner) : undefined;
    const canCreateDestination = Boolean(targetOwner && canCreateChildItems(targetOwner));
    if (left.parent !== destinationParent) {
      placementsByRight.set(right, {
        target: left,
        source: right,
        destinationParent,
        destinationOwner: destinationParent ? undefined : targetOwner,
        createDestinationChildItems: !destinationParent && canCreateDestination ? true : undefined,
        sourceOrder: rightItems.children.indexOf(right),
        reason: destinationParent || canCreateDestination
          ? undefined
          : 'В целевой форме нет уникального контейнера ChildItems у владельца назначения.',
      });
    }
  }

  const sourceContainers: XmlElementNode[] = [];
  walk(rightRoot, (element) => {
    if (localXmlName(element.name) === 'ChildItems' && !isInsideBaseForm(element)) {
      sourceContainers.push(element);
    }
  });
  for (const rightItems of sourceContainers) {
    const rightOwner = rightItems.parent;
    const targetOwner = rightOwner ? ownerPairs.get(rightOwner) : undefined;
    const targetItems = targetOwner ? uniqueChildItems(targetOwner) : undefined;
    if (!targetItems) {
      continue;
    }
    const sourceOrder = rightItems.children.filter((child) => leftByRight.has(child) && leftByRight.get(child)?.parent === targetItems);
    const targetOrder = targetItems.children.filter((child) => {
      const right = rightByLeft.get(child);
      return Boolean(right && right.parent === rightItems);
    });
    const targetKeys = targetOrder.map(visualKey).filter((key): key is string => key !== undefined);
    const sourceKeys = sourceOrder.map(visualKey).filter((key): key is string => key !== undefined);
    if (targetKeys.length < 2 || arraysEqual(targetKeys, sourceKeys)) {
      continue;
    }
    const stationary = longestCommonSubsequence(targetKeys, sourceKeys);
    for (const source of sourceOrder) {
      const key = visualKey(source);
      if (!key || stationary.has(key) || placementsByRight.has(source)) {
        continue;
      }
      const target = leftByRight.get(source);
      if (target) {
        placementsByRight.set(source, {
          target,
          source,
          destinationParent: targetItems,
          sourceOrder: rightItems.children.indexOf(source),
        });
      }
    }
  }

  // Prefer anchors that stay in the destination without needing another selection.
  for (const placement of placementsByRight.values()) {
    if (!placement.destinationParent || !placement.source.parent) {
      continue;
    }
    const siblings = placement.source.parent.children;
    const start = siblings.indexOf(placement.source);
    for (let index = start + 1; index < siblings.length; index += 1) {
      const targetAnchor = leftByRight.get(siblings[index]!);
      if (targetAnchor?.parent === placement.destinationParent) {
        placement.anchor = targetAnchor;
        break;
      }
    }
  }

  const placementsByRightParent = new Map<XmlElementNode, FormPlacementEntry[]>();
  for (const placement of placementsByRight.values()) {
    const parent = placement.source.parent;
    if (parent) {
      placementsByRightParent.set(parent, [...(placementsByRightParent.get(parent) ?? []), placement]);
    }
  }
  for (const placements of placementsByRightParent.values()) {
    placements.sort((left, right) => left.sourceOrder - right.sourceOrder);
  }

  return {
    leftByRight,
    rightByLeft,
    placementsByRightParent,
    placementsByRight,
    hasRelocatedDescendant(element) {
      let found = false;
      walk(element, (child) => {
        if (child !== element && placementsByRight.has(child)) {
          found = true;
        }
      });
      return found;
    },
  };
}

function indexVisuals(root: XmlElementNode): { unique: Map<string, XmlElementNode>; counts: Map<string, number> } {
  const unique = new Map<string, XmlElementNode>();
  const counts = new Map<string, number>();
  walk(root, (element) => {
    if (localXmlName(element.parent?.name ?? '') !== 'ChildItems' || isInsideBaseForm(element) ||
        !expandedXmlName(element.dom).startsWith(`{${LOGFORM_NAMESPACE}}`) ||
        !FORM_VISUAL_ELEMENT_SET.has(localXmlName(element.name))) {
      return;
    }
    const key = visualKey(element);
    if (!key) {
      return;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    unique.set(key, element);
  });
  for (const [key, count] of counts) {
    if (count !== 1) {
      unique.delete(key);
    }
  }
  return { unique, counts };
}

function indexOwners(leftRoot: XmlElementNode, rightRoot: XmlElementNode): Map<XmlElementNode, XmlElementNode> {
  const leftIndex = uniqueOwnerIndex(leftRoot);
  const rightIndex = uniqueOwnerIndex(rightRoot);
  const result = new Map<XmlElementNode, XmlElementNode>([[rightRoot, leftRoot]]);
  for (const [key, right] of rightIndex) {
    const left = leftIndex.get(key);
    if (left) {
      result.set(right, left);
    }
  }
  return result;
}

function uniqueOwnerIndex(root: XmlElementNode): Map<string, XmlElementNode> {
  const elements = new Map<string, XmlElementNode>();
  const counts = new Map<string, number>();
  walk(root, (element) => {
    if (element === root || isInsideBaseForm(element) ||
        !expandedXmlName(element.dom).startsWith(`{${LOGFORM_NAMESPACE}}`)) {
      return;
    }
    const key = stableOwnerKey(element);
    if (key) {
      elements.set(key, element);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  });
  for (const [key, count] of counts) {
    if (count !== 1) {
      elements.delete(key);
    }
  }
  return elements;
}

function stableOwnerKey(element: XmlElementNode): string | undefined {
  const id = attributeValue(element, 'id');
  return id ? expandedXmlName(element.dom) + '\0id=' + id.normalize('NFC') : undefined;
}

function visualKey(element: XmlElementNode): string | undefined {
  const id = attributeValue(element, 'id');
  return id ? expandedXmlName(element.dom) + '\0id=' + id.normalize('NFC') : undefined;
}

function attributeValue(element: XmlElementNode, name: string): string | undefined {
  return element.dom.attributes.find((attribute) => attribute.localName.toLowerCase() === name)?.value;
}

function uniqueChildItems(owner: XmlElementNode): XmlElementNode | undefined {
  const containers = owner.children.filter((child) => localXmlName(child.name) === 'ChildItems');
  return containers.length === 1 ? containers[0] : undefined;
}

function canCreateChildItems(owner: XmlElementNode): boolean {
  const ownerName = localXmlName(owner.name);
  const allowed = !owner.parent
    ? ownerName === 'Form'
    : ['UsualGroup', 'Pages', 'Page', 'Table', 'CommandBar', 'ButtonGroup', 'Popup', 'AutoCommandBar']
      .includes(ownerName);
  return allowed && expandedXmlName(owner.dom) === `{http://v8.1c.ru/8.3/xcf/logform}${ownerName}` &&
    owner.children.every((child) => localXmlName(child.name) !== 'ChildItems');
}

function isInsideBaseForm(element: XmlElementNode): boolean {
  let current: XmlElementNode | undefined = element;
  while (current) {
    if (localXmlName(current.name) === 'BaseForm') {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]): Set<string> {
  const lengths = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      lengths[leftIndex]![rightIndex] = left[leftIndex] === right[rightIndex]
        ? lengths[leftIndex + 1]![rightIndex + 1]! + 1
        : Math.max(lengths[leftIndex + 1]![rightIndex]!, lengths[leftIndex]![rightIndex + 1]!);
    }
  }
  const result = new Set<string>();
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      result.add(left[leftIndex]!);
      leftIndex += 1;
      rightIndex += 1;
    } else if (lengths[leftIndex + 1]![rightIndex]! > lengths[leftIndex]![rightIndex + 1]!) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return result;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function walk(root: XmlElementNode, visit: (element: XmlElementNode) => void): void {
  visit(root);
  for (const child of root.children) {
    walk(child, visit);
  }
}
