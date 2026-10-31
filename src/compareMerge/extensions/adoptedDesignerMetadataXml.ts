import { elementChildren, textContent, type XmlDocument, type XmlElement } from '../xml/xmlDom';
import { compareOrdinalStrings } from '../ordinalStringOrder';
import {
  attribute,
  cloneWithNamespaces,
  descendants,
  direct as xmlDirect,
  expandedName,
  stableElement,
} from './adoptedDesignerXml';

const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const READABLE_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/readable';

export interface MetadataXmlProjectionIssue {
  readonly side: 'target' | 'source';
  readonly identityKey: string;
  readonly propertyName?: string;
  readonly reason: string;
}

export interface MetadataXmlObjectIdentity {
  readonly type: string;
  readonly name: string;
}

export function metadataRoot(document: XmlDocument, metadataType: string): XmlElement {
  const roots = direct(document.root, metadataType);
  if (roots.length !== 1) { throw new Error(`MetaDataObject должен содержать единственный ${metadataType}.`); }
  return roots[0]!;
}

export function direct(parent: XmlElement, name: string): XmlElement[] {
  const namespace = ['PropertyState', 'Property', 'State'].includes(name) ? READABLE_NAMESPACE : MDCLASSES_NAMESPACE;
  return xmlDirect(parent, name).filter((element) => expandedName(element) === `{${namespace}}${name}`);
}

export function childText(parent: XmlElement, name: string): string | undefined {
  const matches = direct(parent, name);
  if (matches.length !== 1) { return undefined; }
  return textContent(matches[0]!).trim();
}

export function inMetadataNamespace(element: XmlElement): boolean {
  return expandedName(element) === `{${MDCLASSES_NAMESPACE}}${element.localName}`;
}

export function inReadableNamespace(element: XmlElement): boolean {
  return expandedName(element) === `{${READABLE_NAMESPACE}}${element.localName}`;
}

export function collectForeignStructureIssues(
  document: XmlDocument,
  identity: MetadataXmlObjectIdentity,
  side: 'target' | 'source',
  issues: MetadataXmlProjectionIssue[],
): void {
  const root = metadataRoot(document, identity.type);
  const structural = new Set(['Properties', 'InternalInfo', 'ChildObjects']);
  for (const node of descendants(root)) {
    const parent = node.parent;
    if (!parent || !inMetadataNamespace(parent) || inMetadataNamespace(node)) { continue; }
    if (!structural.has(node.localName) && parent.localName !== 'Properties' && parent.localName !== 'ChildObjects'
      && !(parent.localName === 'InternalInfo' && node.localName === 'PropertyState' && !inReadableNamespace(node))) { continue; }
    const propertyName = parent.localName === 'Properties' ? node.localName : undefined;
    const identityKey = nearestMetadataChildKey(node) ?? rootKey(identity);
    addIssue(issues, side, identityKey, propertyName, `XML-узел ${node.localName} использует посторонний namespace и остаётся непроецируемым.`);
  }
}

export function exactlyOne(parent: XmlElement, name: string, reason: string): XmlElement {
  const matches = direct(parent, name);
  if (matches.length !== 1) { throw new Error(reason); }
  return matches[0]!;
}

export function singleDirect(parent: XmlElement, name: string): { node?: XmlElement; duplicate: boolean } {
  const values = direct(parent, name);
  return { ...(values[0] ? { node: values[0] } : {}), duplicate: values.length > 1 };
}

export function identityXmlEqual(left: XmlElement, right: XmlElement): boolean {
  return stableWithoutPropertyState(left) === stableWithoutPropertyState(right);
}

export function sameGeneratedTypes(left: XmlElement, right: XmlElement): boolean {
  const generated = (node: XmlElement) => direct(node, 'InternalInfo')
    .flatMap((internalInfo) => xmlDirect(internalInfo, 'GeneratedType').filter(inReadableNamespace))
    .map((item) => stableElement(item)).sort(compareOrdinalStrings).join('\n');
  return generated(left) === generated(right);
}

export function allMetadataChildren(root: XmlElement): XmlElement[] {
  const container = direct(root, 'ChildObjects')[0];
  if (!container) { return []; }
  const result: XmlElement[] = [];
  const visit = (parent: XmlElement) => {
    for (const child of elementChildren(parent)) {
      result.push(child);
      const nested = direct(child, 'ChildObjects')[0];
      if (nested) { visit(nested); }
    }
  };
  visit(container);
  return result;
}

export function metadataChildName(element: XmlElement): string | undefined {
  return childText(direct(element, 'Properties')[0] ?? element, 'Name');
}

export function isFormRegistration(element: XmlElement): boolean {
  return element.localName === 'Form'
    && inMetadataNamespace(element)
    && direct(element, 'Properties').length === 0
    && element.children.every((child) => child.kind === 'text')
    && element.attributes.every((item) => item.name === 'xmlns' || item.name.startsWith('xmlns:'))
    && textContent(element).trim().length > 0;
}

export function formRegistrationName(element: XmlElement): string | undefined {
  return isFormRegistration(element) ? textContent(element).trim() : undefined;
}

export function normalizeFormRegistrationName(name: string): string {
  return name.trim().normalize('NFC').toLocaleLowerCase('en-US');
}

export function childIdentity(child: XmlElement): string {
  const formName = formRegistrationName(child);
  if (formName) { return `form\0${normalizeFormRegistrationName(formName)}`; }
  if (child.localName === 'Form' && inMetadataNamespace(child)) { return `form-invalid\0${stableElement(child)}`; }
  return `${child.localName.toLocaleLowerCase('en-US')}\0${(attribute(child, 'uuid') ?? '').toLowerCase()}`;
}

export function physicalChildMapsTo(physical: XmlElement, base: XmlElement | undefined): boolean {
  if (!base || physical.localName !== base.localName) { return false; }
  const properties = direct(physical, 'Properties')[0];
  return childText(properties ?? physical, 'ExtendedConfigurationObject') === attribute(base, 'uuid');
}

export function childIsAdopted(child: XmlElement): boolean {
  const properties = direct(child, 'Properties')[0];
  return childText(properties ?? child, 'ObjectBelonging') === 'Adopted';
}

export function rootKey(identity: MetadataXmlObjectIdentity): string {
  return `root=${identity.type}.${identity.name}`;
}

export function addIssue(
  issues: MetadataXmlProjectionIssue[],
  side: 'target' | 'source',
  identityKey: string,
  propertyName: string | undefined,
  reason: string,
): void {
  issues.push({ side, identityKey, ...(propertyName ? { propertyName } : {}), reason });
}

export function same(left: string | undefined, right: string | undefined): boolean {
  return left?.normalize('NFC').toLocaleLowerCase('en-US') === right?.normalize('NFC').toLocaleLowerCase('en-US');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nearestMetadataChildKey(element: XmlElement): string | undefined {
  let current: XmlElement | undefined = element;
  while (current) {
    if (current.localName !== 'ChildObjects' && inMetadataNamespace(current) && attribute(current, 'uuid')) {
      return `uuid=${attribute(current, 'uuid')!.toLowerCase()}`;
    }
    current = current.parent;
  }
  return undefined;
}

function stableWithoutPropertyState(element: XmlElement): string {
  if (element.localName === 'PropertyState' && inReadableNamespace(element)) { return ''; }
  const clone = cloneWithNamespaces(element);
  const strip = (node: XmlElement) => {
    node.children = node.children.filter((child) => child.kind !== 'element'
      || child.localName !== 'PropertyState' || !inReadableNamespace(child));
    for (const child of elementChildren(node)) { strip(child); }
  };
  strip(clone);
  return stableElement(clone);
}
