import { METADATA_TYPE_DESCRIPTORS } from '../../../constants/metadataTypeDescriptors';
import type { XmlElement } from '../../xml/xmlDom';
import { namespaceUriForName } from './semanticXmlIdentity';
import type { SemanticXmlKind } from './semanticXmlValidator';

export const QUALIFIER_NAMES = new Set(['StringQualifiers', 'NumberQualifiers', 'DateQualifiers']);
export const IDENTITY_ATTRIBUTE_NAMES = new Set(['id', 'uuid', 'name', 'version']);
const METADATA_FIELD_NAMES = new Set(['Attribute', 'Dimension', 'Resource', 'Recalculation']);
export const HARD_DIAGNOSTIC_CODES = new Set([
  'XML_PARSE_FAILED', 'XML_ROOT_KIND_MISMATCH', 'XML_FORMAT_VERSION_UNSUPPORTED',
  'XML_FORM_DUPLICATE_ID', 'XML_METADATA_DUPLICATE_ID', 'XML_PREDEFINED_DUPLICATE_ID',
  'XML_PREDEFINED_MISSING_ID', 'XML_PREDEFINED_MISSING_NAME', 'XML_PREDEFINED_INVALID_UUID',
  'XML_PREDEFINED_DUPLICATE_NAME', 'XML_TYPE_QUALIFIER_MISMATCH', 'XML_TYPE_QUALIFIER_BOUNDS',
  'XML_METADATA_INVALID_UUID', 'XML_FORM_INVALID_ID',
  'XML_FORM_BASEFORM_SHAPE',
  'XML_FORMAT_VERSION_MISMATCH',
  'XML_ROOT_PROPERTY_REFERENCE', 'XML_ROOT_PROPERTY_REFERENCE_FORMAT',
  'XML_PREDEFINED_REFERENCE', 'XML_ROOT_NAMESPACE_UNSUPPORTED', 'XML_UNBOUND_PREFIX',
  'XML_TYPE_REFERENCE_KIND_UNSUPPORTED',
  'XML_UNBOUND_QNAME_PREFIX',
  'XML_RIGHTS_VERSION_MISSING', 'XML_RIGHTS_REQUIRED_FIELD_MISSING', 'XML_RIGHTS_DUPLICATE_FIELD',
  'XML_RIGHTS_BOOLEAN_INVALID', 'XML_RIGHTS_OBJECT_NAME_INVALID', 'XML_RIGHTS_UNKNOWN_RIGHT',
  'XML_RIGHTS_INAPPLICABLE_RIGHT', 'XML_RIGHTS_METADATA_TYPE_UNSUPPORTED',
  'XML_DCS_OWNER_VERSION_CONTEXT_REQUIRED', 'XML_DCS_OWNER_VERSION_UNSUPPORTED',
  'XML_DCS_REQUIRED_MEMBER_MISSING', 'XML_DCS_DATASET_TYPE_MISSING',
  'XML_DCS_DATASET_TYPE_UNSUPPORTED', 'XML_DCS_DATA_SOURCE_TYPE_UNSUPPORTED', 'XML_DCS_UNION_EMPTY', 'XML_DCS_REQUIRED_FIELD_MISSING',
  'XML_DCS_DUPLICATE_FIELD', 'XML_DCS_IDENTITY_MISSING', 'XML_DCS_DUPLICATE_IDENTITY',
  'XML_RIGHTS_IDENTITY_MISSING', 'XML_RIGHTS_DUPLICATE_IDENTITY',
]);

export const DESCRIPTOR_OBJECT_NAMES = new Set([
  ...METADATA_TYPE_DESCRIPTORS.map((descriptor) => descriptor.designerRootTag),
  'Configuration', 'Form', 'Template', 'Command', 'Picture', 'Attribute', 'TabularSection',
  'Dimension', 'Resource', 'Recalculation',
  'AccumulationRegister', 'AccountingRegister', 'BusinessProcess', 'CalculationRegister',
  'ChartOfAccounts', 'ChartOfCalculationTypes', 'ChartOfCharacteristicTypes', 'CommonAttribute',
  'CommonCommand', 'CommonForm', 'CommonModule', 'CommonPicture', 'CommonTemplate', 'CommandGroup',
  'Constant', 'DataProcessor', 'DefinedType', 'Document', 'DocumentJournal', 'DocumentNumerator',
  'Enum', 'EventSubscription', 'ExchangePlan', 'ExternalDataSource', 'FilterCriterion',
  'FunctionalOption', 'FunctionalOptionsParameter', 'HTTPService', 'InformationRegister',
  'IntegrationService', 'Interface', 'Language', 'Report', 'Role', 'ScheduledJob',
  'SessionParameter', 'SettingsStorage', 'Style', 'Subsystem', 'Task', 'WebService',
  'URLTemplate', 'Method', 'Operation', 'Parameter', 'AddressingAttribute',
  'AccountingFlag', 'ExtDimensionAccountingFlag',
  'WSReference', 'XDTOPackage',
]);
const METADATA_COMPLEX_NAMES = new Set([
  'MetaDataObject', 'Properties', 'ChildObjects', 'Type', 'StringQualifiers', 'NumberQualifiers',
  'DateQualifiers', 'Content', 'item', 'Item', 'lang', 'content', 'Presentation', 'Title',
  'Synonym', 'Comment', 'ExtendedDescription', 'StandardAttributes', 'StandardAttribute',
  'GeneratedType', 'TabularSection', 'Attribute', 'Dimension', 'Resource', 'Recalculation',
  'Command', 'Form', 'Template', 'Picture', 'TableParts', 'URLTemplate', 'Method',
  'Operation', 'Parameter', 'AddressingAttribute', 'AccountingFlag', 'ExtDimensionAccountingFlag',
]);

const ROOT_NAMESPACE_BY_KIND: Record<SemanticXmlKind, string> = {
  metadataXml: 'http://v8.1c.ru/8.3/MDClasses',
  formXml: 'http://v8.1c.ru/8.3/xcf/logform',
  predefinedXml: 'http://v8.1c.ru/8.3/xcf/predef',
  roleRightsXml: 'http://v8.1c.ru/8.2/roles',
  dcsXml: 'http://v8.1c.ru/8.1/data-composition-system/schema',
};
const SUPPORTED_ONEC_NAMESPACES = new Set([
  'http://v8.1c.ru/8.3/MDClasses',
  'http://v8.1c.ru/8.3/xcf/logform',
  'http://v8.1c.ru/8.3/xcf/predef',
  'http://v8.1c.ru/8.3/xcf/readable',
  'http://v8.1c.ru/8.3/xcf/enums',
  'http://v8.1c.ru/8.2/roles',
  'http://v8.1c.ru/8.2/managed-application/core',
  'http://v8.1c.ru/8.2/managed-application/cmi',
  'http://v8.1c.ru/8.2/managed-application/logform',
  'http://v8.1c.ru/8.1/data/core',
  'http://v8.1c.ru/8.1/data/enterprise',
  'http://v8.1c.ru/8.1/data/enterprise/current-config',
  'http://v8.1c.ru/8.1/data/ui',
  'http://v8.1c.ru/8.1/data/ui/style',
  'http://v8.1c.ru/8.1/data/ui/fonts/system',
  'http://v8.1c.ru/8.1/data/ui/colors/web',
  'http://v8.1c.ru/8.1/data/ui/colors/windows',
  'http://v8.1c.ru/8.1/data-composition-system/schema',
  'http://v8.1c.ru/8.1/data-composition-system/common',
  'http://v8.1c.ru/8.1/data-composition-system/core',
  'http://v8.1c.ru/8.1/data-composition-system/settings',
  'http://v8.1c.ru/8.1/data-composition-system/area-template',
]);
const SUPPORTED_EXTERNAL_NAMESPACES = new Set([
  'http://www.w3.org/2001/XMLSchema',
  'http://www.w3.org/2001/XMLSchema-instance',
  'http://www.w3.org/XML/1998/namespace',
]);
export const SHARED_FORM_VALUE_STRUCTURES = new Set([
  'Type', 'StringQualifiers', 'NumberQualifiers', 'DateQualifiers', 'item', 'lang', 'content',
]);

export function isSupportedRootNamespace(element: XmlElement, kind: SemanticXmlKind): boolean {
  const namespace = namespaceUriForName(element);
  if (kind === 'roleRightsXml' || kind === 'dcsXml') {
    return namespace === ROOT_NAMESPACE_BY_KIND[kind];
  }
  return !namespace || namespace === ROOT_NAMESPACE_BY_KIND[kind];
}

export function isSupportedElementNamespace(element: XmlElement): boolean {
  const namespace = namespaceUriForName(element);
  return !namespace || isSupportedOneCXmlNamespace(namespace) || SUPPORTED_EXTERNAL_NAMESPACES.has(namespace);
}

export function isSupportedAttributeNamespace(element: XmlElement, name: string): boolean {
  const namespace = namespaceUriForName(element, name, true);
  return !namespace || isSupportedOneCXmlNamespace(namespace) || SUPPORTED_EXTERNAL_NAMESPACES.has(namespace);
}

export function isSupportedOneCXmlNamespace(namespace: string | undefined): boolean {
  return !namespace || SUPPORTED_ONEC_NAMESPACES.has(namespace);
}

export function isProtectedXmlAttribute(name: string, kind: SemanticXmlKind): boolean {
  const local = localName(name);
  return IDENTITY_ATTRIBUTE_NAMES.has(local.toLowerCase()) ||
    name === 'xmlns' || name.startsWith('xmlns:') ||
    (kind === 'metadataXml' && local.toLowerCase() === 'type' && name.startsWith('xsi:'));
}

export function isKnownMetadataStructure(name: string): boolean {
  return DESCRIPTOR_OBJECT_NAMES.has(name) || METADATA_COMPLEX_NAMES.has(name);
}

/** These metadata children share one name space within a ChildObjects collection. */
export function metadataChildNameScope(name: string): string {
  return METADATA_FIELD_NAMES.has(name) ? 'Field' : name;
}

function localName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
}
