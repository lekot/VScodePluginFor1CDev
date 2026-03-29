import * as assert from 'assert';
import {
  IBCMD_EXEC_MAX_BUFFER,
  resolveIbcmdTimeoutMs,
  runIbcmdExecutable,
  type ExecFileFn,
} from '../../src/services/ibcmd/IbcmdProcessRunner';

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
    test('passes timeout, maxBuffer, windowsHide to exec implementation', async () => {
      const calls: Array<{ timeout: number; maxBuffer: number; windowsHide: boolean }> = [];
      const execImpl: ExecFileFn = async (_file, _args, options) => {
        calls.push({
          timeout: options.timeout,
          maxBuffer: options.maxBuffer,
          windowsHide: options.windowsHide,
        });
        return { stdout: 'ok', stderr: '' };
      };
      const out = await runIbcmdExecutable('/bin/ibcmd', ['a', 'b'], 7777, execImpl);
      assert.strictEqual(out.stdout, 'ok');
      assert.strictEqual(out.stderr, '');
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].timeout, 7777);
      assert.strictEqual(calls[0].maxBuffer, IBCMD_EXEC_MAX_BUFFER);
      assert.strictEqual(calls[0].windowsHide, true);
    });

    test('normalizes Buffer stdout/stderr to strings', async () => {
      const execImpl: ExecFileFn = async () => ({
        stdout: Buffer.from('out'),
        stderr: Buffer.from('err'),
      });
      const out = await runIbcmdExecutable('/x', [], 1, execImpl);
      assert.strictEqual(out.stdout, 'out');
      assert.strictEqual(out.stderr, 'err');
    });

    test('with --config= in argv passes child env without IBCMD_INFOBASE_CONFIG', async () => {
      const prev = process.env.IBCMD_INFOBASE_CONFIG;
      process.env.IBCMD_INFOBASE_CONFIG = 'C:\\other-infobase.yml';
      try {
        const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];
        const execImpl: ExecFileFn = async (_file, _args, options) => {
          calls.push({ env: options.env });
          return { stdout: '', stderr: '' };
        };
        await runIbcmdExecutable('/x', ['infobase', 'config', 'check', '--config=C:\\me.yml'], 1, execImpl);
        assert.strictEqual(calls.length, 1);
        assert.ok(calls[0].env, 'execFile should receive explicit env');
        assert.strictEqual(calls[0].env!.IBCMD_INFOBASE_CONFIG, undefined);
        assert.strictEqual(process.env.IBCMD_INFOBASE_CONFIG, 'C:\\other-infobase.yml');
      } finally {
        if (prev === undefined) {
          delete process.env.IBCMD_INFOBASE_CONFIG;
        } else {
          process.env.IBCMD_INFOBASE_CONFIG = prev;
        }
      }
    });
  });
});
