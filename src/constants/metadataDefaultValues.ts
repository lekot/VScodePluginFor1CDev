/**
 * Default property values for metadata elements when creating new items.
 * Used by XMLWriter.createMinimalElementFile and buildMinimalNestedElement.
 * Does not duplicate propertySections (UI grouping); only "required/default" values for XML.
 */

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
};

/** Defaults for nested Attribute (Type = String 50 is applied in XMLWriter; here only extra scalars if needed). */
const ATTRIBUTE_DEFAULTS: DefaultProperties = {
  // Name, Synonym, Type are set in buildMinimalNestedElement; Comment can be empty
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
  elementType: 'Attribute' | 'TabularSection'
): DefaultProperties {
  const defaults =
    elementType === 'Attribute' ? ATTRIBUTE_DEFAULTS : TABULAR_SECTION_DEFAULTS;
  return { ...defaults };
}
