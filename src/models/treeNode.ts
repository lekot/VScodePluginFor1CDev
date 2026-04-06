/**
 * Typed property bag for TreeNode.
 *
 * Known keys are declared explicitly for autocomplete and documentation.
 * The index signature `[key: string]: unknown` keeps backward compatibility —
 * all existing consumers compile without changes.
 */
export interface TreeNodeProperties {
  /** Synonym (human-readable name) of the metadata object. */
  synonym?: string;
  /** Comment for the metadata object. */
  comment?: string;
  /** Marks the node as lazily loaded — children not yet fetched. */
  _lazy?: boolean;
  /** UUID of the metadata object. Stored as-is from the parsed XML (may be any scalar). */
  uuid?: unknown;
  /**
   * Indicates whether the object was borrowed from a base configuration.
   * Values: `'Own'` | `'Adopted'` | `'OwnWithBorrow'`.
   */
  objectBelonging?: string;
  /** Full name of the base configuration object this extension object extends. */
  extendedConfigurationObject?: string;
  /** Extension purpose, e.g. `'Patch'` | `'Modification'` | `'Adaptation'`. */
  extensionPurpose?: string;
  /** Name prefix for extension objects. */
  namePrefix?: string;
  /** Whether the root node represents an extension configuration. */
  isExtension?: boolean;
  /** File type marker used in template/layout nodes. */
  fileType?: string;
  /**
   * Parent subsystem reference for Subsystem nodes.
   * Either a plain string (MDO path), an object `{filePath, name}`, or `null` (no parent).
   */
  parentSubsystemRef?: string | { filePath: string | undefined; name?: string } | null;
  /**
   * Raw parent subsystem value from EDT format (normalised into parentSubsystemRef).
   * Present only transiently during parsing.
   */
  ParentSubsystem?: unknown;
  /**
   * Subsystem content list (array of child object references).
   * Present on Subsystem nodes when content is loaded.
   */
  Content?: unknown;
  /** Marks a node as virtual (e.g. a virtual attribute node). */
  isVirtual?: boolean;
  /** Arbitrary extra keys — preserved for backward compatibility. */
  [key: string]: unknown;
}

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
  properties: TreeNodeProperties;
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
