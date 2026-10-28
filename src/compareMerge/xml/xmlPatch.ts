import { createHash } from 'crypto';

import type { MergeFileWitness } from '../merge/mergePreview';
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
  insertBefore?: XmlAddress;
  insertPosition?: 'append';
  insertOrder?: number;
  semanticKind?: 'metadataXml' | 'formXml' | 'predefinedXml';
  semanticContext?: {
    availableFormReferences?: {
      attributes?: readonly string[];
      commands?: readonly string[];
      elements?: readonly string[];
    };
    availableMetadataReferences?: readonly string[];
  };
  expectedOldHash: string;
  newHash: string;
  replacementXml?: string;
  sourceWitnesses?: readonly MergeFileWitness[];
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
  return createHash('sha256')
    .update(source.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
    .digest('hex');
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
