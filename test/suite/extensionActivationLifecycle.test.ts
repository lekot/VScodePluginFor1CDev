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
});
