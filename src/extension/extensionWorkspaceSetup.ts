import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { MetadataTreeLifecycle } from './metadataTreeLifecycle';
import { ExtensionCompositionRoot } from './extensionCompositionRoot';
import { getActivationSubscriptionScope } from './activationSubscriptionScope';

/**
 * Orchestrates workspace registration via ExtensionCompositionRoot:
 * tree view, providers, reload coordinator, editor providers,
 * infobase features, commands, git handlers.
 */
export async function registerExtensionWorkspace(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  lifecycle: MetadataTreeLifecycle,
  onRoot?: (root: ExtensionCompositionRoot) => void,
): Promise<ExtensionCompositionRoot> {
  const root = new ExtensionCompositionRoot(context, state, lifecycle);
  try {
    if (onRoot) {
      onRoot(root);
    } else if (!getActivationSubscriptionScope(context)) {
      context.subscriptions.push(root);
    } else {
      throw new Error('An activation subscription scope requires an external composition-root owner.');
    }
    await root.compose();
    return root;
  } catch (error) {
    await root.dispose();
    throw error;
  }
}
