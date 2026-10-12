import { MetadataType } from '../models/treeNode';

/** Standard BSL module kinds owned by a metadata type. */
export type StandardModuleKind =
  | 'ObjectModule'
  | 'ManagerModule'
  | 'RecordSetModule'
  | 'ValueManagerModule'
  | 'CommonModule'
  | 'ManagedApplicationModule';

/** Canonical relation between a metadata type, its standard module kind, and file. */
export interface MetadataStandardModuleDescriptor {
  readonly metadataType: MetadataType;
  readonly kind: StandardModuleKind;
  readonly fileName: string;
  readonly label: string;
}

/**
 * Canonical registry for standard modules directly owned by metadata objects.
 * Tree, path, debug, and feature adapters project this relation while keeping their
 * own presentation and admission policies.
 */
export const METADATA_STANDARD_MODULE_DESCRIPTORS: readonly MetadataStandardModuleDescriptor[] = [
  {
    metadataType: MetadataType.Catalog,
    kind: 'ObjectModule',
    fileName: 'ObjectModule.bsl',
    label: 'Модуль объекта',
  },
  {
    metadataType: MetadataType.Catalog,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.Document,
    kind: 'ObjectModule',
    fileName: 'ObjectModule.bsl',
    label: 'Модуль объекта',
  },
  {
    metadataType: MetadataType.Document,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.Report,
    kind: 'ObjectModule',
    fileName: 'ObjectModule.bsl',
    label: 'Модуль объекта',
  },
  {
    metadataType: MetadataType.Report,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.DataProcessor,
    kind: 'ObjectModule',
    fileName: 'ObjectModule.bsl',
    label: 'Модуль объекта',
  },
  {
    metadataType: MetadataType.DataProcessor,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.BusinessProcess,
    kind: 'ObjectModule',
    fileName: 'ObjectModule.bsl',
    label: 'Модуль объекта',
  },
  {
    metadataType: MetadataType.BusinessProcess,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.Task,
    kind: 'ObjectModule',
    fileName: 'ObjectModule.bsl',
    label: 'Модуль объекта',
  },
  {
    metadataType: MetadataType.Task,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.ChartOfAccounts,
    kind: 'ObjectModule',
    fileName: 'ObjectModule.bsl',
    label: 'Модуль объекта',
  },
  {
    metadataType: MetadataType.ChartOfAccounts,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.ChartOfCharacteristicTypes,
    kind: 'ObjectModule',
    fileName: 'ObjectModule.bsl',
    label: 'Модуль объекта',
  },
  {
    metadataType: MetadataType.ChartOfCharacteristicTypes,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.ChartOfCalculationTypes,
    kind: 'ObjectModule',
    fileName: 'ObjectModule.bsl',
    label: 'Модуль объекта',
  },
  {
    metadataType: MetadataType.ChartOfCalculationTypes,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.ExchangePlan,
    kind: 'ObjectModule',
    fileName: 'ObjectModule.bsl',
    label: 'Модуль объекта',
  },
  {
    metadataType: MetadataType.ExchangePlan,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.Enum,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.Constant,
    kind: 'ValueManagerModule',
    fileName: 'ValueManagerModule.bsl',
    label: 'Модуль менеджера значений',
  },
  {
    metadataType: MetadataType.InformationRegister,
    kind: 'RecordSetModule',
    fileName: 'RecordSetModule.bsl',
    label: 'Модуль набора записей',
  },
  {
    metadataType: MetadataType.InformationRegister,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.AccumulationRegister,
    kind: 'RecordSetModule',
    fileName: 'RecordSetModule.bsl',
    label: 'Модуль набора записей',
  },
  {
    metadataType: MetadataType.AccumulationRegister,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.AccountingRegister,
    kind: 'RecordSetModule',
    fileName: 'RecordSetModule.bsl',
    label: 'Модуль набора записей',
  },
  {
    metadataType: MetadataType.AccountingRegister,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.CalculationRegister,
    kind: 'RecordSetModule',
    fileName: 'RecordSetModule.bsl',
    label: 'Модуль набора записей',
  },
  {
    metadataType: MetadataType.CalculationRegister,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.Sequence,
    kind: 'RecordSetModule',
    fileName: 'RecordSetModule.bsl',
    label: 'Модуль набора записей',
  },
  {
    metadataType: MetadataType.Sequence,
    kind: 'ManagerModule',
    fileName: 'ManagerModule.bsl',
    label: 'Модуль менеджера',
  },
  {
    metadataType: MetadataType.CommonModule,
    kind: 'CommonModule',
    fileName: 'Module.bsl',
    label: 'Модуль',
  },
  {
    metadataType: MetadataType.Configuration,
    kind: 'ManagedApplicationModule',
    fileName: 'ManagedApplicationModule.bsl',
    label: 'Модуль управляемого приложения',
  },
];

const descriptorsByType = new Map<MetadataType, MetadataStandardModuleDescriptor[]>();
const descriptorsByTypeAndFileName = new Map<string, MetadataStandardModuleDescriptor>();
const descriptorsByTypeAndKind = new Map<string, MetadataStandardModuleDescriptor>();

for (const descriptor of METADATA_STANDARD_MODULE_DESCRIPTORS) {
  const typeDescriptors = descriptorsByType.get(descriptor.metadataType) ?? [];
  typeDescriptors.push(descriptor);
  descriptorsByType.set(descriptor.metadataType, typeDescriptors);
  descriptorsByTypeAndFileName.set(
    `${descriptor.metadataType}\u0000${descriptor.fileName}`,
    descriptor
  );
  descriptorsByTypeAndKind.set(`${descriptor.metadataType}\u0000${descriptor.kind}`, descriptor);
}

export function getStandardModules(
  metadataType: MetadataType
): readonly MetadataStandardModuleDescriptor[] {
  return descriptorsByType.get(metadataType) ?? [];
}

export function getStandardModuleByFileName(
  metadataType: MetadataType,
  fileName: string
): MetadataStandardModuleDescriptor | undefined {
  return descriptorsByTypeAndFileName.get(`${metadataType}\u0000${fileName}`);
}

export function getStandardModuleFileName(
  metadataType: MetadataType,
  kind: StandardModuleKind
): string | undefined {
  return descriptorsByTypeAndKind.get(`${metadataType}\u0000${kind}`)?.fileName;
}
