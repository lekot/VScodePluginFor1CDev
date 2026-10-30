import { getRoleRightByXmlName } from '../../../rolesEditor/roleRightsRegistry';
import { getMetadataTypeDescriptorByRootTag } from '../../../constants/metadataTypeDescriptors';
import { buildXmlAddress, elementChildren, textContent, type XmlElement } from '../../xml/xmlDom';
import { normalizeReferenceValue, namespaceUriForName } from './semanticXmlIdentity';
import type { SemanticXmlDiagnostic, SemanticXmlValidationContext } from './semanticXmlValidator';

export const ROLE_RIGHTS_NAMESPACE = 'http://v8.1c.ru/8.2/roles';

const REQUIRED_ROOT_BOOLEANS = [
  'setForNewObjects',
  'setForAttributesByDefault',
  'independentRightsOfChildObjects',
] as const;

const ROOT_RIGHT_NAMES = new Set(['Catalog', 'Document', 'ExchangePlan', 'ChartOfAccounts', 'ChartOfCharacteristicTypes', 'ChartOfCalculationTypes',
  'InformationRegister', 'AccumulationRegister', 'AccountingRegister', 'CalculationRegister', 'DocumentJournal', 'DataProcessor', 'Report',
  'BusinessProcess', 'Task', 'WebService', 'HTTPService', 'IntegrationService', 'ExternalDataSource', 'Configuration', 'Subsystem',
  'CommonModule', 'CommonCommand', 'CommonForm', 'CommonTemplate', 'CommonPicture', 'CommonAttribute', 'CommonSetting', 'CommonValueStorage',
  'Constant', 'Enum', 'DefinedType', 'Role', 'Language', 'Style', 'Interface', 'FunctionalOption', 'FunctionalOptionsParameter',
  'SessionParameter', 'ScheduledJob', 'EventSubscription', 'ExchangeRate', 'AccountingFlag']);
const EDIT_RIGHTS = new Set(['View', 'Edit']);
const EDS_TABLE_RIGHTS = new Set(['Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert', 'InteractiveDelete']);

export function roleRightsDiagnostics(
  root: XmlElement,
  context?: SemanticXmlValidationContext,
): SemanticXmlDiagnostic[] {
  const diagnostics: SemanticXmlDiagnostic[] = [];
  const version = attributeValueByLocalName(root, 'version');
  if (!version) {
    diagnostics.push(diagnostic('XML_RIGHTS_VERSION_MISSING', 'В корне Rights отсутствует версия формата.', root));
  }
  for (const name of REQUIRED_ROOT_BOOLEANS) {
    const value = requiredDirectText(root, name, diagnostics);
    if (value !== undefined && !isBoolean(value)) {
      diagnostics.push(diagnostic('XML_RIGHTS_BOOLEAN_INVALID', `Значение «${name}» должно быть true или false.`, firstDirect(root, name)));
    }
  }

  for (const object of direct(root, 'object')) {
    const objectName = requiredDirectText(object, 'name', diagnostics);
    if (!objectName) {
      continue;
    }
    const parts = objectName.split('.').map((part) => part.trim());
    const metadataType = parts[0];
    if (parts.length < 2 || parts.some((part) => !part) || !metadataType) {
      diagnostics.push(diagnostic('XML_RIGHTS_OBJECT_NAME_INVALID', `Полное имя объекта «${objectName}» задано некорректно.`, object));
      continue;
    }
    for (const right of direct(object, 'right')) {
      const rightName = requiredDirectText(right, 'name', diagnostics);
      const value = requiredDirectText(right, 'value', diagnostics);
      if (value !== undefined && !isBoolean(value)) {
        diagnostics.push(diagnostic('XML_RIGHTS_BOOLEAN_INVALID', `Значение права «${rightName ?? '?'}» должно быть true или false.`, firstDirect(right, 'value')));
      }
      if (rightName) {
        const descriptor = getRoleRightByXmlName(rightName);
        if (!descriptor) {
          diagnostics.push(diagnostic('XML_RIGHTS_UNKNOWN_RIGHT', `Право «${rightName}» отсутствует в реестре прав.`, right));
        } else if (!isApplicableRoleRight(rightName, parts, descriptor.applicableTo)) {
          diagnostics.push(diagnostic('XML_RIGHTS_INAPPLICABLE_RIGHT', `Право «${rightName}» неприменимо к типу «${metadataType}».`, right));
        }
      }
      for (const restriction of direct(right, 'restrictionByCondition')) {
        requiredDirectText(restriction, 'condition', diagnostics, true);
      }
    }
  }

  for (const template of direct(root, 'restrictionTemplate')) {
    requiredDirectText(template, 'name', diagnostics);
    requiredDirectText(template, 'condition', diagnostics, true);
  }

  const available = context?.availableMetadataReferences;
  if (available !== undefined) {
    const known = new Set(available.map(normalizeReferenceValue));
    for (const object of direct(root, 'object')) {
      const value = singleDirectText(object, 'name');
      if (!value) {continue;}
      const parts = value.split('.').map((part) => part.trim());
      if (parts.some((part) => !part)) {continue;}
      if (parts.length < 2) {continue;}
      const rootReference = normalizeReferenceValue(parts[0] === 'Configuration' && context?.configurationName
        ? `Configuration.${context.configurationName}`
        : parts.slice(0, 2).join('.'));
      if (parts[0] === 'Configuration' && context?.configurationName &&
          normalizeReferenceValue(parts[1]!) !== normalizeReferenceValue(context.configurationName)) {
        diagnostics.push(diagnostic('XML_TYPE_REFERENCE', `Право ссылается на другую конфигурацию «${parts[1]}», ожидалась «${context.configurationName}».`, object));
      } else if (parts[0] !== 'Configuration' && !known.has(rootReference)) {
        diagnostics.push(diagnostic('XML_TYPE_REFERENCE', `Объект прав «${value}» отсутствует в целевой конфигурации.`, object));
      } else if (parts[0] === 'Configuration' && !context?.configurationName && !known.has(rootReference)) {
        diagnostics.push(diagnostic('XML_TYPE_REFERENCE', `Конфигурация из объекта прав «${value}» не подтверждена.`, object));
      }
      const metadataRootType = parts[0]!;
      if (!getMetadataTypeDescriptorByRootTag(metadataRootType) && metadataRootType !== 'Configuration') {
        diagnostics.push(diagnostic('XML_RIGHTS_METADATA_TYPE_UNSUPPORTED', `Тип объекта «${metadataRootType}» не подтверждён реестром метаданных.`, object));
      }
    }
  }
  return diagnostics;
}

function isApplicableRoleRight(rightName: string, parts: readonly string[], rootApplicableTo: readonly string[]): boolean {
  if (parts.length === 2) {
    return rootApplicableTo.some((type) => normalizeReferenceValue(type) === normalizeReferenceValue(parts[0]!));
  }
  const type = parts[0]!;
  if (type === 'ExternalDataSource') {
    return isApplicableExternalDataSourceRight(rightName, parts);
  }
  if (parts.length === 4 && parts[2] === 'StandardAttribute' &&
      containsOneOf(type, ['Catalog', 'Document', 'ExchangePlan', 'ChartOfAccounts', 'ChartOfCharacteristicTypes', 'ChartOfCalculationTypes',
        'Task', 'BusinessProcess', 'InformationRegister', 'AccumulationRegister', 'AccountingRegister', 'CalculationRegister', 'DocumentJournal'])) {
    return EDIT_RIGHTS.has(rightName);
  }
  if (parts.length === 4 && parts[2] === 'Attribute' &&
      containsOneOf(type, ['Catalog', 'Document', 'ExchangePlan', 'ChartOfAccounts', 'ChartOfCharacteristicTypes', 'ChartOfCalculationTypes',
        'Task', 'BusinessProcess', 'InformationRegister', 'AccumulationRegister', 'AccountingRegister', 'CalculationRegister', 'DataProcessor', 'Report'])) {
    return EDIT_RIGHTS.has(rightName);
  }
  if (parts.length === 4 && parts[2] === 'TabularSection' &&
      containsOneOf(type, ['Catalog', 'Document', 'ExchangePlan', 'ChartOfAccounts', 'ChartOfCharacteristicTypes', 'ChartOfCalculationTypes',
        'Task', 'BusinessProcess', 'DataProcessor', 'Report'])) {
    return EDIT_RIGHTS.has(rightName);
  }
  if (parts.length === 6 && parts[2] === 'TabularSection' &&
      containsOneOf(type, ['Catalog', 'Document', 'ExchangePlan', 'ChartOfAccounts', 'ChartOfCharacteristicTypes', 'ChartOfCalculationTypes',
        'Task', 'BusinessProcess', 'DataProcessor', 'Report']) &&
      (parts[4] === 'Attribute' || parts[4] === 'StandardAttribute')) {
    return EDIT_RIGHTS.has(rightName);
  }
  if (parts.length === 4 && (parts[2] === 'Dimension' || parts[2] === 'Resource') &&
      containsOneOf(type, ['InformationRegister', 'AccumulationRegister', 'AccountingRegister'])) {
    return EDIT_RIGHTS.has(rightName);
  }
  if (parts.length === 4 && parts[2] === 'Command' && isCommandOwner(type)) {
    return rightName === 'View';
  }
  if (parts.length === 4 && parts[2] === 'AddressingAttribute' && containsOneOf(type, ['Task', 'BusinessProcess'])) {
    return EDIT_RIGHTS.has(rightName);
  }
  if (parts.length === 4 && parts[2] === 'StandardTabularSection' &&
      containsOneOf(type, ['Catalog', 'Document', 'ChartOfAccounts', 'ChartOfCharacteristicTypes', 'ChartOfCalculationTypes'])) {
    return EDIT_RIGHTS.has(rightName);
  }
  if (parts.length === 4 && (parts[2] === 'AccountingFlag' || parts[2] === 'ExtDimensionAccountingFlag') && type === 'ChartOfAccounts') {
    return EDIT_RIGHTS.has(rightName);
  }
  if (parts.length === 4 && parts[2] === 'Subsystem' && type === 'Subsystem') {
    return rightName === 'View';
  }
  if (parts.length === 4 && parts[2] === 'Operation' && type === 'WebService') {
    return rightName === 'Use';
  }
  if (parts.length === 6 && parts[2] === 'URLTemplate' && parts[4] === 'Method' && type === 'HTTPService') {
    return rightName === 'Use';
  }
  if (parts.length === 4 && parts[2] === 'IntegrationServiceChannel' && type === 'IntegrationService') {
    return rightName === 'Use';
  }
  if (parts.length === 4 && parts[2] === 'Recalculation' && type === 'CalculationRegister') {
    return rightName === 'Read' || rightName === 'Update';
  }
  return false;
}

function isApplicableExternalDataSourceRight(rightName: string, parts: readonly string[]): boolean {
  if (parts.length === 2) {
    return ['Use', 'Administration', 'StandardAuthenticationChange', 'SessionStandardAuthenticationChange', 'SessionOSAuthenticationChange'].includes(rightName);
  }
  const kind = parts[2];
  if (kind === 'Table' && parts.length === 4) {return EDS_TABLE_RIGHTS.has(rightName);}
  if (kind === 'Table' && parts[4] === 'Field' && parts.length === 6) {return EDIT_RIGHTS.has(rightName);}
  if (kind === 'Table' && parts[4] === 'Command' && parts.length === 6) {return rightName === 'View';}
  if (kind === 'Cube' && parts.length === 4) {return rightName === 'Read' || rightName === 'View';}
  if (kind === 'Cube' && (parts[4] === 'Dimension' || parts[4] === 'Resource') && parts.length === 6) {return rightName === 'View';}
  if (kind === 'Cube' && parts[4] === 'DimensionTable' && parts.length === 6) {return rightName === 'Read' || rightName === 'View';}
  if (kind === 'Cube' && parts[4] === 'DimensionTable' && parts[6] === 'Field' && parts.length === 8) {return EDIT_RIGHTS.has(rightName);}
  if (kind === 'Cube' && parts[4] === 'Command' && parts.length === 6) {return rightName === 'View';}
  if (kind === 'Cube' && parts[4] === 'DimensionTable' && parts[6] === 'Command' && parts.length === 8) {return rightName === 'View';}
  if (kind === 'Function' && parts.length === 4) {return rightName === 'Use' || rightName === 'View';}
  return false;
}

function isCommandOwner(type: string): boolean {
  return ROOT_RIGHT_NAMES.has(type) && (type.endsWith('Register') ||
    ['Catalog', 'Document', 'DataProcessor', 'Report', 'DocumentJournal', 'ExchangePlan', 'BusinessProcess', 'Task'].includes(type));
}

function containsOneOf(value: string, choices: readonly string[]): boolean {
  return choices.includes(value);
}

export function roleRightsMetadataReferences(root: XmlElement): string[] {
  const references = new Set<string>();
  for (const object of direct(root, 'object')) {
    const value = singleDirectText(object, 'name');
    if (!value) {continue;}
    const parts = value.split('.').map((part) => part.trim());
    if (parts.length >= 2 && !parts.some((part) => !part)) {
      references.add(parts.slice(0, 2).join('.'));
    }
  }
  return [...references];
}

function requiredDirectText(
  element: XmlElement,
  name: string,
  diagnostics: SemanticXmlDiagnostic[],
  allowEmpty = false,
): string | undefined {
  const matches = direct(element, name);
  if (matches.length !== 1) {
    diagnostics.push(diagnostic(
      matches.length > 1 ? 'XML_RIGHTS_DUPLICATE_FIELD' : 'XML_RIGHTS_REQUIRED_FIELD_MISSING',
      matches.length > 1 ? `Элемент «${name}» повторяется в ${element.name}.` : `В ${element.name} отсутствует обязательное поле «${name}».`,
      matches[1] ?? element,
    ));
    return undefined;
  }
  const value = textContent(matches[0]!).trim();
  if (!allowEmpty && !value) {
    diagnostics.push(diagnostic('XML_RIGHTS_REQUIRED_FIELD_MISSING', `Поле «${name}» в ${element.name} не должно быть пустым.`, matches[0]));
    return undefined;
  }
  return value;
}

function singleDirectText(element: XmlElement, name: string): string | undefined {
  const matches = direct(element, name);
  return matches.length === 1 ? textContent(matches[0]!).trim() || undefined : undefined;
}

function direct(element: XmlElement, name: string): XmlElement[] {
  return elementChildren(element).filter((child) => child.localName === name && namespaceUriForName(child) === ROLE_RIGHTS_NAMESPACE);
}

function firstDirect(element: XmlElement, name: string): XmlElement | undefined {
  return direct(element, name)[0];
}

function isBoolean(value: string): boolean {
  return value === 'true' || value === 'false';
}

function attributeValueByLocalName(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.localName === name)?.value;
}

function diagnostic(code: string, message: string, element?: XmlElement): SemanticXmlDiagnostic {
  return {
    code,
    message,
    pointer: element ? buildXmlAddress('Rights.xml', element).pointer : undefined,
    blocking: true,
  };
}
