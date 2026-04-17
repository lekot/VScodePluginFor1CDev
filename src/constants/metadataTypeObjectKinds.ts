import { MetadataType } from '../models/treeNode';
import type { ObjectKind } from '../types/objectTypeDefinitions';

export const METADATA_TYPE_TO_OBJECT_KIND: Partial<Record<MetadataType, ObjectKind>> = {
  [MetadataType.Catalog]: 'CatalogObject',
  [MetadataType.Document]: 'DocumentObject',
  [MetadataType.BusinessProcess]: 'BusinessProcessObject',
  [MetadataType.Task]: 'TaskObject',
  [MetadataType.ChartOfCharacteristicTypes]: 'ChartOfCharacteristicTypesObject',
  [MetadataType.ChartOfAccounts]: 'ChartOfAccountsObject',
  [MetadataType.ChartOfCalculationTypes]: 'ChartOfCalculationTypesObject',
  [MetadataType.ExchangePlan]: 'ExchangePlanObject',
  [MetadataType.InformationRegister]: 'InformationRegisterRecordSet',
  [MetadataType.AccumulationRegister]: 'AccumulationRegisterRecordSet',
  [MetadataType.AccountingRegister]: 'AccountingRegisterRecordSet',
  [MetadataType.CalculationRegister]: 'CalculationRegisterRecordSet',
};

export const OBJECT_KIND_ORDER: readonly ObjectKind[] = [
  'CatalogObject',
  'DocumentObject',
  'BusinessProcessObject',
  'TaskObject',
  'ChartOfCharacteristicTypesObject',
  'ChartOfAccountsObject',
  'ChartOfCalculationTypesObject',
  'ExchangePlanObject',
  'InformationRegisterRecordSet',
  'AccumulationRegisterRecordSet',
  'AccountingRegisterRecordSet',
  'CalculationRegisterRecordSet',
];
