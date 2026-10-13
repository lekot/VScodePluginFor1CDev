import * as assert from 'assert';
import { EventEmitter } from 'events';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { PassThrough } from 'stream';
import {
  invalidateIncrementalSupportProbeCache,
  probeIncrementalSupport,
} from '../../src/services/ibcmd/ibcmdVersionSupport';

const FAKE_PATH = 'C:/fake/ibcmd.exe';

interface ProbeProcessOptions {
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

const probeIncrementalSupportWithProcessBoundary = probeIncrementalSupport as unknown as (
  executablePath: string,
  options?: ProbeProcessOptions,
) => ReturnType<typeof probeIncrementalSupport>;

function spawnWithExit(code: number | 'hang', count?: () => void): typeof spawn {
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
      stderr.write('db not found');
      stdout.end();
      stderr.end();
      child.emit('close', code, null);
    });
    return child;
  }) as typeof spawn;
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
