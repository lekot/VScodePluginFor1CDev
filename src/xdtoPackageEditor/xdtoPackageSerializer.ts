import type { XdtoPackageModel, XdtoProperty, XdtoRawNode, XdtoTypeDefinition } from '../types/xdtoPackage';

const XDTO_NAMESPACE = 'http://v8.1c.ru/8.1/xdto';
const XML_SCHEMA_NAMESPACE = 'http://www.w3.org/2001/XMLSchema';
const XML_SCHEMA_INSTANCE_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';

type AttributeValue = string | boolean | undefined;

function escapeAttribute(value: AttributeValue): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pushAttribute(attributes: string[], name: string, value: AttributeValue): void {
  if (value === undefined || value === '') {
    return;
  }
  attributes.push(`${name}="${escapeAttribute(value)}"`);
}

function renderStartTag(name: string, attributes: string[]): string {
  return attributes.length > 0 ? `<${name} ${attributes.join(' ')}>` : `<${name}>`;
}

function renderEmptyTag(name: string, attributes: string[]): string {
  return attributes.length > 0 ? `<${name} ${attributes.join(' ')}/>` : `<${name}/>`;
}

function namespaceDeclarationAttributes(rawRoot: XdtoRawNode | undefined): string[] {
  if (!rawRoot) {
    return [];
  }

  const declarations: string[] = [];
  for (const [key, value] of Object.entries(rawRoot)) {
    if (!key.startsWith('@_xmlns:') || typeof value !== 'string' || value === '') {
      continue;
    }

    const prefix = key.slice('@_xmlns:'.length);
    if (prefix === 'xs' || prefix === 'xsi') {
      continue;
    }

    declarations.push(`xmlns:${prefix}="${escapeAttribute(value)}"`);
  }
  return declarations;
}

function propertyAttributes(property: XdtoProperty, formOverride?: string): string[] {
  const attributes: string[] = [];
  const form = formOverride ?? property.form;

  pushAttribute(attributes, 'name', property.name);
  pushAttribute(attributes, 'type', property.type);
  pushAttribute(attributes, 'ref', property.ref);
  pushAttribute(attributes, 'namespaceURI', property.namespaceURI);
  pushAttribute(attributes, 'localName', property.localName);
  pushAttribute(attributes, 'qualified', property.qualified);
  pushAttribute(attributes, 'nillable', property.nillable);
  pushAttribute(attributes, 'fixed', property.fixed);
  pushAttribute(attributes, 'default', property.defaultValue);
  pushAttribute(attributes, 'lowerBound', property.lowerBound);
  pushAttribute(attributes, 'upperBound', property.upperBound);
  pushAttribute(attributes, 'minOccurs', property.minOccurs);
  pushAttribute(attributes, 'maxOccurs', property.maxOccurs);
  pushAttribute(attributes, 'form', form);
  pushAttribute(attributes, 'use', property.use);
  return attributes;
}

function renderProperty(property: XdtoProperty, indent: string, formOverride?: string): string {
  return `${indent}${renderEmptyTag('property', propertyAttributes(property, formOverride))}`;
}

function renderImport(item: XdtoPackageModel['imports'][number], indent: string): string {
  const attributes: string[] = [];
  pushAttribute(attributes, 'namespace', item.namespace);
  pushAttribute(attributes, 'schemaLocation', item.schemaLocation);
  return `${indent}${renderEmptyTag('import', attributes)}`;
}

function renderValueType(type: XdtoTypeDefinition, indent: string): string {
  const attributes: string[] = [];
  pushAttribute(attributes, 'name', type.name);
  pushAttribute(attributes, 'base', type.baseType);
  return `${indent}${renderEmptyTag('valueType', attributes)}`;
}

function renderObjectType(type: XdtoTypeDefinition, indent: string): string {
  const attributes: string[] = [];
  pushAttribute(attributes, 'name', type.name);
  pushAttribute(attributes, 'base', type.baseType);

  const memberLines = [
    ...type.properties.map((property) => renderProperty(
      { ...property, form: property.form === 'Attribute' ? undefined : property.form },
      `${indent}  `
    )),
    ...type.attributes.map((attribute) => renderProperty(attribute, `${indent}  `, 'Attribute')),
  ];

  if (memberLines.length === 0) {
    return `${indent}${renderEmptyTag('objectType', attributes)}`;
  }

  return [
    `${indent}${renderStartTag('objectType', attributes)}`,
    ...memberLines,
    `${indent}</objectType>`,
  ].join('\n');
}

export function serializeXdtoPackageModel(model: XdtoPackageModel): string {
  const rootAttributes = [
    `xmlns="${XDTO_NAMESPACE}"`,
    `xmlns:xs="${XML_SCHEMA_NAMESPACE}"`,
    `xmlns:xsi="${XML_SCHEMA_INSTANCE_NAMESPACE}"`,
    ...namespaceDeclarationAttributes(model.rawRoot),
  ];
  pushAttribute(rootAttributes, 'targetNamespace', model.targetNamespace);

  const bodyLines = [
    ...model.imports.map((item) => renderImport(item, '  ')),
    ...model.valueTypes.map((type) => renderValueType(type, '  ')),
    ...model.objectTypes.map((type) => renderObjectType(type, '  ')),
    ...model.rootProperties.map((property) => renderProperty(property, '  ')),
  ];

  if (bodyLines.length === 0) {
    return `\uFEFF${renderEmptyTag('package', rootAttributes)}`;
  }

  return [
    `\uFEFF${renderStartTag('package', rootAttributes)}`,
    ...bodyLines,
    '</package>',
  ].join('\n');
}
