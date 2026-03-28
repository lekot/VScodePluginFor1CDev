import * as vscode from 'vscode';

const SETTINGS_QUERY = '1cInfobaseManager.ibcmdPath';

/**
 * Explains missing ibcmd and offers to open relevant settings (also used from Command Palette).
 */
export async function showIbcmdNotFoundDialog(): Promise<void> {
  const openSettings = 'Открыть настройки';
  const choice = await vscode.window.showInformationMessage(
    'CDT 41: ibcmd не найден. Укажите путь в настройках (1cInfobaseManager.ibcmdPath) или переменную окружения IBCMD_PATH.',
    openSettings
  );
  if (choice === openSettings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', SETTINGS_QUERY);
  }
}
