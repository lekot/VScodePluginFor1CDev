import * as assert from 'assert';
import * as path from 'path';

const W = path.win32;
import {
  resolveIbcmdPath,
  type IbcmdPathResolverDeps,
} from '../../src/services/ibcmd/IbcmdPathResolver';

suite('ibcmdPathResolver', () => {
  function makeDeps(over: Partial<IbcmdPathResolverDeps> & Pick<IbcmdPathResolverDeps, 'existsSync'>): IbcmdPathResolverDeps {
    return {
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => true }),
      env: {},
      platform: 'linux',
      findOnSystemPath: () => null,
      ...over,
    } as IbcmdPathResolverDeps;
  }

  test('prefers non-empty settings path over env when both exist', () => {
    const settings = '/cfg/ibcmd';
    const envPath = '/env/ibcmd';
    const deps = makeDeps({
      existsSync: (p: string) => p === settings,
      env: { IBCMD_PATH: envPath },
    });
    const r = resolveIbcmdPath({ settingsPath: settings, envIbcmdPath: envPath, deps });
    assert.strictEqual(r.kind, 'resolved');
    if (r.kind === 'resolved') {
      assert.strictEqual(r.path, settings);
    }
  });

  test('uses env when settings empty', () => {
    const envPath = '/env/ibcmd';
    const deps = makeDeps({
      existsSync: (p: string) => p === envPath,
      env: {},
    });
    const r = resolveIbcmdPath({ settingsPath: '', envIbcmdPath: envPath, deps });
    assert.strictEqual(r.kind, 'resolved');
    if (r.kind === 'resolved') {
      assert.strictEqual(r.path, envPath);
    }
  });

  test('whitespace-only settings falls through to env', () => {
    const envPath = '/env/ibcmd';
    const deps = makeDeps({
      existsSync: (p: string) => p === envPath,
      env: {},
    });
    const r = resolveIbcmdPath({ settingsPath: '   \t', envIbcmdPath: envPath, deps });
    assert.strictEqual(r.kind, 'resolved');
    if (r.kind === 'resolved') {
      assert.strictEqual(r.path, envPath);
    }
  });

  test('returns notFound when configured path is non-empty but missing on disk', () => {
    const missing = '/no/such/ibcmd';
    const deps = makeDeps({
      existsSync: () => false,
      env: {},
      findOnSystemPath: () => null,
    });
    const r = resolveIbcmdPath({ settingsPath: missing, envIbcmdPath: undefined, deps });
    assert.strictEqual(r.kind, 'notFound');
    if (r.kind === 'notFound') {
      assert.ok(r.hint.includes('Configured path'));
      assert.ok(r.hint.includes(missing));
    }
  });

  test('returns notFound when IBCMD_PATH is set but file does not exist', () => {
    const missing = '/no/env/ibcmd';
    const deps = makeDeps({
      existsSync: () => false,
      env: {},
      findOnSystemPath: () => null,
    });
    const r = resolveIbcmdPath({ settingsPath: '', envIbcmdPath: missing, deps });
    assert.strictEqual(r.kind, 'notFound');
    if (r.kind === 'notFound') {
      assert.ok(r.hint.includes('IBCMD_PATH'));
      assert.ok(r.hint.includes(missing));
    }
  });

  test('returns notFound when settings and env empty and autoDetect is false', () => {
    const deps = makeDeps({
      existsSync: () => false,
      env: {},
      findOnSystemPath: () => null,
    });
    const r = resolveIbcmdPath({
      settingsPath: undefined,
      envIbcmdPath: undefined,
      deps,
      autoDetect: false,
    });
    assert.strictEqual(r.kind, 'notFound');
    if (r.kind === 'notFound') {
      assert.ok(r.hint.includes('Auto-detect is disabled'));
    }
  });

  test('uses findOnSystemPath when settings and env empty', () => {
    const discovered = '/usr/bin/ibcmd';
    const deps = makeDeps({
      existsSync: (p: string) => p === discovered,
      findOnSystemPath: () => discovered,
    });
    const r = resolveIbcmdPath({ settingsPath: '  ', envIbcmdPath: undefined, deps });
    assert.strictEqual(r.kind, 'resolved');
    if (r.kind === 'resolved') {
      assert.strictEqual(r.path, discovered);
    }
  });

  test('discovers ibcmd under 1cv8/version/bin on Windows layout', () => {
    const base1cv8 = W.join('C:\\Program Files', '1cv8');
    const verDir = W.join(base1cv8, '8.3.24.1000');
    const root = W.join(verDir, 'bin', 'ibcmd.exe');
    const deps = makeDeps({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      existsSync: (p: string) => {
        if (p === base1cv8) {
          return true;
        }
        if (p === verDir) {
          return true;
        }
        return p === root;
      },
      readdirSync: (p: string) => {
        if (p === base1cv8) {
          return ['8.3.24.1000'];
        }
        return [];
      },
      statSync: () => ({ isDirectory: () => true }),
      findOnSystemPath: () => null,
    });
    const r = resolveIbcmdPath({ settingsPath: undefined, envIbcmdPath: undefined, deps });
    assert.strictEqual(r.kind, 'resolved');
    if (r.kind === 'resolved') {
      assert.strictEqual(r.path, root);
    }
  });
});
