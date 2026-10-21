import * as vscode from 'vscode';
import type { ConfigurationIdentity } from '../services/configurationSession/types';
import type { MutationExecutionOptions, MutationOutcome } from '../services/configurationSession/ConfigurationSession';
import type { AgentResolutionContext, AgentResult, ConfigurationScopedParams } from './types';
import type { AgentTaskManager } from './agentTaskManager';
import { hasSuccessfulAgentPullWrite } from './pullReconciliation';

type RunForConfiguration = <T>(
  params: ConfigurationScopedParams,
  capability: keyof ConfigurationIdentity['capabilities'],
  mutationKind: string | undefined,
  operation: (configRoot: string, context: AgentResolutionContext) => Promise<AgentResult<T>>,
  cancellation?: vscode.CancellationToken,
  executionOptions?: MutationExecutionOptions<AgentResult<T>>,
) => Promise<AgentResult<T>>;

type DeployOperation<T> = (
  configRoot: string,
  token?: vscode.CancellationToken,
  reportStage?: (message: string) => void,
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
  ): Promise<AgentResult<unknown>> {
    const run = async (token?: vscode.CancellationToken, reportStage?: (message: string) => void): Promise<AgentResult<T>> => {
      return runForConfiguration(
        params,
        'process',
        mutationKind,
        (configRoot) => operation(configRoot, token, reportStage),
        token,
        {
          reconcile: mutationKind === 'agent.pullSelectedObjects',
          commitWhen: (result) => mutationKind === 'agent.pullSelectedObjects' && hasSuccessfulAgentPullWrite(result),
          shouldReconcile: (outcome) => mutationKind === 'agent.pullSelectedObjects'
            && (outcome.status === 'committed' || isUncertainPullOutcome(outcome)),
        },
      );
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

function isUncertainPullOutcome<T>(outcome: MutationOutcome<AgentResult<T>>): boolean {
  if (outcome.status !== 'failed' || !outcome.value?.data || typeof outcome.value.data !== 'object') {
    return false;
  }
  const data = outcome.value.data as { summary?: { inDoubt?: unknown } };
  return typeof data.summary?.inDoubt === 'number' && data.summary.inDoubt > 0;
}
