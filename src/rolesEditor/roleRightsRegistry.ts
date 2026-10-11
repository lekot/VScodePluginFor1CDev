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

const ROLE_RIGHT_DEFINITIONS: readonly RoleRightDefinition[] = [
  {
    xmlName: 'Administration',
    applicableTo: ['Configuration', 'ExternalDataSource'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'DataAdministration',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'UpdateDataBaseConfiguration',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'ConfigurationExtensionsAdministration',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'ActiveUsers',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'EventLog',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'ExclusiveMode',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'ThinClient',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'ThickClient',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'WebClient',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'MobileClient',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'ExternalConnection',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'Automation',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'Output',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'SaveUserData',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'TechnicalSpecialistMode',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'InteractiveOpenExtDataProcessors',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'InteractiveOpenExtReports',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'AnalyticsSystemClient',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'CollaborationSystemInfoBaseRegistration',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'MainWindowModeNormal',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'MainWindowModeWorkplace',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'MainWindowModeEmbeddedWorkplace',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'MainWindowModeFullscreenWorkplace',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'MainWindowModeKiosk',
    applicableTo: ['Configuration'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'Read',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'AccumulationRegister',
      'AccountingRegister',
      'CalculationRegister',
      'Constant',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
      'ExchangePlan',
      'BusinessProcess',
      'Task',
      'DocumentJournal',
      'Sequence',
    ],
    ui: {
      label: 'Read',
    },
    dependencies: [],
    clearedBy: [],
    presets: ['view', 'edit'],
  },
  {
    xmlName: 'Insert',
    applicableTo: [
      'Catalog',
      'Document',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
      'ExchangePlan',
      'BusinessProcess',
      'Task',
    ],
    ui: {
      label: 'Insert',
    },
    dependencies: [],
    clearedBy: [],
    presets: ['edit'],
  },
  {
    xmlName: 'Update',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'AccumulationRegister',
      'AccountingRegister',
      'Constant',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
      'ExchangePlan',
      'BusinessProcess',
      'Task',
      'Sequence',
    ],
    ui: {
      label: 'Update',
    },
    dependencies: ['read'],
    clearedBy: ['read'],
    presets: ['edit'],
  },
  {
    xmlName: 'Delete',
    applicableTo: [
      'Catalog',
      'Document',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
      'ExchangePlan',
      'BusinessProcess',
      'Task',
    ],
    ui: {
      label: 'Delete',
    },
    dependencies: ['read'],
    clearedBy: ['read'],
    presets: ['edit'],
  },
  {
    xmlName: 'View',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'AccumulationRegister',
      'AccountingRegister',
      'CalculationRegister',
      'Constant',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
      'ExchangePlan',
      'BusinessProcess',
      'Task',
      'DataProcessor',
      'Report',
      'CommonForm',
      'CommonCommand',
      'Subsystem',
      'FilterCriterion',
      'DocumentJournal',
      'CommonAttribute',
    ],
    ui: {
      label: 'View',
    },
    dependencies: [],
    clearedBy: [],
    presets: ['view', 'edit'],
  },
  {
    xmlName: 'Edit',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'AccumulationRegister',
      'AccountingRegister',
      'Constant',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
      'ExchangePlan',
      'BusinessProcess',
      'Task',
      'CommonAttribute',
    ],
    ui: {
      label: 'Edit',
    },
    dependencies: [],
    clearedBy: [],
    presets: ['edit'],
  },
  {
    xmlName: 'InputByString',
    applicableTo: [
      'Catalog',
      'Document',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
      'ExchangePlan',
      'BusinessProcess',
      'Task',
    ],
    dependencies: [],
    clearedBy: [],
    presets: ['view', 'edit'],
  },
  {
    xmlName: 'InteractiveInsert',
    applicableTo: [
      'Catalog',
      'Document',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
      'ExchangePlan',
      'BusinessProcess',
      'Task',
    ],
    ui: {
      label: 'Int. Insert',
    },
    dependencies: ['insert'],
    clearedBy: ['insert'],
    interactiveBase: 'insert',
    presets: ['edit'],
  },
  {
    xmlName: 'InteractiveSetDeletionMark',
    applicableTo: [
      'Catalog',
      'Document',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
      'ExchangePlan',
      'BusinessProcess',
      'Task',
    ],
    ui: {
      label: 'Int. Set Del. Mark',
    },
    dependencies: [],
    clearedBy: ['read'],
    presets: ['edit'],
  },
  {
    xmlName: 'InteractiveClearDeletionMark',
    applicableTo: [
      'Catalog',
      'Document',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
      'ExchangePlan',
      'BusinessProcess',
      'Task',
    ],
    ui: {
      label: 'Int. Clear Del. Mark',
    },
    dependencies: [],
    clearedBy: ['read'],
    presets: ['edit'],
  },
  {
    xmlName: 'InteractiveDelete',
    applicableTo: [
      'Catalog',
      'Document',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
      'ExchangePlan',
      'BusinessProcess',
      'Task',
    ],
    ui: {
      label: 'Int. Delete',
    },
    dependencies: ['delete'],
    clearedBy: ['delete', 'read'],
    interactiveBase: 'delete',
    presets: ['edit'],
  },
  {
    xmlName: 'InteractiveDeleteMarked',
    applicableTo: ['Catalog', 'Document', 'ChartOfCharacteristicTypes', 'ExchangePlan'],
    ui: {
      label: 'Int. Del. Marked',
    },
    dependencies: ['delete'],
    clearedBy: ['delete', 'read'],
    interactiveBase: 'delete',
    presets: ['edit'],
  },
  {
    xmlName: 'InteractiveDeletePredefinedData',
    applicableTo: [
      'Catalog',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
    ],
    ui: {
      label: 'Int. Del. Predef.',
    },
    dependencies: ['delete'],
    clearedBy: ['delete', 'read'],
    interactiveBase: 'delete',
    presets: ['edit'],
  },
  {
    xmlName: 'InteractiveSetDeletionMarkPredefinedData',
    applicableTo: [
      'Catalog',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
    ],
    dependencies: [],
    clearedBy: [],
    presets: ['edit'],
  },
  {
    xmlName: 'InteractiveClearDeletionMarkPredefinedData',
    applicableTo: [
      'Catalog',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
    ],
    dependencies: [],
    clearedBy: [],
    presets: ['edit'],
  },
  {
    xmlName: 'InteractiveDeleteMarkedPredefinedData',
    applicableTo: [
      'Catalog',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ChartOfCalculationTypes',
    ],
    ui: {
      label: 'Int. Del. Marked Predef.',
    },
    dependencies: ['delete'],
    clearedBy: ['delete', 'read'],
    interactiveBase: 'delete',
    presets: ['edit'],
  },
  {
    xmlName: 'ReadDataHistory',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'Constant',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ExchangePlan',
    ],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'ViewDataHistory',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'Constant',
      'ChartOfCharacteristicTypes',
      'ExchangePlan',
    ],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'UpdateDataHistory',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'Constant',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ExchangePlan',
    ],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'UpdateDataHistoryOfMissingData',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ExchangePlan',
    ],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'ReadDataHistoryOfMissingData',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ExchangePlan',
    ],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'UpdateDataHistorySettings',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'Constant',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ExchangePlan',
    ],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'UpdateDataHistoryVersionComment',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'Constant',
      'ChartOfAccounts',
      'ChartOfCharacteristicTypes',
      'ExchangePlan',
    ],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'EditDataHistoryVersionComment',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'Constant',
      'ChartOfCharacteristicTypes',
      'ExchangePlan',
    ],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'SwitchToDataHistoryVersion',
    applicableTo: [
      'Catalog',
      'Document',
      'InformationRegister',
      'Constant',
      'ChartOfCharacteristicTypes',
      'ExchangePlan',
    ],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'Posting',
    applicableTo: ['Document'],
    dependencies: [],
    clearedBy: [],
    presets: ['post'],
  },
  {
    xmlName: 'UndoPosting',
    applicableTo: ['Document'],
    dependencies: [],
    clearedBy: [],
    presets: ['post'],
  },
  {
    xmlName: 'InteractivePosting',
    applicableTo: ['Document'],
    dependencies: [],
    clearedBy: [],
    presets: ['post'],
  },
  {
    xmlName: 'InteractivePostingRegular',
    applicableTo: ['Document'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'InteractiveUndoPosting',
    applicableTo: ['Document'],
    dependencies: [],
    clearedBy: [],
    presets: ['post'],
  },
  {
    xmlName: 'InteractiveChangeOfPosted',
    applicableTo: ['Document'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'TotalsControl',
    applicableTo: ['InformationRegister', 'AccumulationRegister', 'AccountingRegister'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'Start',
    applicableTo: ['BusinessProcess'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'InteractiveActivate',
    applicableTo: ['BusinessProcess', 'Task'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'InteractiveStart',
    applicableTo: ['BusinessProcess'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'Execute',
    applicableTo: ['Task'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'InteractiveExecute',
    applicableTo: ['Task'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'Use',
    applicableTo: [
      'DataProcessor',
      'Report',
      'WebService',
      'HTTPService',
      'IntegrationService',
      'ExternalDataSource',
    ],
    dependencies: [],
    clearedBy: [],
    presets: ['view'],
  },
  {
    xmlName: 'Get',
    applicableTo: ['SessionParameter'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'Set',
    applicableTo: ['SessionParameter'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'StandardAuthenticationChange',
    applicableTo: ['ExternalDataSource'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'SessionStandardAuthenticationChange',
    applicableTo: ['ExternalDataSource'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
  {
    xmlName: 'SessionOSAuthenticationChange',
    applicableTo: ['ExternalDataSource'],
    dependencies: [],
    clearedBy: [],
    presets: [],
  },
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
