import { MetadataType } from '../models/treeNode';

/**
 * Describes a standard module that belongs to a metadata object.
 */
export interface StandardModule {
  /** Filename, e.g. "ObjectModule.bsl" */
  fileName: string;
  /** Human-readable label shown in the tree */
  label: string;
}

/**
 * Maps MetadataType to the list of standard modules that the platform supports for it.
 * Based on 1c-config-objects-spec.md §1.2 module table.
 *
 * Only types that have at least one module are listed here.
 * Types absent from this map have no associated modules.
 */
/* eslint-disable @typescript-eslint/naming-convention */
export const STANDARD_MODULES: Partial<Record<MetadataType, StandardModule[]>> = {
  // ObjectModule + ManagerModule
  [MetadataType.Catalog]: [
    { fileName: 'ObjectModule.bsl', label: 'Модуль объекта' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.Document]: [
    { fileName: 'ObjectModule.bsl', label: 'Модуль объекта' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.Report]: [
    { fileName: 'ObjectModule.bsl', label: 'Модуль объекта' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.DataProcessor]: [
    { fileName: 'ObjectModule.bsl', label: 'Модуль объекта' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.BusinessProcess]: [
    { fileName: 'ObjectModule.bsl', label: 'Модуль объекта' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.Task]: [
    { fileName: 'ObjectModule.bsl', label: 'Модуль объекта' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.ChartOfAccounts]: [
    { fileName: 'ObjectModule.bsl', label: 'Модуль объекта' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.ChartOfCharacteristicTypes]: [
    { fileName: 'ObjectModule.bsl', label: 'Модуль объекта' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.ChartOfCalculationTypes]: [
    { fileName: 'ObjectModule.bsl', label: 'Модуль объекта' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.ExchangePlan]: [
    { fileName: 'ObjectModule.bsl', label: 'Модуль объекта' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],

  // Только ManagerModule
  [MetadataType.Enum]: [{ fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' }],
  [MetadataType.Constant]: [{ fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' }],

  // RecordSetModule + ManagerModule
  [MetadataType.InformationRegister]: [
    { fileName: 'RecordSetModule.bsl', label: 'Модуль набора записей' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.AccumulationRegister]: [
    { fileName: 'RecordSetModule.bsl', label: 'Модуль набора записей' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.AccountingRegister]: [
    { fileName: 'RecordSetModule.bsl', label: 'Модуль набора записей' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],
  [MetadataType.CalculationRegister]: [
    { fileName: 'RecordSetModule.bsl', label: 'Модуль набора записей' },
    { fileName: 'ManagerModule.bsl', label: 'Модуль менеджера' },
  ],

  // Единственный модуль (Module.bsl для CommonModule)
  [MetadataType.CommonModule]: [{ fileName: 'Module.bsl', label: 'Модуль' }],

  // Корневой модуль конфигурации
  [MetadataType.Configuration]: [
    { fileName: 'ManagedApplicationModule.bsl', label: 'Модуль управляемого приложения' },
  ],
};
/* eslint-enable @typescript-eslint/naming-convention */
