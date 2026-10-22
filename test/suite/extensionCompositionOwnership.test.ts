import * as assert from 'assert';
import { ExtensionCompositionOwnership } from '../../src/extension/extensionCompositionOwnership';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

suite('ExtensionCompositionOwnership (#261)', () => {
  test('deduplicates by identity, upgrades a producer to explicit quiesce, and rejects phase conflicts', async () => {
    const events: string[] = [];
    const ownership = new ExtensionCompositionOwnership(() => undefined);
    const producer = { dispose: () => { events.push('producer-dispose'); } };
    const producerQuiesce = () => { events.push('producer-quiesce'); };
    const sessions = { dispose: () => { events.push('sessions-dispose'); } };

    ownership.registerDisposable('producer', producer, { quiescePhase: 'producers' });
    ownership.registerDisposable('producer with explicit stop', producer, { quiesce: producerQuiesce });
    ownership.registerDisposable('sessions', sessions, {
      quiescePhase: 'sessions',
      quiesce: () => { events.push('sessions-quiesce'); },
    });

    await ownership.beginQuiescence();
    assert.deepStrictEqual(events, ['producer-quiesce', 'sessions-quiesce']);

    const firstDispose = ownership.disposeResources();
    assert.strictEqual(ownership.disposeResources(), firstDispose, 'concurrent disposal must share one promise');
    await firstDispose;
    assert.deepStrictEqual(events, [
      'producer-quiesce',
      'sessions-quiesce',
      'sessions-dispose',
      'producer-dispose',
    ], 'quiesce callbacks must run before sessions drain and identity duplicates must dispose once');

    const conflictEvents: string[] = [];
    const conflictingOwnership = new ExtensionCompositionOwnership(() => undefined);
    const conflicted = { dispose: () => { conflictEvents.push('dispose'); } };
    conflictingOwnership.registerDisposable('first phase', conflicted, { quiescePhase: 'ingress' });
    assert.throws(
      () => conflictingOwnership.registerDisposable('conflicting phase', conflicted, { quiescePhase: 'producers' }),
      /multiple quiesce phases/u,
    );
    await conflictingOwnership.disposeResources();
    assert.deepStrictEqual(conflictEvents, ['dispose'], 'a rejected phase upgrade must preserve the original resource owner');
  });

  test('adopts resources during blocked sessions quiesce and disposes them only after the phase drains', async () => {
    const events: string[] = [];
    const ownership = new ExtensionCompositionOwnership(() => undefined);
    const sessionsStarted = deferred();
    const releaseSessions = deferred();
    const producer = { dispose: () => { events.push('producer-dispose'); } };
    const sessions = { dispose: () => { events.push('sessions-dispose'); } };
    ownership.registerDisposable('producer', producer, {
      quiescePhase: 'producers',
      quiesce: () => { events.push('producer-quiesce'); },
    });
    ownership.registerDisposable('active sessions', sessions, {
      quiescePhase: 'sessions',
      quiesce: async () => {
        events.push('sessions-start');
        sessionsStarted.resolve();
        await releaseSessions.promise;
        events.push('sessions-end');
      },
    });

    const quiesce = ownership.beginQuiescence();
    const disposal = ownership.disposeResources();
    assert.strictEqual(ownership.beginQuiescence(), quiesce, 'concurrent quiescence must share one promise');
    assert.strictEqual(ownership.disposeResources(), disposal, 'concurrent disposal must share one promise');
    try {
      await sessionsStarted.promise;
      const lateResource = { dispose: () => { events.push('late-dispose'); } };
      ownership.registerDisposable('late active session', lateResource, {
        quiescePhase: 'sessions',
        quiesce: () => { events.push('late-sessions-quiesce'); },
      });
      assert.deepStrictEqual(events, ['producer-quiesce', 'sessions-start']);

      releaseSessions.resolve();
      await disposal;
    } finally {
      releaseSessions.resolve();
      await disposal;
    }

    assert.deepStrictEqual(events, [
      'producer-quiesce',
      'sessions-start',
      'sessions-end',
      'late-sessions-quiesce',
      'late-dispose',
      'sessions-dispose',
      'producer-dispose',
    ], 'late sessions must quiesce before LIFO disposal begins');
  });

  test('disposes late adoptions immediately during cleanup and drains them exactly once', async () => {
    const events: string[] = [];
    const ownership = new ExtensionCompositionOwnership(() => undefined);
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const oldestDisposed = deferred();
    const lateQuiesced = deferred();
    const callbackCompleted = deferred();
    const nestedQuiesced = deferred();
    const lateDisposeStarted = deferred();
    const releaseLateDispose = deferred();
    const lateDisposeCompleted = deferred();
    const nestedDisposeStarted = deferred();
    const releaseNestedDispose = deferred();
    const nestedDisposeCompleted = deferred();
    let lateQuiesceCalls = 0;
    let callbackCalls = 0;
    let nestedQuiesceCalls = 0;
    let lateDisposeCalls = 0;
    let nestedDisposeCalls = 0;
    let disposalCompleted = false;
    ownership.registerDisposable('oldest cleanup', () => {
      events.push('oldest-dispose');
      oldestDisposed.resolve();
    });
    ownership.registerDisposable('blocking cleanup', async () => {
      events.push('blocking-start');
      cleanupStarted.resolve();
      await releaseCleanup.promise;
      events.push('blocking-end');
    });

    const disposal = ownership.disposeResources();
    void disposal.then(() => { disposalCompleted = true; });
    try {
      await cleanupStarted.promise;
      const nestedResource = {
        dispose: async () => {
          nestedDisposeCalls += 1;
          events.push('nested-dispose-start');
          nestedDisposeStarted.resolve();
          await releaseNestedDispose.promise;
          events.push('nested-dispose-end');
          nestedDisposeCompleted.resolve();
        },
      };
      const nestedQuiesce = () => {
        nestedQuiesceCalls += 1;
        events.push('nested-quiesce');
        nestedQuiesced.resolve();
      };
      const lateResource = {
        dispose: async () => {
          lateDisposeCalls += 1;
          events.push('late-dispose-start');
          lateDisposeStarted.resolve();
          await releaseLateDispose.promise;
          events.push('late-dispose-end');
          lateDisposeCompleted.resolve();
        },
      };
      const lateQuiesce = () => {
        lateQuiesceCalls += 1;
        events.push('late-quiesce');
        ownership.registerDisposable('nested resource', nestedResource, {
          quiescePhase: 'sessions',
          quiesce: nestedQuiesce,
        });
        ownership.registerDisposable('nested duplicate', nestedResource, { quiesce: nestedQuiesce });
        lateQuiesced.resolve();
      };
      ownership.registerDisposable('late resource', lateResource, {
        quiescePhase: 'sessions',
        quiesce: lateQuiesce,
      });
      ownership.registerDisposable('late duplicate', lateResource, {
        quiescePhase: 'sessions',
        quiesce: lateQuiesce,
      });
      ownership.registerQuiesce('late callback', 'sessions', () => {
        callbackCalls += 1;
        events.push('late-callback');
        callbackCompleted.resolve();
      });

      await Promise.all([
        lateQuiesced.promise,
        callbackCompleted.promise,
        nestedQuiesced.promise,
        lateDisposeStarted.promise,
        nestedDisposeStarted.promise,
      ]);
      assert.strictEqual(lateDisposeCalls, 1, 'identity duplicates must start late disposal once');
      assert.strictEqual(nestedDisposeCalls, 1, 'reentrant identity duplicates must start disposal once');
      assert.strictEqual(disposalCompleted, false, 'the main cleanup must remain pending behind its blocker');
      assert.ok(!events.includes('blocking-end'), 'late cleanup must start while the main disposer is blocked');

      releaseCleanup.resolve();
      await oldestDisposed.promise;
      assert.deepStrictEqual(events.slice(-2), ['blocking-end', 'oldest-dispose'], 'main resources must retain LIFO order');
      assert.strictEqual(disposalCompleted, false, 'cleanup must await the pending late disposal promises');

      releaseLateDispose.resolve();
      releaseNestedDispose.resolve();
      await Promise.all([lateDisposeCompleted.promise, nestedDisposeCompleted.promise]);
      await disposal;
    } finally {
      releaseCleanup.resolve();
      releaseLateDispose.resolve();
      releaseNestedDispose.resolve();
      await disposal;
    }

    assert.strictEqual(lateQuiesceCalls, 1, 'identity duplicates must quiesce once');
    assert.strictEqual(callbackCalls, 1, 'a late quiesce callback must be drained once');
    assert.strictEqual(nestedQuiesceCalls, 1, 'a reentrant registration must quiesce once');
    assert.strictEqual(lateDisposeCalls, 1, 'identity duplicates must dispose once');
    assert.strictEqual(nestedDisposeCalls, 1, 'reentrant identity duplicates must dispose once');
    assert.ok(events.indexOf('blocking-start') < events.indexOf('late-quiesce'));
    assert.ok(events.indexOf('late-quiesce') < events.indexOf('late-dispose-start'));
    assert.ok(events.indexOf('nested-quiesce') < events.indexOf('nested-dispose-start'));
    assert.ok(events.indexOf('late-dispose-start') < events.indexOf('late-dispose-end'));
    assert.ok(events.indexOf('nested-dispose-start') < events.indexOf('nested-dispose-end'));
    assert.ok(events.indexOf('blocking-end') < events.indexOf('oldest-dispose'));
    assert.strictEqual(disposalCompleted, true);
  });

  test('continues ordered quiesce and LIFO disposal when reporting errors throws', async () => {
    const events: string[] = [];
    const reports: Array<{ message: string; error: unknown }> = [];
    const quiesceError = new Error('quiesce failed');
    const disposeError = new Error('dispose failed');
    const ownership = new ExtensionCompositionOwnership((message, error) => {
      reports.push({ message, error });
      events.push(`report:${message}`);
      throw new Error('logger failed');
    });

    ownership.registerDisposable('oldest', () => { events.push('dispose-oldest'); });
    ownership.registerDisposable('failing disposer', () => {
      events.push('dispose-failing');
      throw disposeError;
    });
    ownership.registerDisposable('newest', () => { events.push('dispose-newest'); });
    ownership.registerQuiesce('ingress failure', 'ingress', () => {
      events.push('quiesce-ingress');
      throw quiesceError;
    });
    ownership.registerQuiesce('producer phase', 'producers', () => { events.push('quiesce-producers'); });
    ownership.registerQuiesce('sessions phase', 'sessions', () => { events.push('quiesce-sessions'); });

    const firstQuiesce = ownership.beginQuiescence();
    const firstDispose = ownership.disposeResources();
    assert.strictEqual(ownership.beginQuiescence(), firstQuiesce);
    assert.strictEqual(ownership.disposeResources(), firstDispose);
    await firstDispose;

    assert.deepStrictEqual(events, [
      'quiesce-ingress',
      'report:ExtensionCompositionRoot quiesce error for ingress failure',
      'quiesce-producers',
      'quiesce-sessions',
      'dispose-newest',
      'dispose-failing',
      'report:ExtensionCompositionRoot cleanup error for failing disposer',
      'dispose-oldest',
    ], 'a throwing logger must not interrupt phase order or LIFO resource cleanup');
    assert.deepStrictEqual(reports, [
      { message: 'ExtensionCompositionRoot quiesce error for ingress failure', error: quiesceError },
      { message: 'ExtensionCompositionRoot cleanup error for failing disposer', error: disposeError },
    ]);
  });
});
