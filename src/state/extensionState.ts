import * as vscode from 'vscode';
import { InfobaseTreeDataProvider, type InfobaseTreeNode } from '../infobases/infobaseTreeProvider';
import { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import { PropertiesProvider } from '../providers/propertiesProvider';
import { TypeEditorProvider } from '../providers/typeEditorProvider';
import { RolesRightsEditorProvider } from '../rolesEditor/rolesRightsEditorProvider';
import type { CompositionEditorProvider } from '../compositionEditor/compositionEditorProvider';
import type { SubsystemCommandInterfaceProvider } from '../subsystemCommandInterfaceEditor';
import type { XdtoPackageEditorProvider } from '../xdtoPackageEditor';
import { FormEditorProvider } from '../formEditor/formEditorProvider';
import { MxlPreviewProvider } from '../mxlPreview/mxlPreviewProvider';
import { MetadataWatcherService } from '../services/metadataWatcherService';
import { ReloadCoordinatorService } from '../services/reloadCoordinatorService';
import { TreeNode } from '../models/treeNode';
import { BindingManager } from '../bindings/bindingManager';
import { InfobaseManager } from '../infobases/infobaseManager';
import { InfobaseStorageService } from '../infobases/infobaseStorageService';
import {
  InfobaseCatalogMutationService,
  type RecoveryOutcome,
} from '../infobases/infobaseCatalogMutationService';
import { resetIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';
import { FormsContext } from '../services/forms/FormsContext';
import type { AgentBridge } from '../agent/agentBridge';
import type { AgentTaskManager } from '../agent/agentTaskManager';
import type { SupportServiceComposition } from '../support/supportServiceComposition';
import type { SupportStateCache } from '../support/supportStateCache';
import type { SupportStateWatcher } from '../support/supportStateWatcher';
import type { SupportRootRegistrationLifecycle } from '../support/supportRootRegistrationLifecycle';
import type { ConfigurationRepositoryService } from '../services/configurationRepository/configurationRepositoryService';
import type { RepositoryStateProjection } from '../services/configurationRepository/repositoryTreeDecorations';
import type { WorkspaceRegistry } from '../services/configurationSession/WorkspaceRegistry';
import type { ConfigurationContextResolver } from '../services/configurationSession/ConfigurationContextResolver';
import {
  ConfigurationMutationEngine,
  setConfigurationMutationEngine,
} from '../services/configurationSession/ConfigurationMutationEngine';
import { Logger } from '../utils/logger';

export interface ExtensionStateInitOptions {
  /** Set false when ExtensionCompositionRoot will create or adopt the production graph. */
  readonly initializeInfobaseServices?: boolean;
}

/**
 * Holds extension-wide mutable references (providers, tree view, reload coordinator).
 * Replaces module-level `let` globals in extension.ts (refactor step 5.3.1).
 */
export class ExtensionState {
  private _treeDataProvider: MetadataTreeDataProvider | null = null;
  private _treeView: vscode.TreeView<TreeNode> | null = null;
  private _propertiesProvider: PropertiesProvider | null = null;
  private _typeEditorProvider: TypeEditorProvider | null = null;
  private _rolesRightsEditorProvider: RolesRightsEditorProvider | null = null;
  private _subsystemCompositionEditorProvider: CompositionEditorProvider | null = null;
  private _exchangePlanCompositionEditorProvider: CompositionEditorProvider | null = null;
  private _commonAttributeCompositionEditorProvider: CompositionEditorProvider | null = null;
  private _functionalOptionCompositionEditorProvider: CompositionEditorProvider | null = null;
  private _filterCriterionCompositionEditorProvider: CompositionEditorProvider | null = null;
  private _subsystemCommandInterfaceProvider: SubsystemCommandInterfaceProvider | null = null;
  private _xdtoPackageEditorProvider: XdtoPackageEditorProvider | null = null;
  private _formEditorProvider: FormEditorProvider | null = null;
  private _mxlPreviewProvider: MxlPreviewProvider | null = null;
  private _extensionContext: vscode.ExtensionContext | undefined;
  private _metadataWatchers: MetadataWatcherService[] = [];
  private _reloadCoordinator: ReloadCoordinatorService | null = null;
  private _infobaseStorage: InfobaseStorageService | null = null;
  private _bindingManager: BindingManager | null = null;
  private _infobaseManager: InfobaseManager | null = null;
  private _infobaseTreeProvider: InfobaseTreeDataProvider | null = null;
  private _infobaseTreeView: vscode.TreeView<InfobaseTreeNode> | null = null;
  private _refreshBindingTreeDecorations: (() => Promise<void>) | null = null;
  private _agentBridge: AgentBridge | null = null;
  private _agentTaskManager: AgentTaskManager | null = null;
  private _supportComposition: SupportServiceComposition | null = null;
  private _supportStateCache: SupportStateCache | null = null;
  private _supportStateWatcher: SupportStateWatcher | null = null;
  private _supportRootRegistrationLifecycle: SupportRootRegistrationLifecycle | null = null;
  private _configurationRepositoryService: ConfigurationRepositoryService | null = null;
  private _configurationRepositoryProjection: RepositoryStateProjection | null = null;
  private _workspaceRegistry: WorkspaceRegistry | null = null;
  private _configurationContextResolver: ConfigurationContextResolver | null = null;
  private _configurationMutationEngine: ConfigurationMutationEngine | null = null;
  private _infobaseMutationRecovery: Promise<RecoveryOutcome> | null = null;
  private _infobaseRecoveryOutcome: RecoveryOutcome | null = null;
  private _isDisposed = false;
  private _disposePromise: Promise<void> | null = null;
  private _compositionManaged = false;

  // ── Getters ───────────────────────────────────────────────────────────────

  get workspaceRegistry(): WorkspaceRegistry | null { return this._workspaceRegistry; }
  get configurationContextResolver(): ConfigurationContextResolver | null { return this._configurationContextResolver; }
  get configurationMutationEngine(): ConfigurationMutationEngine | null { return this._configurationMutationEngine; }
  get treeDataProvider(): MetadataTreeDataProvider | null { return this._treeDataProvider; }
  get treeView(): vscode.TreeView<TreeNode> | null { return this._treeView; }
  get propertiesProvider(): PropertiesProvider | null { return this._propertiesProvider; }
  get typeEditorProvider(): TypeEditorProvider | null { return this._typeEditorProvider; }
  get rolesRightsEditorProvider(): RolesRightsEditorProvider | null { return this._rolesRightsEditorProvider; }
  get subsystemCompositionEditorProvider(): CompositionEditorProvider | null { return this._subsystemCompositionEditorProvider; }
  get exchangePlanCompositionEditorProvider(): CompositionEditorProvider | null { return this._exchangePlanCompositionEditorProvider; }
  get commonAttributeCompositionEditorProvider(): CompositionEditorProvider | null { return this._commonAttributeCompositionEditorProvider; }
  get functionalOptionCompositionEditorProvider(): CompositionEditorProvider | null { return this._functionalOptionCompositionEditorProvider; }
  get filterCriterionCompositionEditorProvider(): CompositionEditorProvider | null { return this._filterCriterionCompositionEditorProvider; }
  get subsystemCommandInterfaceProvider(): SubsystemCommandInterfaceProvider | null { return this._subsystemCommandInterfaceProvider; }
  get xdtoPackageEditorProvider(): XdtoPackageEditorProvider | null { return this._xdtoPackageEditorProvider; }
  get formEditorProvider(): FormEditorProvider | null { return this._formEditorProvider; }
  get mxlPreviewProvider(): MxlPreviewProvider | null { return this._mxlPreviewProvider; }
  get extensionContext(): vscode.ExtensionContext | undefined { return this._extensionContext; }
  get metadataWatchers(): MetadataWatcherService[] { return this._metadataWatchers; }
  get reloadCoordinator(): ReloadCoordinatorService | null { return this._reloadCoordinator; }
  get infobaseStorage(): InfobaseStorageService | null { return this._infobaseStorage; }
  get bindingManager(): BindingManager | null { return this._bindingManager; }
  get infobaseManager(): InfobaseManager | null { return this._infobaseManager; }
  get infobaseMutationRecovery(): Promise<RecoveryOutcome> | null { return this._infobaseMutationRecovery; }
  get infobaseRecoveryOutcome(): RecoveryOutcome | null { return this._infobaseRecoveryOutcome; }
  get infobaseTreeProvider(): InfobaseTreeDataProvider | null { return this._infobaseTreeProvider; }
  get infobaseTreeView(): vscode.TreeView<InfobaseTreeNode> | null { return this._infobaseTreeView; }
  /** Обновление бейджей/tooltip привязок на узле Configuration (§2C); выставляется в extensionWorkspaceSetup. */
  get refreshBindingTreeDecorations(): (() => Promise<void>) | null { return this._refreshBindingTreeDecorations; }
  get agentBridge(): AgentBridge | null { return this._agentBridge; }
  get agentTaskManager(): AgentTaskManager | null { return this._agentTaskManager; }
  get supportComposition(): SupportServiceComposition | null { return this._supportComposition; }
  get supportStateCache(): SupportStateCache | null { return this._supportStateCache; }
  get supportStateWatcher(): SupportStateWatcher | null { return this._supportStateWatcher; }
  get supportRootRegistrationLifecycle(): SupportRootRegistrationLifecycle | null {
    return this._supportRootRegistrationLifecycle;
  }
  get configurationRepositoryService(): ConfigurationRepositoryService | null { return this._configurationRepositoryService; }
  get configurationRepositoryProjection(): RepositoryStateProjection | null { return this._configurationRepositoryProjection; }

  // ── Setters ───────────────────────────────────────────────────────────────

  set treeDataProvider(v: MetadataTreeDataProvider | null) { this._treeDataProvider = v; }
  set treeView(v: vscode.TreeView<TreeNode> | null) { this._treeView = v; }
  set propertiesProvider(v: PropertiesProvider | null) { this._propertiesProvider = v; }
  set typeEditorProvider(v: TypeEditorProvider | null) { this._typeEditorProvider = v; }
  set rolesRightsEditorProvider(v: RolesRightsEditorProvider | null) { this._rolesRightsEditorProvider = v; }
  set subsystemCompositionEditorProvider(v: CompositionEditorProvider | null) { this._subsystemCompositionEditorProvider = v; }
  set exchangePlanCompositionEditorProvider(v: CompositionEditorProvider | null) { this._exchangePlanCompositionEditorProvider = v; }
  set commonAttributeCompositionEditorProvider(v: CompositionEditorProvider | null) { this._commonAttributeCompositionEditorProvider = v; }
  set functionalOptionCompositionEditorProvider(v: CompositionEditorProvider | null) { this._functionalOptionCompositionEditorProvider = v; }
  set filterCriterionCompositionEditorProvider(v: CompositionEditorProvider | null) { this._filterCriterionCompositionEditorProvider = v; }
  set subsystemCommandInterfaceProvider(v: SubsystemCommandInterfaceProvider | null) { this._subsystemCommandInterfaceProvider = v; }
  set xdtoPackageEditorProvider(v: XdtoPackageEditorProvider | null) { this._xdtoPackageEditorProvider = v; }
  set formEditorProvider(v: FormEditorProvider | null) { this._formEditorProvider = v; }
  set mxlPreviewProvider(v: MxlPreviewProvider | null) { this._mxlPreviewProvider = v; }
  set metadataWatchers(v: MetadataWatcherService[]) { this._metadataWatchers = v; }
  set reloadCoordinator(v: ReloadCoordinatorService | null) { this._reloadCoordinator = v; }
  set infobaseTreeProvider(v: InfobaseTreeDataProvider | null) { this._infobaseTreeProvider = v; }
  set infobaseTreeView(v: vscode.TreeView<InfobaseTreeNode> | null) { this._infobaseTreeView = v; }
  set refreshBindingTreeDecorations(v: (() => Promise<void>) | null) { this._refreshBindingTreeDecorations = v; }
  set infobaseStorage(v: InfobaseStorageService | null) { this._infobaseStorage = v; }
  set bindingManager(v: BindingManager | null) { this._bindingManager = v; }
  set infobaseManager(v: InfobaseManager | null) { this._infobaseManager = v; }
  set infobaseMutationRecovery(v: Promise<RecoveryOutcome> | null) { this._infobaseMutationRecovery = v; }
  set infobaseRecoveryOutcome(v: RecoveryOutcome | null) { this._infobaseRecoveryOutcome = v; }
  set agentBridge(v: AgentBridge | null) { this._agentBridge = v; }
  set agentTaskManager(v: AgentTaskManager | null) { this._agentTaskManager = v; }
  set supportComposition(v: SupportServiceComposition | null) { this._supportComposition = v; }
  set supportStateCache(v: SupportStateCache | null) { this._supportStateCache = v; }
  set supportStateWatcher(v: SupportStateWatcher | null) { this._supportStateWatcher = v; }
  set supportRootRegistrationLifecycle(v: SupportRootRegistrationLifecycle | null) {
    this._supportRootRegistrationLifecycle = v;
  }
  set configurationRepositoryService(v: ConfigurationRepositoryService | null) { this._configurationRepositoryService = v; }
  set configurationRepositoryProjection(v: RepositoryStateProjection | null) { this._configurationRepositoryProjection = v; }
  set workspaceRegistry(v: WorkspaceRegistry | null) { this._workspaceRegistry = v; }
  set configurationContextResolver(v: ConfigurationContextResolver | null) { this._configurationContextResolver = v; }
  set configurationMutationEngine(v: ConfigurationMutationEngine | null) { this._configurationMutationEngine = v; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  init(context: vscode.ExtensionContext, options: ExtensionStateInitOptions = {}): void {
    this._isDisposed = false;
    this._disposePromise = null;
    this._compositionManaged = false;
    this._extensionContext = context;
    this._infobaseMutationRecovery = null;
    this._infobaseRecoveryOutcome = null;
    if (options.initializeInfobaseServices === false) {
      return;
    }

    this._infobaseStorage = new InfobaseStorageService(context.globalState, context.secrets);
    this._bindingManager = new BindingManager();
    const mutationService = new InfobaseCatalogMutationService({
      storage: this._infobaseStorage,
      secretStorage: context.secrets,
      bindingManager: this._bindingManager,
      memento: context.globalState,
    });
    this._infobaseManager = new InfobaseManager(this._infobaseStorage, this._bindingManager, mutationService);
    this._infobaseMutationRecovery = mutationService.recoverPendingMutations();
    void this._infobaseMutationRecovery.catch((error) => {
      Logger.error('Infobase catalog mutation recovery failed during ExtensionState initialization', error);
    });
  }

  /** Marks this state as a reference facade whose graph is disposed by the composition root. */
  enableCompositionManagedMode(): void {
    this._compositionManaged = true;
  }

  dispose(): Promise<void> {
    if (this._disposePromise) {
      return this._disposePromise;
    }
    if (this._isDisposed) {
      return Promise.resolve();
    }
    this._isDisposed = true;
    this._disposePromise = Promise.resolve().then(() => {
      if (this._compositionManaged) {
        this.releaseCompositionRootReferences();
        return;
      }
      return this.disposeOwnedState();
    });
    return this._disposePromise;
  }

  /** Clears handles already disposed by the composition root before its state fallback cleanup. */
  releaseCompositionRootReferences(): void {
    this._treeDataProvider?.setSupportRootRegistrationCallback(undefined);
    this._treeDataProvider?.setSupportStateCache(undefined);
    this._workspaceRegistry = null;
    this._configurationContextResolver = null;
    this._configurationMutationEngine = null;
    setConfigurationMutationEngine(undefined);
    this._treeDataProvider = null;
    this._treeView = null;
    this._propertiesProvider = null;
    this._typeEditorProvider = null;
    this._rolesRightsEditorProvider = null;
    this._subsystemCompositionEditorProvider = null;
    this._exchangePlanCompositionEditorProvider = null;
    this._commonAttributeCompositionEditorProvider = null;
    this._functionalOptionCompositionEditorProvider = null;
    this._filterCriterionCompositionEditorProvider = null;
    this._subsystemCommandInterfaceProvider = null;
    this._xdtoPackageEditorProvider = null;
    this._reloadCoordinator = null;
    this._formEditorProvider = null;
    this._mxlPreviewProvider = null;
    this._extensionContext = undefined;
    this._metadataWatchers = [];
    this._infobaseTreeView = null;
    this._refreshBindingTreeDecorations = null;
    this._infobaseStorage = null;
    this._bindingManager = null;
    this._infobaseManager = null;
    this._infobaseTreeProvider = null;
    this._infobaseMutationRecovery = null;
    this._infobaseRecoveryOutcome = null;
    this._agentBridge = null;
    this._agentTaskManager = null;
    this._supportComposition = null;
    this._supportStateCache = null;
    this._supportStateWatcher = null;
    this._supportRootRegistrationLifecycle = null;
    this._configurationRepositoryService = null;
    this._configurationRepositoryProjection = null;
  }

  private async disposeOwnedState(): Promise<void> {

    const errors: unknown[] = [];
    const attempt = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        errors.push(err);
        Logger.error(`Error during ExtensionState teardown of ${name}`, err);
      }
    };

    // 1. Drain active WorkspaceRegistry mutation queues before shutting down dependencies
    await attempt('workspaceRegistry', async () => {
      await this._workspaceRegistry?.dispose();
    });
    this._workspaceRegistry = null;
    this._configurationContextResolver = null;
    this._configurationMutationEngine = null;
    setConfigurationMutationEngine(undefined);

    // 2. Metadata watchers
    for (const w of this._metadataWatchers) {
      await attempt('metadataWatcher', () => {
        w.dispose();
      });
    }
    this._metadataWatchers = [];

    // 3. Tree data provider support callbacks
    await attempt('treeSupportCallbacks', () => {
      this._treeDataProvider?.setSupportRootRegistrationCallback(undefined);
      this._treeDataProvider?.setSupportStateCache(undefined);
    });

    // 4. Support lifecycle & composition (run and observe both independently)
    const supportComp = this._supportComposition;
    this._supportComposition = null;
    await attempt('supportComposition', async () => {
      await supportComp?.dispose();
    });

    const supportRoot = this._supportRootRegistrationLifecycle;
    this._supportRootRegistrationLifecycle = null;
    await attempt('supportRootRegistrationLifecycle', async () => {
      await supportRoot?.dispose();
    });

    await attempt('supportStateWatcher', () => {
      this._supportStateWatcher?.dispose();
    });
    this._supportStateWatcher = null;

    await attempt('supportStateCache', () => {
      this._supportStateCache?.clear();
    });
    this._supportStateCache = null;

    // 5. Configuration repository & tree
    this._configurationRepositoryService = null;
    await attempt('configurationRepositoryProjection', () => {
      this._configurationRepositoryProjection?.clear();
    });
    this._configurationRepositoryProjection = null;

    await attempt('treeDataProvider', () => {
      this._treeDataProvider?.dispose();
    });
    this._treeDataProvider = null;

    // 6. Reload coordinator
    await attempt('reloadCoordinator', async () => {
      await this._reloadCoordinator?.dispose();
    });
    this._reloadCoordinator = null;

    // 7. Agent bridge and long-running tasks
    await attempt('agentBridge', async () => {
      await this._agentBridge?.stop();
    });
    this._agentBridge = null;

    await attempt('agentTaskManager', async () => {
      await this._agentTaskManager?.dispose();
    });
    this._agentTaskManager = null;

    // 8. Editors
    await attempt('subsystemCompositionEditorProvider', () => {
      this._subsystemCompositionEditorProvider?.dispose();
    });
    this._subsystemCompositionEditorProvider = null;

    await attempt('exchangePlanCompositionEditorProvider', () => {
      this._exchangePlanCompositionEditorProvider?.dispose();
    });
    this._exchangePlanCompositionEditorProvider = null;

    await attempt('commonAttributeCompositionEditorProvider', () => {
      this._commonAttributeCompositionEditorProvider?.dispose();
    });
    this._commonAttributeCompositionEditorProvider = null;

    await attempt('functionalOptionCompositionEditorProvider', () => {
      this._functionalOptionCompositionEditorProvider?.dispose();
    });
    this._functionalOptionCompositionEditorProvider = null;

    await attempt('filterCriterionCompositionEditorProvider', () => {
      this._filterCriterionCompositionEditorProvider?.dispose();
    });
    this._filterCriterionCompositionEditorProvider = null;

    await attempt('subsystemCommandInterfaceProvider', () => {
      this._subsystemCommandInterfaceProvider?.dispose();
    });
    this._subsystemCommandInterfaceProvider = null;

    await attempt('xdtoPackageEditorProvider', () => {
      this._xdtoPackageEditorProvider?.dispose();
    });
    this._xdtoPackageEditorProvider = null;

    await attempt('formEditorProvider', () => {
      this._formEditorProvider?.dispose();
    });
    this._formEditorProvider = null;

    this._infobaseTreeProvider = null;
    this._infobaseTreeView = null;
    this._refreshBindingTreeDecorations = null;

    // 9. Infobase storage and bindings
    await attempt('infobaseMutationRecovery', async () => {
      await this._infobaseMutationRecovery;
    });
    this._infobaseMutationRecovery = null;
    this._infobaseRecoveryOutcome = null;
    await attempt('infobaseStorage', () => {
      this._infobaseStorage?.dispose();
    });
    this._infobaseStorage = null;
    this._bindingManager = null;
    this._infobaseManager = null;

    // 10. Singletons
    await attempt('resetIbcmdService', () => {
      resetIbcmdService();
    });

    await attempt('formsContext', async () => {
      await FormsContext.get().dispose();
    });
  }
}
