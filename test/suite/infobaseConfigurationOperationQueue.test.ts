import * as assert from 'assert';
import {
  InfobaseConfigurationOperationQueue,
  type InfobaseConfigurationOperationLease,
} from '../../src/infobases/infobaseConfigurationOperationQueue';

interface QueueCancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

type CancellableRunExclusive = <T>(
  identity: string,
  operation: (lease: InfobaseConfigurationOperationLease) => Promise<T>,
  cancellation?: QueueCancellation,
) => Promise<T>;

function runExclusive<T>(
  queue: InfobaseConfigurationOperationQueue,
  identity: string,
  operation: (lease: InfobaseConfigurationOperationLease) => Promise<T>,
  cancellation?: QueueCancellation,
): Promise<T> {
  const run = queue.runExclusive as unknown as CancellableRunExclusive;
  return Reflect.apply(run, queue, [identity, operation, cancellation]) as Promise<T>;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function cancellable(): QueueCancellation & { cancel(): void } {
  let requested = false;
  const listeners = new Set<() => void>();
  return {
    get isCancellationRequested() { return requested; },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      if (requested) return;
      requested = true;
      listeners.forEach((listener) => listener());
    },
  };
}

function isQueueCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'InfobaseConfigurationOperationCancelledError';
}

suite('infobaseConfigurationOperationQueue cancellation', () => {
  test('pre-cancelled operation does not acquire a lease or invoke the callback', async () => {
    const queue = new InfobaseConfigurationOperationQueue();
    const cancellation = cancellable();
    cancellation.cancel();
    let started = false;

    await assert.rejects(
      runExclusive(queue, 'target-a', async () => {
        started = true;
        return 'unexpected';
      }, cancellation),
      isQueueCancellation,
    );
    assert.strictEqual(started, false);
  });

  test('queued cancellation returns immediately while its FIFO gate still preserves following ownership', async () => {
    const queue = new InfobaseConfigurationOperationQueue();
    const events: string[] = [];
    const releaseFirst = deferred<void>();
    const firstEntered = deferred<void>();
    const cancellation = cancellable();
    const first = runExclusive(queue, 'target-b', async () => {
      events.push('first');
      firstEntered.resolve();
      await releaseFirst.promise;
      return 'first';
    });
    await firstEntered.promise;

    const cancelledWaiter = runExclusive(queue, 'target-b', async () => {
      events.push('cancelled-waiter-ran');
      return 'unexpected';
    }, cancellation).then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    const following = runExclusive(queue, 'target-b', async () => {
      events.push('following');
      return 'following';
    });

    try {
      cancellation.cancel();
      const immediate = await Promise.race([
        cancelledWaiter,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
      ]);
      assert.ok(immediate, 'queued cancellation should return without waiting for the held lease');
      assert.strictEqual(immediate.kind, 'error');
      assert.ok(isQueueCancellation(immediate.error));
      assert.deepStrictEqual(events, ['first']);
    } finally {
      releaseFirst.resolve();
      await first;
      await cancelledWaiter;
      await following;
    }

    assert.deepStrictEqual(events, ['first', 'following']);
  });
});
