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
    );
}
