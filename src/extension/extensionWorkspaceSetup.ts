import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { MetadataTreeLifecycle } from './metadataTreeLifecycle';
import { ExtensionCompositionRoot } from './extensionCompositionRoot';

/**
 * Orchestrates workspace registration via ExtensionCompositionRoot:
 * tree view, providers, reload coordinator, editor providers,
 * infobase features, commands, git handlers.
 */
export async function registerExtensionWorkspace(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  lifecycle: MetadataTreeLifecycle,
): Promise<void> {
  const root = new ExtensionCompositionRoot(context, state, lifecycle);
  await root.compose();
  context.subscriptions.push(root);
}
