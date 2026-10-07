// src/agent/agentCommands.ts
// Agent API — тонкая VS Code обёртка над AgentOperations.
// Регистрирует команды 1c-metadata-tree.agent.* для вызова через executeCommand.

import * as vscode from 'vscode';
import { AgentOperations } from './agentOperations';
import { AgentDebugOperations, AgentDebugOperationsDeps } from './agentDebugOperations';
import {
    AgentDeployOperations,
    AgentDeployOperationsDeps,
    DeployParams,
    DeploySelectedObjectsParams,
    DeployChangedFilesParams,
    PullSelectedObjectsParams as AgentPullParams,
    ExportStatusAgentParams,
} from './agentDeployOperations';
import { DebugSessionRegistry } from './debugSessionRegistry';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import type {
    CreateObjectParams,
    GetYamlParams,
    ListObjectsParams,
    ListChildrenParams,
    GetPropertiesParams,
    AddAttributeParams,
    AddTabularSectionParams,
    AddTabularSectionColumnParams,
    DeleteAttributeParams,
    DeleteTabularSectionParams,
    DeleteObjectParams,
    RenameObjectParams,
    SetPropertiesParams,
    GetTypeParams,
    SetTypeParams,
    GetSourceParams,
    SetSourceParams,
    AgentResult,
    ConfigurationScopedParams,
    AgentSupportGetStatusParams,
    AgentSupportSetObjectModeParams,
    AgentSupportEnableObjectRulesParams,
    AgentSupportSyncParams,
    AgentSupportVerifyParams,
    AgentSupportGetLastRunParams,
    AgentDumpExternalProcessorParams,
    AgentBuildExternalProcessorParams,
    AgentSetRoleRightsParams,
    ResolveSourceAddressParams,
} from './types';
import type {
    DebugStartParams,
    DebugStopParams,
    DebugSetBreakpointParams,
    DebugClearBreakpointsParams,
    DebugSetExceptionFilterParams,
    DebugWaitForStopParams,
    DebugThreadParams,
    DebugFrameParams,
    DebugGetVariablesParams,
    DebugEvaluateParams,
    DebugStartFromBindingParams,
} from './agentDebugTypes';
import { resolveBindingCommand, listBindingsCommand } from './agentBindingResolver';
import { CommandInterfaceOperations } from './commandInterfaceOperations';
import type { CommandOrderEntry, CommandVisibility } from '../types/commandInterface';
import {
    listPredefinedCharacteristics,
    getPredefinedCharacteristicType,
    setPredefinedCharacteristicType,
    getCharacteristicValueRegisters,
} from './predefinedCharacteristicOperations';
import type {
    CotPathParams,
    PredefinedCotPathParams,
    SetPredefinedCotTypeParams,
} from './types';
import { FormsOperations } from './agentFormsOperations';
import { getPlatformPathSetting } from '../services/metadataTreeSettings';
import { AgentStaticFormOperations } from './agentStaticForms';
import { AgentSyntaxHelpOperations } from './agentSyntaxHelp';
import type {
  FormsDiscoverParams,
  FormsLaunchParams,
  FormsStartParams,
  FormsStopParams,
  FormsShotParams,
  FormsStatusParams,
  NativeFormsCommandParams,
} from './agentFormsTypes';
import type { StaticFormEditParams, StaticFormSelector, StaticFormValidateParams } from './agentStaticForms';
import { SkdOperations } from './agentSkdOperations';
import type {
    SkdCompileParams,
    SkdInfoParams,
    SkdEditParams,
    SkdValidateParams,
} from './agentSkdTypes';
import { XdtoAgentOperations } from './agentXdtoOperations';
import type {
    XdtoCompareParams,
    XdtoCreateFromXsdParams,
    XdtoExportXsdParams,
    XdtoGetPackageParams,
    XdtoImportXsdParams,
    XdtoMergeParams,
} from './agentXdtoTypes';
import { WorkspaceRegistry, WorkspaceRegistryError } from '../services/configurationSession/WorkspaceRegistry';
import type { ConfigurationIdentity } from '../services/configurationSession/types';
import type { MutationPlan } from '../services/configurationSession/mutationPlan';
import { AgentRoleRightsError, planSetRoleRights } from './agentRoleRights';
import { resolveAgentConfiguration } from './agentConfigurationResolver';
import { AgentPathError, parseSourceAddress } from './agentPathResolver';
import { resolveSourceAddress } from './agentSourceAddressResolver';
import { AgentTaskManager } from './agentTaskManager';
import { AgentRepositoryOperations } from './agentRepositoryOperations';
import type {
    AgentRepositoryCommitParams,
    AgentRepositoryConnectParams,
    AgentRepositoryDisconnectParams,
    AgentRepositoryLockParams,
    AgentRepositoryUpdateConfigurationParams,
    AgentRepositoryUpdateObjectParams,
    AgentRepositoryUnlockParams,
    AgentTaskIdParams,
} from './types';
import type { ConfigurationRepositoryService } from '../services/configurationRepository/configurationRepositoryService';
import {
    AGENT_SUPPORT_COMMAND_IDS,
    AgentSupportOperations,
    type AgentSupportOperationsDeps,
} from './agentSupportOperations';
import {
    AGENT_CFE_COMMAND_IDS,
    AgentCfeProjectOperations,
    type AgentCfeBorrowObjectParams,
    type AgentCfeBorrowFormParams,
    type AgentCfeCreateInterceptorParams,
    type AgentCfeCreateOwnFormParams,
    type AgentCfeCreateProjectParams,
    type AgentCfeExtendFormParams,
    type AgentCfeGetContextParams,
    type AgentCfeListProjectsParams,
    type AgentCfeValidateParams,
} from './agentCfeProjectOperations';

/**
 * Регистрирует Agent API команды.
 *
 * @param context - ExtensionContext для подписок.
 * @param getTreeDataProvider - Геттер провайдера дерева (может быть null до инициализации).
 * @param getConfigurationRegistry - Асинхронный геттер registry конфигураций.
 * @param debugRegistry - Реестр отладочных сессий.
 * @param getDebugDeps - Опциональный геттер зависимостей для debug.startFromBinding.
 * @param getDeployDeps - Опциональный геттер зависимостей deploy/pull.
 * @param getSupportDeps - Опциональный геттер общего support application facade.
 */
export function registerAgentCommands(
    context: vscode.ExtensionContext,
    getTreeDataProvider: () => MetadataTreeDataProvider | null,
    getConfigurationRegistry: () => Promise<WorkspaceRegistry | null>,
    debugRegistry: DebugSessionRegistry,
    getDebugDeps?: () => AgentDebugOperationsDeps | undefined,
    getDeployDeps?: () => AgentDeployOperationsDeps | undefined,
    getSupportDeps?: () => AgentSupportOperationsDeps | undefined,
    /** Optional lifecycle hook used by CFE creation after registry discovery succeeds. */
    refreshCfeLifecycle?: () => Promise<void>,
    getRepositoryService?: () => ConfigurationRepositoryService | null,
): void {
    const resolveSession = async (
        params: ConfigurationScopedParams = {},
        capability: keyof ConfigurationIdentity['capabilities'] = 'read',
    ) => {
        const registry = await getConfigurationRegistry();
        if (!registry) {
            throw new WorkspaceRegistryError('CONFIGURATION_NOT_FOUND', 'Корень конфигурации не найден.');
        }
        if (
            !params.configurationId
            && 'configPath' in params
            && typeof params.configPath === 'string'
            && params.configPath.trim()
        ) {
            const session = await registry.resolveResource(params.configPath);
            if (!session.identity.capabilities[capability]) {
                throw new WorkspaceRegistryError(
                    'CONFIGURATION_CAPABILITY_UNSUPPORTED',
                    `Конфигурация ${session.identity.configurationId} не поддерживает ${capability}.`,
                );
            }
            return session;
        }
        const candidateAddress = extractCandidateAddress(params);
        if (candidateAddress) {
            const resolved = await resolveSourceAddress(
                { address: candidateAddress, configurationId: params.configurationId },
                {
                    registry,
                    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                    treeDataProvider: getTreeDataProvider ? getTreeDataProvider() ?? undefined : undefined,
                },
            );
            if (!resolved.session.identity.capabilities[capability]) {
                throw new WorkspaceRegistryError(
                    'CONFIGURATION_CAPABILITY_UNSUPPORTED',
                    `Конфигурация ${resolved.session.identity.configurationId} не поддерживает ${capability}.`,
                );
            }
            return resolved.session;
        }
        return resolveAgentConfiguration(registry, params, capability);
    };

    const runForConfiguration = async <T>(
        params: ConfigurationScopedParams,
        capability: keyof ConfigurationIdentity['capabilities'],
        mutationKind: string | undefined,
        operation: (configRoot: string) => Promise<AgentResult<T>>,
        cancellation?: vscode.CancellationToken,
    ): Promise<AgentResult<T>> => {
        try {
            const session = await resolveSession(params, capability);
            if (!mutationKind) {
                const result = await operation(session.identity.rootPath);
                return {
                    ...result,
                    configurationId: session.identity.configurationId,
                    snapshotVersion: session.snapshotVersion,
                };
            }
            const outcome = await session.enqueue({
                kind: mutationKind,
                cancellation,
                execute: () => operation(session.identity.rootPath),
                commitWhen: (result) => result.success,
            });
            if (outcome.status === 'committed' || (outcome.status === 'failed' && outcome.value)) {
                const value = outcome.value!;
                return {
                    ...value,
                    configurationId: outcome.configurationId,
                    operationId: outcome.operationId,
                    snapshotVersion: outcome.snapshotVersion,
                };
            }
            const failureError = outcome.status === 'failed' || outcome.status === 'conflict'
                ? outcome.error?.message ?? 'Операция конфигурации не выполнена.'
                : 'Операция отменена.';
            return {
                success: false,
                code: outcome.status === 'conflict' ? outcome.code : outcome.status.toUpperCase(),
                error: failureError,
                configurationId: outcome.configurationId,
                operationId: outcome.operationId,
                snapshotVersion: outcome.snapshotVersion,
            };
        } catch (error) {
            return {
                success: false,
                code: error instanceof WorkspaceRegistryError ? error.code : 'CONFIGURATION_OPERATION_FAILED',
                error: error instanceof Error ? error.message : String(error),
            };
        }
    };

    const runPlanForConfiguration = async <T>(
        params: ConfigurationScopedParams,
        buildPlan: (
            configRoot: string,
            format: ConfigurationIdentity['format'],
        ) => Promise<MutationPlan<AgentResult<T>>>,
    ): Promise<AgentResult<T>> => {
        try {
            const session = await resolveSession(params, 'write');
            const plan = await buildPlan(session.identity.rootPath, session.identity.format);
            const outcome = await session.enqueuePlan(plan);
            if (outcome.status === 'committed') {
                return {
                    ...outcome.value,
                    configurationId: outcome.configurationId,
                    operationId: outcome.operationId,
                    snapshotVersion: outcome.snapshotVersion,
                };
            }
            return {
                success: false,
                code: outcome.status === 'conflict' ? outcome.code : outcome.status.toUpperCase(),
                error: outcome.status === 'failed' || outcome.status === 'conflict'
                    ? outcome.error?.message ?? 'Configuration mutation failed.'
                    : 'Configuration mutation was cancelled.',
                configurationId: outcome.configurationId,
                operationId: outcome.operationId,
                snapshotVersion: outcome.snapshotVersion,
            };
        } catch (error) {
            if (error instanceof AgentRoleRightsError) {
                return { success: false, code: error.code, error: error.message };
            }
            return {
                success: false,
                code: error instanceof WorkspaceRegistryError || error instanceof AgentPathError
                    ? error.code
                    : 'CONFIGURATION_OPERATION_FAILED',
                error: error instanceof Error ? error.message : String(error),
            };
        }
    };

    const taskManager = new AgentTaskManager();
    context.subscriptions.push({ dispose: () => taskManager.dispose() });
    const runAgentLongTask = <T>(
        name: string,
        background: boolean | undefined,
        requestToken: vscode.CancellationToken | undefined,
        execute: (
            token: vscode.CancellationToken | undefined,
            reportStage?: (message: string) => void,
        ) => Promise<AgentResult<T>>,
    ): Promise<AgentResult<unknown>> => {
        if (background === true) {
            return Promise.resolve(taskManager.start(name, async (token, reportStage) => {
                if (token.isCancellationRequested) {
                    return { success: false, code: 'REQUEST_CANCELLED', error: 'Операция отменена до запуска.' };
                }
                reportStage(`Запущена операция ${name}.`);
                return execute(token, reportStage);
            }));
        }
        if (requestToken?.isCancellationRequested) {
            return Promise.resolve({
                success: false,
                code: 'REQUEST_CANCELLED',
                error: 'Операция отменена до запуска.',
            });
        }
        return execute(requestToken);
    };
    const repositoryOperations = new AgentRepositoryOperations({
        getService: () => getRepositoryService?.() ?? null,
        getTreeProvider: getTreeDataProvider,
        getConfigurationRegistry,
        infobaseStorage: getDeployDeps?.()?.infobaseStorage ?? null,
        taskManager,
    });

    const taskStatusCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.task.status',
        (params: AgentTaskIdParams) => isTaskIdParams(params)
            ? taskManager.status(params.taskId)
            : invalidTaskParams(),
    );
    const taskResultCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.task.result',
        (params: AgentTaskIdParams) => isTaskIdParams(params)
            ? taskManager.result(params.taskId)
            : invalidTaskParams(),
    );
    const taskCancelCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.task.cancel',
        (params: AgentTaskIdParams) => isTaskIdParams(params)
            ? taskManager.cancel(params.taskId)
            : invalidTaskParams(),
    );

    const repositoryConnectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.repository.connect',
        (params: AgentRepositoryConnectParams, token?: vscode.CancellationToken) => repositoryOperations.connect(params, token),
    );
    const repositoryDisconnectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.repository.disconnect',
        (params: AgentRepositoryDisconnectParams, token?: vscode.CancellationToken) => repositoryOperations.disconnect(params, token),
    );
    const repositoryLockCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.repository.lock',
        (params: AgentRepositoryLockParams, token?: vscode.CancellationToken) => repositoryOperations.lock(params, token),
    );
    const repositoryUnlockCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.repository.unlock',
        (params: AgentRepositoryUnlockParams, token?: vscode.CancellationToken) => repositoryOperations.unlock(params, token),
    );
    const repositoryCommitCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.repository.commit',
        (params: AgentRepositoryCommitParams, token?: vscode.CancellationToken) => repositoryOperations.commit(params, token),
    );
    const repositoryUpdateObjectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.repository.updateObject',
        (params: AgentRepositoryUpdateObjectParams, token?: vscode.CancellationToken) => repositoryOperations.updateObject(params, token),
    );
    const repositoryUpdateConfigurationCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.repository.updateConfiguration',
        (params: AgentRepositoryUpdateConfigurationParams, token?: vscode.CancellationToken) => repositoryOperations.updateConfiguration(params, token),
    );
    const repositoryGetStatusCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.repository.getStatus',
        (params: { configurationId: string }) => repositoryOperations.getStatus(params),
    );

    const listConfigurationsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.listConfigurations',
        async () => {
            const registry = await getConfigurationRegistry();
            return registry
                ? { success: true, data: { configurations: registry.list() } }
                : { success: true, data: { configurations: [] } };
        },
    );

    const setRoleRightsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.roles.setRights',
        async (params: AgentSetRoleRightsParams) => {
            let normalizedParams = params;
            if (params.objects && Array.isArray(params.objects)) {
                const detectedSourceSets = new Set<string>();
                let hasUnprefixed = false;
                const normalizedObjects: string[] = [];

                for (const obj of params.objects) {
                    if (typeof obj === 'string') {
                        const colonCount = (obj.match(/:/g) || []).length;
                        if (colonCount >= 2 && !/^[a-zA-Z]:[\\/]/.test(obj)) {
                            const firstColon = obj.indexOf(':');
                            const prefix = obj.slice(0, firstColon).trim();
                            detectedSourceSets.add(prefix);
                            normalizedObjects.push(obj.slice(firstColon + 1).trim());
                            continue;
                        }
                    }
                    hasUnprefixed = true;
                    normalizedObjects.push(obj);
                }

                const uniqueCanonicalSets = new Set(Array.from(detectedSourceSets).map((s) => s.toLowerCase()));
                if (uniqueCanonicalSets.size > 1 || (uniqueCanonicalSets.size === 1 && hasUnprefixed)) {
                    const setNames = Array.from(detectedSourceSets);
                    if (hasUnprefixed) {
                        setNames.push('<unprefixed>');
                    }
                    return {
                        success: false,
                        code: 'INVALID_AGENT_PATH',
                        error: `Cannot set rights across multiple source sets in a single request: ${setNames.join(', ')}.`,
                    };
                }

                normalizedParams = { ...params, objects: normalizedObjects };
            }
            const result = await runPlanForConfiguration(params, (configRoot, format) =>
                planSetRoleRights(configRoot, format, normalizedParams));
            if (result.success) { getTreeDataProvider()?.refresh(); }
            return result;
        },
    );


    // ─── CFE project lifecycle ─────────────────────────────────────────────

    const cfeOperations = new AgentCfeProjectOperations(
        getConfigurationRegistry,
        async () => {
            await getConfigurationRegistry();
            await refreshCfeLifecycle?.();
        },
    );
    const cfeListProjectsCommand = vscode.commands.registerCommand(
        AGENT_CFE_COMMAND_IDS.listProjects,
        async (params: AgentCfeListProjectsParams = {}) => cfeOperations.listProjects(params),
    );
    const cfeGetContextCommand = vscode.commands.registerCommand(
        AGENT_CFE_COMMAND_IDS.getContext,
        async (params: AgentCfeGetContextParams) => cfeOperations.getContext(params),
    );
    const cfeValidateCommand = vscode.commands.registerCommand(
        AGENT_CFE_COMMAND_IDS.validate,
        async (params: AgentCfeValidateParams = {}) => cfeOperations.validate(params),
    );
    const cfeCreateProjectCommand = vscode.commands.registerCommand(
        AGENT_CFE_COMMAND_IDS.createProject,
        async (params: AgentCfeCreateProjectParams) => cfeOperations.createProject(params),
    );
    const cfeBorrowObjectCommand = vscode.commands.registerCommand(
        AGENT_CFE_COMMAND_IDS.borrowObject,
        async (params: AgentCfeBorrowObjectParams) => cfeOperations.borrowObject(params),
    );
    const cfeCreateInterceptorCommand = vscode.commands.registerCommand(
        AGENT_CFE_COMMAND_IDS.createInterceptor,
        async (params: AgentCfeCreateInterceptorParams) => cfeOperations.createInterceptor(params),
    );
    const cfeCreateOwnFormCommand = vscode.commands.registerCommand(
        AGENT_CFE_COMMAND_IDS.createOwnForm,
        async (params: AgentCfeCreateOwnFormParams) => cfeOperations.createOwnForm(params),
    );
    const cfeBorrowFormCommand = vscode.commands.registerCommand(
        AGENT_CFE_COMMAND_IDS.borrowForm,
        async (params: AgentCfeBorrowFormParams) => cfeOperations.borrowForm(params),
    );
    const cfeExtendFormCommand = vscode.commands.registerCommand(
        AGENT_CFE_COMMAND_IDS.extendForm,
        async (params: AgentCfeExtendFormParams) => cfeOperations.extendForm(params),
    );

    // ─── 1c-metadata-tree.agent.createObject ─────────────────────────────────

    const createObjectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.createObject',
        async (params: CreateObjectParams) => {
            let normalizedParams = params;
            if (params.type && params.type.includes(':') && !/^[a-zA-Z]:[\\/]/.test(params.type)) {
                const { dotPath } = parseSourceAddress(params.type);
                normalizedParams = { ...params, type: dotPath };
            }
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.createObject', async (configRoot) => {
                const result = await new AgentOperations(configRoot).createObject(normalizedParams);
                if (result.success && !dryRun) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.getYaml ──────────────────────────────────────

    const getYamlCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getYaml',
        async (params: GetYamlParams) => {
            return runForConfiguration(params, 'read', undefined, (configRoot) =>
                new AgentOperations(configRoot).getYaml(params));
        }
    );

    // ─── 1c-metadata-tree.agent.listObjects ──────────────────────────────────

    const listObjectsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.listObjects',
        async (params: ListObjectsParams = {}) => {
            let normalizedParams = params;
            if (params.type && params.type.includes(':') && !/^[a-zA-Z]:[\\/]/.test(params.type)) {
                const { dotPath } = parseSourceAddress(params.type);
                normalizedParams = { ...params, type: dotPath };
            }
            return runForConfiguration(params, 'read', undefined, (configRoot) =>
                new AgentOperations(configRoot).listObjects(normalizedParams));
        }
    );

    const listChildrenCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.listChildren',
        async (params: ListChildrenParams) => runForConfiguration(params, 'read', undefined, (configRoot) =>
            new AgentOperations(configRoot).listChildren(params)),
    );

    // ─── 1c-metadata-tree.agent.resolveSourceAddress ─────────────────────────

    const resolveSourceAddressCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.resolveSourceAddress',
        async (params: ResolveSourceAddressParams) => {
            try {
                const registry = await getConfigurationRegistry();
                if (!registry) {
                    return { success: false, error: 'Корень конфигурации не найден.' };
                }
                const resolved = await resolveSourceAddress(params, {
                    registry,
                    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                    treeDataProvider: getTreeDataProvider ? getTreeDataProvider() ?? undefined : undefined,
                });
                return {
                    success: true,
                    configurationId: resolved.configurationId,
                    snapshotVersion: resolved.session.snapshotVersion,
                    data: {
                        sourceSet: resolved.sourceSet,
                        dotPath: resolved.dotPath,
                        configRoot: resolved.configRoot,
                        configurationId: resolved.configurationId,
                        resolvedPath: resolved.resolvedPath,
                        cfeContext: resolved.cfeContext ? {
                            extensionName: resolved.cfeContext.extensionName,
                            baseConfiguration: resolved.cfeContext.baseSession.identity.rootPath,
                            extensionConfiguration: resolved.cfeContext.extensionSession.identity.rootPath,
                            baseRoot: resolved.cfeContext.baseRoot,
                            extensionRoot: resolved.cfeContext.extensionRoot,
                        } : undefined,
                        treeNode: resolved.treeNode,
                    },
                };
            } catch (error) {
                return {
                    success: false,
                    code: error instanceof AgentPathError
                        ? error.code
                        : error instanceof WorkspaceRegistryError
                        ? error.code
                        : 'INVALID_AGENT_PATH',
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        },
    );

    // ─── 1c-metadata-tree.agent.getProperties ────────────────────────────────

    const getPropertiesCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getProperties',
        async (params: GetPropertiesParams) => {
            return runForConfiguration(params, 'read', undefined, (configRoot) =>
                new AgentOperations(configRoot).getProperties(params));
        }
    );

    // ─── 1c-metadata-tree.agent.addAttribute ─────────────────────────────────

    const addAttributeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.addAttribute',
        async (params: AddAttributeParams) => {
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.addAttribute', async (configRoot) => {
                const result = await new AgentOperations(configRoot).addAttribute(params);
                if (result.success && !dryRun) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.addTabularSection ────────────────────────────

    const addTabularSectionCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.addTabularSection',
        async (params: AddTabularSectionParams) => {
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.addTabularSection', async (configRoot) => {
                const result = await new AgentOperations(configRoot).addTabularSection(params);
                if (result.success && !dryRun) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.addTabularSectionColumn ──────────────────────

    const addTabularSectionColumnCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.addTabularSectionColumn',
        async (params: AddTabularSectionColumnParams) => {
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.addTabularSectionColumn', async (configRoot) => {
                const result = await new AgentOperations(configRoot).addTabularSectionColumn(params);
                if (result.success && !dryRun) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.deleteAttribute ──────────────────────────────

    const deleteAttributeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deleteAttribute',
        async (params: DeleteAttributeParams) => {
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.deleteAttribute', async (configRoot) => {
                const result = await new AgentOperations(configRoot).deleteAttribute(params);
                if (result.success && !dryRun) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.deleteTabularSection ─────────────────────────

    const deleteTabularSectionCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deleteTabularSection',
        async (params: DeleteTabularSectionParams) => {
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.deleteTabularSection', async (configRoot) => {
                const result = await new AgentOperations(configRoot).deleteTabularSection(params);
                if (result.success && !dryRun) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.deleteObject ─────────────────────────────────

    const deleteObjectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deleteObject',
        async (params: DeleteObjectParams) => {
            const dotPath = typeof params?.path === 'string' ? parseSourceAddress(params.path).dotPath : '';
            const segmentCount = dotPath ? dotPath.split('.').length : 0;
            if (segmentCount !== 2) {
                return {
                    success: false,
                    code: 'INVALID_AGENT_PATH',
                    error: `deleteObject supports only a root object path: "${String(params?.path)}".`,
                };
            }
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.deleteObject', async (configRoot) => {
                const result = await new AgentOperations(configRoot).deleteObject(params);
                if (result.success && !dryRun) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.renameObject ─────────────────────────────────

    const renameObjectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.renameObject',
        async (params: RenameObjectParams) => {
            const dotPath = typeof params?.path === 'string' ? parseSourceAddress(params.path).dotPath : '';
            const segmentCount = dotPath ? dotPath.split('.').length : 0;
            if (segmentCount !== 2) {
                return {
                    success: false,
                    code: 'INVALID_AGENT_PATH',
                    error: `renameObject supports only a root object path (RootTag.Name): "${String(params?.path)}".`,
                };
            }
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.renameObject', async (configRoot) => {
                const result = await new AgentOperations(configRoot).renameObject(params);
                if (result.success && !dryRun) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.setProperties ────────────────────────────────

    const setPropertiesCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setProperties',
        async (params: SetPropertiesParams) => {
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.setProperties', async (configRoot) => {
                const result = await new AgentOperations(configRoot).setProperties(params);
                if (result.success && !dryRun) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.debug.start ──────────────────────────────────

    const debugStartCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.start',
        async (params: DebugStartParams, requestToken?: vscode.CancellationToken) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return runAgentLongTask('agent.debug.start', params.background, requestToken, (token, reportStage) =>
                ops.debugStart(params, token, reportStage));
        }
    );

    // ─── 1c-metadata-tree.agent.debug.stop ───────────────────────────────────

    const debugStopCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.stop',
        async (params: DebugStopParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugStop(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.setBreakpoint ──────────────────────────

    const debugSetBreakpointCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.setBreakpoint',
        async (params: DebugSetBreakpointParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugSetBreakpoint(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.clearBreakpoints ───────────────────────

    const debugClearBreakpointsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.clearBreakpoints',
        async (params: DebugClearBreakpointsParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugClearBreakpoints(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.setExceptionFilter ─────────────────────

    const debugSetExceptionFilterCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.setExceptionFilter',
        async (params: DebugSetExceptionFilterParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugSetExceptionFilter(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.waitForStop ────────────────────────────

    const debugWaitForStopCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.waitForStop',
        async (params: DebugWaitForStopParams, requestToken?: vscode.CancellationToken) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return runAgentLongTask('agent.debug.waitForStop', params.background, requestToken, (token, reportStage) =>
                ops.debugWaitForStop(params, token, reportStage));
        }
    );

    // ─── 1c-metadata-tree.agent.debug.getStackTrace ──────────────────────────

    const debugGetStackTraceCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.getStackTrace',
        async (params: DebugThreadParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugGetStackTrace(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.getScopes ──────────────────────────────

    const debugGetScopesCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.getScopes',
        async (params: DebugFrameParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugGetScopes(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.getVariables ───────────────────────────

    const debugGetVariablesCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.getVariables',
        async (params: DebugGetVariablesParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugGetVariables(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.evaluate ───────────────────────────────

    const debugEvaluateCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.evaluate',
        async (params: DebugEvaluateParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugEvaluate(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.continue ───────────────────────────────

    const debugContinueCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.continue',
        async (params: DebugThreadParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugContinue(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.stepOver ───────────────────────────────

    const debugStepOverCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.stepOver',
        async (params: DebugThreadParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugStepOver(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.stepIn ─────────────────────────────────

    const debugStepInCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.stepIn',
        async (params: DebugThreadParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugStepIn(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.stepOut ────────────────────────────────

    const debugStepOutCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.stepOut',
        async (params: DebugThreadParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugStepOut(params);
        }
    );

    // ─── 1c-metadata-tree.agent.debug.startFromBinding ───────────────────────

    const debugStartFromBindingCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.startFromBinding',
        async (params: DebugStartFromBindingParams, requestToken?: vscode.CancellationToken) => {
            const ops = new AgentDebugOperations(debugRegistry, getDebugDeps?.());
            return runAgentLongTask('agent.debug.startFromBinding', params.background, requestToken, (token, reportStage) =>
                ops.debugStartFromBinding(params, token, reportStage));
        }
    );

    // ─── 1c-metadata-tree.agent.resolveBinding ────────────────────────────

    const resolveBindingCmd = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.resolveBinding',
        async (params: { configPath?: string } = {}) => {
            const deps = getDebugDeps?.();
            if (!deps) {
                return { success: false, error: 'Привязки не инициализированы (нет deps).' };
            }
            return await resolveBindingCommand(params, deps);
        }
    );

    // ─── 1c-metadata-tree.agent.listBindings ────────────────────────────

    const listBindingsCmd = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.listBindings',
        async () => {
            const deps = getDebugDeps?.();
            if (!deps) {
                return { success: false, error: 'Привязки не инициализированы (нет deps).' };
            }
            return await listBindingsCommand(deps);
        }
    );

    // ─── 1c-metadata-tree.agent.deploy ───────────────────────────────────

    const runDeployAgentOperation = async <T>(
        params: ConfigurationScopedParams & { readonly background?: boolean },
        name: string,
        mutationKind: string | undefined,
        operation: (configRoot: string, token?: vscode.CancellationToken, reportStage?: (message: string) => void) => Promise<AgentResult<T>>,
        requestToken?: vscode.CancellationToken,
    ): Promise<AgentResult<unknown>> => {
        const run = (token?: vscode.CancellationToken, reportStage?: (message: string) => void) =>
            runForConfiguration(params, 'process', mutationKind, (configRoot) => operation(configRoot, token, reportStage), token);
        if (params.background === true) {
            return taskManager.start(name, async (token, reportStage) => {
                reportStage(`Начата операция ${name}.`);
                return run(token, reportStage);
            });
        }
        return run(requestToken);
    };

    const deployCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deploy',
        async (params: DeployParams = {}, requestToken?: vscode.CancellationToken) => {
            const deps = getDeployDeps?.();
            if (!deps) {
                return { success: false, error: 'Раскатка недоступна: хранилище или привязки не инициализированы.' };
            }
            return runDeployAgentOperation(params, 'agent.deploy', 'agent.deploy', (configRoot, token, reportStage) =>
                new AgentDeployOperations(deps).deploy({ ...params, configPath: configRoot }, { token, reportStage }), requestToken);
        }
    );

    // ─── 1c-metadata-tree.agent.deploySelectedObjects ────────────────────

    const deploySelectedObjectsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deploySelectedObjects',
        async (params: DeploySelectedObjectsParams, requestToken?: vscode.CancellationToken) => {
            const deps = getDeployDeps?.();
            if (!deps) {
                return { success: false, error: 'Раскатка недоступна: хранилище или привязки не инициализированы.' };
            }
            return runDeployAgentOperation(params, 'agent.deploySelectedObjects', 'agent.deploySelectedObjects', (configRoot, token, reportStage) =>
                new AgentDeployOperations(deps).deploySelectedObjects({ ...params, configPath: configRoot }, { token, reportStage }), requestToken);
        }
    );

    // ─── 1c-metadata-tree.agent.deployChangedFiles ───────────────────────

    const deployChangedFilesCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deployChangedFiles',
        async (params: DeployChangedFilesParams = {}, requestToken?: vscode.CancellationToken) => {
            const deps = getDeployDeps?.();
            if (!deps) {
                return { success: false, error: 'Раскатка недоступна: хранилище или привязки не инициализированы.' };
            }
            return runDeployAgentOperation(params, 'agent.deployChangedFiles', 'agent.deployChangedFiles', (configRoot, token, reportStage) =>
                new AgentDeployOperations(deps).deployChangedFiles({ ...params, configPath: configRoot }, { token, reportStage }), requestToken);
        }
    );

    // ─── 1c-metadata-tree.agent.pullSelectedObjects ──────────────────────

    const pullSelectedObjectsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.pullSelectedObjects',
        async (params: AgentPullParams, requestToken?: vscode.CancellationToken) => {
            const deps = getDeployDeps?.();
            if (!deps) {
                return { success: false, error: 'Выгрузка недоступна: хранилище или привязки не инициализированы.' };
            }
            return runDeployAgentOperation(params, 'agent.pullSelectedObjects', 'agent.pullSelectedObjects', (configRoot, token, reportStage) =>
                new AgentDeployOperations(deps).pullSelectedObjects({ ...params, configPath: configRoot }, { token, reportStage }), requestToken);
        }
    );

    // ─── 1c-metadata-tree.agent.exportStatus ─────────────────────────────

    const exportStatusCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.exportStatus',
        async (params: ExportStatusAgentParams = {}, requestToken?: vscode.CancellationToken) => {
            const deps = getDeployDeps?.();
            if (!deps) {
                return { success: false, error: 'Статус недоступен: хранилище или привязки не инициализированы.' };
            }
            return runDeployAgentOperation(params, 'agent.exportStatus', undefined, (configRoot, token, reportStage) => {
                reportStage?.('Запрос статуса через ibcmd.');
                return new AgentDeployOperations(deps).exportStatus({ ...params, configPath: configRoot }, { token, reportStage });
            }, requestToken);
        }
    );

    // ─── 1c-metadata-tree.agent.getType ─────────────────────────────────

    const getTypeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getType',
        async (params: GetTypeParams) => {
            return runForConfiguration(params, 'read', undefined, (configRoot) =>
                new AgentOperations(configRoot).getType(params));
        }
    );

    // ─── 1c-metadata-tree.agent.setType ─────────────────────────────────

    const setTypeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setType',
        async (params: SetTypeParams) => {
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.setType', async (configRoot) => {
                const result = await new AgentOperations(configRoot).setType(params);
                if (result.success && !dryRun) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.getSource ───────────────────────────────

    const getSourceCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getSource',
        async (params: GetSourceParams) => runForConfiguration(params, 'read', undefined, (configRoot) =>
            new AgentOperations(configRoot).getSource(params)),
    );

    // ─── 1c-metadata-tree.agent.setSource ───────────────────────────────

    const setSourceCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setSource',
        async (params: SetSourceParams) => {
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.setSource', async (configRoot) => {
                const result = await new AgentOperations(configRoot).setSource(params);
                if (result.success && !dryRun) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        },
    );

    const getSubsystemCommandInterfaceCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getSubsystemCommandInterface',
        async (params: ConfigurationScopedParams & { subsystemPath: string }) => {
            return runForConfiguration(params, 'read', undefined, (configRoot) =>
                new CommandInterfaceOperations(configRoot).getCommandInterface(params.subsystemPath));
        }
    );

    const setSubsystemCommandVisibilityCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setSubsystemCommandVisibility',
        async (params: ConfigurationScopedParams & { subsystemPath: string; commandName: string; common: CommandVisibility | null }) => {
            return runForConfiguration(params, 'write', 'agent.setSubsystemCommandVisibility', (configRoot) =>
                new CommandInterfaceOperations(configRoot)
                    .setCommandVisibility(params.subsystemPath, params.commandName, params.common));
        }
    );

    const setSubsystemCommandOrderCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setSubsystemCommandOrder',
        async (params: ConfigurationScopedParams & { subsystemPath: string; entries: CommandOrderEntry[] }) => {
            return runForConfiguration(params, 'write', 'agent.setSubsystemCommandOrder', (configRoot) =>
                new CommandInterfaceOperations(configRoot).setCommandOrder(params.subsystemPath, params.entries));
        }
    );

    const setSubsystemSubsystemsOrderCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setSubsystemSubsystemsOrder',
        async (params: ConfigurationScopedParams & { subsystemPath: string; order: string[] }) => {
            return runForConfiguration(params, 'write', 'agent.setSubsystemsOrder', (configRoot) =>
                new CommandInterfaceOperations(configRoot).setSubsystemsOrder(params.subsystemPath, params.order));
        }
    );

    const listPredefinedCharacteristicsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.listPredefinedCharacteristics',
        async (params: CotPathParams) => {
            return runForConfiguration(params, 'read', undefined, async (configRoot) => ({
                success: true,
                data: await listPredefinedCharacteristics(configRoot, params.path),
            }));
        }
    );

    const getPredefinedCharacteristicTypeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getPredefinedCharacteristicType',
        async (params: PredefinedCotPathParams) => {
            return runForConfiguration(params, 'read', undefined, async (configRoot) => ({
                success: true,
                data: await getPredefinedCharacteristicType(configRoot, params.path, params.predefinedName),
            }));
        }
    );

    const setPredefinedCharacteristicTypeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setPredefinedCharacteristicType',
        async (params: SetPredefinedCotTypeParams) => {
            return runForConfiguration(params, 'write', 'agent.setPredefinedCharacteristicType', async (configRoot) => {
                await setPredefinedCharacteristicType(configRoot, params.path, params.predefinedName, params.types);
                return { success: true };
            });
        }
    );

    const getCharacteristicValueRegistersCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getCharacteristicValueRegisters',
        async (params: CotPathParams) => {
            return runForConfiguration(params, 'read', undefined, async (configRoot) => ({
                success: true,
                data: await getCharacteristicValueRegisters(configRoot, params.path),
            }));
        }
    );

    const syntaxHelpOperations = new AgentSyntaxHelpOperations(context.extensionPath);
    const syntaxHelpCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.syntaxHelp',
        (params: unknown) => syntaxHelpOperations.execute(params),
    );

    const createFormsOperations = () => new FormsOperations({
        infobaseStorage: getDeployDeps?.()?.infobaseStorage ?? null,
        getConfiguredPlatformPath: getPlatformPathSetting,
    });

    // ─── 1c-metadata-tree.agent.forms.discover ───────────────────────────────

    const formsDiscoverCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.discover',
        async (params: FormsDiscoverParams = {}, requestToken?: vscode.CancellationToken) =>
            createFormsOperations().formsDiscover(params, requestToken),
    );

    // ─── 1c-metadata-tree.agent.forms.launch ─────────────────────────────────

    const formsLaunchCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.launch',
        async (params: FormsLaunchParams, requestToken?: vscode.CancellationToken) => {
            return runAgentLongTask('agent.forms.launch', params?.background, requestToken, (token, reportStage) =>
                createFormsOperations().formsLaunch(params, token, reportStage));
        },
    );

    // ─── 1c-metadata-tree.agent.forms.start ──────────────────────────────────

    const formsStartCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.start',
        async (params: FormsStartParams, requestToken?: vscode.CancellationToken) => {
            const ops = createFormsOperations();
            return runAgentLongTask('agent.forms.start', params.background, requestToken, (token, reportStage) =>
                ops.formsStart(params, token, reportStage));
        }
    );

    // ─── 1c-metadata-tree.agent.forms.stop ───────────────────────────────────

    const formsStopCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.stop',
        async (params: FormsStopParams = {}) => {
            const ops = createFormsOperations();
            return await ops.formsStop(params);
        }
    );

    // ─── 1c-metadata-tree.agent.forms.shot ───────────────────────────────────

    const formsShotCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.shot',
        async (params: FormsShotParams = {}, requestToken?: vscode.CancellationToken) => {
            const ops = createFormsOperations();
            return runAgentLongTask('agent.forms.shot', params.background, requestToken, (token, reportStage) =>
                ops.formsShot(params, token, reportStage));
        }
    );

    // ─── 1c-metadata-tree.agent.forms.status ─────────────────────────────────

    const formsStatusCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.status',
        async (params: FormsStatusParams = {}) => {
            const ops = createFormsOperations();
            return await ops.formsStatus(params);
        }
    );

    // ─── 1c-metadata-tree.agent.forms.native ────────────────────────────────

    const formsNativeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.native',
        async (params: NativeFormsCommandParams, requestToken?: vscode.CancellationToken) => {
            const ops = createFormsOperations();
            return runAgentLongTask('agent.forms.native', params.background, requestToken, (token, reportStage) =>
                ops.formsNative(params, token, reportStage));
        }
    );

    // ─── Static Form.xml inspection and validation ──────────────────────────

    const formsInspectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.inspect',
        async (params: StaticFormSelector) => runForConfiguration(params, 'read', undefined, (configRoot) =>
            new AgentStaticFormOperations(configRoot).inspect(params)),
    );

    const formsValidateCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.validate',
        async (params: StaticFormValidateParams) => runForConfiguration(params, 'read', undefined, (configRoot) =>
            new AgentStaticFormOperations(configRoot).validate(params)),
    );

    const formsEditCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.edit',
        async (params: StaticFormEditParams) => {
            const dryRun = params?.dryRun === true;
            return runForConfiguration(params, dryRun ? 'read' : 'write', dryRun ? undefined : 'agent.forms.edit', (configRoot) =>
                new AgentStaticFormOperations(configRoot).edit(params));
        },
    );

    // ─── 1c-metadata-tree.agent.skd.compile ──────────────────────────────────

    const skdCompileCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.compile',
        async (params: SkdCompileParams, requestToken?: vscode.CancellationToken) => {
            const ops = new SkdOperations({ extensionPath: context.extensionPath });
            return runAgentLongTask('agent.skd.compile', params.background, requestToken, (token, reportStage) =>
                ops.skdCompile(params, token, reportStage));
        }
    );

    // ─── 1c-metadata-tree.agent.skd.info ─────────────────────────────────────

    const skdInfoCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.info',
        async (params: SkdInfoParams, requestToken?: vscode.CancellationToken) => {
            const ops = new SkdOperations({ extensionPath: context.extensionPath });
            return runAgentLongTask('agent.skd.info', params.background, requestToken, (token, reportStage) =>
                ops.skdInfo(params, token, reportStage));
        }
    );

    // ─── 1c-metadata-tree.agent.skd.edit ─────────────────────────────────────

    const skdEditCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.edit',
        async (params: SkdEditParams, requestToken?: vscode.CancellationToken) => {
            const ops = new SkdOperations({ extensionPath: context.extensionPath });
            return runAgentLongTask('agent.skd.edit', params.background, requestToken, (token, reportStage) =>
                ops.skdEdit(params, token, reportStage));
        }
    );

    // ─── 1c-metadata-tree.agent.skd.validate ─────────────────────────────────

    const skdValidateCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.validate',
        async (params: SkdValidateParams, requestToken?: vscode.CancellationToken) => {
            const ops = new SkdOperations({ extensionPath: context.extensionPath });
            return runAgentLongTask('agent.skd.validate', params.background, requestToken, (token, reportStage) =>
                ops.skdValidate(params, token, reportStage));
        }
    );

    const listXdtoPackagesCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.listPackages',
        async (params: ConfigurationScopedParams = {}) => {
            return runForConfiguration(params, 'read', undefined, (configRoot) =>
                new XdtoAgentOperations(configRoot).listPackages());
        }
    );

    const getXdtoPackageCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.getPackage',
        async (params: XdtoGetPackageParams) => {
            return runForConfiguration(params, 'read', undefined, (configRoot) =>
                new XdtoAgentOperations(configRoot).getPackage(params));
        }
    );

    const exportXdtoXsdCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.exportXsd',
        async (params: XdtoExportXsdParams) => {
            if (params.outputPath !== undefined) {
                return runPlanForConfiguration(params, (configRoot) =>
                    new XdtoAgentOperations(configRoot).planExportXsd(params));
            }
            return runForConfiguration(params, 'read', undefined, (configRoot) =>
                new XdtoAgentOperations(configRoot).exportXsd(params));
        }
    );

    const importXdtoXsdCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.importXsd',
        async (params: XdtoImportXsdParams) => {
            const result = await runPlanForConfiguration(params, (configRoot) =>
                new XdtoAgentOperations(configRoot).planImportXsd(params));
            if (result.success) { getTreeDataProvider()?.refresh(); }
            return result;
        }
    );

    const createXdtoFromXsdCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.createFromXsd',
        async (params: XdtoCreateFromXsdParams) => {
            const result = await runPlanForConfiguration(params, (configRoot) =>
                new XdtoAgentOperations(configRoot).planCreateFromXsd(params));
            if (result.success) { getTreeDataProvider()?.refresh(); }
            return result;
        }
    );

    const compareXdtoPackageCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.compare',
        async (params: XdtoCompareParams) => {
            return runForConfiguration(params, 'read', undefined, (configRoot) =>
                new XdtoAgentOperations(configRoot).compare(params));
        }
    );

    const mergeXdtoPackageCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.merge',
        async (params: XdtoMergeParams) => {
            const result = await runPlanForConfiguration(params, (configRoot) =>
                new XdtoAgentOperations(configRoot).planMerge(params));
            if (result.success) { getTreeDataProvider()?.refresh(); }
            return result;
        }
    );

    const supportUnavailable = (): AgentResult => ({
        success: false,
        code: 'SUPPORT_OPERATION_FAILED',
        error: 'Операции поддержки недоступны: application facade не инициализирован.',
    });
    const supportOperations = (): AgentSupportOperations | undefined => {
        const deps = getSupportDeps?.();
        return deps ? new AgentSupportOperations(deps) : undefined;
    };

    const supportGetStatusCommand = vscode.commands.registerCommand(
        AGENT_SUPPORT_COMMAND_IDS.getStatus,
        async (params: AgentSupportGetStatusParams) => {
            return supportOperations()?.supportGetStatus(params) ?? supportUnavailable();
        }
    );

    const supportSetObjectModeCommand = vscode.commands.registerCommand(
        AGENT_SUPPORT_COMMAND_IDS.setObjectMode,
        async (params: AgentSupportSetObjectModeParams, requestToken?: vscode.CancellationToken) => {
            const ops = supportOperations();
            if (!ops) { return supportUnavailable(); }
            return runAgentLongTask('agent.supportSetObjectMode', params.background, requestToken, (token, reportStage) =>
                ops.supportSetObjectMode(params, token, reportStage));
        }
    );

    const supportEnableObjectRulesCommand = vscode.commands.registerCommand(
        AGENT_SUPPORT_COMMAND_IDS.enableObjectRules,
        async (params: AgentSupportEnableObjectRulesParams, requestToken?: vscode.CancellationToken) => {
            const ops = supportOperations();
            if (!ops) { return supportUnavailable(); }
            return runAgentLongTask('agent.supportEnableObjectRules', params.background, requestToken, (token, reportStage) =>
                ops.supportEnableObjectRules(params, token, reportStage));
        }
    );

    const supportSyncCommand = vscode.commands.registerCommand(
        AGENT_SUPPORT_COMMAND_IDS.sync,
        async (params: AgentSupportSyncParams, requestToken?: vscode.CancellationToken) => {
            const ops = supportOperations();
            if (!ops) { return supportUnavailable(); }
            return runAgentLongTask('agent.supportSync', params.background, requestToken, (token, reportStage) =>
                ops.supportSync(params, token, reportStage));
        }
    );

    const supportVerifyCommand = vscode.commands.registerCommand(
        AGENT_SUPPORT_COMMAND_IDS.verify,
        async (params: AgentSupportVerifyParams, requestToken?: vscode.CancellationToken) => {
            const ops = supportOperations();
            if (!ops) { return supportUnavailable(); }
            return runAgentLongTask('agent.supportVerify', params.background, requestToken, (token, reportStage) =>
                ops.supportVerify(params, token, reportStage));
        }
    );

    const supportGetLastRunCommand = vscode.commands.registerCommand(
        AGENT_SUPPORT_COMMAND_IDS.getLastRun,
        async (params: AgentSupportGetLastRunParams) => {
            return supportOperations()?.supportGetLastRun(params) ?? supportUnavailable();
        }
    );

    const dumpExternalProcessorCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.dumpExternalProcessor',
        async (params: AgentDumpExternalProcessorParams, requestToken?: vscode.CancellationToken) => {
            const { agentDumpExternalProcessor } = await import('./agentExternalProcessorOperations');
            if (params.background === true) {
                return taskManager.start('agent.dumpExternalProcessor', async (token, reportStage) => {
                    reportStage('Запущена выгрузка исходников EPF/ERF.');
                    return agentDumpExternalProcessor(params, token, reportStage);
                });
            }
            if (requestToken?.isCancellationRequested) {
                return { success: false, code: 'REQUEST_CANCELLED', error: 'Запрос отменён до запуска операции.' };
            }
            return agentDumpExternalProcessor(params, requestToken);
        }
    );

    const buildExternalProcessorCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.buildExternalProcessor',
        async (params: AgentBuildExternalProcessorParams, requestToken?: vscode.CancellationToken) => {
            const { agentBuildExternalProcessor } = await import('./agentExternalProcessorOperations');
            if (params.background === true) {
                return taskManager.start('agent.buildExternalProcessor', async (token, reportStage) => {
                    reportStage('Запущена сборка EPF/ERF.');
                    return agentBuildExternalProcessor(params, token, reportStage);
                });
            }
            if (requestToken?.isCancellationRequested) {
                return { success: false, code: 'REQUEST_CANCELLED', error: 'Запрос отменён до запуска операции.' };
            }
            return agentBuildExternalProcessor(params, requestToken);
        }
    );

    context.subscriptions.push(
        listConfigurationsCommand,
        setRoleRightsCommand,
        cfeListProjectsCommand, cfeGetContextCommand, cfeValidateCommand, cfeCreateProjectCommand, cfeBorrowObjectCommand,
        cfeCreateInterceptorCommand, cfeCreateOwnFormCommand, cfeBorrowFormCommand, cfeExtendFormCommand,
        createObjectCommand, getYamlCommand, listObjectsCommand, listChildrenCommand, resolveSourceAddressCommand, getPropertiesCommand,
        addAttributeCommand, addTabularSectionCommand, addTabularSectionColumnCommand,
        deleteAttributeCommand, deleteTabularSectionCommand, deleteObjectCommand,
        renameObjectCommand, setPropertiesCommand,
        debugStartCommand, debugStopCommand, debugSetBreakpointCommand,
        debugClearBreakpointsCommand, debugSetExceptionFilterCommand, debugWaitForStopCommand,
        debugGetStackTraceCommand, debugGetScopesCommand, debugGetVariablesCommand,
        debugEvaluateCommand, debugContinueCommand, debugStepOverCommand,
        debugStepInCommand, debugStepOutCommand,
        debugStartFromBindingCommand,
        resolveBindingCmd, listBindingsCmd,
        taskStatusCommand, taskResultCommand, taskCancelCommand,
        repositoryConnectCommand, repositoryDisconnectCommand, repositoryLockCommand, repositoryUnlockCommand,
        repositoryCommitCommand, repositoryUpdateObjectCommand, repositoryUpdateConfigurationCommand,
        repositoryGetStatusCommand,
        deployCommand,
        deploySelectedObjectsCommand, deployChangedFilesCommand,
        pullSelectedObjectsCommand, exportStatusCommand,
        getTypeCommand, setTypeCommand,
        getSourceCommand, setSourceCommand,
        getSubsystemCommandInterfaceCommand, setSubsystemCommandVisibilityCommand,
        setSubsystemCommandOrderCommand, setSubsystemSubsystemsOrderCommand,
        listPredefinedCharacteristicsCommand,
        getPredefinedCharacteristicTypeCommand,
        setPredefinedCharacteristicTypeCommand,
        getCharacteristicValueRegistersCommand,
        formsDiscoverCommand, formsLaunchCommand, formsStartCommand, formsStopCommand,
        formsShotCommand, formsStatusCommand, formsNativeCommand, formsInspectCommand, formsValidateCommand, formsEditCommand,
        syntaxHelpCommand,
        skdCompileCommand, skdInfoCommand, skdEditCommand, skdValidateCommand,
        listXdtoPackagesCommand, getXdtoPackageCommand, exportXdtoXsdCommand,
        importXdtoXsdCommand, createXdtoFromXsdCommand,
        compareXdtoPackageCommand, mergeXdtoPackageCommand,
        supportGetStatusCommand, supportSetObjectModeCommand,
        supportEnableObjectRulesCommand, supportSyncCommand,
        supportVerifyCommand, supportGetLastRunCommand,
        dumpExternalProcessorCommand, buildExternalProcessorCommand,
    );
}

function isTaskIdParams(value: unknown): value is AgentTaskIdParams {
    return value !== null
        && typeof value === 'object'
        && typeof (value as { taskId?: unknown }).taskId === 'string'
        && Boolean((value as { taskId: string }).taskId.trim());
}

function invalidTaskParams(): AgentResult<never> {
    return { success: false, code: 'INVALID_ARGUMENTS', error: 'Укажите непустой taskId.' };
}

function extractCandidateAddress(params: ConfigurationScopedParams): string | undefined {
    if ('address' in params && typeof (params as Record<string, unknown>).address === 'string') {
        const address = ((params as Record<string, unknown>).address as string).trim();
        if (address) {
            return address;
        }
    }
    if ('path' in params && typeof (params as Record<string, unknown>).path === 'string') {
        const pathVal = ((params as Record<string, unknown>).path as string).trim();
        if (pathVal) {
            return pathVal;
        }
    }
    if ('type' in params && typeof (params as Record<string, unknown>).type === 'string') {
        const typeVal = ((params as Record<string, unknown>).type as string).trim();
        if (typeVal.includes(':') && !/^[a-zA-Z]:[\\/]/.test(typeVal)) {
            return typeVal;
        }
    }
    if ('objects' in params && Array.isArray((params as Record<string, unknown>).objects)) {
        const objects = (params as Record<string, unknown>).objects as unknown[];
        if (typeof objects[0] === 'string' && objects[0].trim()) {
            return extractAddressFromObjectSpec(objects[0]);
        }
    }
    return undefined;
}

function extractAddressFromObjectSpec(spec: string): string {
    const trimmed = spec.trim();
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
        return trimmed;
    }
    const lastColon = trimmed.lastIndexOf(':');
    if (lastColon >= 0) {
        return trimmed.slice(0, lastColon).trim();
    }
    return trimmed;
}

