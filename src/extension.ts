import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { MESSAGES } from './constants/messages';
import { initDesignerTemplateRepository } from './services/designerTemplateRepository';
import { ExtensionState } from './state/extensionState';
import { createMetadataTreeLifecycle } from './extension/metadataTreeLifecycle';
import { registerExtensionWorkspace } from './extension/extensionWorkspaceSetup';
import { registerDebugAdapter } from './debug';
import { MetadataParser } from './parsers/metadataParser';
import {
  ActivationSubscriptionScope,
  createActivationSubscriptionScope,
  getActivationSubscriptionScope,
} from './extension/activationSubscriptionScope';
import { ExtensionCompositionRoot } from './extension/extensionCompositionRoot';

export const extensionState = new ExtensionState();
let activeCompositionRoot: ExtensionCompositionRoot | undefined;
let activeSubscriptionScope: ActivationSubscriptionScope | undefined;

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
      await (subscription.dispose as () => void | Promise<void>).call(subscription);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await state.dispose();
  } catch (error) {
    errors.push(error);
  }
  const scope = getActivationSubscriptionScope(context as vscode.ExtensionContext);
  scope?.close();
  return errors;
}

/**
 * Activate the extension
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const scope = createActivationSubscriptionScope(context);
  let compositionRoot: ExtensionCompositionRoot | undefined;
  try {
    activeSubscriptionScope = scope;
    extensionState.init(scope.context, { initializeInfobaseServices: false });
    MetadataParser.setTypeContentsCacheStoragePath(scope.context.globalStoragePath);
    initDesignerTemplateRepository(scope.context.extensionPath);
    Logger.initialize();
    Logger.info(MESSAGES.EXTENSION_ACTIVATED);

    const lifecycle = createMetadataTreeLifecycle(extensionState);
    await registerExtensionWorkspace(scope.context, extensionState, lifecycle, (root) => {
      compositionRoot = root;
      activeCompositionRoot = root;
      context.subscriptions.push(root);
    });
    registerDebugAdapter(scope.context);

    Logger.info('Extension activation completed');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('Critical error during extension activation', error);

    let rollbackErrors: readonly unknown[] = [];
    if (compositionRoot) {
      await compositionRoot.dispose();
      const rootIndex = context.subscriptions.indexOf(compositionRoot);
      if (rootIndex >= 0) {
        context.subscriptions.splice(rootIndex, 1);
      }
    } else {
      rollbackErrors = await rollbackPartialActivation(scope.context);
    }
    activeCompositionRoot = undefined;
    activeSubscriptionScope = undefined;
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
    if (activeCompositionRoot) {
      await activeCompositionRoot.dispose();
    } else {
      await extensionState.dispose();
      activeSubscriptionScope?.close();
    }
  } finally {
    activeCompositionRoot = undefined;
    activeSubscriptionScope = undefined;
    Logger.info(MESSAGES.EXTENSION_DEACTIVATED);
  }
}
