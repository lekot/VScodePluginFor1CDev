import { MetadataType } from '../../models/treeNode';

/**
 * Same coverage as `elementOperations` TOP_LEVEL_TYPES (Designer single-object XML).
 */
export const TOP_LEVEL_TYPES = new Set<MetadataType>([
  MetadataType.Catalog,
  MetadataType.Document,
  MetadataType.Enum,
  MetadataType.Report,
  MetadataType.DataProcessor,
  MetadataType.ChartOfCharacteristicTypes,
  MetadataType.ChartOfAccounts,
  MetadataType.ChartOfCalculationTypes,
  MetadataType.InformationRegister,
  MetadataType.AccumulationRegister,
  MetadataType.AccountingRegister,
  MetadataType.CalculationRegister,
  MetadataType.BusinessProcess,
  MetadataType.Task,
  MetadataType.ExternalDataSource,
  MetadataType.Constant,
  MetadataType.SessionParameter,
  MetadataType.FilterCriterion,
  MetadataType.ScheduledJob,
  MetadataType.FunctionalOption,
  MetadataType.FunctionalOptionsParameter,
  MetadataType.SettingsStorage,
  MetadataType.EventSubscription,
  MetadataType.CommonModule,
  MetadataType.CommandGroup,
  MetadataType.Role,
  MetadataType.Interface,
  MetadataType.Style,
  MetadataType.WebService,
  MetadataType.HTTPService,
  MetadataType.IntegrationService,
  MetadataType.Subsystem,
  MetadataType.ExchangePlan,
  MetadataType.DocumentJournal,
  MetadataType.DefinedType,
  MetadataType.CommonAttribute,
  MetadataType.CommonCommand,
  MetadataType.CommonForm,
  MetadataType.CommonPicture,
  MetadataType.CommonTemplate,
  MetadataType.DocumentNumerator,
  MetadataType.Language,
  MetadataType.WSReference,
  MetadataType.XDTOPackage,
  MetadataType.StyleItem,
]);

/**
 * Root metadata tags that omit ChildObjects in Designer XML (docs/1c-config-objects-spec.md).
 * Не подставлять искусственно ChildObjects при добавлении вложенных элементов — иначе ibcmd / конфигуратор отвергнут файл.
 */
export const ROOT_TAGS_WITHOUT_CHILDOBJECTS = new Set<string>([
  'CommonModule',
  'Role',
  'SessionParameter',
  'FunctionalOption',
  'FunctionalOptionsParameter',
  'CommandGroup',
  'Interface',
  // Стиль оформления: в ibcmd при пустом ChildObjects — «ожидаемое Style»; в выгрузке нет контейнера ChildObjects.
  'Style',
  'EventSubscription',
  'DefinedType',
  'Language',
  'CommonPicture',
  'CommonAttribute',
  'CommonForm',
  /** Встроенная форма объекта: в ibcmd ожидается последовательность без пустого ChildObjects (см. docs/1c-config-objects-spec.md §6.3). */
  'Form',
  'WSReference',
  'StyleItem',
  'XDTOPackage',
  // Только Properties, без ChildObjects (spec; иначе ibcmd config import падает).
  'DocumentNumerator',
  'ScheduledJob',
  'Constant',
  // Подсистема содержит только состав (Content) и вложенные Subsystem — реквизитов нет.
  'Subsystem',
]);

/**
 * Options for {@link writeNestedElementProperties} (XMLWriter facade).
 * When `scopedTabularSectionName` is set with `elementType === 'Attribute'`, name-based updates apply only
 * to columns under that tabular section (not top-level attributes or other sections).
 */
export type WriteNestedElementOptions = {
  scopedTabularSectionName?: string;
};

/** Internal: Attribute nested write scoped to one tabular section by `<Name>`. */
export type NestedAttributeScopeState = {
  scopedTabularSectionName: string;
  insideMatchingTabularSection: boolean;
};
