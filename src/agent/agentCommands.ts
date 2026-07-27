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
    AgentResult,
    ConfigurationScopedParams,
    AgentSupportGetStatusParams,
    AgentSupportSetObjectModeParams,
    AgentSupportEnableObjectRulesParams,
    AgentSupportSyncParams,
    AgentSupportVerifyParams,
    AgentSupportGetLastRunParams,
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
import type {
    FormsStartParams,
    FormsExecParams,
    FormsStopParams,
    FormsShotParams,
    FormsStatusParams,
} from './agentFormsTypes';
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
import { resolveAgentConfiguration } from './agentConfigurationResolver';
import { AgentPathError } from './agentPathResolver';
import {
    AGENT_SUPPORT_COMMAND_IDS,
    AgentSupportOperations,
    type AgentSupportOperationsDeps,
} from './agentSupportOperations';

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
        return resolveAgentConfiguration(registry, params, capability);
    };

    const runForConfiguration = async <T>(
        params: ConfigurationScopedParams,
        capability: keyof ConfigurationIdentity['capabilities'],
        mutationKind: string | undefined,
        operation: (configRoot: string) => Promise<AgentResult<T>>,
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
        buildPlan: (configRoot: string) => Promise<MutationPlan<AgentResult<T>>>,
    ): Promise<AgentResult<T>> => {
        try {
            const session = await resolveSession(params, 'write');
            const plan = await buildPlan(session.identity.rootPath);
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
            return {
                success: false,
                code: error instanceof WorkspaceRegistryError || error instanceof AgentPathError
                    ? error.code
                    : 'CONFIGURATION_OPERATION_FAILED',
                error: error instanceof Error ? error.message : String(error),
            };
        }
    };

    const listConfigurationsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.listConfigurations',
        async () => {
            const registry = await getConfigurationRegistry();
            return registry
                ? { success: true, data: { configurations: registry.list() } }
                : { success: true, data: { configurations: [] } };
        },
    );

    // ─── 1c-metadata-tree.agent.createObject ─────────────────────────────────

    const createObjectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.createObject',
        async (params: CreateObjectParams) => {
            const result = await runPlanForConfiguration(params, (configRoot) =>
                new AgentOperations(configRoot).planCreateObject(params));
            if (result.success) { getTreeDataProvider()?.refresh(); }
            return result;
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
            return runForConfiguration(params, 'read', undefined, (configRoot) =>
                new AgentOperations(configRoot).listObjects(params));
        }
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
            return runForConfiguration(params, 'write', 'agent.addAttribute', async (configRoot) => {
                const result = await new AgentOperations(configRoot).addAttribute(params);
                if (result.success) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.addTabularSection ────────────────────────────

    const addTabularSectionCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.addTabularSection',
        async (params: AddTabularSectionParams) => {
            return runForConfiguration(params, 'write', 'agent.addTabularSection', async (configRoot) => {
                const result = await new AgentOperations(configRoot).addTabularSection(params);
                if (result.success) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.addTabularSectionColumn ──────────────────────

    const addTabularSectionColumnCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.addTabularSectionColumn',
        async (params: AddTabularSectionColumnParams) => {
            return runForConfiguration(params, 'write', 'agent.addTabularSectionColumn', async (configRoot) => {
                const result = await new AgentOperations(configRoot).addTabularSectionColumn(params);
                if (result.success) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.deleteAttribute ──────────────────────────────

    const deleteAttributeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deleteAttribute',
        async (params: DeleteAttributeParams) => {
            return runForConfiguration(params, 'write', 'agent.deleteAttribute', async (configRoot) => {
                const result = await new AgentOperations(configRoot).deleteAttribute(params);
                if (result.success) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.deleteTabularSection ─────────────────────────

    const deleteTabularSectionCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deleteTabularSection',
        async (params: DeleteTabularSectionParams) => {
            return runForConfiguration(params, 'write', 'agent.deleteTabularSection', async (configRoot) => {
                const result = await new AgentOperations(configRoot).deleteTabularSection(params);
                if (result.success) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.deleteObject ─────────────────────────────────

    const deleteObjectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deleteObject',
        async (params: DeleteObjectParams) => {
            const result = await runPlanForConfiguration(params, (configRoot) =>
                new AgentOperations(configRoot).planDeleteObject(params));
            if (result.success) { getTreeDataProvider()?.refresh(); }
            return result;
        }
    );

    // ─── 1c-metadata-tree.agent.renameObject ─────────────────────────────────

    const renameObjectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.renameObject',
        async (params: RenameObjectParams) => {
            const result = await runPlanForConfiguration(params, (configRoot) =>
                new AgentOperations(configRoot).planRenameObject(params));
            if (result.success) { getTreeDataProvider()?.refresh(); }
            return result;
        }
    );

    // ─── 1c-metadata-tree.agent.setProperties ────────────────────────────────

    const setPropertiesCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setProperties',
        async (params: SetPropertiesParams) => {
            return runForConfiguration(params, 'write', 'agent.setProperties', async (configRoot) => {
                const result = await new AgentOperations(configRoot).setProperties(params);
                if (result.success) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
    );

    // ─── 1c-metadata-tree.agent.debug.start ──────────────────────────────────

    const debugStartCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.debug.start',
        async (params: DebugStartParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugStart(params);
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
        async (params: DebugWaitForStopParams) => {
            const ops = new AgentDebugOperations(debugRegistry);
            return await ops.debugWaitForStop(params);
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
        async (params: DebugStartFromBindingParams) => {
            const ops = new AgentDebugOperations(debugRegistry, getDebugDeps?.());
            return await ops.debugStartFromBinding(params);
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

    const deployCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deploy',
        async (params: DeployParams = {}) => {
            const deps = getDeployDeps?.();
            if (!deps) {
                return { success: false, error: 'Раскатка недоступна: хранилище или привязки не инициализированы.' };
            }
            return runForConfiguration(params, 'process', 'agent.deploy', (configRoot) =>
                new AgentDeployOperations(deps).deploy({ ...params, configPath: configRoot }));
        }
    );

    // ─── 1c-metadata-tree.agent.deploySelectedObjects ────────────────────

    const deploySelectedObjectsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deploySelectedObjects',
        async (params: DeploySelectedObjectsParams) => {
            const deps = getDeployDeps?.();
            if (!deps) {
                return { success: false, error: 'Раскатка недоступна: хранилище или привязки не инициализированы.' };
            }
            return runForConfiguration(params, 'process', 'agent.deploySelectedObjects', (configRoot) =>
                new AgentDeployOperations(deps).deploySelectedObjects({ ...params, configPath: configRoot }));
        }
    );

    // ─── 1c-metadata-tree.agent.deployChangedFiles ───────────────────────

    const deployChangedFilesCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deployChangedFiles',
        async (params: DeployChangedFilesParams = {}) => {
            const deps = getDeployDeps?.();
            if (!deps) {
                return { success: false, error: 'Раскатка недоступна: хранилище или привязки не инициализированы.' };
            }
            return runForConfiguration(params, 'process', 'agent.deployChangedFiles', (configRoot) =>
                new AgentDeployOperations(deps).deployChangedFiles({ ...params, configPath: configRoot }));
        }
    );

    // ─── 1c-metadata-tree.agent.pullSelectedObjects ──────────────────────

    const pullSelectedObjectsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.pullSelectedObjects',
        async (params: AgentPullParams) => {
            const deps = getDeployDeps?.();
            if (!deps) {
                return { success: false, error: 'Выгрузка недоступна: хранилище или привязки не инициализированы.' };
            }
            return runForConfiguration(params, 'process', 'agent.pullSelectedObjects', (configRoot) =>
                new AgentDeployOperations(deps).pullSelectedObjects({ ...params, configPath: configRoot }));
        }
    );

    // ─── 1c-metadata-tree.agent.exportStatus ─────────────────────────────

    const exportStatusCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.exportStatus',
        async (params: ExportStatusAgentParams = {}) => {
            const deps = getDeployDeps?.();
            if (!deps) {
                return { success: false, error: 'Статус недоступен: хранилище или привязки не инициализированы.' };
            }
            return runForConfiguration(params, 'process', undefined, (configRoot) =>
                new AgentDeployOperations(deps).exportStatus({ ...params, configPath: configRoot }));
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
            return runForConfiguration(params, 'write', 'agent.setType', async (configRoot) => {
                const result = await new AgentOperations(configRoot).setType(params);
                if (result.success) { getTreeDataProvider()?.refresh(); }
                return result;
            });
        }
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

    // ─── 1C Forms output channel (однократно для всей группы forms.*) ─────────

    const formsOutputChannel = vscode.window.createOutputChannel('CDT 41: 1C Forms');
    context.subscriptions.push(formsOutputChannel);

    // ─── 1c-metadata-tree.agent.forms.start ──────────────────────────────────

    const formsStartCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.start',
        async (params: FormsStartParams) => {
            const ops = new FormsOperations({
                extensionPath: context.extensionPath,
                outputChannel: formsOutputChannel,
            });
            return await ops.formsStart(params);
        }
    );

    // ─── 1c-metadata-tree.agent.forms.exec ───────────────────────────────────

    const formsExecCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.exec',
        async (params: FormsExecParams) => {
            const ops = new FormsOperations({
                extensionPath: context.extensionPath,
                outputChannel: formsOutputChannel,
            });
            return await ops.formsExec(params);
        }
    );

    // ─── 1c-metadata-tree.agent.forms.stop ───────────────────────────────────

    const formsStopCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.stop',
        async (params: FormsStopParams = {}) => {
            const ops = new FormsOperations({
                extensionPath: context.extensionPath,
                outputChannel: formsOutputChannel,
            });
            return await ops.formsStop(params);
        }
    );

    // ─── 1c-metadata-tree.agent.forms.shot ───────────────────────────────────

    const formsShotCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.shot',
        async (params: FormsShotParams = {}) => {
            const ops = new FormsOperations({
                extensionPath: context.extensionPath,
                outputChannel: formsOutputChannel,
            });
            return await ops.formsShot(params);
        }
    );

    // ─── 1c-metadata-tree.agent.forms.status ─────────────────────────────────

    const formsStatusCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.forms.status',
        async (params: FormsStatusParams = {}) => {
            const ops = new FormsOperations({
                extensionPath: context.extensionPath,
                outputChannel: formsOutputChannel,
            });
            return await ops.formsStatus(params);
        }
    );

    // ─── 1c-metadata-tree.agent.skd.compile ──────────────────────────────────

    const skdCompileCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.compile',
        async (params: SkdCompileParams) => {
            const ops = new SkdOperations({ extensionPath: context.extensionPath });
            return await ops.skdCompile(params);
        }
    );

    // ─── 1c-metadata-tree.agent.skd.info ─────────────────────────────────────

    const skdInfoCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.info',
        async (params: SkdInfoParams) => {
            const ops = new SkdOperations({ extensionPath: context.extensionPath });
            return await ops.skdInfo(params);
        }
    );

    // ─── 1c-metadata-tree.agent.skd.edit ─────────────────────────────────────

    const skdEditCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.edit',
        async (params: SkdEditParams) => {
            const ops = new SkdOperations({ extensionPath: context.extensionPath });
            return await ops.skdEdit(params);
        }
    );

    // ─── 1c-metadata-tree.agent.skd.validate ─────────────────────────────────

    const skdValidateCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.validate',
        async (params: SkdValidateParams) => {
            const ops = new SkdOperations({ extensionPath: context.extensionPath });
            return await ops.skdValidate(params);
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
        async (params: AgentSupportSetObjectModeParams) => {
            return supportOperations()?.supportSetObjectMode(params) ?? supportUnavailable();
        }
    );

    const supportEnableObjectRulesCommand = vscode.commands.registerCommand(
        AGENT_SUPPORT_COMMAND_IDS.enableObjectRules,
        async (params: AgentSupportEnableObjectRulesParams) => {
            return supportOperations()?.supportEnableObjectRules(params) ?? supportUnavailable();
        }
    );

    const supportSyncCommand = vscode.commands.registerCommand(
        AGENT_SUPPORT_COMMAND_IDS.sync,
        async (params: AgentSupportSyncParams) => {
            return supportOperations()?.supportSync(params) ?? supportUnavailable();
        }
    );

    const supportVerifyCommand = vscode.commands.registerCommand(
        AGENT_SUPPORT_COMMAND_IDS.verify,
        async (params: AgentSupportVerifyParams) => {
            return supportOperations()?.supportVerify(params) ?? supportUnavailable();
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
        async (params: { srcPath: string; outDir?: string; format?: 'Hierarchical' | 'Plain' }) => {
            const { agentDumpExternalProcessor } = await import('./agentExternalProcessorOperations');
            return agentDumpExternalProcessor(params);
        }
    );

    const buildExternalProcessorCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.buildExternalProcessor',
        async (params: { srcDir: string; dstPath?: string; format?: 'Hierarchical' | 'Plain' }) => {
            const { agentBuildExternalProcessor } = await import('./agentExternalProcessorOperations');
            return agentBuildExternalProcessor(params);
        }
    );

    context.subscriptions.push(
        listConfigurationsCommand,
        createObjectCommand, getYamlCommand, listObjectsCommand, getPropertiesCommand,
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
        deployCommand,
        deploySelectedObjectsCommand, deployChangedFilesCommand,
        pullSelectedObjectsCommand, exportStatusCommand,
        getTypeCommand, setTypeCommand,
        getSubsystemCommandInterfaceCommand, setSubsystemCommandVisibilityCommand,
        setSubsystemCommandOrderCommand, setSubsystemSubsystemsOrderCommand,
        listPredefinedCharacteristicsCommand,
        getPredefinedCharacteristicTypeCommand,
        setPredefinedCharacteristicTypeCommand,
        getCharacteristicValueRegistersCommand,
        formsStartCommand, formsExecCommand, formsStopCommand,
        formsShotCommand, formsStatusCommand,
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
