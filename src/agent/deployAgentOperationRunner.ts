import * as vscode from 'vscode';
import type { ConfigurationIdentity } from '../services/configurationSession/types';
import type { AgentResolutionContext, AgentResult, ConfigurationScopedParams } from './types';
import type { AgentTaskManager } from './agentTaskManager';

type RunForConfiguration = <T>(
  params: ConfigurationScopedParams,
  capability: keyof ConfigurationIdentity['capabilities'],
  mutationKind: string | undefined,
  operation: (configRoot: string, context: AgentResolutionContext) => Promise<AgentResult<T>>,
  cancellation?: vscode.CancellationToken,
) => Promise<AgentResult<T>>;

type DeployOperation<T> = (
  configRoot: string,
  token?: vscode.CancellationToken,
  reportStage?: (message: string) => void,
) => Promise<AgentResult<T>>;

type PostCommitHook<T> = (
  result: AgentResult<T>,
  configRoot: string,
) => Promise<AgentResult<T>>;

export function createDeployAgentOperationRunner(
  runForConfiguration: RunForConfiguration,
  taskManager: Pick<AgentTaskManager, 'start'>,
) {
  return async function runDeployAgentOperation<T>(
    params: ConfigurationScopedParams & { readonly background?: boolean },
    name: string,
    mutationKind: string | undefined,
    operation: DeployOperation<T>,
    requestToken?: vscode.CancellationToken,
    postCommit?: PostCommitHook<T>,
  ): Promise<AgentResult<unknown>> {
    const run = async (token?: vscode.CancellationToken, reportStage?: (message: string) => void): Promise<AgentResult<T>> => {
      let resolvedConfigRoot: string | undefined;
      const result = await runForConfiguration(
        params,
        'process',
        mutationKind,
        (configRoot) => {
          resolvedConfigRoot = configRoot;
          return operation(configRoot, token, reportStage);
        },
        token,
      );
      if (
        postCommit
        && result.success
        && result.configurationId
        && result.operationId
        && typeof result.snapshotVersion === 'number'
        && resolvedConfigRoot
      ) {
        return postCommit(result, resolvedConfigRoot);
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
}
