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

type GeneratedTypeProfileEntry = readonly [suffix: string, category: string, prefixOverride?: string];
type GeneratedTypeProfile = readonly GeneratedTypeProfileEntry[];

const suffixProfile = (...suffixes: readonly string[]): GeneratedTypeProfile => suffixes.map((suffix) => [suffix, suffix] as const);
const exactPrefix = (prefix: string, category = prefix): GeneratedTypeProfileEntry => [prefix, category, prefix];

const OBJECT_REFERENCE_PROFILE = suffixProfile('Object', 'Ref', 'Selection', 'List', 'Manager');
const REGISTER_PROFILE = suffixProfile('Record', 'Manager', 'Selection', 'List', 'RecordSet', 'RecordKey');
const OBJECT_MANAGER_PROFILE = suffixProfile('Object', 'Manager');

const GENERATED_TYPE_PROFILES: Readonly<Record<string, GeneratedTypeProfile>> = {
  Catalog: OBJECT_REFERENCE_PROFILE,
  Document: OBJECT_REFERENCE_PROFILE,
  Task: OBJECT_REFERENCE_PROFILE,
  BusinessProcess: [...OBJECT_REFERENCE_PROFILE, ['RoutePointRef', 'RoutePointRef']],
  Enum: suffixProfile('Ref', 'Manager', 'List'),
  Report: OBJECT_MANAGER_PROFILE,
  DataProcessor: OBJECT_MANAGER_PROFILE,
  Constant: suffixProfile('Manager', 'ValueManager', 'ValueKey'),
  InformationRegister: [...REGISTER_PROFILE, ['RecordManager', 'RecordManager']],
  AccumulationRegister: REGISTER_PROFILE,
  AccountingRegister: suffixProfile('Record', 'ExtDimensions', 'RecordSet', 'RecordKey', 'Selection', 'List', 'Manager'),
  CalculationRegister: [...REGISTER_PROFILE, exactPrefix('RecalculationsManager', 'Recalcs')],
  ExternalDataSource: suffixProfile('Manager', 'TablesManager', 'CubesManager'),
  Sequence: suffixProfile('Record', 'Manager', 'RecordSet'),
  ChartOfAccounts: [...OBJECT_REFERENCE_PROFILE, ['ExtDimensionTypes', 'ExtDimensionTypes'], ['ExtDimensionTypesRow', 'ExtDimensionTypesRow']],
  ChartOfCharacteristicTypes: [
    ...OBJECT_REFERENCE_PROFILE.slice(0, -1),
    exactPrefix('Characteristic'),
    OBJECT_REFERENCE_PROFILE[OBJECT_REFERENCE_PROFILE.length - 1]!,
  ],
  ChartOfCalculationTypes: [
    ...OBJECT_REFERENCE_PROFILE,
    exactPrefix('DisplacingCalculationTypes'),
    exactPrefix('DisplacingCalculationTypesRow'),
    exactPrefix('BaseCalculationTypes'),
    exactPrefix('BaseCalculationTypesRow'),
    exactPrefix('LeadingCalculationTypes'),
    exactPrefix('LeadingCalculationTypesRow'),
  ],
  DefinedType: [exactPrefix('DefinedType')],
  ExchangePlan: OBJECT_REFERENCE_PROFILE,
  DocumentJournal: suffixProfile('Selection', 'List', 'Manager'),
  FilterCriterion: suffixProfile('Manager', 'List'),
  SettingsStorage: suffixProfile('Manager'),
  IntegrationService: suffixProfile('Manager'),
  WSReference: suffixProfile('Manager'),
};

/** Explicit generator metadata only. Unknown types do not receive a Manager fallback here. */
export function getExplicitGeneratedTypeSpecs(rootTag: string): readonly GeneratedTypeSpec[] | undefined {
  const profile = Object.prototype.hasOwnProperty.call(GENERATED_TYPE_PROFILES, rootTag)
    ? GENERATED_TYPE_PROFILES[rootTag]
    : undefined;
  return profile?.map(([suffix, category, prefixOverride]) => ({
    namePrefix: prefixOverride ?? `${rootTag}${suffix}`,
    category,
  }));
}
