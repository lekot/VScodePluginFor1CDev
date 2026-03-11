"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetadataTypeMapper = void 0;
const treeNode_1 = require("../models/treeNode");
/**
 * Utility class for mapping metadata type strings to MetadataType enum
 * Centralizes the type mapping logic used by both Designer and EDT parsers
 */
class MetadataTypeMapper {
    /**
     * Map string type to MetadataType enum
     * @param typeString Type string from directory name
     * @returns MetadataType enum value
     */
    static map(typeString) {
        return this.TYPE_MAP[typeString] || treeNode_1.MetadataType.Unknown;
    }
    /**
     * Get list of all metadata type directory names
     * @returns Array of metadata type names
     */
    static getMetadataTypes() {
        return Object.keys(this.TYPE_MAP);
    }
    /**
     * Check if type string is valid metadata type
     * @param typeString Type string to check
     * @returns true if valid
     */
    static isValidType(typeString) {
        return typeString in this.TYPE_MAP;
    }
}
exports.MetadataTypeMapper = MetadataTypeMapper;
MetadataTypeMapper.TYPE_MAP = {
    Catalogs: treeNode_1.MetadataType.Catalog,
    Documents: treeNode_1.MetadataType.Document,
    Enums: treeNode_1.MetadataType.Enum,
    Reports: treeNode_1.MetadataType.Report,
    DataProcessors: treeNode_1.MetadataType.DataProcessor,
    ChartsOfCharacteristicTypes: treeNode_1.MetadataType.ChartOfCharacteristicTypes,
    ChartsOfAccounts: treeNode_1.MetadataType.ChartOfAccounts,
    ChartsOfCalculationTypes: treeNode_1.MetadataType.ChartOfCalculationTypes,
    InformationRegisters: treeNode_1.MetadataType.InformationRegister,
    AccumulationRegisters: treeNode_1.MetadataType.AccumulationRegister,
    AccountingRegisters: treeNode_1.MetadataType.AccountingRegister,
    CalculationRegisters: treeNode_1.MetadataType.CalculationRegister,
    BusinessProcesses: treeNode_1.MetadataType.BusinessProcess,
    Tasks: treeNode_1.MetadataType.Task,
    ExternalDataSources: treeNode_1.MetadataType.ExternalDataSource,
    Constants: treeNode_1.MetadataType.Constant,
    SessionParameters: treeNode_1.MetadataType.SessionParameter,
    FilterCriteria: treeNode_1.MetadataType.FilterCriterion,
    ScheduledJobs: treeNode_1.MetadataType.ScheduledJob,
    FunctionalOptions: treeNode_1.MetadataType.FunctionalOption,
    FunctionalOptionsParameters: treeNode_1.MetadataType.FunctionalOptionsParameter,
    SettingsStorages: treeNode_1.MetadataType.SettingsStorage,
    EventSubscriptions: treeNode_1.MetadataType.EventSubscription,
    CommonModules: treeNode_1.MetadataType.CommonModule,
    CommandGroups: treeNode_1.MetadataType.CommandGroup,
    Roles: treeNode_1.MetadataType.Role,
    Interfaces: treeNode_1.MetadataType.Interface,
    Styles: treeNode_1.MetadataType.Style,
    WebServices: treeNode_1.MetadataType.WebService,
    HTTPServices: treeNode_1.MetadataType.HTTPService,
    IntegrationServices: treeNode_1.MetadataType.IntegrationService,
    Subsystems: treeNode_1.MetadataType.Subsystem,
    Languages: treeNode_1.MetadataType.Unknown,
    CommonPictures: treeNode_1.MetadataType.Unknown,
};
//# sourceMappingURL=metadataTypeMapper.js.map