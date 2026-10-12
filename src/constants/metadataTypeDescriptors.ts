import { MetadataType } from '../models/treeNode';

export type MetadataModuleCapability = 'debug-path';
export type MetadataUiCapability = 'metadata-tree';
export type MetadataCrudOperation = 'create' | 'rename' | 'duplicate' | 'delete';
export type MetadataGenericRootChildObjectKind = 'Attribute' | 'TabularSection';

export type MetadataCrudCapability =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

export type MetadataCrudCapabilities = Readonly<Record<MetadataCrudOperation, MetadataCrudCapability>>;

/**
 * Stable cross-format identity for a root metadata type.
 *
 * Consumers derive their lookup maps from this registry instead of keeping
 * independent folder, root-tag and EDT file-name tables in sync.
 */
export interface MetadataTypeDescriptor {
  readonly type: MetadataType;
  readonly structure: {
    /** Every descriptor in this registry has its own Designer root XML file. */
    readonly designerRootObject: true;
    /** Whether this Designer root XML uses a top-level <ChildObjects> section. */
    readonly hasChildObjects: boolean;
  };
  /** Generic root child tags admitted by elementOperations; independent of ChildObjects structure. */
  readonly genericRootChildObjectKinds: readonly MetadataGenericRootChildObjectKind[];
  readonly crud: MetadataCrudCapabilities;
  readonly designerFolder: string;
  readonly designerRootTag: string;
  readonly designerRootTagAliases?: readonly string[];
  readonly edtFolder: string;
  readonly edtFileName: string;
  readonly referenceKind?: string;
  readonly moduleCapabilities: readonly MetadataModuleCapability[];
  readonly uiCapabilities: readonly MetadataUiCapability[];
}

interface DescriptorOptions {
  readonly referenceKind?: string;
  readonly debugPath?: boolean;
  readonly rootTagAliases?: readonly string[];
  readonly genericRootChildObjectKinds?: readonly MetadataGenericRootChildObjectKind[];
}

const SUPPORTED_ROOT_CRUD: MetadataCrudCapabilities = Object.freeze({
  create: Object.freeze({ supported: true }),
  rename: Object.freeze({ supported: true }),
  duplicate: Object.freeze({ supported: true }),
  delete: Object.freeze({ supported: true }),
});

function descriptor(
  designerFolder: string,
  type: MetadataType,
  designerRootTag: string,
  crud: MetadataCrudCapabilities,
  hasChildObjects: boolean,
  options: DescriptorOptions = {}
): MetadataTypeDescriptor {
  const genericRootChildObjectKinds = Object.freeze([...(options.genericRootChildObjectKinds ?? [])]);
  return Object.freeze({
    type,
    structure: Object.freeze({ designerRootObject: true as const, hasChildObjects }),
    genericRootChildObjectKinds,
    crud,
    designerFolder,
    designerRootTag,
    designerRootTagAliases: options.rootTagAliases,
    edtFolder: designerFolder,
    edtFileName: `${designerRootTag}.mdo`,
    referenceKind: options.referenceKind,
    moduleCapabilities: options.debugPath ? (['debug-path'] as const) : [],
    uiCapabilities: ['metadata-tree'] as const,
  });
}

export const METADATA_TYPE_DESCRIPTORS: readonly MetadataTypeDescriptor[] = Object.freeze([
  descriptor('Catalogs', MetadataType.Catalog, 'Catalog', SUPPORTED_ROOT_CRUD, true, {
    referenceKind: 'CatalogRef', debugPath: true, genericRootChildObjectKinds: ['Attribute', 'TabularSection'],
  }),
  descriptor('Documents', MetadataType.Document, 'Document', SUPPORTED_ROOT_CRUD, true, {
    referenceKind: 'DocumentRef', debugPath: true, genericRootChildObjectKinds: ['Attribute', 'TabularSection'],
  }),
  descriptor('Enums', MetadataType.Enum, 'Enum', SUPPORTED_ROOT_CRUD, true, { referenceKind: 'EnumRef', debugPath: true }),
  descriptor('Reports', MetadataType.Report, 'Report', SUPPORTED_ROOT_CRUD, true, {
    debugPath: true, genericRootChildObjectKinds: ['Attribute', 'TabularSection'],
  }),
  descriptor('DataProcessors', MetadataType.DataProcessor, 'DataProcessor', SUPPORTED_ROOT_CRUD, true, {
    debugPath: true, genericRootChildObjectKinds: ['Attribute', 'TabularSection'],
  }),
  descriptor('ChartsOfCharacteristicTypes', MetadataType.ChartOfCharacteristicTypes, 'ChartOfCharacteristicTypes', SUPPORTED_ROOT_CRUD, true, {
    referenceKind: 'ChartOfCharacteristicTypesRef', debugPath: true,
    genericRootChildObjectKinds: ['Attribute', 'TabularSection'],
  }),
  descriptor('ChartsOfAccounts', MetadataType.ChartOfAccounts, 'ChartOfAccounts', SUPPORTED_ROOT_CRUD, true, {
    referenceKind: 'ChartOfAccountsRef', debugPath: true,
    genericRootChildObjectKinds: ['Attribute', 'TabularSection'],
  }),
  descriptor('ChartsOfCalculationTypes', MetadataType.ChartOfCalculationTypes, 'ChartOfCalculationTypes', SUPPORTED_ROOT_CRUD, true, {
    referenceKind: 'ChartOfCalculationTypesRef', debugPath: true,
    genericRootChildObjectKinds: ['Attribute', 'TabularSection'],
  }),
  descriptor('InformationRegisters', MetadataType.InformationRegister, 'InformationRegister', SUPPORTED_ROOT_CRUD, true, {
    debugPath: true, genericRootChildObjectKinds: ['Attribute'],
  }),
  descriptor('AccumulationRegisters', MetadataType.AccumulationRegister, 'AccumulationRegister', SUPPORTED_ROOT_CRUD, true, {
    debugPath: true, genericRootChildObjectKinds: ['Attribute'],
  }),
  descriptor('AccountingRegisters', MetadataType.AccountingRegister, 'AccountingRegister', SUPPORTED_ROOT_CRUD, true, {
    debugPath: true, genericRootChildObjectKinds: ['Attribute'],
  }),
  descriptor('CalculationRegisters', MetadataType.CalculationRegister, 'CalculationRegister', SUPPORTED_ROOT_CRUD, true, {
    debugPath: true, genericRootChildObjectKinds: ['Attribute'],
  }),
  descriptor('BusinessProcesses', MetadataType.BusinessProcess, 'BusinessProcess', SUPPORTED_ROOT_CRUD, true, {
    debugPath: true, genericRootChildObjectKinds: ['Attribute', 'TabularSection'],
  }),
  descriptor('Tasks', MetadataType.Task, 'Task', SUPPORTED_ROOT_CRUD, true, {
    debugPath: true, genericRootChildObjectKinds: ['Attribute', 'TabularSection'],
  }),
  descriptor('ExternalDataSources', MetadataType.ExternalDataSource, 'ExternalDataSource', SUPPORTED_ROOT_CRUD, true),
  descriptor('Sequences', MetadataType.Sequence, 'Sequence', SUPPORTED_ROOT_CRUD, true, { debugPath: true }),
  descriptor('Constants', MetadataType.Constant, 'Constant', SUPPORTED_ROOT_CRUD, false, { debugPath: true }),
  descriptor('SessionParameters', MetadataType.SessionParameter, 'SessionParameter', SUPPORTED_ROOT_CRUD, false),
  descriptor('FilterCriteria', MetadataType.FilterCriterion, 'FilterCriterion', SUPPORTED_ROOT_CRUD, true, { debugPath: true, rootTagAliases: ['FilterCriteria'] }),
  descriptor('ScheduledJobs', MetadataType.ScheduledJob, 'ScheduledJob', SUPPORTED_ROOT_CRUD, false, { debugPath: true }),
  descriptor('FunctionalOptions', MetadataType.FunctionalOption, 'FunctionalOption', SUPPORTED_ROOT_CRUD, false, { debugPath: true }),
  descriptor('FunctionalOptionsParameters', MetadataType.FunctionalOptionsParameter, 'FunctionalOptionsParameter', SUPPORTED_ROOT_CRUD, false),
  descriptor('SettingsStorages', MetadataType.SettingsStorage, 'SettingsStorage', SUPPORTED_ROOT_CRUD, true, { debugPath: true }),
  descriptor('EventSubscriptions', MetadataType.EventSubscription, 'EventSubscription', SUPPORTED_ROOT_CRUD, false),
  descriptor('CommonModules', MetadataType.CommonModule, 'CommonModule', SUPPORTED_ROOT_CRUD, false, { debugPath: true }),
  descriptor('CommandGroups', MetadataType.CommandGroup, 'CommandGroup', SUPPORTED_ROOT_CRUD, false),
  descriptor('Roles', MetadataType.Role, 'Role', SUPPORTED_ROOT_CRUD, false),
  descriptor('Interfaces', MetadataType.Interface, 'Interface', SUPPORTED_ROOT_CRUD, false),
  descriptor('Styles', MetadataType.Style, 'Style', SUPPORTED_ROOT_CRUD, false),
  descriptor('WebServices', MetadataType.WebService, 'WebService', SUPPORTED_ROOT_CRUD, true, { debugPath: true }),
  descriptor('HTTPServices', MetadataType.HTTPService, 'HTTPService', SUPPORTED_ROOT_CRUD, true, { debugPath: true }),
  descriptor('IntegrationServices', MetadataType.IntegrationService, 'IntegrationService', SUPPORTED_ROOT_CRUD, true, { debugPath: true }),
  descriptor('Subsystems', MetadataType.Subsystem, 'Subsystem', SUPPORTED_ROOT_CRUD, true, {
    genericRootChildObjectKinds: [],
  }),
  descriptor('ExchangePlans', MetadataType.ExchangePlan, 'ExchangePlan', SUPPORTED_ROOT_CRUD, true, {
    debugPath: true, genericRootChildObjectKinds: ['Attribute', 'TabularSection'],
  }),
  descriptor('DocumentJournals', MetadataType.DocumentJournal, 'DocumentJournal', SUPPORTED_ROOT_CRUD, true, { debugPath: true }),
  descriptor('DefinedTypes', MetadataType.DefinedType, 'DefinedType', SUPPORTED_ROOT_CRUD, false),
  descriptor('CommonAttributes', MetadataType.CommonAttribute, 'CommonAttribute', SUPPORTED_ROOT_CRUD, false),
  descriptor('CommonCommands', MetadataType.CommonCommand, 'CommonCommand', SUPPORTED_ROOT_CRUD, false),
  descriptor('CommonForms', MetadataType.CommonForm, 'CommonForm', SUPPORTED_ROOT_CRUD, false),
  descriptor('CommonPictures', MetadataType.CommonPicture, 'CommonPicture', SUPPORTED_ROOT_CRUD, false),
  descriptor('CommonTemplates', MetadataType.CommonTemplate, 'CommonTemplate', SUPPORTED_ROOT_CRUD, false),
  descriptor('DocumentNumerators', MetadataType.DocumentNumerator, 'DocumentNumerator', SUPPORTED_ROOT_CRUD, false),
  descriptor('Languages', MetadataType.Language, 'Language', SUPPORTED_ROOT_CRUD, false),
  descriptor('WSReferences', MetadataType.WSReference, 'WSReference', SUPPORTED_ROOT_CRUD, false),
  descriptor('XDTOPackages', MetadataType.XDTOPackage, 'XDTOPackage', SUPPORTED_ROOT_CRUD, false),
  descriptor('StyleItems', MetadataType.StyleItem, 'StyleItem', SUPPORTED_ROOT_CRUD, false),
]);

const BY_FOLDER = new Map(METADATA_TYPE_DESCRIPTORS.map((item) => [item.designerFolder, item]));
const BY_TYPE = new Map(METADATA_TYPE_DESCRIPTORS.map((item) => [item.type, item]));
const BY_ROOT_TAG = new Map<string, MetadataTypeDescriptor>();
for (const item of METADATA_TYPE_DESCRIPTORS) {
  BY_ROOT_TAG.set(item.designerRootTag, item);
  for (const alias of item.designerRootTagAliases ?? []) {
    BY_ROOT_TAG.set(alias, item);
  }
}

export function getMetadataTypeDescriptorByFolder(folder: string): MetadataTypeDescriptor | undefined {
  return BY_FOLDER.get(folder);
}

export function getMetadataTypeDescriptorByType(type: MetadataType): MetadataTypeDescriptor | undefined {
  return BY_TYPE.get(type);
}

/** Structural root identity only; callers must still check the operation's CRUD capability. */
export const DESIGNER_ROOT_OBJECT_TYPES: ReadonlySet<MetadataType> = new Set(
  METADATA_TYPE_DESCRIPTORS
    .filter((item) => item.structure.designerRootObject)
    .map((item) => item.type),
);

export function getMetadataCrudCapability(
  type: MetadataType,
  operation: MetadataCrudOperation,
): MetadataCrudCapability | undefined {
  return getMetadataTypeDescriptorByType(type)?.crud[operation];
}

export function supportsMetadataCrud(type: MetadataType, operation: MetadataCrudOperation): boolean {
  return getMetadataCrudCapability(type, operation)?.supported === true;
}

/** Whether the generic root-level create path may add this ChildObjects tag under a metadata type. */
export function supportsMetadataGenericRootChildObject(
  type: MetadataType,
  childKind: MetadataGenericRootChildObjectKind,
): boolean {
  return getMetadataTypeDescriptorByType(type)?.genericRootChildObjectKinds.includes(childKind) ?? false;
}

export function assertMetadataCrudSupported(type: MetadataType, operation: MetadataCrudOperation): void {
  const capability = getMetadataCrudCapability(type, operation);
  if (!capability?.supported) {
    const reason = capability && 'reason' in capability ? `: ${capability.reason}` : '';
    throw new Error(`Metadata type "${String(type)}" does not support ${operation}${reason}.`);
  }
}

export function getMetadataTypeDescriptorByRootTag(rootTag: string): MetadataTypeDescriptor | undefined {
  return BY_ROOT_TAG.get(rootTag);
}
