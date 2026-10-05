import * as assert from 'assert';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as path from 'path';
import {
  NativeTestClientLaunchError,
  NativeTestClientLifecycleService,
  resolveTestClientExecutable,
  type NativeTestClientChild,
} from '../../src/services/forms/nativeTestClientLifecycle';
import { NativeScreenshotError } from '../../src/services/forms/nativeScreenshot';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';

function fileEntry(): InfobaseEntry {
  return {
    id: 'file-1',
    name: 'Test base',
    type: 'file',
    filePath: 'C:\\bases\\test',
    hasStoredPassword: false,
    createdAt: '2026-10-05T00:00:00.000Z',
  };
}

class FakeChild extends EventEmitter implements NativeTestClientChild {
  killed = false;

  constructor(readonly pid: number, private readonly exitsOnKill = true) {
    super();
  }

  kill(): boolean {
    this.killed = true;
    if (this.exitsOnKill) {
      this.emit('exit');
    }
    return true;
  }
}

function expectLaunchError(code: string, inspect?: (error: NativeTestClientLaunchError) => void) {
  return (error: unknown): boolean => {
    if (!(error instanceof NativeTestClientLaunchError) || error.code !== code) {return false;}
    inspect?.(error);
    return true;
  };
}

suite('Native TestClient lifecycle service', () => {
  test('uses the discovery timeout and preserves timeout errors instead of returning an empty list', async () => {
    let receivedTimeout = 0;
    const service = new NativeTestClientLifecycleService({
      platform: 'win32',
      discoverTestClients: async (timeout) => {
        receivedTimeout = timeout;
        throw new NativeScreenshotError('NATIVE_SCREENSHOT_TIMEOUT', 'PowerShell discovery timed out.');
      },
    });

    await assert.rejects(
      service.discover(),
      expectLaunchError('NATIVE_SCREENSHOT_TIMEOUT', (failure) => {
        assert.match(failure.message, /PowerShell discovery timed out/);
      }),
    );
    assert.strictEqual(receivedTimeout, 15_000);
  });

  test('resolves an explicitly configured thick executable to its sibling thin client', () => {
    const files = new Set([
      'C:\\1C\\8.3.27.1859\\bin\\1cv8.exe',
      'C:\\1C\\8.3.27.1859\\bin\\1cv8c.exe',
    ]);
    const resolved = resolveTestClientExecutable({
      configuredPlatformPath: 'C:\\1C\\8.3.27.1859\\bin\\1cv8.exe',
    }, {
      platform: 'win32',
      existsSync: (candidate) => files.has(candidate),
      statSync: () => ({ isDirectory: () => false }),
    });

    assert.deepStrictEqual(resolved, {
      exe: 'C:\\1C\\8.3.27.1859\\bin\\1cv8c.exe',
      platformVersion: '8.3.27.1859',
    });
  });

  test('prefers the configured path and fails when it has no thin executable', () => {
    let discoveryCalls = 0;
    const request = { configuredPlatformPath: 'C:\\custom\\bin\\1cv8.exe' };
    const dependencies = {
      platform: 'win32' as NodeJS.Platform,
      existsSync: (candidate: string) => candidate === request.configuredPlatformPath,
      statSync: () => ({ isDirectory: () => false }),
      discoverInstalls: () => { discoveryCalls++; return []; },
    };

    assert.throws(
      () => resolveTestClientExecutable(request, dependencies),
      expectLaunchError('TESTCLIENT_PLATFORM_NOT_FOUND'),
    );
    assert.strictEqual(discoveryCalls, 0, 'an invalid explicit setting must not silently select another version');
  });

  test('selects the newest installed thin client and uses the preferred bitness', () => {
    const installs = [
      { version: '8.3.27.1859', bitness: '32' as const, thickExe: 'old32', thinExe: 'new32' },
      { version: '8.3.27.1859', bitness: '64' as const, thickExe: 'old64', thinExe: 'new64' },
      { version: '8.3.26.1000', bitness: '64' as const, thickExe: 'prior64', thinExe: 'priorThin64' },
    ];
    const resolved = resolveTestClientExecutable({}, {
      platform: 'win32',
      arch: 'x64',
      existsSync: () => true,
      discoverInstalls: () => installs,
    });
    assert.deepStrictEqual(resolved, { exe: 'new64', platformVersion: '8.3.27.1859' });
  });

  test('fails closed when multiple newest installs remain equally preferred', () => {
    const installs = [
      { version: '8.3.27.1859', bitness: '64' as const, thickExe: 'one', thinExe: 'one-thin' },
      { version: '8.3.27.1859', bitness: '64' as const, thickExe: 'two', thinExe: 'two-thin' },
    ];
    assert.throws(
      () => resolveTestClientExecutable({}, {
        platform: 'win32',
        arch: 'x64',
        existsSync: () => true,
        discoverInstalls: () => installs,
      }),
      expectLaunchError('TESTCLIENT_PLATFORM_AMBIGUOUS'),
    );
  });

  test('validates a file database marker and server identity before port allocation or spawn', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'testclient-lifecycle-'));
    let allocations = 0;
    let spawns = 0;
    const service = new NativeTestClientLifecycleService({
      platform: 'win32',
      resolveExecutable: () => ({ exe: 'thin.exe', platformVersion: '8.3.27.1859' }),
      isPortAvailable: async () => { allocations++; return 1842; },
      spawnProcess: () => { spawns++; return new FakeChild(8420); },
    });
    try {
      await assert.rejects(
        service.start({ entry: { ...fileEntry(), filePath: directory } }),
        expectLaunchError('TESTCLIENT_INVALID_INFOBASE', (failure) => {
          assert.match(failure.message, /1Cv8\.1CD/);
        }),
      );
      await assert.rejects(
        service.start({ entry: { ...fileEntry(), type: 'server', filePath: undefined } }),
        expectLaunchError('TESTCLIENT_INVALID_INFOBASE', (failure) => {
          assert.match(failure.message, /server и database/);
        }),
      );
      assert.strictEqual(allocations, 0);
      assert.strictEqual(spawns, 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('starts the thin client without a shell and waits for the same PID and port', async () => {
    const child = new FakeChild(8421);
    let received: { exe: string; args: string[] } | undefined;
    let receivedDiscovery: { timeout: number; signal?: AbortSignal; port?: number } | undefined;
    let discoverCalls = 0;
    const service = new NativeTestClientLifecycleService({
      platform: 'win32',
      validateInfobase: () => undefined,
      resolveExecutable: () => ({ exe: 'C:\\1C\\bin\\1cv8c.exe', platformVersion: '8.3.27.1859' }),
      isPortAvailable: async (requested) => requested ?? 1843,
      spawnProcess: (exe, args) => { received = { exe, args }; return child; },
      discoverPortOwners: async (timeout, signal, port) => {
        receivedDiscovery = { timeout, signal, port };
        discoverCalls++;
        return [{ pid: child.pid!, port: 1843, testClient: true }];
      },
    });

    const handle = await service.start({ entry: fileEntry(), port: 1843 });

    assert.deepStrictEqual(handle, {
      child,
      pid: 8421,
      port: 1843,
      platformVersion: '8.3.27.1859',
    });
    assert.strictEqual(received?.exe, 'C:\\1C\\bin\\1cv8c.exe');
    assert.deepStrictEqual(received?.args.slice(-3), ['/TestClient', '-TPort', '1843']);
    assert.deepStrictEqual(receivedDiscovery, { timeout: 15_000, signal: undefined, port: 1843 });
    assert.ok(discoverCalls >= 1);
    assert.strictEqual(child.killed, false);
  });

  test('rejects a port collision before spawning a process', async () => {
    let spawnCalls = 0;
    const error = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    const service = new NativeTestClientLifecycleService({
      platform: 'win32',
      validateInfobase: () => undefined,
      resolveExecutable: () => ({ exe: 'thin.exe', platformVersion: '8.3.27.1859' }),
      isPortAvailable: async () => { throw error; },
      spawnProcess: () => { spawnCalls++; return new FakeChild(8421); },
    });

    await assert.rejects(
      service.start({ entry: fileEntry(), port: 1843 }),
      expectLaunchError('TESTCLIENT_PORT_IN_USE', (failure) => {
        assert.strictEqual(failure.port, 1843);
        assert.strictEqual(failure.pid, undefined);
      }),
    );
    assert.strictEqual(spawnCalls, 0);
  });

  test('fails quickly when another process wins the port after the initial availability check', async () => {
    const child = new FakeChild(8424);
    let now = 0;
    const service = new NativeTestClientLifecycleService({
      platform: 'win32',
      validateInfobase: () => undefined,
      resolveExecutable: () => ({ exe: 'thin.exe', platformVersion: '8.3.27.1859' }),
      isPortAvailable: async () => 1846,
      spawnProcess: () => child,
      discoverPortOwners: async () => [{ pid: 9921, port: 1846, testClient: false }],
      isProcessRunning: () => false,
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds; },
    });

    await assert.rejects(
      service.start({ entry: fileEntry(), waitTimeoutMs: 60_000 }),
      expectLaunchError('TESTCLIENT_PORT_COLLISION', (failure) => {
        assert.strictEqual(failure.pid, 8424);
        assert.strictEqual(failure.port, 1846);
        assert.strictEqual(failure.processStatus, 'stopped');
      }),
    );
    assert.strictEqual(now, 0, 'foreign listener is detected before the readiness timeout');
    assert.strictEqual(child.killed, true);
  });

  test('times out with PID/port and confirms cleanup of the spawned process', async () => {
    const child = new FakeChild(8422);
    let now = 0;
    const service = new NativeTestClientLifecycleService({
      platform: 'win32',
      validateInfobase: () => undefined,
      resolveExecutable: () => ({ exe: 'thin.exe', platformVersion: '8.3.27.1859' }),
      isPortAvailable: async () => 1844,
      spawnProcess: () => child,
      discoverPortOwners: async () => [],
      isProcessRunning: () => false,
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds; },
    });

    await assert.rejects(
      service.start({ entry: fileEntry(), waitTimeoutMs: 1_000 }),
      expectLaunchError('TESTCLIENT_LAUNCH_TIMEOUT', (failure) => {
        assert.strictEqual(failure.pid, 8422);
        assert.strictEqual(failure.port, 1844);
        assert.strictEqual(failure.processStatus, 'stopped');
        assert.match(failure.message, /остановлен/);
      }),
    );
    assert.strictEqual(child.killed, true);
  });

  test('reports cancellation and retains PID/port when process cleanup cannot be confirmed', async () => {
    const child = new FakeChild(8423, false);
    const controller = new AbortController();
    let now = 0;
    const service = new NativeTestClientLifecycleService({
      platform: 'win32',
      validateInfobase: () => undefined,
      resolveExecutable: () => ({ exe: 'thin.exe', platformVersion: '8.3.27.1859' }),
      isPortAvailable: async () => 1845,
      spawnProcess: () => child,
      discoverPortOwners: async () => { controller.abort(); return []; },
      isProcessRunning: () => true,
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds; },
    });

    await assert.rejects(
      service.start({ entry: fileEntry(), waitTimeoutMs: 1_000 }, controller.signal),
      expectLaunchError('REQUEST_CANCELLED', (failure) => {
        assert.strictEqual(failure.pid, 8423);
        assert.strictEqual(failure.port, 1845);
        assert.strictEqual(failure.processStatus, 'unknown');
        assert.match(failure.message, /PID 8423, порт 1845/);
      }),
    );
    assert.strictEqual(child.killed, true);
  });
});
