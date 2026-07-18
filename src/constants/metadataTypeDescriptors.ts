import { MetadataType } from '../models/treeNode';

export type MetadataModuleCapability = 'debug-path';
export type MetadataUiCapability = 'metadata-tree';

/**
 * Stable cross-format identity for a root metadata type.
 *
 * Consumers derive their lookup maps from this registry instead of keeping
 * independent folder, root-tag and EDT file-name tables in sync.
 */
export interface MetadataTypeDescriptor {
  readonly type: MetadataType;
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
}

function descriptor(
  designerFolder: string,
  type: MetadataType,
  designerRootTag: string,
  options: DescriptorOptions = {}
): MetadataTypeDescriptor {
  return Object.freeze({
    type,
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
  descriptor('Catalogs', MetadataType.Catalog, 'Catalog', { referenceKind: 'CatalogRef', debugPath: true }),
  descriptor('Documents', MetadataType.Document, 'Document', { referenceKind: 'DocumentRef', debugPath: true }),
  descriptor('Enums', MetadataType.Enum, 'Enum', { referenceKind: 'EnumRef', debugPath: true }),
  descriptor('Reports', MetadataType.Report, 'Report', { debugPath: true }),
  descriptor('DataProcessors', MetadataType.DataProcessor, 'DataProcessor', { debugPath: true }),
  descriptor('ChartsOfCharacteristicTypes', MetadataType.ChartOfCharacteristicTypes, 'ChartOfCharacteristicTypes', { referenceKind: 'ChartOfCharacteristicTypesRef', debugPath: true }),
  descriptor('ChartsOfAccounts', MetadataType.ChartOfAccounts, 'ChartOfAccounts', { referenceKind: 'ChartOfAccountsRef', debugPath: true }),
  descriptor('ChartsOfCalculationTypes', MetadataType.ChartOfCalculationTypes, 'ChartOfCalculationTypes', { referenceKind: 'ChartOfCalculationTypesRef', debugPath: true }),
  descriptor('InformationRegisters', MetadataType.InformationRegister, 'InformationRegister', { debugPath: true }),
  descriptor('AccumulationRegisters', MetadataType.AccumulationRegister, 'AccumulationRegister', { debugPath: true }),
  descriptor('AccountingRegisters', MetadataType.AccountingRegister, 'AccountingRegister', { debugPath: true }),
  descriptor('CalculationRegisters', MetadataType.CalculationRegister, 'CalculationRegister', { debugPath: true }),
  descriptor('BusinessProcesses', MetadataType.BusinessProcess, 'BusinessProcess', { debugPath: true }),
  descriptor('Tasks', MetadataType.Task, 'Task', { debugPath: true }),
  descriptor('ExternalDataSources', MetadataType.ExternalDataSource, 'ExternalDataSource'),
  descriptor('Sequences', MetadataType.Sequence, 'Sequence', { debugPath: true }),
  descriptor('Constants', MetadataType.Constant, 'Constant', { debugPath: true }),
  descriptor('SessionParameters', MetadataType.SessionParameter, 'SessionParameter'),
  descriptor('FilterCriteria', MetadataType.FilterCriterion, 'FilterCriterion', { debugPath: true, rootTagAliases: ['FilterCriteria'] }),
  descriptor('ScheduledJobs', MetadataType.ScheduledJob, 'ScheduledJob', { debugPath: true }),
  descriptor('FunctionalOptions', MetadataType.FunctionalOption, 'FunctionalOption', { debugPath: true }),
  descriptor('FunctionalOptionsParameters', MetadataType.FunctionalOptionsParameter, 'FunctionalOptionsParameter'),
  descriptor('SettingsStorages', MetadataType.SettingsStorage, 'SettingsStorage', { debugPath: true }),
  descriptor('EventSubscriptions', MetadataType.EventSubscription, 'EventSubscription'),
  descriptor('CommonModules', MetadataType.CommonModule, 'CommonModule', { debugPath: true }),
  descriptor('CommandGroups', MetadataType.CommandGroup, 'CommandGroup'),
  descriptor('Roles', MetadataType.Role, 'Role'),
  descriptor('Interfaces', MetadataType.Interface, 'Interface'),
  descriptor('Styles', MetadataType.Style, 'Style'),
  descriptor('WebServices', MetadataType.WebService, 'WebService', { debugPath: true }),
  descriptor('HTTPServices', MetadataType.HTTPService, 'HTTPService', { debugPath: true }),
  descriptor('IntegrationServices', MetadataType.IntegrationService, 'IntegrationService', { debugPath: true }),
  descriptor('Subsystems', MetadataType.Subsystem, 'Subsystem'),
  descriptor('ExchangePlans', MetadataType.ExchangePlan, 'ExchangePlan', { debugPath: true }),
  descriptor('DocumentJournals', MetadataType.DocumentJournal, 'DocumentJournal', { debugPath: true }),
  descriptor('DefinedTypes', MetadataType.DefinedType, 'DefinedType'),
  descriptor('CommonAttributes', MetadataType.CommonAttribute, 'CommonAttribute'),
  descriptor('CommonCommands', MetadataType.CommonCommand, 'CommonCommand'),
  descriptor('CommonForms', MetadataType.CommonForm, 'CommonForm'),
  descriptor('CommonPictures', MetadataType.CommonPicture, 'CommonPicture'),
  descriptor('CommonTemplates', MetadataType.CommonTemplate, 'CommonTemplate'),
  descriptor('DocumentNumerators', MetadataType.DocumentNumerator, 'DocumentNumerator'),
  descriptor('Languages', MetadataType.Language, 'Language'),
  descriptor('WSReferences', MetadataType.WSReference, 'WSReference'),
  descriptor('XDTOPackages', MetadataType.XDTOPackage, 'XDTOPackage'),
  descriptor('StyleItems', MetadataType.StyleItem, 'StyleItem'),
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

export function getMetadataTypeDescriptorByRootTag(rootTag: string): MetadataTypeDescriptor | undefined {
  return BY_ROOT_TAG.get(rootTag);
}
