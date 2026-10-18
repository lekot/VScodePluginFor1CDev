// src/agent/agentSkdCommands.ts
// Registration and routing for Agent SKD API commands (#352, #267).

import * as vscode from 'vscode';
import { SkdOperations } from './agentSkdOperations';
import type {
    SkdCompileParams,
    SkdEditParams,
    SkdInfoParams,
    SkdValidateParams,
} from './agentSkdTypes';
import type { AgentResult, ConfigurationScopedParams, AgentResolutionContext } from './types';
import type { AgentTaskManager } from './agentTaskManager';
import type { ConfigurationIdentity } from '../services/configurationSession/types';
import type { RequestConfigurationReload } from '../reload/requestConfigurationReload';

export interface AgentSkdCommandsDeps {
    readonly extensionPath: string;
    readonly taskManager: AgentTaskManager;
    readonly runForConfiguration: <T>(
        params: ConfigurationScopedParams,
        capability: keyof ConfigurationIdentity['capabilities'],
        mutationKind: string | undefined,
        operation: (configRoot: string, context: AgentResolutionContext) => Promise<AgentResult<T>>,
        cancellation?: vscode.CancellationToken,
    ) => Promise<AgentResult<T>>;
    readonly requestConfigurationReload?: RequestConfigurationReload;
}

export function registerAgentSkdCommands(deps: AgentSkdCommandsDeps): vscode.Disposable[] {
    const { extensionPath, taskManager, runForConfiguration, requestConfigurationReload } = deps;

    const runSkdAgentOperation = async <T>(
        params: ConfigurationScopedParams & { readonly background?: boolean },
        name: string,
        capability: keyof ConfigurationIdentity['capabilities'],
        mutationKind: string | undefined,
        operation: (configRoot: string, token?: vscode.CancellationToken, reportStage?: (message: string) => void) => Promise<AgentResult<T>>,
        requestToken?: vscode.CancellationToken,
    ): Promise<AgentResult<unknown>> => {
        const run = (token?: vscode.CancellationToken, reportStage?: (message: string) => void) =>
            runForConfiguration(params, capability, mutationKind, async (configRoot) => {
                const result = await operation(configRoot, token, reportStage);
                if (result.success && mutationKind && requestConfigurationReload) {
                    await requestConfigurationReload(configRoot, 'agent-mutation').catch(() => {
                        // Keep mutation result even if reload notification fails
                    });
                }
                return result;
            }, token);
        if (params.background === true) {
            return taskManager.start(name, async (token, reportStage) => {
                reportStage(`Начата операция ${name}.`);
                return run(token, reportStage);
            });
        }
        return run(requestToken);
    };

    const skdCompileCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.compile',
        async (params: SkdCompileParams, requestToken?: vscode.CancellationToken) => {
            return runSkdAgentOperation(
                params,
                'agent.skd.compile',
                'write',
                'agent.skd.compile',
                (configRoot, token, reportStage) => {
                    const ops = new SkdOperations({
                        extensionPath,
                        configRoot,
                    });
                    return ops.skdCompile(params, token, reportStage);
                },
                requestToken,
            );
        },
    );

    const skdInfoCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.info',
        async (params: SkdInfoParams, requestToken?: vscode.CancellationToken) => {
            return runSkdAgentOperation(
                params,
                'agent.skd.info',
                'read',
                undefined,
                (configRoot, token, reportStage) => {
                    const ops = new SkdOperations({
                        extensionPath,
                        configRoot,
                    });
                    return ops.skdInfo(params, token, reportStage);
                },
                requestToken,
            );
        },
    );

    const skdEditCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.edit',
        async (params: SkdEditParams, requestToken?: vscode.CancellationToken) => {
            return runSkdAgentOperation(
                params,
                'agent.skd.edit',
                'write',
                'agent.skd.edit',
                (configRoot, token, reportStage) => {
                    const ops = new SkdOperations({
                        extensionPath,
                        configRoot,
                    });
                    return ops.skdEdit(params, token, reportStage);
                },
                requestToken,
            );
        },
    );

    const skdValidateCommand = vscode.commands.registerCommand(
        '1c-metadata-tree.agent.skd.validate',
        async (params: SkdValidateParams, requestToken?: vscode.CancellationToken) => {
            return runSkdAgentOperation(
                params,
                'agent.skd.validate',
                'read',
                undefined,
                (configRoot, token, reportStage) => {
                    const ops = new SkdOperations({
                        extensionPath,
                        configRoot,
                    });
                    return ops.skdValidate(params, token, reportStage);
                },
                requestToken,
            );
        },
    );

    return [
        skdCompileCommand,
        skdInfoCommand,
        skdEditCommand,
        skdValidateCommand,
    ];
}
