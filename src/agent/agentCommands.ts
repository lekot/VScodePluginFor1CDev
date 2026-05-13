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

/**
 * Регистрирует Agent API команды.
 *
 * @param context - ExtensionContext для подписок.
 * @param getTreeDataProvider - Геттер провайдера дерева (может быть null до инициализации).
 * @param getConfigRoot - Асинхронный геттер пути к корню конфигурации.
 * @param debugRegistry - Реестр отладочных сессий.
 * @param getDebugDeps - Опциональный геттер зависимостей для debug.startFromBinding.
 */
export function registerAgentCommands(
    context: vscode.ExtensionContext,
    getTreeDataProvider: () => MetadataTreeDataProvider | null,
    getConfigRoot: () => Promise<string | null>,
    debugRegistry: DebugSessionRegistry,
    getDebugDeps?: () => AgentDebugOperationsDeps | undefined,
    getDeployDeps?: () => AgentDeployOperationsDeps | undefined,
): void {
    // ─── 1c-metadata-tree.agent.createObject ─────────────────────────────────

    const createObjectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.createObject',
        async (params: CreateObjectParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            const result = await ops.createObject(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    // ─── 1c-metadata-tree.agent.getYaml ──────────────────────────────────────

    const getYamlCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getYaml',
        async (params: GetYamlParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            return await ops.getYaml(params);
        }
    );

    // ─── 1c-metadata-tree.agent.listObjects ──────────────────────────────────

    const listObjectsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.listObjects',
        async (params: ListObjectsParams = {}) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            return await ops.listObjects(params);
        }
    );

    // ─── 1c-metadata-tree.agent.getProperties ────────────────────────────────

    const getPropertiesCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getProperties',
        async (params: GetPropertiesParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            return await ops.getProperties(params);
        }
    );

    // ─── 1c-metadata-tree.agent.addAttribute ─────────────────────────────────

    const addAttributeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.addAttribute',
        async (params: AddAttributeParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            const result = await ops.addAttribute(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    // ─── 1c-metadata-tree.agent.addTabularSection ────────────────────────────

    const addTabularSectionCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.addTabularSection',
        async (params: AddTabularSectionParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            const result = await ops.addTabularSection(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    // ─── 1c-metadata-tree.agent.addTabularSectionColumn ──────────────────────

    const addTabularSectionColumnCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.addTabularSectionColumn',
        async (params: AddTabularSectionColumnParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            const result = await ops.addTabularSectionColumn(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    // ─── 1c-metadata-tree.agent.deleteAttribute ──────────────────────────────

    const deleteAttributeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deleteAttribute',
        async (params: DeleteAttributeParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            const result = await ops.deleteAttribute(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    // ─── 1c-metadata-tree.agent.deleteTabularSection ─────────────────────────

    const deleteTabularSectionCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deleteTabularSection',
        async (params: DeleteTabularSectionParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            const result = await ops.deleteTabularSection(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    // ─── 1c-metadata-tree.agent.deleteObject ─────────────────────────────────

    const deleteObjectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.deleteObject',
        async (params: DeleteObjectParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            const result = await ops.deleteObject(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    // ─── 1c-metadata-tree.agent.renameObject ─────────────────────────────────

    const renameObjectCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.renameObject',
        async (params: RenameObjectParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            const result = await ops.renameObject(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    // ─── 1c-metadata-tree.agent.setProperties ────────────────────────────────

    const setPropertiesCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setProperties',
        async (params: SetPropertiesParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            const result = await ops.setProperties(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
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
            const ops = new AgentDeployOperations(deps);
            return await ops.deploy(params);
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
            const ops = new AgentDeployOperations(deps);
            return await ops.deploySelectedObjects(params);
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
            const ops = new AgentDeployOperations(deps);
            return await ops.deployChangedFiles(params);
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
            const ops = new AgentDeployOperations(deps);
            return await ops.pullSelectedObjects(params);
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
            const ops = new AgentDeployOperations(deps);
            return await ops.exportStatus(params);
        }
    );

    // ─── 1c-metadata-tree.agent.getType ─────────────────────────────────

    const getTypeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getType',
        async (params: GetTypeParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            return await ops.getType(params);
        }
    );

    // ─── 1c-metadata-tree.agent.setType ─────────────────────────────────

    const setTypeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setType',
        async (params: SetTypeParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new AgentOperations(configRoot);
            const result = await ops.setType(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    const getSubsystemCommandInterfaceCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getSubsystemCommandInterface',
        async (params: { subsystemPath: string }) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new CommandInterfaceOperations(configRoot);
            return await ops.getCommandInterface(params.subsystemPath);
        }
    );

    const setSubsystemCommandVisibilityCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setSubsystemCommandVisibility',
        async (params: { subsystemPath: string; commandName: string; common: CommandVisibility | null }) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new CommandInterfaceOperations(configRoot);
            return await ops.setCommandVisibility(params.subsystemPath, params.commandName, params.common);
        }
    );

    const setSubsystemCommandOrderCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setSubsystemCommandOrder',
        async (params: { subsystemPath: string; entries: CommandOrderEntry[] }) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new CommandInterfaceOperations(configRoot);
            return await ops.setCommandOrder(params.subsystemPath, params.entries);
        }
    );

    const setSubsystemSubsystemsOrderCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setSubsystemSubsystemsOrder',
        async (params: { subsystemPath: string; order: string[] }) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new CommandInterfaceOperations(configRoot);
            return await ops.setSubsystemsOrder(params.subsystemPath, params.order);
        }
    );

    const listPredefinedCharacteristicsCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.listPredefinedCharacteristics',
        async (params: CotPathParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            try {
                const data = await listPredefinedCharacteristics(configRoot, params.path);
                return { success: true, data };
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        }
    );

    const getPredefinedCharacteristicTypeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getPredefinedCharacteristicType',
        async (params: PredefinedCotPathParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            try {
                const data = await getPredefinedCharacteristicType(configRoot, params.path, params.predefinedName);
                return { success: true, data };
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        }
    );

    const setPredefinedCharacteristicTypeCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.setPredefinedCharacteristicType',
        async (params: SetPredefinedCotTypeParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            try {
                await setPredefinedCharacteristicType(configRoot, params.path, params.predefinedName, params.types);
                return { success: true };
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        }
    );

    const getCharacteristicValueRegistersCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.getCharacteristicValueRegisters',
        async (params: CotPathParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            try {
                const data = await getCharacteristicValueRegisters(configRoot, params.path);
                return { success: true, data };
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
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
        async () => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new XdtoAgentOperations(configRoot);
            return await ops.listPackages();
        }
    );

    const getXdtoPackageCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.getPackage',
        async (params: XdtoGetPackageParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new XdtoAgentOperations(configRoot);
            return await ops.getPackage(params);
        }
    );

    const exportXdtoXsdCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.exportXsd',
        async (params: XdtoExportXsdParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new XdtoAgentOperations(configRoot);
            return await ops.exportXsd(params);
        }
    );

    const importXdtoXsdCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.importXsd',
        async (params: XdtoImportXsdParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new XdtoAgentOperations(configRoot);
            const result = await ops.importXsd(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    const createXdtoFromXsdCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.createFromXsd',
        async (params: XdtoCreateFromXsdParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new XdtoAgentOperations(configRoot);
            const result = await ops.createFromXsd(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    const compareXdtoPackageCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.compare',
        async (params: XdtoCompareParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new XdtoAgentOperations(configRoot);
            return await ops.compare(params);
        }
    );

    const mergeXdtoPackageCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.xdto.merge',
        async (params: XdtoMergeParams) => {
            const configRoot = await getConfigRoot();
            if (!configRoot) {
                return { success: false, error: 'Корень конфигурации не найден.' };
            }
            const ops = new XdtoAgentOperations(configRoot);
            const result = await ops.merge(params);
            if (result.success) {
                getTreeDataProvider()?.refresh();
            }
            return result;
        }
    );

    context.subscriptions.push(
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
    );
}
