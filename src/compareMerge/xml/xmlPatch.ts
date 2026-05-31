import { createHash } from 'crypto';

import type { XmlAddress } from './xmlAddress';
import { parseXmlAddressPointer } from './xmlAddress';
import {
  cloneXmlElement,
  elementChildren,
  getXmlElementIdentityKey,
  parseXmlDocument,
  serializeXmlDocument,
  type XmlDocument,
  type XmlElement,
} from './xmlDom';

export interface XmlPatchPayload {
  kind: 'replaceNode' | 'insertNode' | 'deleteNode';
  target: XmlAddress;
  expectedOldHash: string;
  newHash: string;
  replacementXml?: string;
}

export function applyXmlPatch(source: string, patch: XmlPatchPayload): string {
  if (patch.expectedOldHash && hashXmlText(source) !== patch.expectedOldHash) {
    throw new Error(`XML patch hash guard failed for ${patch.target.filePath}`);
  }

  const document = parseXmlDocument(source);
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

  return serializeXmlDocument(document);
}

export function hashXmlText(source: string): string {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n').replace(/\r/g, '\n')).digest('hex');
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
    insertAttribute(document, patch);
    return;
  }

  const replacement = parseReplacement(patch);
  const segments = parseXmlAddressPointer(patch.target.pointer);
  if (segments.length < 2) {
    throw new Error('Cannot insert XML root node');
  }

  const parentPointer = `/${segments
    .slice(0, -1)
    .map((segment) => `${segment.localName}[${segment.selector}]`)
    .join('/')}`;
  const parent = findElementByPointer(document, parentPointer);
  replacement.parent = parent;

  const insertIndex = findInsertIndex(parent, segments[segments.length - 1].localName);
  parent.children.splice(insertIndex, 0, replacement);
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
      if (current.localName !== segment.localName) {
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

  return candidates.find((child) => getXmlElementIdentityKey(child) === selector);
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
  return name.includes(':') ? name.split(':').pop() ?? name : name;
}

function unescapePointer(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}
