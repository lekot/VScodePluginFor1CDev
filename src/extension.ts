import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { MetadataTreeDataProvider } from './providers/treeDataProvider';
import { MetadataParser } from './parsers/metadataParser';
import { TreeNode } from './models/treeNode';
import { MESSAGES } from './constants/messages';

let treeDataProvider: MetadataTreeDataProvider | null = null;
let treeView: vscode.TreeView<TreeNode> | null = null;

/**
 * Activate the extension
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  Logger.initialize();
  Logger.info(MESSAGES.EXTENSION_ACTIVATED);

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
      Logger.info(MESSAGES.OPENING_PANEL);
      await loadMetadataTree();
    }
  );

  const refreshCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.refresh',
    async () => {
      Logger.info(MESSAGES.REFRESHING);
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
    Logger.error(MESSAGES.ERROR_PROVIDER_NOT_INITIALIZED);
    return;
  }

  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showWarningMessage(MESSAGES.NO_WORKSPACE);
    return;
  }

  const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: MESSAGES.LOADING,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 0 });

        const rootNode = await parseMetadata(workspacePath);
        if (!rootNode) {
          vscode.window.showWarningMessage(MESSAGES.NO_CONFIGURATION);
          return;
        }

        progress.report({ increment: 50 });

        treeDataProvider!.setRootNode(rootNode);

        progress.report({ increment: 100 });

        vscode.window.showInformationMessage(MESSAGES.SUCCESS);
        Logger.info(MESSAGES.TREE_LOADED);
      }
    );
  } catch (error) {
    handleLoadError(error);
  }
}

/**
 * Parse metadata from workspace
 */
async function parseMetadata(workspacePath: string): Promise<TreeNode | null> {
  return await MetadataParser.parseFromWorkspace(workspacePath);
}

/**
 * Handle metadata loading error
 */
function handleLoadError(error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  Logger.error('Error loading metadata tree', error);
  vscode.window.showErrorMessage(`${MESSAGES.ERROR_LOADING}: ${errorMessage}`);
}

/**
 * Deactivate the extension
 */
export function deactivate(): void {
  Logger.info(MESSAGES.EXTENSION_DEACTIVATED);
}
