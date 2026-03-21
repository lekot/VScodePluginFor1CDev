import * as assert from 'assert';
import {
  recoverDeleteUiStateAfterReconcileIssue,
} from '../../src/services/deleteReconcileRecovery';

suite('deleteReconcileRecovery', () => {
  test('recovery never performs rollback to keep delete UX monotonic', async () => {
    const result = await recoverDeleteUiStateAfterReconcileIssue({
      elementName: 'CatalogMonotonic',
      reason: 'failed',
      forceRefresh: async () => {},
      verifyDeletionConverged: async () => true,
    });

    assert.strictEqual(result.rollbackApplied, false);
  });

  test('delete success + benign reconcile lag stays silent for user', async () => {
    let refreshCalls = 0;
    let verifyCalls = 0;
    const result = await recoverDeleteUiStateAfterReconcileIssue({
      elementName: 'ахКакойНовыйСправочник',
      reason: 'timeout',
      forceRefresh: async () => {
        refreshCalls += 1;
      },
      verifyDeletionConverged: async () => {
        verifyCalls += 1;
        return true;
      },
    });

    assert.strictEqual(refreshCalls, 1);
    assert.strictEqual(verifyCalls, 1);
    assert.strictEqual(result.rollbackApplied, false);
    assert.strictEqual(result.refreshSucceeded, true);
    assert.strictEqual(result.converged, true);
    assert.strictEqual(result.shouldNotifyUser, false);
    assert.strictEqual(result.message, undefined);
  });

  test('failed reconcile with non-converged tree triggers warning', async () => {
    let refreshCalls = 0;
    const result = await recoverDeleteUiStateAfterReconcileIssue({
      elementName: 'CatalogA',
      reason: 'failed',
      forceRefresh: async () => {
        refreshCalls += 1;
      },
      verifyDeletionConverged: async () => false,
    });

    assert.strictEqual(refreshCalls, 1, 'Safe refresh should run to converge UI with disk state');
    assert.strictEqual(result.rollbackApplied, false);
    assert.strictEqual(result.refreshSucceeded, true);
    assert.strictEqual(result.converged, false);
    assert.strictEqual(result.shouldNotifyUser, true);
    assert.match(result.message ?? '', /не сошлось/);
  });

  test('refresh failure still warns with clear user action', async () => {
    const result = await recoverDeleteUiStateAfterReconcileIssue({
      elementName: 'CatalogB',
      reason: 'timeout',
      forceRefresh: async () => {
        throw new Error('reload failed');
      },
      verifyDeletionConverged: async () => {
        throw new Error('must not be called when refresh failed');
      },
    });

    assert.strictEqual(result.refreshSucceeded, false);
    assert.strictEqual(result.converged, null);
    assert.strictEqual(result.shouldNotifyUser, true);
    assert.match(result.message ?? '', /Нажмите «Обновить дерево»/);
  });

  test('when converge status is unknown after refresh, warning is preserved', async () => {
    const result = await recoverDeleteUiStateAfterReconcileIssue({
      elementName: 'CatalogUnknown',
      reason: 'timeout',
      forceRefresh: async () => {},
      verifyDeletionConverged: async () => null,
    });

    assert.strictEqual(result.refreshSucceeded, true);
    assert.strictEqual(result.converged, null);
    assert.strictEqual(result.shouldNotifyUser, true);
    assert.match(result.message ?? '', /Не удалось однозначно подтвердить удаление/);
  });
});
