import { MetadataType } from '../models/treeNode';
import { rulesRegistry, metadataConverter } from '../rules';
import type { MetadataObjectRules } from '../rules/types';
import { XMLWriter } from '../utils/XMLWriter';
import { generateSimpleUuid } from '../utils/xml/xmlHelpers';
import { getValueByLocalName } from '../parsers/xmlNavHelpers';
import { XmlParser } from '../parsers/xmlParser';
import { substituteDesignerTemplate } from './designerTemplateSubstitutor';

interface MetadataDesignerTemplateRequest {
  readonly type: MetadataType;
  readonly rootTag: string;
  readonly templateXml: string;
  readonly name: string;
  readonly uuid: string;
  readonly synonym?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly recorderDocument?: string;
}

/** Applies request overrides to the properties represented by a Designer template. */
export function createMetadataDesignerTemplateContent(request: MetadataDesignerTemplateRequest): string {
  const templateOverrideRules = request.type === MetadataType.AccountingRegister
    || request.type === MetadataType.CalculationRegister
    ? rulesRegistry.get(request.rootTag)
    : undefined;
  const overrides = templateOverrideRules
    ? createTemplatePropertyOverrides(templateOverrideRules, request.synonym, request.properties)
    : undefined;

  let content = substituteDesignerTemplate(request.templateXml, {
    uuid: request.uuid,
    Name: request.name,
    Synonym_ru: request.synonym ?? request.name,
    uuidDim: generateSimpleUuid(),
    uuidResource: generateSimpleUuid(),
    ...(request.type === MetadataType.DocumentJournal && request.recorderDocument
      ? { RecorderDocumentRef: `Document.${request.recorderDocument}` }
      : {}),
    ...(request.type === MetadataType.AccountingRegister
      ? { ChartOfAccounts: String(overrides?.['chartOfAccounts'] ?? '') }
      : {}),
    ...(request.type === MetadataType.CalculationRegister
      ? { ChartOfCalculationTypes: String(overrides?.['chartOfCalculationTypes'] ?? '') }
      : {}),
  });

  if (templateOverrideRules && overrides) {
    content = applyTemplatePropertyOverrides(content, templateOverrideRules, { name: request.name, uuid: request.uuid }, overrides);
  }
  return content;
}

function createTemplatePropertyOverrides(
  rules: MetadataObjectRules,
  synonym: string | undefined,
  properties: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (synonym !== undefined) {
    overrides['synonym'] = synonym;
  }

  const irKeyByXmlName = new Map<string, string>();
  for (const [irKey, rule] of Object.entries(rules.properties)) {
    const xmlName = rule.xml ?? `${irKey.charAt(0).toUpperCase()}${irKey.slice(1)}`;
    irKeyByXmlName.set(xmlName, irKey);
  }

  for (const [propertyName, value] of Object.entries(properties ?? {})) {
    const irKey = Object.prototype.hasOwnProperty.call(rules.properties, propertyName)
      ? propertyName
      : irKeyByXmlName.get(propertyName);
    if (irKey !== undefined) {
      overrides[irKey] = value;
    }
  }
  return overrides;
}

function applyTemplatePropertyOverrides(
  templateXml: string,
  rules: MetadataObjectRules,
  identity: { readonly name: string; readonly uuid: string },
  overrides: Record<string, unknown>,
): string {
  const propertyRules = Object.fromEntries(
    Object.entries(rules.properties).filter(([irKey]) =>
      Object.prototype.hasOwnProperty.call(overrides, irKey),
    ),
  );
  if (Object.keys(propertyRules).length === 0) {
    return templateXml;
  }

  const overrideRules: MetadataObjectRules = { ...rules, properties: propertyRules };
  const intermediate = metadataConverter.mergeProperties(
    metadataConverter.createDefaultIR(overrideRules, identity),
    overrides,
  );
  const serialized = metadataConverter.irToXml(intermediate, overrideRules);
  const parsed = XmlParser.parseString(serialized);
  const metadataObject = requireXmlRecord(getValueByLocalName(parsed, 'MetaDataObject'), `generated ${overrideRules.rootTag}`);
  const root = requireXmlRecord(getValueByLocalName(metadataObject, overrideRules.rootTag), `generated ${overrideRules.rootTag}`);
  const properties = requireXmlRecord(getValueByLocalName(root, 'Properties'), `generated ${overrideRules.rootTag}`);
  return XMLWriter.buildUpdatedPropertiesXml(templateXml, properties);
}

function requireXmlRecord(value: unknown, source: string): Record<string, unknown> {
  const single = Array.isArray(value)
    ? value.length === 1 ? value[0] : undefined
    : value;
  if (!single || typeof single !== 'object' || Array.isArray(single)) {
    throw new Error(`Malformed XML structure in ${source}.`);
  }
  return single as Record<string, unknown>;
}
