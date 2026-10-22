import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, deactivate, extensionDiagnostics, rollbackPartialActivation } from '../../src/extension';
import { createExtensionState } from '../../src/state/extensionState';
import type { ExtensionState } from '../../src/state/extensionState';
import { ExtensionCompositionRoot } from '../../src/extension/extensionCompositionRoot';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { InfobaseCatalogMutationService } from '../../src/infobases/infobaseCatalogMutationService';
import { createActivationSubscriptionScope } from '../../src/extension/activationSubscriptionScope';
import { debugTestState, resetDebugTestState, resetVscodeTestState, vscodeTestState, fireWorkspaceFoldersChanged } from '../helpers/vscodeModuleStub';
import { Logger } from '../../src/utils/logger';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

function createActivationContext(
  globalStoragePath: string,
  subscriptions: vscode.Disposable[] = [],
): vscode.ExtensionContext {
  return {
    subscriptions,
    globalStoragePath,
    globalStorageUri: vscode.Uri.file(globalStoragePath),
    extensionPath: process.cwd(),
    extensionUri: vscode.Uri.file(process.cwd()),
    extension: { packageJSON: { version: 'test' } },
    globalState: {
      get: () => undefined,
      update: async () => undefined,
      keys: () => [],
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
      onDidChange: new vscode.EventEmitter<{ key: string }>().event,
    },
  } as unknown as vscode.ExtensionContext;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

suite('extension activation lifecycle', () => {
  setup(async () => {
    await deactivate();
    resetVscodeTestState();
    resetDebugTestState();
  });
  teardown(async () => {
    await deactivate();
    resetVscodeTestState();
    resetDebugTestState();
  });

  test('diagnostics facade exposes the active state through a frozen readonly getter', () => {
    const state: ExtensionState | undefined = extensionDiagnostics.state;
    const descriptor = Object.getOwnPropertyDescriptor(extensionDiagnostics, 'state');

    assert.strictEqual(state, undefined);
    assert.ok(Object.isFrozen(extensionDiagnostics));
    assert.strictEqual(typeof descriptor?.get, 'function');
    assert.strictEqual(descriptor?.set, undefined);
    assert.strictEqual(Reflect.set(extensionDiagnostics, 'state', undefined), false);

    function assertReadonlyDiagnosticsType(): void {
      // @ts-expect-error Diagnostics state is intentionally readonly.
      extensionDiagnostics.state = undefined;
    }
    void assertReadonlyDiagnosticsType;
  });

  test('rollback disposes subscriptions in reverse order, continues after errors, and is idempotent', async () => {
    const order: string[] = [];
    let stateDisposed = false;
    const context = {
      subscriptions: [
        { dispose: () => { order.push('first'); } },
        { dispose: () => { order.push('broken'); throw new Error('dispose failed'); } },
        { dispose: () => { order.push('last'); } },
      ],
    } as Pick<vscode.ExtensionContext, 'subscriptions'>;
    const state = {
      dispose: async () => {
        if (!stateDisposed) {
          stateDisposed = true;
          order.push('state');
        }
      },
    };

    const errors = await rollbackPartialActivation(context, state);
    await rollbackPartialActivation(context, state);

    assert.deepStrictEqual(order, ['last', 'broken', 'first', 'state']);
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(context.subscriptions, []);
  });

  test('activation scope preserves ExtensionContext accessors and methods without adopting foreign subscriptions', async () => {
    let foreignDisposed = false;
    const foreign: vscode.Disposable = { dispose: () => { foreignDisposed = true; } };
    const sourceValue: { subscriptions: vscode.Disposable[]; ownerName: string; getSubscriptionCount: () => number } = {
      subscriptions: [foreign],
      ownerName: 'source-context',
      getSubscriptionCount() { return this.subscriptions.length; },
    };
    Object.defineProperty(sourceValue, 'extensionPath', {
      configurable: true,
      get() { return `${this.ownerName}/extension`; },
    });
    const source = sourceValue as unknown as vscode.ExtensionContext;
    const scope = createActivationSubscriptionScope(source);
    const captured: vscode.Disposable[] = [];
    scope.bind({ registerDisposable: (_name, disposable) => {
      if (typeof disposable !== 'function') {
        captured.push(disposable);
      }
    } });

    assert.strictEqual(scope.context.extensionPath, 'source-context/extension');
    assert.strictEqual((scope.context as any).getSubscriptionCount(), 1);
    assert.notStrictEqual(scope.context.subscriptions, source.subscriptions);

    const activationSubscription: vscode.Disposable = { dispose: () => undefined };
    scope.context.subscriptions.push(activationSubscription);
    scope.close();
    const lateSubscription: vscode.Disposable = { dispose: () => undefined };
    scope.context.subscriptions.push(lateSubscription);

    assert.deepStrictEqual(source.subscriptions, [foreign]);
    assert.strictEqual(foreignDisposed, false, 'scope close must not dispose subscriptions owned by the source context');
    assert.ok(captured.includes(activationSubscription));
    assert.ok(captured.includes(lateSubscription));
  });

  test('activation rollback preserves the primary failure when disposal and diagnostics also fail', async () => {
    const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-activation-failure-storage-'));
    const failure = new Error('initialization failed');
    const disposalFailure = new Error('cleanup failed');
    const diagnosticFailure = new Error('logger failed');
    const context = createActivationContext(globalStoragePath);
    const originalLoggerError = Logger.error;
    const subscriptions = context.subscriptions;
    const originalPush = subscriptions.push;
    let capturedRoot: ExtensionCompositionRoot | undefined;
    let disposalCalls = 0;
    let diagnosticCalls = 0;
    Object.defineProperty(subscriptions, 'push', {
      configurable: true,
      writable: true,
      value: function (...items: vscode.Disposable[]): number {
        for (const item of items) {
          if (item instanceof ExtensionCompositionRoot) {
            capturedRoot = item;
            item.registerDisposable('failing activation cleanup', () => {
              disposalCalls += 1;
              throw disposalFailure;
            });
          }
        }
        return originalPush.apply(this, items);
      },
    });
    debugTestState.registerDebugConfigurationProviderImpl = () => {
      throw failure;
    };
    Logger.error = () => {
      diagnosticCalls += 1;
      throw diagnosticFailure;
    };

    try {
      const foreignSubscription: vscode.Disposable = { dispose: () => undefined };
      context.subscriptions.push(foreignSubscription);
      await assert.rejects(activate(context), (error: unknown) => error === failure);
      assert.strictEqual(disposalCalls, 1, 'root rollback must continue through a failing disposer');
      assert.ok(capturedRoot, 'the production composition root must be published before initialization');
      assert.ok(diagnosticCalls > 0, 'cleanup and activation diagnostics must be attempted');
      assert.deepStrictEqual(context.subscriptions, [foreignSubscription]);
      assert.strictEqual(extensionDiagnostics.state, undefined, 'failed activation must not leave a current runtime facade');
    } finally {
      Logger.error = originalLoggerError;
      subscriptions.push = originalPush;
      await deactivate();
      await fs.rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  test('overlapping activate calls share one active composition graph', async () => {
    const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-concurrent-activation-storage-'));
    const context = createActivationContext(globalStoragePath);
    const originalRecover = InfobaseCatalogMutationService.prototype.recoverPendingMutations;
    const recoveryStarted = deferred();
    const releaseRecovery = deferred();
    let recoveryCount = 0;
    InfobaseCatalogMutationService.prototype.recoverPendingMutations = function () {
      recoveryCount += 1;
      recoveryStarted.resolve();
      return releaseRecovery.promise.then(() => originalRecover.call(this));
    };

    try {
      const firstActivation = activate(context);
      const overlappingActivation = activate(context);
      assert.strictEqual(overlappingActivation, firstActivation, 'overlapping calls must join the same activation promise');
      await recoveryStarted.promise;
      assert.strictEqual(recoveryCount, 1, 'only one infobase graph may be constructed');
      assert.strictEqual(context.subscriptions.filter((item) => item instanceof ExtensionCompositionRoot).length, 1);
      releaseRecovery.resolve();
      await firstActivation;
      assert.strictEqual(recoveryCount, 1);
      assert.ok(extensionDiagnostics.state, 'successful activation must publish a runtime facade');
    } finally {
      releaseRecovery.resolve();
      InfobaseCatalogMutationService.prototype.recoverPendingMutations = originalRecover;
      await deactivate();
      await fs.rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  test('synchronous reentrant activate during root publication shares the reserved activation', async () => {
    const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-reentrant-activation-storage-'));
    const context = createActivationContext(globalStoragePath);
    const originalRecover = InfobaseCatalogMutationService.prototype.recoverPendingMutations;
    const recoveryStarted = deferred();
    const releaseRecovery = deferred();
    const subscriptions = context.subscriptions;
    const originalPush = subscriptions.push;
    const roots: ExtensionCompositionRoot[] = [];
    let reentrantActivation: Promise<void> | undefined;
    let reentered = false;
    let recoveryCount = 0;
    subscriptions.push = function (...items: vscode.Disposable[]): number {
      for (const item of items) {
        if (item instanceof ExtensionCompositionRoot) {
          roots.push(item);
          if (!reentered) {
            reentered = true;
            reentrantActivation = activate(context);
          }
        }
      }
      return originalPush.apply(this, items);
    };
    InfobaseCatalogMutationService.prototype.recoverPendingMutations = function () {
      recoveryCount += 1;
      recoveryStarted.resolve();
      return releaseRecovery.promise.then(() => originalRecover.call(this));
    };

    let activation: Promise<void> | undefined;
    try {
      activation = activate(context);
      assert.ok(reentrantActivation, 'root publication must synchronously re-enter activate');
      assert.strictEqual(reentrantActivation, activation, 'reentrant activation must join the already reserved promise');
      await recoveryStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(recoveryCount, 1, 'reentrant activation must not start a second construction graph');
      assert.strictEqual(roots.length, 1, 'one active activation must publish exactly one composition root');
      releaseRecovery.resolve();
      await activation;
      assert.ok(extensionDiagnostics.state, 'the shared activation must publish its runtime facade');
    } finally {
      releaseRecovery.resolve();
      InfobaseCatalogMutationService.prototype.recoverPendingMutations = originalRecover;
      subscriptions.push = originalPush;
      await Promise.allSettled([activation, reentrantActivation].filter((promise): promise is Promise<void> => Boolean(promise)));
      await deactivate();
      await Promise.allSettled(roots.map((root) => root.dispose()));
      for (const root of roots) {
        const index = subscriptions.indexOf(root);
        if (index >= 0) {
          subscriptions.splice(index, 1);
        }
      }
      await fs.rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  test('immediate deactivate fences activation before the first await and closes published resources once', async () => {
    const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-immediate-deactivation-storage-'));
    const context = createActivationContext(globalStoragePath);
    const subscriptions = context.subscriptions;
    const originalPush = subscriptions.push;
    const roots: ExtensionCompositionRoot[] = [];
    let resourceDisposals = 0;
    Object.defineProperty(subscriptions, 'push', {
      configurable: true,
      writable: true,
      value: function (...items: vscode.Disposable[]): number {
        for (const item of items) {
          if (item instanceof ExtensionCompositionRoot) {
            roots.push(item);
            item.registerDisposable('immediate shutdown resource', () => { resourceDisposals += 1; });
          }
        }
        return originalPush.apply(this, items);
      },
    });

    try {
      const activation = activate(context);
      const facadeAtFence = extensionDiagnostics.state;
      const deactivation = deactivate();
      await Promise.allSettled([activation]);
      await deactivation;

      assert.strictEqual(extensionDiagnostics.state, undefined, 'immediate shutdown must leave no published facade');
      assert.ok(roots.length <= 1, 'immediate activation must publish at most one composition root');
      if (facadeAtFence) {
        assert.strictEqual(facadeAtFence.infobaseStorage, null, 'the facade captured at the fence must not retain live handles');
      }
      assert.strictEqual(resourceDisposals, roots.length, 'every published graph resource must be disposed exactly once');
    } finally {
      subscriptions.push = originalPush;
      await deactivate();
      await fs.rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  test('deactivate stops admission during deferred initialization and serializes a fresh activation', async () => {
    const firstStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-deferred-activation-storage-'));
    const secondStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-next-activation-storage-'));
    const firstContext = createActivationContext(firstStoragePath);
    const secondContext = createActivationContext(secondStoragePath);
    const originalRecover = InfobaseCatalogMutationService.prototype.recoverPendingMutations;
    const recoveryStarted = deferred();
    const releaseRecovery = deferred();
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    let recoveryCount = 0;
    let firstActivationSettled = false;
    let firstRoot: ExtensionCompositionRoot | undefined;
    const subscriptions = firstContext.subscriptions;
    const originalPush = subscriptions.push;
    subscriptions.push = function (...items: vscode.Disposable[]): number {
      for (const item of items) {
        if (item instanceof ExtensionCompositionRoot) {
          firstRoot = item;
          item.registerDisposable('deferred activation cleanup', async () => {
            cleanupStarted.resolve();
            await releaseCleanup.promise;
          });
        }
      }
      return originalPush.apply(this, items);
    };
    InfobaseCatalogMutationService.prototype.recoverPendingMutations = function () {
      recoveryCount += 1;
      if (recoveryCount === 1) {
        recoveryStarted.resolve();
        return releaseRecovery.promise.then(() => originalRecover.call(this));
      }
      return originalRecover.call(this);
    };

    try {
      const firstActivation = activate(firstContext);
      const firstActivationResult = firstActivation.then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ).then((result) => {
        firstActivationSettled = true;
        return result;
      });
      await recoveryStarted.promise;
      const firstState = extensionDiagnostics.state;
      assert.ok(firstState, 'facade must be observable while activation is pending');
      const oldRoot = firstRoot;
      assert.ok(oldRoot, 'root must be published before deferred construction');
      let staleCallbackFinished = false;
      let staleCallback: (() => Promise<void>) | undefined;
      oldRoot.registerDisposable('old runtime callback', () => {
        staleCallback = async () => {
          await firstState.dispose();
          staleCallbackFinished = true;
        };
      });

      let deactivationFinished = false;
      const deactivation = deactivate().then(() => { deactivationFinished = true; });
      const nextActivation = activate(secondContext);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(deactivationFinished, false, 'deactivate must wait for deferred initialization and cleanup');
      assert.strictEqual(recoveryCount, 1, 'the next graph must wait for the current deactivation to drain');
      assert.strictEqual(secondContext.subscriptions.length, 0, 'the next context must not be published early');
      assert.strictEqual(firstState.infobaseRecoveryOutcome, null, 'a stopped assembly must not publish late initialization results');

      releaseRecovery.resolve();
      await cleanupStarted.promise;
      assert.strictEqual(firstState.infobaseRecoveryOutcome, null, 'recovery completion must not republish into a stopped facade');
      assert.strictEqual(firstState.infobaseStorage !== null, true, 'facade handles remain observable until the drain finishes');

      releaseCleanup.resolve();
      await deactivation;
      await firstActivationResult;
      assert.strictEqual(firstActivationSettled, true, 'deactivation must drain the canceled initialization before the next session');
      await nextActivation;

      const secondState = extensionDiagnostics.state;
      assert.ok(secondState, 'the serialized second activation must publish its facade');
      assert.notStrictEqual(secondState, firstState, 'each activation must receive a fresh facade');
      assert.strictEqual(secondContext.subscriptions.filter((item) => item instanceof ExtensionCompositionRoot).length, 1);
      assert.strictEqual(recoveryCount, 2);

      assert.ok(staleCallback, 'an old cleanup callback may remain queued after its root is disposed');
      await staleCallback();

      assert.strictEqual(staleCallbackFinished, true, 'late callbacks from the old root must still be drained');
      assert.strictEqual(extensionDiagnostics.state, secondState, 'old callbacks must not clear the newer runtime export');
      assert.ok(secondState.infobaseStorage, 'old callbacks must not clear the newer runtime handles');
      assert.strictEqual(firstState.infobaseStorage, null, 'the old facade remains cleared');
    } finally {
      releaseRecovery.resolve();
      releaseCleanup.resolve();
      InfobaseCatalogMutationService.prototype.recoverPendingMutations = originalRecover;
      subscriptions.push = originalPush;
      await deactivate();
      await fs.rm(firstStoragePath, { recursive: true, force: true });
      await fs.rm(secondStoragePath, { recursive: true, force: true });
    }
  });

  test('production activate/deactivate keeps foreign subscriptions and awaits the real workspace writer drain', async () => {
    const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-activation-storage-'));
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-activation-config-'));
    await fs.writeFile(
      path.join(configRoot, 'Configuration.xml'),
      '<MetaDataObject version="2.20"><Configuration uuid="11111111-1111-1111-1111-111111111111"/></MetaDataObject>',
    );
    vscodeTestState.mockWorkspaceFolders = [{ name: 'configuration', index: 0, uri: vscode.Uri.file(configRoot) }];
    let foreignDisposed = false;
    const foreignSubscription: vscode.Disposable = { dispose: () => { foreignDisposed = true; } };
    const context = createActivationContext(globalStoragePath, [foreignSubscription]);
    const originalRecover = InfobaseCatalogMutationService.prototype.recoverPendingMutations;
    let recoveryCount = 0;
    const releaseWriter = deferred();
    InfobaseCatalogMutationService.prototype.recoverPendingMutations = function () {
      recoveryCount += 1;
      return originalRecover.call(this);
    };

    try {
      await activate(context);

      assert.strictEqual(recoveryCount, 1, 'production activation must construct and recover one infobase graph');
      assert.strictEqual(context.subscriptions.length, 2, 'only the composition root is added beside foreign subscriptions');
      assert.strictEqual(context.subscriptions[0], foreignSubscription, 'pre-existing subscription identity must be preserved');
      const root = context.subscriptions[1] as ExtensionCompositionRoot;
      assert.ok(root instanceof ExtensionCompositionRoot);
      assert.strictEqual(debugTestState.registeredConfigurationProviders.length, 1);
      assert.strictEqual(debugTestState.registeredDescriptorFactories.length, 1);
      const activeState = extensionDiagnostics.state;
      assert.ok(activeState, 'production activation must publish its read-only facade');

      const session = await root.infrastructure!.workspaceRegistry.registerTargetedRoot({
        configPath: configRoot,
        format: ConfigFormat.Designer,
      });
      const started = deferred();
      const writer = session.runExclusive({
        kind: 'test.pending-writer',
        execute: async () => {
          started.resolve();
          await releaseWriter.promise;
          return 'committed';
        },
      });
      await started.promise;

      let deactivationFinished = false;
      const deactivation = deactivate().then(() => { deactivationFinished = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(deactivationFinished, false, 'deactivate must wait for an active ConfigurationSession writer');
      releaseWriter.resolve();
      await Promise.all([deactivation, writer]);

      assert.strictEqual(foreignDisposed, false, 'deactivate must leave host-owned subscriptions untouched');
      assert.strictEqual(activeState.workspaceRegistry, null);
      assert.strictEqual(activeState.infobaseStorage, null);
    } finally {
      releaseWriter.resolve();
      InfobaseCatalogMutationService.prototype.recoverPendingMutations = originalRecover;
      await deactivate();
      vscodeTestState.mockWorkspaceFolders = [];
      await fs.rm(globalStoragePath, { recursive: true, force: true });
      await fs.rm(configRoot, { recursive: true, force: true });
    }
  });

  test('production deactivate drains workspace folder scans before disposing the registry', async () => {
    const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-refresh-storage-'));
    const context = createActivationContext(globalStoragePath);
    try {
      await activate(context);
      const activeState = extensionDiagnostics.state;
      assert.ok(activeState, 'production activation must publish its read-only facade');
      const root = context.subscriptions[0] as ExtensionCompositionRoot;
      const coordinator = root.infrastructure!.registryCoordinator as unknown as {
        deps: { findAllConfigurationRoots?: (folders: string[]) => Promise<Array<{ configPath: string; workspaceFolderPath: string }>> };
      };
      const scanStarted = deferred();
      const releaseScan = deferred();
      coordinator.deps.findAllConfigurationRoots = async () => {
        scanStarted.resolve();
        await releaseScan.promise;
        return [];
      };

      fireWorkspaceFoldersChanged();
      await scanStarted.promise;
      let deactivationFinished = false;
      const deactivation = deactivate().then(() => { deactivationFinished = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(deactivationFinished, false, 'shutdown must wait for an in-flight workspace scan');
      releaseScan.resolve();
      await deactivation;
      assert.strictEqual(activeState.workspaceRegistry, null);
    } finally {
      await deactivate();
      await fs.rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  test('partial activation failure awaits the root registered before compose returns', async () => {
    const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-rollback-storage-'));
    let foreignDisposed = false;
    const foreignSubscription: vscode.Disposable = { dispose: () => { foreignDisposed = true; } };
    const context = createActivationContext(globalStoragePath, [foreignSubscription]);
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const registrationFailure = new Error('debug registration failed');
    debugTestState.registerDebugConfigurationProviderImpl = () => {
      const root = context.subscriptions.find((item) => item instanceof ExtensionCompositionRoot) as ExtensionCompositionRoot | undefined;
      assert.ok(root, 'activation must publish its root before composing services');
      root.registerDisposable('debug partial rollback gate', async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
      });
      throw registrationFailure;
    };

    try {
      let activationFinished = false;
      const activation = activate(context).catch((error: unknown) => {
        assert.strictEqual(error, registrationFailure);
      }).finally(() => { activationFinished = true; });
      await cleanupStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(activationFinished, false, 'activation rollback must await registered async root cleanup');
      releaseCleanup.resolve();
      await activation;
      assert.strictEqual(context.subscriptions.length, 1, 'failed activation removes only its own root registration');
      assert.strictEqual(context.subscriptions[0], foreignSubscription);
      assert.strictEqual(foreignDisposed, false);
      assert.strictEqual(extensionDiagnostics.state, undefined);
    } finally {
      releaseCleanup.resolve();
      await deactivate();
      await fs.rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  test('deactivate awaits agentTaskManager disposal and drains background tasks', async () => {
    const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pr347-agent-task-storage-'));
    const context = createActivationContext(globalStoragePath);
    let releaseTask!: () => void;
    const taskGate = new Promise<void>((resolve) => { releaseTask = resolve; });
    let taskDrained = false;
    try {
      await activate(context);
      const taskManager = extensionDiagnostics.state?.agentTaskManager;
      assert.ok(taskManager, 'the active composition must expose its AgentTaskManager');
      let taskStarted!: () => void;
      const started = new Promise<void>((resolve) => { taskStarted = resolve; });
      const result = taskManager.start('test.deactivateTask', async () => {
        taskStarted();
        await taskGate;
        taskDrained = true;
        return { success: true, data: undefined };
      });
      assert.strictEqual(result.success, true);
      await started;

      let deactivateFinished = false;
      const deactivatePromise = deactivate().then(() => { deactivateFinished = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(deactivateFinished, false, 'deactivate must not finish before an active agent task drains');
      releaseTask();
      await deactivatePromise;
      assert.strictEqual(taskDrained, true, 'deactivate must await background task completion');
    } finally {
      releaseTask();
      await deactivate();
      await fs.rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  test('rollbackPartialActivation awaits in-flight agent tasks via shared disposePromise', async () => {
    const { AgentTaskManager } = await import('../../src/agent/agentTaskManager');
    const taskManager = new AgentTaskManager();
    let taskFinished = false;
    let cancelReceived = false;

    taskManager.start('test.longTask', async (token) => {
      token.onCancellationRequested(() => {
        cancelReceived = true;
      });
      await new Promise((r) => setTimeout(r, 50));
      taskFinished = true;
      return { success: true, data: undefined };
    });

    const assembly = createExtensionState();
    assembly.composition.initialize(createActivationContext(process.cwd()));
    assembly.composition.bindDispose(() => taskManager.dispose());
    assembly.composition.publish({ agentTaskManager: taskManager });
    const state = assembly.state;

    const context: Pick<vscode.ExtensionContext, 'subscriptions'> = {
      subscriptions: [
        { dispose: () => { void taskManager.dispose(); } },
      ],
    };

    const rollbackPromise = rollbackPartialActivation(context, state);
    assert.strictEqual(taskFinished, false, 'rollback must not finish immediately while task is draining');
    await rollbackPromise;
    assert.strictEqual(cancelReceived, true, 'task cancellation must be requested during disposal');
    assert.strictEqual(taskFinished, true, 'rollback must await completion of in-flight agent task');
  });

  test('AgentTaskManager: subsequent dispose() calls return the same in-flight drain promise', async () => {
    const { AgentTaskManager } = await import('../../src/agent/agentTaskManager');
    const taskManager = new AgentTaskManager();
    let taskFinished = false;

    taskManager.start('test.task', async () => {
      await new Promise((r) => setTimeout(r, 40));
      taskFinished = true;
      return { success: true, data: undefined };
    });

    const firstDispose = taskManager.dispose();
    const secondDispose = taskManager.dispose();

    assert.strictEqual(firstDispose, secondDispose, 'dispose() must return the same promise');
    await secondDispose;
    assert.strictEqual(taskFinished, true, 'tasks must be finished when second dispose resolves');
  });

  test('AgentTaskManager: reentrant dispose() from cancellation listener returns identical disposePromise without double drain', async () => {
    const { AgentTaskManager } = await import('../../src/agent/agentTaskManager');
    const taskManager = new AgentTaskManager();
    let reentrantPromise: Promise<void> | undefined;
    let cancelListenerCalls = 0;
    let taskFinished = false;

    let registeredResolve!: () => void;
    const registered = new Promise<void>((r) => { registeredResolve = r; });

    let reentrantStartResult: ReturnType<typeof taskManager.start> | undefined;

    taskManager.start('test.reentrantTask', async (token) => {
      token.onCancellationRequested(() => {
        cancelListenerCalls += 1;
        reentrantPromise = taskManager.dispose();
        reentrantStartResult = taskManager.start('test.rejected', async () => ({ success: true, data: undefined }));
      });
      registeredResolve();
      await new Promise((r) => setTimeout(r, 40));
      taskFinished = true;
      return { success: true, data: undefined };
    });

    await registered;

    const initialPromise = taskManager.dispose();
    await initialPromise;

    assert.ok(reentrantPromise, 'reentrant dispose() should have been called');
    assert.strictEqual(
      reentrantPromise,
      initialPromise,
      'reentrant dispose() from cancellation listener must return the exact same in-flight disposePromise'
    );
    assert.strictEqual(reentrantStartResult?.code, 'MANAGER_DISPOSED', 'reentrant task start must be rejected with MANAGER_DISPOSED');
    assert.strictEqual(cancelListenerCalls, 1, 'cancellation listener must only fire once');
    assert.strictEqual(taskFinished, true, 'task must finish draining');
  });

  test('AgentTaskManager: multiple tasks reentrantly invoking dispose() all share the same drain promise', async () => {
    const { AgentTaskManager } = await import('../../src/agent/agentTaskManager');
    const taskManager = new AgentTaskManager();
    const reentrantPromises: Array<Promise<void>> = [];
    let task1Finished = false;
    let task2Finished = false;

    let resolve1!: () => void;
    let resolve2!: () => void;
    const ready1 = new Promise<void>((r) => { resolve1 = r; });
    const ready2 = new Promise<void>((r) => { resolve2 = r; });

    taskManager.start('test.task1', async (token) => {
      token.onCancellationRequested(() => {
        reentrantPromises.push(taskManager.dispose());
      });
      resolve1();
      await new Promise((r) => setTimeout(r, 30));
      task1Finished = true;
      return { success: true, data: undefined };
    });

    taskManager.start('test.task2', async (token) => {
      token.onCancellationRequested(() => {
        reentrantPromises.push(taskManager.dispose());
      });
      resolve2();
      await new Promise((r) => setTimeout(r, 40));
      task2Finished = true;
      return { success: true, data: undefined };
    });

    await Promise.all([ready1, ready2]);

    const initialPromise = taskManager.dispose();
    await initialPromise;

    assert.strictEqual(reentrantPromises.length, 2, 'both cancellation listeners should have run');
    for (const p of reentrantPromises) {
      assert.strictEqual(p, initialPromise, 'all reentrant calls must return the same promise');
    }
    assert.strictEqual(task1Finished, true, 'task 1 must finish draining');
    assert.strictEqual(task2Finished, true, 'task 2 must finish draining');

    const postDispose = taskManager.dispose();
    assert.strictEqual(postDispose, initialPromise, 'subsequent dispose call returns the existing settled promise');
    await postDispose;
  });
});


