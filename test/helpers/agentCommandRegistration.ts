import type * as vscode from 'vscode';
import { AgentTaskManager } from '../../src/agent/agentTaskManager';
import type { AgentDebugOperationsDeps } from '../../src/agent/agentDebugOperations';
import type { AgentDeployOperationsDeps } from '../../src/agent/agentDeployOperations';
import type { AgentSupportOperationsDeps } from '../../src/agent/agentSupportOperations';
import type { SkdOperationsDeps } from '../../src/agent/agentSkdOperations';
import type { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import { registerAgentCommands as registerAgentCommandsWithManager } from '../../src/agent/agentCommands';
import type { RegisterAgentCommandsDependencies } from '../../src/agent/agentCommands';
import type { MetadataTreeDataProvider } from '../../src/providers/treeDataProvider';
import type { ConfigurationRepositoryService } from '../../src/services/configurationRepository/configurationRepositoryService';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import type { RequestConfigurationReload } from '../../src/reload/requestConfigurationReload';

type LegacyAgentCommandRegistrationArgs = [
  context: vscode.ExtensionContext,
  getTreeDataProvider: () => MetadataTreeDataProvider | null,
  getConfigurationRegistry: () => Promise<WorkspaceRegistry>,
  debugRegistry: DebugSessionRegistry,
  getDebugDependencies?: () => AgentDebugOperationsDeps | undefined,
  getDeployDependencies?: () => AgentDeployOperationsDeps | undefined,
  getSupportDependencies?: () => AgentSupportOperationsDeps | undefined,
  refreshCfeLifecycle?: () => Promise<void>,
  getRepositoryService?: () => ConfigurationRepositoryService | null,
  /** Retained only to preserve legacy test call positions; the object API has no such input. */
  _requestConfigurationReload?: RequestConfigurationReload,
  getSkdDependencies?: () => Pick<SkdOperationsDeps, 'runPowerShellScript'> | undefined,
];

/** Creates a stable getter backed by a real empty registry for headless tests. */
export function createEmptyWorkspaceRegistryProvider(): () => Promise<WorkspaceRegistry> {
  const registry = new WorkspaceRegistry();
  return async () => registry;
}

/**
 * Adapts legacy test tuples to the production object capability contract.
 * The adapter also owns the task manager through the supplied test context.
 */
export function registerAgentCommands(
  ...args: LegacyAgentCommandRegistrationArgs
): ReturnType<typeof registerAgentCommandsWithManager> {
  const [
    context,
    getTreeDataProvider,
    getConfigurationRegistry,
    debugRegistry,
    getDebugDependencies,
    getDeployDependencies,
    getSupportDependencies,
    refreshCfeLifecycle,
    getRepositoryService,
    _requestConfigurationReload,
    getSkdDependencies,
  ] = args;
  void _requestConfigurationReload;

  const taskManager = new AgentTaskManager();
  context.subscriptions.push({ dispose: () => taskManager.dispose() });
  const treeDataProvider = getTreeDataProvider();
  const debug = getDebugDependencies?.();
  const deploy = getDeployDependencies?.();
  const support = getSupportDependencies?.();
  const repositoryService = getRepositoryService?.() ?? undefined;
  const skd = getSkdDependencies?.();

  const dependencies: RegisterAgentCommandsDependencies = {
    context,
    taskManager,
    getConfigurationRegistry,
    debugRegistry,
    ...(treeDataProvider ? { treeDataProvider } : {}),
    ...(debug ? { debug } : {}),
    ...(deploy ? { deploy } : {}),
    ...(support ? { support } : {}),
    ...(refreshCfeLifecycle ? { refreshCfeLifecycle } : {}),
    ...(repositoryService ? { repositoryService } : {}),
    ...(skd ? { skd } : {}),
  };
  return registerAgentCommandsWithManager(dependencies);
}
