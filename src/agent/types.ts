// src/agent/types.ts
// Agent API — публичные типы для команд агента. Без зависимостей от vscode.

import type {
    ExternalProcessorExecutionContext,
    ExternalProcessorOperationResult,
} from '../services/externalProcessor/externalProcessorTypes';
import type {
    RepositoryBinding,
    RepositoryObservedState,
    RepositoryServiceResult,
    RepositoryTarget,
} from '../services/configurationRepository/types';
import type { MetadataObjectPathSegment } from '../types/metadataObjectPath';

export interface MutationResultData {
    filePath?: string;
    dryRun?: boolean;
    rev?: string;
    currentRev?: string;
    target?: string;
    plannedChanges?: import('./agentRevision').MutationPlannedChanges;
}

export interface CreateObjectResult extends MutationResultData {
    filePath: string;
}

export interface AgentResult<T = void> {
    success: boolean;
    data?: T;
    error?: string;
    code?: string;
    configurationId?: string;
    operationId?: string;
    snapshotVersion?: number;
    dryRun?: boolean;
    rev?: string;
    currentRev?: string;
    target?: string;
    plannedChanges?: import('./agentRevision').MutationPlannedChanges;
}

export type AgentExternalProcessorContext = ExternalProcessorExecutionContext;

export interface AgentDumpExternalProcessorParams {
    srcPath: string;
    outDir?: string;
    format: 'Plain' | 'Hierarchical';
    context: AgentExternalProcessorContext;
    timeoutMs?: number;
    /** Run in the background and return an Agent task receipt. */
    background?: boolean;
}

export interface AgentBuildExternalProcessorParams {
    rootXmlPath: string;
    dstPath?: string;
    context: AgentExternalProcessorContext;
    timeoutMs?: number;
    /** Run in the background and return an Agent task receipt. */
    background?: boolean;
}

export type ExternalProcessorAgentData = ExternalProcessorOperationResult;

export interface ConfigurationScopedParams {
    /** Exact configuration selector. Optional only for a single compatible configuration. */
    configurationId?: string;
}

export interface MutationOptions {
    /** If true, calculates planned diff and revision without writing to disk. */
    dryRun?: boolean;
    /** Expected target revision (SHA-256). If current revision on disk mismatches, returns CONCURRENT_MODIFICATION_ERROR. */
    ifRev?: string;
}

export interface MutationScopedParams extends ConfigurationScopedParams, MutationOptions {}

export interface AgentTaskIdParams {
    taskId: string;
}

export interface AgentRepositoryConfigurationParams {
    /** Exact configuration identity; repository commands never use the active tree selection. */
    configurationId: string;
    background?: boolean;
}

export interface AgentRepositoryConnectParams extends AgentRepositoryConfigurationParams {
  /** ID of the file infobase in the CDT catalog used for Designer repository commands. */
  executionInfobaseId: string;
    repositoryPath: string;
    repositoryUser: string;
    repositoryPassword?: string;
}

export interface AgentRepositoryDisconnectParams extends AgentRepositoryConfigurationParams {
    force?: boolean;
}

export interface AgentRepositoryObjectParams extends AgentRepositoryConfigurationParams {
    /** Root object dot path, for example `Catalog.Goods`. */
    path: string;
}

export interface AgentRepositoryLockParams extends AgentRepositoryObjectParams {
    recursive?: boolean;
    revised?: boolean;
}

export interface AgentRepositoryUnlockParams extends AgentRepositoryObjectParams {
    recursive?: boolean;
    force?: boolean;
}

export interface AgentRepositoryCommitParams extends AgentRepositoryObjectParams {
    comment: string;
    recursive?: boolean;
    keepLocked?: boolean;
    force?: boolean;
}

export interface AgentRepositoryUpdateObjectParams extends AgentRepositoryObjectParams {
    recursive?: boolean;
    force?: boolean;
}

export interface AgentRepositoryUpdateConfigurationParams extends AgentRepositoryConfigurationParams {
    force?: boolean;
}

export interface AgentRepositoryStatusData {
    readonly live: false;
    readonly target: RepositoryTarget;
    readonly binding?: RepositoryBinding;
    readonly observedState: RepositoryObservedState;
}

export type AgentRepositoryOperationData = RepositoryServiceResult;

export interface AgentSetRoleRightsParams extends MutationScopedParams {
    roleName: string;
    /** Entries in the role-rights DSL, for example `Catalog.Goods: @edit`. */
    objects: string[];
}

export interface AgentSetRoleRightsResult {
    roleName: string;
    objectsAffected: number;
    files: string[];
}

/** Exact configuration selector for support operations. */
export interface AgentSupportConfigurationParams {
    configurationId: string;
}

export interface AgentSupportGetStatusParams extends AgentSupportConfigurationParams {
    objectIds?: string[];
}

export interface AgentSupportSetObjectModeParams extends AgentSupportConfigurationParams {
    objectId: string;
    targetMode: 'notEditable' | 'editableWithSupport' | 'removedFromSupport';
    expectedGenerationId: string;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

export interface AgentSupportEnableObjectRulesParams extends AgentSupportConfigurationParams {
    targetObjectId: string;
    targetMode: 'editableWithSupport' | 'removedFromSupport';
    expectedGenerationId: string;
    expectedMetadataUniverseGenerationId: string;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

export type AgentSupportTargetSelection =
    | { kind: 'all' }
    | {
        kind: 'retryable';
        include: Array<'failed' | 'inDoubt' | 'targetDrift'>;
    }
    | { kind: 'ids'; targetIds: string[] };

export interface AgentSupportSyncParams extends AgentSupportConfigurationParams {
    targets: AgentSupportTargetSelection;
    verification?: 'fast' | 'strict';
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

export interface AgentSupportVerifyParams extends AgentSupportConfigurationParams {
    targets: AgentSupportTargetSelection;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

export type AgentSupportGetLastRunParams = AgentSupportConfigurationParams;

export interface CreateObjectParams extends MutationScopedParams {
    /** Тип объекта: 'Catalog', 'Document', 'Enum', 'CommonModule', 'Subsystem' */
    type: string;
    name: string;
    synonym?: string;
    properties?: Record<string, unknown>;
}

export interface GetYamlParams extends ConfigurationScopedParams {
    /** Путь вида 'Catalog.Товары' */
    path: string;
}

export interface ListObjectsParams extends ConfigurationScopedParams {
    /** Если не задан — все типы */
    type?: string;
    /** Case-insensitive substring search by object name. */
    query?: string;
}

export interface ListChildrenParams extends ConfigurationScopedParams {
    /** Root or nested metadata path whose named inline children should be listed. */
    path: string;
}

export interface MetadataChildInfo {
    type: string;
    name: string;
    path: string;
}

export interface ObjectInfo {
    type: string;
    name: string;
    filePath: string;
    /** Present only when the selected configuration is a CFE project. */
    ownership?: 'own' | 'adopted';
    /** UUID of the linked base object; present for adopted CFE objects only. */
    sourceUuid?: string;
}

/** Read result for metadata properties, optionally enriched by CFE ownership. */
export interface GetPropertiesResult {
    properties: Record<string, unknown>;
    /** Present only when the selected configuration is a CFE project. */
    ownership?: 'own' | 'adopted';
    /** UUID of the linked base object; present for adopted CFE objects only. */
    sourceUuid?: string;
}

export interface ResolvedAgentPath {
    /** Root metadata tag, e.g. 'Catalog', 'ChartOfAccounts' */
    rootTag: string;
    /** Object name, e.g. 'Товары' */
    objectName: string;
    /** Absolute path to the object XML file */
    filePath: string;
    /** Exact root-to-leaf selector for root and nested metadata elements. */
    nestedPath?: MetadataObjectPathSegment[];
    /** Root tag of the XML document when it differs from the public root object (e.g. ExternalDataSource.Table). */
    fileRootType?: string;
    /** Selector relative to the selected XML file; `nestedPath` remains the complete public Agent API path. */
    fileNestedPath?: MetadataObjectPathSegment[];
    /** For 4-segment and 6-segment paths: the nested element type, e.g. 'Attribute' */
    nestedType?: string;
    /** For 4-segment and 6-segment paths: the nested element name */
    nestedName?: string;
    /** For 6-segment paths: the tabular section name */
    tabularSection?: string;
}

export interface AddAttributeParams extends MutationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    name: string;
}

export interface AddTabularSectionParams extends MutationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    name: string;
}

export interface AddTabularSectionColumnParams extends MutationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары.TabularSection.Состав' */
    path: string;
    name: string;
}

export interface DeleteAttributeParams extends MutationScopedParams {
    /** Agent path to attribute, e.g. 'Catalog.Товары.Attribute.Цена' */
    path: string;
}

export interface DeleteTabularSectionParams extends MutationScopedParams {
    /** Agent path to tabular section, e.g. 'Catalog.Товары.TabularSection.Состав' */
    path: string;
}

export interface DeleteObjectParams extends MutationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
}

export interface RenameObjectParams extends MutationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    newName: string;
}

export interface GetPropertiesParams extends ConfigurationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
}

export interface SetPropertiesParams extends MutationScopedParams {
    /** Agent path, e.g. 'Catalog.Товары' */
    path: string;
    properties: Record<string, unknown>;
}

export interface GetTypeParams extends ConfigurationScopedParams {
    /** Agent path, e.g. 'DefinedType.ТипНоменклатуры' or 'Catalog.Товары.Attribute.Цена' */
    path: string;
}

export interface SetTypeParams extends MutationScopedParams {
    /** Agent path, e.g. 'DefinedType.ТипНоменклатуры' or 'Catalog.Товары.Attribute.Цена' */
    path: string;
    /** Array of type strings, e.g. ['xs:string', 'cfg:CatalogRef.Товары'] */
    types: string[];
}

export interface GetTypeResult {
    /** Array of type strings, e.g. ['xs:string', 'cfg:CatalogRef.Товары'] */
    types: string[];
    /** Raw XML of the Type element */
    rawXml: string;
}

export interface GetSourceParams extends ConfigurationScopedParams {
    /** Root EventSubscription path, for example 'EventSubscription.ПодпискаНаСобытие'. */
    path: string;
}

export interface SetSourceParams extends MutationScopedParams {
    /** Root EventSubscription path, for example 'EventSubscription.ПодпискаНаСобытие'. */
    path: string;
    /** Complete replacement list of cfg:ObjectKind[.Name] types; an empty array clears Source. */
    types: string[];
}

export interface GetSourceResult {
    /** Parsed Source entries in canonical cfg:ObjectKind[.Name] form. */
    types: string[];
    /** XML fragment for the Source property. */
    rawXml: string;
}

export interface CotPathParams extends ConfigurationScopedParams {
    /** Agent path: 'ChartOfCharacteristicTypes.Name' or plain 'Name' */
    path: string;
}

export interface PredefinedCotPathParams extends ConfigurationScopedParams {
    /** Agent path: 'ChartOfCharacteristicTypes.Name' or plain 'Name' */
    path: string;
    predefinedName: string;
}

export interface SetPredefinedCotTypeParams extends MutationScopedParams {
    /** Agent path: 'ChartOfCharacteristicTypes.Name' or plain 'Name' */
    path: string;
    predefinedName: string;
    types: string[];
}
