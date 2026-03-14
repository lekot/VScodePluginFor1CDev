/**
 * Predefined enum values for metadata properties.
 * Properties listed here will render as <select> dropdowns in the Properties panel.
 */

export const PropertyEnumValues: Record<string, string[]> = {
  // Catalog
  HierarchyType: ['HierarchyFoldersAndItems', 'HierarchyItems'],
  SubordinationUse: ['ToItems', 'ToFoldersAndItems', 'DontUse'],
  CodeType: ['String', 'Number'],
  CodeAllowedLength: ['Variable', 'Fixed'],
  CodeSeries: ['WholeCatalog', 'WithinOwner', 'WithinParent'],
  DefaultPresentation: ['AsDescription', 'AsCode'],
  PredefinedDataUpdate: ['Auto', 'DontAutoUpdate'],
  EditType: ['InDialog', 'InList', 'BothWays'],
  ChoiceMode: ['BothWays', 'FromForm', 'QuickChoice'],
  SearchStringModeOnInputByString: ['Begin', 'Anywhere'],
  FullTextSearchOnInputByString: ['DontUse', 'Use'],
  ChoiceDataGetModeOnInputByString: ['Directly', 'Background', 'BackgroundIfPossible'],
  DataLockControlMode: ['Managed', 'Automatic', 'AutomaticAndManaged'],
  FullTextSearch: ['Use', 'DontUse'],
  CreateOnInput: ['Use', 'DontUse'],
  ChoiceHistoryOnInput: ['Auto', 'DontUse'],
  DataHistory: ['DontUse', 'Use'],

  // Document
  NumberType: ['String', 'Number'],
  NumberAllowedLength: ['Variable', 'Fixed'],
  NumberPeriodicity: ['Nonperiodical', 'Year', 'Quarter', 'Month', 'Day'],

  // Attribute
  FillChecking: ['DontCheck', 'ShowError'],
  ChoiceFoldersAndItems: ['Items', 'Folders', 'FoldersAndItems'],
  Indexing: ['DontIndex', 'Index', 'IndexWithAdditionalOrder'],

  // Register
  Periodicity: [
    'Nonperiodical',
    'RecorderPosition',
    'Second',
    'Minute',
    'Hour',
    'Day',
    'Month',
    'Quarter',
    'Year',
  ],
  WriteMode: ['Independent', 'SubordinateToRecorder'],
  MainMode: ['Independent', 'SubordinateToRecorder'],

  // Configuration
  DefaultRunMode: ['Auto', 'ManagedApplication', 'OrdinaryApplication'],
  ScriptVariant: ['Russian', 'English'],
};

/**
 * Returns enum values for a property, or undefined if it's a free-form field.
 */
export function getPropertyEnumValues(propertyName: string): string[] | undefined {
  return PropertyEnumValues[propertyName];
}
