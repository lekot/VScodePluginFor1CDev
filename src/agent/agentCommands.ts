// src/agent/agentCommands.ts
// Agent API — тонкая VS Code обёртка над AgentOperations.
// Регистрирует команды 1c-metadata-tree.agent.* для вызова через executeCommand.

import * as vscode from 'vscode';
import { AgentOperations } from './agentOperations';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import type { CreateObjectParams, GetYamlParams, ListObjectsParams } from './types';

/**
 * Регистрирует Agent API команды.
 *
 * @param context - ExtensionContext для подписок.
 * @param getTreeDataProvider - Геттер провайдера дерева (может быть null до инициализации).
 * @param getConfigRoot - Асинхронный геттер пути к корню конфигурации.
 */
export function registerAgentCommands(
    context: vscode.ExtensionContext,
    getTreeDataProvider: () => MetadataTreeDataProvider | null,
    getConfigRoot: () => Promise<string | null>,
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

    context.subscriptions.push(createObjectCommand, getYamlCommand, listObjectsCommand);
}
