import { parseXdtoPackage } from '../parsers/xdtoPackageParser';
import type { XdtoPackageModel, XdtoProperty, XdtoTypeDefinition } from '../types/xdtoPackage';
import { stripUtf8Bom } from './xdtoPackageFiles';

const XS_NS = 'http://www.w3.org/2001/XMLSchema';
const XDTO_NS = 'http://v8.1c.ru/8.1/xdto';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

export function convert1cPackageToXsd(source: string): string {
  const model = parseWithoutBlockingErrors(source);
  const localTypeNames = collectLocalTypeNames(model);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xs:schema xmlns:xs="${XS_NS}"${schemaNamespaceAttrs(model)} elementFormDefault="qualified">`,
  ];

  for (const item of model.imports) {
    lines.push(`  <xs:import${attr('namespace', item.namespace)}${attr('schemaLocation', item.schemaLocation)}/>`);
  }

  for (const type of model.valueTypes) {
    lines.push(`  <xs:simpleType name="${escapeXml(type.name)}">`);
    if (type.baseType) {
      lines.push(
        `    <xs:restriction base="${escapeXml(xsdRequiredTypeReference(type.baseType, model, localTypeNames))}"/>`
      );
    }
    lines.push('  </xs:simpleType>');
  }

  for (const type of model.objectTypes) {
    lines.push(`  <xs:complexType name="${escapeXml(type.name)}">`);
    if (type.baseType) {
      lines.push(`    <xs:complexContent>`);
      lines.push(
        `      <xs:extension base="${escapeXml(xsdRequiredTypeReference(type.baseType, model, localTypeNames))}">`
      );
      appendXsdObjectMembers(lines, type, '        ', model, localTypeNames);
      lines.push(`      </xs:extension>`);
      lines.push(`    </xs:complexContent>`);
    } else {
      appendXsdObjectMembers(lines, type, '    ', model, localTypeNames);
    }
    lines.push('  </xs:complexType>');
  }

  for (const property of model.rootProperties) {
    lines.push(`  <xs:element${xsdPropertyAttrs(property, model, localTypeNames)}/>`);
  }

  lines.push('</xs:schema>', '');
  return lines.join('\n');
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
    lines.push(`  <valueType name="${escapeXml(type.name)}"${attr('base', type.baseType)}/>`);
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
  model: XdtoPackageModel,
  localTypeNames: ReadonlySet<string>
): void {
  if (type.properties.length > 0) {
    lines.push(`${indent}<xs:sequence>`);
    for (const property of type.properties) {
      lines.push(`${indent}  <xs:element${xsdPropertyAttrs(property, model, localTypeNames)}/>`);
    }
    lines.push(`${indent}</xs:sequence>`);
  }
  for (const attribute of type.attributes) {
    lines.push(`${indent}<xs:attribute${xsdAttributeAttrs(attribute, model, localTypeNames)}/>`);
  }
}

function schemaNamespaceAttrs(model: XdtoPackageModel): string {
  const namespace = model.targetNamespace;
  return namespace
    ? ` targetNamespace="${escapeXml(namespace)}" xmlns:tns="${escapeXml(namespace)}"`
    : '';
}

function xsdPropertyAttrs(
  property: XdtoProperty,
  model: XdtoPackageModel,
  localTypeNames: ReadonlySet<string>
): string {
  const minOccurs = property.minOccurs ?? property.lowerBound;
  const maxOccurs = property.maxOccurs ?? normalizeUpperBound(property.upperBound);
  return [
    attr('name', property.name),
    attr('type', xsdTypeReference(property.type, model, localTypeNames)),
    attr('minOccurs', minOccurs),
    attr('maxOccurs', maxOccurs),
  ].join('');
}

function xsdAttributeAttrs(
  property: XdtoProperty,
  model: XdtoPackageModel,
  localTypeNames: ReadonlySet<string>
): string {
  const use = property.use ?? (property.lowerBound && property.lowerBound !== '0' ? 'required' : undefined);
  return [
    attr('name', property.name),
    attr('type', xsdTypeReference(property.type, model, localTypeNames)),
    attr('use', use),
  ].join('');
}

function collectLocalTypeNames(model: XdtoPackageModel): ReadonlySet<string> {
  return new Set([
    ...model.valueTypes.map((type) => type.name),
    ...model.objectTypes.map((type) => type.name),
  ]);
}

function xsdTypeReference(
  value: string | undefined,
  model: XdtoPackageModel,
  localTypeNames: ReadonlySet<string>
): string | undefined {
  if (!value || !model.targetNamespace || value.includes(':') || !localTypeNames.has(value)) {
    return value;
  }
  return `tns:${value}`;
}

function xsdRequiredTypeReference(
  value: string,
  model: XdtoPackageModel,
  localTypeNames: ReadonlySet<string>
): string {
  return xsdTypeReference(value, model, localTypeNames) ?? value;
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

function oneCPackagePropertyAttrs(property: XdtoProperty, asAttribute: boolean): string {
  const lowerBound = property.lowerBound ?? property.minOccurs ?? (asAttribute && property.use === 'required' ? '1' : undefined);
  return [
    attr('name', property.name),
    attr('type', property.type),
    attr('lowerBound', lowerBound),
    attr('upperBound', property.upperBound ?? normalizeMaxOccurs(property.maxOccurs)),
    asAttribute ? attr('form', 'Attribute') : '',
  ].join('');
}

function normalizeUpperBound(value: string | undefined): string | undefined {
  return value === '-1' ? 'unbounded' : value;
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
