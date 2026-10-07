import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, deactivate, extensionState, rollbackPartialActivation } from '../../src/extension';
import { ExtensionState } from '../../src/state/extensionState';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

suite('extension activation lifecycle', () => {
  setup(() => resetVscodeTestState());
  teardown(() => resetVscodeTestState());

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

  test('deactivate awaits agentTaskManager disposal and drains background tasks', async () => {
    (extensionState as any)._isDisposed = false;
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
    (state as any)._isDisposed = false;
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


