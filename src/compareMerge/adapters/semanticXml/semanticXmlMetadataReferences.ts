import { METADATA_TYPE_DESCRIPTORS } from '../../../constants/metadataTypeDescriptors';
import { getExplicitGeneratedTypeSpecs } from '../../../utils/xml/metadataGeneratedTypeSchema';
import { scanKnownRootPropertyReferences, type ExtensionKnownRootPropertyScanResult } from '../../extensions/extensionKnownRootPropertyReferences';
import { elementChildren, textContent, type XmlChildNode, type XmlElement } from '../../xml/xmlDom';
import { attributeByLocalName, namespaceUriForName, normalizeQNameValue, normalizeReferenceValue } from './semanticXmlIdentity';
import { isSupportedOneCXmlNamespace } from './semanticXmlPolicy';

const CURRENT_CONFIGURATION_NAMESPACE = 'http://v8.1c.ru/8.1/data/enterprise/current-config';
const READABLE_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/readable';
const ROOT_TYPE_BY_GENERATED_PREFIX = buildGeneratedPrefixIndex();

export interface MetadataTypeReference {
  qualifiedName?: string;
  unsupported: boolean;
}

export function knownRootPropertyReferencesInXml(root: XmlElement): ExtensionKnownRootPropertyScanResult {
  return scanKnownRootPropertyReferences({ [root.name]: toParsedXmlValue(root) }, 'semantic-validation.xml');
}

export function metadataReferenceFromType(element: XmlElement): MetadataTypeReference | undefined {
  if (element.localName !== 'Type' || element.parent?.localName !== 'Type' || !isOneCElement(element)) {
    return undefined;
  }
  const expandedType = normalizeQNameValue(textContent(element), element);
  const currentConfigPrefix = `{${CURRENT_CONFIGURATION_NAMESPACE}}`;
  if (!expandedType.startsWith(currentConfigPrefix)) {
    return undefined;
  }
  const lexicalType = expandedType.slice(currentConfigPrefix.length);
  const separator = lexicalType.indexOf('.');
  if (separator <= 0 || separator === lexicalType.length - 1) {
    return { unsupported: true };
  }
  const generatedPrefix = lexicalType.slice(0, separator);
  const objectName = lexicalType.slice(separator + 1).trim().normalize('NFC');
  const rootType = ROOT_TYPE_BY_GENERATED_PREFIX.get(normalizeReferenceValue(generatedPrefix));
  return rootType && objectName
    ? { qualifiedName: `${rootType}.${objectName}`, unsupported: false }
    : { unsupported: true };
}

export function isMetadataObjectRefItem(element: XmlElement): boolean {
  const type = attributeByLocalName(element, 'type');
  return isOneCElement(element) && Boolean(type && normalizeQNameValue(type, element) === `{${READABLE_NAMESPACE}}MDObjectRef`);
}

export function metadataReferencesInSubsystemContent(root: XmlElement): string[] {
  const references = new Set<string>();
  walk(root, (subsystem) => {
    if (subsystem.localName !== 'Subsystem' || !isOneCElement(subsystem)) {
      return;
    }
    const properties = elementChildren(subsystem).find((child) => child.localName === 'Properties' && isOneCElement(child));
    const content = properties && elementChildren(properties).find((child) => child.localName === 'Content' && isOneCElement(child));
    for (const item of content ? elementChildren(content).filter(isMetadataObjectRefItem) : []) {
      const reference = textContent(item).trim().normalize('NFC');
      if (reference) {
        references.add(reference);
      }
    }
  });
  return [...references];
}

function buildGeneratedPrefixIndex(): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const descriptor of METADATA_TYPE_DESCRIPTORS) {
    const rootType = descriptor.designerRootTag;
    index.set(normalizeReferenceValue(rootType), rootType);
    for (const alias of descriptor.designerRootTagAliases ?? []) {
      index.set(normalizeReferenceValue(alias), rootType);
    }
    if (descriptor.referenceKind) {
      index.set(normalizeReferenceValue(descriptor.referenceKind), rootType);
    }
    for (const generatedType of getExplicitGeneratedTypeSpecs(rootType) ?? []) {
      index.set(normalizeReferenceValue(generatedType.namePrefix), rootType);
    }
  }
  return index;
}

function isOneCElement(element: XmlElement): boolean {
  return isSupportedOneCXmlNamespace(namespaceUriForName(element));
}

function walk(element: XmlElement, visit: (element: XmlElement) => void): void {
  visit(element);
  for (const child of elementChildren(element)) {
    walk(child, visit);
  }
}

function toParsedXmlValue(element: XmlElement): unknown {
  const children = elementChildren(element);
  if (children.length === 0) {
    return textContent(element);
  }
  const value: Record<string, unknown> = {};
  for (const child of children) {
    const childValue = toParsedXmlValue(child);
    const current = value[child.name];
    value[child.name] = current === undefined ? childValue : Array.isArray(current) ? [...current, childValue] : [current, childValue];
  }
  const attributes = Object.fromEntries(element.attributes.map((attribute) => ['@_' + attribute.name, attribute.value]));
  if (Object.keys(attributes).length > 0) {
    value[':@'] = attributes;
  }
  const directText = element.children
    .filter((child): child is Extract<XmlChildNode, { kind: 'text' | 'cdata' }> => child.kind === 'text' || child.kind === 'cdata')
    .map((child) => child.text)
    .join('');
  if (directText) {
    value['#text'] = directText;
  }
  return value;
}
