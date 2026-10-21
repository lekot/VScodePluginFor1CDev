import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AgentTaskManager } from '../agent/agentTaskManager';
import { DebugSessionRegistry } from '../agent/debugSessionRegistry';
import { activateAgentBridge } from '../agent/agentBridgeActivation';
import type { RegisterAgentCommandsDependencies } from '../agent/agentCommands';
import type { AgentDeployOperationsDeps } from '../agent/agentDeployOperations';
import type { AgentDebugOperationsDeps } from '../agent/agentDebugOperations';
import type { AgentSupportOperationsDeps } from '../agent/agentSupportOperations';
import { DeployService, type DeploySupportContext } from '../bindings/deployService';
import type { WorkspaceRegistry } from '../services/configurationSession/WorkspaceRegistry';
import type { RequestConfigurationReload } from '../reload/requestConfigurationReload';
import type { AgentFeatureContext } from './extensionFeatureContexts';
import type { ExtensionRuntimeHandles } from '../state/extensionStateComposition';
import type { AgentBridge } from '../agent/agentBridge';
import type { CompositionResourceOptions } from './extensionCompositionRoot';

export interface AgentFeatureCompositionDependencies {
  readonly context: AgentFeatureContext;
  readonly getConfigurationRegistry: () => Promise<WorkspaceRegistry>;
  readonly runConfigurationMutation: ConfigurationMutationRunner;
  readonly requestConfigurationReload: RequestConfigurationReload;
  readonly refreshMetadataTree: () => Promise<void>;
  readonly registerDisposable: (
    name: string,
    disposable: vscode.Disposable | { dispose: () => Promise<void> | void } | (() => Promise<void> | void),
    options?: CompositionResourceOptions,
  ) => void;
}

export interface AgentFeatureComposition {
  readonly handles: Pick<ExtensionRuntimeHandles, 'agentTaskManager'>;
  readonly commandDependencies: RegisterAgentCommandsDependencies;
  readonly startBridge: () => Promise<AgentBridge | null>;
}

/** Builds and owns the activation-scoped Agent graph before publishing its handles. */
export async function createAgentFeatureComposition({
  context,
  getConfigurationRegistry,
  runConfigurationMutation,
  requestConfigurationReload,
  refreshMetadataTree,
  registerDisposable,
}: AgentFeatureCompositionDependencies): Promise<AgentFeatureComposition> {
  const { extensionContext } = context;
  const debugRegistry = new DebugSessionRegistry();
  registerDisposable('agent debug registry', debugRegistry.activate(), { quiescePhase: 'producers' });

  const taskManager = new AgentTaskManager();
  registerDisposable('agent task manager', () => taskManager.dispose(), { quiescePhase: 'producers' });

  const getConfigPath = () => context.treeDataProvider.getConfigPath() ?? null;
  const debug: AgentDebugOperationsDeps = {
    bindingManager: context.bindingManager,
    infobaseStorage: context.infobaseStorage,
    getConfigPath,
  };
  const deployService = new DeployService({ runConfigurationMutation });
  const deploy: AgentDeployOperationsDeps = {
    bindingManager: context.bindingManager,
    infobaseStorage: context.infobaseStorage,
    getConfigPath,
    resolveSupportContext: (configRoot) => resolveAgentDeploySupportContext(
      configRoot,
      context,
      getConfigurationRegistry,
    ),
    deployService,
    runConfigurationMutation,
    requestConfigurationReload,
  };
  const support: AgentSupportOperationsDeps = { facade: context.supportComposition.facade };

  const commandDependencies: RegisterAgentCommandsDependencies = Object.freeze({
    context: extensionContext,
    taskManager,
    treeDataProvider: context.treeDataProvider,
    getConfigurationRegistry,
    debugRegistry,
    debug,
    deploy,
    support,
    refreshCfeLifecycle: refreshMetadataTree,
    repositoryService: context.configurationRepositoryService,
  });

  const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  return {
    handles: { agentTaskManager: taskManager },
    commandDependencies,
    startBridge: async () => await activateAgentBridge(extensionContext, workspaceFolders) ?? null,
  };
}

type ConfigurationMutationRunner = <T>(
  configPath: string,
  kind: string,
  operation: () => Promise<T>,
) => Promise<T>;

async function resolveAgentDeploySupportContext(
  configRoot: string,
  context: AgentFeatureContext,
  getConfigurationRegistry: () => Promise<WorkspaceRegistry>,
): Promise<DeploySupportContext> {
  const canonicalRoot = await fs.realpath(path.resolve(configRoot));
  const workspaceRegistry = await getConfigurationRegistry();
  const descriptor = workspaceRegistry.list().find(
    (candidate) => normalizeRootKey(candidate.rootPath) === normalizeRootKey(canonicalRoot),
  );
  const registration = context.supportComposition.registry.getRegistrationByRoot(canonicalRoot);
  if (
    !descriptor
    || !registration
    || registration.configurationId !== descriptor.configurationId
    || normalizeRootKey(registration.configRoot) !== normalizeRootKey(canonicalRoot)
    || !context.supportStateCache.isRegistered(canonicalRoot)
  ) {
    throw new Error('Support deploy preflight cannot resolve an exact registered configuration.');
  }

  return {
    configurationId: descriptor.configurationId,
    facade: Object.freeze({
      getStatus: (request) => context.supportComposition.facade.getStatus(request),
      getMasterStatus: (request) => context.supportComposition.facade.getMasterStatus(request),
      sync: (request) => context.supportComposition.facade.sync(request),
    }),
  };
}

function normalizeRootKey(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}
