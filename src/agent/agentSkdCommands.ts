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
import type { SkdOperationsDeps } from './agentSkdOperations';
import type { SkdConfigurationSelector } from './agentSkdTypes';

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
    readonly runPowerShellScript?: SkdOperationsDeps['runPowerShellScript'];
}

export function registerAgentSkdCommands(deps: AgentSkdCommandsDeps): vscode.Disposable[] {
    const { extensionPath, taskManager, runForConfiguration, requestConfigurationReload, runPowerShellScript } = deps;

    const runSkdAgentOperation = async <T>(
        params: ConfigurationScopedParams & SkdConfigurationSelector & { readonly background?: boolean },
        name: string,
        capability: keyof ConfigurationIdentity['capabilities'],
        mutationKind: string | undefined,
        reloadAfterCommit: boolean,
        operation: (configRoot: string, token?: vscode.CancellationToken, reportStage?: (message: string) => void) => Promise<AgentResult<T>>,
        requestToken?: vscode.CancellationToken,
    ): Promise<AgentResult<unknown>> => {
        const run = async (token?: vscode.CancellationToken, reportStage?: (message: string) => void) => {
            let configRoot: string | undefined;
            const result = await runForConfiguration(params, capability, mutationKind, async (resolvedRoot) => {
                configRoot = resolvedRoot;
                return operation(resolvedRoot, token, reportStage);
            }, token);
            if (result.success && reloadAfterCommit && configRoot && requestConfigurationReload) {
                try {
                    await requestConfigurationReload(configRoot, 'agent-mutation');
                    return { ...result, reconciliation: { status: 'succeeded' as const } };
                } catch (error) {
                    const reconciliation: NonNullable<AgentResult['reconciliation']> = {
                        status: 'failed',
                        code: errorCode(error),
                        message: error instanceof Error ? error.message : String(error),
                    };
                    return {
                        ...result,
                        reconciliation,
                    };
                }
            }
            return result;
        };
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
                true,
                (configRoot, token, reportStage) => {
                    const ops = new SkdOperations({
                        extensionPath,
                        configRoot,
                        runPowerShellScript,
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
                params.outFile ? 'write' : 'read',
                params.outFile ? 'agent.skd.info.report' : undefined,
                false,
                (configRoot, token, reportStage) => {
                    const ops = new SkdOperations({
                        extensionPath,
                        configRoot,
                        runPowerShellScript,
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
                true,
                (configRoot, token, reportStage) => {
                    const ops = new SkdOperations({
                        extensionPath,
                        configRoot,
                        runPowerShellScript,
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
                params.outFile ? 'write' : 'read',
                params.outFile ? 'agent.skd.validate.report' : undefined,
                false,
                (configRoot, token, reportStage) => {
                    const ops = new SkdOperations({
                        extensionPath,
                        configRoot,
                        runPowerShellScript,
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

function errorCode(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'CONFIGURATION_RELOAD_FAILED';
}
