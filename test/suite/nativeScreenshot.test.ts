import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import {
  captureNativeTestClientScreenshotWithDependencies,
  discoverNativeTestClientsWithDependencies,
  inspectNativeTestClientPortOwnersWithDependencies,
  isLocalNativeTestClientHost,
  NativeScreenshotError,
  NativeScreenshotDiscovery,
  NativeScreenshotWindow,
  resolveTestClientProcess,
  selectTestClientAnchor,
  selectTestClientCaptureLayers,
} from '../../src/services/forms/nativeScreenshot';

const PORT = 23456;
const PID = 4312;

function processRecord(overrides: Partial<NativeScreenshotDiscovery['processes'][number]> = {}) {
  return {
    pid: PID,
    name: '1cv8c.exe',
    commandLine: `"C:\\Program Files\\1cv8\\1cv8c.exe" /TESTCLIENT -TPort ${PORT}`,
    createdTicks: '638953200000000000',
    ...overrides,
  };
}

function windowRecord(overrides: Partial<NativeScreenshotWindow> = {}): NativeScreenshotWindow {
  return {
    hwnd: '100',
    pid: PID,
    threadId: 71,
    visible: true,
    minimized: false,
    cloaked: false,
    rootOwner: '100',
    owner: '0',
    zOrder: 4,
    active: false,
    foreground: false,
    rect: { left: 10, top: 20, right: 810, bottom: 620 },
    ...overrides,
  };
}

function discovery(overrides: Partial<NativeScreenshotDiscovery> = {}): NativeScreenshotDiscovery {
  return {
    listenerPids: [PID],
    processes: [processRecord()],
    windows: [windowRecord()],
    ...overrides,
  };
}

function expectNativeError(code: string) {
  return (error: unknown): boolean => error instanceof NativeScreenshotError && error.code === code;
}

suite('Native TestClient screenshot adapter', () => {
  test('discovers only PID/port pairs whose executable and command line match the listening TestClient port', async () => {
    const output = {
      ok: true,
      listenerPorts: [
        { pid: PID, port: PORT },
        { pid: PID, port: PORT + 1 },
        { pid: PID + 1, port: PORT + 2 },
      ],
      processes: [
        processRecord({ commandLine: `1cv8c.exe /TESTCLIENT -TPort ${PORT} /N"user" /P"secret-value"` }),
        { ...processRecord({ pid: PID + 1, name: 'other.exe' }), commandLine: `other.exe /TESTCLIENT -TPort ${PORT + 2}` },
      ],
    };
    let script = '';
    const result = await discoverNativeTestClientsWithDependencies(4_000, {
      platform: 'win32',
      runPowerShell: async (captured) => {
        script = captured;
        return JSON.stringify(output);
      },
    });

    assert.deepStrictEqual(result, [{ pid: PID, port: PORT }]);
    assert.doesNotMatch(JSON.stringify(result), /commandLine|secret-value/);
    assert.match(script, /Get-NetTCPConnection -State Listen/);
    assert.match(script, /Get-CimInstance -ClassName Win32_Process -Filter "Name = '1cv8c\.exe' OR Name = '1cv8\.exe'"/);
    assert.strictEqual((script.match(/Get-CimInstance/g) ?? []).length, 1, 'process metadata is fetched once, not once per listening PID');
    assert.doesNotMatch(script, /ProcessId = \$targetPid/);
  });

  test('readiness discovery queries only its requested listener port', async () => {
    let script = '';
    const result = await inspectNativeTestClientPortOwnersWithDependencies(4_000, {
      platform: 'win32',
      runPowerShell: async (captured) => {
        script = captured;
        return JSON.stringify({ ok: true, listenerPorts: [{ pid: PID, port: PORT }], processes: [processRecord()] });
      },
    }, undefined, PORT);

    assert.deepStrictEqual(result, [{ pid: PID, port: PORT, testClient: true, createdTicks: '638953200000000000' }]);
    assert.match(script, new RegExp(`Get-NetTCPConnection -LocalPort ${PORT} -State Listen`));
    assert.doesNotMatch(script, /Get-NetTCPConnection -State Listen/);
  });

  test('TestClient discovery is Windows-only and rejects malformed process inventory', async () => {
    let calls = 0;
    await assert.rejects(
      discoverNativeTestClientsWithDependencies(1_000, {
        platform: 'linux',
        runPowerShell: async () => { calls++; return ''; },
      }),
      expectNativeError('NATIVE_TESTCLIENT_UNSUPPORTED_PLATFORM'),
    );
    await assert.rejects(
      discoverNativeTestClientsWithDependencies(1_000, {
        platform: 'win32',
        runPowerShell: async () => JSON.stringify({ ok: true, listenerPorts: [], processes: {} }),
      }),
      expectNativeError('NATIVE_SCREENSHOT_INVALID_RESPONSE'),
    );
    assert.strictEqual(calls, 0);
  });

  test('allows only explicit loopback hosts', () => {
    assert.strictEqual(isLocalNativeTestClientHost('localhost'), true);
    assert.strictEqual(isLocalNativeTestClientHost('127.12.0.8'), true);
    assert.strictEqual(isLocalNativeTestClientHost('::1'), true);
    assert.strictEqual(isLocalNativeTestClientHost('192.168.1.10'), false);
    assert.strictEqual(isLocalNativeTestClientHost('0.0.0.0'), false);
    assert.strictEqual(isLocalNativeTestClientHost('localhost.attacker.example'), false);
  });

  test('validates the exact listener PID, executable, TestClient switch, and port', () => {
    const target = resolveTestClientProcess(discovery({
      listenerPids: [PID, PID],
      processes: [processRecord({ commandLine: `1cv8c.exe /TESTCLIENT -TPort=${PORT}` })],
    }), PORT);
    assert.strictEqual(target.pid, PID);

    assert.throws(
      () => resolveTestClientProcess(discovery({ processes: [processRecord({ commandLine: `1cv8c.exe /TESTCLIENT -TPort ${PORT + 1}` })] }), PORT),
      expectNativeError('NATIVE_SCREENSHOT_CLIENT_NOT_FOUND'),
    );
    assert.throws(
      () => resolveTestClientProcess(discovery({ processes: [processRecord({ name: 'other.exe' })] }), PORT),
      expectNativeError('NATIVE_SCREENSHOT_CLIENT_NOT_FOUND'),
    );
  });

  test('reports missing and ambiguous listeners instead of guessing a process', () => {
    assert.throws(
      () => resolveTestClientProcess(discovery({ listenerPids: [] }), PORT),
      expectNativeError('NATIVE_SCREENSHOT_CLIENT_NOT_FOUND'),
    );
    assert.throws(
      () => resolveTestClientProcess(discovery({ listenerPids: [PID, PID + 1] }), PORT),
      expectNativeError('NATIVE_SCREENSHOT_CLIENT_AMBIGUOUS'),
    );
  });

  test('selects a visible active window by PID and GUI state, not its title', () => {
    const main = windowRecord({ hwnd: '100', rootOwner: '100', active: false, foreground: false });
    const popup = windowRecord({ hwnd: '200', rootOwner: '100', owner: '100', zOrder: 1, active: true, foreground: true });
    const foreign = windowRecord({ hwnd: '300', pid: PID + 1, foreground: true, active: true });
    assert.strictEqual(selectTestClientAnchor([foreign, popup, main], PID), main);
  });

  test('reports no-window, minimized, and ambiguous window states clearly', () => {
    assert.throws(() => selectTestClientAnchor([], PID), expectNativeError('NATIVE_SCREENSHOT_WINDOW_NOT_FOUND'));
    assert.throws(
      () => selectTestClientAnchor([windowRecord({ minimized: true })], PID),
      expectNativeError('NATIVE_SCREENSHOT_WINDOW_MINIMIZED'),
    );
    assert.throws(
      () => selectTestClientAnchor([
        windowRecord({ hwnd: '100', rootOwner: '100', foreground: true }),
        windowRecord({ hwnd: '200', rootOwner: '200', zOrder: 1, foreground: true }),
      ], PID),
      expectNativeError('NATIVE_SCREENSHOT_WINDOW_AMBIGUOUS'),
    );
  });

  test('includes relevant same-process popup layers and excludes unrelated windows', () => {
    const anchor = windowRecord({ hwnd: '100', rootOwner: '100', zOrder: 5 });
    const popup = windowRecord({
      hwnd: '200', rootOwner: '100', owner: '100', zOrder: 1,
      rect: { left: 650, top: 100, right: 900, bottom: 320 },
    });
    const unrelated = windowRecord({ hwnd: '300', rootOwner: '300', zOrder: 2, rect: { left: 2000, top: 100, right: 2200, bottom: 300 } });
    const foreign = windowRecord({ hwnd: '400', pid: PID + 1, rootOwner: '100', zOrder: 0 });
    assert.deepStrictEqual(selectTestClientCaptureLayers([anchor, popup, unrelated, foreign], anchor).map((item) => item.hwnd), ['100', '200']);
  });

  test('validates platform and remote host before launching PowerShell', async () => {
    let launches = 0;
    const runPowerShell = async () => { launches++; return ''; };
    await assert.rejects(
      captureNativeTestClientScreenshotWithDependencies(
        { host: '192.168.1.10', port: PORT, file: 'shot.png' },
        { platform: 'win32', runPowerShell },
      ),
      expectNativeError('NATIVE_SCREENSHOT_LOCAL_ONLY'),
    );
    await assert.rejects(
      captureNativeTestClientScreenshotWithDependencies(
        { host: '127.0.0.1', port: PORT, file: 'shot.png' },
        { platform: 'linux', runPowerShell },
      ),
      expectNativeError('NATIVE_SCREENSHOT_UNSUPPORTED_PLATFORM'),
    );
    assert.strictEqual(launches, 0);
  });

  test('runs bounded discovery and capture, returning the atomically written PNG path and dimensions', async () => {
    const file = path.join(os.tmpdir(), 'native-testclient-shot.png');
    const calls: Array<{ script: string; timeout: number }> = [];
    const runPowerShell = async (script: string, timeout: number): Promise<string> => {
      calls.push({ script, timeout });
      return calls.length === 1
        ? JSON.stringify({ ok: true, ...discovery({ windows: [windowRecord({ foreground: true })] }) })
        : JSON.stringify({ ok: true, width: 800, height: 600 });
    };
    const result = await captureNativeTestClientScreenshotWithDependencies(
      { host: '127.0.0.1', port: PORT, file, timeoutMs: 5_000 },
      { platform: 'win32', runPowerShell },
    );
    assert.deepStrictEqual(result, { file: path.resolve(file), width: 800, height: 600 });
    assert.strictEqual(calls.length, 2);
    assert.ok(calls.every((call) => call.timeout > 0 && call.timeout <= 5_000));
    assert.match(calls[0].script, /Get-NetTCPConnection -LocalPort/);
    assert.match(calls[1].script, /PrintWindow/);
    assert.match(calls[1].script, /BitBlt/);
    assert.match(calls[1].script, /\[Console\]::OutputEncoding/);
    assert.match(calls[1].script, /\[Console\]::SetError/);
    assert.doesNotMatch(calls[1].script, /SetForegroundWindow|ShowWindow\s*\(/);
  });

  test('preserves UTF-8 Windows error messages and error codes', async () => {
    let calls = 0;
    const message = 'Окно TestClient переместилось во время снимка.';
    await assert.rejects(
      captureNativeTestClientScreenshotWithDependencies(
        { host: '127.0.0.1', port: PORT, file: 'shot.png' },
        {
          platform: 'win32',
          runPowerShell: async () => {
            calls++;
            return calls === 1
              ? JSON.stringify({ ok: true, ...discovery() })
              : JSON.stringify({ ok: false, code: 'NATIVE_SCREENSHOT_WINDOW_CHANGED', error: message });
          },
        },
      ),
      (error: unknown) => error instanceof NativeScreenshotError
        && error.code === 'NATIVE_SCREENSHOT_WINDOW_CHANGED'
        && error.message === message,
    );
  });

  test('honors cancellation before making an operating-system call', async () => {
    const controller = new AbortController();
    controller.abort();
    let launches = 0;
    await assert.rejects(
      captureNativeTestClientScreenshotWithDependencies(
        { host: 'localhost', port: PORT, file: 'shot.png', signal: controller.signal },
        { platform: 'win32', runPowerShell: async () => { launches++; return ''; } },
      ),
      expectNativeError('NATIVE_SCREENSHOT_CANCELLED'),
    );
    assert.strictEqual(launches, 0);
  });
});
