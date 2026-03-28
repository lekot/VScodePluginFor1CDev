import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import { PropertiesProvider } from '../providers/propertiesProvider';
import { TypeEditorProvider } from '../providers/typeEditorProvider';
import { RolesRightsEditorProvider } from '../rolesEditor/rolesRightsEditorProvider';
import { FormEditorProvider } from '../formEditor/formEditorProvider';
import { MxlPreviewProvider } from '../mxlPreview/mxlPreviewProvider';
import { ReloadCoordinatorService } from '../services/reloadCoordinatorService';
import { MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { registerAllCommands } from '../commands';
import { registerIbcmdInfobaseHooks } from '../services/ibcmdService';
import { MetadataTreeLifecycle } from './metadataTreeLifecycle';

/**
 * Tree view, providers, reload coordinator, command registration, selection wiring.
 */
export function registerExtensionWorkspace(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  lifecycle: MetadataTreeLifecycle
): void {
  state.treeDataProvider = new MetadataTreeDataProvider(context);

  state.treeView = vscode.window.createTreeView('1c-metadata-tree', {
    treeDataProvider: state.treeDataProvider,
    showCollapseAll: true,
  });
  state.treeDataProvider.setMessageUpdater((msg) => {
    if (state.treeView) {
      state.treeView.message = msg ?? '';
    }
  });
  context.subscriptions.push(state.treeView);

  state.typeEditorProvider = new TypeEditorProvider(context);

  state.rolesRightsEditorProvider = new RolesRightsEditorProvider(context);
  context.subscriptions.push(state.rolesRightsEditorProvider);

  state.propertiesProvider = new PropertiesProvider(
    context,
    state.treeDataProvider,
    state.typeEditorProvider,
    (payload) => {
      state.formEditorProvider?.applySelectionPropertyChange(payload);
    }
  );
  context.subscriptions.push(state.propertiesProvider);

  state.reloadCoordinator = new ReloadCoordinatorService(async ({ configPath, reason, operationId }) => {
    Logger.info('reload.run.started', { configPath, reason, operationId });
    await lifecycle.invalidateTreeCacheOnly(configPath);
    await lifecycle.loadMetadataTree();
    Logger.info('reload.run.completed', { configPath, reason, operationId, success: true });
  });
  context.subscriptions.push({
    dispose: () => {
      state.reloadCoordinator?.dispose();
      state.reloadCoordinator = null;
    },
  });

  state.formEditorProvider = new FormEditorProvider((payload) => {
    if (state.propertiesProvider) {
      void state.propertiesProvider.showFormSelectionProperties(payload);
    }
  });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('1c-form-editor', state.formEditorProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  state.mxlPreviewProvider = new MxlPreviewProvider();
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('1c-mxl-preview', state.mxlPreviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    })
  );

  registerIbcmdInfobaseHooks(context);

  const commandDisposables = registerAllCommands({ context, state, lifecycle });
  context.subscriptions.push(...commandDisposables);

  const treeSelectionDisposable = state.treeView.onDidChangeSelection(async (e) => {
    if (e.selection.length > 0) {
      const selectedNode = e.selection[0];
      Logger.debug(`Tree selection changed: ${selectedNode.name}`);

      if (selectedNode.type === MetadataType.Role && selectedNode.filePath) {
        await vscode.commands.executeCommand('1c-metadata-tree.openRightsEditor', selectedNode);
      } else if (state.propertiesProvider) {
        await vscode.commands.executeCommand('1c-metadata-tree.showProperties', selectedNode);
      }
    }
  });
  context.subscriptions.push(treeSelectionDisposable);

  vscode.commands.executeCommand('setContext', '1c-metadata-tree:enabled', true);
}
