import * as vscode from 'vscode';
import { Logger } from './utils/logger';

/**
 * Activate the extension
 */
export function activate(context: vscode.ExtensionContext): void {
  Logger.initialize();
  Logger.info('1C Metadata Tree extension activated');

  // Register commands
  const openPanelCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openPanel',
    () => {
      Logger.info('Opening metadata tree panel');
      vscode.window.showInformationMessage('1C Metadata Tree panel opened');
    }
  );

  const refreshCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.refresh',
    () => {
      Logger.info('Refreshing metadata tree');
    }
  );

  context.subscriptions.push(openPanelCommand, refreshCommand);

  // Set context for conditional activation
  vscode.commands.executeCommand('setContext', '1c-metadata-tree:enabled', true);
}

/**
 * Deactivate the extension
 */
export function deactivate(): void {
  Logger.info('1C Metadata Tree extension deactivated');
}
