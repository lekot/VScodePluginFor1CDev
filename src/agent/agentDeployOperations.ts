// src/agent/agentDeployOperations.ts
// Agent API — операции раскатки конфигурации в информационные базы.

import * as vscode from 'vscode';
import * as path from 'path';
import { BindingManager } from '../bindings/bindingManager';
import { InfobaseStorageService } from '../infobases/infobaseStorageService';
import {
    DeployService,
    resolveConfigurationXmlDirectory,
    resolveDeployTargetsForBinding,
} from '../bindings/deployService';
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

export class AgentDeployOperations {
    constructor(private readonly deps: AgentDeployOperationsDeps) {}

    async deploy(params: DeployParams): Promise<AgentResult<DeployResultData>> {
        try {
            // 1. Resolve configPath
            const configPath = params.configPath
                ? path.resolve(params.configPath)
                : this.deps.getConfigPath();
            if (!configPath) {
                return {
                    success: false,
                    error: 'Путь к конфигурации не задан. Укажите configPath или откройте конфигурацию в дереве.',
                };
            }

            // 2. Find workspace folder
            let workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(configPath));
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

            const configResolved = norm(configPath);
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

            // 5. Load catalog and resolve targets
            const catalog = await this.deps.infobaseStorage.load();
            const catalogById = new Map(catalog.map((e) => [e.id, e] as const));
            const { entries, skipped } = resolveDeployTargetsForBinding(matchedBinding, catalogById);
            if (entries.length === 0 && skipped.length > 0) {
                return { success: false, error: 'Нет подходящих баз для раскатки (все пропущены).' };
            }
            if (entries.length === 0) {
                return { success: false, error: 'Нет баз для раскатки.' };
            }

            // 6. Create CancellationTokenSource, create no-op progress sink, run deploy
            const cts = new vscode.CancellationTokenSource();
            const noopProgress = { report: () => {} };
            try {
                const deployService = new DeployService();
                const summary = await deployService.deployBinding({
                    binding: matchedBinding,
                    workspaceFolderRoot: workspaceFolder.uri.fsPath,
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
}
