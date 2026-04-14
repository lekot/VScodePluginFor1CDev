import * as assert from 'assert';
import {
  invalidateIncrementalSupportProbeCache,
  probeIncrementalSupport,
  type IbcmdVersionExecFn,
} from '../../src/services/ibcmd/ibcmdVersionSupport';

const FAKE_PATH = 'C:/fake/ibcmd.exe';

/**
 * Build a mock execImpl that simulates ibcmd subcommand behaviour.
 * @param exitCode — numeric exit code means command is recognised (e.g. 2 = usage error).
 *                    `null` simulates a spawn/signal failure (command not found).
 */
function makeExecWithExit(exitCode: number | null): IbcmdVersionExecFn {
  return async (_file, _args, _opts) => {
    if (exitCode === null) {
      // Simulate spawn failure: code is null (signal kill / ENOENT)
      const err: Error & { code?: number | null; status?: number | null } = new Error('spawn error');
      err.code = null;
      err.status = null;
      throw err;
    }
    if (exitCode !== 0) {
      const err: Error & { code?: number | null; status?: number | null; stdout?: string; stderr?: string } =
        new Error(`exit ${exitCode}`);
      err.status = exitCode;
      err.code = exitCode;
      err.stdout = '';
      err.stderr = 'usage error';
      throw err;
    }
    return { stdout: '', stderr: '' };
  };
}

/** Build a mock execImpl that counts invocations and returns exit 2 (supported). */
function makeCountingExec(): { exec: IbcmdVersionExecFn; callCount: () => number } {
  let count = 0;
  const exec: IbcmdVersionExecFn = async (_file, _args, _opts) => {
    count++;
    const err: Error & { code?: number; status?: number; stdout?: string; stderr?: string } =
      new Error('exit 2');
    err.status = 2;
    err.code = 2;
    err.stdout = '';
    err.stderr = '';
    throw err;
  };
  return { exec, callCount: () => count };
}

suite('ibcmdVersionSupport — incremental probe', () => {
  setup(() => {
    invalidateIncrementalSupportProbeCache();
  });

  teardown(() => {
    invalidateIncrementalSupportProbeCache();
  });

  // 1 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: exit code 2 (usage error) → all supported', async () => {
    const exec = makeExecWithExit(2);
    const probe = await probeIncrementalSupport(FAKE_PATH, exec);
    assert.strictEqual(probe.importFiles, true);
    assert.strictEqual(probe.exportStatus, true);
    assert.strictEqual(probe.exportSync, true);
    assert.strictEqual(probe.exportObjects, true);
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: exit code 0 → all supported', async () => {
    const exec = makeExecWithExit(0);
    const probe = await probeIncrementalSupport(FAKE_PATH, exec);
    assert.strictEqual(probe.importFiles, true);
    assert.strictEqual(probe.exportObjects, true);
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: null exit (spawn error) → not supported', async () => {
    const exec = makeExecWithExit(null);
    const probe = await probeIncrementalSupport(FAKE_PATH, exec);
    assert.strictEqual(probe.importFiles, false);
    assert.strictEqual(probe.exportStatus, false);
    assert.strictEqual(probe.exportSync, false);
    assert.strictEqual(probe.exportObjects, false);
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: caching — execImpl called only once for same path', async () => {
    const { exec, callCount } = makeCountingExec();

    await probeIncrementalSupport(FAKE_PATH, exec);
    const countAfterFirst = callCount();
    assert.ok(countAfterFirst >= 1, 'execImpl should have been called at least once');

    await probeIncrementalSupport(FAKE_PATH, exec);
    assert.strictEqual(callCount(), countAfterFirst, 'execImpl should not be called again after caching');
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  test('invalidateIncrementalSupportProbeCache: clears cache so next call re-probes', async () => {
    const { exec, callCount } = makeCountingExec();

    await probeIncrementalSupport(FAKE_PATH, exec);
    const countAfterFirst = callCount();

    invalidateIncrementalSupportProbeCache();

    await probeIncrementalSupport(FAKE_PATH, exec);
    assert.ok(
      callCount() > countAfterFirst,
      'After cache invalidation execImpl should be called again',
    );
  });
});
