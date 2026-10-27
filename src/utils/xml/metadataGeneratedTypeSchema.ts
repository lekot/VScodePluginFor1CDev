/** Root objects whose Designer XML omits InternalInfo. */
export const ROOT_TAGS_WITHOUT_INTERNALINFO: ReadonlySet<string> = new Set([
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
  'Interface',
]);

export interface GeneratedTypeSpec {
  readonly namePrefix: string;
  readonly category: string;
}

/** Explicit generator metadata only. Unknown types do not receive a Manager fallback here. */
export function getExplicitGeneratedTypeSpecs(rootTag: string): readonly GeneratedTypeSpec[] | undefined {
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
        { namePrefix: 'RecalculationsManager', category: 'Recalcs' },
      ];
    case 'ExternalDataSource':
      return [
        { namePrefix: 'ExternalDataSourceManager', category: 'Manager' },
        { namePrefix: 'ExternalDataSourceTablesManager', category: 'TablesManager' },
        { namePrefix: 'ExternalDataSourceCubesManager', category: 'CubesManager' },
      ];
    case 'Sequence':
      return [
        { namePrefix: 'SequenceRecord', category: 'Record' },
        { namePrefix: 'SequenceManager', category: 'Manager' },
        { namePrefix: 'SequenceRecordSet', category: 'RecordSet' },
      ];
    case 'ChartOfAccounts':
      return [
        { namePrefix: 'ChartOfAccountsObject', category: 'Object' },
        { namePrefix: 'ChartOfAccountsRef', category: 'Ref' },
        { namePrefix: 'ChartOfAccountsSelection', category: 'Selection' },
        { namePrefix: 'ChartOfAccountsList', category: 'List' },
        { namePrefix: 'ChartOfAccountsManager', category: 'Manager' },
        { namePrefix: 'ChartOfAccountsExtDimensionTypes', category: 'ExtDimensionTypes' },
        { namePrefix: 'ChartOfAccountsExtDimensionTypesRow', category: 'ExtDimensionTypesRow' },
      ];
    case 'ChartOfCharacteristicTypes':
      return [
        { namePrefix: 'ChartOfCharacteristicTypesObject', category: 'Object' },
        { namePrefix: 'ChartOfCharacteristicTypesRef', category: 'Ref' },
        { namePrefix: 'ChartOfCharacteristicTypesSelection', category: 'Selection' },
        { namePrefix: 'ChartOfCharacteristicTypesList', category: 'List' },
        { namePrefix: 'Characteristic', category: 'Characteristic' },
        { namePrefix: 'ChartOfCharacteristicTypesManager', category: 'Manager' },
      ];
    case 'ChartOfCalculationTypes':
      return [
        { namePrefix: 'ChartOfCalculationTypesObject', category: 'Object' },
        { namePrefix: 'ChartOfCalculationTypesRef', category: 'Ref' },
        { namePrefix: 'ChartOfCalculationTypesSelection', category: 'Selection' },
        { namePrefix: 'ChartOfCalculationTypesList', category: 'List' },
        { namePrefix: 'ChartOfCalculationTypesManager', category: 'Manager' },
        { namePrefix: 'DisplacingCalculationTypes', category: 'DisplacingCalculationTypes' },
        { namePrefix: 'DisplacingCalculationTypesRow', category: 'DisplacingCalculationTypesRow' },
        { namePrefix: 'BaseCalculationTypes', category: 'BaseCalculationTypes' },
        { namePrefix: 'BaseCalculationTypesRow', category: 'BaseCalculationTypesRow' },
        { namePrefix: 'LeadingCalculationTypes', category: 'LeadingCalculationTypes' },
        { namePrefix: 'LeadingCalculationTypesRow', category: 'LeadingCalculationTypesRow' },
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
      return [
        { namePrefix: 'FilterCriterionManager', category: 'Manager' },
        { namePrefix: 'FilterCriterionList', category: 'List' },
      ];
    case 'SettingsStorage':
      return [{ namePrefix: 'SettingsStorageManager', category: 'Manager' }];
    case 'IntegrationService':
      return [{ namePrefix: 'IntegrationServiceManager', category: 'Manager' }];
    case 'WSReference':
      return [{ namePrefix: 'WSReferenceManager', category: 'Manager' }];
    default:
      return undefined;
  }
}
