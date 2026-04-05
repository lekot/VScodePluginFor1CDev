import * as assert from 'assert';
import {
  invalidateIncrementalSupportProbeCache,
  probeIncrementalSupport,
  type IbcmdVersionExecFn,
} from '../../src/services/ibcmd/ibcmdVersionSupport';

const FAKE_PATH = 'C:/fake/ibcmd.exe';

/** Build a mock execImpl that returns the given text for all calls. */
function makeExec(text: string): IbcmdVersionExecFn {
  return async (_file, _args, _opts) => ({ stdout: text, stderr: '' });
}

/** Build a mock execImpl that counts invocations. */
function makeCountingExec(
  text: string,
): { exec: IbcmdVersionExecFn; callCount: () => number } {
  let count = 0;
  const exec: IbcmdVersionExecFn = async (_file, _args, _opts) => {
    count++;
    return { stdout: text, stderr: '' };
  };
  return { exec, callCount: () => count };
}

suite('ibcmdVersionSupport — incremental probe', () => {
  // Reset cache before each test so tests are isolated.
  setup(() => {
    invalidateIncrementalSupportProbeCache();
  });

  teardown(() => {
    invalidateIncrementalSupportProbeCache();
  });

  // 1 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: stdout containing "files" → importFiles: true', async () => {
    const exec = makeExec('Available subcommands: import export files status sync objects');
    const probe = await probeIncrementalSupport(FAKE_PATH, exec);
    assert.strictEqual(probe.importFiles, true);
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: stdout without "files" → importFiles: false', async () => {
    const exec = makeExec('Available subcommands: import export');
    const probe = await probeIncrementalSupport(FAKE_PATH, exec);
    assert.strictEqual(probe.importFiles, false);
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: stdout with "status" → exportStatus: true', async () => {
    // import help has no "files", export help has "status"
    // The implementation calls import --help then export --help.
    // We return a text that contains "status" from both calls so exportStatus is true.
    const exec = makeExec('status');
    const probe = await probeIncrementalSupport(FAKE_PATH, exec);
    assert.strictEqual(probe.exportStatus, true);
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test('probeIncrementalSupport: caching — execImpl called only once for same path', async () => {
    const { exec, callCount } = makeCountingExec('files status sync objects');

    await probeIncrementalSupport(FAKE_PATH, exec);
    await probeIncrementalSupport(FAKE_PATH, exec);

    // The implementation makes 2 execImpl calls internally (import --help + export --help),
    // but those happen once per path due to caching of the Promise.
    // The total call count should not grow on the second probeIncrementalSupport call.
    const countAfterFirst = callCount();
    assert.ok(countAfterFirst >= 1, 'execImpl should have been called at least once');

    // A third call must NOT trigger more execImpl invocations.
    await probeIncrementalSupport(FAKE_PATH, exec);
    assert.strictEqual(callCount(), countAfterFirst, 'execImpl should not be called again after caching');
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  test('invalidateIncrementalSupportProbeCache: clears cache so next call re-probes', async () => {
    const { exec, callCount } = makeCountingExec('files status sync objects');

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
