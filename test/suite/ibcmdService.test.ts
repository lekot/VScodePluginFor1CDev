import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { PassThrough } from 'stream';
import '../helpers/vscodeStubRegister';
import * as vscode from 'vscode';
import { IbcmdService } from '../../src/services/ibcmd/IbcmdService';
import { resetIbcmdServiceSingletonForTests } from '../../src/services/ibcmd/ibcmdServiceSingleton';
import { registerIbcmdInfobaseHooks } from '../../src/services/ibcmd/registerIbcmdInfobaseHooks';
import { resetVscodeTestState, vscodeTestState } from '../helpers/vscodeModuleStub';

suite('registerIbcmdInfobaseHooks ownership', () => {
  test('command registration failure rolls back the configuration listener', () => {
    const originalConfigurationRegistration = vscode.workspace.onDidChangeConfiguration;
    const originalCommandRegistration = vscode.commands.registerCommand;
    let listenerDisposeCalls = 0;
    Reflect.set(vscode.workspace, 'onDidChangeConfiguration', () => ({
      dispose: () => { listenerDisposeCalls += 1; },
    }));
    Reflect.set(vscode.commands, 'registerCommand', () => {
      throw new Error('injected ibcmd command registration failure');
    });

    try {
      assert.throws(registerIbcmdInfobaseHooks, /injected ibcmd command registration failure/u);
      assert.strictEqual(listenerDisposeCalls, 1);
    } finally {
      Reflect.set(vscode.workspace, 'onDidChangeConfiguration', originalConfigurationRegistration);
      Reflect.set(vscode.commands, 'registerCommand', originalCommandRegistration);
      resetIbcmdServiceSingletonForTests();
    }
  });
});

function fakeSpawn(
  stdoutText: string,
  onSpawn: (file: string, args: readonly string[], options: SpawnOptions) => void,
): typeof spawn {
  return ((file: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    onSpawn(file, args, options);
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
      stdout.end(stdoutText);
      stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  }) as typeof spawn;
}

suite('IbcmdService', () => {
  let savedIbcmdPath: string | undefined;
  let savedTimeout: string | undefined;
  let tempDir: string;

  setup(() => {
    resetIbcmdServiceSingletonForTests();
    resetVscodeTestState();
    savedIbcmdPath = process.env.IBCMD_PATH;
    savedTimeout = process.env.IBCMD_TIMEOUT_MS;
    delete process.env.IBCMD_PATH;
    delete process.env.IBCMD_TIMEOUT_MS;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-svc-'));
  });

  teardown(() => {
    resetIbcmdServiceSingletonForTests();
    resetVscodeTestState();
    if (savedIbcmdPath === undefined) {
      delete process.env.IBCMD_PATH;
    } else {
      process.env.IBCMD_PATH = savedIbcmdPath;
    }
    if (savedTimeout === undefined) {
      delete process.env.IBCMD_TIMEOUT_MS;
    } else {
      process.env.IBCMD_TIMEOUT_MS = savedTimeout;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('getTimeoutMs uses workspace 1cMetadataTree.ibcmd.timeout when positive', () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 88;
    const svc = new IbcmdService();
    assert.strictEqual(svc.getTimeoutMs(), 88_000);
  });

  test('getTimeoutMs uses IBCMD_TIMEOUT_MS when workspace timeouts are zero or absent', () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.timeout'] = 0;
    process.env.IBCMD_TIMEOUT_MS = '15000';
    const svc = new IbcmdService();
    assert.strictEqual(svc.getTimeoutMs(), 15_000);
  });

  test('resolveExecutablePathAsync returns notFound when configured path is missing', async () => {
    const missing = path.join(tempDir, 'missing-ibcmd');
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = missing;
    const svc = new IbcmdService();
    const r = await svc.resolveExecutablePathAsync();
    assert.strictEqual(r.kind, 'notFound');
    if (r.kind === 'notFound') {
      assert.ok(r.hint.includes('Configured path'));
    }
  });

  test('resolveExecutablePathAsync resolves via IBCMD_PATH when settings path empty', async () => {
    const exe = path.join(tempDir, 'stub-ibcmd');
    fs.writeFileSync(exe, '', 'utf-8');
    process.env.IBCMD_PATH = exe;
    const svc = new IbcmdService();
    const r = await svc.resolveExecutablePathAsync();
    assert.strictEqual(r.kind, 'resolved');
    if (r.kind === 'resolved') {
      assert.strictEqual(r.path, exe);
    }
  });

  test('re-resolves an expired positive cache entry', async () => {
    const exe = path.join(tempDir, 'vanish-ibcmd');
    fs.writeFileSync(exe, '', 'utf-8');
    process.env.IBCMD_PATH = exe;
    const svc = new IbcmdService({ positiveCacheTtlMs: 0 });
    assert.strictEqual((await svc.resolveExecutablePathAsync()).kind, 'resolved');
    fs.unlinkSync(exe);
    const r = await svc.resolveExecutablePathAsync();
    assert.strictEqual(r.kind, 'notFound');
  });

  test('invalidatePathCache forces full re-resolve on next async call', async () => {
    const exe = path.join(tempDir, 'cached-ibcmd');
    fs.writeFileSync(exe, '', 'utf-8');
    process.env.IBCMD_PATH = exe;
    const svc = new IbcmdService();
    assert.strictEqual((await svc.resolveExecutablePathAsync()).kind, 'resolved');
    svc.invalidatePathCache();
    assert.strictEqual(svc.resolveExecutablePath().kind, 'notFound');
    assert.strictEqual((await svc.resolveExecutablePathAsync()).kind, 'resolved');
  });

  test('cache-only accessor never starts discovery', () => {
    let resolveCalls = 0;
    const svc = new IbcmdService({
      resolvePath: async () => {
        resolveCalls += 1;
        return { kind: 'notFound', hint: 'missing' };
      },
    });

    assert.strictEqual(svc.resolveExecutablePath().kind, 'notFound');
    assert.strictEqual(resolveCalls, 0);
  });

  test('coalesces discovery and caches negative result without blocking event loop', async () => {
    let resolveCalls = 0;
    let eventLoopAdvanced = false;
    const svc = new IbcmdService({
      negativeCacheTtlMs: 60_000,
      resolvePath: async () => {
        resolveCalls += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return { kind: 'notFound', hint: 'missing' };
      },
    });
    setImmediate(() => {
      eventLoopAdvanced = true;
    });

    const results = await Promise.all([
      svc.resolveExecutablePathAsync(),
      svc.resolveExecutablePathAsync(),
      svc.resolveExecutablePathAsync(),
    ]);
    const cached = await svc.resolveExecutablePathAsync();

    assert.strictEqual(eventLoopAdvanced, true);
    assert.strictEqual(resolveCalls, 1);
    assert.ok(results.every((result) => result.kind === 'notFound'));
    assert.strictEqual(cached.kind, 'notFound');
  });

  test('invalidation prevents stale in-flight discovery from repopulating cache', async () => {
    let resolveFirst!: (result: { kind: 'resolved'; path: string }) => void;
    let calls = 0;
    const svc = new IbcmdService({
      resolvePath: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<{ kind: 'resolved'; path: string }>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { kind: 'resolved', path: '/new/ibcmd' };
      },
    });

    const stale = svc.resolveExecutablePathAsync();
    await new Promise<void>((resolve) => setImmediate(resolve));
    svc.invalidatePathCache();
    const fresh = await svc.resolveExecutablePathAsync();
    resolveFirst({ kind: 'resolved', path: '/old/ibcmd' });
    await stale;

    assert.strictEqual(fresh.kind, 'resolved');
    assert.deepStrictEqual(svc.resolveExecutablePath(), fresh);
  });

  test('run throws with code IBCMD_NOT_RESOLVED when path cannot be resolved', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = path.join(tempDir, 'nope');
    const svc = new IbcmdService();
    try {
      await svc.run(['--help']);
      assert.fail('expected throw');
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      assert.strictEqual(err.code, 'IBCMD_NOT_RESOLVED');
      assert.ok((err.message ?? '').includes('ibcmd path not resolved'));
    }
  });

  test('runInfobaseCreateFileDb throws IBCMD_NOT_RESOLVED when path cannot be resolved', async () => {
    vscodeTestState.workspaceConfig['1cMetadataTree.ibcmd.path'] = path.join(tempDir, 'missing-for-create');
    const svc = new IbcmdService();
    try {
      await svc.runInfobaseCreateFileDb(path.join(tempDir, 'some-db'));
      assert.fail('expected throw');
    } catch (e: unknown) {
      const err = e as { code?: string };
      assert.strictEqual(err.code, 'IBCMD_NOT_RESOLVED');
    }
  });

  test('run delegates to the shared process boundary with resolved path', async () => {
    const exe = path.join(tempDir, 'run-ibcmd');
    fs.writeFileSync(exe, '', 'utf-8');
    process.env.IBCMD_PATH = exe;
    const svc = new IbcmdService();
    const seen: string[] = [];
    const spawnImpl = fakeSpawn('done', (file, args) => {
      seen.push(file);
      seen.push(...args);
    });
    const out = await svc.run(['infobase', 'info'], { spawnImpl });
    assert.strictEqual(out.stdout, 'done');
    assert.strictEqual(seen[0], exe);
    assert.deepStrictEqual(seen.slice(1), ['infobase', 'info']);
  });

  test('runInfobaseCreateFileDb passes resolved absolute path to the shared runner', async () => {
    const exe = path.join(tempDir, 'ibcmd-infobase-create');
    fs.writeFileSync(exe, '', 'utf-8');
    process.env.IBCMD_PATH = exe;
    const svc = new IbcmdService();
    const seen: string[] = [];
    const spawnImpl = fakeSpawn('', (file, args) => {
      seen.push(file, ...args);
    });
    const rel = path.join('rel-segment', 'db-folder');
    const absExpected = path.resolve(rel);
    await svc.runInfobaseCreateFileDb(rel, { spawnImpl });
    assert.strictEqual(seen[0], exe);
    assert.deepStrictEqual(seen.slice(1), ['infobase', 'create', `--db-path=${absExpected}`]);
  });
});
