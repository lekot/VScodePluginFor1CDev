import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { registerExternalProcessorCommands } from './externalProcessorCommands';
import { ExtensionState } from '../state/extensionState';
import type { MetadataTreeLifecycle } from '../extension/metadataTreeLifecycle';
import { registerElementCommands } from './elementCommands';
import { registerNavigationCommands } from './navigationCommands';
import { registerEditorCommands } from './editorCommands';
import { registerConfigurationCompareCommands } from './configurationCompareCommands';
import { registerCfCommands } from './cfCommands';
import { registerFilterCommands } from './filterCommands';
import {
  registerUtilityCommandsLeading,
  registerUtilityCommandsTrailing,
} from './utilityCommands';
import { registerExtensionCommands } from '../extensionSupport/extensionCommands';
import { registerAgentCommands } from '../agent/agentCommands';
import { DebugSessionRegistry } from '../agent/debugSessionRegistry';
import { activateAgentBridge } from '../agent/agentBridgeActivation';
import { FormatDetector } from '../parsers/formatDetector';
import { WorkspaceRegistry } from '../services/configurationSession/WorkspaceRegistry';
import { configureConfigurationMutationGateway } from '../services/configurationSession/configurationMutationGateway';
import { MetadataType, type TreeNode } from '../models/treeNode';
import { sharedInfobaseConfigurationOperationQueue } from '../infobases/infobaseConfigurationOperationQueue';
import { createSupportServiceComposition } from '../support/supportServiceComposition';
import { SupportStateCache } from '../support/supportStateCache';
import {
  SUPPORT_MASTER_WATCH_GLOB,
  SupportStateWatcher,
  type SupportFileSystemWatcherFactory,
} from '../support/supportStateWatcher';
import { SupportRootRegistrationLifecycle } from '../support/supportRootRegistrationLifecycle';
import type { SupportConfigurationRegistration } from '../support/supportApplicationServiceRegistry';
import type { ConfigurationId } from '../services/configurationSession/types';
import { SupportBindingResolver } from '../support/supportBindingResolver';
import {
  registerSupportCommands,
  type SupportCommandContext,
  type SupportCommandTarget,
} from '../support/supportCommands';
import { resolveSupportTreeDecoration } from '../support/supportTreeDecorations';
import type { DeploySupportContext } from '../bindings/deployService';
import { normalizeConfigRelativePath } from '../bindings/bindingPathUtils';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { Logger } from '../utils/logger';
import { registerConfigurationRepositoryCommands } from './configurationRepositoryCommands';

export type RegisterAllCommandsArgs = {
  context: vscode.ExtensionContext;
  state: ExtensionState;
  lifecycle: MetadataTreeLifecycle;
};


/** Registers every extension command; order matches historical subscription order in activation. */
export async function registerAllCommands({
  context,
  state,
  lifecycle,
}: RegisterAllCommandsArgs): Promise<vscode.Disposable[]> {
  const utilityDeps = {
    state,
    loadMetadataTree: lifecycle.loadMetadataTree,
    extensionContext: context,
  };
  registerExternalProcessorCommands(context);
  registerExtensionCommands(context, state);

  const configurationRegistry = new WorkspaceRegistry(
    path.join(context.globalStorageUri.fsPath, 'configuration-identities.v1.json'),
  );
  let registryRefreshTail: Promise<void> = Promise.resolve();
  const getConfigurationRegistry = async (): Promise<WorkspaceRegistry> => {
    const refresh = async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const configs = await FormatDetector.findAllConfigurationRoots(folders.map((folder) => folder.uri.fsPath));
      await configurationRegistry.refresh(await Promise.all(configs.map(async (config) => ({
        ...config,
        format: await FormatDetector.detect(config.configPath),
      }))));
    };
    const current = registryRefreshTail.then(refresh, refresh);
    registryRefreshTail = current.then(() => undefined, () => undefined);
    await current;
    return configurationRegistry;
  };
  const runConfigurationMutation = async <T>(
    configPath: string,
    kind: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const registry = await getConfigurationRegistry();
    const session = await registry.resolveResource(configPath);
    const outcome = await session.enqueue({ kind, execute: operation });
    if (outcome.status === 'committed') {
      return outcome.value;
    }
    throw outcome.status === 'failed' || outcome.status === 'conflict'
      ? outcome.error ?? new Error('Операция конфигурации не выполнена.')
      : new Error('Операция конфигурации отменена.');
  };
  const runConfigurationPlan = async <T>(configPath: string, plan: import('../services/configurationSession/mutationPlan').MutationPlan<T>): Promise<T> => {
    const registry = await getConfigurationRegistry();
    const session = await registry.resolveResource(configPath);
    const outcome = await session.enqueuePlan(plan);
    if (outcome.status === 'committed') { return outcome.value; }
    throw outcome.status === 'failed' || outcome.status === 'conflict'
      ? outcome.error ?? new Error('Configuration plan failed.')
      : new Error('Configuration plan was cancelled.');
  };
  context.subscriptions.push(
    configureConfigurationMutationGateway(runConfigurationMutation, runConfigurationPlan),
  );
  configureSupportServices({
    context,
    state,
    getConfigurationRegistry,
    runConfigurationMutation,
  });
  context.subscriptions.push({ dispose: () => { void configurationRegistry.dispose(); } });

  // Agent API — регистрируем отдельно (не возвращают Disposable[] — управляют подписками сами)
  const debugRegistry = new DebugSessionRegistry();
  debugRegistry.activate(context);
  registerAgentCommands(
    context,
    () => state.treeDataProvider,
    getConfigurationRegistry,
    debugRegistry,
    () => {
      const bm = state.bindingManager;
      const is = state.infobaseStorage;
      if (!bm || !is) {return undefined;}
      return {
        bindingManager: bm,
        infobaseStorage: is,
        getConfigPath: () => state.treeDataProvider?.getConfigPath() ?? null,
      };
    },
    // Deploy deps — same shape as debug deps
    () => {
      const bm = state.bindingManager;
      const is = state.infobaseStorage;
      if (!bm || !is) {return undefined;}
      return {
        bindingManager: bm,
        infobaseStorage: is,
        getConfigPath: () => state.treeDataProvider?.getConfigPath() ?? null,
        resolveSupportContext: (configRoot) =>
          resolveAgentDeploySupportContext(configRoot, state, getConfigurationRegistry),
      };
    },
    () => {
      const facade = state.supportComposition?.facade;
      return facade ? { facade } : undefined;
    },
  );

  // Agent Bridge — HTTP сервер для вызова Agent API команд снаружи VS Code
  const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  state.agentBridge = await activateAgentBridge(context, wsFolder) ?? null;

  return [
    ...registerUtilityCommandsLeading(utilityDeps),
    ...registerConfigurationCompareCommands({ context, state }),
    ...registerCfCommands({ state }),
    ...registerEditorCommands({ state }),
    ...registerElementCommands({
      state,
      loadMetadataTree: lifecycle.loadMetadataTree,
      invalidateCacheAndReload: lifecycle.invalidateCacheAndReload,
      scheduleDeleteReconcile: lifecycle.reloadOrchestratorHandlers.scheduleDeleteReconcile,
      runConfigurationMutation,
      runConfigurationPlan,
    }),
    ...registerNavigationCommands({ state }),
    ...registerUtilityCommandsTrailing(utilityDeps),
    ...registerFilterCommands({
      state,
      loadMetadataTree: lifecycle.loadMetadataTree,
      invalidateTreeCacheOnly: lifecycle.invalidateTreeCacheOnly,
    }),
    ...registerConfigurationRepositoryCommands(state),
  ];
}

interface ConfigureSupportServicesArgs {
  readonly context: vscode.ExtensionContext;
  readonly state: ExtensionState;
  readonly getConfigurationRegistry: () => Promise<WorkspaceRegistry>;
  readonly runConfigurationMutation: <T>(
    configPath: string,
    kind: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

function configureSupportServices({
  context,
  state,
  getConfigurationRegistry,
  runConfigurationMutation,
}: ConfigureSupportServicesArgs): void {
  const bindingManager = state.bindingManager;
  const infobaseStorage = state.infobaseStorage;
  const provider = state.treeDataProvider;
  if (!bindingManager || !infobaseStorage || !provider) {
    throw new Error('Support services require initialized binding, infobase and tree providers.');
  }
  if (
    state.supportComposition
    || state.supportStateCache
    || state.supportStateWatcher
    || state.supportRootRegistrationLifecycle
  ) {
    throw new Error('Support services are already configured.');
  }

  const composition = createSupportServiceComposition({
    bindingManager,
    infobaseStorage,
    globalStorageRoot: context.globalStorageUri.fsPath,
    selector: (registration) => ({
      workspaceFolderName: registration.workspaceFolderName,
      configRelativePath: registration.configRelativePath,
    }),
    targetQueue: sharedInfobaseConfigurationOperationQueue,
    runExclusiveConfigurationOperation: runConfigurationMutation,
  });
  const cache = new SupportStateCache({
    getStatus: async (request) => {
      const outcome = await composition.facade.getStatus(request);
      if (outcome.status !== 'available') {
        throw new Error(`Support status is unavailable: ${outcome.errorCode}.`);
      }
      return outcome;
    },
  });
  const watcher = new SupportStateWatcher(
    createSupportWatcherFactory(),
    cache,
    {
      onDidReload: (configRoot) => {
        provider.refreshSupportForRoot(configRoot);
      },
      onReloadError: (configRoot, error) => {
        Logger.error('Support state watcher reload failed', { configRoot, error });
      },
    },
  );
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
    onDidLoad: (registration) => {
      provider.refreshSupportForRoot(registration.configRoot);
    },
    onError: (error) => {
      Logger.error('Support root registration failed', error);
    },
  });

  state.supportComposition = composition;
  state.supportStateCache = cache;
  state.supportStateWatcher = watcher;
  state.supportRootRegistrationLifecycle = rootLifecycle;
  provider.setSupportStateCache(cache);
  provider.setSupportDecorationResolver(resolveSupportTreeDecoration);
  provider.setSupportRootRegistrationCallback((configRoots) => {
    rootLifecycle.accept(configRoots);
  });
  const commandTargetResolver = new SupportBindingResolver({
    bindingManager,
    infobaseStorage,
  });
  context.subscriptions.push(...registerSupportCommands({
    facade: composition.facade,
    resolveContext: (argument) =>
      resolveSupportCommandContext(argument, provider, cache, composition.registry),
    listTargets: (configurationId) =>
      listSupportCommandTargets(configurationId, composition.registry, commandTargetResolver),
    onStatusChanged: (configurationId) => {
      const registration = composition.registry.getRegistration(configurationId);
      if (!registration) {
        return;
      }
      cache.invalidate(registration.configRoot);
      void cache.load(registration.configRoot).then(
        () => provider.refreshSupportForRoot(registration.configRoot),
        (error) => Logger.error('Support status refresh after command failed', error),
      );
    },
  }));
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
    workspaceRegistry.list().map((descriptor) => [
      normalizeRootKey(descriptor.rootPath),
      descriptor,
    ]),
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
      descriptor.workspaceFolderUris.map((uri) =>
        normalizeRootKey(vscode.Uri.parse(uri).fsPath)),
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

async function resolveAgentDeploySupportContext(
  configRoot: string,
  state: ExtensionState,
  getConfigurationRegistry: () => Promise<WorkspaceRegistry>,
): Promise<DeploySupportContext> {
  const composition = state.supportComposition;
  const cache = state.supportStateCache;
  if (!composition || !cache) {
    throw new Error('Support deploy preflight is unavailable.');
  }

  const canonicalRoot = await fs.realpath(path.resolve(configRoot));
  const workspaceRegistry = await getConfigurationRegistry();
  const descriptor = workspaceRegistry.list().find(
    (candidate) => normalizeRootKey(candidate.rootPath) === normalizeRootKey(canonicalRoot),
  );
  const registration = composition.registry.getRegistrationByRoot(canonicalRoot);
  if (
    !descriptor
    || !registration
    || registration.configurationId !== descriptor.configurationId
    || normalizeRootKey(registration.configRoot) !== normalizeRootKey(canonicalRoot)
    || !cache.isRegistered(canonicalRoot)
  ) {
    throw new Error('Support deploy preflight cannot resolve an exact registered configuration.');
  }

  return {
    configurationId: descriptor.configurationId,
    facade: Object.freeze({
      getStatus: (request) => composition.facade.getStatus(request),
      getMasterStatus: (request) => composition.facade.getMasterStatus(request),
      sync: (request) => composition.facade.sync(request),
    }),
  };
}

function resolveSupportCommandContext(
  argument: unknown,
  provider: NonNullable<ExtensionState['treeDataProvider']>,
  cache: SupportStateCache,
  registry: import('../support/supportApplicationServiceRegistry').SupportApplicationServiceRegistry,
): SupportCommandContext | undefined {
  if (!isTreeNode(argument)) {
    return undefined;
  }
  if (!provider.isLoadedNode(argument)) {
    return undefined;
  }
  const configRoot = provider.getSupportConfigRootForNode(argument);
  if (!configRoot) {
    return undefined;
  }
  const registration = registry.getRegistrationByRoot(configRoot);
  if (!registration) {
    return undefined;
  }
  const status = cache.get(registration.configRoot);
  if (!status || status.configurationId !== registration.configurationId) {
    return undefined;
  }
  if (
    argument.type === MetadataType.Configuration
    && argument.parent === undefined
  ) {
    return {
      kind: 'configuration',
      configurationId: registration.configurationId,
    };
  }
  const decoration = resolveSupportTreeDecoration(argument, status);
  if (decoration?.kind !== 'object') {
    return undefined;
  }
  return {
    kind: 'object',
    configurationId: registration.configurationId,
    objectId: decoration.objectId,
  };
}

async function listSupportCommandTargets(
  configurationId: ConfigurationId,
  registry: import('../support/supportApplicationServiceRegistry').SupportApplicationServiceRegistry,
  resolver: SupportBindingResolver,
): Promise<readonly SupportCommandTarget[]> {
  const registration = registry.getRegistration(configurationId);
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
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<TreeNode>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.type === 'string'
    && candidate.properties !== undefined
    && typeof candidate.properties === 'object';
}
