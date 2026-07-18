import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { MetadataParser } from '../parsers/metadataParser';
import {
  ConfigurationDiscoveryError,
  FormatDetector,
  ConfigFormat,
} from '../parsers/formatDetector';
import { MetadataWatcherService } from '../services/metadataWatcherService';
import { loadTreeFromCache, saveTreeToCache, invalidateTreeCache } from '../utils/diskCache';
import { MetadataType, TreeNode } from '../models/treeNode';
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

function getConfigurationPackageRootName(workspaceFolderPath: string, filePath: string): string {
  const fileName = path.basename(filePath);
  const relDir = path.dirname(getWorkspaceRelativePath(workspaceFolderPath, filePath));
  return relDir && relDir !== '.' ? `${fileName} (~/${relDir})` : fileName;
}

function createConfigurationPackageRootNode(filePath: string, workspaceFolderPath: string): TreeNode {
  const normalizedPath = path.normalize(filePath);
  return {
    id: `cf:${normalizedPath.replace(/\\/g, '_')}`,
    name: getConfigurationPackageRootName(workspaceFolderPath, filePath),
    type: MetadataType.ConfigurationPackage,
    properties: {},
    filePath,
  };
}

function handleLoadError(error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  Logger.error('Error loading metadata tree', error);
  vscode.window.showErrorMessage(`${MESSAGES.ERROR_LOADING}: ${errorMessage}`);
}

export type MetadataTreeLifecycle = {
  invalidateTreeCacheOnly: (configPath: string) => Promise<void>;
  invalidateCacheAndReload: (configPath: string) => Promise<void>;
  reloadConfiguration: (configPath: string) => Promise<void>;
  loadMetadataTree: () => Promise<void>;
  reloadOrchestratorHandlers: ReloadOrchestratorHandlers;
  dispose: () => void;
};

export type MetadataReloadErrorCode =
  | 'RELOAD_DISPOSED'
  | 'CONFIGURATION_NOT_LOADED'
  | 'CONFIGURATION_PARSE_FAILED';

export class MetadataReloadError extends Error {
  constructor(
    readonly code: MetadataReloadErrorCode,
    message: string,
    readonly configPath?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MetadataReloadError';
  }
}

/**
 * Tree cache invalidation, full metadata load, and reload-orchestrator handlers wired in dependency order.
 */
export function createMetadataTreeLifecycle(state: ExtensionState): MetadataTreeLifecycle {
  let disposed = false;
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let cacheEpoch = 0;
  let loadInProgress: Promise<void> | null = null;
  const configurationReloadSlots = new Map<string, {
    configPath: string;
    requestedGeneration: number;
    completedGeneration: number;
    inProgress: Promise<void> | null;
  }>();

  function throwIfDisposed(): void {
    if (disposed) {
      throw new MetadataReloadError('RELOAD_DISPOSED', 'Metadata lifecycle is disposed.');
    }
  }

  function disposeWatchers(watchers: readonly vscode.Disposable[]): void {
    for (const watcher of watchers) {
      try {
        watcher.dispose();
      } catch (error) {
        Logger.warn('Failed to dispose metadata watcher', error);
      }
    }
  }

  function disposeMetadataWatchers(): void {
    const watchers = state.metadataWatchers;
    state.metadataWatchers = [];
    disposeWatchers(watchers);
  }

  async function invalidateTreeCacheOnly(configPath: string): Promise<void> {
    throwIfDisposed();
    // Fence any full-tree parse that began before this targeted invalidation.
    // Increment synchronously, before the first await, so an in-flight parser
    // cannot repopulate the just-invalidated shared cache.
    cacheEpoch += 1;
    if (state.extensionContext?.globalStoragePath) {
      await invalidateTreeCache(state.extensionContext.globalStoragePath, configPath);
    }
    await MetadataParser.invalidateTypeContentsCache(configPath);
  }

  async function invalidateCacheAndReload(configPath: string): Promise<void> {
    await invalidateTreeCacheOnly(configPath);
    await reloadConfiguration(configPath);
  }

  const reloadOrchestratorHandlers = createReloadOrchestratorHandlers({
    state,
    invalidateCacheAndReload,
  });

  async function loadConfigurationRoot(
    configRoot: string,
    workspaceFolderPath: string,
    options: {
      useTreeCache?: boolean;
      canWriteTreeCache?: () => boolean;
    } = {},
  ): Promise<{ rootNode: TreeNode; context: { configPath: string; format: ConfigFormat } }> {
    const storagePath = state.extensionContext?.globalStoragePath ?? '';
    const useTreeCache = options.useTreeCache !== false;
    let rootNode: TreeNode | null = storagePath && useTreeCache
      ? await loadTreeFromCache(storagePath, configRoot)
      : null;
    if (!rootNode) {
      rootNode = await MetadataParser.parseStructureOnly(configRoot);
      if (storagePath && useTreeCache && (options.canWriteTreeCache?.() ?? true)) {
        await saveTreeToCache(storagePath, configRoot, rootNode);
      }
    }
    const format = await FormatDetector.detect(configRoot);
    rootNode = normalizeEmptyPlaceholderTree(rootNode, { configPath: configRoot, format });
    const relativePath = getWorkspaceRelativePath(workspaceFolderPath, configRoot);
    rootNode.id = `config:${path.normalize(configRoot).replace(/\\/g, '_')}`;
    rootNode.name = relativePath && relativePath !== '.'
      ? `Configuration (~/${relativePath})`
      : 'Configuration';
    return { rootNode, context: { configPath: configRoot, format } };
  }

  function createWatcher(configRoot: string): MetadataWatcherService {
    const watcher = new MetadataWatcherService();
    watcher.start(configRoot, {
      onTreeReload: () => undefined,
      onFsMutationBatch: (meta) => {
        reloadOrchestratorHandlers.scheduleCoordinatedReload(meta.configPath, 'watcher');
      },
      onFilesChanged: (changedPaths) => {
        for (const changedPath of changedPaths) {
          state.propertiesProvider?.notifyFileChangedExternally(changedPath);
        }
      },
    });
    return watcher;
  }

  async function doLoadMetadataTree(generation: number): Promise<boolean> {
    throwIfDisposed();
    if (!state.treeDataProvider) {
      Logger.error(MESSAGES.ERROR_PROVIDER_NOT_INITIALIZED);
      return false;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      if (generation !== requestedGeneration) { return false; }
      throwIfDisposed();
      disposeMetadataWatchers();
      vscode.window.showWarningMessage(MESSAGES.NO_WORKSPACE);
      state.treeDataProvider.setRootNodes([], undefined);
      return true;
    }

    const nextWatchers: MetadataWatcherService[] = [];
    try {
      const workspacePaths = folders.map((f) => f.uri.fsPath);
      const configDiscovery = await FormatDetector.discoverAllConfigurationRoots(workspacePaths);
      if (configDiscovery.status !== 'authoritative') {
        throw new ConfigurationDiscoveryError('configuration-roots', configDiscovery);
      }
      const packageDiscovery = await FormatDetector.discoverAllConfigurationPackageFiles(workspacePaths);
      if (packageDiscovery.status !== 'authoritative') {
        throw new ConfigurationDiscoveryError('configuration-packages', packageDiscovery);
      }
      const configs = configDiscovery.items;
      const packages = packageDiscovery.items;
      if (configs.length === 0 && packages.length === 0) {
        if (generation !== requestedGeneration) { return false; }
        throwIfDisposed();
        disposeMetadataWatchers();
        state.treeDataProvider.setRootNodes([], undefined);
        return true;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: MESSAGES.LOADING,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0 });

          const roots: TreeNode[] = [];
          const loadContextMap = new Map<string, { configPath: string; format: ConfigFormat }>();
          const totalRootCount = configs.length + packages.length;
          const rootProgressIncrement = 100 / totalRootCount;

          for (let i = 0; i < configs.length; i++) {
            const { configPath: configRoot, workspaceFolderPath } = configs[i];
            const cacheEpochAtParseStart = cacheEpoch;
            const { rootNode, context } = await loadConfigurationRoot(
              configRoot,
              workspaceFolderPath,
              {
                canWriteTreeCache: () =>
                  !disposed
                  && generation === requestedGeneration
                  && cacheEpoch === cacheEpochAtParseStart,
              },
            );
            roots.push(rootNode);
            loadContextMap.set(rootNode.id, context);
            progress.report({ increment: rootProgressIncrement });
          }

          for (const { filePath, workspaceFolderPath } of packages) {
            roots.push(createConfigurationPackageRootNode(filePath, workspaceFolderPath));
            progress.report({ increment: rootProgressIncrement });
          }

          if (generation !== requestedGeneration) { return; }
          throwIfDisposed();
          for (const { configPath: configRoot } of configs) {
            const watcher = createWatcher(configRoot);
            nextWatchers.push(watcher);
          }

          const provider = state.treeDataProvider;
          if (!provider) {
            throw new Error(MESSAGES.ERROR_PROVIDER_NOT_INITIALIZED);
          }
          if (roots.length === 1) {
            provider.setRootNode(roots[0], loadContextMap.get(roots[0].id));
          } else {
            provider.setRootNodes(roots, loadContextMap);
          }
          provider.startTypeContentsCacheWarmup({ delayMs: 1000 });

          vscode.window.showInformationMessage(MESSAGES.SUCCESS);
          Logger.info(MESSAGES.TREE_LOADED);

          // Commit the new watcher set only after parsing, provider update, and
          // watcher startup have all succeeded. Until this point the previous
          // set keeps observing the last known-good configuration roots.
          const previousWatchers = state.metadataWatchers;
          state.metadataWatchers = nextWatchers;
          disposeWatchers(previousWatchers);
        }
      );
      if (generation !== requestedGeneration) {
        disposeWatchers(nextWatchers);
        return false;
      }
      return true;
    } catch (error) {
      disposeWatchers(nextWatchers);
      if (error instanceof MetadataReloadError && error.code === 'RELOAD_DISPOSED') {
        throw error;
      }
      handleLoadError(error);
      throw error;
    }
  }

  async function loadMetadataTree(): Promise<void> {
    throwIfDisposed();
    requestedGeneration += 1;
    if (!loadInProgress) {
      loadInProgress = (async () => {
        while (completedGeneration < requestedGeneration) {
          const generation = requestedGeneration;
          await doLoadMetadataTree(generation);
          completedGeneration = generation;
        }
      })().finally(() => {
        loadInProgress = null;
      });
    }
    await loadInProgress;
  }

  async function doReloadConfiguration(
    configPath: string,
    generation: number,
    slot: { requestedGeneration: number },
  ): Promise<boolean> {
    throwIfDisposed();
    if (loadInProgress) {
      await loadInProgress;
    }
    const fullGenerationAtStart = requestedGeneration;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(configPath));
    const workspaceFolderPath = folder?.uri.fsPath ?? configPath;
    let loaded: Awaited<ReturnType<typeof loadConfigurationRoot>>;
    try {
      // Targeted generations are already preceded by explicit cache invalidation.
      // Never let an older in-flight generation repopulate or consume the shared
      // disk cache after a newer invalidation has been requested.
      loaded = await loadConfigurationRoot(configPath, workspaceFolderPath, {
        useTreeCache: false,
      });
    } catch (error) {
      throw new MetadataReloadError(
        'CONFIGURATION_PARSE_FAILED',
        `Failed to reload configuration ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
        configPath,
        error,
      );
    }
    throwIfDisposed();
    if (generation !== slot.requestedGeneration) {
      return false;
    }
    if (requestedGeneration !== fullGenerationAtStart || loadInProgress) {
      await loadInProgress;
      return false;
    }
    const provider = state.treeDataProvider;
    if (!provider?.replaceConfigurationRoot(configPath, loaded.rootNode, loaded.context)) {
      throw new MetadataReloadError(
        'CONFIGURATION_NOT_LOADED',
        `Configuration is not present in the active tree: ${configPath}`,
        configPath,
      );
    }
    provider.startTypeContentsCacheWarmup({
      delayMs: 1000,
      rootIds: [loaded.rootNode.id],
    });
    return true;
  }

  async function reloadConfiguration(configPath: string): Promise<void> {
    throwIfDisposed();
    const key = path.normalize(configPath).replace(/\\/g, '/').toLocaleLowerCase();
    let slot = configurationReloadSlots.get(key);
    if (!slot) {
      slot = {
        configPath,
        requestedGeneration: 0,
        completedGeneration: 0,
        inProgress: null,
      };
      configurationReloadSlots.set(key, slot);
    }
    slot.requestedGeneration += 1;
    if (!slot.inProgress) {
      const activeSlot = slot;
      activeSlot.inProgress = (async () => {
        while (activeSlot.completedGeneration < activeSlot.requestedGeneration) {
          const generation = activeSlot.requestedGeneration;
          const published = await doReloadConfiguration(activeSlot.configPath, generation, activeSlot);
          if (published) {
            activeSlot.completedGeneration = generation;
          }
        }
      })().finally(() => {
        activeSlot.inProgress = null;
      });
    }
    await slot.inProgress;
  }

  function dispose(): void {
    if (disposed) { return; }
    disposed = true;
    requestedGeneration += 1;
    for (const slot of configurationReloadSlots.values()) {
      slot.requestedGeneration += 1;
    }
    disposeMetadataWatchers();
    state.treeDataProvider?.dispose();
  }

  return {
    invalidateTreeCacheOnly,
    invalidateCacheAndReload,
    reloadConfiguration,
    loadMetadataTree,
    reloadOrchestratorHandlers,
    dispose,
  };
}
