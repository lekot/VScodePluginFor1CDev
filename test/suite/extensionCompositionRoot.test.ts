import * as assert from 'assert';
import * as vscode from 'vscode';
import { createExtensionState, type ExtensionState } from '../../src/state/extensionState';
import type { ExtensionStateAssembly } from '../../src/state/extensionStateComposition';
import {
  ExtensionCompositionRoot,
  type CompositionPipelineStages,
} from '../../src/extension/extensionCompositionRoot';
import { createMetadataTreeLifecycle } from '../../src/extension/metadataTreeLifecycle';
import { createMetadataTreeLifecycleRuntimeView, createFilterCommandsContext } from '../../src/extension/extensionFeatureContexts';
import { InfobaseCatalogMutationService } from '../../src/infobases/infobaseCatalogMutationService';
import { fireTreeViewVisibility, fireWorkspaceFoldersChanged, resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../../src/utils/logger';
import { createActivationSubscriptionScope } from '../../src/extension/activationSubscriptionScope';
import { rollbackPartialActivation } from '../../src/extension';
import {
  RepositoryBindingStore,
  RepositoryStateStore,
  repositoryTargetKey,
} from '../../src/services/configurationRepository/repositoryStores';

suite('ExtensionCompositionRoot (#261)', () => {
  let context: vscode.ExtensionContext;
  let assembly: ExtensionStateAssembly;
  let state: ExtensionState;
  let lifecycle: ReturnType<typeof createMetadataTreeLifecycle>;

  setup(() => {
    resetVscodeTestState();
    context = {
      subscriptions: [],
      globalStorageUri: vscode.Uri.file('C:/tmp/globalStorage'),
      extensionPath: 'C:/tmp/extension',
      globalState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => [],
      },
      secrets: {
        get: () => Promise.resolve(undefined),
        store: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        onDidChange: new vscode.EventEmitter<{ key: string }>().event,
      },
    } as unknown as vscode.ExtensionContext;
    assembly = createExtensionState();
    assembly.composition.initialize(context);
    state = assembly.state;
    lifecycle = createMetadataTreeLifecycle(createMetadataTreeLifecycleRuntimeView(state));
  });

  teardown(async () => {
    await state.dispose();
    await lifecycle.dispose();
    resetVscodeTestState();
  });

  test('composition root builds complete service graph and assigns non-null foundational dependencies to state', async () => {
    const root = new ExtensionCompositionRoot(context, assembly, lifecycle);
    await root.compose();

    assert.ok(state.infobaseStorage, 'infobaseStorage must be non-null after composition');
    assert.ok(state.bindingManager, 'bindingManager must be non-null after composition');
    assert.ok(state.workspaceRegistry, 'workspaceRegistry must be non-null after composition');
    assert.ok(state.configurationContextResolver, 'configurationContextResolver must be non-null after composition');
    assert.ok(state.configurationMutationEngine, 'configurationMutationEngine must be non-null after composition');
    assert.ok(state.reloadCoordinator, 'reloadCoordinator must be non-null after composition');
    assert.ok(state.treeDataProvider, 'treeDataProvider must be non-null after composition');

    // Teardown cleans up state
    await root.dispose();
    assert.strictEqual(state.workspaceRegistry, null, 'workspaceRegistry must be cleared upon dispose');
    assert.strictEqual(state.configurationMutationEngine, null, 'configurationMutationEngine must be cleared');
    assert.strictEqual(state.reloadCoordinator, null, 'reloadCoordinator must be cleared');
  });

  test('composition root owns the shared state graph disposal and clears facade references', async () => {
    const root = new ExtensionCompositionRoot(context, assembly, lifecycle);
    await root.compose();
    const storage = state.infobaseStorage;
    assert.ok(storage);
    const treeDataProvider = state.treeDataProvider;
    assert.ok(treeDataProvider);
    const originalDispose = storage.dispose.bind(storage);
    const originalTreeDispose = treeDataProvider.dispose.bind(treeDataProvider);
    let disposeCalls = 0;
    let treeDisposeCalls = 0;
    storage.dispose = () => {
      disposeCalls += 1;
      originalDispose();
    };
    treeDataProvider.dispose = () => {
      treeDisposeCalls += 1;
      originalTreeDispose();
    };

    await root.dispose();
    await state.dispose();

    assert.strictEqual(disposeCalls, 1, 'state facade must not dispose a root-owned service twice');
    assert.strictEqual(treeDisposeCalls, 1, 'the composition root must dispose its provider instance');
    assert.strictEqual(state.infobaseStorage, null);
    assert.strictEqual(state.infobaseManager, null);
    assert.strictEqual(state.configurationRepositoryService, null);
    assert.strictEqual(state.supportComposition, null);
  });

  test('feature context builders reject missing required handles before command registration', async () => {
    const initialSubscriptions = context.subscriptions.length;
    const initialCommandCount = vscodeTestState.registeredCommandHandlers.size;

    assert.throws(() => createFilterCommandsContext(state), /requires extension handle "treeDataProvider"/u);
    assert.strictEqual(context.subscriptions.length, initialSubscriptions);
    assert.strictEqual(vscodeTestState.registeredCommandHandlers.size, initialCommandCount);
  });

  test('composition rolls back command registrations when the final command registrar throws', async () => {
    const commandApi = (vscode as any).commands;
    const originalRegisterCommand = commandApi.registerCommand;
    const registrationError = new Error('late repository command registration failed');
    const created: vscode.Disposable[] = [];
    let disposed = 0;
    const root = new ExtensionCompositionRoot(context, assembly, lifecycle);
    commandApi.registerCommand = (id: string, callback: unknown): vscode.Disposable => {
      if (id === '1c-metadata-tree.repository.updateConfiguration') {
        throw registrationError;
      }
      const registration = originalRegisterCommand(id, callback) as vscode.Disposable;
      created.push(registration);
      return {
        dispose: () => {
          disposed += 1;
          registration.dispose();
        },
      };
    };

    try {
      await assert.rejects(root.compose(), (error: unknown) => error === registrationError);
      await root.dispose();
    } finally {
      commandApi.registerCommand = originalRegisterCommand;
    }

    assert.ok(created.length > 10, 'the injected failure must occur after earlier command registrations');
    assert.strictEqual(disposed, created.length, 'every acquired command registration must be disposed after rollback');
  });

  test('repository bindings and observed state route to the owning workspace after reorder, including nested roots', async () => {
    const workspaceA = await fs.mkdtemp(path.join(os.tmpdir(), 'pr354-workspace-a-'));
    const workspaceB = await fs.mkdtemp(path.join(os.tmpdir(), 'pr354-workspace-b-'));
    const nestedWorkspace = path.join(workspaceA, 'nested');
    await fs.mkdir(nestedWorkspace, { recursive: true });
    const root = new ExtensionCompositionRoot(context, assembly, lifecycle);

    const createTarget = (configRoot: string, configKind: 'cf' | 'cfe', extensionName?: string) => ({
      configRoot,
      configKind,
      ...(extensionName ? { extensionName } : {}),
      key: repositoryTargetKey({ configRoot, configKind, extensionName }),
    });
    const targets = [
      createTarget(path.join(workspaceA, 'ConfigurationA'), 'cf'),
      createTarget(path.join(workspaceB, 'ExtensionB'), 'cfe', 'ExtB'),
      createTarget(path.join(nestedWorkspace, 'ConfigurationNested'), 'cf'),
    ];
    const roots = [workspaceA, workspaceB, nestedWorkspace];

    try {
      for (let index = 0; index < roots.length; index += 1) {
        const storageRoot = path.join(roots[index], '.vscode');
        const bindingStore = new RepositoryBindingStore(
          path.join(storageRoot, 'configuration-repository-bindings.json'),
        );
        const stateStore = new RepositoryStateStore(
          path.join(storageRoot, 'configuration-repository-state.json'),
        );
        await bindingStore.set(targets[index], {
          repositoryPath: `repo-${index}`,
          repositoryUser: 'user',
          executionInfobaseId: `ib-${index}`,
        });
        await stateStore.set(targets[index], {
          connection: 'connected',
          locks: {},
          source: 'configuratorAcknowledgement',
        });
      }

      vscodeTestState.mockWorkspaceFolders = roots.map((workspaceRoot, index) => ({
        name: `workspace-${index}`,
        index,
        uri: vscode.Uri.file(workspaceRoot),
      }));
      await root.compose();

      const service = state.configurationRepositoryService;
      assert.ok(service);
      for (let index = 0; index < targets.length; index += 1) {
        assert.strictEqual(
          (await service!.getBinding(targets[index]))?.repositoryPath,
          `repo-${index}`,
          `target ${index} must read from its owning workspace store`,
        );
        assert.strictEqual(
          (await service!.getObservedState(targets[index])).connection,
          'connected',
          `target ${index} must load state from its owning workspace store`,
        );
      }

      vscodeTestState.mockWorkspaceFolders = [...vscodeTestState.mockWorkspaceFolders].reverse();
      assert.strictEqual(
        (await service!.getBinding(targets[1]))?.repositoryPath,
        'repo-1',
        'changing workspace order must not redirect a repository binding',
      );
    } finally {
      await root.dispose();
      await fs.rm(workspaceA, { recursive: true, force: true });
      await fs.rm(workspaceB, { recursive: true, force: true });
    }
  });

  test('legacy records are migrated before their former first workspace is removed', async () => {
    const formerFirstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pr354-legacy-first-'));
    const ownerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pr354-legacy-owner-'));
    const target = {
      configRoot: path.join(ownerRoot, 'Configuration'),
      configKind: 'cf' as const,
      key: repositoryTargetKey({ configRoot: path.join(ownerRoot, 'Configuration'), configKind: 'cf' }),
    };
    const legacyBindingStore = new RepositoryBindingStore(
      path.join(formerFirstRoot, '.vscode', 'configuration-repository-bindings.json'),
    );
    const legacyStateStore = new RepositoryStateStore(
      path.join(formerFirstRoot, '.vscode', 'configuration-repository-state.json'),
    );
    await legacyBindingStore.set(target, {
      repositoryPath: 'legacy-repository',
      repositoryUser: 'legacy-user',
      executionInfobaseId: 'legacy-infobase',
    });
    await legacyStateStore.set(target, {
      connection: 'connected',
      locks: { 'Справочник.Products': 'heldByCurrentCredentials' },
      source: 'configuratorAcknowledgement',
    });
    vscodeTestState.mockWorkspaceFolders = [formerFirstRoot, ownerRoot].map((workspaceRoot, index) => ({
      name: `workspace-${index}`,
      index,
      uri: vscode.Uri.file(workspaceRoot),
    }));
    const root = new ExtensionCompositionRoot(context, assembly, lifecycle);

    try {
      await root.compose();
      vscodeTestState.mockWorkspaceFolders = [{ name: 'owner', index: 0, uri: vscode.Uri.file(ownerRoot) }];
      await fs.rm(formerFirstRoot, { recursive: true, force: true });

      const service = state.configurationRepositoryService;
      assert.ok(service);
      assert.strictEqual(
        (await service!.getBinding(target))?.repositoryPath,
        'legacy-repository',
        'removing the former storage root must not orphan the migrated binding',
      );
      const observed = await service!.getObservedState(target);
      assert.strictEqual(observed.connection, 'connected');
      assert.strictEqual(observed.locks['Справочник.Products'], 'heldByCurrentCredentials');
    } finally {
      await root.dispose();
      await fs.rm(formerFirstRoot, { recursive: true, force: true });
      await fs.rm(ownerRoot, { recursive: true, force: true });
    }
  });

  test('composition root adopts and recovers its infobase mutation graph once', async () => {
    const originalRecover = InfobaseCatalogMutationService.prototype.recoverPendingMutations;
    const recoveryPromises: Promise<unknown>[] = [];
    InfobaseCatalogMutationService.prototype.recoverPendingMutations = function () {
      const recovery = originalRecover.call(this);
      recoveryPromises.push(recovery);
      return recovery;
    };

    try {
      const root = new ExtensionCompositionRoot(context, assembly, lifecycle);
      await root.compose();
      await Promise.all(recoveryPromises);

      assert.ok(state.infobaseStorage, 'the root must publish the storage it owns');
      assert.ok(state.infobaseManager, 'the root must publish the manager it owns');
      assert.ok(state.bindingManager, 'the root must publish the binding manager it owns');
      assert.strictEqual(recoveryPromises.length, 1, 'pending mutation recovery must run once for the owned graph');

      await root.dispose();
    } finally {
      InfobaseCatalogMutationService.prototype.recoverPendingMutations = originalRecover;
    }
  });

  test('concurrent root disposal calls share one promise and wait for asynchronous drains', async () => {
    const root = new ExtensionCompositionRoot(context, assembly, lifecycle);
    let releaseDrain!: () => void;
    let drained = false;
    const gate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    root.registerDisposable('pending writer and reload', async () => {
      await gate;
      drained = true;
    });

    const firstDispose = root.dispose();
    const secondDispose = root.dispose();
    assert.strictEqual(firstDispose, secondDispose, 'concurrent dispose callers must share one teardown promise');
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(drained, false, 'dispose callers must remain pending while the asynchronous drain is blocked');
    } finally {
      releaseDrain();
      await firstDispose;
    }
    assert.strictEqual(drained, true, 'a concurrent dispose caller must not return before teardown drain');
  });

  test('root disposal waits for an in-flight initialization stage and drains its late registrations', async () => {
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve; });
    let lateDisposableDisposed = false;
    let disposeFinished = false;
    const root = new ExtensionCompositionRoot(context, assembly, lifecycle, {
      initInfobaseServices: async (compositionRoot) => {
        await initializationGate;
        compositionRoot.registerDisposable('late initialization resource', {
          dispose: () => { lateDisposableDisposed = true; },
        });
      },
    });

    const composition = root.compose();
    const disposal = root.dispose().then(() => { disposeFinished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(disposeFinished, false, 'root disposal must wait for the active initialization stage');

    releaseInitialization();
    await disposal;
    await assert.rejects(composition, /disposed during initialization/u);
    assert.strictEqual(lateDisposableDisposed, true, 'late registered resources must be drained');
    assert.strictEqual(state.infobaseStorage, null, 'late state references must be released');
  });

  test('late asynchronous registrations are drained and async disposal failures do not stop cleanup', async () => {
    const scope = createActivationSubscriptionScope(context);
    const root = new ExtensionCompositionRoot(scope.context, assembly, lifecycle);
    let releaseBlocking!: () => void;
    let releaseLate!: () => void;
    let blockingStarted!: () => void;
    let lateStarted!: () => void;
    let disposeFinished = false;
    let lateDisposed = false;
    const blockingGate = new Promise<void>((resolve) => { releaseBlocking = resolve; });
    const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
    const blockingStartedPromise = new Promise<void>((resolve) => { blockingStarted = resolve; });
    const lateStartedPromise = new Promise<void>((resolve) => { lateStarted = resolve; });

    root.registerDisposable('blocking teardown', async () => {
      blockingStarted();
      await blockingGate;
    });
    root.registerDisposable('async failing teardown', async () => {
      throw new Error('async teardown failed');
    });
    root.registerDisposable('cleanup after failure', () => {
      lateDisposed = true;
    });

    const disposePromise = root.dispose().then(() => { disposeFinished = true; });
    try {
      await blockingStartedPromise;
      scope.context.subscriptions.push({
        dispose: async () => {
          lateStarted();
          await lateGate;
        },
      });
      await lateStartedPromise;
      releaseBlocking();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(disposeFinished, false, 'root disposal must include async registrations created during drain');
    } finally {
      releaseBlocking();
      releaseLate();
      await disposePromise;
    }
    assert.strictEqual(lateDisposed, true, 'cleanup continues after a rejected async disposer');
    assert.ok(Logger.getBufferedContent().includes('async failing teardown'));
  });

  test('partial root construction rollback gives adopted subscriptions one cleanup owner despite diagnostic failure', async () => {
    const scope = createActivationSubscriptionScope(context);
    let brokenDisposals = 0;
    let healthyDisposals = 0;
    const registrationFailure = new Error('workspace listener registration failed');
    const diagnosticsFailure = new Error('cleanup diagnostics unavailable');
    const workspaceApi = vscode.workspace as unknown as {
      onDidChangeWorkspaceFolders: typeof vscode.workspace.onDidChangeWorkspaceFolders;
    };
    const originalWorkspaceListener = workspaceApi.onDidChangeWorkspaceFolders;
    const originalLoggerError = Logger.error;
    scope.context.subscriptions.push(
      {
        dispose: () => {
          brokenDisposals += 1;
          throw new Error('captured subscription cleanup failed');
        },
      },
      {
        dispose: () => {
          healthyDisposals += 1;
        },
      },
    );
    workspaceApi.onDidChangeWorkspaceFolders = () => {
      throw registrationFailure;
    };
    Logger.error = () => {
      throw diagnosticsFailure;
    };

    let constructionError: unknown;
    try {
      new ExtensionCompositionRoot(scope.context, assembly, lifecycle);
    } catch (error) {
      constructionError = error;
    } finally {
      workspaceApi.onDidChangeWorkspaceFolders = originalWorkspaceListener;
      Logger.error = originalLoggerError;
    }

    const rollbackErrors = await rollbackPartialActivation(scope.context, state);
    assert.strictEqual(constructionError, registrationFailure, 'the host subscription error remains the construction failure');
    assert.deepStrictEqual(rollbackErrors, [], 'the root owner safely reports cleanup failures without blocking rollback');
    assert.strictEqual(brokenDisposals, 1, 'the root owner and activation fallback must not dispose an adopted subscription twice');
    assert.strictEqual(healthyDisposals, 1, 'cleanup must continue after a resource and its diagnostics both fail');
    assert.strictEqual(scope.subscriptions.length, 0, 'the partial root closes the activation subscription scope');
    assert.strictEqual(state.extensionContext, undefined, 'partial root rollback clears the runtime facade');
  });

  test('visible and explicit metadata loads arm workspace add and remove reloads', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-metadata-workspace-'));
    let loadCalls = 0;
    let blockNextLoad = false;
    let releasePendingLoad!: () => void;
    let resolvePendingLoadStarted!: () => void;
    const pendingLoadGate = new Promise<void>((resolve) => { releasePendingLoad = resolve; });
    const pendingLoadStarted = new Promise<void>((resolve) => { resolvePendingLoadStarted = resolve; });
    const originalLoad = lifecycle.loadMetadataTree;
    lifecycle.loadMetadataTree = async () => {
      loadCalls += 1;
      if (blockNextLoad) {
        blockNextLoad = false;
        resolvePendingLoadStarted();
        await pendingLoadGate;
      }
      await originalLoad();
    };

    const root = new ExtensionCompositionRoot(context, assembly, lifecycle);
    try {
      await root.compose();
      fireTreeViewVisibility('1c-metadata-tree', true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(loadCalls, 1, 'initial visible tree discovery must use the tracked lifecycle');

      const featureLifecycle = (root as unknown as { _featureLifecycle: { loadMetadataTree(): Promise<void> } })._featureLifecycle;
      await featureLifecycle.loadMetadataTree();
      assert.strictEqual(loadCalls, 2, 'explicit feature discovery must use the same tracked lifecycle');

      vscodeTestState.mockWorkspaceFolders = [{
        name: 'pr347-workspace',
        index: 0,
        uri: vscode.Uri.file(workspacePath),
      }];
      fireWorkspaceFoldersChanged();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(loadCalls, 3, 'adding a workspace folder after discovery must reload metadata');

      vscodeTestState.mockWorkspaceFolders = [];
      fireWorkspaceFoldersChanged();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(loadCalls, 4, 'removing a workspace folder after discovery must reload metadata');

      blockNextLoad = true;
      fireWorkspaceFoldersChanged();
      await pendingLoadStarted;
      const logBeforeDisposal = Logger.getBufferedContent();
      let disposeFinished = false;
      const disposal = root.dispose().then(() => { disposeFinished = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(disposeFinished, false, 'root teardown must drain a metadata load started by workspace change');
      releasePendingLoad();
      await disposal;
      assert.ok(
        !Logger.getBufferedContent().slice(logBeforeDisposal.length).includes('Metadata lifecycle is disposed.'),
        'a metadata load admitted before shutdown must finish before the raw lifecycle is disposed',
      );
    } finally {
      releasePendingLoad();
      await root.dispose();
      await fs.rm(workspacePath, { recursive: true, force: true });
      lifecycle.loadMetadataTree = originalLoad;
    }
  });

  test('root drains support root registration before closing its workspace registry', async () => {
    const root = new ExtensionCompositionRoot(context, assembly, lifecycle);
    await root.compose();

    const supportLifecycle = state.supportRootRegistrationLifecycle;
    assert.ok(supportLifecycle, 'commands must configure the support root registration lifecycle');
    const coordinator = root.infrastructure!.registryCoordinator;
    const originalSupportDispose = supportLifecycle.dispose.bind(supportLifecycle);
    const originalCoordinatorDispose = coordinator.dispose.bind(coordinator);
    let supportDrainStarted!: () => void;
    let releaseSupportDrain!: () => void;
    let registryDisposeStarted = false;
    const supportDrainStartedPromise = new Promise<void>((resolve) => { supportDrainStarted = resolve; });
    const supportDrainGate = new Promise<void>((resolve) => { releaseSupportDrain = resolve; });
    supportLifecycle.dispose = async () => {
      supportDrainStarted();
      await supportDrainGate;
      await originalSupportDispose();
    };
    coordinator.dispose = () => {
      registryDisposeStarted = true;
      return originalCoordinatorDispose();
    };

    try {
      const disposal = root.dispose();
      await supportDrainStartedPromise;
      assert.strictEqual(registryDisposeStarted, false, 'registry must remain available until support reconciliation drains');
      releaseSupportDrain();
      await disposal;
      assert.strictEqual(registryDisposeStarted, true);
    } finally {
      releaseSupportDrain();
      await root.dispose();
    }
  });

  test('root drains a committed foreground session through real reload publication and ACK before resource teardown', async () => {
    const workspacePathAlias = await fs.mkdtemp(path.join(os.tmpdir(), 'issue261-session-drain-'));
    const workspacePath = await fs.realpath(workspacePathAlias);
    const configRoot = path.join(workspacePath, 'Configuration');
    await fs.cp(path.join(process.cwd(), 'test', 'fixtures', 'designer-config'), configRoot, { recursive: true });
    const canonicalConfigRoot = await fs.realpath(configRoot);
    vscodeTestState.mockWorkspaceFolders = [{
      name: 'issue261-session-drain',
      index: 0,
      uri: vscode.Uri.file(workspacePath),
    }];

    const root = new ExtensionCompositionRoot(context, assembly, lifecycle);
    const originalExecuteReload = lifecycle.executeConfigurationReload;
    let restoreCoordinatorQuiesce = (): void => undefined;
    let restoreTreeProviderMethod = (): void => undefined;
    let releaseMutation!: () => void;
    let mutationStarted!: () => void;
    let releaseAck!: () => void;
    let reloadPublished!: () => void;
    let registryQuiesceStarted!: () => void;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutationStartedPromise = new Promise<void>((resolve) => { mutationStarted = resolve; });
    const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
    const reloadPublishedPromise = new Promise<void>((resolve) => { reloadPublished = resolve; });
    const registryQuiesceStartedPromise = new Promise<void>((resolve) => { registryQuiesceStarted = resolve; });
    let providerReplacements = 0;
    let disposalFinished = false;

    try {
      await root.compose();
      await lifecycle.loadMetadataTree();
      await waitForCondition(
        () => Boolean(state.supportComposition?.registry.getRegistrationByRoot(canonicalConfigRoot)),
        'the loaded tree root must have a live support registration',
      );

      const coordinator = root.infrastructure!.registryCoordinator;
      const originalCoordinatorQuiesce = coordinator.quiesce;
      coordinator.quiesce = () => {
        registryQuiesceStarted();
        return originalCoordinatorQuiesce.call(coordinator);
      };
      restoreCoordinatorQuiesce = () => { coordinator.quiesce = originalCoordinatorQuiesce; };
      const session = await coordinator.resolveResource(canonicalConfigRoot);
      const supportComposition = state.supportComposition;
      const supportCache = state.supportStateCache;
      const treeProvider = state.treeDataProvider;
      assert.ok(supportComposition);
      assert.ok(supportCache);
      assert.ok(treeProvider);
      const originalReplaceConfigurationRoot = treeProvider.replaceConfigurationRoot;
      treeProvider.replaceConfigurationRoot = (...args) => {
        const published = originalReplaceConfigurationRoot.apply(treeProvider, args);
        if (published) {
          providerReplacements += 1;
        }
        return published;
      };
      restoreTreeProviderMethod = () => { treeProvider.replaceConfigurationRoot = originalReplaceConfigurationRoot; };
      lifecycle.executeConfigurationReload = async (pathToReload, canPublish) => {
        const outcome = await originalExecuteReload(pathToReload, canPublish);
        if (outcome.status === 'published') {
          reloadPublished();
          await ackGate;
        }
        return outcome;
      };

      const mutation = session.runExclusive({
        kind: 'issue261.foreground-mutation',
        reconcile: true,
        execute: async () => {
          mutationStarted();
          await mutationGate;
          return 'committed-value';
        },
      });
      await mutationStartedPromise;
      const disposal = root.dispose().then(() => { disposalFinished = true; });
      await registryQuiesceStartedPromise;

      const lateMutation = await session.runExclusive({
        kind: 'issue261.late-mutation',
        reconcile: true,
        execute: async () => 'must-not-run',
      });
      assert.strictEqual(lateMutation.status, 'cancelled', 'session admission closes before the active mutation drains');

      releaseMutation();
      await reloadPublishedPromise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(disposalFinished, false, 'resource teardown waits for the actual reload ACK');
      assert.strictEqual(providerReplacements, 1, 'the admitted session publishes through the real metadata lifecycle');
      assert.strictEqual(await coordinator.resolveResource(canonicalConfigRoot), session, 'existing session identity remains resolvable while its post-commit reload is held');

      const supportRegistration = supportComposition.registry.getRegistrationByRoot(canonicalConfigRoot);
      assert.ok(supportRegistration, 'support registry entry remains live until the ACK');
      assert.strictEqual(supportCache.isRegistered(canonicalConfigRoot), true, 'support cache registration remains live until the ACK');
      const supportStatus = await supportComposition.facade.getMasterStatus({
        configurationId: supportRegistration.configurationId,
      });
      assert.ok(supportStatus && typeof supportStatus.status === 'string', 'the support facade remains queryable through session drain');

      releaseAck();
      const outcome = await mutation;
      assert.strictEqual(outcome.status, 'committed');
      assert.strictEqual(outcome.reconciliation?.status, 'succeeded', 'the mutation receives a successful reconciliation ACK');
      await disposal;
      assert.strictEqual(state.workspaceRegistry, null, 'registry handles are released after session ACK');
      assert.strictEqual(state.supportComposition, null, 'support services are released after session ACK');
    } finally {
      releaseMutation();
      releaseAck();
      lifecycle.executeConfigurationReload = originalExecuteReload;
      restoreTreeProviderMethod();
      restoreCoordinatorQuiesce();
      await root.dispose();
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });

  test('composition observes a failed recovery outcome while keeping the catalog available', async () => {
    const originalRecover = InfobaseCatalogMutationService.prototype.recoverPendingMutations;
    let releaseRecovery!: () => void;
    let recoveryStarted!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const recoveryStartedPromise = new Promise<void>((resolve) => { recoveryStarted = resolve; });
    InfobaseCatalogMutationService.prototype.recoverPendingMutations = async function () {
      recoveryStarted();
      await recoveryGate;
      return { recoveredCount: 0, errors: ['durable workspace root is temporarily unavailable'] };
    };

    try {
      const root = new ExtensionCompositionRoot(context, assembly, lifecycle);
      const composition = root.compose();
      await recoveryStartedPromise;
      assert.strictEqual(state.infobaseRecoveryOutcome, null, 'root must await recovery before exposing its outcome');
      releaseRecovery();
      await composition;

      assert.ok(state.infobaseStorage, 'catalog reads remain available while recovery is pending');
      assert.ok(state.infobaseManager?.mutations, 'mutation service remains available and can reject writes with recoveryRequired');
      assert.deepStrictEqual((state as any).infobaseRecoveryOutcome?.errors, ['durable workspace root is temporarily unavailable']);
      assert.ok(Logger.getBufferedContent().includes('recovery is required'));
      await root.dispose();
    } finally {
      InfobaseCatalogMutationService.prototype.recoverPendingMutations = originalRecover;
    }
  });

  test('teardown executes disposables in reverse LIFO order with one-time guarantee', async () => {
    const order: string[] = [];
    const root = new ExtensionCompositionRoot(context, assembly, lifecycle);

    root.registerDisposable('storage', () => {
      order.push('storage');
    });
    root.registerDisposable('registry', () => {
      order.push('registry');
    });
    root.registerDisposable('tree', () => {
      order.push('tree');
    });
    root.registerDisposable('commands', () => {
      order.push('commands');
    });

    await root.dispose();
    // Subsequent dispose must be idempotent
    await root.dispose();

    assert.deepStrictEqual(
      order,
      ['commands', 'tree', 'registry', 'storage'],
      'Teardown order must strictly follow reverse LIFO creation order without duplicate calls',
    );
  });

  test('construction failure during early stage rolls back already created components', async () => {
    const disposed: string[] = [];
    const stages: CompositionPipelineStages = {
      initInfobaseServices: (r) => {
        r.registerDisposable('infobase', () => {
          disposed.push('infobase');
        });
      },
      initConfigurationInfrastructure: () => {
        throw new Error('Simulated failure during ConfigurationInfrastructure creation');
      },
      initTreeAndReload: (r) => {
        r.registerDisposable('tree', () => {
          disposed.push('tree');
        });
      },
    };

    const root = new ExtensionCompositionRoot(context, assembly, lifecycle, stages);

    await assert.rejects(
      root.compose(),
      /Simulated failure during ConfigurationInfrastructure creation/,
      'compose() must rethrow original stage failure',
    );

    assert.deepStrictEqual(
      disposed,
      ['infobase'],
      'Only components created prior to failure must be disposed during rollback',
    );
  });

  test('construction failure during late command stage rolls back all upstream services', async () => {
    const disposed: string[] = [];
    const stages: CompositionPipelineStages = {
      initInfobaseServices: (r) => {
        r.registerDisposable('infobase', () => {
          disposed.push('infobase');
        });
      },
      initConfigurationInfrastructure: (r) => {
        r.registerDisposable('infra', () => {
          disposed.push('infra');
        });
        return {} as any;
      },
      initTreeAndReload: (r) => {
        r.registerDisposable('tree', () => {
          disposed.push('tree');
        });
      },
      initEditors: () => undefined,
      initInfobaseFeatures: () => undefined,
      initCommands: () => {
        throw new Error('Simulated command registration failure');
      },
    };

    const root = new ExtensionCompositionRoot(context, assembly, lifecycle, stages);

    await assert.rejects(
      root.compose(),
      /Simulated command registration failure/,
    );

    assert.deepStrictEqual(
      disposed,
      ['tree', 'infra', 'infobase'],
      'All upstream components must be rolled back in reverse LIFO order upon late failure',
    );
  });

  test('rollback is fault-isolated: error in one disposable does not block downstream disposals', async () => {
    const disposed: string[] = [];
    const stages: CompositionPipelineStages = {
      initInfobaseServices: (r) => {
        r.registerDisposable('storage', () => {
          disposed.push('storage');
        });
        r.registerDisposable('broken', () => {
          disposed.push('broken');
          throw new Error('Disposal exploded');
        });
        r.registerDisposable('manager', () => {
          disposed.push('manager');
        });
      },
      initConfigurationInfrastructure: () => {
        throw new Error('Trigger rollback');
      },
    };

    const root = new ExtensionCompositionRoot(context, assembly, lifecycle, stages);

    await assert.rejects(root.compose(), /Trigger rollback/);

    assert.deepStrictEqual(
      disposed,
      ['manager', 'broken', 'storage'],
      'Rollback must continue disposing remaining services even when one throws',
    );
  });

  test('rollback completes LIFO cleanup and preserves the initialization error when diagnostics fail', async () => {
    const disposed: string[] = [];
    const initializationError = new Error('primary initialization failure');
    const disposerError = new Error('resource cleanup failure');
    const diagnosticsError = new Error('diagnostics unavailable');
    const originalLoggerError = Logger.error;
    Logger.error = (message: string, error?: unknown): void => {
      if (message === 'ExtensionCompositionRoot rollback error for broken') {
        throw diagnosticsError;
      }
      originalLoggerError.call(Logger, message, error);
    };

    const root = new ExtensionCompositionRoot(context, assembly, lifecycle, {
      initInfobaseServices: (compositionRoot) => {
        compositionRoot.registerDisposable('older resource', () => { disposed.push('older'); });
        compositionRoot.registerDisposable('broken', () => {
          disposed.push('broken');
          throw disposerError;
        });
        compositionRoot.registerDisposable('newer resource', () => { disposed.push('newer'); });
      },
      initConfigurationInfrastructure: () => {
        throw initializationError;
      },
    });

    try {
      await assert.rejects(root.compose(), (error: unknown) => error === initializationError);
      assert.deepStrictEqual(
        disposed,
        ['newer', 'broken', 'older'],
        'diagnostics failure must not interrupt the reverse-order cleanup pass',
      );
    } finally {
      Logger.error = originalLoggerError;
      await root.dispose().catch(() => undefined);
    }
  });
});

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
