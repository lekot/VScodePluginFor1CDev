import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { MESSAGES } from './constants/messages';
import { initDesignerTemplateRepository } from './services/designerTemplateRepository';
import { ExtensionState } from './state/extensionState';
import { createMetadataTreeLifecycle } from './extension/metadataTreeLifecycle';
import { registerExtensionWorkspace } from './extension/extensionWorkspaceSetup';
import { registerDebugAdapter } from './debug';
import { MetadataParser } from './parsers/metadataParser';

const extensionState = new ExtensionState();
let activeMetadataLifecycle: ReturnType<typeof createMetadataTreeLifecycle> | undefined;

/**
 * Rolls back registrations and state created before activation failed.
 * The operation consumes context subscriptions, so repeating it is safe for them;
 * ExtensionState.dispose is expected to remain idempotent as well.
 */
export async function rollbackPartialActivation(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  state: Pick<ExtensionState, 'dispose'> = extensionState
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  const subscriptions = context.subscriptions.splice(0).reverse();
  for (const subscription of subscriptions) {
    try {
      subscription.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await state.dispose();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

/**
 * Activate the extension
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    extensionState.init(context);
    MetadataParser.setTypeContentsCacheStoragePath(context.globalStoragePath);
    initDesignerTemplateRepository(context.extensionPath);
    Logger.initialize();
    Logger.info(MESSAGES.EXTENSION_ACTIVATED);

    const lifecycle = createMetadataTreeLifecycle(extensionState);
    activeMetadataLifecycle = lifecycle;
    await registerExtensionWorkspace(context, extensionState, lifecycle);
    registerDebugAdapter(context);

    Logger.info('Extension activation completed');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('Critical error during extension activation', error);

    const rollbackErrors = await rollbackPartialActivation(context);
    activeMetadataLifecycle = undefined;
    for (const rollbackError of rollbackErrors) {
      Logger.error('Failed to roll back partial extension activation', rollbackError);
    }

    void vscode.window
      .showErrorMessage(`CDT 41: Failed to activate extension. ${errorMessage}`, 'Show Logs')
      .then((selection) => {
        if (selection === 'Show Logs') {
          Logger.show();
        }
      });
    throw error;
  }
}

/**
 * Deactivate the extension
 */
export async function deactivate(): Promise<void> {
  try {
    activeMetadataLifecycle?.dispose();
    activeMetadataLifecycle = undefined;
    await extensionState.dispose();
  } finally {
    Logger.info(MESSAGES.EXTENSION_DEACTIVATED);
  }
}
