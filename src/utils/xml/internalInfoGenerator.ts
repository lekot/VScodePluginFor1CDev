import { XMLWriter } from '../XMLWriter';

/**
 * Корневые теги метаданных, для которых в иерархической выгрузке Designer **не** должно быть
 * вставлено блока InternalInfo при создании объекта — иначе ibcmd: «не может иметь внутренней информации».
 * См. также Role/CommonModule (исторически исключены вручную).
 */
export const ROOT_TAGS_WITHOUT_INTERNALINFO = new Set<string>([
  'Role',
  'CommonModule',
  'ScheduledJob',
  'CommandGroup',
  'CommonPicture',
  'SessionParameter',
  'CommonTemplate',
  'HTTPService',
  'Style',
  'EventSubscription',
  'CommonForm',
  /** Встроенная форма: ibcmd — «Form не может иметь внутренней информации». */
  'Form',
  'XDTOPackage',
  'DocumentNumerator',
  'CommonAttribute',
  'Subsystem',
  'CommonCommand',
  'FunctionalOptionsParameter',
  'Language',
  'FunctionalOption',
  'WebService',
  'StyleItem',
]);

type GeneratedTypeSpec = {
  /** e.g. "CatalogObject", "InformationRegisterRecord" */
  namePrefix: string;
  /** e.g. "Object", "RecordSet", "ValueKey" */
  category: string;
};

function indentOf(s: string): { lineIndent: string; childIndent: string } {
  // Prefer to keep whatever indentation caller uses (tabs/spaces),
  // but for nested lines we always add one tab (Designer XML from 1C uses tabs).
  return { lineIndent: s, childIndent: `${s}\t` };
}

function makeGeneratedType(spec: GeneratedTypeSpec, objectName: string, indent: string): string {
  const typeId = XMLWriter.generateSimpleUuid();
  const valueId = XMLWriter.generateSimpleUuid();
  return (
    `${indent}<xr:GeneratedType name="${spec.namePrefix}.${objectName}" category="${spec.category}">\n` +
    `${indent}\t<xr:TypeId>${typeId}</xr:TypeId>\n` +
    `${indent}\t<xr:ValueId>${valueId}</xr:ValueId>\n` +
    `${indent}</xr:GeneratedType>\n`
  );
}

function getSpecsForRootTag(rootTag: string): GeneratedTypeSpec[] {
  // Patterns derived from `FormatSamples/ut_demo_ForFormat` exports.
  switch (rootTag) {
    case 'Catalog':
    case 'Document':
    case 'Task':
      return [
        { namePrefix: `${rootTag}Object`, category: 'Object' },
        { namePrefix: `${rootTag}Ref`, category: 'Ref' },
        { namePrefix: `${rootTag}Selection`, category: 'Selection' },
        { namePrefix: `${rootTag}List`, category: 'List' },
        { namePrefix: `${rootTag}Manager`, category: 'Manager' },
      ];
    case 'BusinessProcess':
      return [
        { namePrefix: 'BusinessProcessObject', category: 'Object' },
        { namePrefix: 'BusinessProcessRef', category: 'Ref' },
        { namePrefix: 'BusinessProcessSelection', category: 'Selection' },
        { namePrefix: 'BusinessProcessList', category: 'List' },
        { namePrefix: 'BusinessProcessManager', category: 'Manager' },
        { namePrefix: 'BusinessProcessRoutePointRef', category: 'RoutePointRef' },
      ];
    case 'Enum':
      return [
        { namePrefix: 'EnumRef', category: 'Ref' },
        { namePrefix: 'EnumManager', category: 'Manager' },
        { namePrefix: 'EnumList', category: 'List' },
      ];
    case 'Report':
      return [
        { namePrefix: 'ReportObject', category: 'Object' },
        { namePrefix: 'ReportManager', category: 'Manager' },
      ];
    case 'DataProcessor':
      return [
        { namePrefix: 'DataProcessorObject', category: 'Object' },
        { namePrefix: 'DataProcessorManager', category: 'Manager' },
      ];
    case 'Constant':
      return [
        { namePrefix: 'ConstantManager', category: 'Manager' },
        { namePrefix: 'ConstantValueManager', category: 'ValueManager' },
        { namePrefix: 'ConstantValueKey', category: 'ValueKey' },
      ];
    case 'InformationRegister':
      return [
        { namePrefix: 'InformationRegisterRecord', category: 'Record' },
        { namePrefix: 'InformationRegisterManager', category: 'Manager' },
        { namePrefix: 'InformationRegisterSelection', category: 'Selection' },
        { namePrefix: 'InformationRegisterList', category: 'List' },
        { namePrefix: 'InformationRegisterRecordSet', category: 'RecordSet' },
        { namePrefix: 'InformationRegisterRecordKey', category: 'RecordKey' },
        { namePrefix: 'InformationRegisterRecordManager', category: 'RecordManager' },
      ];
    case 'AccumulationRegister':
      return [
        { namePrefix: 'AccumulationRegisterRecord', category: 'Record' },
        { namePrefix: 'AccumulationRegisterManager', category: 'Manager' },
        { namePrefix: 'AccumulationRegisterSelection', category: 'Selection' },
        { namePrefix: 'AccumulationRegisterList', category: 'List' },
        { namePrefix: 'AccumulationRegisterRecordSet', category: 'RecordSet' },
        { namePrefix: 'AccumulationRegisterRecordKey', category: 'RecordKey' },
      ];
    case 'AccountingRegister':
      // docs/1c-config-objects-spec.md §29
      return [
        { namePrefix: 'AccountingRegisterRecord', category: 'Record' },
        { namePrefix: 'AccountingRegisterExtDimensions', category: 'ExtDimensions' },
        { namePrefix: 'AccountingRegisterRecordSet', category: 'RecordSet' },
        { namePrefix: 'AccountingRegisterRecordKey', category: 'RecordKey' },
        { namePrefix: 'AccountingRegisterSelection', category: 'Selection' },
        { namePrefix: 'AccountingRegisterList', category: 'List' },
        { namePrefix: 'AccountingRegisterManager', category: 'Manager' },
      ];
    case 'CalculationRegister':
      return [
        { namePrefix: 'CalculationRegisterRecord', category: 'Record' },
        { namePrefix: 'CalculationRegisterManager', category: 'Manager' },
        { namePrefix: 'CalculationRegisterSelection', category: 'Selection' },
        { namePrefix: 'CalculationRegisterList', category: 'List' },
        { namePrefix: 'CalculationRegisterRecordSet', category: 'RecordSet' },
        { namePrefix: 'CalculationRegisterRecordKey', category: 'RecordKey' },
        { namePrefix: 'CalculationRegisterRecalcs', category: 'Recalcs' },
      ];
    case 'ChartOfAccounts':
      return [
        { namePrefix: 'ChartOfAccountsObject', category: 'Object' },
        { namePrefix: 'ChartOfAccountsRef', category: 'Ref' },
        { namePrefix: 'ChartOfAccountsSelection', category: 'Selection' },
        { namePrefix: 'ChartOfAccountsList', category: 'List' },
        { namePrefix: 'ChartOfAccountsManager', category: 'Manager' },
      ];
    case 'ChartOfCharacteristicTypes':
      return [
        { namePrefix: 'ChartOfCharacteristicTypesObject', category: 'Object' },
        { namePrefix: 'ChartOfCharacteristicTypesRef', category: 'Ref' },
        { namePrefix: 'ChartOfCharacteristicTypesSelection', category: 'Selection' },
        { namePrefix: 'ChartOfCharacteristicTypesList', category: 'List' },
        { namePrefix: 'ChartOfCharacteristicTypesCharacteristic', category: 'Characteristic' },
        { namePrefix: 'ChartOfCharacteristicTypesManager', category: 'Manager' },
      ];
    case 'ChartOfCalculationTypes':
      return [
        { namePrefix: 'ChartOfCalculationTypesObject', category: 'Object' },
        { namePrefix: 'ChartOfCalculationTypesRef', category: 'Ref' },
        { namePrefix: 'ChartOfCalculationTypesSelection', category: 'Selection' },
        { namePrefix: 'ChartOfCalculationTypesList', category: 'List' },
        { namePrefix: 'ChartOfCalculationTypesManager', category: 'Manager' },
        { namePrefix: 'ChartOfCalculationTypesDisplacingCalculationTypes', category: 'DisplacingCalculationTypes' },
        { namePrefix: 'ChartOfCalculationTypesDisplacingCalculationTypesRow', category: 'DisplacingCalculationTypesRow' },
        { namePrefix: 'ChartOfCalculationTypesBaseCalculationTypes', category: 'BaseCalculationTypes' },
        { namePrefix: 'ChartOfCalculationTypesBaseCalculationTypesRow', category: 'BaseCalculationTypesRow' },
        { namePrefix: 'ChartOfCalculationTypesLeadingCalculationTypes', category: 'LeadingCalculationTypes' },
        { namePrefix: 'ChartOfCalculationTypesLeadingCalculationTypesRow', category: 'LeadingCalculationTypesRow' },
      ];
    case 'DefinedType':
      return [{ namePrefix: 'DefinedType', category: 'DefinedType' }];
    case 'ExchangePlan':
      return [
        { namePrefix: 'ExchangePlanObject', category: 'Object' },
        { namePrefix: 'ExchangePlanRef', category: 'Ref' },
        { namePrefix: 'ExchangePlanSelection', category: 'Selection' },
        { namePrefix: 'ExchangePlanList', category: 'List' },
        { namePrefix: 'ExchangePlanManager', category: 'Manager' },
      ];
    case 'DocumentJournal':
      return [
        { namePrefix: 'DocumentJournalSelection', category: 'Selection' },
        { namePrefix: 'DocumentJournalList', category: 'List' },
        { namePrefix: 'DocumentJournalManager', category: 'Manager' },
      ];
    case 'FilterCriterion':
      // Как в выгрузке Designer (см. FormatSamples/ut_demo_ForFormat/FilterCriteria); иначе ibcmd:
      // «отсутствует один или более типов объекта FilterCriterion» при одном Manager из default.
      return [
        { namePrefix: 'FilterCriterionManager', category: 'Manager' },
        { namePrefix: 'FilterCriterionList', category: 'List' },
      ];
    default:
      // Best-effort fallback: at least provide a Manager, which is commonly present.
      return [{ namePrefix: `${rootTag}Manager`, category: 'Manager' }];
  }
}

export function buildInternalInfoXml(rootTag: string, objectName: string, baseIndent: string): string {
  const { lineIndent, childIndent } = indentOf(baseIndent);
  const specs = getSpecsForRootTag(rootTag);
  let xml = `${lineIndent}<InternalInfo>\n`;
  if (rootTag === 'ExchangePlan') {
    xml += `${childIndent}<xr:ThisNode>${XMLWriter.generateSimpleUuid()}</xr:ThisNode>\n`;
  }
  for (const spec of specs) {
    xml += makeGeneratedType(spec, objectName, childIndent);
  }
  xml += `${lineIndent}</InternalInfo>\n`;
  return xml;
}

export function injectInternalInfoIntoMetadataXml(
  xml: string,
  rootTag: string,
  objectName: string
): string {
  if (ROOT_TAGS_WITHOUT_INTERNALINFO.has(rootTag)) {
    return xml;
  }
  if (xml.includes('<InternalInfo>')) {
    return xml;
  }

  // Insert right before <Properties> of the rootTag.
  const re = new RegExp(
    `(<${rootTag}\\b[^>]*>\\s*\\r?\\n)([\\t ]*)<Properties>`,
    'm'
  );
  const m = xml.match(re);
  if (!m) {return xml;}
  const indent = m[2] ?? '';
  const internalInfo = buildInternalInfoXml(rootTag, objectName, indent);
  return xml.replace(re, `$1${internalInfo}${indent}<Properties>`);
}

export function buildTabularSectionInternalInfoObject(
  rootTag: string,
  parentObjectName: string,
  sectionName: string
): Record<string, unknown> {
  const sectionTypePrefix = `${rootTag}TabularSection`;
  const rowTypePrefix = `${rootTag}TabularSectionRow`;
  const generatedBase = `${parentObjectName}.${sectionName}`;

  const makeType = (namePrefix: string, category: string): Record<string, unknown> => ({
    '@_name': `${namePrefix}.${generatedBase}`,
    '@_category': category,
    'xr:TypeId': [{ '#text': XMLWriter.generateSimpleUuid() }],
    'xr:ValueId': [{ '#text': XMLWriter.generateSimpleUuid() }],
  });

  return {
    'xr:GeneratedType': [
      makeType(sectionTypePrefix, 'TabularSection'),
      makeType(rowTypePrefix, 'TabularSectionRow'),
    ],
  };
}

