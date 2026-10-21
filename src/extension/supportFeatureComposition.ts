import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConfigurationId } from '../services/configurationSession/types';
import type { WorkspaceRegistry } from '../services/configurationSession';
import { MetadataType, type TreeNode } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { normalizeConfigRelativePath } from '../bindings/bindingPathUtils';
import { SupportBindingResolver } from '../support/supportBindingResolver';
import {
  createSupportServiceComposition,
  type SupportServiceComposition,
} from '../support/supportServiceComposition';
import {
  createSupportStateCacheFacade,
  SupportStateCache,
} from '../support/supportStateCache';
import {
  SUPPORT_MASTER_WATCH_GLOB,
  SupportStateWatcher,
  type SupportFileSystemWatcherFactory,
} from '../support/supportStateWatcher';
import { SupportRootRegistrationLifecycle } from '../support/supportRootRegistrationLifecycle';
import type { SupportConfigurationRegistration } from '../support/supportApplicationServiceRegistry';
import {
  type RegisterSupportCommandsDeps,
  type SupportCommandContext,
  type SupportCommandTarget,
} from '../support/supportCommands';
import { resolveSupportTreeDecoration } from '../support/supportTreeDecorations';
import type { SupportFeatureContext } from './extensionFeatureContexts';
import type { ExtensionRuntimeHandles } from '../state/extensionStateComposition';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import type { SupportStateCache as SupportStateCacheType } from '../support/supportStateCache';
import { sharedInfobaseConfigurationOperationQueue } from '../infobases/infobaseConfigurationOperationQueue';
import type { CompositionResourceOptions } from './extensionCompositionRoot';

export interface SupportFeatureCompositionDependencies {
  readonly context: SupportFeatureContext;
  readonly getConfigurationRegistry: () => Promise<WorkspaceRegistry>;
  readonly runConfigurationMutation: <T>(
    configPath: string,
    kind: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly registerDisposable: (
    name: string,
    disposable: vscode.Disposable | { dispose: () => Promise<void> | void } | (() => Promise<void> | void),
    options?: CompositionResourceOptions,
  ) => void;
  readonly registerQuiesce: (
    name: string,
    phase: 'ingress' | 'producers' | 'sessions',
    action: () => Promise<void> | void,
  ) => void;
}

export interface SupportFeatureComposition {
  readonly handles: Pick<
    ExtensionRuntimeHandles,
    'supportComposition' | 'supportStateCache' | 'supportStateWatcher' | 'supportRootRegistrationLifecycle'
  >;
  readonly commandDependencies: RegisterSupportCommandsDeps;
}

/** Builds support services beside the extension composition root and adopts each owner immediately. */
export function createSupportFeatureComposition({
  context,
  getConfigurationRegistry,
  runConfigurationMutation,
  registerDisposable,
  registerQuiesce,
}: SupportFeatureCompositionDependencies): SupportFeatureComposition {
  const { bindingManager, infobaseStorage, treeDataProvider } = context;
  const composition = createSupportServiceComposition({
    bindingManager,
    infobaseStorage,
    globalStorageRoot: context.extensionContext.globalStorageUri.fsPath,
    selector: (registration) => ({
      workspaceFolderName: registration.workspaceFolderName,
      configRelativePath: registration.configRelativePath,
    }),
    targetQueue: sharedInfobaseConfigurationOperationQueue,
    runExclusiveConfigurationOperation: runConfigurationMutation,
  });
  registerDisposable('support composition', () => composition.dispose());

  const cache = new SupportStateCache(createSupportStateCacheFacade(composition.facade));
  registerDisposable('support state cache', () => cache.clear());

  const watcher = new SupportStateWatcher(
    createSupportWatcherFactory(),
    cache,
    {
      onDidReload: (configRoot) => treeDataProvider.refreshSupportForRoot(configRoot),
      onReloadError: (configRoot, error) => {
        logFeatureError('Support state watcher reload failed', { configRoot, error });
      },
    },
  );
  registerDisposable('support state watcher', watcher, {
    quiescePhase: 'producers',
    quiesce: () => watcher.quiesce(),
  });

  const rootLifecycle = new SupportRootRegistrationLifecycle({
    registry: composition.registry,
    watcher,
    resolveRegistrations: async (configRoots) => {
      const workspaceRegistry = await getConfigurationRegistry();
      return resolveSupportRegistrations(configRoots, workspaceRegistry);
    },
    loadRegistration: async (registration) => {
      await cache.load(registration.configRoot);
    },
    onDidLoad: (registration) => treeDataProvider.refreshSupportForRoot(registration.configRoot),
    onError: (error) => {
      logFeatureError('Support root registration failed', error);
    },
  });
  registerDisposable('support root registration lifecycle', () => rootLifecycle.dispose());
  registerQuiesce('support root registration lifecycle', 'producers', () => rootLifecycle.quiesce());

  treeDataProvider.setSupportStateCache(cache);
  treeDataProvider.setSupportDecorationResolver(resolveSupportTreeDecoration);
  treeDataProvider.setSupportRootRegistrationCallback((configRoots) => rootLifecycle.accept(configRoots));

  const commandTargetResolver = new SupportBindingResolver({ bindingManager, infobaseStorage });
  const commandDependencies: RegisterSupportCommandsDeps = Object.freeze({
    facade: composition.facade,
    resolveContext: (argument: unknown) => resolveSupportCommandContext(argument, treeDataProvider, cache, composition),
    listTargets: (configurationId: ConfigurationId) => listSupportCommandTargets(
      configurationId,
      composition,
      commandTargetResolver,
    ),
    onStatusChanged: (configurationId: ConfigurationId) => {
      const registration = composition.registry.getRegistration(configurationId);
      if (!registration) {
        return;
      }
      cache.invalidate(registration.configRoot);
      void cache.load(registration.configRoot).then(
        () => treeDataProvider.refreshSupportForRoot(registration.configRoot),
        (error) => {
          logFeatureError('Support status refresh after command failed', error);
        },
      );
    },
  });

  return {
    handles: {
      supportComposition: composition,
      supportStateCache: cache,
      supportStateWatcher: watcher,
      supportRootRegistrationLifecycle: rootLifecycle,
    },
    commandDependencies,
  };
}

function createSupportWatcherFactory(): SupportFileSystemWatcherFactory {
  return {
    createFileSystemWatcher: (globPattern) => {
      if (globPattern !== SUPPORT_MASTER_WATCH_GLOB) {
        throw new Error('Unexpected support watcher glob.');
      }
      const watcher = vscode.workspace.createFileSystemWatcher(globPattern);
      return {
        onDidCreate: (listener) => watcher.onDidCreate((uri) => listener({ fsPath: uri.fsPath })),
        onDidChange: (listener) => watcher.onDidChange((uri) => listener({ fsPath: uri.fsPath })),
        onDidDelete: (listener) => watcher.onDidDelete((uri) => listener({ fsPath: uri.fsPath })),
        dispose: () => watcher.dispose(),
      };
    },
  };
}

async function resolveSupportRegistrations(
  configRoots: readonly string[],
  workspaceRegistry: WorkspaceRegistry,
): Promise<readonly SupportConfigurationRegistration[]> {
  const descriptorsByRoot = new Map(
    workspaceRegistry.list().map((descriptor) => [normalizeRootKey(descriptor.rootPath), descriptor]),
  );
  const workspaceFolders = await Promise.all(
    (vscode.workspace.workspaceFolders ?? []).map(async (folder) => ({
      folder,
      canonicalPath: await fs.realpath(folder.uri.fsPath),
    })),
  );
  const registrations: SupportConfigurationRegistration[] = [];
  for (const configRoot of configRoots) {
    const canonicalRoot = await fs.realpath(configRoot);
    const descriptor = descriptorsByRoot.get(normalizeRootKey(canonicalRoot));
    if (!descriptor) {
      throw new Error(`Workspace registry has no exact identity for support root: ${canonicalRoot}`);
    }
    const allowedWorkspaceRoots = new Set(
      descriptor.workspaceFolderUris.map((uri) => normalizeRootKey(vscode.Uri.parse(uri).fsPath)),
    );
    const workspace = workspaceFolders
      .filter(({ canonicalPath }) =>
        allowedWorkspaceRoots.has(normalizeRootKey(canonicalPath))
        && isPathInside(canonicalPath, descriptor.rootPath))
      .sort((left, right) => right.canonicalPath.length - left.canonicalPath.length)[0];
    if (!workspace) {
      throw new Error(`Support root is not owned by an exact workspace folder: ${canonicalRoot}`);
    }
    const descriptorPath = path.join(descriptor.rootPath, CONFIGURATION_XML);
    const configRelativePath = normalizeConfigRelativePath(
      path.relative(workspace.canonicalPath, descriptorPath).replace(/\\/g, '/'),
    );
    registrations.push({
      configurationId: descriptor.configurationId,
      configRoot: descriptor.rootPath,
      workspaceFolderName: workspace.folder.name,
      configRelativePath,
    });
  }
  return registrations;
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeRootKey(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

function resolveSupportCommandContext(
  argument: unknown,
  provider: MetadataTreeDataProvider,
  cache: SupportStateCacheType,
  composition: SupportServiceComposition,
): SupportCommandContext | undefined {
  if (!isTreeNode(argument) || !provider.isLoadedNode(argument)) {
    return undefined;
  }
  const configRoot = provider.getSupportConfigRootForNode(argument);
  if (!configRoot) {
    return undefined;
  }
  const registration = composition.registry.getRegistrationByRoot(configRoot);
  if (!registration) {
    return undefined;
  }
  const status = cache.get(registration.configRoot);
  if (!status || status.configurationId !== registration.configurationId) {
    return undefined;
  }
  if (argument.type === MetadataType.Configuration && argument.parent === undefined) {
    return { kind: 'configuration', configurationId: registration.configurationId };
  }
  const decoration = resolveSupportTreeDecoration(argument, status);
  return decoration?.kind === 'object'
    ? { kind: 'object', configurationId: registration.configurationId, objectId: decoration.objectId }
    : undefined;
}

async function listSupportCommandTargets(
  configurationId: ConfigurationId,
  composition: SupportServiceComposition,
  resolver: SupportBindingResolver,
): Promise<readonly SupportCommandTarget[]> {
  const registration = composition.registry.getRegistration(configurationId);
  if (!registration) {
    return [];
  }
  const result = await resolver.resolve({
    workspaceFolderName: registration.workspaceFolderName,
    configRelativePath: registration.configRelativePath,
  });
  if (!result.accepted || result.scope === 'masterOnly') {
    return [];
  }
  return result.targets.map((target) => ({
    canonicalTargetId: target.canonicalTargetId,
    label: target.entry.name,
    description: target.infobaseIds.length > 1
      ? `Записей каталога: ${target.infobaseIds.length}`
      : undefined,
    detail: target.canonicalTargetId,
  }));
}

function isTreeNode(value: unknown): value is TreeNode {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<TreeNode>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.type === 'string'
    && candidate.properties !== undefined
    && typeof candidate.properties === 'object';
}

function logFeatureError(message: string, error: unknown): void {
  try {
    Logger.error(message, error);
  } catch {
    // Diagnostics must not interrupt support lifecycle work.
  }
}
