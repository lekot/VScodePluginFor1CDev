import * as vscode from 'vscode';
import type { ExtensionStateAssembly } from '../state/extensionStateComposition';
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
  assembly: ExtensionStateAssembly,
  lifecycle: MetadataTreeLifecycle,
  onRoot?: (root: ExtensionCompositionRoot) => void,
): Promise<ExtensionCompositionRoot> {
  const root = new ExtensionCompositionRoot(context, assembly, lifecycle);
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
