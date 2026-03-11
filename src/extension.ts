import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { MetadataTreeDataProvider } from './providers/treeDataProvider';
import { MetadataParser } from './parsers/metadataParser';

let treeDataProvider: MetadataTreeDataProvider | null = null;
let treeView: vscode.TreeView<any> | null = null;

/**
 * Activate the extension
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  Logger.initialize();
  Logger.info('1C Metadata Tree extension activated');

  // Create tree data provider
  treeDataProvider = new MetadataTreeDataProvider(context);

  // Register tree view
  treeView = vscode.window.createTreeView('1c-metadata-tree', {
    treeDataProvider: treeDataProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(treeView);

  // Register commands
  const openPanelCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openPanel',
    async () => {
      Logger.info('Opening metadata tree panel');
      await loadMetadataTree();
    }
  );

  const refreshCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.refresh',
    async () => {
      Logger.info('Refreshing metadata tree');
      await loadMetadataTree();
    }
  );

  context.subscriptions.push(openPanelCommand, refreshCommand);

  // Set context for conditional activation
  vscode.commands.executeCommand('setContext', '1c-metadata-tree:enabled', true);

  // Auto-load metadata tree if workspace is open
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    await loadMetadataTree();
  }
}

/**
 * Load metadata tree from workspace
 */
async function loadMetadataTree(): Promise<void> {
  if (!treeDataProvider) {
    Logger.error('Tree data provider not initialized');
    return;
  }

  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('Откройте папку с конфигурацией 1С');
    return;
  }

  const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;

  try {
    // Show progress
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Загрузка метаданных 1С...',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 0 });

        // Parse metadata
        const rootNode = await MetadataParser.parseFromWorkspace(workspacePath);

        if (!rootNode) {
          vscode.window.showWarningMessage(
            'Конфигурация 1С не найдена в рабочей области'
          );
          return;
        }

        progress.report({ increment: 50 });

        // Set root node
        treeDataProvider!.setRootNode(rootNode);

        progress.report({ increment: 100 });

        vscode.window.showInformationMessage('Метаданные 1С успешно загружены');
        Logger.info('Metadata tree loaded successfully');
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('Error loading metadata tree', error);
    vscode.window.showErrorMessage(`Ошибка загрузки метаданных: ${errorMessage}`);
  }
}

/**
 * Deactivate the extension
 */
export function deactivate(): void {
  Logger.info('1C Metadata Tree extension deactivated');
}
