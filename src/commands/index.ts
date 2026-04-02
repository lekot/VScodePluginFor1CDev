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
