import * as vscode from 'vscode';
import { getIbcmdService } from './ibcmdServiceSingleton';
import { showIbcmdNotFoundDialog } from './showIbcmdNotFoundDialog';

export const IBCMD_SETUP_COMMAND = '1c-metadata-tree.infobaseManager.showIbcmdSetup';

/**
 * Configuration-driven cache invalidation + palette command for ibcmd setup.
 */
export function registerIbcmdInfobaseHooks(context: vscode.ExtensionContext): void {
  const svc = getIbcmdService();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('1cMetadataTree')) {
        svc.invalidatePathCache();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(IBCMD_SETUP_COMMAND, async () => {
      await showIbcmdNotFoundDialog();
    })
  );
}
