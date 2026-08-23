import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionState } from '../state/extensionState';
import { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import { PropertiesProvider } from '../providers/propertiesProvider';
import { TypeEditorProvider } from '../providers/typeEditorProvider';
import { RolesRightsEditorProvider } from '../rolesEditor/rolesRightsEditorProvider';
import { CompositionEditorProvider } from '../compositionEditor/compositionEditorProvider';
import { SubsystemStrategy } from '../compositionEditor/strategies/subsystemStrategy';
import { ExchangePlanStrategy } from '../compositionEditor/strategies/exchangePlanStrategy';
import { CommonAttributeStrategy } from '../compositionEditor/strategies/commonAttributeStrategy';
import { FunctionalOptionStrategy } from '../compositionEditor/strategies/functionalOptionStrategy';
import { FilterCriterionStrategy } from '../compositionEditor/strategies/filterCriterionStrategy';
import { FormEditorProvider } from '../formEditor/formEditorProvider';
import { MxlPreviewProvider } from '../mxlPreview/mxlPreviewProvider';
import { ReloadCoordinatorService } from '../services/reloadCoordinatorService';
import { MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { registerAllCommands } from '../commands';
import { registerIbcmdInfobaseHooks } from '../services/ibcmdService';
import { INFOBASE_TREE_VIEW_ID, InfobaseTreeDataProvider } from '../infobases/infobaseTreeProvider';
import { registerInfobaseTreeCommands } from '../infobases/registerInfobaseTreeCommands';
import { registerBindingDialogCommands } from '../bindings/bindingDialog';
import { rebuildBindingDecorationsForTree, registerBindingDecorationSync } from '../bindings/bindingTreeDecorations';
import { MetadataTreeLifecycle } from './metadataTreeLifecycle';
import { SubsystemCommandInterfaceProvider } from '../subsystemCommandInterfaceEditor';
import { XdtoPackageEditorProvider } from '../xdtoPackageEditor';
import { registerGitPhase4HeadChangeHandlers } from '../services/gitIntegration';
import { registerLazyWorkspaceOrchestrator } from './lazyWorkspaceOrchestrator';
import { registerMetadataWorkspaceFolderLifecycle } from './metadataWorkspaceFolders';
import { ConfigurationRepositoryService } from '../services/configurationRepository/configurationRepositoryService';
import {
  RepositoryBindingStore,
  RepositorySecretStore,
  RepositoryStateStore,
} from '../services/configurationRepository/repositoryStores';
import {
  RepositoryStateProjection,
  resolveRepositoryTreeDecoration,
} from '../services/configurationRepository/repositoryTreeDecorations';

/** Empty-catalog hint (WOW design UC-01 / plan §1C). */
async function syncInfobaseTreeViewMessage(state: ExtensionState): Promise<void> {
  const storage = state.infobaseStorage;
  const view = state.infobaseTreeView;
  if (!storage || !view) {
    return;
  }
  try {
    const entries = await storage.load();
    view.message =
      entries.length === 0
        ? 'Нет баз в списке. Создайте, добавьте существующую или импортируйте из .v8i — кнопки на панели вида.'
        : undefined;
  } catch {
    view.message = 'Не удалось загрузить список информационных баз.';
  }
}

/** Registers metadata tree view, properties panel, type editor, and selection listener. */
function registerMetadataTreeProviders(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  lifecycle: MetadataTreeLifecycle
): void {
  state.treeDataProvider = new MetadataTreeDataProvider();

  state.treeView = vscode.window.createTreeView('1c-metadata-tree', {
    treeDataProvider: state.treeDataProvider,
    showCollapseAll: true,
    canSelectMany: true,
  });
  state.treeDataProvider.setMessageUpdater((msg) => {
    if (state.treeView) {
      state.treeView.message = msg ?? '';
    }
  });
  context.subscriptions.push(state.treeView);

  state.typeEditorProvider = new TypeEditorProvider(context);

  state.rolesRightsEditorProvider = new RolesRightsEditorProvider(context);
  context.subscriptions.push(state.rolesRightsEditorProvider);

  const compositionDeps = {
    loadMetadataTree: () => lifecycle.loadMetadataTree(),
    invalidateTreeCacheOnly: (cp: string) => lifecycle.invalidateTreeCacheOnly(cp),
  };

  state.subsystemCompositionEditorProvider = new CompositionEditorProvider(context, compositionDeps, SubsystemStrategy);
  context.subscriptions.push(state.subsystemCompositionEditorProvider);

  state.exchangePlanCompositionEditorProvider = new CompositionEditorProvider(context, compositionDeps, ExchangePlanStrategy);
  context.subscriptions.push(state.exchangePlanCompositionEditorProvider);

  state.commonAttributeCompositionEditorProvider = new CompositionEditorProvider(context, compositionDeps, CommonAttributeStrategy);
  context.subscriptions.push(state.commonAttributeCompositionEditorProvider);

  state.functionalOptionCompositionEditorProvider = new CompositionEditorProvider(context, compositionDeps, FunctionalOptionStrategy);
  context.subscriptions.push(state.functionalOptionCompositionEditorProvider);

  state.filterCriterionCompositionEditorProvider = new CompositionEditorProvider(context, compositionDeps, FilterCriterionStrategy);
  context.subscriptions.push(state.filterCriterionCompositionEditorProvider);

  state.subsystemCommandInterfaceProvider = new SubsystemCommandInterfaceProvider(context);
  context.subscriptions.push(state.subsystemCommandInterfaceProvider);

  state.xdtoPackageEditorProvider = new XdtoPackageEditorProvider(context);
  context.subscriptions.push(state.xdtoPackageEditorProvider);

  state.propertiesProvider = new PropertiesProvider(
    context,
    state.treeDataProvider,
    state.typeEditorProvider,
    (payload) => {
      state.formEditorProvider?.applySelectionPropertyChange(payload);
    },
    (payload) => {
      state.formEditorProvider?.gotoEventHandler(payload);
    },
    (payload) => {
      state.formEditorProvider?.createEventHandler(payload);
    }
  );
  context.subscriptions.push(state.propertiesProvider);

  const treeSelectionDisposable = state.treeView.onDidChangeSelection(async (e) => {
    if (e.selection.length > 0) {
      const selectedNode = e.selection[0];
      Logger.debug(`Tree selection changed: ${selectedNode.name}`);

      if (selectedNode.type === MetadataType.Role && selectedNode.filePath) {
        if (state.rolesRightsEditorProvider?.isOpen()) {
          await state.rolesRightsEditorProvider.updateIfOpen(selectedNode);
        }
      } else if (state.propertiesProvider?.isOpen()) {
        await state.propertiesProvider.updateIfOpen(selectedNode);
      }
    }
  });
  context.subscriptions.push(treeSelectionDisposable);
}

/** Registers form editor, MXL preview custom editor providers. */
function registerEditorProviders(
  context: vscode.ExtensionContext,
  state: ExtensionState
): void {
  state.formEditorProvider = new FormEditorProvider((payload) => {
    if (state.propertiesProvider) {
      void state.propertiesProvider.showFormSelectionProperties(payload);
    }
  });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('1c-form-editor', state.formEditorProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  state.mxlPreviewProvider = new MxlPreviewProvider();
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('1c-mxl-preview', state.mxlPreviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    })
  );
}

/** Registers infobase tree view, ibcmd hooks, binding commands. */
function registerInfobaseFeatures(
  context: vscode.ExtensionContext,
  state: ExtensionState
): void {
  registerIbcmdInfobaseHooks(context);

  if (state.infobaseStorage) {
    const infobaseTreeProvider = new InfobaseTreeDataProvider(state.infobaseStorage);
    state.infobaseTreeProvider = infobaseTreeProvider;
    state.infobaseTreeView = vscode.window.createTreeView(INFOBASE_TREE_VIEW_ID, {
      treeDataProvider: infobaseTreeProvider,
      showCollapseAll: true,
    });
    context.subscriptions.push(state.infobaseTreeView);
    syncInfobaseTreeViewMessage(state).catch((err) => Logger.error('syncInfobaseTreeViewMessage failed', err));
    context.subscriptions.push(
      state.infobaseStorage.onDidChangeCatalog(() => {
        infobaseTreeProvider.refresh();
        syncInfobaseTreeViewMessage(state).catch((err) => Logger.error('syncInfobaseTreeViewMessage failed', err));
      }),
    );
    context.subscriptions.push(...registerInfobaseTreeCommands(state));
    state.refreshBindingTreeDecorations = () => rebuildBindingDecorationsForTree(state);
    context.subscriptions.push(...registerBindingDialogCommands(context, state, state.treeDataProvider));
    context.subscriptions.push(registerBindingDecorationSync(state));
    rebuildBindingDecorationsForTree(state).catch((err) => Logger.error('rebuildBindingDecorationsForTree failed', err));
  }
}

/** Registers reload coordinator and wires it to the watcher lifecycle. */
function registerReloadCoordinator(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  lifecycle: MetadataTreeLifecycle
): void {
  state.reloadCoordinator = new ReloadCoordinatorService(async ({ configPath, reason, operationId }) => {
    Logger.info('reload.run.started', { configPath, reason, operationId });
    await lifecycle.invalidateCacheAndReload(configPath);
    Logger.info('reload.run.completed', { configPath, reason, operationId, success: true });
  });
  context.subscriptions.push({
    dispose: () => {
      state.reloadCoordinator?.dispose();
      state.reloadCoordinator = null;
    },
  });
}

/** Configures phase-1 Configuration Repository services and the synchronous tree projection. */
async function configureConfigurationRepositoryServices(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  lifecycle: MetadataTreeLifecycle,
): Promise<void> {
  const storage = state.infobaseStorage;
  const provider = state.treeDataProvider;
  if (!storage || !provider) {
    throw new Error('Configuration Repository requires initialized tree and infobase services.');
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const repositoryStorageRoot = workspaceRoot
    ? path.join(workspaceRoot, '.vscode')
    : context.globalStorageUri.fsPath;
  const projection = new RepositoryStateProjection();
  const bindingStore = new RepositoryBindingStore(
    path.join(repositoryStorageRoot, 'configuration-repository-bindings.json'),
  );
  const stateStore = new RepositoryStateStore(
    path.join(repositoryStorageRoot, 'configuration-repository-state.json'),
  );
  const service = new ConfigurationRepositoryService({
    bindingStore,
    secretStore: new RepositorySecretStore(context.secrets),
    stateStore,
    infobaseStorage: storage,
    stateProjection: projection,
    onStateChanged: () => provider.refresh(),
    reloadConfiguration: lifecycle.invalidateCacheAndReload,
  });
  state.configurationRepositoryProjection = projection;
  state.configurationRepositoryService = service;
  provider.setRepositoryStateReader(projection);
  provider.setRepositoryDecorationResolver(resolveRepositoryTreeDecoration);

  // Hydrate only the last-known projection; no Designer call is made here.
  try {
    for (const stored of await bindingStore.list()) {
      const target = {
        configRoot: stored.configRoot,
        configKind: stored.configKind,
        ...(stored.extensionName ? { extensionName: stored.extensionName } : {}),
        key: stored.targetKey,
      } as const;
      projection.set(target.key, await stateStore.get(target));
    }
  } catch (error) {
    Logger.warn('Configuration Repository projection hydration failed', error);
  }
}

/**
 * Orchestrates workspace registration: tree view, providers, reload coordinator,
 * editor providers, infobase features, commands, git handlers.
 */
export async function registerExtensionWorkspace(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  lifecycle: MetadataTreeLifecycle
): Promise<void> {
  context.subscriptions.push({ dispose: lifecycle.dispose });
  const workspaceFolderLifecycle = registerMetadataWorkspaceFolderLifecycle(lifecycle);
  context.subscriptions.push(workspaceFolderLifecycle);
  const trackedLifecycle: MetadataTreeLifecycle = {
    invalidateTreeCacheOnly: lifecycle.invalidateTreeCacheOnly,
    invalidateCacheAndReload: lifecycle.invalidateCacheAndReload,
    reloadConfiguration: lifecycle.reloadConfiguration,
    loadMetadataTree: () => workspaceFolderLifecycle.loadMetadataTree(),
    reloadOrchestratorHandlers: lifecycle.reloadOrchestratorHandlers,
    dispose: lifecycle.dispose,
  };

  registerMetadataTreeProviders(context, state, trackedLifecycle);
  registerReloadCoordinator(context, state, trackedLifecycle);
  registerEditorProviders(context, state);
  registerInfobaseFeatures(context, state);
  await configureConfigurationRepositoryServices(context, state, trackedLifecycle);

  const commandDisposables = await registerAllCommands({ context, state, lifecycle: trackedLifecycle });
  context.subscriptions.push(...commandDisposables);

  if (state.treeView) {
    const infobaseTreeForGitRefresh = state.infobaseTreeProvider;
    context.subscriptions.push(
      registerLazyWorkspaceOrchestrator({
        metadataView: state.treeView,
        infobaseView: state.infobaseTreeView ?? undefined,
        loadMetadataTree: () => trackedLifecycle.loadMetadataTree(),
        registerGitHeadChangeHandlers: () => {
          registerGitPhase4HeadChangeHandlers(context, {
            onReloadMetadataTree: () => trackedLifecycle.loadMetadataTree(),
            onRefreshInfobaseManager: infobaseTreeForGitRefresh
              ? () => {
                  infobaseTreeForGitRefresh.refresh();
                  void rebuildBindingDecorationsForTree(state);
                  void syncInfobaseTreeViewMessage(state);
                }
              : undefined,
          });
        },
        onAutoLoadError: (error) => Logger.error('Error during auto-load', error),
      })
    );
  }
}
