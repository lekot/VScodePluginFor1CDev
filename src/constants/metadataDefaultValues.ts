/**
 * Default property values for metadata elements when creating new items.
 * Used by XMLWriter.createMinimalElementFile and buildMinimalNestedElement.
 * Does not duplicate propertySections (UI grouping); only "required/default" values for XML.
 */

import { MetadataType } from '../models/treeNode';

export type DefaultProperties = Record<string, unknown>;

const ROOT_TAG_DEFAULTS: Record<string, DefaultProperties> = {
  Catalog: {
    Hierarchical: false,
    CodeLength: 9,
    DescriptionLength: 25,
    CodeType: 'String',
  },
  Document: {
    NumberType: 'String',
    NumberLength: 9,
  },
  Enum: {},
  Report: {},
  DataProcessor: {},
  ChartOfCharacteristicTypes: {},
  ChartOfAccounts: {},
  ChartOfCalculationTypes: {},
  InformationRegister: {},
  AccumulationRegister: {},
  AccountingRegister: {},
  CalculationRegister: {},
  BusinessProcess: {},
  Task: {},
  ExternalDataSource: {},
  Constant: {},
  SessionParameter: {},
  FilterCriterion: {},
  ScheduledJob: {},
  FunctionalOption: {},
  FunctionalOptionsParameter: {},
  SettingsStorage: {},
  EventSubscription: {},
  CommonModule: {},
  CommandGroup: {},
  Role: {},
  Interface: {},
  Style: {},
  WebService: {},
  HTTPService: {},
  IntegrationService: {},
  Subsystem: {},
  ExchangePlan: {},
  DocumentJournal: {},
  DefinedType: {},
  CommonAttribute: {},
  CommonCommand: {},
  CommonForm: {},
  CommonPicture: {},
  CommonTemplate: {},
  DocumentNumerator: {},
  Language: {},
  WSReference: {},
  XDTOPackage: {},
  StyleItem: {},
};

/** Defaults for nested Attribute (Type = String 50 is applied in XMLWriter; here only extra scalars if needed). */
const ATTRIBUTE_DEFAULTS: DefaultProperties = {
  // Name, Synonym, Type are set in buildMinimalNestedElement; Comment can be empty
  Comment: '',
  PasswordMode: false,
  Format: '',
  EditFormat: '',
  ToolTip: {
    // Empty ToolTip with proper structure - will be handled by XML writer
  },
  MarkNegatives: false,
  Mask: '',
  MultiLine: false,
  ExtendedEdit: false,
  MinValue: null, // Will be rendered as xsi:nil="true"
  MaxValue: null, // Will be rendered as xsi:nil="true"
  FillFromFillingValue: true,
  // FillValue will be set based on type in the UI, for now empty
  FillValue: null,
  FillChecking: 'ShowError',
  ChoiceFoldersAndItems: 'Items',
  ChoiceParameterLinks: '',
  ChoiceParameters: '',
  QuickChoice: 'Auto',
  CreateOnInput: 'Auto',
  ChoiceForm: '',
  LinkByType: '',
  ChoiceHistoryOnInput: 'Auto',
  Indexing: 'DontIndex',
  FullTextSearch: 'Use',
  DataHistory: 'Use',
};

/**
 * Defaults for nested Attribute when Attribute belongs to a DataProcessor (Обработка).
 *
 * In some 1C versions/configs, requisites (Attributes) inside DataProcessor don't support
 * the same set of properties as requisites inside catalogs/documents. Generating XML with
 * unsupported property names leads to "Неверное свойство объекта метаданных..."
 */
const ATTRIBUTE_DEFAULTS_FOR_DATAPROCESSOR: DefaultProperties = {
  ...ATTRIBUTE_DEFAULTS,
  // These properties are reported by 1C as invalid for DataProcessor requisites.
  Indexing: undefined as unknown as string,
  FullTextSearch: undefined as unknown as string,
  DataHistory: undefined as unknown as string,
  FillValue: undefined as unknown as null,
  FillFromFillingValue: undefined as unknown as boolean,
};

/** Defaults for TabularSection (no Type at tabular level in 1C). */
const TABULAR_SECTION_DEFAULTS: DefaultProperties = {
  // Name, Synonym only; no Type
};

/**
 * Returns default properties for a root metadata tag (Catalog, Document, etc.).
 * Used when creating a new top-level element file.
 */
export function getDefaultPropertiesForRootTag(rootTag: string): DefaultProperties {
  const defaults = ROOT_TAG_DEFAULTS[rootTag];
  if (!defaults) {
    return {};
  }
  return { ...defaults };
}

/**
 * Returns default properties for a nested element (Attribute or TabularSection).
 * Name and Synonym are always set by caller; Type for Attribute is applied in XMLWriter.
 */
export function getDefaultPropertiesForNestedElement(
  elementType: 'Attribute' | 'TabularSection',
  parentRootType?: MetadataType
): DefaultProperties {
  const defaults =
    elementType === 'Attribute'
      ? parentRootType === MetadataType.DataProcessor
        ? ATTRIBUTE_DEFAULTS_FOR_DATAPROCESSOR
        : ATTRIBUTE_DEFAULTS
      : TABULAR_SECTION_DEFAULTS;
  return { ...defaults };
}