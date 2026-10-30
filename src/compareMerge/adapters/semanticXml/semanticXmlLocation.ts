import type { XmlElementNode } from './semanticXmlAdapter';
import { encodeXmlAddressComponent } from '../../xml/xmlAddress';
import { getXmlElementIdentityKey } from '../../xml/xmlDom';
import { localXmlName } from './semanticXmlIdentity';

export interface Location {
  pointer: string;
  displayPath: string;
  identityKey?: string;
}

export function selector(element: XmlElementNode): string {
  return getXmlElementIdentityKey(element.dom) ?? String(ordinal(element));
}

export function locationForRoot(element: XmlElementNode): Location {
  return {
    pointer: '/' + encodeXmlAddressComponent(localXmlName(element.name)) + '[0]',
    displayPath: element.name,
    identityKey: getXmlElementIdentityKey(element.dom),
  };
}

export function locationForElement(element: XmlElementNode): Location {
  const path = ancestors(element);
  let location = locationForRoot(path[0]!);
  for (let index = 1; index < path.length; index += 1) {
    const child = path[index]!;
    location = childLocation(location, child, selector(child));
  }
  return location;
}

export function childLocation(parent: Location, element: XmlElementNode, selectorValue: string): Location {
  return {
    pointer: parent.pointer + '/' + encodeXmlAddressComponent(localXmlName(element.name)) + '[' + encodeXmlAddressComponent(selectorValue) + ']',
    displayPath: parent.displayPath + '/' + element.name + '[' + selectorValue + ']',
    identityKey: selectorValue,
  };
}

function ordinal(element: XmlElementNode): number {
  return element.parent
    ? element.parent.children.filter((child) => localXmlName(child.name) === localXmlName(element.name)).indexOf(element)
    : 0;
}

function ancestors(element: XmlElementNode): XmlElementNode[] {
  const result: XmlElementNode[] = [];
  let current: XmlElementNode | undefined = element;
  while (current) {
    result.unshift(current);
    current = current.parent;
  }
  return result;
}
