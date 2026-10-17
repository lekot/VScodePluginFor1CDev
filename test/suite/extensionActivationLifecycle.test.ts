import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, deactivate, extensionState, rollbackPartialActivation } from '../../src/extension';
import { ExtensionState } from '../../src/state/extensionState';
import { ExtensionCompositionRoot } from '../../src/extension/extensionCompositionRoot';
import { ConfigFormat } from '../../src/parsers/formatDetector';
import { InfobaseCatalogMutationService } from '../../src/infobases/infobaseCatalogMutationService';
import { createActivationSubscriptionScope } from '../../src/extension/activationSubscriptionScope';
import { debugTestState, resetDebugTestState, resetVscodeTestState, vscodeTestState, fireWorkspaceFoldersChanged } from '../helpers/vscodeModuleStub';
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
  setup(() => {
    resetVscodeTestState();
    resetDebugTestState();
    extensionState.init(createActivationContext(process.cwd()), { initializeInfobaseServices: false });
  });
  teardown(() => {
    resetVscodeTestState();
    resetDebugTestState();
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
    const foreign: vscode.Disposable = { dispose: () => undefined };
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
    assert.ok(captured.includes(activationSubscription));
    assert.ok(captured.includes(lateSubscription));
  });

  test('activation rolls back and rethrows the original initialization failure', async () => {
    const failure = new Error('initialization failed');
    const originalInit = ExtensionState.prototype.init;
    ExtensionState.prototype.init = () => { throw failure; };
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    try {
      await assert.rejects(activate(context), (error: unknown) => error === failure);
      assert.strictEqual(context.subscriptions.length, 0);
      assert.ok(
        vscodeTestState.errorLog.some((message) => message.includes('Failed to activate extension'))
      );
    } finally {
      ExtensionState.prototype.init = originalInit;
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
      assert.strictEqual(extensionState.workspaceRegistry, null);
      assert.strictEqual(extensionState.infobaseStorage, null);
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
      assert.strictEqual(extensionState.workspaceRegistry, null);
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
      assert.strictEqual(extensionState.infobaseStorage, null);
    } finally {
      releaseCleanup.resolve();
      await deactivate();
      await fs.rm(globalStoragePath, { recursive: true, force: true });
    }
  });

  test('deactivate awaits agentTaskManager disposal and drains background tasks', async () => {
    let taskDrained = false;
    extensionState.agentTaskManager = {
      dispose: async () => {
        await new Promise((r) => setTimeout(r, 30));
        taskDrained = true;
      },
    } as any;

    const deactivatePromise = deactivate();
    assert.strictEqual(taskDrained, false, 'deactivate must not finish before task drain');
    await deactivatePromise;
    assert.strictEqual(taskDrained, true, 'deactivate must await background task drain');
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

    const state = new ExtensionState();
    state.init(createActivationContext(process.cwd()), { initializeInfobaseServices: false });
    state.agentTaskManager = taskManager;

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


