import { parseXdtoPackage } from '../parsers/xdtoPackageParser';
import type { XdtoPackageModel, XdtoProperty, XdtoRawNode, XdtoTypeDefinition } from '../types/xdtoPackage';
import { stripUtf8Bom } from './xdtoPackageFiles';

const XS_NS = 'http://www.w3.org/2001/XMLSchema';
const XDTO_NS = 'http://v8.1c.ru/8.1/xdto';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const ONE_C_ATTRIBUTE_FACETS = new Set(['length', 'minLength', 'maxLength', 'totalDigits', 'fractionDigits', 'whiteSpace']);
const ONE_C_CHILD_FACETS = new Set(['pattern', 'enumeration', 'maxInclusive', 'maxExclusive', 'minInclusive', 'minExclusive']);
const XSD_LINE_SEPARATOR = '\r\n';

interface XsdExportContext {
  targetNamespace: string;
  localTypeNames: ReadonlySet<string>;
  importedNamespacePrefixes: ReadonlyMap<string, string>;
  sourcePrefixToNamespace: ReadonlyMap<string, string>;
  additionalNamespacePrefixes: ReadonlyArray<[string, string]>;
}

export function convert1cPackageToXsd(source: string): string {
  const model = parseWithoutBlockingErrors(source);
  const context = buildXsdExportContext(model);
  const lines = [
    `\uFEFF<xs:schema${schemaNamespaceAttrs(context)} attributeFormDefault="unqualified" elementFormDefault="qualified">`,
  ];

  for (const item of model.imports) {
    lines.push(`\t<xs:import${attr('namespace', item.namespace)}${attr('schemaLocation', item.schemaLocation)}/>`);
  }

  for (const type of model.valueTypes) {
    lines.push(`\t<xs:simpleType name="${escapeXml(type.name)}">`);
    if (type.baseType) {
      appendXsdRestriction(lines, type, context, '\t\t');
    }
    lines.push('\t</xs:simpleType>');
  }

  for (const type of model.objectTypes) {
    lines.push(`\t<xs:complexType name="${escapeXml(type.name)}">`);
    if (type.baseType) {
      lines.push(`\t\t<xs:complexContent>`);
      lines.push(
        `\t\t\t<xs:extension base="${escapeXml(xsdRequiredTypeReference(type.baseType, context, type.raw))}">`
      );
      appendXsdObjectMembers(lines, type, '\t\t\t\t', context);
      lines.push(`\t\t\t</xs:extension>`);
      lines.push(`\t\t</xs:complexContent>`);
    } else {
      appendXsdObjectMembers(lines, type, '\t\t', context);
    }
    lines.push('\t</xs:complexType>');
  }

  for (const property of model.rootProperties) {
    appendXsdElement(lines, property, '\t', context);
  }

  lines.push('</xs:schema>');
  return lines.join(XSD_LINE_SEPARATOR);
}

export function convertXsdTo1cPackage(source: string, fallbackNamespace = ''): string {
  const model = parseWithoutBlockingErrors(source);
  const targetNamespace = model.targetNamespace ?? fallbackNamespace.trim();
  const namespaceDeclarations = rootNamespaceDeclarationAttrs(model);
  const lines = [
    `\uFEFF<package xmlns="${XDTO_NS}" xmlns:xs="${XS_NS}" xmlns:xsi="${XSI_NS}"${namespaceDeclarations}${attr('targetNamespace', targetNamespace)}>`,
  ];

  for (const item of model.imports) {
    lines.push(`  <import${attr('namespace', item.namespace)}${attr('schemaLocation', item.schemaLocation)}/>`);
  }

  for (const type of model.valueTypes) {
    appendOneCValueType(lines, type);
  }

  for (const type of model.objectTypes) {
    lines.push(`  <objectType name="${escapeXml(type.name)}"${attr('base', type.baseType)}>`);
    for (const property of type.attributes) {
      lines.push(`    <property${oneCPackagePropertyAttrs(property, true)}/>`);
    }
    for (const property of type.properties) {
      lines.push(`    <property${oneCPackagePropertyAttrs(property, false)}/>`);
    }
    lines.push('  </objectType>');
  }

  for (const property of model.rootProperties) {
    lines.push(`  <property${oneCPackagePropertyAttrs(property, false)}/>`);
  }

  lines.push('</package>', '');
  return lines.join('\r\n');
}

function appendXsdRestriction(
  lines: string[],
  type: XdtoTypeDefinition,
  context: XsdExportContext,
  indent: string
): void {
  const base = escapeXml(xsdRequiredTypeReference(type.baseType ?? '', context, type.raw));
  if (type.facets.length === 0) {
    lines.push(`${indent}<xs:restriction base="${base}"/>`);
    return;
  }
  lines.push(`${indent}<xs:restriction base="${base}">`);
  for (const facet of type.facets) {
    lines.push(`${indent}\t<xs:${facet.name} value="${escapeXml(facet.value)}"/>`);
  }
  lines.push(`${indent}</xs:restriction>`);
}

function appendOneCValueType(lines: string[], type: XdtoTypeDefinition): void {
  const attributeFacets = type.facets.filter((facet) => ONE_C_ATTRIBUTE_FACETS.has(facet.name));
  const childFacets = type.facets.filter((facet) => ONE_C_CHILD_FACETS.has(facet.name));
  const variety = type.variety ?? (childFacets.length > 0 ? 'Atomic' : undefined);
  const attrs = [
    ` name="${escapeXml(type.name)}"`,
    attr('base', type.baseType),
    attr('variety', variety),
    ...attributeFacets.map((facet) => attr(facet.name, facet.value)),
  ].join('');
  if (childFacets.length === 0) {
    lines.push(`  <valueType${attrs}/>`);
    return;
  }
  lines.push(`  <valueType${attrs}>`);
  for (const facet of childFacets) {
    lines.push(`    <${facet.name}>${escapeText(facet.value)}</${facet.name}>`);
  }
  lines.push('  </valueType>');
}

function parseWithoutBlockingErrors(source: string): XdtoPackageModel {
  const model = parseXdtoPackage(stripUtf8Bom(source));
  const error = model.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  if (error) {
    throw new Error(error.message);
  }
  return model;
}

function appendXsdObjectMembers(
  lines: string[],
  type: XdtoTypeDefinition,
  indent: string,
  context: XsdExportContext
): void {
  const open = rawAttr(type.raw, 'open') === 'true';
  if (type.properties.length > 0 || open) {
    lines.push(`${indent}<xs:sequence>`);
    for (const property of type.properties) {
      appendXsdElement(lines, property, `${indent}\t`, context);
    }
    if (open) {
      appendXsdAny(lines, `${indent}\t`);
    }
    lines.push(`${indent}</xs:sequence>`);
  }
  for (const attribute of type.attributes) {
    lines.push(`${indent}<xs:attribute${xsdAttributeAttrs(attribute, context)}/>`);
  }
  if (open) {
    appendXsdAnyAttribute(lines, indent);
  }
}

function appendXsdElement(
  lines: string[],
  property: XdtoProperty,
  indent: string,
  context: XsdExportContext
): void {
  const typeDef = rawChild(property.raw, 'typeDef');
  if (!typeDef) {
    lines.push(`${indent}<xs:element${xsdPropertyAttrs(property, context)}/>`);
    return;
  }

  lines.push(`${indent}<xs:element${xsdPropertyAttrs(property, context)}>`);
  appendAnonymousTypeDef(lines, typeDef, `${indent}\t`, context);
  lines.push(`${indent}</xs:element>`);
}

function appendAnonymousTypeDef(
  lines: string[],
  typeDef: XdtoRawNode,
  indent: string,
  context: XsdExportContext
): void {
  const xsiType = rawAttr(typeDef, 'xsi:type');
  if (xsiType === 'ValueType') {
    appendAnonymousSimpleType(lines, typeDef, indent, context);
    return;
  }
  if (xsiType === 'ObjectType') {
    appendAnonymousComplexType(lines, typeDef, indent, context);
  }
}

function appendAnonymousSimpleType(
  lines: string[],
  typeDef: XdtoRawNode,
  indent: string,
  context: XsdExportContext
): void {
  const memberTypes = rawAttr(typeDef, 'memberTypes');
  if (rawAttr(typeDef, 'variety') === 'Union' && memberTypes) {
    lines.push(`${indent}<xs:simpleType>`);
    lines.push(`${indent}\t<xs:union memberTypes="${escapeXml(xsdMemberTypes(memberTypes, context))}"/>`);
    lines.push(`${indent}</xs:simpleType>`);
    return;
  }

  const base = escapeXml(xsdRequiredTypeReference(rawAttr(typeDef, 'base') ?? '', context, typeDef));
  const facets = rawTypeFacets(typeDef);
  lines.push(`${indent}<xs:simpleType>`);
  if (facets.length === 0) {
    lines.push(`${indent}\t<xs:restriction base="${base}"/>`);
  } else {
    lines.push(`${indent}\t<xs:restriction base="${base}">`);
    for (const facet of facets) {
      lines.push(`${indent}\t\t<xs:${facet.name} value="${escapeXml(facet.value)}"/>`);
    }
    lines.push(`${indent}\t</xs:restriction>`);
  }
  lines.push(`${indent}</xs:simpleType>`);
}

function appendAnonymousComplexType(
  lines: string[],
  typeDef: XdtoRawNode,
  indent: string,
  context: XsdExportContext
): void {
  const properties = rawChildren(typeDef, 'property');
  const open = rawAttr(typeDef, 'open') === 'true';
  const compositor = rawAttr(typeDef, 'ordered') === 'false' ? 'choice' : 'sequence';
  lines.push(`${indent}<xs:complexType>`);
  if (properties.length > 0 || open) {
    lines.push(`${indent}\t<xs:${compositor}>`);
    for (const property of properties) {
      appendXsdElement(lines, rawPropertyToModel(property), `${indent}\t\t`, context);
    }
    if (open) {
      appendXsdAny(lines, `${indent}\t\t`);
    }
    lines.push(`${indent}\t</xs:${compositor}>`);
  }
  if (open) {
    appendXsdAnyAttribute(lines, `${indent}\t`);
  }
  lines.push(`${indent}</xs:complexType>`);
}

function appendXsdAny(lines: string[], indent: string): void {
  lines.push(`${indent}<xs:any namespace="##any" processContents="lax" minOccurs="0" maxOccurs="unbounded"/>`);
}

function appendXsdAnyAttribute(lines: string[], indent: string): void {
  lines.push(`${indent}<xs:anyAttribute namespace="##any" processContents="lax"/>`);
}

function schemaNamespaceAttrs(context: XsdExportContext): string {
  const attrs: string[] = [];
  for (const [namespace, prefix] of context.importedNamespacePrefixes) {
    attrs.push(` xmlns:${prefix}="${escapeXml(namespace)}"`);
  }
  if (context.targetNamespace) {
    attrs.push(` xmlns:tns="${escapeXml(context.targetNamespace)}"`);
  }
  attrs.push(` xmlns:xs="${XS_NS}"`);
  for (const [prefix, namespace] of context.additionalNamespacePrefixes) {
    attrs.push(` xmlns:${prefix}="${escapeXml(namespace)}"`);
  }
  if (context.targetNamespace) {
    attrs.push(` targetNamespace="${escapeXml(context.targetNamespace)}"`);
  }
  return attrs.join('');
}

function xsdPropertyAttrs(
  property: XdtoProperty,
  context: XsdExportContext
): string {
  const minOccurs = normalizeDefaultOccurrence(property.minOccurs ?? property.lowerBound);
  const maxOccurs = normalizeDefaultOccurrence(property.maxOccurs ?? normalizeUpperBound(property.upperBound));
  return [
    attr('name', property.name),
    attr('type', xsdTypeReference(property.type, context, property.raw)),
    attr('nillable', property.nillable === 'false' ? undefined : property.nillable),
    attr('minOccurs', minOccurs),
    attr('maxOccurs', maxOccurs),
    attr('fixed', property.fixed),
    attr('default', property.defaultValue),
  ].join('');
}

function xsdAttributeAttrs(
  property: XdtoProperty,
  context: XsdExportContext
): string {
  const use = property.use ?? (property.lowerBound && property.lowerBound !== '0' ? 'required' : undefined);
  return [
    attr('name', property.name),
    attr('type', xsdTypeReference(property.type, context, property.raw)),
    attr('use', use),
    attr('fixed', property.fixed),
    attr('default', property.defaultValue),
  ].join('');
}

function collectLocalTypeNames(model: XdtoPackageModel): ReadonlySet<string> {
  return new Set([
    ...model.valueTypes.map((type) => type.name),
    ...model.objectTypes.map((type) => type.name),
  ]);
}

function buildXsdExportContext(model: XdtoPackageModel): XsdExportContext {
  const sourcePrefixToNamespace = collectNamespacePrefixes(model.rawRoot);
  const importedNamespacePrefixes = new Map<string, string>();
  for (const item of model.imports) {
    if (!item.namespace || importedNamespacePrefixes.has(item.namespace)) {
      continue;
    }
    importedNamespacePrefixes.set(item.namespace, `ns${importedNamespacePrefixes.size + 1}`);
  }
  return {
    targetNamespace: model.targetNamespace ?? '',
    localTypeNames: collectLocalTypeNames(model),
    importedNamespacePrefixes,
    sourcePrefixToNamespace,
    additionalNamespacePrefixes: additionalNamespacePrefixes(sourcePrefixToNamespace, model.targetNamespace ?? '', importedNamespacePrefixes),
  };
}

function xsdTypeReference(
  value: string | undefined,
  context: XsdExportContext,
  raw?: XdtoRawNode
): string | undefined {
  if (!value) {
    return value;
  }
  if (!value.includes(':')) {
    return context.targetNamespace && context.localTypeNames.has(value)
      ? `tns:${value}`
      : value;
  }

  const separator = value.indexOf(':');
  const prefix = value.slice(0, separator);
  const local = value.slice(separator + 1);
  const namespace = rawNamespacePrefix(raw, prefix)
    ?? context.sourcePrefixToNamespace.get(prefix)
    ?? inferMissingPrefixNamespace(prefix, context);
  if (namespace === XS_NS) {
    return value;
  }
  if (namespace && namespace === context.targetNamespace) {
    return `tns:${local}`;
  }
  if (namespace) {
    const importPrefix = context.importedNamespacePrefixes.get(namespace);
    return importPrefix ? `${importPrefix}:${local}` : value;
  }
  return value;
}

function xsdRequiredTypeReference(
  value: string,
  context: XsdExportContext,
  raw?: XdtoRawNode
): string {
  return xsdTypeReference(value, context, raw) ?? value;
}

function xsdMemberTypes(value: string, context: XsdExportContext): string {
  return value.split(/\s+/)
    .filter(Boolean)
    .map((item) => xsdTypeReferenceFromClarkName(item, context))
    .join(' ');
}

function xsdTypeReferenceFromClarkName(value: string, context: XsdExportContext): string {
  const match = /^\{([^}]+)\}(.+)$/.exec(value);
  if (!match) {
    return xsdTypeReference(value, context) ?? value;
  }
  const [, namespace, local] = match;
  if (namespace === XS_NS) {
    return `xs:${local}`;
  }
  if (namespace === context.targetNamespace) {
    return `tns:${local}`;
  }
  const importPrefix = context.importedNamespacePrefixes.get(namespace);
  return importPrefix ? `${importPrefix}:${local}` : local;
}

function inferMissingPrefixNamespace(prefix: string, context: XsdExportContext): string | undefined {
  if (!/^d\d+p\d+$/i.test(prefix)) {
    return undefined;
  }
  if (context.importedNamespacePrefixes.size === 1) {
    return Array.from(context.importedNamespacePrefixes.keys())[0];
  }
  return undefined;
}

function collectNamespacePrefixes(raw: unknown): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  visitRaw(raw, (node) => {
    for (const [key, value] of Object.entries(node)) {
      if (!key.startsWith('@_xmlns:') || typeof value !== 'string') {
        continue;
      }
      result.set(key.slice('@_xmlns:'.length), value);
    }
  });
  return result;
}

function rawNamespacePrefix(raw: XdtoRawNode | undefined, prefix: string): string | undefined {
  const value = raw?.[`@_xmlns:${prefix}`];
  return typeof value === 'string' ? value : undefined;
}

function additionalNamespacePrefixes(
  sourcePrefixToNamespace: ReadonlyMap<string, string>,
  targetNamespace: string,
  importedNamespacePrefixes: ReadonlyMap<string, string>
): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const [prefix, namespace] of sourcePrefixToNamespace) {
    if (prefix === 'xs' || prefix === 'xsi' || prefix === 'tns' || namespace === targetNamespace || importedNamespacePrefixes.has(namespace)) {
      continue;
    }
    result.push([prefix, namespace]);
  }
  return result;
}

function rootNamespaceDeclarationAttrs(model: XdtoPackageModel): string {
  const root = model.rawRoot;
  if (!root) {
    return '';
  }

  return Object.entries(root)
    .filter(([key, value]) => isRootNamespaceDeclaration(key, value))
    .map(([key, value]) => ` ${key.slice(2)}="${escapeXml(value as string)}"`)
    .join('');
}

function isRootNamespaceDeclaration(key: string, value: unknown): boolean {
  if (typeof value !== 'string' || !key.startsWith('@_xmlns:')) {
    return false;
  }

  const prefix = key.slice('@_xmlns:'.length);
  return prefix !== 'xs' && prefix !== 'xsi';
}

function rawPropertyToModel(raw: XdtoRawNode): XdtoProperty {
  const form = rawAttr(raw, 'form');
  return {
    name: rawAttr(raw, 'name') ?? '',
    type: rawAttr(raw, 'type'),
    ref: rawAttr(raw, 'ref'),
    namespaceURI: rawAttr(raw, 'namespaceURI'),
    localName: rawAttr(raw, 'localName'),
    qualified: rawAttr(raw, 'qualified'),
    nillable: rawAttr(raw, 'nillable'),
    fixed: rawAttr(raw, 'fixed'),
    defaultValue: rawAttr(raw, 'default'),
    minOccurs: rawAttr(raw, 'minOccurs'),
    maxOccurs: rawAttr(raw, 'maxOccurs'),
    lowerBound: rawAttr(raw, 'lowerBound'),
    upperBound: rawAttr(raw, 'upperBound'),
    form,
    use: rawAttr(raw, 'use'),
    raw,
    unknownNodes: [],
  };
}

function rawTypeFacets(raw: XdtoRawNode): Array<{ name: string; value: string }> {
  const facets: Array<{ name: string; value: string }> = [];
  for (const name of ONE_C_ATTRIBUTE_FACETS) {
    const value = rawAttr(raw, name);
    if (value !== undefined) {
      facets.push({ name, value });
    }
  }
  for (const name of ONE_C_CHILD_FACETS) {
    for (const value of rawFacetValues(raw, name)) {
      facets.push({ name, value });
    }
  }
  return facets;
}

function rawAttr(raw: XdtoRawNode, name: string): string | undefined {
  const value = raw[`@_${name}`];
  return typeof value === 'string' ? value : undefined;
}

function rawChild(raw: XdtoRawNode, name: string): XdtoRawNode | undefined {
  const value = raw[name];
  if (Array.isArray(value)) {
    return value.find(isRawNode);
  }
  return isRawNode(value) ? value : undefined;
}

function rawChildren(raw: XdtoRawNode, name: string): XdtoRawNode[] {
  const value = raw[name];
  if (Array.isArray(value)) {
    return value.filter(isRawNode);
  }
  return isRawNode(value) ? [value] : [];
}

function rawFacetValues(raw: XdtoRawNode, name: string): string[] {
  const value = raw[name];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (typeof item === 'string') {
      return [item];
    }
    if (isRawNode(item)) {
      const text = rawText(item);
      return text === undefined ? [] : [text];
    }
    return [];
  });
}

function rawText(raw: XdtoRawNode): string | undefined {
  if (typeof raw['#text'] === 'string') {
    return raw['#text'];
  }
  if (typeof raw['@_value'] === 'string') {
    return raw['@_value'];
  }
  return undefined;
}

function visitRaw(raw: unknown, callback: (node: XdtoRawNode) => void): void {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      visitRaw(item, callback);
    }
    return;
  }
  if (!isRawNode(raw)) {
    return;
  }
  callback(raw);
  for (const value of Object.values(raw)) {
    visitRaw(value, callback);
  }
}

function isRawNode(value: unknown): value is XdtoRawNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneCPackagePropertyAttrs(property: XdtoProperty, asAttribute: boolean): string {
  const lowerBound = property.lowerBound ?? property.minOccurs ?? (asAttribute && property.use === 'required' ? '1' : undefined);
  return [
    attr('name', property.name),
    attr('type', property.type),
    attr('lowerBound', lowerBound),
    attr('upperBound', property.upperBound ?? normalizeMaxOccurs(property.maxOccurs)),
    attr('nillable', property.nillable),
    attr('fixed', property.fixed),
    attr('default', property.defaultValue),
    asAttribute ? attr('form', 'Attribute') : '',
  ].join('');
}

function normalizeUpperBound(value: string | undefined): string | undefined {
  return value === '-1' ? 'unbounded' : value;
}

function normalizeDefaultOccurrence(value: string | undefined): string | undefined {
  return value === '1' ? undefined : value;
}

function normalizeMaxOccurs(value: string | undefined): string | undefined {
  return value === 'unbounded' ? '-1' : value;
}

function attr(name: string, value: string | undefined): string {
  return value ? ` ${name}="${escapeXml(value)}"` : '';
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
