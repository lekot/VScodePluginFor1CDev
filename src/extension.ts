import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { MESSAGES } from './constants/messages';
import { initDesignerTemplateRepository } from './services/designerTemplateRepository';
import { ExtensionState } from './state/extensionState';
import { createMetadataTreeLifecycle } from './extension/metadataTreeLifecycle';
import { registerExtensionWorkspace } from './extension/extensionWorkspaceSetup';
import { registerDebugAdapter } from './debug';

const extensionState = new ExtensionState();

/**
 * Activate the extension
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    extensionState.init(context);
    initDesignerTemplateRepository(context);
    Logger.initialize();
    Logger.info(MESSAGES.EXTENSION_ACTIVATED);

    const lifecycle = createMetadataTreeLifecycle(extensionState);
    registerExtensionWorkspace(context, extensionState, lifecycle);
    registerDebugAdapter(context);

    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      lifecycle.loadMetadataTree().catch((error) => {
        Logger.error('Error during auto-load', error);
      });
    }

    Logger.info('Extension activation completed');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('Critical error during extension activation', error);

    vscode.window
      .showErrorMessage(`CDT 41: Failed to activate extension. ${errorMessage}`, 'Show Logs')
      .then((selection) => {
        if (selection === 'Show Logs') {
          Logger.show();
        }
      });
  }
}

/**
 * Deactivate the extension
 */
export function deactivate(): void {
  extensionState.dispose();
  Logger.info(MESSAGES.EXTENSION_DEACTIVATED);
}
