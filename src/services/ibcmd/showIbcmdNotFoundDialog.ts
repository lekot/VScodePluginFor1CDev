import * as vscode from 'vscode';
import { IBCMD_PATH_SETTINGS_QUERY } from '../metadataTreeSettings';

/**
 * Explains missing ibcmd and offers to open relevant settings (also used from Command Palette).
 */
export async function showIbcmdNotFoundDialog(): Promise<void> {
  const open = 'Открыть настройки';
  const choice = await vscode.window.showWarningMessage(
    `CDT 41: ibcmd не найден. Укажите путь в настройках (${IBCMD_PATH_SETTINGS_QUERY}) или переменную окружения IBCMD_PATH.`,
    open,
  );
  if (choice === open) {
    await vscode.commands.executeCommand('workbench.action.openSettings', IBCMD_PATH_SETTINGS_QUERY);
  }
}
