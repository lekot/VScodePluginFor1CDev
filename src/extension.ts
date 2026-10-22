import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { MESSAGES } from './constants/messages';
import { initDesignerTemplateRepository } from './services/designerTemplateRepository';
import { type ExtensionState, createExtensionState } from './state/extensionState';
import type { ExtensionStateAssembly } from './state/extensionStateComposition';
import { createMetadataTreeLifecycle } from './extension/metadataTreeLifecycle';
import { createMetadataTreeLifecycleRuntimeView } from './extension/extensionFeatureContexts';
import { registerExtensionWorkspace } from './extension/extensionWorkspaceSetup';
import { registerDebugAdapter } from './debug';
import { MetadataParser } from './parsers/metadataParser';
import {
  ActivationSubscriptionScope,
  createActivationSubscriptionScope,
  getActivationSubscriptionScope,
} from './extension/activationSubscriptionScope';
import { ExtensionCompositionRoot } from './extension/extensionCompositionRoot';

let activeExtensionState: ExtensionState | undefined;
/** Immutable diagnostics view; features must receive dependencies through their composition context. */
export const extensionDiagnostics: Readonly<{ readonly state: ExtensionState | undefined }> = Object.freeze({
  get state(): ExtensionState | undefined {
    return activeExtensionState;
  },
});
let activeAssembly: ExtensionStateAssembly | undefined;
let activeCompositionRoot: ExtensionCompositionRoot | undefined;
let activeSubscriptionScope: ActivationSubscriptionScope | undefined;
let activeActivationPromise: Promise<void> | undefined;
let deactivationPromise: Promise<void> | undefined;

/**
 * Rolls back registrations and state created before activation failed.
 * The state owner gets the first chance to drain adopted subscriptions; only subscriptions
 * left in the activation context are cleaned up directly.
 */
export async function rollbackPartialActivation(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  state: Pick<ExtensionState, 'dispose'> | undefined = activeAssembly?.state,
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  const scope = getActivationSubscriptionScope(context as vscode.ExtensionContext);
  if (scope?.hasOwner) {
    try {
      await state?.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  const subscriptions = context.subscriptions.splice(0).reverse();
  for (const subscription of subscriptions) {
    try {
      await (subscription.dispose as () => void | Promise<void>).call(subscription);
    } catch (error) {
      errors.push(error);
    }
  }
  if (!scope?.hasOwner) {
    try {
      await state?.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  scope?.close();
  return errors;
}

/** Activate once; overlapping activation calls share the in-flight or active session. */
export function activate(context: vscode.ExtensionContext): Promise<void> {
  if (deactivationPromise) {
    return deactivationPromise.then(() => activate(context));
  }
  if (activeActivationPromise) {
    return activeActivationPromise;
  }
  let resolveActivation!: () => void;
  let rejectActivation!: (error: unknown) => void;
  const activation = new Promise<void>((resolve, reject) => {
    resolveActivation = resolve;
    rejectActivation = reject;
  });
  activeActivationPromise = activation;
  void activation.then(undefined, () => {
    if (activeActivationPromise === activation) {
      activeActivationPromise = undefined;
    }
  });
  // Reserve single-flight identity before performActivation can synchronously publish the root
  // into context.subscriptions (whose host callback may reenter activate()). Keep startup itself
  // synchronous through its first await so an immediate deactivate can close the live graph.
  void performActivation(context).then(resolveActivation, rejectActivation);
  return activation;
}

async function performActivation(context: vscode.ExtensionContext): Promise<void> {
  const assembly = createExtensionState();
  const state = assembly.state;
  const scope = createActivationSubscriptionScope(context);
  let compositionRoot: ExtensionCompositionRoot | undefined;
  activeAssembly = assembly;
  activeExtensionState = state;
  try {
    activeSubscriptionScope = scope;
    assembly.composition.initialize(scope.context);
    MetadataParser.setTypeContentsCacheStoragePath(scope.context.globalStoragePath);
    initDesignerTemplateRepository(scope.context.extensionPath);
    Logger.initialize();
    Logger.info(MESSAGES.EXTENSION_ACTIVATED);

    const lifecycle = createMetadataTreeLifecycle(createMetadataTreeLifecycleRuntimeView(state));
    await registerExtensionWorkspace(scope.context, assembly, lifecycle, (root) => {
      compositionRoot = root;
      if (activeAssembly === assembly) {
        activeCompositionRoot = root;
      }
      context.subscriptions.push(root);
    });
    registerDebugAdapter(scope.context);

    Logger.info('Extension activation completed');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    try {
      Logger.error('Critical error during extension activation', error);
    } catch {
      // Activation rollback must preserve the original failure.
    }

    let rollbackErrors: readonly unknown[] = [];
    if (compositionRoot) {
      await compositionRoot.dispose();
      const rootIndex = context.subscriptions.indexOf(compositionRoot);
      if (rootIndex >= 0) {
        context.subscriptions.splice(rootIndex, 1);
      }
    } else {
      rollbackErrors = await rollbackPartialActivation(scope.context, state);
    }
    if (activeCompositionRoot === compositionRoot) {
      activeCompositionRoot = undefined;
    }
    if (activeSubscriptionScope === scope) {
      activeSubscriptionScope = undefined;
    }
    if (activeAssembly === assembly) {
      activeAssembly = undefined;
      activeExtensionState = undefined;
    }
    for (const rollbackError of rollbackErrors) {
      try {
        Logger.error('Failed to roll back partial extension activation', rollbackError);
      } catch {
        // Keep reporting failures from replacing the activation error.
      }
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

/** Deactivate only after any activation work has settled, then release that exact session. */
export function deactivate(): Promise<void> {
  if (deactivationPromise) {
    return deactivationPromise;
  }
  const activation = activeActivationPromise;
  const assembly = activeAssembly;
  const compositionRoot = activeCompositionRoot;
  const scope = activeSubscriptionScope;

  // Start the synchronous admission fence and root quiescence before waiting for activation.
  scope?.close();
  const disposal = compositionRoot
    ? compositionRoot.dispose()
    : assembly?.state.dispose() ?? Promise.resolve();

  const tracked = (async () => {
    await activation?.catch(() => undefined);
    await disposal;
    if (activeCompositionRoot === compositionRoot) {
      activeCompositionRoot = undefined;
    }
    if (activeSubscriptionScope === scope) {
      activeSubscriptionScope = undefined;
    }
    if (activeAssembly === assembly) {
      activeAssembly = undefined;
      activeExtensionState = undefined;
    }
    if (activeActivationPromise === activation) {
      activeActivationPromise = undefined;
    }
    try {
      Logger.info(MESSAGES.EXTENSION_DEACTIVATED);
    } catch {
      // Diagnostics cannot turn a completed shutdown into a failed lifecycle transition.
    }
  })().finally(() => {
    if (deactivationPromise === tracked) {
      deactivationPromise = undefined;
    }
  });
  deactivationPromise = tracked;
  return tracked;
}
