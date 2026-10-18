import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import { reconcileAfterCommit } from '../../src/reload/reconciliation';

suite('post-commit reconciliation outcome', () => {
  test('reports success when reload completes', async () => {
    const outcome = await reconcileAfterCommit('/config', 'pull-objects', async () => undefined);

    assert.deepStrictEqual(outcome, { status: 'succeeded' });
  });

  test('preserves Error code and message', async () => {
    const reloadError = Object.assign(new Error('reload failed'), { code: 'AUDIT_RELOAD_FAILURE' });
    const outcome = await reconcileAfterCommit('/config', 'pull-objects', async () => { throw reloadError; });

    assert.deepStrictEqual(outcome, {
      status: 'failed',
      code: 'AUDIT_RELOAD_FAILURE',
      message: 'reload failed',
    });
  });

  test('preserves code and message from a plain object error', async () => {
    const outcome = await reconcileAfterCommit('/config', 'pull-objects', async () => {
      throw { code: 'RELOAD_CUSTOM', message: 'plain object failure' };
    });

    assert.deepStrictEqual(outcome, {
      status: 'failed',
      code: 'RELOAD_CUSTOM',
      message: 'plain object failure',
    });
  });

  test('uses the generic reload code when an error has no string code', async () => {
    const outcome = await reconcileAfterCommit('/config', 'pull-objects', async () => { throw 'unknown failure'; });

    assert.deepStrictEqual(outcome, {
      status: 'failed',
      code: 'UNKNOWN_RELOAD_FAILURE',
      message: 'unknown failure',
    });
  });
});
