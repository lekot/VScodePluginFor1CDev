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
  | 'CalculationRegisterRecordSet';

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
