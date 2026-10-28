import {
  elementChildren,
  getXmlElementIdentityKey,
  textContent,
  type XmlElement,
} from '../../xml/xmlDom';

export function localXmlName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}

export function directChildText(element: XmlElement | undefined, childName: string): string | undefined {
  if (!element) {
    return undefined;
  }
  const child = elementChildren(element).find((candidate) => candidate.localName === childName);
  const value = child ? textContent(child).trim() : '';
  return value || undefined;
}

export function normalizeQNameValue(value: string, context: XmlElement): string {
  const normalized = value.trim().normalize('NFC');
  const separator = normalized.indexOf(':');
  if (separator <= 0 || separator !== normalized.lastIndexOf(':') || separator === normalized.length - 1) {
    return normalized;
  }

  const prefix = normalized.slice(0, separator);
  const localPart = normalized.slice(separator + 1);
  const namespace = namespaceForPrefix(context, prefix!);
  return namespace ? `{${namespace}}${localPart}` : normalized;
}

export function unboundQNamePrefix(value: string, context: XmlElement): string | undefined {
  const normalized = value.trim().normalize('NFC');
  const separator = normalized.indexOf(':');
  if (separator <= 0 || separator === normalized.length - 1 || separator !== normalized.lastIndexOf(':')) {
    return undefined;
  }
  const prefix = normalized.slice(0, separator);
  return prefix === 'xml' || namespaceForPrefix(context, prefix) ? undefined : prefix;
}

export function normalizeReferenceValue(value: string): string {
  return value.trim().normalize('NFC').toLocaleLowerCase('en-US');
}

export function namespaceUriForName(element: XmlElement, qualifiedName = element.name, attribute = false): string | undefined {
  const separator = qualifiedName.indexOf(':');
  if (separator < 0) {
    return attribute ? '' : namespaceForPrefix(element, '');
  }
  const prefix = qualifiedName.slice(0, separator);
  return namespaceForPrefix(element, prefix);
}

export function expandedXmlName(element: XmlElement): string {
  const namespace = namespaceUriForName(element);
  return namespace ? `{${namespace}}${element.localName}` : element.localName;
}

export function semanticXmlIdentityKey(
  element: XmlElement,
  parent: XmlElement | undefined,
  kind: 'metadataXml' | 'formXml' | 'predefinedXml'
): string | undefined {
  if (kind === 'metadataXml' && parent?.localName === 'MetaDataObject' && attributeByLocalName(element, 'uuid') && !hasCfeMetadataMarker(parent)) {
    const name = directChildText(elementChildren(element).find((child) => child.localName === 'Properties'), 'Name');
    if (name) {
      return `metadata-root=${expandedXmlName(element)};name=${normalizeReferenceValue(name)}`;
    }
  }
  return getXmlElementIdentityKey(element);
}

export function hasCfeMetadataMarker(root: XmlElement): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const element = pending.pop()!;
    if (['ObjectBelonging', 'ExtendedConfigurationObject', 'ConfigurationExtensionPurpose'].includes(element.localName)) {
      return true;
    }
    pending.push(...elementChildren(element));
  }
  return false;
}

export function attributeByLocalName(element: XmlElement, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return element.attributes.find((attribute) => attribute.localName.toLowerCase() === normalizedName)?.value;
}

export function attributeValue(element: XmlElement, qualifiedName: string): string | undefined {
  return element.attributes.find((attribute) => attribute.name === qualifiedName)?.value;
}

function namespaceForPrefix(element: XmlElement, prefix: string): string | undefined {
  let current: XmlElement | undefined = element;
  while (current) {
    const declaration = current.attributes.find((attribute) => attribute.name === (prefix ? `xmlns:${prefix}` : 'xmlns'));
    if (declaration) {
      return declaration.value;
    }
    current = current.parent;
  }
  return undefined;
}
