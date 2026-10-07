import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import { ExtensionState } from '../../src/state/extensionState';
import { MetadataWatcherService } from '../../src/services/metadataWatcherService';
import { WorkspaceRegistry } from '../../src/services/configurationSession/WorkspaceRegistry';
import type { ConfigurationSession } from '../../src/services/configurationSession/ConfigurationSession';

suite('ExtensionState teardown and drain (#202, #205)', () => {
  test('#202: dispose() is fault-isolated: error in watcher does not block downstream cleanup', async () => {
    const state = new ExtensionState();

    let secondWatcherDisposed = false;
    let agentBridgeStopped = false;
    let reloadCoordinatorDisposed = false;

    const throwingWatcher = {
      dispose: () => {
        throw new Error('Watcher disposal exploded');
      },
    } as unknown as MetadataWatcherService;

    const healthyWatcher = {
      dispose: () => {
        secondWatcherDisposed = true;
      },
    } as unknown as MetadataWatcherService;

    state.metadataWatchers = [throwingWatcher, healthyWatcher];

    state.reloadCoordinator = {
      dispose: () => {
        reloadCoordinatorDisposed = true;
      },
    } as any;

    state.agentBridge = {
      stop: async () => {
        agentBridgeStopped = true;
      },
    } as any;

    await state.dispose();

    assert.strictEqual(secondWatcherDisposed, true, 'Second watcher must be disposed even if first throws');
    assert.strictEqual(reloadCoordinatorDisposed, true, 'Reload coordinator must be disposed');
    assert.strictEqual(agentBridgeStopped, true, 'Agent bridge must be stopped');
    assert.strictEqual(state.metadataWatchers.length, 0, 'Metadata watchers must be cleared');
  });

  test('#202: reject in supportRootRegistrationLifecycle does not block supportComposition or downstream teardown', async () => {
    const state = new ExtensionState();

    let supportCompositionDisposed = false;
    let agentBridgeStopped = false;

    state.supportRootRegistrationLifecycle = {
      dispose: async () => {
        throw new Error('Support root registration lifecycle rejected');
      },
    } as any;

    state.supportComposition = {
      dispose: async () => {
        await new Promise((r) => setTimeout(r, 10));
        supportCompositionDisposed = true;
      },
    } as any;

    state.agentBridge = {
      stop: async () => {
        agentBridgeStopped = true;
      },
    } as any;

    await state.dispose();

    assert.strictEqual(supportCompositionDisposed, true, 'supportComposition.dispose must be awaited');
    assert.strictEqual(agentBridgeStopped, true, 'agentBridge must be stopped despite support lifecycle failure');
  });

  test('#205: ExtensionState.dispose() awaits WorkspaceRegistry disposal and mutation drain', async () => {
    const state = new ExtensionState();

    let mutationCompleted = false;
    let registryDisposed = false;

    const mockRegistry = {
      dispose: async () => {
        // Simulate waiting for active mutation queue
        await new Promise((r) => setTimeout(r, 40));
        mutationCompleted = true;
        registryDisposed = true;
      },
    } as unknown as WorkspaceRegistry;

    (state as any).workspaceRegistry = mockRegistry;

    const disposePromise = state.dispose();
    assert.strictEqual(mutationCompleted, false, 'dispose must not complete before registry drain');

    await disposePromise;
    assert.strictEqual(mutationCompleted, true, 'in-flight mutation must drain before dispose completes');
    assert.strictEqual(registryDisposed, true, 'registry must be disposed');
  });

  test('#202: synchronous throw in supportComposition does not prevent supportRootRegistrationLifecycle disposal', async () => {
    const state = new ExtensionState();

    let supportRootDisposed = false;
    state.supportComposition = {
      dispose: () => {
        throw new Error('Support composition threw synchronously');
      },
    } as any;

    state.supportRootRegistrationLifecycle = {
      dispose: () => {
        supportRootDisposed = true;
      },
    } as any;

    await state.dispose();
    assert.strictEqual(
      supportRootDisposed,
      true,
      'supportRootRegistrationLifecycle must be disposed even if supportComposition throws synchronously'
    );
  });

  test('#204: ExtensionState.dispose() awaits agentTaskManager disposal and drains running tasks', async () => {
    const state = new ExtensionState();

    let taskDrainCompleted = false;
    let agentTaskManagerDisposed = false;

    (state as any).agentTaskManager = {
      dispose: async () => {
        await new Promise((r) => setTimeout(r, 40));
        taskDrainCompleted = true;
        agentTaskManagerDisposed = true;
      },
    };

    const disposePromise = state.dispose();
    assert.strictEqual(taskDrainCompleted, false, 'dispose must not complete before agentTaskManager drain');

    await disposePromise;
    assert.strictEqual(taskDrainCompleted, true, 'running agent tasks must drain before dispose completes');
    assert.strictEqual(agentTaskManagerDisposed, true, 'agentTaskManager must be disposed');
  });

  test('#202: dispose() is idempotent on repeated calls', async () => {
    const state = new ExtensionState();

    let bridgeStopCalls = 0;
    state.agentBridge = {
      stop: async () => {
        bridgeStopCalls += 1;
      },
    } as any;

    await state.dispose();
    assert.strictEqual(bridgeStopCalls, 1);

    await state.dispose();
    assert.strictEqual(bridgeStopCalls, 1, 'Repeated dispose must be a safe no-op');
  });
});
