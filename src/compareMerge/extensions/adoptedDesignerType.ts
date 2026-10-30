import { cloneXmlElement, elementChildren, textContent, type XmlElement } from '../xml/xmlDom';
import { attach, cloneWithNamespaces, direct, expandQName } from './adoptedDesignerXml';

const EXTENSION_NAMESPACE = 'http://v8.1c.ru/8.3/xcf/readable';
const CORE_NAMESPACE = 'http://v8.1c.ru/8.1/data/core';
const MDCLASSES_NAMESPACE = 'http://v8.1c.ru/8.3/MDClasses';
const XSI_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';

/** Flattens a verified xr:ExtendedProperty Type into an ordinary TypeDescription. */
export function flattenExtendedType(
  base: XmlElement | undefined,
  overlay: XmlElement,
  formatVersion: string,
  resolveTypeId?: (typeId: string) => string | undefined,
): XmlElement | undefined {
  if (!base || !['2.19', '2.20', '2.21'].includes(formatVersion) || !hasExtendedPropertyShape(overlay)) { return undefined; }
  const extension = directIn(overlay, 'ExtendValue', EXTENSION_NAMESPACE)[0];
  if (!extension || !hasXsiType(extension, `{${CORE_NAMESPACE}}TypeDescription`)
    || !isTypeDescription(extension, resolveTypeId) || !isTypeDescription(base, resolveTypeId)) { return undefined; }
  const baseTypes = typeMembers(base, resolveTypeId);
  const extensionTypes = typeMembers(extension, resolveTypeId);
  if (!baseTypes || !extensionTypes) { return undefined; }
  const target = cloneXmlElement(base);
  target.attributes = target.attributes.filter((attribute) => attribute.localName !== 'type');
  target.children = target.children.filter((child) => child.kind !== 'element' || !isTypeShapeChild(child.localName));
  for (const type of mergeTypeMembers(baseTypes, extensionTypes)) { attach(target, cloneWithNamespaces(type)); }
  for (const qualifier of ['StringQualifiers', 'NumberQualifiers', 'DateQualifiers']) {
    const baseMatches = directIn(base, qualifier, CORE_NAMESPACE);
    const extensionMatches = directIn(extension, qualifier, CORE_NAMESPACE);
    if (baseMatches.length > 1 || extensionMatches.length > 1) { return undefined; }
    const merged = mergeQualifier(qualifier, baseMatches[0], extensionMatches[0]);
    if (merged === null) { return undefined; }
    if (merged) { attach(target, cloneWithNamespaces(merged)); }
  }
  return target;
}

/** Returns true only for an xr:ExtendedProperty wrapper bound to the expected namespace. */
export function isExtendedPropertyWrapper(type: XmlElement): boolean {
  return hasExtendedPropertyShape(type);
}

/** Detects the xsi:type marker even when the wrapper's child shape is malformed. */
export function hasExtendedPropertyMarker(type: XmlElement): boolean {
  return hasXsiType(type, `{${EXTENSION_NAMESPACE}}ExtendedProperty`);
}

/** Validates a plain, non-wrapper TypeDescription for a Notify replacement. */
export function isPlainTypeDescription(type: XmlElement): boolean {
  return !hasExtendedPropertyMarker(type) && isTypeDescription(type);
}

function mergeQualifier(kind: string, base: XmlElement | undefined, extension: XmlElement | undefined): XmlElement | undefined | null {
  if (!base) { return extension ? cloneWithNamespaces(extension) : undefined; }
  if (!extension) { return cloneWithNamespaces(base); }
  const baseFields = base ? qualifierFields(base) : undefined;
  const extensionFields = extension ? qualifierFields(extension) : undefined;
  if ((base && !baseFields) || (extension && !extensionFields)
    || (baseFields && !validQualifier(kind, baseFields)) || (extensionFields && !validQualifier(kind, extensionFields))) { return null; }
  if (!base) { return extension ? cloneWithNamespaces(extension) : undefined; }
  if (!extension) { return cloneWithNamespaces(base); }
  if (!baseFields || !extensionFields) { return null; }
  const result = cloneXmlElement(base);
  result.children = result.children.filter((child) => child.kind !== 'element');
  if (kind === 'StringQualifiers') {
    const leftLength = numericField(baseFields, 'Length');
    const rightLength = numericField(extensionFields, 'Length');
    const leftAllowed = fieldText(baseFields, 'AllowedLength');
    const rightAllowed = fieldText(extensionFields, 'AllowedLength');
    if (leftLength === undefined || rightLength === undefined || leftLength < 0 || rightLength < 0 || !leftAllowed || !rightAllowed
      || !['Variable', 'Fixed'].includes(leftAllowed) || !['Variable', 'Fixed'].includes(rightAllowed)) { return null; }
    const length = leftLength === 0 || rightLength === 0 ? 0 : Math.max(leftLength, rightLength);
    const allowed = leftAllowed === 'Variable' || rightAllowed === 'Variable' ? 'Variable' : 'Fixed';
    appendTextField(result, 'Length', String(length), baseFields.get('Length') ?? extensionFields.get('Length'));
    appendTextField(result, 'AllowedLength', allowed, baseFields.get('AllowedLength') ?? extensionFields.get('AllowedLength'));
    return result;
  }
  if (kind === 'NumberQualifiers') {
    const leftDigits = numericField(baseFields, 'Digits');
    const rightDigits = numericField(extensionFields, 'Digits');
    const leftFraction = numericField(baseFields, 'FractionDigits');
    const rightFraction = numericField(extensionFields, 'FractionDigits');
    const leftSign = fieldText(baseFields, 'AllowedSign');
    const rightSign = fieldText(extensionFields, 'AllowedSign');
    if (leftDigits === undefined || rightDigits === undefined || leftFraction === undefined || rightFraction === undefined
      || !leftSign || !rightSign || !['Any', 'Nonnegative'].includes(leftSign) || !['Any', 'Nonnegative'].includes(rightSign)
      || !validNumberQualifiers(leftDigits, leftFraction) || !validNumberQualifiers(rightDigits, rightFraction)) { return null; }
    const fractionDigits = Math.max(leftFraction, rightFraction);
    const integerCapacity = Math.max(leftDigits - leftFraction, rightDigits - rightFraction);
    const digits = integerCapacity + fractionDigits;
    if (!validNumberQualifiers(digits, fractionDigits)) { return null; }
    const allowedSign = leftSign === 'Any' || rightSign === 'Any' ? 'Any' : 'Nonnegative';
    appendTextField(result, 'Digits', String(digits), baseFields.get('Digits') ?? extensionFields.get('Digits'));
    appendTextField(result, 'FractionDigits', String(fractionDigits), baseFields.get('FractionDigits') ?? extensionFields.get('FractionDigits'));
    appendTextField(result, 'AllowedSign', allowedSign, baseFields.get('AllowedSign') ?? extensionFields.get('AllowedSign'));
    return result;
  }
  if (kind === 'DateQualifiers') {
    const left = fieldText(baseFields, 'DateFractions');
    const right = fieldText(extensionFields, 'DateFractions');
    if (!left || !right || !['Date', 'Time', 'DateTime'].includes(left) || !['Date', 'Time', 'DateTime'].includes(right)) { return null; }
    const merged = left === right ? left : 'DateTime';
    appendTextField(result, 'DateFractions', merged, baseFields.get('DateFractions') ?? extensionFields.get('DateFractions'));
    return result;
  }
  return null;
}

function qualifierFields(qualifier: XmlElement): Map<string, XmlElement> | undefined {
  if (namespaceUri(qualifier) !== CORE_NAMESPACE || !hasOnlyNamespaceAttributes(qualifier)) { return undefined; }
  const result = new Map<string, XmlElement>();
  for (const field of elementChildren(qualifier)) {
    if (namespaceUri(field) !== CORE_NAMESPACE || !hasOnlyNamespaceAttributes(field)) { return undefined; }
    if (result.has(field.localName)) { return undefined; }
    if (!['Length', 'AllowedLength', 'Digits', 'FractionDigits', 'AllowedSign', 'DateFractions'].includes(field.localName)) { return undefined; }
    result.set(field.localName, field);
  }
  return result;
}

function appendTextField(parent: XmlElement, name: string, value: string, template?: XmlElement): void {
  const field = template ? cloneWithNamespaces(template) : { kind: 'element' as const, name: `v8:${name}`, localName: name, attributes: [], children: [] };
  field.children = [{ kind: 'text', text: value }];
  attach(parent, field);
}

function typeMembers(type: XmlElement, resolveTypeId?: (typeId: string) => string | undefined): XmlElement[] | undefined {
  if (namespaceUri(type) !== CORE_NAMESPACE && namespaceUri(type) !== MDCLASSES_NAMESPACE
    && !hasXsiType(type, `{${CORE_NAMESPACE}}TypeDescription`)) { return undefined; }
  if (!hasOnlyNamespaceAttributes(type, true)) { return undefined; }
  const children = elementChildren(type);
  const members: XmlElement[] = [];
  for (const child of children) {
    if (namespaceUri(child) !== CORE_NAMESPACE || !isTypeShapeChild(child.localName)) { return undefined; }
    if (child.localName === 'TypeId') {
      if (!resolveTypeId || !hasOnlyNamespaceAttributes(child)) { return undefined; }
      const resolved = resolveTypeId(textContent(child).trim());
      if (!resolved) { return undefined; }
      members.push(makeCanonicalTypeMember(resolved));
      continue;
    }
    if (child.localName === 'Type' || child.localName === 'TypeSet') { members.push(child); }
  }
  if (members.length === 0 || members.some((member) => !hasOnlyNamespaceAttributes(member) || !textContent(member).trim())) { return undefined; }
  return members;
}

function mergeTypeMembers(base: readonly XmlElement[], extension: readonly XmlElement[]): XmlElement[] {
  const result: XmlElement[] = [];
  const seen = new Set<string>();
  for (const member of [...base, ...extension]) {
    const value = expandQName(member, textContent(member).trim());
    const key = `${member.localName}\0${value}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    result.push(member);
  }
  return result;
}

function isTypeDescription(type: XmlElement, resolveTypeId?: (typeId: string) => string | undefined): boolean {
  return Boolean(typeMembers(type, resolveTypeId));
}

function isTypeShapeChild(name: string): boolean {
  return name === 'Type' || name === 'TypeSet' || name === 'TypeId' || name === 'StringQualifiers'
    || name === 'NumberQualifiers' || name === 'DateQualifiers';
}

function makeCanonicalTypeMember(qualifiedName: string): XmlElement {
  return {
    kind: 'element',
    name: 'v8:Type',
    localName: 'Type',
    attributes: [
      { name: 'xmlns:v8', localName: 'v8', value: CORE_NAMESPACE, quote: '"' },
      { name: 'xmlns:cfg', localName: 'cfg', value: 'http://v8.1c.ru/8.1/data/enterprise/current-config', quote: '"' },
    ],
    children: [{ kind: 'text', text: qualifiedName }],
  };
}

function hasExtendedPropertyShape(type: XmlElement): boolean {
  return hasXsiType(type, `{${EXTENSION_NAMESPACE}}ExtendedProperty`)
    && directIn(type, 'ExtendValue', EXTENSION_NAMESPACE).length === 1;
}

function hasXsiType(element: XmlElement, expected: string): boolean {
  const xsiType = element.attributes.find((attribute) => attribute.localName === 'type'
    && namespaceForAttribute(element, attribute.name) === XSI_NAMESPACE)?.value;
  return xsiType !== undefined && expandQName(element, xsiType) === expected;
}

function namespaceForAttribute(element: XmlElement, name: string): string | undefined {
  const colon = name.indexOf(':');
  if (colon <= 0) { return undefined; }
  const prefix = name.slice(0, colon);
  let current: XmlElement | undefined = element;
  while (current) {
    const declaration = current.attributes.find((attribute) => attribute.name === `xmlns:${prefix}`);
    if (declaration) { return declaration.value; }
    current = current.parent;
  }
  return undefined;
}

function namespaceUri(element: XmlElement): string | undefined {
  const colon = element.name.indexOf(':');
  const prefix = colon < 0 ? '' : element.name.slice(0, colon);
  const declarationName = prefix ? `xmlns:${prefix}` : 'xmlns';
  let current: XmlElement | undefined = element;
  while (current) {
    const declaration = current.attributes.find((attribute) => attribute.name === declarationName);
    if (declaration) { return declaration.value || undefined; }
    current = current.parent;
  }
  return undefined;
}

function directIn(parent: XmlElement, localName: string, namespace: string): XmlElement[] {
  return direct(parent, localName).filter((element) => namespaceUri(element) === namespace);
}

function hasOnlyNamespaceAttributes(element: XmlElement, allowTypeDescription = false): boolean {
  return element.attributes.every((attribute) => {
    if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) { return true; }
    return allowTypeDescription && attribute.localName === 'type'
      && namespaceForAttribute(element, attribute.name) === XSI_NAMESPACE
      && hasXsiType(element, `{${CORE_NAMESPACE}}TypeDescription`);
  });
}

function validNumberQualifiers(digits: number, fractionDigits: number): boolean {
  return Number.isInteger(digits) && digits >= 1 && digits <= 38
    && Number.isInteger(fractionDigits) && fractionDigits >= 0 && fractionDigits <= digits && fractionDigits <= 38;
}

function validQualifier(kind: string, fields: ReadonlyMap<string, XmlElement>): boolean {
  if (kind === 'StringQualifiers') {
    const length = numericField(fields, 'Length');
    const allowed = fieldText(fields, 'AllowedLength');
    return fields.size === 2 && length !== undefined && length >= 0 && ['Fixed', 'Variable'].includes(allowed ?? '');
  }
  if (kind === 'NumberQualifiers') {
    const digits = numericField(fields, 'Digits');
    const fraction = numericField(fields, 'FractionDigits');
    const sign = fieldText(fields, 'AllowedSign');
    return fields.size === 3 && digits !== undefined && fraction !== undefined
      && validNumberQualifiers(digits, fraction) && ['Any', 'Nonnegative'].includes(sign ?? '');
  }
  if (kind === 'DateQualifiers') {
    const fractions = fieldText(fields, 'DateFractions');
    return fields.size === 1 && ['Date', 'Time', 'DateTime'].includes(fractions ?? '');
  }
  return false;
}

function appendTextFieldValue(node: XmlElement): string | undefined {
  const value = textContent(node).trim();
  return value || undefined;
}

function fieldText(fields: ReadonlyMap<string, XmlElement>, name: string): string | undefined {
  const field = fields.get(name);
  return field ? appendTextFieldValue(field) : undefined;
}

function numericField(fields: ReadonlyMap<string, XmlElement>, name: string): number | undefined {
  const value = fieldText(fields, name);
  if (value === undefined || !/^\d+$/u.test(value)) { return undefined; }
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}
