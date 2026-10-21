import * as vscode from 'vscode';
import { getIbcmdService } from './ibcmdServiceSingleton';
import { showIbcmdNotFoundDialog } from './showIbcmdNotFoundDialog';

export const IBCMD_SETUP_COMMAND = '1c-metadata-tree.infobaseManager.showIbcmdSetup';

/**
 * Configuration-driven cache invalidation + palette command for ibcmd setup.
 */
export function registerIbcmdInfobaseHooks(): vscode.Disposable[] {
  const svc = getIbcmdService();
  const disposables: vscode.Disposable[] = [];

  try {
    disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('1cMetadataTree')) {
        svc.invalidatePathCache();
      }
    }));
    disposables.push(vscode.commands.registerCommand(IBCMD_SETUP_COMMAND, async () => {
      await showIbcmdNotFoundDialog();
    }));
    return disposables;
  } catch (error) {
    for (const disposable of disposables.splice(0).reverse()) {
      try {
        disposable.dispose();
      } catch {
        // Preserve the registration failure while releasing earlier subscriptions.
      }
    }
    throw error;
  }
}
