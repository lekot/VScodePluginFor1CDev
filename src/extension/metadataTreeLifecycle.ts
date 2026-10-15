import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { MetadataParser } from '../parsers/metadataParser';
import {
  ConfigurationDiscoveryError,
  FormatDetector,
} from '../parsers/formatDetector';
import { MetadataWatcherService } from '../services/metadataWatcherService';
import { loadTreeFromCache, saveTreeToCache, invalidateTreeCache } from '../utils/diskCache';
import { MetadataType, TreeNode } from '../models/treeNode';
import { MESSAGES } from '../constants/messages';
import { normalizeEmptyPlaceholderTree } from '../utils/treeNormalization';
import { Logger } from '../utils/logger';
import type { ReloadAttemptOutcome } from '../types/reloadContracts';
import type { TreeLoadContext } from '../types/treeLoadContext';
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
  executeConfigurationReload: (
    configPath: string,
    canPublish: () => boolean,
  ) => Promise<ReloadAttemptOutcome>;
  loadMetadataTree: () => Promise<void>;
  reloadOrchestratorHandlers: ReloadOrchestratorHandlers;
  dispose: () => void;
};

/** Lifecycle surface available to feature registrations; targeted execution stays at the composition root. */
export type MetadataTreeFeatureLifecycle = Omit<MetadataTreeLifecycle, 'executeConfigurationReload'>;

export type MetadataReloadErrorCode =
  | 'RELOAD_DISPOSED'
  | 'CONFIGURATION_NOT_LOADED'
  | 'CONFIGURATION_CONTEXT_UNAVAILABLE'
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
    state.treeDataProvider?.invalidateTypeLoadsForConfiguration(configPath);

    const invoke = (operation: () => Promise<void>): Promise<void> => {
      try {
        return Promise.resolve(operation());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    // Start parser invalidation first so its epoch advances before any disk I/O can suspend.
    const parserInvalidation = invoke(() => MetadataParser.invalidateTypeContentsCache(configPath));
    const diskInvalidation = state.extensionContext?.globalStoragePath
      ? invoke(() => invalidateTreeCache(state.extensionContext!.globalStoragePath, configPath))
      : Promise.resolve();
    const results = await Promise.allSettled([diskInvalidation, parserInvalidation]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
  }

  const reloadOrchestratorHandlers = createReloadOrchestratorHandlers({ state });

  async function loadConfigurationRoot(
    configRoot: string,
    workspaceFolderPath: string,
    options: {
      useTreeCache?: boolean;
      canWriteTreeCache?: () => boolean;
    } = {},
  ): Promise<{ rootNode: TreeNode; context: TreeLoadContext }> {
    const resolver = state.configurationContextResolver;
    if (!resolver) {
      throw new MetadataReloadError(
        'CONFIGURATION_CONTEXT_UNAVAILABLE',
        `Невозможно загрузить конфигурацию без резолвера контекста чтения: ${configRoot}`,
        configRoot,
      );
    }

    let context: TreeLoadContext;
    try {
      const resolved = await resolver.resolveFromResource(configRoot, 'read');
      context = Object.freeze({
        configurationId: resolved.configurationId,
        configPath: resolved.rootPath,
        format: resolved.format,
      });
    } catch (error) {
      throw new MetadataReloadError(
        'CONFIGURATION_CONTEXT_UNAVAILABLE',
        `Не удалось определить контекст чтения конфигурации ${configRoot}: ${error instanceof Error ? error.message : String(error)}`,
        configRoot,
        error,
      );
    }

    const configPath = context.configPath;
    const storagePath = state.extensionContext?.globalStoragePath ?? '';
    const useTreeCache = options.useTreeCache !== false;
    let rootNode: TreeNode | null = storagePath && useTreeCache
      ? await loadTreeFromCache(storagePath, configPath)
      : null;
    if (!rootNode) {
      rootNode = await MetadataParser.parseStructureOnly(configPath);
      if (storagePath && useTreeCache && (options.canWriteTreeCache?.() ?? true)) {
        await saveTreeToCache(storagePath, configPath, rootNode);
      }
    }
    rootNode = normalizeEmptyPlaceholderTree(rootNode, { configPath, format: context.format });
    const relativePath = getWorkspaceRelativePath(workspaceFolderPath, configPath);
    rootNode.id = `config:${context.configurationId}`;
    const rootProperties = { ...(rootNode.properties ?? {}) };
    delete (rootProperties as Record<string, unknown>).configurationId;
    rootNode.properties = rootProperties;
    Object.defineProperty(rootNode, 'configurationId', {
      value: context.configurationId,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    rootNode.name = relativePath && relativePath !== '.'
      ? `Configuration (~/${relativePath})`
      : 'Configuration';
    return { rootNode, context };
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
          const loadContextMap = new Map<TreeNode, TreeLoadContext>();
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
            loadContextMap.set(rootNode, context);
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
            provider.setRootNode(roots[0], loadContextMap.get(roots[0]));
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

  async function executeConfigurationReload(
    configPath: string,
    canPublish: () => boolean,
  ): Promise<ReloadAttemptOutcome> {
    throwIfDisposed();
    await invalidateTreeCacheOnly(configPath);
    while (loadInProgress) {
      await loadInProgress;
      throwIfDisposed();
    }

    if (!canPublish()) {
      return { status: 'superseded' };
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
      if (error instanceof MetadataReloadError && error.code === 'CONFIGURATION_CONTEXT_UNAVAILABLE') {
        throw error;
      }
      throw new MetadataReloadError(
        'CONFIGURATION_PARSE_FAILED',
        `Failed to reload configuration ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
        configPath,
        error,
      );
    }
    throwIfDisposed();
    if (!canPublish()) {
      return { status: 'superseded' };
    }
    if (requestedGeneration !== fullGenerationAtStart || loadInProgress) {
      while (loadInProgress) {
        await loadInProgress;
        throwIfDisposed();
      }
      return { status: 'superseded' };
    }
    const provider = state.treeDataProvider;
    if (!provider?.replaceConfigurationRoot(loaded.context.configurationId, loaded.rootNode, loaded.context)) {
      throw new MetadataReloadError(
        'CONFIGURATION_NOT_LOADED',
        `Configuration is not present in the active tree: ${configPath}`,
        configPath,
      );
    }
    provider.startTypeContentsCacheWarmup({
      delayMs: 1000,
      preferredRootId: loaded.rootNode.id,
    });
    return { status: 'published' };
  }

  function dispose(): void {
    if (disposed) { return; }
    disposed = true;
    requestedGeneration += 1;
    disposeMetadataWatchers();
    state.treeDataProvider?.dispose();
  }

  return {
    invalidateTreeCacheOnly,
    executeConfigurationReload,
    loadMetadataTree,
    reloadOrchestratorHandlers,
    dispose,
  };
}
