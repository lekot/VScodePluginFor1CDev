// src/extension/extensionCompositionRoot.ts
// Composition Root for CDT 41 (Architecture Roadmap #267, Issue #261).
// Provides single-point deterministic service graph construction,
// narrow typed capability injection, and LIFO teardown ownership.

import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionState } from '../state/extensionState';
import type {
  MetadataTreeLifecycle,
  MetadataTreeFeatureLifecycle,
} from './metadataTreeLifecycle';
import { WorkspaceRegistry } from '../services/configurationSession/WorkspaceRegistry';
import { WorkspaceRegistryCoordinator } from '../services/configurationSession/WorkspaceRegistryCoordinator';
import { ConfigurationContextResolver } from '../services/configurationSession/ConfigurationContextResolver';
import {
  ConfigurationMutationEngine,
  setConfigurationMutationEngine,
} from '../services/configurationSession/ConfigurationMutationEngine';
import { configureConfigurationMutationGateway } from '../services/configurationSession/configurationMutationGateway';
import { InfobaseStorageService } from '../infobases/infobaseStorageService';
import { BindingManager } from '../bindings/bindingManager';
import { InfobaseCatalogMutationService } from '../infobases/infobaseCatalogMutationService';
import { InfobaseManager } from '../infobases/infobaseManager';
import { ReloadCoordinatorService } from '../services/reloadCoordinatorService';
import {
  createRequestConfigurationReload,
  type RequestConfigurationReload,
} from '../reload/requestConfigurationReload';
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
import { SubsystemCommandInterfaceProvider } from '../subsystemCommandInterfaceEditor';
import { XdtoPackageEditorProvider } from '../xdtoPackageEditor';
import { FormEditorProvider } from '../formEditor/formEditorProvider';
import { MxlPreviewProvider } from '../mxlPreview/mxlPreviewProvider';
import {
  TEMPLATE_EDITOR_VIEW_TYPE,
  TemplateEditorProvider,
} from '../templateEditor/templateEditorProvider';
import { registerTemplateDiffCommands } from '../templateEditor/templateDiffPanel';
import { INFOBASE_TREE_VIEW_ID, InfobaseTreeDataProvider } from '../infobases/infobaseTreeProvider';
import { registerIbcmdInfobaseHooks } from '../services/ibcmdService';
import { registerInfobaseTreeCommands } from '../infobases/registerInfobaseTreeCommands';
import { registerBindingDialogCommands } from '../bindings/bindingDialog';
import {
  rebuildBindingDecorationsForTree,
  registerBindingDecorationSync,
} from '../bindings/bindingTreeDecorations';
import { registerBslCompletionProvider } from '../providers/bslCompletionProvider';
import { registerBslSignatureHelpProvider } from '../providers/bslSignatureHelpProvider';
import { registerMetadataWorkspaceFolderLifecycle } from './metadataWorkspaceFolders';
import { registerLazyWorkspaceOrchestrator } from './lazyWorkspaceOrchestrator';
import { registerGitPhase4HeadChangeHandlers } from '../services/gitIntegration';
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
import { registerAllCommands } from '../commands';
import { MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';

export interface ConfigurationInfrastructure {
  readonly workspaceRegistry: WorkspaceRegistry;
  readonly registryCoordinator: WorkspaceRegistryCoordinator;
  readonly contextResolver: ConfigurationContextResolver;
  readonly mutationEngine: ConfigurationMutationEngine;
  readonly runConfigurationMutation: <T>(
    configPath: string,
    kind: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly runConfigurationPlan: <T>(
    configPath: string,
    plan: import('../services/configurationSession/mutationPlan').MutationPlan<T>,
  ) => Promise<T>;
  readonly getConfigurationRegistry: () => Promise<WorkspaceRegistry>;
}

export interface CompositionPipelineStages {
  readonly initInfobaseServices?: (root: ExtensionCompositionRoot) => Promise<void> | void;
  readonly initConfigurationInfrastructure?: (
    root: ExtensionCompositionRoot,
  ) => Promise<ConfigurationInfrastructure> | ConfigurationInfrastructure;
  readonly initTreeAndReload?: (
    root: ExtensionCompositionRoot,
    infra: ConfigurationInfrastructure,
  ) => Promise<void> | void;
  readonly initEditors?: (root: ExtensionCompositionRoot) => Promise<void> | void;
  readonly initInfobaseFeatures?: (root: ExtensionCompositionRoot) => Promise<void> | void;
  readonly initRepositoryServices?: (
    root: ExtensionCompositionRoot,
    reload: RequestConfigurationReload,
  ) => Promise<void> | void;
  readonly initCommands?: (
    root: ExtensionCompositionRoot,
    infra: ConfigurationInfrastructure,
  ) => Promise<void> | void;
}

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

export class ExtensionCompositionRoot implements vscode.Disposable {
  private readonly _disposables: Array<{ name: string; dispose: () => Promise<void> | void }> = [];
  private _isDisposed = false;
  private _infra: ConfigurationInfrastructure | null = null;
  private _requestConfigurationReload: RequestConfigurationReload | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: ExtensionState,
    private readonly lifecycle: MetadataTreeLifecycle,
    private readonly stages?: CompositionPipelineStages,
  ) {}

  registerDisposable(
    name: string,
    disposable: vscode.Disposable | { dispose: () => Promise<void> | void } | (() => Promise<void> | void),
  ): void {
    if (typeof disposable === 'function') {
      this._disposables.push({ name, dispose: disposable });
    } else {
      this._disposables.push({
        name,
        dispose: () => disposable.dispose(),
      });
    }
  }

  get infrastructure(): ConfigurationInfrastructure | null {
    return this._infra;
  }

  get requestConfigurationReload(): RequestConfigurationReload | null {
    return this._requestConfigurationReload;
  }

  async compose(): Promise<void> {
    try {
      // 1. Infobase core services
      if (this.stages?.initInfobaseServices) {
        await this.stages.initInfobaseServices(this);
      } else {
        await this.defaultInitInfobaseServices();
      }

      // 2. Configuration Infrastructure & Mutation Engine
      let infra: ConfigurationInfrastructure;
      if (this.stages?.initConfigurationInfrastructure) {
        infra = await this.stages.initConfigurationInfrastructure(this);
      } else {
        infra = await this.defaultInitConfigurationInfrastructure();
      }
      this._infra = infra;

      // 3. Tree Model, Lifecycle & Reload Coordinator
      if (this.stages?.initTreeAndReload) {
        await this.stages.initTreeAndReload(this, infra);
      } else {
        await this.defaultInitTreeAndReload();
      }

      // 4. Editor Providers & Webviews
      if (this.stages?.initEditors) {
        await this.stages.initEditors(this);
      } else {
        await this.defaultInitEditors();
      }

      // 5. Infobase UI & Bindings Features
      if (this.stages?.initInfobaseFeatures) {
        await this.stages.initInfobaseFeatures(this);
      } else {
        await this.defaultInitInfobaseFeatures();
      }

      // 6. Configuration Repository Services
      if (this.stages?.initRepositoryServices) {
        await this.stages.initRepositoryServices(this, this._requestConfigurationReload!);
      } else if (this._requestConfigurationReload) {
        await this.defaultInitRepositoryServices(this._requestConfigurationReload);
      }

      // 7. Commands & Integration
      if (this.stages?.initCommands) {
        await this.stages.initCommands(this, infra);
      } else {
        await this.defaultInitCommands(infra);
      }
    } catch (err) {
      Logger.error('ExtensionCompositionRoot: composition failed, rolling back partial state', err);
      await this.rollback();
      throw err;
    }
  }

  async rollback(): Promise<void> {
    const errors: unknown[] = [];
    const items = this._disposables.splice(0).reverse();

    for (const item of items) {
      try {
        await item.dispose();
      } catch (err) {
        errors.push(err);
        Logger.error(`ExtensionCompositionRoot rollback error for ${item.name}`, err);
      }
    }

    // Reset ExtensionState handles
    this.state.workspaceRegistry = null;
    this.state.configurationContextResolver = null;
    this.state.configurationMutationEngine = null;
    setConfigurationMutationEngine(undefined);
    this.state.reloadCoordinator = null;
    this.state.treeDataProvider = null;
    this.state.treeView = null;
    this.state.propertiesProvider = null;
    this.state.typeEditorProvider = null;
    this.state.rolesRightsEditorProvider = null;
    this.state.formEditorProvider = null;
    this.state.mxlPreviewProvider = null;
    this.state.infobaseStorage = null;
    this.state.bindingManager = null;
    this.state.infobaseManager = null;
    this.state.infobaseTreeProvider = null;
    this.state.infobaseTreeView = null;
    this.state.configurationRepositoryService = null;
    this.state.configurationRepositoryProjection = null;
    this._infra = null;
    this._requestConfigurationReload = null;
  }

  async dispose(): Promise<void> {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    await this.rollback();
  }

  // ─── Default Pipeline Stages ───────────────────────────────────────────────

  private async defaultInitInfobaseServices(): Promise<void> {
    const storage = new InfobaseStorageService(this.context.globalState, this.context.secrets);
    this.state.infobaseStorage = storage;
    this.registerDisposable('infobaseStorage', storage);

    const bindingManager = new BindingManager();
    this.state.bindingManager = bindingManager;

    const mutationService = new InfobaseCatalogMutationService({
      storage,
      secretStorage: this.context.secrets,
      bindingManager,
      memento: this.context.globalState,
    });

    const infobaseManager = new InfobaseManager(storage, bindingManager, mutationService);
    this.state.infobaseManager = infobaseManager;

    void mutationService.recoverPendingMutations();
  }

  private async defaultInitConfigurationInfrastructure(): Promise<ConfigurationInfrastructure> {
    const configurationRegistry = new WorkspaceRegistry(
      path.join(this.context.globalStorageUri.fsPath, 'configuration-identities.v1.json'),
    );
    this.state.workspaceRegistry = configurationRegistry;
    this.registerDisposable('workspaceRegistry', {
      dispose: () => configurationRegistry.dispose(),
    });

    const registryCoordinator = new WorkspaceRegistryCoordinator(configurationRegistry, {
      getWorkspaceFolders: () =>
        (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      getWorkspaceFolderForPath: (filePath) =>
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath,
    });
    this.registerDisposable('registryCoordinator', {
      dispose: () => {
        void registryCoordinator.dispose();
      },
    });

    const contextResolver = new ConfigurationContextResolver(registryCoordinator, {
      getWorkspaceFolderForPath: (filePath) =>
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath,
    });
    this.state.configurationContextResolver = contextResolver;

    const getConfigurationRegistry = async (): Promise<WorkspaceRegistry> => {
      return registryCoordinator.getRegistry();
    };

    const workspaceFoldersChangeSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void registryCoordinator.refreshWorkspace();
    });
    this.registerDisposable('workspaceFoldersChangeSub', workspaceFoldersChangeSub);

    const runConfigurationMutation = async <T>(
      configPath: string,
      kind: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const session = await registryCoordinator.resolveResource(configPath);
      const outcome = await session.enqueue({ kind, execute: operation });
      if (outcome.status === 'committed') {
        return outcome.value;
      }
      throw outcome.status === 'failed' || outcome.status === 'conflict'
        ? outcome.error ?? new Error('Операция конфигурации не выполнена.')
        : new Error('Операция конфигурации отменена.');
    };

    const runConfigurationPlan = async <T>(
      configPath: string,
      plan: import('../services/configurationSession/mutationPlan').MutationPlan<T>,
    ): Promise<T> => {
      const session = await registryCoordinator.resolveResource(configPath);
      const outcome = await session.enqueuePlan(plan);
      if (outcome.status === 'committed') {
        return outcome.value;
      }
      throw outcome.status === 'failed' || outcome.status === 'conflict'
        ? outcome.error ?? new Error('Configuration plan failed.')
        : new Error('Configuration plan was cancelled.');
    };

    const gatewayDisposable = configureConfigurationMutationGateway(
      runConfigurationMutation,
      runConfigurationPlan,
    );
    this.registerDisposable('configurationMutationGateway', gatewayDisposable);

    const mutationEngine = new ConfigurationMutationEngine({
      contextResolver,
      runMutation: runConfigurationMutation,
      runPlan: runConfigurationPlan,
    });
    this.state.configurationMutationEngine = mutationEngine;
    setConfigurationMutationEngine(mutationEngine);

    return {
      workspaceRegistry: configurationRegistry,
      registryCoordinator,
      contextResolver,
      mutationEngine,
      runConfigurationMutation,
      runConfigurationPlan,
      getConfigurationRegistry,
    };
  }

  private async defaultInitTreeAndReload(): Promise<void> {
    registerBslCompletionProvider(this.context, this.context.extensionPath, () => this.state.treeDataProvider);
    registerBslSignatureHelpProvider(this.context);

    this.registerDisposable('lifecycle', { dispose: this.lifecycle.dispose });

    const workspaceFolderLifecycle = registerMetadataWorkspaceFolderLifecycle(this.lifecycle);
    this.registerDisposable('workspaceFolderLifecycle', workspaceFolderLifecycle);

    const treeDataProvider = new MetadataTreeDataProvider();
    this.state.treeDataProvider = treeDataProvider;
    this.registerDisposable('treeDataProvider', treeDataProvider);

    const treeView = vscode.window.createTreeView('1c-metadata-tree', {
      treeDataProvider,
      showCollapseAll: true,
      canSelectMany: true,
    });
    this.state.treeView = treeView;
    this.registerDisposable('treeView', treeView);

    treeDataProvider.setMessageUpdater((msg) => {
      if (this.state.treeView) {
        this.state.treeView.message = msg ?? '';
      }
    });

    const reloadCoordinator = new ReloadCoordinatorService(
      async ({ configPath, reason, operationId, canPublish }) => {
        Logger.info('reload.run.started', { configPath, reason, operationId });
        const outcome = await this.lifecycle.executeConfigurationReload(configPath, canPublish);
        Logger.info('reload.run.completed', {
          configPath,
          reason,
          operationId,
          status: outcome.status,
        });
        return outcome;
      },
    );
    this.state.reloadCoordinator = reloadCoordinator;
    this.registerDisposable('reloadCoordinator', {
      dispose: () => {
        void reloadCoordinator.dispose();
      },
    });

    this._requestConfigurationReload = createRequestConfigurationReload(this.state);
  }

  private async defaultInitEditors(): Promise<void> {
    const compositionDeps = {
      loadMetadataTree: () => this.lifecycle.loadMetadataTree(),
      invalidateTreeCacheOnly: (cp: string) => this.lifecycle.invalidateTreeCacheOnly(cp),
    };

    const typeEditor = new TypeEditorProvider(this.context);
    this.state.typeEditorProvider = typeEditor;

    const rolesEditor = new RolesRightsEditorProvider(this.context);
    this.state.rolesRightsEditorProvider = rolesEditor;
    this.registerDisposable('rolesRightsEditorProvider', rolesEditor);

    const subsystemComp = new CompositionEditorProvider(this.context, compositionDeps, SubsystemStrategy);
    this.state.subsystemCompositionEditorProvider = subsystemComp;
    this.registerDisposable('subsystemCompositionEditorProvider', subsystemComp);

    const exchangePlanComp = new CompositionEditorProvider(this.context, compositionDeps, ExchangePlanStrategy);
    this.state.exchangePlanCompositionEditorProvider = exchangePlanComp;
    this.registerDisposable('exchangePlanCompositionEditorProvider', exchangePlanComp);

    const commonAttrComp = new CompositionEditorProvider(this.context, compositionDeps, CommonAttributeStrategy);
    this.state.commonAttributeCompositionEditorProvider = commonAttrComp;
    this.registerDisposable('commonAttributeCompositionEditorProvider', commonAttrComp);

    const functionalOptionComp = new CompositionEditorProvider(this.context, compositionDeps, FunctionalOptionStrategy);
    this.state.functionalOptionCompositionEditorProvider = functionalOptionComp;
    this.registerDisposable('functionalOptionCompositionEditorProvider', functionalOptionComp);

    const filterCriterionComp = new CompositionEditorProvider(this.context, compositionDeps, FilterCriterionStrategy);
    this.state.filterCriterionCompositionEditorProvider = filterCriterionComp;
    this.registerDisposable('filterCriterionCompositionEditorProvider', filterCriterionComp);

    const subsystemCmd = new SubsystemCommandInterfaceProvider(this.context);
    this.state.subsystemCommandInterfaceProvider = subsystemCmd;
    this.registerDisposable('subsystemCommandInterfaceProvider', subsystemCmd);

    const xdtoEditor = new XdtoPackageEditorProvider(this.context);
    this.state.xdtoPackageEditorProvider = xdtoEditor;
    this.registerDisposable('xdtoPackageEditorProvider', xdtoEditor);

    const propertiesProvider = new PropertiesProvider(
      this.context,
      this.state.treeDataProvider!,
      this.state.typeEditorProvider!,
      (payload) => {
        this.state.formEditorProvider?.applySelectionPropertyChange(payload);
      },
      (payload) => {
        this.state.formEditorProvider?.gotoEventHandler(payload);
      },
      (payload) => {
        this.state.formEditorProvider?.createEventHandler(payload);
      },
    );
    this.state.propertiesProvider = propertiesProvider;
    this.registerDisposable('propertiesProvider', propertiesProvider);

    if (this.state.treeView) {
      const treeSelectionDisposable = this.state.treeView.onDidChangeSelection(async (e) => {
        if (e.selection.length > 0) {
          const selectedNode = e.selection[0];
          Logger.debug(`Tree selection changed: ${selectedNode.name}`);

          if (selectedNode.type === MetadataType.Role && selectedNode.filePath) {
            if (this.state.rolesRightsEditorProvider?.isOpen()) {
              await this.state.rolesRightsEditorProvider.updateIfOpen(selectedNode);
            }
          } else if (this.state.propertiesProvider?.isOpen()) {
            await this.state.propertiesProvider.updateIfOpen(selectedNode);
          }
        }
      });
      this.registerDisposable('treeSelectionDisposable', treeSelectionDisposable);
    }

    const formEditor = new FormEditorProvider((payload) => {
      if (this.state.propertiesProvider) {
        void this.state.propertiesProvider.showFormSelectionProperties(payload);
      }
    });
    this.state.formEditorProvider = formEditor;
    this.registerDisposable(
      'formEditorProvider',
      vscode.window.registerCustomEditorProvider('1c-form-editor', formEditor, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );

    const mxlPreview = new MxlPreviewProvider();
    this.state.mxlPreviewProvider = mxlPreview;
    this.registerDisposable(
      'mxlPreviewProvider',
      vscode.window.registerCustomEditorProvider('1c-mxl-preview', mxlPreview, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }),
    );

    this.registerDisposable(
      'templateEditorProvider',
      vscode.window.registerCustomEditorProvider(
        TEMPLATE_EDITOR_VIEW_TYPE,
        new TemplateEditorProvider(this.context.extensionUri),
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    );
    registerTemplateDiffCommands(this.context);
  }

  private async defaultInitInfobaseFeatures(): Promise<void> {
    registerIbcmdInfobaseHooks(this.context);

    if (this.state.infobaseStorage) {
      const storage = this.state.infobaseStorage;
      const infobaseTreeProvider = new InfobaseTreeDataProvider(storage);
      this.state.infobaseTreeProvider = infobaseTreeProvider;

      const infobaseTreeView = vscode.window.createTreeView(INFOBASE_TREE_VIEW_ID, {
        treeDataProvider: infobaseTreeProvider,
        showCollapseAll: true,
      });
      this.state.infobaseTreeView = infobaseTreeView;
      this.registerDisposable('infobaseTreeView', infobaseTreeView);
      void syncInfobaseTreeViewMessage(this.state);

      const catalogChangeSub = storage.onDidChangeCatalog(() => {
        infobaseTreeProvider.refresh();
        void syncInfobaseTreeViewMessage(this.state);
      });
      this.registerDisposable('catalogChangeSub', catalogChangeSub);

      const treeCommands = registerInfobaseTreeCommands(this.state);
      for (const cmd of treeCommands) {
        this.registerDisposable('infobaseTreeCommand', cmd);
      }

      this.state.refreshBindingTreeDecorations = () => rebuildBindingDecorationsForTree(this.state);
      const bindingDialogCommands = registerBindingDialogCommands(
        this.context,
        this.state,
        this.state.treeDataProvider,
      );
      for (const cmd of bindingDialogCommands) {
        this.registerDisposable('bindingDialogCommand', cmd);
      }

      const bindingSyncDisposable = registerBindingDecorationSync(this.state);
      this.registerDisposable('bindingDecorationSync', bindingSyncDisposable);
      void rebuildBindingDecorationsForTree(this.state);
    }
  }

  private async defaultInitRepositoryServices(
    requestConfigurationReload: RequestConfigurationReload,
  ): Promise<void> {
    const storage = this.state.infobaseStorage;
    const provider = this.state.treeDataProvider;
    if (!storage || !provider) {
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const repositoryStorageRoot = workspaceRoot
      ? path.join(workspaceRoot, '.vscode')
      : this.context.globalStorageUri.fsPath;
    const projection = new RepositoryStateProjection();
    const bindingStore = new RepositoryBindingStore(
      path.join(repositoryStorageRoot, 'configuration-repository-bindings.json'),
    );
    const stateStore = new RepositoryStateStore(
      path.join(repositoryStorageRoot, 'configuration-repository-state.json'),
    );
    const service = new ConfigurationRepositoryService({
      bindingStore,
      secretStore: new RepositorySecretStore(this.context.secrets),
      stateStore,
      infobaseStorage: storage,
      stateProjection: projection,
      onStateChanged: () => provider.refresh(),
      requestConfigurationReload,
    });
    this.state.configurationRepositoryProjection = projection;
    this.state.configurationRepositoryService = service;
    provider.setRepositoryStateReader(projection);
    provider.setRepositoryDecorationResolver(resolveRepositoryTreeDecoration);

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

  private async defaultInitCommands(infra: ConfigurationInfrastructure): Promise<void> {
    const trackedLifecycle: MetadataTreeFeatureLifecycle = {
      invalidateTreeCacheOnly: this.lifecycle.invalidateTreeCacheOnly,
      loadMetadataTree: () => this.lifecycle.loadMetadataTree(),
      reloadOrchestratorHandlers: this.lifecycle.reloadOrchestratorHandlers,
      dispose: this.lifecycle.dispose,
    };

    const commandDisposables = await registerAllCommands({
      context: this.context,
      state: this.state,
      lifecycle: trackedLifecycle,
      requestConfigurationReload: this._requestConfigurationReload!,
      infrastructure: infra,
    });

    for (const d of commandDisposables) {
      this.registerDisposable('command', d);
    }

    if (this.state.treeView) {
      const infobaseTreeForGitRefresh = this.state.infobaseTreeProvider;
      const lazyOrchestrator = registerLazyWorkspaceOrchestrator({
        metadataView: this.state.treeView,
        infobaseView: this.state.infobaseTreeView ?? undefined,
        loadMetadataTree: () => trackedLifecycle.loadMetadataTree(),
        registerGitHeadChangeHandlers: () => {
          registerGitPhase4HeadChangeHandlers(this.context, {
            onReloadMetadataTree: () => trackedLifecycle.loadMetadataTree(),
            onRefreshInfobaseManager: infobaseTreeForGitRefresh
              ? () => {
                  infobaseTreeForGitRefresh.refresh();
                  void rebuildBindingDecorationsForTree(this.state);
                  void syncInfobaseTreeViewMessage(this.state);
                }
              : undefined,
          });
        },
        onAutoLoadError: (error) => Logger.error('Error during auto-load', error),
      });
      this.registerDisposable('lazyWorkspaceOrchestrator', lazyOrchestrator);
    }
  }
}
