import { MetadataType } from '../models/treeNode';

/**
 * Utility class for mapping metadata type strings to MetadataType enum
 * Centralizes the type mapping logic used by both Designer and EDT parsers
 */
export class MetadataTypeMapper {
  private static readonly TYPE_MAP: Record<string, MetadataType> = {
    Catalogs: MetadataType.Catalog,
    Documents: MetadataType.Document,
    Enums: MetadataType.Enum,
    Reports: MetadataType.Report,
    DataProcessors: MetadataType.DataProcessor,
    ChartsOfCharacteristicTypes: MetadataType.ChartOfCharacteristicTypes,
    ChartsOfAccounts: MetadataType.ChartOfAccounts,
    ChartsOfCalculationTypes: MetadataType.ChartOfCalculationTypes,
    InformationRegisters: MetadataType.InformationRegister,
    AccumulationRegisters: MetadataType.AccumulationRegister,
    AccountingRegisters: MetadataType.AccountingRegister,
    CalculationRegisters: MetadataType.CalculationRegister,
    BusinessProcesses: MetadataType.BusinessProcess,
    Tasks: MetadataType.Task,
    ExternalDataSources: MetadataType.ExternalDataSource,
    Constants: MetadataType.Constant,
    SessionParameters: MetadataType.SessionParameter,
    FilterCriteria: MetadataType.FilterCriterion,
    ScheduledJobs: MetadataType.ScheduledJob,
    FunctionalOptions: MetadataType.FunctionalOption,
    FunctionalOptionsParameters: MetadataType.FunctionalOptionsParameter,
    SettingsStorages: MetadataType.SettingsStorage,
    EventSubscriptions: MetadataType.EventSubscription,
    CommonModules: MetadataType.CommonModule,
    CommandGroups: MetadataType.CommandGroup,
    Roles: MetadataType.Role,
    Interfaces: MetadataType.Interface,
    Styles: MetadataType.Style,
    WebServices: MetadataType.WebService,
    HTTPServices: MetadataType.HTTPService,
    IntegrationServices: MetadataType.IntegrationService,
    Subsystems: MetadataType.Subsystem,
    Languages: MetadataType.Unknown,
    CommonPictures: MetadataType.Unknown,
  };

  /**
   * Map string type to MetadataType enum
   * @param typeString Type string from directory name
   * @returns MetadataType enum value
   */
  static map(typeString: string): MetadataType {
    return this.TYPE_MAP[typeString] || MetadataType.Unknown;
  }

  /**
   * Get list of all metadata type directory names
   * @returns Array of metadata type names
   */
  static getMetadataTypes(): string[] {
    return Object.keys(this.TYPE_MAP);
  }

  /**
   * Check if type string is valid metadata type
   * @param typeString Type string to check
   * @returns true if valid
   */
  static isValidType(typeString: string): boolean {
    return typeString in this.TYPE_MAP;
  }
}
