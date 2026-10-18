// src/agent/agentDeployOperations.ts
// Agent API — операции раскатки конфигурации в информационные базы.
// Presentation/transport adapter over DeployApplicationService (#255).

import * as vscode from 'vscode';
import { BindingManager } from '../bindings/bindingManager';
import { InfobaseStorageService } from '../infobases/infobaseStorageService';
import {
    DeployService,
    type DeploySupportContext,
} from '../bindings/deployService';
import type { ProcessTreeTerminationOutcome } from '../services/ibcmd/processTreeTermination';
import type { ConfigurationBinding } from '../bindings/models/configurationBinding';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import { MetadataType, type TreeNode } from '../models/treeNode';
import type { AgentResult, ConfigurationScopedParams } from './types';
import {
    DeployApplicationService,
    type DeployOutcome,
    type DeployResultData,
    type ResolvedDeployContext,
} from '../bindings/deployApplicationService';
import type { RequestConfigurationReload } from '../reload/requestConfigurationReload';

export interface AgentDeployOperationsDeps {
    bindingManager: BindingManager;
    infobaseStorage: InfobaseStorageService;
    getConfigPath: () => string | null;
    /**
     * Composition-root seam. Must resolve the exact registered configuration
     * identity and expose only the public support facade.
     */
    resolveSupportContext?: (configRoot: string) => Promise<DeploySupportContext | undefined>;
    deployService?: DeployService;
    runConfigurationMutation?: <T>(resourcePath: string, kind: string, operation: () => Promise<T>) => Promise<T>;
    requestConfigurationReload?: RequestConfigurationReload;
}

export interface DeployParams extends ConfigurationScopedParams {
    /** Путь к каталогу конфигурации. Если не задан — берётся из дерева метаданных. */
    configPath?: string;
    /** Запустить работу в фоне и вернуть task receipt. */
    background?: boolean;
}

export { type DeployResultData } from '../bindings/deployApplicationService';

export interface DeploySelectedObjectsParams extends ConfigurationScopedParams {
    configPath?: string;
    /** Относительные пути файлов (от корня конфигурации, forward slashes). */
    files: string[];
    background?: boolean;
}

export interface DeployChangedFilesParams extends ConfigurationScopedParams {
    configPath?: string;
    background?: boolean;
}

export interface PullSelectedObjectsParams extends ConfigurationScopedParams {
    configPath?: string;
    /** ID объектов в формате 'Type.Name', например 'Catalog.Справочник55'. */
    objectIds: string[];
    /** Если несколько баз — можно указать имя. Иначе — первая привязанная. */
    infobaseName?: string;
    background?: boolean;
}

export interface ExportStatusAgentParams extends ConfigurationScopedParams {
    configPath?: string;
    background?: boolean;
}

interface AgentDeployExecutionOptions {
    readonly token?: vscode.CancellationToken;
    readonly reportStage?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Resolved deploy context — shared by legacy monkey-patching and adapter
// ---------------------------------------------------------------------------

interface DeployContext {
    configRoot: string;
    binding: ConfigurationBinding;
    entries: InfobaseEntry[];
    catalog: InfobaseEntry[];
    workspaceFolderRoot: string;
}

export class AgentDeployOperations {
    private readonly appService: DeployApplicationService;

    constructor(deps: AgentDeployOperationsDeps) {
        this.appService = new DeployApplicationService({
            bindingManager: deps.bindingManager,
            infobaseStorage: deps.infobaseStorage,
            getConfigPath: deps.getConfigPath,
            resolveSupportContext: deps.resolveSupportContext
                ? (configRoot) => deps.resolveSupportContext!(configRoot)
                : undefined,
            deployService: deps.deployService,
            runConfigurationMutation: deps.runConfigurationMutation,
            requestConfigurationReload: deps.requestConfigurationReload,
        });
    }

    // -------------------------------------------------------------------------
    // Helper: resolve configPath → workspace → binding → catalog
    // -------------------------------------------------------------------------

    private async resolveDeployContext(configPath?: string): Promise<AgentResult<DeployContext>> {
        const plan = await this.appService.prepareDeploy({
            kind: 'path',
            path: configPath,
            allowFuzzyMatch: true,
        });
        if (!plan.ok) {
            return { success: false, error: plan.error, code: plan.code };
        }
        return {
            success: true,
            data: {
                configRoot: plan.context.configRoot,
                binding: plan.context.binding,
                entries: plan.context.deployTargets,
                catalog: plan.context.catalog,
                workspaceFolderRoot: plan.context.workspaceFolderRoot,
            },
        };
    }

    // -------------------------------------------------------------------------
    // deploy — полная раскатка конфигурации
    // -------------------------------------------------------------------------

    async deploy(params: DeployParams, execution: AgentDeployExecutionOptions = {}): Promise<AgentResult<DeployResultData>> {
        try {
            const ctx = await this.resolveDeployContext(params.configPath);
            if (!ctx.success) {
                return { success: false, error: ctx.error, code: ctx.code };
            }
            const { binding, catalog, workspaceFolderRoot, configRoot, entries } = ctx.data!;
            const context: ResolvedDeployContext = {
                configRoot,
                workspaceFolder: { uri: vscode.Uri.file(workspaceFolderRoot), name: binding.workspaceFolder, index: 0 },
                workspaceFolderRoot,
                binding,
                catalog,
                deployTargets: entries,
                skippedTargets: [],
                previewLabels: [],
            };
            const outcome = await this.appService.executeDeployBinding(context, execution);
            return deployOutcomeToAgentResult(outcome);
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // -------------------------------------------------------------------------
    // deploySelectedObjects — раскатка конкретных файлов
    // -------------------------------------------------------------------------

    async deploySelectedObjects(params: DeploySelectedObjectsParams, execution: AgentDeployExecutionOptions = {}): Promise<AgentResult<DeployResultData>> {
        try {
            const ctx = await this.resolveDeployContext(params.configPath);
            if (!ctx.success) {
                return { success: false, error: ctx.error, code: ctx.code };
            }
            const { binding, catalog, workspaceFolderRoot, configRoot, entries } = ctx.data!;

            if (!params.files || params.files.length === 0) {
                return { success: false, error: 'Список файлов не задан.' };
            }

            const context: ResolvedDeployContext = {
                configRoot,
                workspaceFolder: { uri: vscode.Uri.file(workspaceFolderRoot), name: binding.workspaceFolder, index: 0 },
                workspaceFolderRoot,
                binding,
                catalog,
                deployTargets: entries,
                skippedTargets: [],
                previewLabels: [],
            };

            const outcome = await this.appService.executeDeployChangedFiles(context, params.files, execution);
            return deployOutcomeToAgentResult(outcome);
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // -------------------------------------------------------------------------
    // deployChangedFiles — раскатка изменённых файлов по git
    // -------------------------------------------------------------------------

    async deployChangedFiles(params: DeployChangedFilesParams, execution: AgentDeployExecutionOptions = {}): Promise<AgentResult<DeployResultData>> {
        try {
            const ctx = await this.resolveDeployContext(params.configPath);
            if (!ctx.success) {
                return { success: false, error: ctx.error, code: ctx.code };
            }
            const { configRoot, binding, catalog, workspaceFolderRoot, entries } = ctx.data!;
            const context: ResolvedDeployContext = {
                configRoot,
                workspaceFolder: { uri: vscode.Uri.file(workspaceFolderRoot), name: binding.workspaceFolder, index: 0 },
                workspaceFolderRoot,
                binding,
                catalog,
                deployTargets: entries,
                skippedTargets: [],
                previewLabels: [],
            };

            const detected = await this.appService.detectChangedFiles(context);
            if (!detected.ok) {
                return { success: false, error: detected.error };
            }
            if (detected.relativePaths.length === 0) {
                return {
                    success: true,
                    data: {
                        summary: { success: 0, error: 0, inDoubt: 0, skipped: 0, hasPartial: false },
                        results: [],
                    },
                    error: 'Нет изменённых файлов.',
                };
            }

            const outcome = await this.appService.executeDeployChangedFiles(context, detected.relativePaths, execution);
            return deployOutcomeToAgentResult(outcome);
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // -------------------------------------------------------------------------
    // pullSelectedObjects — выгрузка объектов из ИБ
    // -------------------------------------------------------------------------

    async pullSelectedObjects(params: PullSelectedObjectsParams, execution: AgentDeployExecutionOptions = {}): Promise<AgentResult<DeployResultData>> {
        try {
            const ctx = await this.resolveDeployContext(params.configPath);
            if (!ctx.success) {
                return { success: false, error: ctx.error, code: ctx.code };
            }
            const { binding, entries, workspaceFolderRoot, configRoot, catalog } = ctx.data!;

            if (!params.objectIds || params.objectIds.length === 0) {
                return { success: false, error: 'Список objectIds не задан.' };
            }

            // Select target infobase entry
            let selectedEntry: InfobaseEntry | undefined;
            if (params.infobaseName) {
                const nameLower = params.infobaseName.toLowerCase();
                selectedEntry = entries.find((e) => e.name.toLowerCase() === nameLower);
                if (!selectedEntry) {
                    return {
                        success: false,
                        error: `База с именем «${params.infobaseName}» не найдена среди привязанных.`,
                    };
                }
            } else {
                selectedEntry = entries[0];
            }

            if (!selectedEntry) {
                return { success: false, error: 'Нет доступных баз для выгрузки.' };
            }

            // Build minimal TreeNode list from objectIds
            const nodes: TreeNode[] = params.objectIds.map((id) => {
                const dotIdx = id.indexOf('.');
                const type = dotIdx >= 0 ? id.substring(0, dotIdx) : id;
                const name = dotIdx >= 0 ? id.substring(dotIdx + 1) : '';
                return { id, name, type: type as MetadataType, properties: {} };
            });

            const context: ResolvedDeployContext = {
                configRoot,
                workspaceFolder: { uri: vscode.Uri.file(workspaceFolderRoot), name: binding.workspaceFolder, index: 0 },
                workspaceFolderRoot,
                binding,
                catalog,
                deployTargets: entries,
                skippedTargets: [],
                previewLabels: [],
            };

            const outcome = await this.appService.executePullSelectedObjects(context, nodes, {
                ...execution,
                entry: selectedEntry,
            });
            return deployOutcomeToAgentResult(outcome);
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // -------------------------------------------------------------------------
    // exportStatus — статус конфигурации через ibcmd export status
    // -------------------------------------------------------------------------

    async exportStatus(
        params: ExportStatusAgentParams,
        execution: AgentDeployExecutionOptions = {},
    ): Promise<AgentResult<{
        message: string;
        status: 'success' | 'cancelled' | 'inDoubt' | 'error';
        effectPossible?: boolean;
        termination?: ProcessTreeTerminationOutcome;
    }>> {
        try {
            const ctx = await this.resolveDeployContext(params.configPath);
            if (!ctx.success) {
                return { success: false, error: ctx.error };
            }
            const { configRoot, binding, entries, workspaceFolderRoot, catalog } = ctx.data!;

            const context: ResolvedDeployContext = {
                configRoot,
                workspaceFolder: { uri: vscode.Uri.file(workspaceFolderRoot), name: binding.workspaceFolder, index: 0 },
                workspaceFolderRoot,
                binding,
                catalog,
                deployTargets: entries,
                skippedTargets: [],
                previewLabels: [],
            };

            const result = await this.appService.executeExportStatus(context, execution);

            return {
                success: result.success,
                code: result.code,
                data: {
                    message: result.message,
                    status: result.status,
                    effectPossible: result.effectPossible,
                    termination: result.termination,
                },
                error: result.error,
            };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
}

function deployOutcomeToAgentResult(outcome: DeployOutcome): AgentResult<DeployResultData> {
    return {
        success: outcome.success,
        code: outcome.code,
        data: outcome.data,
        error: outcome.error,
    };
}
