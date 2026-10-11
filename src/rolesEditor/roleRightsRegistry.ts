/**
 * Canonical domain catalog for root 1C metadata-object rights.
 *
 * Each right is declared once with applicability and semantic capabilities. UI and Agent
 * projections are derived below so these surfaces cannot grow separate allowlists.
 */

export interface RoleRightDescriptor {
  readonly xmlName: string;
  readonly key: string;
  readonly applicableTo: readonly string[];
  readonly ui?: { readonly label: string };
  readonly dependencies: readonly string[];
  readonly clearedBy: readonly string[];
  readonly interactiveBase?: string;
  readonly presets: readonly ('view' | 'edit' | 'post')[];
}

type RoleRightDefinition = Omit<RoleRightDescriptor, 'key'>;

type RoleRightOptions = Partial<Omit<RoleRightDefinition, 'xmlName' | 'applicableTo'>>;

function defineRoleRight(
  xmlName: string,
  applicableTo: readonly string[],
  options: RoleRightOptions = {}
): RoleRightDefinition {
  return {
    xmlName,
    applicableTo,
    dependencies: [],
    clearedBy: [],
    presets: [],
    ...options,
  };
}

const CATALOG_DOCUMENT_TYPES = ['Catalog', 'Document'] as const;
const STANDARD_REGISTER_TYPES = [...CATALOG_DOCUMENT_TYPES, 'InformationRegister', 'AccumulationRegister', 'AccountingRegister'] as const;
const CHART_TYPES = ['ChartOfAccounts', 'ChartOfCharacteristicTypes', 'ChartOfCalculationTypes'] as const;
const CRUD_TYPES = [...CATALOG_DOCUMENT_TYPES, ...CHART_TYPES, 'ExchangePlan', 'BusinessProcess', 'Task'] as const;
const PREDEFINED_DATA_TYPES = ['Catalog', ...CHART_TYPES] as const;
const READ_VIEW_BASE_TYPES = [
  ...STANDARD_REGISTER_TYPES,
  'CalculationRegister',
  'Constant',
  ...CHART_TYPES,
  'ExchangePlan',
  'BusinessProcess',
  'Task',
] as const;
const READ_TYPES = [...READ_VIEW_BASE_TYPES, 'DocumentJournal', 'Sequence'] as const;
const VIEW_TYPES = [
  ...READ_VIEW_BASE_TYPES,
  'DataProcessor',
  'Report',
  'CommonForm',
  'CommonCommand',
  'Subsystem',
  'FilterCriterion',
  'DocumentJournal',
  'CommonAttribute',
] as const;
const EDIT_UPDATE_BASE_TYPES = [
  ...STANDARD_REGISTER_TYPES,
  'Constant',
  ...CHART_TYPES,
  'ExchangePlan',
  'BusinessProcess',
  'Task',
] as const;
const UPDATE_TYPES = [...EDIT_UPDATE_BASE_TYPES, 'Sequence'] as const;
const EDIT_TYPES = [...EDIT_UPDATE_BASE_TYPES, 'CommonAttribute'] as const;
const INTERACTIVE_DELETE_MARKED_TYPES = ['Catalog', 'Document', 'ChartOfCharacteristicTypes', 'ExchangePlan'] as const;
const HISTORY_BASE_TYPES = ['Catalog', 'Document', 'InformationRegister'] as const;
const HISTORY_WITH_CONSTANT_AND_CHART_OF_ACCOUNTS_TYPES = [
  ...HISTORY_BASE_TYPES,
  'Constant',
  'ChartOfAccounts',
  'ChartOfCharacteristicTypes',
  'ExchangePlan',
] as const;
const HISTORY_WITHOUT_CONSTANT_TYPES = [
  ...HISTORY_BASE_TYPES,
  'ChartOfAccounts',
  'ChartOfCharacteristicTypes',
  'ExchangePlan',
] as const;
const HISTORY_WITHOUT_CHART_OF_ACCOUNTS_TYPES = [
  ...HISTORY_BASE_TYPES,
  'Constant',
  'ChartOfCharacteristicTypes',
  'ExchangePlan',
] as const;
const DOCUMENT_TYPES = ['Document'] as const;
const CONFIGURATION_TYPES = ['Configuration'] as const;
const CONFIGURATION_AND_DATA_SOURCE_TYPES = ['Configuration', 'ExternalDataSource'] as const;
const BUSINESS_PROCESS_TYPES = ['BusinessProcess'] as const;
const BUSINESS_PROCESS_AND_TASK_TYPES = ['BusinessProcess', 'Task'] as const;
const TASK_TYPES = ['Task'] as const;
const REGISTER_TOTALS_TYPES = ['InformationRegister', 'AccumulationRegister', 'AccountingRegister'] as const;
const SOURCE_TYPES = ['DataProcessor', 'Report', 'WebService', 'HTTPService', 'IntegrationService', 'ExternalDataSource'] as const;
const EXTERNAL_DATA_SOURCE_TYPES = ['ExternalDataSource'] as const;
const SESSION_PARAMETER_TYPES = ['SessionParameter'] as const;

const ROLE_RIGHT_DEFINITIONS: readonly RoleRightDefinition[] = [
  defineRoleRight('Administration', CONFIGURATION_AND_DATA_SOURCE_TYPES),
  defineRoleRight('DataAdministration', CONFIGURATION_TYPES),
  defineRoleRight('UpdateDataBaseConfiguration', CONFIGURATION_TYPES),
  defineRoleRight('ConfigurationExtensionsAdministration', CONFIGURATION_TYPES),
  defineRoleRight('ActiveUsers', CONFIGURATION_TYPES),
  defineRoleRight('EventLog', CONFIGURATION_TYPES),
  defineRoleRight('ExclusiveMode', CONFIGURATION_TYPES),
  defineRoleRight('ThinClient', CONFIGURATION_TYPES),
  defineRoleRight('ThickClient', CONFIGURATION_TYPES),
  defineRoleRight('WebClient', CONFIGURATION_TYPES),
  defineRoleRight('MobileClient', CONFIGURATION_TYPES),
  defineRoleRight('ExternalConnection', CONFIGURATION_TYPES),
  defineRoleRight('Automation', CONFIGURATION_TYPES),
  defineRoleRight('Output', CONFIGURATION_TYPES),
  defineRoleRight('SaveUserData', CONFIGURATION_TYPES),
  defineRoleRight('TechnicalSpecialistMode', CONFIGURATION_TYPES),
  defineRoleRight('InteractiveOpenExtDataProcessors', CONFIGURATION_TYPES),
  defineRoleRight('InteractiveOpenExtReports', CONFIGURATION_TYPES),
  defineRoleRight('AnalyticsSystemClient', CONFIGURATION_TYPES),
  defineRoleRight('CollaborationSystemInfoBaseRegistration', CONFIGURATION_TYPES),
  defineRoleRight('MainWindowModeNormal', CONFIGURATION_TYPES),
  defineRoleRight('MainWindowModeWorkplace', CONFIGURATION_TYPES),
  defineRoleRight('MainWindowModeEmbeddedWorkplace', CONFIGURATION_TYPES),
  defineRoleRight('MainWindowModeFullscreenWorkplace', CONFIGURATION_TYPES),
  defineRoleRight('MainWindowModeKiosk', CONFIGURATION_TYPES),
  defineRoleRight('Read', READ_TYPES, { ui: { label: 'Read' }, presets: ['view', 'edit'] }),
  defineRoleRight('Insert', CRUD_TYPES, { ui: { label: 'Insert' }, presets: ['edit'] }),
  defineRoleRight('Update', UPDATE_TYPES, {
    ui: { label: 'Update' },
    dependencies: ['read'],
    clearedBy: ['read'],
    presets: ['edit'],
  }),
  defineRoleRight('Delete', CRUD_TYPES, {
    ui: { label: 'Delete' },
    dependencies: ['read'],
    clearedBy: ['read'],
    presets: ['edit'],
  }),
  defineRoleRight('View', VIEW_TYPES, { ui: { label: 'View' }, presets: ['view', 'edit'] }),
  defineRoleRight('Edit', EDIT_TYPES, { ui: { label: 'Edit' }, presets: ['edit'] }),
  defineRoleRight('InputByString', CRUD_TYPES, { presets: ['view', 'edit'] }),
  defineRoleRight('InteractiveInsert', CRUD_TYPES, {
    ui: { label: 'Int. Insert' },
    dependencies: ['insert'],
    clearedBy: ['insert'],
    interactiveBase: 'insert',
    presets: ['edit'],
  }),
  defineRoleRight('InteractiveSetDeletionMark', CRUD_TYPES, {
    ui: { label: 'Int. Set Del. Mark' },
    clearedBy: ['read'],
    presets: ['edit'],
  }),
  defineRoleRight('InteractiveClearDeletionMark', CRUD_TYPES, {
    ui: { label: 'Int. Clear Del. Mark' },
    clearedBy: ['read'],
    presets: ['edit'],
  }),
  defineRoleRight('InteractiveDelete', CRUD_TYPES, {
    ui: { label: 'Int. Delete' },
    dependencies: ['delete'],
    clearedBy: ['delete', 'read'],
    interactiveBase: 'delete',
    presets: ['edit'],
  }),
  defineRoleRight('InteractiveDeleteMarked', INTERACTIVE_DELETE_MARKED_TYPES, {
    ui: { label: 'Int. Del. Marked' },
    dependencies: ['delete'],
    clearedBy: ['delete', 'read'],
    interactiveBase: 'delete',
    presets: ['edit'],
  }),
  defineRoleRight('InteractiveDeletePredefinedData', PREDEFINED_DATA_TYPES, {
    ui: { label: 'Int. Del. Predef.' },
    dependencies: ['delete'],
    clearedBy: ['delete', 'read'],
    interactiveBase: 'delete',
    presets: ['edit'],
  }),
  defineRoleRight('InteractiveSetDeletionMarkPredefinedData', PREDEFINED_DATA_TYPES, { presets: ['edit'] }),
  defineRoleRight('InteractiveClearDeletionMarkPredefinedData', PREDEFINED_DATA_TYPES, { presets: ['edit'] }),
  defineRoleRight('InteractiveDeleteMarkedPredefinedData', PREDEFINED_DATA_TYPES, {
    ui: { label: 'Int. Del. Marked Predef.' },
    dependencies: ['delete'],
    clearedBy: ['delete', 'read'],
    interactiveBase: 'delete',
    presets: ['edit'],
  }),
  defineRoleRight('ReadDataHistory', HISTORY_WITH_CONSTANT_AND_CHART_OF_ACCOUNTS_TYPES),
  defineRoleRight('ViewDataHistory', HISTORY_WITHOUT_CHART_OF_ACCOUNTS_TYPES),
  defineRoleRight('UpdateDataHistory', HISTORY_WITH_CONSTANT_AND_CHART_OF_ACCOUNTS_TYPES),
  defineRoleRight('UpdateDataHistoryOfMissingData', HISTORY_WITHOUT_CONSTANT_TYPES),
  defineRoleRight('ReadDataHistoryOfMissingData', HISTORY_WITHOUT_CONSTANT_TYPES),
  defineRoleRight('UpdateDataHistorySettings', HISTORY_WITH_CONSTANT_AND_CHART_OF_ACCOUNTS_TYPES),
  defineRoleRight('UpdateDataHistoryVersionComment', HISTORY_WITH_CONSTANT_AND_CHART_OF_ACCOUNTS_TYPES),
  defineRoleRight('EditDataHistoryVersionComment', HISTORY_WITHOUT_CHART_OF_ACCOUNTS_TYPES),
  defineRoleRight('SwitchToDataHistoryVersion', HISTORY_WITHOUT_CHART_OF_ACCOUNTS_TYPES),
  defineRoleRight('Posting', DOCUMENT_TYPES, { presets: ['post'] }),
  defineRoleRight('UndoPosting', DOCUMENT_TYPES, { presets: ['post'] }),
  defineRoleRight('InteractivePosting', DOCUMENT_TYPES, { presets: ['post'] }),
  defineRoleRight('InteractivePostingRegular', DOCUMENT_TYPES),
  defineRoleRight('InteractiveUndoPosting', DOCUMENT_TYPES, { presets: ['post'] }),
  defineRoleRight('InteractiveChangeOfPosted', DOCUMENT_TYPES),
  defineRoleRight('TotalsControl', REGISTER_TOTALS_TYPES),
  defineRoleRight('Start', BUSINESS_PROCESS_TYPES),
  defineRoleRight('InteractiveActivate', BUSINESS_PROCESS_AND_TASK_TYPES),
  defineRoleRight('InteractiveStart', BUSINESS_PROCESS_TYPES),
  defineRoleRight('Execute', TASK_TYPES),
  defineRoleRight('InteractiveExecute', TASK_TYPES),
  defineRoleRight('Use', SOURCE_TYPES, { presets: ['view'] }),
  defineRoleRight('Get', SESSION_PARAMETER_TYPES),
  defineRoleRight('Set', SESSION_PARAMETER_TYPES),
  defineRoleRight('StandardAuthenticationChange', EXTERNAL_DATA_SOURCE_TYPES),
  defineRoleRight('SessionStandardAuthenticationChange', EXTERNAL_DATA_SOURCE_TYPES),
  defineRoleRight('SessionOSAuthenticationChange', EXTERNAL_DATA_SOURCE_TYPES),
];

function modelKey(xmlName: string): string {
  return xmlName.length === 0 ? xmlName : xmlName.charAt(0).toLowerCase() + xmlName.slice(1);
}

export const ROLE_RIGHTS_REGISTRY: readonly RoleRightDescriptor[] = Object.freeze(
  ROLE_RIGHT_DEFINITIONS.map((right) =>
    Object.freeze({
      ...right,
      key: modelKey(right.xmlName),
      applicableTo: Object.freeze([...right.applicableTo]),
      ui: right.ui ? Object.freeze({ ...right.ui }) : undefined,
      dependencies: Object.freeze([...right.dependencies]),
      clearedBy: Object.freeze([...right.clearedBy]),
      presets: Object.freeze([...right.presets]),
    })
  )
);

const rightsByXmlName = new Map(ROLE_RIGHTS_REGISTRY.map((right) => [right.xmlName, right]));
const rightsByKey = new Map(ROLE_RIGHTS_REGISTRY.map((right) => [right.key, right]));

export function getRoleRightsForType(type: string): readonly RoleRightDescriptor[] {
  return ROLE_RIGHTS_REGISTRY.filter((right) => right.applicableTo.includes(type));
}

export function getRoleRightByXmlName(xmlName: string): RoleRightDescriptor | undefined {
  return rightsByXmlName.get(xmlName);
}

export function getRoleRightByKey(key: string): RoleRightDescriptor | undefined {
  return rightsByKey.get(key);
}

export function getRoleRightPreset(
  type: string,
  preset: 'view' | 'edit' | 'post'
): readonly string[] {
  return getRoleRightsForType(type)
    .filter(
      (right) =>
        right.presets.includes(preset) ||
        (preset !== 'view' && (right.presets.includes('edit') || right.presets.includes('view')))
    )
    .map((right) => right.xmlName);
}

export const UI_ROLE_RIGHTS: readonly RoleRightDescriptor[] = Object.freeze(
  ROLE_RIGHTS_REGISTRY.filter((right) => right.ui !== undefined)
);

export const ROLE_RIGHT_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    ROLE_RIGHTS_REGISTRY.filter((right) => right.dependencies.length > 0).map((right) => [
      right.key,
      right.dependencies,
    ])
  )
);

const rightsByType = new Map<string, string[]>();
for (const right of ROLE_RIGHTS_REGISTRY) {
  for (const type of right.applicableTo) {
    const rights = rightsByType.get(type) ?? [];
    rights.push(right.xmlName);
    rightsByType.set(type, rights);
  }
}

export const ROLE_RIGHTS_BY_TYPE: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    [...rightsByType.entries()].map(([type, names]) => [type, Object.freeze(names)])
  )
);
