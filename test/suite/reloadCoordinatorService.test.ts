import * as assert from 'assert';
import { ReloadCoordinatorService } from '../../src/services/reloadCoordinatorService';
import { ReloadRunContext } from '../../src/types/reloadContracts';

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
});
