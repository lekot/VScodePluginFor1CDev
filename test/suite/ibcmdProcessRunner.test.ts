import * as assert from 'assert';
import { EventEmitter } from 'events';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { PassThrough } from 'stream';
import {
  IBCMD_EXEC_MAX_BUFFER,
  resolveIbcmdTimeoutMs,
  runIbcmdExecutable,
  type IbcmdExecutableProcessOptions,
} from '../../src/services/ibcmd/IbcmdProcessRunner';

interface ProcessBoundaryOptions {
  spawnImpl?: typeof spawn;
  consoleOutputEncoding?: 'auto' | 'utf8' | 'utf16le' | 'oem866' | 'windows1251';
  maxBuffer?: number;
}

const runIbcmdExecutableWithProcessBoundary = runIbcmdExecutable as unknown as (
  executable: string,
  args: string[],
  timeoutMs: number,
  options?: ProcessBoundaryOptions,
) => Promise<{ stdout: string; stderr: string }>;

function fakeProcessBoundary(
  code: number,
  stdoutText: string,
  stderrText: string,
  onSpawn?: (executable: string, args: readonly string[], options: SpawnOptions) => void,
): typeof spawn {
  return ((executable: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    onSpawn?.(executable, args, options);
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
      if (stdoutText) stdout.write(stdoutText);
      if (stderrText) stderr.write(stderrText);
      stdout.end();
      stderr.end();
      child.emit('close', code, null);
    });
    return child;
  }) as typeof spawn;
}

suite('ibcmdProcessRunner', () => {
  suite('resolveIbcmdTimeoutMs', () => {
    test('uses positive finite settings value when set', () => {
      assert.strictEqual(resolveIbcmdTimeoutMs(42, '999'), 42);
    });

    test('ignores non-positive settings and uses env', () => {
      assert.strictEqual(resolveIbcmdTimeoutMs(0, '5000'), 5000);
      assert.strictEqual(resolveIbcmdTimeoutMs(-1, '3000'), 3000);
    });

    test('ignores NaN and infinite settings', () => {
      assert.strictEqual(resolveIbcmdTimeoutMs(Number.NaN, '2000'), 2000);
      assert.strictEqual(resolveIbcmdTimeoutMs(Number.POSITIVE_INFINITY, '2000'), 2000);
    });

    test('falls back to default 600000 when settings and env invalid', () => {
      assert.strictEqual(resolveIbcmdTimeoutMs(0, undefined), 600_000);
      assert.strictEqual(resolveIbcmdTimeoutMs(undefined, ''), 600_000);
      assert.strictEqual(resolveIbcmdTimeoutMs(undefined, '0'), 600_000);
      assert.strictEqual(resolveIbcmdTimeoutMs(undefined, '-5'), 600_000);
      assert.strictEqual(resolveIbcmdTimeoutMs(undefined, 'not-a-number'), 600_000);
    });

    test('parses env integer when settings omitted or zero', () => {
      assert.strictEqual(resolveIbcmdTimeoutMs(undefined, '120000'), 120_000);
    });
  });

  suite('runIbcmdExecutable', () => {
    test('uses the shared process boundary and preserves normal config-check output', async () => {
      const calls: Array<{ executable: string; args: readonly string[] }> = [];
      const out = await runIbcmdExecutableWithProcessBoundary(
        '/ibcmd',
        ['infobase', 'config', 'check', '--config=C:\\ib.yml'],
        7777,
        {
          spawnImpl: fakeProcessBoundary(0, 'check ok', 'diagnostic', (executable, args) => {
            calls.push({ executable, args });
          }),
        },
      );

      assert.deepStrictEqual(calls, [{
        executable: '/ibcmd',
        args: ['infobase', 'config', 'check', '--config=C:\\ib.yml'],
      }]);
      assert.strictEqual(out.stdout, 'check ok');
      assert.strictEqual(out.stderr, 'diagnostic');
    });

    test('nonzero exit retains execFile-compatible code, stdout and stderr', async () => {
      let failure: unknown;
      try {
        await runIbcmdExecutableWithProcessBoundary('/ibcmd', ['infobase', 'config', 'check'], 1000, {
          spawnImpl: fakeProcessBoundary(17, 'partial stdout', 'validation failed'),
        });
      } catch (error) {
        failure = error;
      }

      assert.ok(failure instanceof Error, 'a nonzero config-check exit should reject');
      const result = failure as Error & {
        code?: number | string;
        status?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      assert.strictEqual(result.code, 17);
      assert.strictEqual(result.status, 17);
      assert.strictEqual(result.stdout, 'partial stdout');
      assert.strictEqual(result.stderr, 'validation failed');
    });

    test('bounds per-stream output and rejects overflow with execFile-compatible fields', async () => {
      let failure: unknown;
      try {
        await runIbcmdExecutable('/ibcmd', [], 1000, {
          maxBuffer: 5,
          spawnImpl: fakeProcessBoundary(0, '123456789', 'safe'),
        });
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      const result = failure as Error & { code?: string; stdout?: string; stderr?: string };
      assert.strictEqual(result.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      assert.strictEqual(result.stdout?.length, 5);
      assert.strictEqual(result.stderr, 'safe');
      assert.ok(IBCMD_EXEC_MAX_BUFFER > 5);
    });

    test('uses the shared runner timeout and sets windowsHide at the process boundary', async () => {
      const calls: SpawnOptions[] = [];
      const options: IbcmdExecutableProcessOptions = {
        spawnImpl: fakeProcessBoundary(0, 'out', 'err', (_exe, _args, spawnOptions) => {
          calls.push(spawnOptions);
        }),
      };
      const out = await runIbcmdExecutable('/x', [], 1000, options);
      assert.strictEqual(out.stdout, 'out');
      assert.strictEqual(out.stderr, 'err');
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].windowsHide, true);
    });

    test('with --db-path= in argv passes child env without IBCMD default-connection env vars', async () => {
      const prevCfg = process.env.IBCMD_INFOBASE_CONFIG;
      const prevUser = process.env.IBCMD_USER;
      const prevPwd = process.env.IBCMD_PASSWORD;
      process.env.IBCMD_INFOBASE_CONFIG = 'C:\\other-infobase.yml';
      process.env.IBCMD_USER = 'u1';
      process.env.IBCMD_PASSWORD = 'p1';
      try {
        const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];
        const spawnImpl = fakeProcessBoundary(0, '', '', (_file, _args, options) => {
          calls.push({ env: options.env });
        });
        await runIbcmdExecutable(
          '/x',
          ['infobase', 'config', 'check', '--db-path=C:\\ib', '--data=C:\\d'],
          1,
          { spawnImpl },
        );
        assert.strictEqual(calls.length, 1);
        assert.ok(calls[0].env, 'spawn should receive explicit env');
        assert.strictEqual(calls[0].env!.IBCMD_INFOBASE_CONFIG, undefined);
        assert.strictEqual(calls[0].env!.IBCMD_USER, undefined);
        assert.strictEqual(calls[0].env!.IBCMD_PASSWORD, undefined);
        assert.strictEqual(process.env.IBCMD_INFOBASE_CONFIG, 'C:\\other-infobase.yml');
      } finally {
        if (prevCfg === undefined) {
          delete process.env.IBCMD_INFOBASE_CONFIG;
        } else {
          process.env.IBCMD_INFOBASE_CONFIG = prevCfg;
        }
        if (prevUser === undefined) {
          delete process.env.IBCMD_USER;
        } else {
          process.env.IBCMD_USER = prevUser;
        }
        if (prevPwd === undefined) {
          delete process.env.IBCMD_PASSWORD;
        } else {
          process.env.IBCMD_PASSWORD = prevPwd;
        }
      }
    });

    test('with --config= in argv passes child env without IBCMD default-connection env vars', async () => {
      const prevCfg = process.env.IBCMD_INFOBASE_CONFIG;
      const prevUser = process.env.IBCMD_USER;
      const prevPwd = process.env.IBCMD_PASSWORD;
      process.env.IBCMD_INFOBASE_CONFIG = 'C:\\other-infobase.yml';
      process.env.IBCMD_USER = 'u1';
      process.env.IBCMD_PASSWORD = 'p1';
      try {
        const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];
        const spawnImpl = fakeProcessBoundary(0, '', '', (_file, _args, options) => {
          calls.push({ env: options.env });
        });
        await runIbcmdExecutable('/x', ['infobase', 'config', 'check', '--config=C:\\me.yml'], 1, { spawnImpl });
        assert.strictEqual(calls.length, 1);
        assert.ok(calls[0].env, 'spawn should receive explicit env');
        assert.strictEqual(calls[0].env!.IBCMD_INFOBASE_CONFIG, undefined);
        assert.strictEqual(calls[0].env!.IBCMD_USER, undefined);
        assert.strictEqual(calls[0].env!.IBCMD_PASSWORD, undefined);
        assert.strictEqual(process.env.IBCMD_INFOBASE_CONFIG, 'C:\\other-infobase.yml');
      } finally {
        if (prevCfg === undefined) {
          delete process.env.IBCMD_INFOBASE_CONFIG;
        } else {
          process.env.IBCMD_INFOBASE_CONFIG = prevCfg;
        }
        if (prevUser === undefined) {
          delete process.env.IBCMD_USER;
        } else {
          process.env.IBCMD_USER = prevUser;
        }
        if (prevPwd === undefined) {
          delete process.env.IBCMD_PASSWORD;
        } else {
          process.env.IBCMD_PASSWORD = prevPwd;
        }
      }
    });
  });
});
