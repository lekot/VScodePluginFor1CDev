import { buildXmlAddress, elementChildren, getXmlElementIdentityKey, serializeXmlElement, textContent, type XmlDocument, type XmlElement } from './xmlDom';
import type { XmlAddress } from './xmlAddress';
import { hashXmlText, type XmlPatchPayload } from './xmlPatch';

export interface XmlDiffOptions {
  filePath: string;
}

export type XmlDiffKind = 'replace' | 'insert' | 'delete';

export interface XmlDiffNode {
  kind: XmlDiffKind;
  address: XmlAddress;
  mergeable: true;
  leftXml?: string;
  rightXml?: string;
  patch: XmlPatchPayload;
}

export function diffXmlDocuments(
  left: XmlDocument,
  right: XmlDocument,
  options: XmlDiffOptions
): XmlDiffNode[] {
  if (left.root.localName !== right.root.localName) {
    return [replaceDiff(left.root, right.root, options)];
  }

  return compareElements(left.root, right.root, options, 0);
}

function compareElements(
  left: XmlElement,
  right: XmlElement,
  options: XmlDiffOptions,
  depth: number
): XmlDiffNode[] {
  if (!sameAttributes(left, right)) {
    return [replaceDiff(left, right, options)];
  }

  const leftChildren = elementChildren(left);
  const rightChildren = elementChildren(right);
  if (leftChildren.length === 0 && rightChildren.length === 0) {
    return textContent(left) === textContent(right) ? [] : [replaceDiff(left, right, options)];
  }

  const leftByKey = groupChildren(leftChildren);
  const rightByKey = groupChildren(rightChildren);
  const keys = mergeDocumentOrderKeys(leftByKey, rightByKey);
  const changedChildSet = keys.some((key) => !leftByKey.has(key) || !rightByKey.has(key));
  if (changedChildSet && depth > 1) {
    return [replaceDiff(left, right, options)];
  }

  const diffs: XmlDiffNode[] = [];
  for (const key of keys) {
    const leftChild = leftByKey.get(key);
    const rightChild = rightByKey.get(key);
    if (leftChild && rightChild) {
      diffs.push(...compareElements(leftChild, rightChild, options, depth + 1));
    } else if (rightChild) {
      diffs.push(insertDiff(rightChild, options));
    } else if (leftChild) {
      diffs.push(deleteDiff(leftChild, options));
    }
  }

  return diffs;
}

function mergeDocumentOrderKeys(
  leftByKey: ReadonlyMap<string, XmlElement>,
  rightByKey: ReadonlyMap<string, XmlElement>
): string[] {
  const result = [...leftByKey.keys()];
  for (const key of rightByKey.keys()) {
    if (!leftByKey.has(key)) {
      result.push(key);
    }
  }

  return result;
}

function replaceDiff(left: XmlElement, right: XmlElement, options: XmlDiffOptions): XmlDiffNode {
  const rightXml = serializeXmlElement(right);
  return {
    kind: 'replace',
    address: buildXmlAddress(options.filePath, left),
    mergeable: true,
    leftXml: serializeXmlElement(left),
    rightXml,
    patch: {
      kind: 'replaceNode',
      target: buildXmlAddress(options.filePath, left),
      expectedOldHash: '',
      newHash: hashXmlText(rightXml),
      replacementXml: rightXml,
    },
  };
}

function insertDiff(right: XmlElement, options: XmlDiffOptions): XmlDiffNode {
  const rightXml = serializeXmlElement(right);
  return {
    kind: 'insert',
    address: buildXmlAddress(options.filePath, right),
    mergeable: true,
    rightXml,
    patch: {
      kind: 'insertNode',
      target: buildXmlAddress(options.filePath, right),
      expectedOldHash: '',
      newHash: hashXmlText(rightXml),
      replacementXml: rightXml,
    },
  };
}

function deleteDiff(left: XmlElement, options: XmlDiffOptions): XmlDiffNode {
  const leftXml = serializeXmlElement(left);
  return {
    kind: 'delete',
    address: buildXmlAddress(options.filePath, left),
    mergeable: true,
    leftXml,
    patch: {
      kind: 'deleteNode',
      target: buildXmlAddress(options.filePath, left),
      expectedOldHash: '',
      newHash: hashXmlText(''),
    },
  };
}

function groupChildren(children: readonly XmlElement[]): Map<string, XmlElement> {
  const counters = new Map<string, number>();
  const result = new Map<string, XmlElement>();

  for (const child of children) {
    const identityKey = getXmlElementIdentityKey(child);
    const ordinal = counters.get(child.localName) ?? 0;
    counters.set(child.localName, ordinal + 1);
    result.set(`${child.localName}:${identityKey ?? ordinal}`, child);
  }

  return result;
}

function sameAttributes(left: XmlElement, right: XmlElement): boolean {
  if (left.attributes.length !== right.attributes.length) {
    return false;
  }

  return left.attributes.every((leftAttr, index) => {
    const rightAttr = right.attributes[index];
    return (
      rightAttr !== undefined &&
      leftAttr.name === rightAttr.name &&
      leftAttr.value === rightAttr.value
    );
  });
}
