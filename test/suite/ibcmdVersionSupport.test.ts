import * as assert from 'assert';
import { EventEmitter } from 'events';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { PassThrough } from 'stream';
import {
  IBCMD_MIN_YAML_INFOBASE_PATCH,
  ibcmdYamlInfobaseTooOldUserMessage,
  invalidateIbcmdVersionQueryCache,
  isIbcmdVersionYamlInfobaseConfigSupported,
  tryParseIbcmdVersionOutput,
  getIbcmdYamlInfobaseConfigUnsupportedMessage,
  queryParsedIbcmdVersion,
  type ParsedIbcmdVersion,
} from '../../src/services/ibcmd/ibcmdVersionSupport';
import type { IbcmdStreamingRunnerOptions } from '../../src/services/ibcmd/IbcmdStreamingRunner';

interface VersionProcessOptions {
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
  terminateProcessTreeImpl?: IbcmdStreamingRunnerOptions['terminateProcessTreeImpl'];
  cancellation?: {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
  };
}

const queryVersionWithProcessBoundary = queryParsedIbcmdVersion as unknown as (
  executablePath: string,
  options?: VersionProcessOptions,
) => ReturnType<typeof queryParsedIbcmdVersion>;

function fakeVersionSpawn(
  stdoutText: string,
  code = 0,
  onStart?: () => void,
  delayMs = 0,
): typeof spawn {
  return ((_executable: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { stdout: PassThrough }).stdout = stdout;
    (child as unknown as { stderr: PassThrough }).stderr = stderr;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    (child as unknown as { killed: boolean }).killed = false;
    let delayedClose: ReturnType<typeof setTimeout> | undefined;
    (child as unknown as { kill: () => boolean }).kill = () => {
      if (delayedClose !== undefined) {
        clearTimeout(delayedClose);
      }
      return true;
    };
    setImmediate(() => {
      child.emit('spawn');
      onStart?.();
      const close = (): void => {
        if (stdoutText) stdout.write(stdoutText);
        stdout.end();
        stderr.end();
        child.emit('close', code, null);
      };
      if (delayMs > 0) {
        delayedClose = setTimeout(close, delayMs);
      } else {
        close();
      }
    });
    return child;
  }) as typeof spawn;
}

function cancellableVersionQuery(): NonNullable<VersionProcessOptions['cancellation']> & { cancel(): void } {
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

suite('ibcmdVersionSupport', () => {
  teardown(() => {
    invalidateIbcmdVersionQueryCache();
  });

  test('tryParseIbcmdVersionOutput: single line', () => {
    const v = tryParseIbcmdVersionOutput('8.3.27.1000\n');
    assert.ok(v);
    assert.strictEqual(v!.major, 8);
    assert.strictEqual(v!.minor, 3);
    assert.strictEqual(v!.patch, 27);
    assert.strictEqual(v!.build, 1000);
    assert.strictEqual(v!.raw, '8.3.27.1000');
  });

  test('tryParseIbcmdVersionOutput: ignores second line', () => {
    const v = tryParseIbcmdVersionOutput('8.3.23.2157\nextra');
    assert.ok(v);
    assert.strictEqual(v!.patch, 23);
  });

  test('tryParseIbcmdVersionOutput: rejects garbage', () => {
    assert.strictEqual(tryParseIbcmdVersionOutput(''), undefined);
    assert.strictEqual(tryParseIbcmdVersionOutput('8.3'), undefined);
  });

  test(`isIbcmdVersionYamlInfobaseConfigSupported: patch >= ${IBCMD_MIN_YAML_INFOBASE_PATCH}`, () => {
    const ok = (major: number, minor: number, patch: number): ParsedIbcmdVersion => ({
      major,
      minor,
      patch,
      build: 1,
      raw: `${major}.${minor}.${patch}.1`,
    });
    assert.strictEqual(isIbcmdVersionYamlInfobaseConfigSupported(ok(8, 3, 27)), true);
    assert.strictEqual(isIbcmdVersionYamlInfobaseConfigSupported(ok(8, 3, 26)), false);
    assert.strictEqual(isIbcmdVersionYamlInfobaseConfigSupported(ok(8, 4, 0)), true);
    assert.strictEqual(isIbcmdVersionYamlInfobaseConfigSupported(ok(9, 0, 0)), true);
    assert.strictEqual(isIbcmdVersionYamlInfobaseConfigSupported(ok(7, 3, 99)), false);
  });

  test('ibcmdYamlInfobaseTooOldUserMessage mentions standalone-server', () => {
    const m = ibcmdYamlInfobaseTooOldUserMessage('8.3.23.2157');
    assert.ok(m.includes('8.3.23.2157'));
    assert.ok(m.includes('8.3.27'));
    assert.ok(m.includes('standalone-server'));
  });

  test('getIbcmdYamlInfobaseConfigUnsupportedMessage: old version through shared process runner', async () => {
    invalidateIbcmdVersionQueryCache();
    const msg = await getIbcmdYamlInfobaseConfigUnsupportedMessage('C:\\ibcmd.exe', {
      spawnImpl: fakeVersionSpawn('8.3.23.2157\n'),
    });
    assert.ok(msg);
    assert.ok(msg!.includes('8.3.23.2157'));
  });

  test('getIbcmdYamlInfobaseConfigUnsupportedMessage: new version → undefined', async () => {
    invalidateIbcmdVersionQueryCache();
    const msg = await getIbcmdYamlInfobaseConfigUnsupportedMessage('C:\\ibcmd.exe', {
      spawnImpl: fakeVersionSpawn('8.3.27.1\n'),
    });
    assert.strictEqual(msg, undefined);
  });

  test('version query uses the shared process boundary and parses decoded output', async () => {
    invalidateIbcmdVersionQueryCache();
    const parsed = await queryVersionWithProcessBoundary('C:\\ibcmd.exe', {
      spawnImpl: fakeVersionSpawn('8.3.27.2157\n'),
      timeoutMs: 100,
    });

    assert.deepStrictEqual(parsed, {
      major: 8,
      minor: 3,
      patch: 27,
      build: 2157,
      raw: '8.3.27.2157',
    });
  });

  test('cancelling one waiter does not cancel the shared old-version query used by the version gate', async () => {
    invalidateIbcmdVersionQueryCache();
    const cancellation = cancellableVersionQuery();
    let processStarts = 0;
    const first = queryVersionWithProcessBoundary('C:\\shared-ibcmd.exe', {
      cancellation,
      spawnImpl: fakeVersionSpawn('8.3.23.2157\n', 0, () => { processStarts += 1; }, 500),
      timeoutMs: 1000,
      terminateProcessTreeImpl: async (child) => {
        child.kill();
        return { terminated: true, hardKillUsed: false, survivingPids: [], errors: [] };
      },
    });

    const deadline = Date.now() + 1000;
    while (processStarts === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.strictEqual(processStarts, 1, 'the shared version command should be running');

    const versionGate = getIbcmdYamlInfobaseConfigUnsupportedMessage('C:\\shared-ibcmd.exe');
    cancellation.cancel();

    assert.strictEqual(await first, undefined, 'the cancelled caller should stop waiting');
    const message = await versionGate;
    assert.ok(message?.includes('8.3.23.2157'), 'the active gate caller must still reject an unsupported version');
    assert.strictEqual(processStarts, 1, 'the shared query should finish without an unnecessary second process');
  });

  test('cancelling every version-query waiter removes the pending cache entry for a later retry', async () => {
    invalidateIbcmdVersionQueryCache();
    const firstCancellation = cancellableVersionQuery();
    const secondCancellation = cancellableVersionQuery();
    let processStarts = 0;
    const first = queryVersionWithProcessBoundary('C:\\retry-ibcmd.exe', {
      cancellation: firstCancellation,
      spawnImpl: fakeVersionSpawn('8.3.23.2157\n', 0, () => { processStarts += 1; }, 500),
      timeoutMs: 1000,
      terminateProcessTreeImpl: async (child) => {
        child.kill();
        return { terminated: true, hardKillUsed: false, survivingPids: [], errors: [] };
      },
    });

    const deadline = Date.now() + 1000;
    while (processStarts === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.strictEqual(processStarts, 1, 'the shared version command should be running');
    const second = queryVersionWithProcessBoundary('C:\\retry-ibcmd.exe', {
      cancellation: secondCancellation,
    });
    firstCancellation.cancel();
    secondCancellation.cancel();

    assert.strictEqual(await first, undefined);
    assert.strictEqual(await second, undefined);
    const retry = await queryVersionWithProcessBoundary('C:\\retry-ibcmd.exe', {
      spawnImpl: fakeVersionSpawn('8.3.27.2157\n', 0, () => { processStarts += 1; }),
      timeoutMs: 1000,
    });
    assert.strictEqual(retry?.raw, '8.3.27.2157');
    assert.strictEqual(processStarts, 2, 'the retry must start a fresh version command');
  });

  test('pre-cancelled version probe does not poison the path cache', async () => {
    invalidateIbcmdVersionQueryCache();
    const parsedCancelled = await queryVersionWithProcessBoundary('C:\\ibcmd.exe', {
      cancellation: {
        isCancellationRequested: true,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      },
    });
    assert.strictEqual(parsedCancelled, undefined);

    const parsedNext = await queryVersionWithProcessBoundary('C:\\ibcmd.exe', {
      spawnImpl: fakeVersionSpawn('8.3.27.2157\n'),
      timeoutMs: 100,
    });
    assert.strictEqual(parsedNext?.raw, '8.3.27.2157');
  });
});
