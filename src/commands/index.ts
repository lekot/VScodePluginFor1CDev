import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import type { MetadataTreeLifecycle } from '../extension/metadataTreeLifecycle';
import { registerElementCommands } from './elementCommands';
import { registerNavigationCommands } from './navigationCommands';
import { registerEditorCommands } from './editorCommands';
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

export type RegisterAllCommandsArgs = {
  context: vscode.ExtensionContext;
  state: ExtensionState;
  lifecycle: MetadataTreeLifecycle;
};


/** Registers every extension command; order matches historical subscription order in activation. */
export function registerAllCommands({
  context,
  state,
  lifecycle,
}: RegisterAllCommandsArgs): vscode.Disposable[] {
  const utilityDeps = {
    state,
    loadMetadataTree: lifecycle.loadMetadataTree,
    extensionContext: context,
  };
  registerExtensionCommands(context, state);

  // Agent API — регистрируем отдельно (не возвращают Disposable[] — управляют подписками сами)
  const debugRegistry = new DebugSessionRegistry();
  debugRegistry.activate(context);
  registerAgentCommands(
    context,
    () => state.treeDataProvider,
    async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {return null;}
      const configs = await FormatDetector.findAllConfigurationRoots(folders.map((f) => f.uri.fsPath));
      return configs.length > 0 ? configs[0].configPath : null;
    },
    debugRegistry,
    () => {
      const bm = state.bindingManager;
      const is = state.infobaseStorage;
      if (!bm || !is) {return undefined;}
      return { bindingManager: bm, infobaseStorage: is };
    },
  );

  // Agent Bridge — HTTP сервер для вызова Agent API команд снаружи VS Code
  const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  activateAgentBridge(context, wsFolder);

  return [
    ...registerUtilityCommandsLeading(utilityDeps),
    ...registerEditorCommands({ state }),
    ...registerElementCommands({
      state,
      loadMetadataTree: lifecycle.loadMetadataTree,
      invalidateCacheAndReload: lifecycle.invalidateCacheAndReload,
      scheduleDeleteReconcile: lifecycle.reloadOrchestratorHandlers.scheduleDeleteReconcile,
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
