import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { MetadataParser } from '../parsers/metadataParser';
import { FormatDetector, ConfigFormat } from '../parsers/formatDetector';
import { MetadataWatcherService } from '../services/metadataWatcherService';
import { loadTreeFromCache, saveTreeToCache, invalidateTreeCache } from '../utils/diskCache';
import { TreeNode } from '../models/treeNode';
import { MESSAGES } from '../constants/messages';
import { normalizeEmptyPlaceholderTree } from '../utils/treeNormalization';
import { Logger } from '../utils/logger';
import {
  createReloadOrchestratorHandlers,
  ReloadOrchestratorHandlers,
} from '../reload/reloadOrchestrator';

function getWorkspaceRelativePath(workspaceFolderPath: string, configRootPath: string): string {
  const rel = path.relative(workspaceFolderPath, configRootPath);
  const normalized = rel ? path.normalize(rel).replace(/\\/g, '/') : '.';
  return normalized;
}

function handleLoadError(error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  Logger.error('Error loading metadata tree', error);
  vscode.window.showErrorMessage(`${MESSAGES.ERROR_LOADING}: ${errorMessage}`);
}

export type MetadataTreeLifecycle = {
  invalidateTreeCacheOnly: (configPath: string) => Promise<void>;
  invalidateCacheAndReload: (configPath: string) => Promise<void>;
  loadMetadataTree: () => Promise<void>;
  reloadOrchestratorHandlers: ReloadOrchestratorHandlers;
};

/**
 * Tree cache invalidation, full metadata load, and reload-orchestrator handlers wired in dependency order.
 */
export function createMetadataTreeLifecycle(state: ExtensionState): MetadataTreeLifecycle {
  async function invalidateTreeCacheOnly(configPath: string): Promise<void> {
    if (state.extensionContext?.globalStoragePath) {
      await invalidateTreeCache(state.extensionContext.globalStoragePath, configPath);
    }
  }

  async function invalidateCacheAndReload(configPath: string): Promise<void> {
    await invalidateTreeCacheOnly(configPath);
    await loadMetadataTree();
  }

  const reloadOrchestratorHandlers = createReloadOrchestratorHandlers({
    state,
    invalidateCacheAndReload,
  });

  async function loadMetadataTree(): Promise<void> {
    if (!state.treeDataProvider) {
      Logger.error(MESSAGES.ERROR_PROVIDER_NOT_INITIALIZED);
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showWarningMessage(MESSAGES.NO_WORKSPACE);
      state.treeDataProvider.setRootNodes([], undefined);
      return;
    }

    const workspacePaths = folders.map((f) => f.uri.fsPath);
    const configs = await FormatDetector.findAllConfigurationRoots(workspacePaths);
    if (configs.length === 0) {
      vscode.window.showWarningMessage(MESSAGES.NO_CONFIGURATION);
      state.treeDataProvider.setRootNodes([], undefined);
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: MESSAGES.LOADING,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0 });

          const storagePath = state.extensionContext?.globalStoragePath ?? '';
          const roots: TreeNode[] = [];
          const loadContextMap = new Map<string, { configPath: string; format: ConfigFormat }>();

          for (let i = 0; i < configs.length; i++) {
            const { configPath: configRoot, workspaceFolderPath } = configs[i];
            let rootNode: TreeNode | null = storagePath
              ? await loadTreeFromCache(storagePath, configRoot)
              : null;
            if (!rootNode) {
              rootNode = await MetadataParser.parseStructureOnly(configRoot);
              if (storagePath) {
                await saveTreeToCache(storagePath, configRoot, rootNode);
              }
            }
            const format = await FormatDetector.detect(configRoot);

            rootNode = normalizeEmptyPlaceholderTree(rootNode, { configPath: configRoot, format });
            const relativePath = getWorkspaceRelativePath(workspaceFolderPath, configRoot);
            const uniqueId = `config:${path.normalize(configRoot).replace(/\\/g, '_')}`;
            rootNode.id = uniqueId;
            rootNode.name =
              relativePath && relativePath !== '.' ? `Configuration (~/${relativePath})` : 'Configuration';
            roots.push(rootNode);
            loadContextMap.set(uniqueId, { configPath: configRoot, format });
            progress.report({ increment: (100 * (i + 1)) / configs.length });
          }

          const provider = state.treeDataProvider!;
          if (roots.length === 1) {
            provider.setRootNode(roots[0], loadContextMap.get(roots[0].id));
          } else {
            provider.setRootNodes(roots, loadContextMap);
          }

          for (const w of state.metadataWatchers) {
            w.dispose();
          }
          state.metadataWatchers = [];
          const onReload = () => {
            // Backward-compatible callback path: watcher still invokes this shape.
          };
          const onFileChanged = (changedPath: string) => {
            state.propertiesProvider?.notifyFileChangedExternally(changedPath);
          };
          for (const { configPath: configRoot } of configs) {
            const watcher = new MetadataWatcherService();
            watcher.start(configRoot, {
              onTreeReload: onReload,
              onFsMutationBatch: (meta) => {
                reloadOrchestratorHandlers.scheduleCoordinatedReload(meta.configPath, 'watcher');
              },
              onFileChanged,
            });
            state.metadataWatchers.push(watcher);
            state.extensionContext?.subscriptions.push(watcher);
          }

          vscode.window.showInformationMessage(MESSAGES.SUCCESS);
          Logger.info(MESSAGES.TREE_LOADED);
        }
      );
    } catch (error) {
      handleLoadError(error);
    }
  }

  return {
    invalidateTreeCacheOnly,
    invalidateCacheAndReload,
    loadMetadataTree,
    reloadOrchestratorHandlers,
  };
}
