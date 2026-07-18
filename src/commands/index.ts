import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionState } from '../state/extensionState';
import type { MetadataTreeLifecycle } from '../extension/metadataTreeLifecycle';
import { registerElementCommands } from './elementCommands';
import { registerNavigationCommands } from './navigationCommands';
import { registerEditorCommands } from './editorCommands';
import { registerConfigurationCompareCommands } from './configurationCompareCommands';
import { registerCfCommands } from './cfCommands';
import { registerFilterCommands } from './filterCommands';
import {
  registerUtilityCommandsLeading,
  registerUtilityCommandsTrailing,
} from './utilityCommands';
import { registerExtensionCommands } from '../extensionSupport/extensionCommands';
import { registerAgentCommands } from '../agent/agentCommands';
import { DebugSessionRegistry } from '../agent/debugSessionRegistry';
import { activateAgentBridge } from '../agent/agentBridgeActivation';
import { FormatDetector } from '../parsers/formatDetector';
import { WorkspaceRegistry } from '../services/configurationSession/WorkspaceRegistry';
import { configureConfigurationMutationGateway } from '../services/configurationSession/configurationMutationGateway';

export type RegisterAllCommandsArgs = {
  context: vscode.ExtensionContext;
  state: ExtensionState;
  lifecycle: MetadataTreeLifecycle;
};


/** Registers every extension command; order matches historical subscription order in activation. */
export async function registerAllCommands({
  context,
  state,
  lifecycle,
}: RegisterAllCommandsArgs): Promise<vscode.Disposable[]> {
  const utilityDeps = {
    state,
    loadMetadataTree: lifecycle.loadMetadataTree,
    extensionContext: context,
  };
  registerExtensionCommands(context, state);

  const configurationRegistry = new WorkspaceRegistry(
    path.join(context.globalStorageUri.fsPath, 'configuration-identities.v1.json'),
  );
  let registryRefreshTail: Promise<void> = Promise.resolve();
  const getConfigurationRegistry = async (): Promise<WorkspaceRegistry> => {
    const refresh = async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const configs = await FormatDetector.findAllConfigurationRoots(folders.map((folder) => folder.uri.fsPath));
      await configurationRegistry.refresh(await Promise.all(configs.map(async (config) => ({
        ...config,
        format: await FormatDetector.detect(config.configPath),
      }))));
    };
    const current = registryRefreshTail.then(refresh, refresh);
    registryRefreshTail = current.then(() => undefined, () => undefined);
    await current;
    return configurationRegistry;
  };
  const runConfigurationMutation = async <T>(
    configPath: string,
    kind: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const registry = await getConfigurationRegistry();
    const session = await registry.resolveResource(configPath);
    const outcome = await session.enqueue({ kind, execute: operation });
    if (outcome.status === 'committed') {
      return outcome.value;
    }
    throw outcome.status === 'failed' || outcome.status === 'conflict'
      ? outcome.error ?? new Error('Операция конфигурации не выполнена.')
      : new Error('Операция конфигурации отменена.');
  };
  const runConfigurationPlan = async <T>(configPath: string, plan: import('../services/configurationSession/mutationPlan').MutationPlan<T>): Promise<T> => {
    const registry = await getConfigurationRegistry();
    const session = await registry.resolveResource(configPath);
    const outcome = await session.enqueuePlan(plan);
    if (outcome.status === 'committed') { return outcome.value; }
    throw outcome.status === 'failed' || outcome.status === 'conflict'
      ? outcome.error ?? new Error('Configuration plan failed.')
      : new Error('Configuration plan was cancelled.');
  };
  context.subscriptions.push(
    configureConfigurationMutationGateway(runConfigurationMutation, runConfigurationPlan),
  );
  context.subscriptions.push({ dispose: () => { void configurationRegistry.dispose(); } });

  // Agent API — регистрируем отдельно (не возвращают Disposable[] — управляют подписками сами)
  const debugRegistry = new DebugSessionRegistry();
  debugRegistry.activate(context);
  registerAgentCommands(
    context,
    () => state.treeDataProvider,
    getConfigurationRegistry,
    debugRegistry,
    () => {
      const bm = state.bindingManager;
      const is = state.infobaseStorage;
      if (!bm || !is) {return undefined;}
      return {
        bindingManager: bm,
        infobaseStorage: is,
        getConfigPath: () => state.treeDataProvider?.getConfigPath() ?? null,
      };
    },
    // Deploy deps — same shape as debug deps
    () => {
      const bm = state.bindingManager;
      const is = state.infobaseStorage;
      if (!bm || !is) {return undefined;}
      return {
        bindingManager: bm,
        infobaseStorage: is,
        getConfigPath: () => state.treeDataProvider?.getConfigPath() ?? null,
      };
    },
  );

  // Agent Bridge — HTTP сервер для вызова Agent API команд снаружи VS Code
  const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  state.agentBridge = await activateAgentBridge(context, wsFolder) ?? null;

  return [
    ...registerUtilityCommandsLeading(utilityDeps),
    ...registerConfigurationCompareCommands({ context, state }),
    ...registerCfCommands({ state }),
    ...registerEditorCommands({ state }),
    ...registerElementCommands({
      state,
      loadMetadataTree: lifecycle.loadMetadataTree,
      invalidateCacheAndReload: lifecycle.invalidateCacheAndReload,
      scheduleDeleteReconcile: lifecycle.reloadOrchestratorHandlers.scheduleDeleteReconcile,
      runConfigurationMutation,
      runConfigurationPlan,
    }),
    ...registerNavigationCommands({ state }),
    ...registerUtilityCommandsTrailing(utilityDeps),
    ...registerFilterCommands({
      state,
      loadMetadataTree: lifecycle.loadMetadataTree,
      invalidateTreeCacheOnly: lifecycle.invalidateTreeCacheOnly,
    }),
  ];
}
