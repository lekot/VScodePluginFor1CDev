import * as assert from 'assert';
import { ReloadCoordinatorService } from '../../src/services/reloadCoordinatorService';
import { ReloadRunContext } from '../../src/types/reloadContracts';
import { MetadataReloadError } from '../../src/extension/metadataTreeLifecycle';

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const nextEventLoopTurn = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(() => resolve()));
};

const assertInFlightBatchResults = async (firstRunFails: boolean): Promise<void> => {
  const runs: ReloadRunContext[] = [];
  const firstRunEntered = deferred<ReloadRunContext>();
  const nextRunEntered = deferred<ReloadRunContext>();
  const releaseFirstRun = deferred<void>();
  const coordinator = new ReloadCoordinatorService(async (ctx) => {
    const index = runs.push(ctx) - 1;
    if (index === 0) {
      firstRunEntered.resolve(ctx);
      await releaseFirstRun.promise;
      if (firstRunFails) {
        throw new Error('first batch failed');
      }
      return;
    }

    nextRunEntered.resolve(ctx);
    if (!firstRunFails) {
      throw new Error('pending batch failed');
    }
  }, { defaultDebounceMs: 0 });

  coordinator.scheduleReload('C:/cfg-a', 'delete-command', { operationId: 'op-first', debounceMs: 0 });
  const firstContext = await firstRunEntered.promise;
  assert.strictEqual(firstContext.operationId, 'op-first');

  coordinator.scheduleReload('C:/cfg-a', 'create-command', { operationId: 'op-pending-a' });
  coordinator.scheduleReload('C:/cfg-a', 'rename-command', { operationId: 'op-pending-b' });
  assert.strictEqual(coordinator.getState('C:/cfg-a').pending, true);

  releaseFirstRun.resolve(undefined);
  const nextContext = await nextRunEntered.promise;
  await nextEventLoopTurn();

  assert.strictEqual(nextContext.operationId, 'op-pending-a');
  assert.strictEqual(runs.length, 2);
  assert.deepStrictEqual(
    coordinator.getOperationResult('C:/cfg-a', 'op-first')?.reason,
    'delete-command',
  );
  assert.strictEqual(
    coordinator.getOperationResult('C:/cfg-a', 'op-first')?.succeeded,
    !firstRunFails,
  );
  assert.deepStrictEqual(
    coordinator.getOperationResult('C:/cfg-a', 'op-pending-a')?.reason,
    'create-command',
  );
  assert.deepStrictEqual(
    coordinator.getOperationResult('C:/cfg-a', 'op-pending-b')?.reason,
    'rename-command',
  );
  assert.strictEqual(
    coordinator.getOperationResult('C:/cfg-a', 'op-pending-a')?.succeeded,
    firstRunFails,
  );
  assert.strictEqual(
    coordinator.getOperationResult('C:/cfg-a', 'op-pending-b')?.succeeded,
    firstRunFails,
  );
  assert.strictEqual(coordinator.getState('C:/cfg-a').executedCount, 2);
  coordinator.dispose();
};

suite('ReloadCoordinatorService', () => {
  test('coalesces burst schedules into one effective run', async () => {
    const runs: ReloadRunContext[] = [];
    const coordinator = new ReloadCoordinatorService(async (ctx) => {
      runs.push(ctx);
    }, { defaultDebounceMs: 15, mutationWindowTtlMs: 150 });

    coordinator.scheduleReload('C:/cfg-a', 'watcher');
    coordinator.scheduleReload('C:/cfg-a', 'watcher');
    coordinator.scheduleReload('C:/cfg-a', 'watcher');
    await sleep(70);

    const state = coordinator.getState('C:/cfg-a');
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(state.scheduledCount, 3);
    assert.strictEqual(state.executedCount, 1);
    assert.strictEqual(state.lastRunSucceeded, true);
    assert.strictEqual(state.lastError, undefined);
    assert.ok(state.coalescedCount >= 2);
    coordinator.dispose();
  });

  test('uses host path case rules to isolate configuration reload slots', async () => {
    const upperCaseRoot = '/workspace/Config';
    const lowerCaseRoot = '/workspace/config';
    const runs: ReloadRunContext[] = [];
    const coordinator = new ReloadCoordinatorService(async (ctx) => {
      runs.push(ctx);
    }, { defaultDebounceMs: 0 });

    coordinator.scheduleReload(upperCaseRoot, 'delete-command', { operationId: 'op-upper', debounceMs: 0 });
    coordinator.scheduleReload(lowerCaseRoot, 'rename-command', { operationId: 'op-lower', debounceMs: 0 });
    await sleep(40);

    if (process.platform === 'win32') {
      assert.strictEqual(runs.length, 1, 'Windows case aliases should share one reload slot');
      assert.strictEqual(coordinator.getOperationResult(upperCaseRoot, 'op-upper')?.reason, 'delete-command');
      assert.strictEqual(coordinator.getOperationResult(lowerCaseRoot, 'op-lower')?.reason, 'rename-command');
    } else {
      assert.strictEqual(runs.length, 2, 'case-distinct POSIX roots must not coalesce');
      assert.strictEqual(coordinator.getOperationResult(upperCaseRoot, 'op-upper')?.reason, 'delete-command');
      assert.strictEqual(coordinator.getOperationResult(lowerCaseRoot, 'op-lower')?.reason, 'rename-command');
      assert.deepStrictEqual(
        runs.map((run) => run.configPath).sort(),
        [upperCaseRoot, lowerCaseRoot].sort(),
      );
    }
    coordinator.dispose();
  });

  test('retains each debounced operation result when watcher schedules without an ID', async () => {
    const runs: ReloadRunContext[] = [];
    const runEntered = deferred<ReloadRunContext>();
    const coordinator = new ReloadCoordinatorService(async (ctx) => {
      runs.push(ctx);
      runEntered.resolve(ctx);
    }, { defaultDebounceMs: 0 });

    coordinator.scheduleReload('C:/cfg-a', 'delete-command', { operationId: 'op-delete', debounceMs: 0 });
    coordinator.scheduleReload('C:/cfg-a', 'rename-command', { operationId: 'op-rename' });
    coordinator.scheduleReload('C:/cfg-a', 'watcher');
    const runContext = await runEntered.promise;
    await nextEventLoopTurn();

    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runContext.operationId, 'op-rename');
    assert.strictEqual(runContext.reason, 'watcher');
    assert.deepStrictEqual(
      coordinator.getOperationResult('C:/cfg-a', 'op-delete')?.reason,
      'delete-command',
    );
    assert.deepStrictEqual(
      coordinator.getOperationResult('C:/cfg-a', 'op-rename')?.reason,
      'rename-command',
    );
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-delete')?.succeeded, true);
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-rename')?.succeeded, true);
    coordinator.dispose();
  });

  test('keeps successful in-flight and failed pending batches separate', async () => {
    await assertInFlightBatchResults(false);
  });

  test('keeps failed in-flight and successful pending batches separate', async () => {
    await assertInFlightBatchResults(true);
  });

  test('isolates operation batches with the same ID across config roots', async () => {
    const runs: ReloadRunContext[] = [];
    const bothRunsEntered = deferred<void>();
    const coordinator = new ReloadCoordinatorService(async (ctx) => {
      runs.push(ctx);
      if (runs.length === 2) {
        bothRunsEntered.resolve(undefined);
      }
    }, { defaultDebounceMs: 0 });

    coordinator.scheduleReload('C:/cfg-a', 'delete-command', { operationId: 'shared-id', debounceMs: 0 });
    coordinator.scheduleReload('C:/cfg-b', 'rename-command', { operationId: 'shared-id', debounceMs: 0 });
    await bothRunsEntered.promise;
    await nextEventLoopTurn();

    assert.strictEqual(runs.length, 2);
    assert.strictEqual(
      coordinator.getOperationResult('C:/cfg-a', 'shared-id')?.reason,
      'delete-command',
    );
    assert.strictEqual(
      coordinator.getOperationResult('C:/cfg-b', 'shared-id')?.reason,
      'rename-command',
    );
    coordinator.dispose();
  });

  test('deduplicates repeated operation IDs and keeps their original reason', async () => {
    const runs: ReloadRunContext[] = [];
    const runEntered = deferred<void>();
    const coordinator = new ReloadCoordinatorService(async (ctx) => {
      runs.push(ctx);
      runEntered.resolve(undefined);
    }, { defaultDebounceMs: 0 });

    coordinator.scheduleReload('C:/cfg-a', 'delete-command', { operationId: 'same-id', debounceMs: 0 });
    coordinator.scheduleReload('C:/cfg-a', 'rename-command', { operationId: 'same-id' });
    await runEntered.promise;
    await nextEventLoopTurn();

    assert.strictEqual(runs.length, 1);
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'same-id')?.reason, 'delete-command');
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'same-id')?.succeeded, true);
    coordinator.dispose();
  });

  test('bounds operation result history to the newest 50 entries', async () => {
    const runEntered = deferred<void>();
    const coordinator = new ReloadCoordinatorService(async () => {
      runEntered.resolve(undefined);
    }, { defaultDebounceMs: 0 });

    for (let index = 1; index <= 51; index += 1) {
      coordinator.scheduleReload('C:/cfg-a', 'create-command', {
        operationId: `op-${index}`,
        debounceMs: 0,
      });
    }
    await runEntered.promise;
    await nextEventLoopTurn();

    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-1'), null);
    for (let index = 2; index <= 51; index += 1) {
      assert.strictEqual(
        coordinator.getOperationResult('C:/cfg-a', `op-${index}`)?.succeeded,
        true,
        `operation ${index} should remain in result history`,
      );
    }
    coordinator.dispose();
  });

  test('bounds result history when the oldest operation ID is an empty string', async () => {
    const runEntered = deferred<void>();
    const coordinator = new ReloadCoordinatorService(async () => {
      runEntered.resolve(undefined);
    }, { defaultDebounceMs: 0 });

    coordinator.scheduleReload('C:/cfg-a', 'create-command', { operationId: '', debounceMs: 0 });
    for (let index = 1; index <= 50; index += 1) {
      coordinator.scheduleReload('C:/cfg-a', 'create-command', {
        operationId: `op-${index}`,
        debounceMs: 0,
      });
    }
    await runEntered.promise;
    await nextEventLoopTurn();

    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', ''), null);
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-1')?.succeeded, true);
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-50')?.succeeded, true);
    coordinator.dispose();
  });

  test('dispose cancels debounce work and makes later calls neutral', async () => {
    let runCount = 0;
    const coordinator = new ReloadCoordinatorService(async () => {
      runCount += 1;
    }, { defaultDebounceMs: 30 });

    coordinator.scheduleReload('C:/cfg-a', 'delete-command', { operationId: 'op-pending' });
    coordinator.dispose();
    coordinator.dispose();
    coordinator.scheduleReload('C:/cfg-a', 'watcher', { operationId: 'op-after-dispose' });
    coordinator.markMutationWindow('C:/cfg-a', 'op-after-dispose', 1000);
    await sleep(80);

    const state = coordinator.getState('C:/cfg-a');
    assert.strictEqual(runCount, 0);
    assert.strictEqual(state.pending, false);
    assert.strictEqual(state.inFlight, false);
    assert.strictEqual(state.lastReason, null);
    assert.strictEqual(state.scheduledCount, 0);
    assert.strictEqual(state.mutationWindowUntil, undefined);
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-pending'), null);
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-after-dispose'), null);
  });

  for (const firstRunFails of [false, true]) {
    test(`dispose does not rearm an in-flight batch after ${firstRunFails ? 'failure' : 'success'}`, async () => {
      const firstRunEntered = deferred<void>();
      const releaseFirstRun = deferred<void>();
      let runCount = 0;
      const coordinator = new ReloadCoordinatorService(async () => {
        runCount += 1;
        firstRunEntered.resolve(undefined);
        await releaseFirstRun.promise;
        if (firstRunFails) {
          throw new Error('in-flight reload failed');
        }
      }, { defaultDebounceMs: 0 });

      coordinator.scheduleReload('C:/cfg-a', 'delete-command', { operationId: 'op-running', debounceMs: 0 });
      await firstRunEntered.promise;
      coordinator.scheduleReload('C:/cfg-a', 'rename-command', { operationId: 'op-pending' });
      coordinator.dispose();
      coordinator.dispose();
      coordinator.scheduleReload('C:/cfg-a', 'watcher', { operationId: 'op-after-dispose' });
      coordinator.markMutationWindow('C:/cfg-a', 'op-after-dispose');
      releaseFirstRun.resolve(undefined);
      await sleep(30);

      const state = coordinator.getState('C:/cfg-a');
      assert.strictEqual(runCount, 1);
      assert.strictEqual(state.pending, false);
      assert.strictEqual(state.inFlight, false);
      assert.strictEqual(state.lastReason, null);
      assert.strictEqual(state.scheduledCount, 0);
      assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-running'), null);
      assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-pending'), null);
      assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-after-dispose'), null);
    });
  }

  test('keeps pending rerun while previous run is in flight', async () => {
    const runs: ReloadRunContext[] = [];
    let release: (() => void) | undefined;
    const firstRunGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const coordinator = new ReloadCoordinatorService(async (ctx) => {
      runs.push(ctx);
      if (runs.length === 1) {
        await firstRunGate;
      }
    }, { defaultDebounceMs: 0, mutationWindowTtlMs: 150 });

    coordinator.scheduleReload('C:/cfg-a', 'delete-command', { operationId: 'op-1' });
    await sleep(10);
    coordinator.scheduleReload('C:/cfg-a', 'watcher');
    await sleep(20);

    const inFlightState = coordinator.getState('C:/cfg-a');
    assert.strictEqual(inFlightState.inFlight, true);
    assert.strictEqual(inFlightState.pending, true);

    release?.();
    await sleep(40);

    const finalState = coordinator.getState('C:/cfg-a');
    assert.strictEqual(runs.length, 2, 'Pending schedule should execute as second run');
    assert.strictEqual(finalState.executedCount, 2);
    assert.strictEqual(finalState.inFlight, false);
    assert.strictEqual(finalState.pending, false);
    coordinator.dispose();
  });

  test('suppresses watcher schedule inside mutation window with pending command reload', async () => {
    const runs: ReloadRunContext[] = [];
    const coordinator = new ReloadCoordinatorService(async (ctx) => {
      runs.push(ctx);
    }, { defaultDebounceMs: 20, mutationWindowTtlMs: 250 });

    coordinator.markMutationWindow('C:/cfg-a', 'op-delete', 250);
    coordinator.scheduleReload('C:/cfg-a', 'delete-command', { debounceMs: 20, operationId: 'op-delete' });
    coordinator.scheduleReload('C:/cfg-a', 'watcher');
    await sleep(80);

    const state = coordinator.getState('C:/cfg-a');
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].reason, 'delete-command');
    assert.ok(state.suppressedWatcherCount >= 1);
    coordinator.dispose();
  });

  test('keeps a watcher operation ID in a batch during the mutation window', async () => {
    const runs: ReloadRunContext[] = [];
    const runEntered = deferred<void>();
    const coordinator = new ReloadCoordinatorService(async (ctx) => {
      runs.push(ctx);
      runEntered.resolve(undefined);
    }, { defaultDebounceMs: 0, mutationWindowTtlMs: 250 });

    coordinator.markMutationWindow('C:/cfg-a', 'op-command', 250);
    coordinator.scheduleReload('C:/cfg-a', 'delete-command', { operationId: 'op-command', debounceMs: 0 });
    coordinator.scheduleReload('C:/cfg-a', 'watcher', { operationId: 'op-watcher' });
    await runEntered.promise;
    await nextEventLoopTurn();

    assert.strictEqual(runs.length, 1);
    assert.strictEqual(coordinator.getState('C:/cfg-a').suppressedWatcherCount, 0);
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-command')?.reason, 'delete-command');
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-watcher')?.reason, 'watcher');
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-watcher')?.succeeded, true);
    coordinator.dispose();
  });

  test('isolates pending and execution state per config root', async () => {
    const runs: ReloadRunContext[] = [];
    const coordinator = new ReloadCoordinatorService(async (ctx) => {
      runs.push(ctx);
    }, { defaultDebounceMs: 10, mutationWindowTtlMs: 120 });

    coordinator.scheduleReload('C:/cfg-a', 'watcher');
    coordinator.scheduleReload('C:/cfg-b', 'delete-command', { operationId: 'op-b' });
    await sleep(60);

    const stateA = coordinator.getState('C:/cfg-a');
    const stateB = coordinator.getState('C:/cfg-b');
    assert.strictEqual(runs.length, 2);
    assert.strictEqual(stateA.executedCount, 1);
    assert.strictEqual(stateB.executedCount, 1);
    assert.notStrictEqual(stateA.lastReason, stateB.lastReason);
    coordinator.dispose();
  });

  test('counts failed run as executed and clears inFlight', async () => {
    const coordinator = new ReloadCoordinatorService(async () => {
      throw new Error('reload failed');
    }, { defaultDebounceMs: 0, mutationWindowTtlMs: 120 });

    coordinator.scheduleReload('C:/cfg-a', 'manual-refresh');
    await sleep(30);

    const state = coordinator.getState('C:/cfg-a');
    assert.strictEqual(state.executedCount, 1);
    assert.strictEqual(state.inFlight, false);
    assert.strictEqual(state.pending, false);
    assert.strictEqual(state.lastRunSucceeded, false);
    assert.strictEqual(state.lastError, 'reload failed');
    assert.deepStrictEqual(state.lastFailure, {
      code: 'UNKNOWN_RELOAD_FAILURE',
      message: 'reload failed',
    });
    coordinator.dispose();
  });

  test('preserves typed reload failure in config state and operation result', async () => {
    const coordinator = new ReloadCoordinatorService(async () => {
      throw new MetadataReloadError(
        'CONFIGURATION_PARSE_FAILED',
        'configuration parse failed',
        'C:/cfg-a',
      );
    }, { defaultDebounceMs: 0, mutationWindowTtlMs: 120 });

    coordinator.scheduleReload('C:/cfg-a', 'delete-command', {
      operationId: 'op-typed',
      debounceMs: 0,
    });
    coordinator.scheduleReload('C:/cfg-a', 'rename-command', {
      operationId: 'op-typed-second',
      debounceMs: 0,
    });
    await sleep(30);

    const expectedFailure = {
      code: 'CONFIGURATION_PARSE_FAILED',
      message: 'configuration parse failed',
    };
    assert.deepStrictEqual(coordinator.getState('C:/cfg-a').lastFailure, expectedFailure);
    assert.deepStrictEqual(
      coordinator.getOperationResult('C:/cfg-a', 'op-typed')?.failure,
      expectedFailure,
    );
    assert.deepStrictEqual(
      coordinator.getOperationResult('C:/cfg-a', 'op-typed-second')?.failure,
      expectedFailure,
    );
    assert.strictEqual(coordinator.getOperationResult('C:/cfg-a', 'op-typed')?.reason, 'delete-command');
    assert.strictEqual(
      coordinator.getOperationResult('C:/cfg-a', 'op-typed-second')?.reason,
      'rename-command',
    );
    coordinator.dispose();
  });

  test('keeps delete operation outcome stable under out-of-order watcher runs', async () => {
    const runs: ReloadRunContext[] = [];
    const coordinator = new ReloadCoordinatorService(async (ctx) => {
      runs.push(ctx);
      if (ctx.reason === 'watcher') {
        throw new Error('watcher reload failed');
      }
    }, { defaultDebounceMs: 0, mutationWindowTtlMs: 80 });

    coordinator.markMutationWindow('C:/cfg-a', 'op-delete', 30);
    coordinator.scheduleReload('C:/cfg-a', 'delete-command', { operationId: 'op-delete', debounceMs: 0 });
    await sleep(20);

    // Late watcher event arrives after delete reconcile run and fails.
    coordinator.scheduleReload('C:/cfg-a', 'watcher', { debounceMs: 0 });
    await sleep(30);

    const deleteOutcome = coordinator.getOperationResult('C:/cfg-a', 'op-delete');
    assert.ok(deleteOutcome, 'Delete operation result should be persisted by operationId');
    assert.strictEqual(deleteOutcome!.succeeded, true);
    assert.strictEqual(deleteOutcome!.reason, 'delete-command');

    const state = coordinator.getState('C:/cfg-a');
    assert.strictEqual(state.lastRunSucceeded, false, 'Global last run may fail due to watcher');
    assert.strictEqual(runs.length, 2, 'Both delete and watcher runs should execute');
    coordinator.dispose();
  });

  test('#213: dispose() awaits in-flight reload and drops pending timer schedules', async () => {
    let reloadFinished = false;
    let secondReloadStarted = false;
    const reloadEntered = deferred<void>();
    const allowReloadFinish = deferred<void>();

    const coordinator = new ReloadCoordinatorService(async (ctx) => {
      if (ctx.operationId === 'op-1') {
        reloadEntered.resolve(undefined);
        await allowReloadFinish.promise;
        reloadFinished = true;
        return;
      }
      secondReloadStarted = true;
    }, { defaultDebounceMs: 50 });

    coordinator.scheduleReload('C:/cfg-a', 'manual-refresh', { operationId: 'op-1', debounceMs: 0 });
    await reloadEntered.promise;
    assert.strictEqual(coordinator.getState('C:/cfg-a').inFlight, true);

    // Schedule another with debounce that hasn't fired yet
    coordinator.scheduleReload('C:/cfg-b', 'watcher', { debounceMs: 100 });

    // Call dispose
    let disposeFinished = false;
    const disposePromise = Promise.resolve(coordinator.dispose()).then(() => {
      disposeFinished = true;
    });

    await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(disposeFinished, false, 'dispose() must not complete before in-flight reload settles');

    // New schedule after dispose must be rejected/ignored
    coordinator.scheduleReload('C:/cfg-c', 'manual-refresh', { debounceMs: 0 });

    // Allow in-flight reload to finish
    allowReloadFinish.resolve(undefined);
    await disposePromise;

    assert.strictEqual(disposeFinished, true, 'dispose() must complete after in-flight reload settles');
    assert.strictEqual(reloadFinished, true, 'in-flight reload must be completed');
    assert.strictEqual(secondReloadStarted, false, 'pending debounced reload must not have run');
  });
});
