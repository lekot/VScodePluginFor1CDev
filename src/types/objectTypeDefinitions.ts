/** Допустимые Object-kinds для v8:Type в Source-подобных свойствах. */
export type ObjectKind =
  | 'CatalogObject'
  | 'DocumentObject'
  | 'BusinessProcessObject'
  | 'TaskObject'
  | 'ChartOfCharacteristicTypesObject'
  | 'ChartOfAccountsObject'
  | 'ChartOfCalculationTypesObject'
  | 'ExchangePlanObject'
  | 'InformationRegisterRecordSet'
  | 'AccumulationRegisterRecordSet'
  | 'AccountingRegisterRecordSet'
  | 'CalculationRegisterRecordSet'
  | 'CatalogManager'
  | 'DocumentManager'
  | 'BusinessProcessManager'
  | 'TaskManager'
  | 'ChartOfCharacteristicTypesManager'
  | 'ChartOfAccountsManager'
  | 'ChartOfCalculationTypesManager'
  | 'ExchangePlanManager'
  | 'InformationRegisterManager'
  | 'AccumulationRegisterManager'
  | 'AccountingRegisterManager'
  | 'CalculationRegisterManager'
  | 'ConstantValueManager'
  | 'DataProcessorManager'
  | 'ReportManager'
  | 'DocumentJournalManager'
  | 'DefinedType';

/**
 * Manager-kinds that appear without an object name in XML (e.g. cfg:CatalogManager).
 * DefinedType always has a name, so it is NOT in this set.
 */
export const OBJECT_KINDS_WITHOUT_NAME: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  'CatalogManager',
  'DocumentManager',
  'BusinessProcessManager',
  'TaskManager',
  'ChartOfCharacteristicTypesManager',
  'ChartOfAccountsManager',
  'ChartOfCalculationTypesManager',
  'ExchangePlanManager',
  'InformationRegisterManager',
  'AccumulationRegisterManager',
  'AccountingRegisterManager',
  'CalculationRegisterManager',
  'ConstantValueManager',
  'DataProcessorManager',
  'ReportManager',
  'DocumentJournalManager',
]);

export interface ObjectTypeInfo {
  objectKind: ObjectKind;
  objectName: string;
}

export interface ObjectTypeDefinition {
  types: ObjectTypeInfo[];
}

/** Аналог ReferenceableGroup для Object-редактора. */
export interface ObjectableGroup {
  objectKind: ObjectKind;
  objectNames: string[];
}
