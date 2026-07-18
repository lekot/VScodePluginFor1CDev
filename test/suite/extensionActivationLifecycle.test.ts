import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, rollbackPartialActivation } from '../../src/extension';
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
});
