/**
 * Represents a node in the metadata tree
 */
export interface TreeNode {
    id: string;
    name: string;
    type: MetadataType;
    parent?: TreeNode;
    children?: TreeNode[];
    properties: Record<string, unknown>;
    filePath?: string;
    isExpanded?: boolean;
}
/**
 * Types of 1C metadata elements
 */
/* eslint-disable @typescript-eslint/naming-convention -- 1C metadata names must match platform object names */
export declare enum MetadataType {
    Configuration = "Configuration",
    Catalog = "Catalog",
    Document = "Document",
    Enum = "Enum",
    Report = "Report",
    DataProcessor = "DataProcessor",
    ChartOfCharacteristicTypes = "ChartOfCharacteristicTypes",
    ChartOfAccounts = "ChartOfAccounts",
    ChartOfCalculationTypes = "ChartOfCalculationTypes",
    InformationRegister = "InformationRegister",
    AccumulationRegister = "AccumulationRegister",
    AccountingRegister = "AccountingRegister",
    CalculationRegister = "CalculationRegister",
    BusinessProcess = "BusinessProcess",
    Task = "Task",
    ExternalDataSource = "ExternalDataSource",
    Constant = "Constant",
    SessionParameter = "SessionParameter",
    FilterCriterion = "FilterCriterion",
    ScheduledJob = "ScheduledJob",
    FunctionalOption = "FunctionalOption",
    FunctionalOptionsParameter = "FunctionalOptionsParameter",
    SettingsStorage = "SettingsStorage",
    EventSubscription = "EventSubscription",
    CommonModule = "CommonModule",
    CommandGroup = "CommandGroup",
    Command = "Command",
    Role = "Role",
    Interface = "Interface",
    Style = "Style",
    WebService = "WebService",
    HTTPService = "HTTPService",
    IntegrationService = "IntegrationService",
    Subsystem = "Subsystem",
    ExchangePlan = "ExchangePlan",
    DocumentJournal = "DocumentJournal",
    DefinedType = "DefinedType",
    CommonAttribute = "CommonAttribute",
    CommonCommand = "CommonCommand",
    CommonForm = "CommonForm",
    CommonPicture = "CommonPicture",
    CommonTemplate = "CommonTemplate",
    DocumentNumerator = "DocumentNumerator",
    Language = "Language",
    WSReference = "WSReference",
    XDTOPackage = "XDTOPackage",
    StyleItem = "StyleItem",
    Attribute = "Attribute",
    TabularSection = "TabularSection",
    Form = "Form",
    Template = "Template",
    CommandSubElement = "CommandSubElement",
    Recurrence = "Recurrence",
    Method = "Method",
    Parameter = "Parameter",
    Extension = "Extension",
    Unknown = "Unknown"
}
/* eslint-enable @typescript-eslint/naming-convention */
/**
 * Metadata element properties
 */
export interface MetadataProperties {
    name: string;
    synonym?: string;
    comment?: string;
    [key: string]: unknown;
}
//# sourceMappingURL=treeNode.d.ts.map