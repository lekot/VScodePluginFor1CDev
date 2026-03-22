/**
 * Represents a node in the metadata tree.
 *
 * Subsystem hierarchy (ADR 0001):
 * - For Subsystem nodes, id is path-based and unique: root = `Subsystems.${name}`,
 *   child = `${parent.id}.${name}`. The type node "Subsystems" has in children only root subsystems.
 * - Optional properties.parentSubsystemRef (string or ref) holds the parent reference from source
 *   (MDO/XML); used when building the tree; absence or empty = root subsystem.
 */
export interface TreeNode {
  id: string;
  name: string;
  type: MetadataType;
  parent?: TreeNode;
  children?: TreeNode[];
  properties: Record<string, unknown>;
  filePath?: string;
  parentFilePath?: string; // Path to parent XML file for nested elements (Attributes, etc.)
  isExpanded?: boolean;
}

/**
 * Types of 1C metadata elements
 */
/* eslint-disable @typescript-eslint/naming-convention -- 1C metadata names must match platform object names */
export enum MetadataType {
  // Root
  Configuration = 'Configuration',

  // Main types
  Catalog = 'Catalog',
  Document = 'Document',
  Enum = 'Enum',
  Report = 'Report',
  DataProcessor = 'DataProcessor',
  ChartOfCharacteristicTypes = 'ChartOfCharacteristicTypes',
  ChartOfAccounts = 'ChartOfAccounts',
  ChartOfCalculationTypes = 'ChartOfCalculationTypes',
  InformationRegister = 'InformationRegister',
  AccumulationRegister = 'AccumulationRegister',
  AccountingRegister = 'AccountingRegister',
  CalculationRegister = 'CalculationRegister',
  BusinessProcess = 'BusinessProcess',
  Task = 'Task',
  ExternalDataSource = 'ExternalDataSource',
  Constant = 'Constant',
  SessionParameter = 'SessionParameter',
  FilterCriterion = 'FilterCriterion',
  ScheduledJob = 'ScheduledJob',
  FunctionalOption = 'FunctionalOption',
  FunctionalOptionsParameter = 'FunctionalOptionsParameter',
  SettingsStorage = 'SettingsStorage',
  EventSubscription = 'EventSubscription',
  CommonModule = 'CommonModule',
  CommandGroup = 'CommandGroup',
  Command = 'Command',
  Role = 'Role',
  Interface = 'Interface',
  Style = 'Style',
  WebService = 'WebService',
  HTTPService = 'HTTPService',
  IntegrationService = 'IntegrationService',
  Subsystem = 'Subsystem',

  /** Планы обмена, журналы, определяемые типы и общие объекты (корневые каталоги §1.1 спеки). */
  ExchangePlan = 'ExchangePlan',
  DocumentJournal = 'DocumentJournal',
  DefinedType = 'DefinedType',
  CommonAttribute = 'CommonAttribute',
  CommonCommand = 'CommonCommand',
  CommonForm = 'CommonForm',
  CommonPicture = 'CommonPicture',
  CommonTemplate = 'CommonTemplate',
  DocumentNumerator = 'DocumentNumerator',
  Language = 'Language',
  WSReference = 'WSReference',
  XDTOPackage = 'XDTOPackage',
  StyleItem = 'StyleItem',

  // Sub-elements
  Attribute = 'Attribute',
  TabularSection = 'TabularSection',
  Form = 'Form',
  Template = 'Template',
  CommandSubElement = 'CommandSubElement',
  Recurrence = 'Recurrence',
  Method = 'Method',
  Parameter = 'Parameter',

  // Extensions
  Extension = 'Extension',

  // Unknown
  Unknown = 'Unknown',
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
