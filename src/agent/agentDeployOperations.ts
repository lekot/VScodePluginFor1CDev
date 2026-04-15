// src/agent/agentDeployOperations.ts
// Agent API — операции раскатки конфигурации в информационные базы.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BindingManager } from '../bindings/bindingManager';
import { InfobaseStorageService } from '../infobases/infobaseStorageService';
import {
    DeployService,
    resolveConfigurationXmlDirectory,
    resolveDeployTargetsForBinding,
} from '../bindings/deployService';
import type { ConfigurationBinding } from '../bindings/models/configurationBinding';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import { MetadataType, type TreeNode } from '../models/treeNode';
import { detectChangedConfigFiles, type IncrementalChangeDetectorDeps } from '../services/ibcmd/incrementalChangeDetector';
import { serializeInfobaseConfigIbcmdOp, runInfobaseConfigExportStatus } from '../infobases/infobaseConfigCommands';
import type { AgentResult } from './types';

export interface AgentDeployOperationsDeps {
    bindingManager: BindingManager;
    infobaseStorage: InfobaseStorageService;
    getConfigPath: () => string | null;
}

export interface DeployParams {
    /** Путь к каталогу конфигурации. Если не задан — берётся из дерева метаданных. */
    configPath?: string;
}

export interface DeployResultData {
    summary: {
        success: number;
        error: number;
        skipped: number;
    };
    results: Array<{
        infobase: string;
        status: string;
        message: string;
    }>;
}

export interface DeploySelectedObjectsParams {
    configPath?: string;
    /** Относительные пути файлов (от корня конфигурации, forward slashes). */
    files: string[];
}

export interface DeployChangedFilesParams {
    configPath?: string;
}

export interface PullSelectedObjectsParams {
    configPath?: string;
    /** ID объектов в формате 'Type.Name', например 'Catalog.Справочник55'. */
    objectIds: string[];
    /** Если несколько баз — можно указать имя. Иначе — первая привязанная. */
    infobaseName?: string;
}

export interface ExportStatusAgentParams {
    configPath?: string;
}

// ---------------------------------------------------------------------------
// Resolved deploy context — shared by all methods
// ---------------------------------------------------------------------------

interface DeployContext {
    configRoot: string;
    binding: ConfigurationBinding;
    entries: InfobaseEntry[];
    catalog: InfobaseEntry[];
    workspaceFolderRoot: string;
}

export class AgentDeployOperations {
    constructor(private readonly deps: AgentDeployOperationsDeps) {}

    // -------------------------------------------------------------------------
    // Private helper: resolve configPath → workspace → binding → catalog
    // -------------------------------------------------------------------------

    private async resolveDeployContext(configPath?: string): Promise<AgentResult<DeployContext>> {
        // 1. Resolve configPath
        const resolvedConfigPath = configPath
            ? path.resolve(configPath)
            : this.deps.getConfigPath();
        if (!resolvedConfigPath) {
            return {
                success: false,
                error: 'Путь к конфигурации не задан. Укажите configPath или откройте конфигурацию в дереве.',
            };
        }

        // 2. Find workspace folder
        let workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(resolvedConfigPath));
        if (!workspaceFolder) {
            workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        }
        if (!workspaceFolder) {
            return { success: false, error: 'Не найдена папка workspace.' };
        }

        // 3. Find matching binding
        const allBindings = await this.deps.bindingManager.listAll();
        const localBindings = allBindings.filter((b) => b.workspaceFolder === workspaceFolder!.name);

        const isWin = process.platform === 'win32';
        const norm = (p: string): string => {
            const r = path.resolve(p);
            return isWin ? r.toLowerCase() : r;
        };

        const configResolved = norm(resolvedConfigPath);
        let matchedBinding: (typeof localBindings)[number] | undefined;
        for (const b of localBindings) {
            const resolved = resolveConfigurationXmlDirectory(workspaceFolder!.uri.fsPath, b.configRelativePath);
            if (!resolved.ok) { continue; }
            const src = norm(resolved.sourceDir);
            if (configResolved === src || configResolved.startsWith(src + path.sep)) {
                matchedBinding = b;
                break;
            }
        }

        // 4. Validate binding
        if (!matchedBinding) {
            return {
                success: false,
                error: 'Для конфигурации не найдена привязка базы. Привяжите базу через «Привязать базы…».',
            };
        }
        if (matchedBinding.infobaseIds.length === 0) {
            return { success: false, error: 'Для конфигурации нет привязанных баз.' };
        }

        // 5. Load catalog and resolve configRoot
        const catalog = await this.deps.infobaseStorage.load();
        const catalogById = new Map(catalog.map((e) => [e.id, e] as const));
        const { entries, skipped } = resolveDeployTargetsForBinding(matchedBinding, catalogById);
        if (entries.length === 0 && skipped.length > 0) {
            return { success: false, error: 'Нет подходящих баз для раскатки (все пропущены).' };
        }
        if (entries.length === 0) {
            return { success: false, error: 'Нет баз для раскатки.' };
        }

        const xmlResolved = resolveConfigurationXmlDirectory(workspaceFolder.uri.fsPath, matchedBinding.configRelativePath);
        if (!xmlResolved.ok) {
            return { success: false, error: xmlResolved.message };
        }

        return {
            success: true,
            data: {
                configRoot: xmlResolved.sourceDir,
                binding: matchedBinding,
                entries,
                catalog,
                workspaceFolderRoot: workspaceFolder.uri.fsPath,
            },
        };
    }

    // -------------------------------------------------------------------------
    // deploy — полная раскатка конфигурации
    // -------------------------------------------------------------------------

    async deploy(params: DeployParams): Promise<AgentResult<DeployResultData>> {
        try {
            const ctx = await this.resolveDeployContext(params.configPath);
            if (!ctx.success) {
                return { success: false, error: ctx.error };
            }
            const { binding, catalog, workspaceFolderRoot } = ctx.data!;

            const cts = new vscode.CancellationTokenSource();
            const noopProgress = { report: () => {} };
            try {
                const deployService = new DeployService();
                const summary = await deployService.deployBinding({
                    binding,
                    workspaceFolderRoot,
                    storage: this.deps.infobaseStorage,
                    catalog,
                    progress: noopProgress,
                    token: cts.token,
                });

                return {
                    success: summary.errorCount === 0 && !summary.cancelledMidChain,
                    data: {
                        summary: {
                            success: summary.successCount,
                            error: summary.errorCount,
                            skipped: summary.skippedCount,
                        },
                        results: summary.results.map((r) => ({
                            infobase: r.name || r.infobaseId,
                            status: r.status,
                            message: r.message,
                        })),
                    },
                    error: summary.errorCount > 0
                        ? `Раскатка завершена с ошибками: ${summary.errorCount}`
                        : undefined,
                };
            } finally {
                cts.dispose();
            }
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // -------------------------------------------------------------------------
    // deploySelectedObjects — раскатка конкретных файлов
    // -------------------------------------------------------------------------

    async deploySelectedObjects(params: DeploySelectedObjectsParams): Promise<AgentResult<DeployResultData>> {
        try {
            const ctx = await this.resolveDeployContext(params.configPath);
            if (!ctx.success) {
                return { success: false, error: ctx.error };
            }
            const { binding, catalog, workspaceFolderRoot } = ctx.data!;

            if (!params.files || params.files.length === 0) {
                return { success: false, error: 'Список файлов не задан.' };
            }

            const cts = new vscode.CancellationTokenSource();
            const noopProgress = { report: () => {} };
            try {
                const deployService = new DeployService();
                const summary = await deployService.deployChangedFiles({
                    binding,
                    workspaceFolderRoot,
                    storage: this.deps.infobaseStorage,
                    catalog,
                    relativeFiles: params.files,
                    progress: noopProgress,
                    token: cts.token,
                });

                return {
                    success: summary.errorCount === 0 && !summary.cancelledMidChain,
                    data: {
                        summary: {
                            success: summary.successCount,
                            error: summary.errorCount,
                            skipped: summary.skippedCount,
                        },
                        results: summary.results.map((r) => ({
                            infobase: r.name || r.infobaseId,
                            status: r.status,
                            message: r.message,
                        })),
                    },
                    error: summary.errorCount > 0
                        ? `Раскатка завершена с ошибками: ${summary.errorCount}`
                        : undefined,
                };
            } finally {
                cts.dispose();
            }
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // -------------------------------------------------------------------------
    // deployChangedFiles — раскатка изменённых файлов по git
    // -------------------------------------------------------------------------

    async deployChangedFiles(params: DeployChangedFilesParams): Promise<AgentResult<DeployResultData>> {
        try {
            const ctx = await this.resolveDeployContext(params.configPath);
            if (!ctx.success) {
                return { success: false, error: ctx.error };
            }
            const { configRoot, binding, catalog, workspaceFolderRoot } = ctx.data!;

            // Build git repository dependency using the VS Code git extension API
            const gitExt = vscode.extensions.getExtension('vscode.git');
            const gitApi = gitExt?.exports?.getAPI(1);
            const gitDeps: IncrementalChangeDetectorDeps = {
                getGitRepository: () => {
                    if (!gitApi) { return undefined; }
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vscode.git extension API is untyped
                    const repos: any[] = gitApi.repositories ?? [];
                    return repos.find((r: { rootUri?: { fsPath?: string } }) => {
                        const rootPath: string = r?.rootUri?.fsPath ?? '';
                        const normalRoot = rootPath.replace(/\\/g, '/').toLowerCase();
                        const normalConfig = configRoot.replace(/\\/g, '/').toLowerCase();
                        return normalConfig.startsWith(normalRoot);
                    }) ?? repos[0];
                },
            };

            const detected = await detectChangedConfigFiles(configRoot, gitDeps);
            if ('error' in detected) {
                return { success: false, error: detected.error };
            }
            if (detected.relativePaths.length === 0) {
                return {
                    success: true,
                    data: { summary: { success: 0, error: 0, skipped: 0 }, results: [] },
                    error: 'Нет изменённых файлов.',
                };
            }

            const cts = new vscode.CancellationTokenSource();
            const noopProgress = { report: () => {} };
            try {
                const deployService = new DeployService();
                const summary = await deployService.deployChangedFiles({
                    binding,
                    workspaceFolderRoot,
                    storage: this.deps.infobaseStorage,
                    catalog,
                    relativeFiles: detected.relativePaths,
                    progress: noopProgress,
                    token: cts.token,
                });

                return {
                    success: summary.errorCount === 0 && !summary.cancelledMidChain,
                    data: {
                        summary: {
                            success: summary.successCount,
                            error: summary.errorCount,
                            skipped: summary.skippedCount,
                        },
                        results: summary.results.map((r) => ({
                            infobase: r.name || r.infobaseId,
                            status: r.status,
                            message: r.message,
                        })),
                    },
                    error: summary.errorCount > 0
                        ? `Раскатка завершена с ошибками: ${summary.errorCount}`
                        : undefined,
                };
            } finally {
                cts.dispose();
            }
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // -------------------------------------------------------------------------
    // pullSelectedObjects — выгрузка объектов из ИБ
    // -------------------------------------------------------------------------

    async pullSelectedObjects(params: PullSelectedObjectsParams): Promise<AgentResult<DeployResultData>> {
        try {
            const ctx = await this.resolveDeployContext(params.configPath);
            if (!ctx.success) {
                return { success: false, error: ctx.error };
            }
            const { binding, entries, workspaceFolderRoot } = ctx.data!;

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

            const cts = new vscode.CancellationTokenSource();
            const noopProgress = { report: () => {} };
            try {
                const deployService = new DeployService();
                const summary = await deployService.pullSelectedObjects({
                    binding,
                    workspaceFolderRoot,
                    storage: this.deps.infobaseStorage,
                    entry: selectedEntry,
                    selectedNodes: nodes,
                    progress: noopProgress,
                    token: cts.token,
                });

                return {
                    success: summary.errorCount === 0 && !summary.cancelledMidChain,
                    data: {
                        summary: {
                            success: summary.successCount,
                            error: summary.errorCount,
                            skipped: summary.skippedCount,
                        },
                        results: summary.results.map((r) => ({
                            infobase: r.name || r.infobaseId,
                            status: r.status,
                            message: r.message,
                        })),
                    },
                    error: summary.errorCount > 0
                        ? `Выгрузка завершена с ошибками: ${summary.errorCount}`
                        : undefined,
                };
            } finally {
                cts.dispose();
            }
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // -------------------------------------------------------------------------
    // exportStatus — статус конфигурации через ibcmd export status
    // -------------------------------------------------------------------------

    async exportStatus(params: ExportStatusAgentParams): Promise<AgentResult<{ message: string }>> {
        try {
            const ctx = await this.resolveDeployContext(params.configPath);
            if (!ctx.success) {
                return { success: false, error: ctx.error };
            }
            const { configRoot, entries } = ctx.data!;

            const configDumpInfoPath = path.join(configRoot, 'ConfigDumpInfo.xml');
            if (!fs.existsSync(configDumpInfoPath)) {
                return {
                    success: false,
                    error: `Файл ConfigDumpInfo.xml не найден в каталоге конфигурации: ${configRoot}`,
                };
            }

            const entry = entries[0]!;

            const cts = new vscode.CancellationTokenSource();
            try {
                const result = await serializeInfobaseConfigIbcmdOp(() =>
                    runInfobaseConfigExportStatus({
                        entry,
                        configDumpInfoPath,
                        storage: this.deps.infobaseStorage,
                        token: cts.token,
                    }),
                );

                return {
                    success: result.status === 'success',
                    data: { message: result.userMessage },
                    error: result.status !== 'success' ? result.userMessage : undefined,
                };
            } finally {
                cts.dispose();
            }
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
}
