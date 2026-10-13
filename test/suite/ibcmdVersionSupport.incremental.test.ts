import * as assert from 'assert';
import { EventEmitter } from 'events';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { PassThrough } from 'stream';
import {
  invalidateIncrementalSupportProbeCache,
  probeIncrementalSupport,
} from '../../src/services/ibcmd/ibcmdVersionSupport';
import type { IbcmdStreamCancellation, IbcmdStreamingRunnerOptions } from '../../src/services/ibcmd/IbcmdStreamingRunner';

const FAKE_PATH = 'C:/fake/ibcmd.exe';

interface ProbeProcessOptions {
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
  cancellation?: IbcmdStreamCancellation;
  terminateProcessTreeImpl?: IbcmdStreamingRunnerOptions['terminateProcessTreeImpl'];
}

const probeIncrementalSupportWithProcessBoundary = probeIncrementalSupport as unknown as (
  executablePath: string,
  options?: ProbeProcessOptions,
) => ReturnType<typeof probeIncrementalSupport>;

function spawnWithExit(code: number | 'hang', count?: () => void, delayMs = 0): typeof spawn {
  return ((_executable: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
    count?.();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { stdout: PassThrough }).stdout = stdout;
    (child as unknown as { stderr: PassThrough }).stderr = stderr;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    (child as unknown as { killed: boolean }).killed = false;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    setImmediate(() => {
      child.emit('spawn');
      if (code === 'hang') return;
      const finish = (): void => {
        stderr.write('db not found');
        stdout.end();
        stderr.end();
        child.emit('close', code, null);
      };
      if (delayMs > 0) {
        setTimeout(finish, delayMs);
      } else {
        finish();
      }
    });
    return child;
  }) as typeof spawn;
}

function cancellable(): IbcmdStreamCancellation & { cancel(): void } {
  let requested = false;
  const listeners = new Set<() => void>();
  return {
    get isCancellationRequested() { return requested; },
    onCancellationRequested(listener) {
      if (requested) {
        listener();
        return { dispose: () => undefined };
      }
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

function assertUnsupported(probe: Awaited<ReturnType<typeof probeIncrementalSupport>>): void {
  assert.deepStrictEqual(probe, {
    importFiles: false,
    exportStatus: false,
    exportSync: false,
    exportObjects: false,
  });
}

function makeCountingOptions(): { options: ProbeProcessOptions; callCount: () => number } {
  let count = 0;
  return {
    options: { spawnImpl: spawnWithExit(2, () => { count += 1; }), timeoutMs: 1000 },
    callCount: () => count,
  };
}

suite('ibcmdVersionSupport — incremental probe', () => {
  setup(() => {
    invalidateIncrementalSupportProbeCache();
  });

  teardown(() => {
    invalidateIncrementalSupportProbeCache();
  });

  // 1 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: numeric exit code (db not found) → all supported', async () => {
    // ibcmd returns 4294967295 when subcommand is valid but db-path is wrong
    const probe = await probeIncrementalSupport(FAKE_PATH, {
      spawnImpl: spawnWithExit(4294967295),
      timeoutMs: 1000,
    });
    assert.strictEqual(probe.importFiles, true);
    assert.strictEqual(probe.exportStatus, true);
    assert.strictEqual(probe.exportSync, true);
    assert.strictEqual(probe.exportObjects, true);
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: exit code 0 → all supported', async () => {
    const probe = await probeIncrementalSupport(FAKE_PATH, { spawnImpl: spawnWithExit(0), timeoutMs: 1000 });
    assert.strictEqual(probe.importFiles, true);
    assert.strictEqual(probe.exportObjects, true);
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: timed out process → not supported', async () => {
    // ibcmd hangs waiting for input when subcommand is unknown → Node kills it
    const probe = await probeIncrementalSupport(FAKE_PATH, {
      spawnImpl: spawnWithExit('hang'),
      timeoutMs: 10,
      terminateProcessTreeImpl: async () => ({
        terminated: true,
        hardKillUsed: false,
        survivingPids: [],
        errors: [],
      }),
    });
    assert.strictEqual(probe.importFiles, false);
    assert.strictEqual(probe.exportStatus, false);
    assert.strictEqual(probe.exportSync, false);
    assert.strictEqual(probe.exportObjects, false);
  });

  test('a pre-cancelled capability probe does not cache false support for the executable path', async () => {
    const token = cancellable();
    token.cancel();
    let processStarts = 0;

    const cancelled = await probeIncrementalSupportWithProcessBoundary(FAKE_PATH, {
      cancellation: token,
      spawnImpl: spawnWithExit(2, () => { processStarts += 1; }),
    });
    assertUnsupported(cancelled);
    assert.strictEqual(processStarts, 0);

    const retried = await probeIncrementalSupportWithProcessBoundary(FAKE_PATH, {
      spawnImpl: spawnWithExit(2, () => { processStarts += 1; }),
      timeoutMs: 1000,
    });
    assert.strictEqual(retried.importFiles, true);
    assert.strictEqual(retried.exportStatus, true);
    assert.strictEqual(retried.exportSync, true);
    assert.strictEqual(retried.exportObjects, true);
    assert.strictEqual(processStarts, 4);
  });

  test('an active cancelled capability probe is retried instead of caching false support', async () => {
    const token = cancellable();
    let processStarts = 0;
    const cancelledRun = probeIncrementalSupportWithProcessBoundary(FAKE_PATH, {
      cancellation: token,
      spawnImpl: spawnWithExit('hang', () => { processStarts += 1; }),
      timeoutMs: 1000,
      terminateProcessTreeImpl: async () => ({
        terminated: true,
        hardKillUsed: false,
        survivingPids: [],
        errors: [],
      }),
    });

    const deadline = Date.now() + 1000;
    while (processStarts < 4 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.strictEqual(processStarts, 4, 'all four child processes should start before cancellation');
    token.cancel();
    assertUnsupported(await cancelledRun);

    const retried = await probeIncrementalSupportWithProcessBoundary(FAKE_PATH, {
      spawnImpl: spawnWithExit(2, () => { processStarts += 1; }),
      timeoutMs: 1000,
    });
    assert.strictEqual(retried.importFiles, true);
    assert.strictEqual(retried.exportStatus, true);
    assert.strictEqual(retried.exportSync, true);
    assert.strictEqual(retried.exportObjects, true);
    assert.strictEqual(processStarts, 8, 'the retry should launch fresh probes after cancellation');
  });

  test('cancelling one waiter does not poison a shared in-flight capability probe or its cache', async () => {
    const token = cancellable();
    let processStarts = 0;
    const first = probeIncrementalSupportWithProcessBoundary(FAKE_PATH, {
      cancellation: token,
      spawnImpl: spawnWithExit(2, () => { processStarts += 1; }, 100),
      timeoutMs: 1000,
      terminateProcessTreeImpl: async () => ({
        terminated: true,
        hardKillUsed: false,
        survivingPids: [],
        errors: [],
      }),
    });

    const deadline = Date.now() + 1000;
    while (processStarts < 4 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.strictEqual(processStarts, 4, 'all four probes should be pending before the second waiter joins');

    const shared = probeIncrementalSupportWithProcessBoundary(FAKE_PATH, {
      spawnImpl: spawnWithExit(2, () => { processStarts += 1; }),
      timeoutMs: 1000,
    });
    token.cancel();

    assertUnsupported(await first);
    const sharedResult = await shared;
    assert.strictEqual(sharedResult.importFiles, true);
    assert.strictEqual(sharedResult.exportStatus, true);
    assert.strictEqual(sharedResult.exportSync, true);
    assert.strictEqual(sharedResult.exportObjects, true);

    const cached = await probeIncrementalSupportWithProcessBoundary(FAKE_PATH, {
      spawnImpl: spawnWithExit(2, () => { processStarts += 1; }),
      timeoutMs: 1000,
    });
    assert.strictEqual(cached.importFiles, true);
    assert.strictEqual(processStarts, 4, 'successful shared probes should remain cached');
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: caching — process boundary called only once for same path', async () => {
    const { options, callCount } = makeCountingOptions();

    await probeIncrementalSupport(FAKE_PATH, options);
    const countAfterFirst = callCount();
    assert.strictEqual(countAfterFirst, 4, 'the four owned capability probes should each spawn once');

    await probeIncrementalSupport(FAKE_PATH, options);
    assert.strictEqual(callCount(), countAfterFirst, 'processes should not be spawned again after caching');
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  test('invalidateIncrementalSupportProbeCache: clears cache so next call re-probes', async () => {
    const { options, callCount } = makeCountingOptions();

    await probeIncrementalSupport(FAKE_PATH, options);
    const countAfterFirst = callCount();

    invalidateIncrementalSupportProbeCache();

    await probeIncrementalSupport(FAKE_PATH, options);
    assert.ok(
      callCount() > countAfterFirst,
      'After cache invalidation execImpl should be called again',
    );
  });

  test('incremental capability probes use the shared process boundary and preserve numeric exit contract', async () => {
    const probe = await probeIncrementalSupportWithProcessBoundary(FAKE_PATH, {
      spawnImpl: spawnWithExit(2),
      timeoutMs: 100,
    });

    assert.strictEqual(probe.importFiles, true);
    assert.strictEqual(probe.exportStatus, true);
    assert.strictEqual(probe.exportSync, true);
    assert.strictEqual(probe.exportObjects, true);
  });
});
