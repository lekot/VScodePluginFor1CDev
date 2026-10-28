import { elementChildren, getXmlElementIdentityKey, textContent, type XmlElement } from '../../xml/xmlDom';
import { metadataChildNameScope } from './semanticXmlPolicy';

/** Prevents inserting a duplicate named metadata child under a new UUID. */
export function hasMetadataSiblingNameCollision(leftParent: XmlElement, incoming: XmlElement): boolean {
  if (leftParent.localName !== 'ChildObjects' || !getXmlElementIdentityKey(incoming)) {
    return false;
  }
  const incomingName = metadataChildName(incoming);
  if (!incomingName) {
    return false;
  }
  const incomingUuid = attributeByLocalName(incoming, 'uuid');
  return elementChildren(leftParent).some((existing) =>
    metadataChildNameScope(existing.localName) === metadataChildNameScope(incoming.localName) &&
    normalizeChildName(metadataChildName(existing)) === normalizeChildName(incomingName) &&
    attributeByLocalName(existing, 'uuid') !== incomingUuid
  );
}

function metadataChildName(element: XmlElement): string | undefined {
  const properties = elementChildren(element).find((child) => child.localName === 'Properties');
  const name = properties && elementChildren(properties).find((child) => child.localName === 'Name');
  const value = name ? textContent(name).trim() : '';
  return value || undefined;
}

function normalizeChildName(value: string | undefined): string | undefined {
  return value?.normalize('NFC').toLocaleLowerCase('en-US');
}

function attributeByLocalName(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.localName.toLowerCase() === name)?.value;
}
