import { buildXmlAddress } from '../../xml/xmlDom';
import type { XmlPatchPayload } from '../mergeAdapter';
import type { XmlElementNode } from './semanticXmlAdapter';
import { localXmlName, semanticXmlIdentityKey } from './semanticXmlIdentity';
import type { SemanticXmlKind } from './semanticXmlValidator';

export type XmlInsertionPosition = Pick<
  XmlPatchPayload,
  'insertBefore' | 'insertPosition' | 'insertOrder' | 'destinationParent' | 'createDestinationChildObjects' | 'createDestinationEvents' | 'orderScope'
>;

export function insertionPosition(
  rightParent: XmlElementNode,
  inserted: XmlElementNode,
  leftRoot: XmlElementNode,
  targetFilePath: string,
  kind: SemanticXmlKind,
  orderScope?: XmlPatchPayload['orderScope'],
): XmlInsertionPosition {
  const sourcePosition = rightParent.children.indexOf(inserted);
  if (sourcePosition < 0) {
    return { insertPosition: 'append' };
  }
  const leftParent = findCorrespondingLeft(rightParent, leftRoot, kind);
  if (!leftParent) {
    return { insertPosition: 'append', insertOrder: sourcePosition };
  }

  const leftByIdentity = new Map<string, XmlElementNode>();
  for (const child of leftParent.children) {
    const identity = semanticXmlIdentityKey(child.dom, leftParent.dom, kind);
    if (identity) {
      leftByIdentity.set(`${localXmlName(child.name)}:${identity}`, child);
    }
  }
  for (let index = sourcePosition + 1; index < rightParent.children.length; index += 1) {
    const sourceAnchor = rightParent.children[index]!;
    if (orderScope && sourceAnchor.dom.localName !== inserted.dom.localName) {continue;}
    const identity = semanticXmlIdentityKey(sourceAnchor.dom, rightParent.dom, kind);
    const targetAnchor = identity
      ? leftByIdentity.get(`${localXmlName(sourceAnchor.name)}:${identity}`)
      : undefined;
    if (targetAnchor) {
      return {
        insertBefore: buildXmlAddress(targetFilePath, targetAnchor.dom),
        insertOrder: sourcePosition,
        orderScope,
      };
    }
  }
  return { insertPosition: 'append', insertOrder: sourcePosition, orderScope };
}

function findCorrespondingLeft(
  source: XmlElementNode,
  leftRoot: XmlElementNode,
  kind: SemanticXmlKind,
): XmlElementNode | undefined {
  const sourcePath: XmlElementNode[] = [];
  let currentSource: XmlElementNode | undefined = source;
  while (currentSource) {
    sourcePath.unshift(currentSource);
    currentSource = currentSource.parent;
  }
  let currentLeft = leftRoot;
  for (let index = 1; index < sourcePath.length; index += 1) {
    const part = sourcePath[index]!;
    const sourceIdentity = semanticXmlIdentityKey(part.dom, part.parent?.dom, kind);
    const sameName = currentLeft.children.filter((child) => localXmlName(child.name) === localXmlName(part.name));
    const match = sourceIdentity
      ? sameName.find((child) => semanticXmlIdentityKey(child.dom, currentLeft.dom, kind) === sourceIdentity)
      : sameName[ordinal(part)];
    if (!match) {
      return undefined;
    }
    currentLeft = match;
  }
  return currentLeft;
}

function ordinal(element: XmlElementNode): number {
  return element.parent
    ? element.parent.children.filter((child) => localXmlName(child.name) === localXmlName(element.name)).indexOf(element)
    : 0;
}
