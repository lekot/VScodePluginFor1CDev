import * as assert from 'assert';
import { ExtensionState } from '../../src/state/extensionState';
import { ReloadCoordinatorService } from '../../src/services/reloadCoordinatorService';
import { ReloadOperationResult, ReloadReason, ReloadScheduleOptions } from '../../src/types/reloadContracts';
import { Logger } from '../../src/utils/logger';
import {
  ReloadOrchestratorDeps,
  scheduleCoordinatedReload,
  scheduleDeleteReconcile,
} from '../../src/reload/reloadOrchestrator';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface RequestCall {
  configPath: string;
  reason: ReloadReason;
  options?: ReloadScheduleOptions;
  handle: ReturnType<ReloadCoordinatorService['requestReload']>;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const check = (): void => {
      if (predicate()) {
        resolve(true);
      } else if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
}

function createDeps(
  coordinator: ReloadCoordinatorService | null,
  options: { reconcileTimeoutMs?: number } = {},
): ReloadOrchestratorDeps {
  const state = new ExtensionState();
  state.reloadCoordinator = coordinator;
  state.treeDataProvider = {
    findNodeById: () => undefined,
    getConfigPathForNode: () => undefined,
  } as any;
  return {
    state,
    reconcileTimeoutMs: options.reconcileTimeoutMs,
  } as unknown as ReloadOrchestratorDeps;
}

function observeRequests(coordinator: ReloadCoordinatorService): RequestCall[] {
  const calls: RequestCall[] = [];
  const original = coordinator.requestReload.bind(coordinator);
  (coordinator as any).requestReload = (
    configPath: string,
    reason: ReloadReason,
    options?: ReloadScheduleOptions,
  ) => {
    const handle = original(configPath, reason, options);
    calls.push({ configPath, reason, options, handle });
    return handle;
  };
  return calls;
}

suite('reloadOrchestrator', () => {
  setup(() => {
    resetVscodeTestState();
    Logger.clearBuffer();
  });
  teardown(() => resetVscodeTestState());

  test('coordinated reload is admitted through requestReload and does not call lifecycle directly', async () => {
    let runCount = 0;
    const coordinator = new ReloadCoordinatorService(async () => {
      runCount += 1;
    }, { defaultDebounceMs: 0 });
    const deps = createDeps(coordinator);
    const calls = observeRequests(coordinator);

    try {
      scheduleCoordinatedReload(deps, 'C:/cfg-one', 'manual-refresh', { operationId: 'manual-1' });
      scheduleCoordinatedReload(deps, 'C:/cfg-two', 'watcher');

      assert.strictEqual(calls.length, 2, 'each config request should acquire its own completion handle');
      assert.deepStrictEqual(calls.map((call) => call.configPath), ['C:/cfg-one', 'C:/cfg-two']);
      assert.strictEqual(calls[0].options?.operationId, 'manual-1');
      assert.strictEqual(await waitFor(() => runCount === 2), true, 'both configurations should run independently');
      const results = await Promise.all(calls.map((call) => call.handle.completed));
      assert.ok(results.every((result) => result.succeeded));
    } finally {
      await coordinator.dispose();
    }
  });

  test('delete success follows its completion handle without cache polling', async () => {
    const gate = deferred<void>();
    const coordinator = new ReloadCoordinatorService(async () => gate.promise, { defaultDebounceMs: 0 });
    const deps = createDeps(coordinator);
    const calls = observeRequests(coordinator);
    let cachePollCount = 0;
    const originalGetResult = coordinator.getOperationResult.bind(coordinator);
    (coordinator as any).getOperationResult = (...args: Parameters<ReloadCoordinatorService['getOperationResult']>) => {
      cachePollCount += 1;
      return originalGetResult(...args);
    };

    try {
      scheduleDeleteReconcile(deps, 'C:/delete-config', 'delete-op', 'node-deleted', 'CatalogAsync');
      gate.resolve();

      assert.strictEqual(await waitFor(() => vscodeTestState.informationLog.length === 1, 500), true);
      assert.strictEqual(calls.length, 1, 'delete should request an awaitable handle immediately');
      assert.strictEqual(calls[0].reason, 'delete-command');
      assert.deepStrictEqual(calls[0].options, { operationId: 'delete-op', debounceMs: 0 });
      assert.strictEqual(vscodeTestState.informationLog[0], 'Удалён элемент: CatalogAsync');
      assert.strictEqual(cachePollCount, 0, 'completion must not be read from the bounded result cache');
    } finally {
      gate.resolve();
      await coordinator.dispose();
    }
  });

  test('delete completion stays with its initial batch when a trailing batch reuses the operation id', async () => {
    const initialGate = deferred<void>();
    let runCount = 0;
    const coordinator = new ReloadCoordinatorService(async () => {
      runCount += 1;
      if (runCount === 1) {
        await initialGate.promise;
      } else {
        throw new Error('unrelated trailing batch failed');
      }
    }, { defaultDebounceMs: 0 });
    const deps = createDeps(coordinator);

    try {
      scheduleDeleteReconcile(deps, 'C:/batch-isolation', 'shared-op', 'deleted-node', 'CatalogBatch');
      assert.strictEqual(await waitFor(() => runCount === 1), true);
      const trailing = coordinator.requestReload('C:/batch-isolation', 'manual-refresh', {
        operationId: 'shared-op',
        debounceMs: 0,
      });
      initialGate.resolve();

      const trailingResult = await trailing.completed;
      assert.strictEqual(trailingResult.succeeded, false);
      assert.strictEqual(await waitFor(() => vscodeTestState.informationLog.length === 1), true);
      assert.deepStrictEqual(vscodeTestState.informationLog, ['Удалён элемент: CatalogBatch']);
      assert.deepStrictEqual(vscodeTestState.warningLog, []);
    } finally {
      initialGate.resolve();
      await coordinator.dispose();
    }
  });

  test('failed delete reconciliation queues a fresh coordinator recovery and keeps a converged tree silent', async () => {
    let execution = 0;
    const coordinator = new ReloadCoordinatorService(async () => {
      execution += 1;
      if (execution === 1) {
        throw new Error('initial parse failure');
      }
    }, { defaultDebounceMs: 0 });
    const deps = createDeps(coordinator);
    const calls = observeRequests(coordinator);

    try {
      scheduleDeleteReconcile(deps, 'C:/failed-delete', 'delete-initial', 'deleted-node', 'CatalogFailed');
      assert.strictEqual(await waitFor(() => calls.length === 2), true);
      if (calls.length === 2) {
        await calls[1].handle.completed;
      }

      assert.strictEqual(calls.length, 2, 'both initial and forced recovery reloads should use the coordinator');
      assert.strictEqual(calls[0].options?.operationId, 'delete-initial');
      assert.notStrictEqual(calls[1].options?.operationId, calls[0].options?.operationId);
      assert.strictEqual(calls[1].reason, 'delete-command');
      assert.deepStrictEqual(calls[1].options, { operationId: calls[1].options?.operationId, debounceMs: 0 });
      assert.deepStrictEqual(vscodeTestState.informationLog, []);
      assert.deepStrictEqual(vscodeTestState.warningLog, [], 'recovery that converged should stay silent');
    } finally {
      await coordinator.dispose();
    }
  });

  test('failed forced recovery warns and never rolls back the committed delete', async () => {
    let execution = 0;
    const coordinator = new ReloadCoordinatorService(async () => {
      execution += 1;
      throw new Error(execution === 1 ? 'initial reload failed' : 'forced recovery failed');
    }, { defaultDebounceMs: 0 });
    const deps = createDeps(coordinator);
    const calls = observeRequests(coordinator);

    try {
      scheduleDeleteReconcile(deps, 'C:/recovery-failure', 'delete-failed-recovery', 'deleted-node', 'CatalogRecovery');
      assert.strictEqual(await waitFor(() => vscodeTestState.warningLog.length > 0), true);

      assert.strictEqual(calls.length, 2);
      assert.deepStrictEqual(vscodeTestState.informationLog, []);
      assert.ok(vscodeTestState.warningLog.some((message) => message.includes('автообновление дерева не завершилось')));
      assert.match(Logger.getBufferedContent(), /rollbackApplied":false/);
      assert.match(Logger.getBufferedContent(), /refreshFailure.*UNKNOWN_RELOAD_FAILURE/);
    } finally {
      await coordinator.dispose();
    }
  });

  test('initial timeout queues recovery and ignores the late initial completion', async () => {
    const initialGate = deferred<void>();
    let runCount = 0;
    const coordinator = new ReloadCoordinatorService(async () => {
      runCount += 1;
      if (runCount === 1) {
        await initialGate.promise;
      }
    }, { defaultDebounceMs: 0 });
    const deps = createDeps(coordinator, { reconcileTimeoutMs: 30 });
    const calls = observeRequests(coordinator);

    try {
      scheduleDeleteReconcile(deps, 'C:/timeout-delete', 'delete-timeout', 'deleted-node', 'CatalogTimeout');
      const recoveryQueued = await waitFor(() => calls.length === 2, 100);
      initialGate.resolve();
      await waitFor(() => runCount >= 2, 500);
      await waitFor(() => coordinator.getState('C:/timeout-delete').executedCount >= 2, 500);

      assert.strictEqual(recoveryQueued, true, 'timeout should schedule a forced trailing reload');
      assert.strictEqual(calls[1]?.options?.operationId === calls[0]?.options?.operationId, false);
      assert.strictEqual(calls[1]?.options?.debounceMs, 0);
      assert.deepStrictEqual(vscodeTestState.informationLog, [], 'late initial success must not notify as confirmed delete');
      assert.deepStrictEqual(vscodeTestState.warningLog, [], 'successful convergent recovery remains silent');
    } finally {
      initialGate.resolve();
      await coordinator.dispose();
    }
  });

  test('forced recovery timeout is typed and a later runner finish cannot report success', async () => {
    const recoveryGate = deferred<void>();
    let runCount = 0;
    const coordinator = new ReloadCoordinatorService(async () => {
      runCount += 1;
      if (runCount === 1) {
        throw new Error('initial reload failed');
      }
      await recoveryGate.promise;
    }, { defaultDebounceMs: 0 });
    const deps = createDeps(coordinator, { reconcileTimeoutMs: 25 });
    const calls = observeRequests(coordinator);

    try {
      scheduleDeleteReconcile(deps, 'C:/recovery-timeout', 'delete-recovery-timeout', 'deleted-node', 'CatalogRecoveryTimeout');
      assert.strictEqual(await waitFor(() => vscodeTestState.warningLog.length > 0), true);
      assert.strictEqual(calls.length, 2);
      assert.deepStrictEqual(vscodeTestState.informationLog, []);
      assert.match(Logger.getBufferedContent(), /refreshFailure.*RELOAD_TIMEOUT/);

      recoveryGate.resolve();
      await waitFor(() => runCount === 2 && coordinator.getState('C:/recovery-timeout').executedCount === 2);
      assert.deepStrictEqual(vscodeTestState.informationLog, []);
      assert.strictEqual(vscodeTestState.warningLog.length, 1);
    } finally {
      recoveryGate.resolve();
      await coordinator.dispose();
    }
  });

  test('disposed coordinator completion is negative and never falls back to direct lifecycle reload', async () => {
    const gate = deferred<void>();
    const coordinator = new ReloadCoordinatorService(async () => gate.promise, { defaultDebounceMs: 0 });
    const deps = createDeps(coordinator);
    const calls = observeRequests(coordinator);
    let disposed = false;
    const originalGetResult = coordinator.getOperationResult.bind(coordinator);
    (coordinator as any).getOperationResult = (...args: Parameters<ReloadCoordinatorService['getOperationResult']>) => {
      if (disposed) {
        return {
          operationId: args[1],
          reason: 'delete-command',
          succeeded: false,
          failure: { code: 'RELOAD_DISPOSED', message: 'disposed' },
          error: 'disposed',
          completedAt: Date.now(),
        } satisfies ReloadOperationResult;
      }
      return originalGetResult(...args);
    };

    try {
      scheduleDeleteReconcile(deps, 'C:/disposed-delete', 'delete-disposed', 'deleted-node', 'CatalogDisposed');
      disposed = true;
      const disposal = coordinator.dispose();
      gate.resolve();
      await disposal;
      assert.strictEqual(await waitFor(() => calls.length >= 2, 500), true);

      assert.ok(calls.length >= 2, 'disposed initial result should attempt coordinator-owned recovery');
      assert.deepStrictEqual(vscodeTestState.informationLog, []);
      assert.ok(vscodeTestState.warningLog.some((message) => message.includes('Не удалось подтвердить удаление')));
    } finally {
      gate.resolve();
      await coordinator.dispose();
    }
  });

  test('missing coordinator is a typed unavailable failure, with no lifecycle fallback', () => {
    const deps = createDeps(null);

    scheduleCoordinatedReload(deps, 'C:/unavailable', 'manual-refresh');
    scheduleDeleteReconcile(deps, 'C:/unavailable-delete', 'delete-unavailable', 'deleted-node', 'CatalogUnavailable');

    assert.ok(
      // Logger buffering is the runtime observation point for the void compatibility adapter.
      require('../../src/utils/logger').Logger.getBufferedContent().includes('RELOAD_COORDINATOR_UNAVAILABLE'),
      'unavailable coordinator should be logged with its typed failure code',
    );
    return waitFor(() => vscodeTestState.warningLog.length > 0).then((warned) => {
      assert.strictEqual(warned, true);
      assert.deepStrictEqual(vscodeTestState.informationLog, []);
      assert.ok(vscodeTestState.warningLog.some((message) => message.includes('Не удалось подтвердить удаление')));
    });
  });

  test('background negative completion is logged without an unhandled rejection', async () => {
    const coordinator = new ReloadCoordinatorService(async () => {
      throw new Error('background parse failed');
    }, { defaultDebounceMs: 0 });
    const deps = createDeps(coordinator);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      scheduleCoordinatedReload(deps, 'C:/background-failure', 'watcher');
      assert.strictEqual(await waitFor(() => Logger.getBufferedContent().includes('reload.coordinated.failed')), true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(Logger.getBufferedContent(), /UNKNOWN_RELOAD_FAILURE/);
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      await coordinator.dispose();
    }
  });
});
