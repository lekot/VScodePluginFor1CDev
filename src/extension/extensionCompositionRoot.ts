// src/extension/extensionCompositionRoot.ts
// Composition Root for CDT 41 (Architecture Roadmap #267, Issue #261).
// Provides single-point deterministic service graph construction,
// narrow typed capability injection, and LIFO teardown ownership.

import * as vscode from 'vscode';
import * as path from 'path';
import type { ExtensionState } from '../state/extensionState';
import type { ExtensionStateAssembly, ExtensionStateCompositionPort } from '../state/extensionStateComposition';
import { createRequestReloadContext } from './extensionFeatureContexts';
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
import { resetIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';
import { FormsContext } from '../services/forms/FormsContext';
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
  RepositorySecretStore,
} from '../services/configurationRepository/repositoryStores';
import {
  WorkspaceRepositoryBindingStore,
  WorkspaceRepositoryStateStore,
  createWorkspaceRepositoryStoreWorkspaceLifecycle,
  migrateWorkspaceRepositoryStores,
} from '../services/configurationRepository/workspaceRepositoryStores';
import {
  RepositoryStateProjection,
  resolveRepositoryTreeDecoration,
} from '../services/configurationRepository/repositoryTreeDecorations';
import { registerAllCommands } from '../commands';
import { MetadataType } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { getActivationSubscriptionScope } from './activationSubscriptionScope';
import {
  createAgentFeatureContext,
  createBindingDialogCommandsContext,
  createBindingDialogContext,
  createBindingTreeDecorationsContext,
  createCfCommandsContext,
  createConfigurationCompareContext,
  createConfigurationRepositoryContext,
  createEditorCommandsContext,
  createElementCommandsContext,
  createExtensionSupportCommandsContext,
  createFilterCommandsContext,
  createInfobaseTreeCommandsContext,
  createTreeNavigationContext,
  createTreeWizardContext,
  createUtilityCommandsContext,
  createSupportFeatureContext,
} from './extensionFeatureContexts';
import { createSupportFeatureComposition } from './supportFeatureComposition';
import { createAgentFeatureComposition } from './agentFeatureComposition';
import type { RegisterSupportCommandsDeps } from '../support/supportCommands';
import {
  CompositionContextSubscriptions,
  createCompositionContext,
} from './extensionContextComposition';
import {
  ExtensionCompositionOwnership,
  type CompositionResourceOptions,
  type CompositionQuiescePhase,
} from './extensionCompositionOwnership';

export type { CompositionResourceOptions, CompositionQuiescePhase } from './extensionCompositionOwnership';

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
  private readonly _ownership: ExtensionCompositionOwnership;
  private readonly _workspaceFolderLifecycle: MetadataWorkspaceFolderLifecycle;
  private _activationSubscriptionScope: ReturnType<typeof getActivationSubscriptionScope> = undefined;
  private readonly _featureLifecycle: MetadataTreeFeatureLifecycle;
  private _isDisposing = false;
  private _rollbackPromise: Promise<void> | null = null;
  private _disposePromise: Promise<void> | null = null;
  private _quiescePromise: Promise<void> | null = null;
  private _compositionPromise: Promise<void> | null = null;
  private _infra: ConfigurationInfrastructure | null = null;
  private _requestConfigurationReload: RequestConfigurationReload | null = null;
  private _supportCommandDependencies: RegisterSupportCommandsDeps | null = null;
  private readonly context: vscode.ExtensionContext;
  private readonly _ownedContextSubscriptions: CompositionContextSubscriptions;
  private _subscriptionQuiescePhase: CompositionQuiescePhase | undefined;
  private readonly state: ExtensionState;
  private readonly composition: ExtensionStateCompositionPort;

  constructor(
    context: vscode.ExtensionContext,
    assembly: ExtensionStateAssembly,
    private readonly lifecycle: MetadataTreeLifecycle,
    private readonly stages?: CompositionPipelineStages,
  ) {
    this.state = assembly.state;
    this.composition = assembly.composition;
    this._ownership = new ExtensionCompositionOwnership((message, error) => this.logCleanupError(message, error));
    this.composition.bindDispose(() => this.dispose());
    this._ownedContextSubscriptions = new CompositionContextSubscriptions((disposable) => {
      const options = this._subscriptionQuiescePhase
        ? { quiescePhase: this._subscriptionQuiescePhase }
        : undefined;
      this.registerDisposable('extension context subscription', disposable, options);
    });
    this.context = createCompositionContext(context, this._ownedContextSubscriptions);
    const subscriptionScope = getActivationSubscriptionScope(context);
    if (subscriptionScope) {
      subscriptionScope.bind(this);
      this.registerDisposable('activation subscription scope', () => subscriptionScope.close(), {
        quiescePhase: 'ingress',
      });
      this._activationSubscriptionScope = subscriptionScope;
    }

    this._workspaceFolderLifecycle = registerMetadataWorkspaceFolderLifecycle(lifecycle);
    this.registerDisposable(
      'workspace folder lifecycle',
      () => this._workspaceFolderLifecycle.dispose(),
    );
    this.registerQuiesce('workspace folder lifecycle', 'producers', () => this._workspaceFolderLifecycle.quiesce());
    this._featureLifecycle = {
      invalidateTreeCacheOnly: lifecycle.invalidateTreeCacheOnly,
      loadMetadataTree: () => this._workspaceFolderLifecycle.loadMetadataTree(),
      reloadOrchestratorHandlers: lifecycle.reloadOrchestratorHandlers,
      get metadataWatchers() {
        return lifecycle.metadataWatchers;
      },
      dispose: lifecycle.dispose,
    };
  }

  registerDisposable(
    name: string,
    disposable: vscode.Disposable | { dispose: () => Promise<void> | void } | (() => Promise<void> | void),
    options: CompositionResourceOptions = {},
  ): void {
    this._ownership.registerDisposable(name, disposable, options);
  }

  registerQuiesce(
    name: string,
    phase: CompositionQuiescePhase,
    action: () => Promise<void> | void,
  ): void {
    this._ownership.registerQuiesce(name, phase, action);
  }

  get infrastructure(): ConfigurationInfrastructure | null {
    return this._infra;
  }

  get requestConfigurationReload(): RequestConfigurationReload | null {
    return this._requestConfigurationReload;
  }

  compose(): Promise<void> {
    if (this._compositionPromise) {
      return this._compositionPromise;
    }
    if (this._isDisposing) {
      return Promise.reject(new Error('Extension composition root is disposed.'));
    }
    this._compositionPromise = this.performComposition();
    return this._compositionPromise;
  }

  private async performComposition(): Promise<void> {
    try {
      // 1. Infobase core services
      if (this.stages?.initInfobaseServices) {
        await this.stages.initInfobaseServices(this);
      } else {
        await this.defaultInitInfobaseServices();
      }
      this.throwIfDisposing();

      // 2. Configuration Infrastructure & Mutation Engine
      let infra: ConfigurationInfrastructure;
      if (this.stages?.initConfigurationInfrastructure) {
        infra = await this.stages.initConfigurationInfrastructure(this);
      } else {
        infra = await this.defaultInitConfigurationInfrastructure();
      }
      this.throwIfDisposing();
      this._infra = infra;

      // 3. Tree Model, Lifecycle & Reload Coordinator
      if (this.stages?.initTreeAndReload) {
        await this.stages.initTreeAndReload(this, infra);
      } else {
        await this.defaultInitTreeAndReload();
      }
      this.throwIfDisposing();

      // 4. Editor Providers & Webviews
      if (this.stages?.initEditors) {
        await this.stages.initEditors(this);
      } else {
        await this.defaultInitEditors();
      }
      this.throwIfDisposing();

      if (!this.stages) {
        this.defaultInitSupportServices(infra);
      }
      this.throwIfDisposing();

      // 5. Infobase UI & Bindings Features
      if (this.stages?.initInfobaseFeatures) {
        await this.stages.initInfobaseFeatures(this);
      } else {
        await this.defaultInitInfobaseFeatures();
      }
      this.throwIfDisposing();

      // 6. Configuration Repository Services
      if (this.stages?.initRepositoryServices) {
        await this.stages.initRepositoryServices(this, this._requestConfigurationReload!);
      } else if (this._requestConfigurationReload) {
        await this.defaultInitRepositoryServices(this._requestConfigurationReload);
      }
      this.throwIfDisposing();

      // 7. Commands & Integration
      if (this.stages?.initCommands) {
        await this.stages.initCommands(this, infra);
      } else {
        await this.defaultInitCommands(infra);
      }
      this.throwIfDisposing();
    } catch (err) {
      if (!this._isDisposing) {
        this.logCleanupError('ExtensionCompositionRoot: composition failed, rolling back partial state', err);
        await this.rollback();
      }
      throw err;
    }
  }

  private throwIfDisposing(): void {
    if (this._isDisposing) {
      throw new Error('Extension composition root was disposed during initialization.');
    }
  }

  rollback(): Promise<void> {
    if (this._rollbackPromise) {
      return this._rollbackPromise;
    }
    const quiescence = this.startQuiescence();
    this._rollbackPromise = Promise.resolve().then(async () => {
      await quiescence;
      await this.performRollback();
    });
    return this._rollbackPromise;
  }

  private async performRollback(): Promise<void> {
    await this._ownership.disposeResources();

    setConfigurationMutationEngine(undefined);
    this._infra = null;
    this._requestConfigurationReload = null;
    this.composition.clear();
  }

  dispose(): Promise<void> {
    if (this._disposePromise) {
      return this._disposePromise;
    }
    const quiescence = this.startQuiescence();
    this._disposePromise = Promise.resolve().then(async () => {
      if (this._compositionPromise) {
        await this._compositionPromise.catch(() => undefined);
      }
      // Keep the synchronous fence, then wait for both in-flight composition and its quiescence
      // drain before rollback disposes resources. rollback awaits this same memoized drain too.
      await quiescence;
      await this.rollback();
    });
    return this._disposePromise;
  }

  private startQuiescence(): Promise<void> {
    if (this._quiescePromise) {
      return this._quiescePromise;
    }
    this._isDisposing = true;
    this.composition.stopPublishing();
    this._activationSubscriptionScope?.close();
    this._workspaceFolderLifecycle?.stopAccepting();
    this._quiescePromise = this._ownership.beginQuiescence();
    return this._quiescePromise;
  }

  private async withSubscriptionQuiescePhase<T>(
    phase: CompositionQuiescePhase,
    action: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this._subscriptionQuiescePhase;
    this._subscriptionQuiescePhase = phase;
    try {
      return await action();
    } finally {
      this._subscriptionQuiescePhase = previous;
    }
  }

  private logCleanupError(message: string, error: unknown): void {
    try {
      Logger.error(message, error);
    } catch {
      // Diagnostics must not interrupt resource cleanup or replace its primary error.
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

    this.registerDisposable('infobaseStorage', storage);
    this.registerDisposable('ibcmdService', () => resetIbcmdService());
    this.registerDisposable('formsContext', () => FormsContext.get().dispose());

    this.composition.publish({ infobaseStorage: storage, bindingManager, infobaseManager });

    let recovery = this.state.infobaseMutationRecovery;
    if (!recovery) {
      recovery = mutationService.recoverPendingMutations();
      this.registerDisposable('infobaseMutationRecovery', async () => {
        await recovery;
      });
      this.composition.publish({ infobaseMutationRecovery: recovery });
    }

    let outcome: RecoveryOutcome;
    try {
      outcome = await recovery;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { recoveredCount: 0, errors: [message] };
      Logger.error('Infobase catalog mutation recovery failed', error);
    }
    this.composition.publish({ infobaseRecoveryOutcome: outcome });
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
    const registryCoordinator = new WorkspaceRegistryCoordinator(configurationRegistry, {
      getWorkspaceFolders: () =>
        (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      getWorkspaceFolderForPath: (filePath) =>
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath,
    });
    this.registerDisposable('registryCoordinator', {
      dispose: () => registryCoordinator.dispose(),
    });
    this.registerQuiesce('registryCoordinator', 'sessions', () => registryCoordinator.quiesce());

    this.composition.publish({ workspaceRegistry: configurationRegistry });

    const contextResolver = new ConfigurationContextResolver(registryCoordinator, {
      getWorkspaceFolderForPath: (filePath) =>
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath,
    });
    this.composition.publish({ configurationContextResolver: contextResolver });

    const getConfigurationRegistry = async (): Promise<WorkspaceRegistry> => {
      return registryCoordinator.getRegistry();
    };

    const workspaceFoldersChangeSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void registryCoordinator.refreshWorkspace().catch((error) => {
        Logger.error('Workspace registry refresh after folder change failed', error);
      });
    });
    this.registerDisposable('workspaceFoldersChangeSub', workspaceFoldersChangeSub, {
      quiescePhase: 'ingress',
    });

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
    this.composition.publish({ configurationMutationEngine: mutationEngine });
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
    this.registerDisposable(
      'bslCompletionProvider',
      registerBslCompletionProvider(this.context.extensionPath, () => this.state.treeDataProvider),
    );
    this.registerDisposable('bslSignatureHelpProvider', registerBslSignatureHelpProvider());

    this.registerQuiesce('metadata tree lifecycle', 'producers', () => this.lifecycle.quiesce());
    this.registerDisposable('lifecycle', { dispose: this.lifecycle.dispose });

    const treeDataProvider = new MetadataTreeDataProvider();
    this.registerDisposable('tree data provider', treeDataProvider);
    this.composition.publish({ treeDataProvider });

    const treeView = vscode.window.createTreeView('1c-metadata-tree', {
      treeDataProvider,
      showCollapseAll: true,
      canSelectMany: true,
    });
    this.registerDisposable('treeView', treeView);
    this.composition.publish({ treeView });

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
    this.registerDisposable('reloadCoordinator', {
      dispose: () => reloadCoordinator.dispose(),
    });
    this.composition.publish({ reloadCoordinator });

    this._requestConfigurationReload = createRequestConfigurationReload(createRequestReloadContext(this.state));
  }

  private async defaultInitEditors(): Promise<void> {
    const compositionDeps = {
      loadMetadataTree: () => this._workspaceFolderLifecycle.loadMetadataTree(),
      invalidateTreeCacheOnly: (cp: string) => this.lifecycle.invalidateTreeCacheOnly(cp),
    };

    const typeEditor = new TypeEditorProvider(this.context);
    this.registerDisposable('typeEditorProvider', typeEditor);
    this.composition.publish({ typeEditorProvider: typeEditor });

    const rolesEditor = new RolesRightsEditorProvider(this.context);
    this.registerDisposable('rolesRightsEditorProvider', rolesEditor);
    this.composition.publish({ rolesRightsEditorProvider: rolesEditor });

    const subsystemComp = new CompositionEditorProvider(this.context, compositionDeps, SubsystemStrategy);
    this.registerDisposable('subsystemCompositionEditorProvider', subsystemComp);
    this.composition.publish({ subsystemCompositionEditorProvider: subsystemComp });

    const exchangePlanComp = new CompositionEditorProvider(this.context, compositionDeps, ExchangePlanStrategy);
    this.registerDisposable('exchangePlanCompositionEditorProvider', exchangePlanComp);
    this.composition.publish({ exchangePlanCompositionEditorProvider: exchangePlanComp });

    const commonAttrComp = new CompositionEditorProvider(this.context, compositionDeps, CommonAttributeStrategy);
    this.registerDisposable('commonAttributeCompositionEditorProvider', commonAttrComp);
    this.composition.publish({ commonAttributeCompositionEditorProvider: commonAttrComp });

    const functionalOptionComp = new CompositionEditorProvider(this.context, compositionDeps, FunctionalOptionStrategy);
    this.registerDisposable('functionalOptionCompositionEditorProvider', functionalOptionComp);
    this.composition.publish({ functionalOptionCompositionEditorProvider: functionalOptionComp });

    const filterCriterionComp = new CompositionEditorProvider(this.context, compositionDeps, FilterCriterionStrategy);
    this.registerDisposable('filterCriterionCompositionEditorProvider', filterCriterionComp);
    this.composition.publish({ filterCriterionCompositionEditorProvider: filterCriterionComp });

    const subsystemCmd = new SubsystemCommandInterfaceProvider(this.context);
    this.registerDisposable('subsystemCommandInterfaceProvider', subsystemCmd);
    this.composition.publish({ subsystemCommandInterfaceProvider: subsystemCmd });

    const xdtoEditor = new XdtoPackageEditorProvider(this.context);
    this.registerDisposable('xdtoPackageEditorProvider', xdtoEditor);
    this.composition.publish({ xdtoPackageEditorProvider: xdtoEditor });

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
    this.registerDisposable('propertiesProvider', propertiesProvider);
    this.composition.publish({ propertiesProvider });

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
    this.registerDisposable('formEditorProviderInstance', formEditor);
    this.composition.publish({ formEditorProvider: formEditor });
    this.registerDisposable(
      'formEditorProvider',
      vscode.window.registerCustomEditorProvider('1c-form-editor', formEditor, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );

    const mxlPreview = new MxlPreviewProvider();
    this.registerDisposable(
      'mxlPreviewProvider',
      vscode.window.registerCustomEditorProvider('1c-mxl-preview', mxlPreview, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }),
    );
    this.composition.publish({ mxlPreviewProvider: mxlPreview });

    this.registerDisposable(
      'templateEditorProvider',
      vscode.window.registerCustomEditorProvider(
        TEMPLATE_EDITOR_VIEW_TYPE,
        new TemplateEditorProvider(this.context.extensionUri),
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    );
    for (const disposable of registerTemplateDiffCommands(this.context.extensionUri)) {
      this.registerDisposable('templateDiffCommand', disposable);
    }
  }

  private defaultInitSupportServices(infra: ConfigurationInfrastructure): void {
    const support = createSupportFeatureComposition({
      context: createSupportFeatureContext(this.state, this.context),
      getConfigurationRegistry: infra.getConfigurationRegistry,
      runConfigurationMutation: infra.runConfigurationMutation,
      registerDisposable: (name, disposable, options) => {
        this.registerDisposable(name, disposable, options);
      },
      registerQuiesce: (name, phase, action) => {
        this.registerQuiesce(name, phase, action);
      },
    });
    this.composition.publish(support.handles);
    this._supportCommandDependencies = support.commandDependencies;
  }

  private async defaultInitInfobaseFeatures(): Promise<void> {
    for (const disposable of registerIbcmdInfobaseHooks()) {
      this.registerDisposable('ibcmdInfobaseHook', disposable);
    }

    const storage = this.state.infobaseStorage;
    const manager = this.state.infobaseManager;
    if (!storage || !manager) {
      throw new Error('Infobase UI requires its composition handles before registration.');
    }
    const infobaseTreeProvider = new InfobaseTreeDataProvider(storage);
    this.composition.publish({ infobaseTreeProvider });

    const infobaseTreeView = vscode.window.createTreeView(INFOBASE_TREE_VIEW_ID, {
      treeDataProvider: infobaseTreeProvider,
      showCollapseAll: true,
    });
    this.registerDisposable('infobaseTreeView', infobaseTreeView);
    this.composition.publish({ infobaseTreeView });
    void syncInfobaseTreeViewMessage(this.state);

    const catalogChangeSub = storage.onDidChangeCatalog(() => {
      infobaseTreeProvider.refresh();
      void syncInfobaseTreeViewMessage(this.state);
    });
    this.registerDisposable('catalogChangeSub', catalogChangeSub, { quiescePhase: 'producers' });

    const infobaseTreeContext = createInfobaseTreeCommandsContext(this.state);
    for (const cmd of registerInfobaseTreeCommands(infobaseTreeContext)) {
      this.registerDisposable('infobaseTreeCommand', cmd, { quiescePhase: 'ingress' });
    }

    const decorationsContext = createBindingTreeDecorationsContext(this.state);
    this.composition.publish({
      refreshBindingTreeDecorations: () => rebuildBindingDecorationsForTree(decorationsContext),
    });
    const bindingDialogCommands = registerBindingDialogCommands(
      this.context,
      createBindingDialogContext(this.state),
      createBindingDialogCommandsContext(this.state),
    );
    for (const cmd of bindingDialogCommands) {
      this.registerDisposable('bindingDialogCommand', cmd, { quiescePhase: 'ingress' });
    }

    const bindingSyncDisposable = registerBindingDecorationSync(decorationsContext);
    this.registerDisposable('bindingDecorationSync', bindingSyncDisposable, { quiescePhase: 'producers' });
    void rebuildBindingDecorationsForTree(decorationsContext);
  }

  private async defaultInitRepositoryServices(
    requestConfigurationReload: RequestConfigurationReload,
  ): Promise<void> {
    const storage = this.state.infobaseStorage;
    const provider = this.state.treeDataProvider;
    if (!storage || !provider) {
      return;
    }
    const storeOptions = {
      getWorkspaceFolders: () =>
        (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      globalStorageRoot: this.context.globalStorageUri.fsPath,
    };
    const projection = new RepositoryStateProjection();
    const bindingStore = new WorkspaceRepositoryBindingStore(storeOptions);
    const stateStore = new WorkspaceRepositoryStateStore(storeOptions);
    const workspaceStoreLifecycle = createWorkspaceRepositoryStoreWorkspaceLifecycle(storeOptions);
    const workspaceStoreChangeSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void workspaceStoreLifecycle.handleWorkspaceFoldersChanged().catch((error) => {
        Logger.warn('Configuration Repository store migration after workspace folder change failed.', error);
      });
    });
    this.registerDisposable('configurationRepositoryWorkspaceLifecycle', async () => {
      workspaceStoreChangeSubscription.dispose();
      await workspaceStoreLifecycle.dispose();
    });
    try {
      await migrateWorkspaceRepositoryStores(storeOptions);
    } catch (error) {
      Logger.warn('Configuration Repository workspace store migration was incomplete; legacy records were retained.', error);
    }
    const service = new ConfigurationRepositoryService({
      bindingStore,
      secretStore: new RepositorySecretStore(this.context.secrets),
      stateStore,
      infobaseStorage: storage,
      stateProjection: projection,
      onStateChanged: () => provider.refresh(),
      requestConfigurationReload,
    });
    this.composition.publish({ configurationRepositoryProjection: projection, configurationRepositoryService: service });
    this.registerDisposable('configurationRepositoryProjection', () => projection.clear());
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
      ...this._featureLifecycle,
    };
    const supportCommands = this._supportCommandDependencies;
    if (!supportCommands) {
      throw new Error('Support command capabilities must be assembled before command registration.');
    }
    const agentFeature = await createAgentFeatureComposition({
      context: createAgentFeatureContext(this.state, this.context),
      getConfigurationRegistry: infra.getConfigurationRegistry,
      runConfigurationMutation: infra.runConfigurationMutation,
      requestConfigurationReload: this._requestConfigurationReload!,
      refreshMetadataTree: trackedLifecycle.loadMetadataTree,
      registerDisposable: (name, disposable, options) => {
        this.registerDisposable(name, disposable, options);
      },
    });

    const commandDisposables = await this.withSubscriptionQuiescePhase('ingress', () => registerAllCommands({
      context: this.context,
      lifecycle: trackedLifecycle,
      requestConfigurationReload: this._requestConfigurationReload!,
      infrastructure: infra,
      agentCommands: agentFeature.commandDependencies,
      featureContexts: {
        cf: createCfCommandsContext(this.state),
        chartOfAccounts: createTreeWizardContext(this.state),
        configurationCompare: createConfigurationCompareContext(this.state),
        configurationRepository: createConfigurationRepositoryContext(this.state),
        editor: createEditorCommandsContext(this.state, this.context),
        element: createElementCommandsContext(this.state),
        extensionSupport: createExtensionSupportCommandsContext(this.state),
        filter: createFilterCommandsContext(this.state),
        filterCriterion: createTreeWizardContext(this.state),
        navigation: createTreeNavigationContext(this.state),
        supportCommands,
        utility: createUtilityCommandsContext(this.state),
      },
    }));

    for (const d of commandDisposables) {
      this.registerDisposable('command', d, { quiescePhase: 'ingress' });
    }

    this.throwIfDisposing();
    const agentBridge = await this.withSubscriptionQuiescePhase('ingress', agentFeature.startBridge);
    this.composition.publish({ ...agentFeature.handles, agentBridge });

    if (this.state.treeView) {
      const infobaseTreeForGitRefresh = this.state.infobaseTreeProvider;
      const lazyOrchestrator = registerLazyWorkspaceOrchestrator({
        metadataView: this.state.treeView,
        infobaseView: this.state.infobaseTreeView ?? undefined,
        loadMetadataTree: () => trackedLifecycle.loadMetadataTree(),
        registerGitHeadChangeHandlers: () => {
          const gitDisposables = registerGitPhase4HeadChangeHandlers({
            onReloadMetadataTree: () => trackedLifecycle.loadMetadataTree(),
            onRefreshInfobaseManager: infobaseTreeForGitRefresh
              ? () => {
                  infobaseTreeForGitRefresh.refresh();
                  void rebuildBindingDecorationsForTree(createBindingTreeDecorationsContext(this.state));
                  void syncInfobaseTreeViewMessage(this.state);
                }
              : undefined,
          });
          this.registerDisposable('gitPhase4HeadChangeHandlers', gitDisposables);
        },
        onAutoLoadError: (error) => Logger.error('Error during auto-load', error),
      });
      this.registerDisposable('lazyWorkspaceOrchestrator', lazyOrchestrator, { quiescePhase: 'producers' });
    }
  }
}
