// src/extension/extensionCompositionRoot.ts
// Composition Root for CDT 41 (Architecture Roadmap #267, Issue #261).
// Provides single-point deterministic service graph construction,
// narrow typed capability injection, and LIFO teardown ownership.

import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionState } from '../state/extensionState';
import type { RecoveryOutcome } from '../infobases/infobaseCatalogMutationService';
import type {
  MetadataTreeLifecycle,
  MetadataTreeFeatureLifecycle,
} from './metadataTreeLifecycle';
import { WorkspaceRegistry } from '../services/configurationSession/WorkspaceRegistry';
import type { ConfigurationSessionFactory } from '../services/configurationSession/WorkspaceRegistry';
import { ConfigurationSession } from '../services/configurationSession/ConfigurationSession';
import type { ConfigurationCommitContext, MutationExecutionOptions, MutationOutcome } from '../services/configurationSession/ConfigurationSession';
import { WorkspaceRegistryCoordinator } from '../services/configurationSession/WorkspaceRegistryCoordinator';
import { ConfigurationContextResolver } from '../services/configurationSession/ConfigurationContextResolver';
import {
  ConfigurationMutationEngine,
  setConfigurationMutationEngine,
} from '../services/configurationSession/ConfigurationMutationEngine';
import {
  configureConfigurationMutationGateway,
  type MutationOutcomeRunner,
  type PlanOutcomeRunner,
} from '../services/configurationSession/configurationMutationGateway';
import { InfobaseStorageService } from '../infobases/infobaseStorageService';
import { BindingManager } from '../bindings/bindingManager';
import { InfobaseCatalogMutationService } from '../infobases/infobaseCatalogMutationService';
import { InfobaseManager } from '../infobases/infobaseManager';
import { ReloadCoordinatorService } from '../services/reloadCoordinatorService';
import {
  createRequestConfigurationReload,
  type RequestConfigurationReload,
} from '../reload/requestConfigurationReload';
import { reconcileAfterCommit } from '../reload/reconciliation';
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
import {
  registerMetadataWorkspaceFolderLifecycle,
  type MetadataWorkspaceFolderLifecycle,
} from './metadataWorkspaceFolders';
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
import { getActivationSubscriptionScope } from './activationSubscriptionScope';

export interface ConfigurationInfrastructure {
  readonly workspaceRegistry: WorkspaceRegistry;
  readonly registryCoordinator: WorkspaceRegistryCoordinator;
  readonly contextResolver: ConfigurationContextResolver;
  readonly mutationEngine: ConfigurationMutationEngine;
  readonly runConfigurationMutation: <T>(
    configPath: string,
    kind: string,
    operation: () => Promise<T>,
    options?: MutationExecutionOptions<T>,
  ) => Promise<T>;
  readonly runConfigurationPlan: <T>(
    configPath: string,
    plan: import('../services/configurationSession/mutationPlan').MutationPlan<T>,
    options?: MutationExecutionOptions<T>,
  ) => Promise<T>;
  readonly runConfigurationMutationOutcome?: MutationOutcomeRunner;
  readonly runConfigurationPlanOutcome?: PlanOutcomeRunner;
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
  private readonly _registeredDisposables = new Set<unknown>();
  private readonly _pendingLateDisposals = new Set<Promise<void>>();
  private readonly _workspaceFolderLifecycle: MetadataWorkspaceFolderLifecycle;
  private readonly _featureLifecycle: MetadataTreeFeatureLifecycle;
  private _isDisposing = false;
  private _rollbackPromise: Promise<void> | null = null;
  private _disposePromise: Promise<void> | null = null;
  private _infra: ConfigurationInfrastructure | null = null;
  private _requestConfigurationReload: RequestConfigurationReload | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: ExtensionState,
    private readonly lifecycle: MetadataTreeLifecycle,
    private readonly stages?: CompositionPipelineStages,
  ) {
    const subscriptionScope = getActivationSubscriptionScope(context);
    if (subscriptionScope) {
      subscriptionScope.bind(this);
      this.registerDisposable('activation subscription scope', () => subscriptionScope.close());
    }

    this._workspaceFolderLifecycle = registerMetadataWorkspaceFolderLifecycle(lifecycle);
    this._featureLifecycle = {
      invalidateTreeCacheOnly: lifecycle.invalidateTreeCacheOnly,
      loadMetadataTree: () => this._workspaceFolderLifecycle.loadMetadataTree(),
      reloadOrchestratorHandlers: lifecycle.reloadOrchestratorHandlers,
      dispose: lifecycle.dispose,
    };
  }

  registerDisposable(
    name: string,
    disposable: vscode.Disposable | { dispose: () => Promise<void> | void } | (() => Promise<void> | void),
  ): void {
    if (this._registeredDisposables.has(disposable)) {
      return;
    }
    this._registeredDisposables.add(disposable);

    const dispose = typeof disposable === 'function'
      ? disposable
      : () => disposable.dispose();
    if (this._isDisposing) {
      this.trackLateDisposal(name, dispose);
      return;
    }

    if (typeof disposable === 'function') {
      this._disposables.push({ name, dispose: disposable });
    } else {
      this._disposables.push({
        name,
        dispose,
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
      await this.dispose();
      throw err;
    }
  }

  rollback(): Promise<void> {
    if (this._rollbackPromise) {
      return this._rollbackPromise;
    }
    this._isDisposing = true;
    this._rollbackPromise = this.performRollback();
    return this._rollbackPromise;
  }

  private async performRollback(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this._workspaceFolderLifecycle.dispose();
    } catch (err) {
      errors.push(err);
      Logger.error('ExtensionCompositionRoot rollback error for workspaceFolderLifecycle', err);
    }
    const items = this._disposables.splice(0).reverse();

    for (const item of items) {
      try {
        await item.dispose();
      } catch (err) {
        errors.push(err);
        Logger.error(`ExtensionCompositionRoot rollback error for ${item.name}`, err);
      }
    }

    this.state.releaseCompositionRootReferences();
    setConfigurationMutationEngine(undefined);
    this._infra = null;
    this._requestConfigurationReload = null;
    await this.drainLateDisposals();
  }

  dispose(): Promise<void> {
    if (this._disposePromise) {
      return this._disposePromise;
    }
    this._isDisposing = true;
    this._disposePromise = Promise.resolve().then(async () => {
      await this.rollback();
      try {
        await this.state.dispose();
      } catch (error) {
        Logger.error('ExtensionCompositionRoot state fallback disposal failed', error);
      }
      await this.drainLateDisposals();
    });
    return this._disposePromise;
  }

  private trackLateDisposal(name: string, dispose: () => Promise<void> | void): void {
    const pending = Promise.resolve()
      .then(dispose)
      .catch((error) => {
        Logger.error(`ExtensionCompositionRoot late disposal error for ${name}`, error);
      })
      .then(() => undefined)
      .finally(() => this._pendingLateDisposals.delete(pending));
    this._pendingLateDisposals.add(pending);
  }

  private async drainLateDisposals(): Promise<void> {
    while (this._pendingLateDisposals.size > 0) {
      await Promise.all([...this._pendingLateDisposals]);
    }
  }

  // ─── Default Pipeline Stages ───────────────────────────────────────────────

  private async defaultInitInfobaseServices(): Promise<void> {
    const storage = this.state.infobaseStorage
      ?? new InfobaseStorageService(this.context.globalState, this.context.secrets);
    const bindingManager = this.state.bindingManager ?? new BindingManager();
    let infobaseManager = this.state.infobaseManager;

    if (infobaseManager && (infobaseManager.catalog !== storage || infobaseManager.bindings !== bindingManager)) {
      throw new Error('ExtensionState infobase graph contains mismatched storage or binding dependencies.');
    }

    const mutationService = infobaseManager?.mutations ?? new InfobaseCatalogMutationService({
      storage,
      secretStorage: this.context.secrets,
      bindingManager,
      memento: this.context.globalState,
    });
    infobaseManager ??= new InfobaseManager(storage, bindingManager, mutationService);

    this.state.infobaseStorage = storage;
    this.state.bindingManager = bindingManager;
    this.state.infobaseManager = infobaseManager;

    let recovery = this.state.infobaseMutationRecovery;
    if (!recovery) {
      recovery = mutationService.recoverPendingMutations();
      this.state.infobaseMutationRecovery = recovery;
    }

    let outcome: RecoveryOutcome;
    try {
      outcome = await recovery;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { recoveredCount: 0, errors: [message] };
      Logger.error('Infobase catalog mutation recovery failed', error);
    }
    this.state.infobaseRecoveryOutcome = outcome;
    if (outcome.errors.length > 0) {
      Logger.warn('Infobase catalog recovery is required; read-only catalog features remain available.', outcome.errors);
    }
  }

  private async defaultInitConfigurationInfrastructure(): Promise<ConfigurationInfrastructure> {
    const requestReloadAfterCommit: RequestConfigurationReload = async (configPath, reason) => {
      const requester = this._requestConfigurationReload;
      if (!requester) {
        throw Object.assign(new Error('Координатор перезагрузки конфигурации недоступен.'), {
          code: 'RELOAD_COORDINATOR_UNAVAILABLE',
        });
      }
      await requester(configPath, reason);
    };
    const observeConfigurationCommit = (commit: ConfigurationCommitContext) =>
      reconcileAfterCommit(
        commit.rootPath,
        commit.kind === 'agent.pullSelectedObjects' ? 'pull-objects' : 'agent-mutation',
        requestReloadAfterCommit,
      );
    const createSession: ConfigurationSessionFactory = (identity) =>
      new ConfigurationSession(identity, observeConfigurationCommit);
    const configurationRegistry = new WorkspaceRegistry(
      path.join(this.context.globalStorageUri.fsPath, 'configuration-identities.v1.json'),
      createSession,
    );
    this.state.workspaceRegistry = configurationRegistry;
    const registryCoordinator = new WorkspaceRegistryCoordinator(configurationRegistry, {
      getWorkspaceFolders: () =>
        (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      getWorkspaceFolderForPath: (filePath) =>
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath,
    });
    this.registerDisposable('registryCoordinator', {
      dispose: () => registryCoordinator.dispose(),
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
      void registryCoordinator.refreshWorkspace().catch((error) => {
        Logger.error('Workspace registry refresh after folder change failed', error);
      });
    });
    this.registerDisposable('workspaceFoldersChangeSub', workspaceFoldersChangeSub);

    const runConfigurationMutation = async <T>(
      configPath: string,
      kind: string,
      operation: () => Promise<T>,
      options?: MutationExecutionOptions<T>,
    ): Promise<T> => {
      const session = await registryCoordinator.resolveResource(configPath);
      return session.runMutationValue({ kind, ...options, execute: operation }, {
        failureMessage: 'Операция конфигурации не выполнена.',
        cancelledMessage: 'Операция конфигурации отменена.',
      });
    };

    const runConfigurationPlan = async <T>(
      configPath: string,
      plan: import('../services/configurationSession/mutationPlan').MutationPlan<T>,
      options?: MutationExecutionOptions<T>,
    ): Promise<T> => {
      const session = await registryCoordinator.resolveResource(configPath);
      return session.runPlanValue(plan, options);
    };

    const runConfigurationMutationOutcome: MutationOutcomeRunner = async <T>(
      configPath: string,
      kind: string,
      operation: () => Promise<T>,
      options?: MutationExecutionOptions<T>,
    ): Promise<MutationOutcome<T>> => {
      const session = await registryCoordinator.resolveResource(configPath);
      return session.enqueue({ kind, ...options, execute: operation });
    };
    const runConfigurationPlanOutcome: PlanOutcomeRunner = async <T>(
      configPath: string,
      plan: import('../services/configurationSession/mutationPlan').MutationPlan<T>,
      options?: MutationExecutionOptions<T>,
    ): Promise<MutationOutcome<T>> => {
      const session = await registryCoordinator.resolveResource(configPath);
      return session.enqueuePlan(plan, options);
    };

    const gatewayDisposable = configureConfigurationMutationGateway(
      runConfigurationMutation,
      runConfigurationPlan,
      runConfigurationMutationOutcome,
      runConfigurationPlanOutcome,
    );
    this.registerDisposable('configurationMutationGateway', gatewayDisposable);

    const mutationEngine = new ConfigurationMutationEngine({
      contextResolver,
      runMutation: runConfigurationMutation,
      runPlan: runConfigurationPlan,
      runMutationWithOutcome: runConfigurationMutationOutcome,
      runPlanWithOutcome: runConfigurationPlanOutcome,
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
      runConfigurationMutationOutcome,
      runConfigurationPlanOutcome,
      getConfigurationRegistry,
    };
  }

  private async defaultInitTreeAndReload(): Promise<void> {
    registerBslCompletionProvider(this.context, this.context.extensionPath, () => this.state.treeDataProvider);
    registerBslSignatureHelpProvider(this.context);

    this.registerDisposable('lifecycle', { dispose: this.lifecycle.dispose });

    const treeDataProvider = new MetadataTreeDataProvider();
    this.state.treeDataProvider = treeDataProvider;

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
      dispose: () => reloadCoordinator.dispose(),
    });

    this._requestConfigurationReload = createRequestConfigurationReload(this.state);
  }

  private async defaultInitEditors(): Promise<void> {
    const compositionDeps = {
      loadMetadataTree: () => this._workspaceFolderLifecycle.loadMetadataTree(),
      invalidateTreeCacheOnly: (cp: string) => this.lifecycle.invalidateTreeCacheOnly(cp),
    };

    const typeEditor = new TypeEditorProvider(this.context);
    this.state.typeEditorProvider = typeEditor;
    this.registerDisposable('typeEditorProvider', typeEditor);

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
    this.registerDisposable('supportRootRegistrationLifecycle', async () => {
      const supportRootLifecycle = this.state.supportRootRegistrationLifecycle;
      if (!supportRootLifecycle) {
        return;
      }
      try {
        await supportRootLifecycle.dispose();
      } finally {
        if (this.state.supportRootRegistrationLifecycle === supportRootLifecycle) {
          this.state.supportRootRegistrationLifecycle = null;
        }
      }
    });

    const trackedLifecycle: MetadataTreeFeatureLifecycle = {
      ...this._featureLifecycle,
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
