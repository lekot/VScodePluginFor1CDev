import * as assert from 'assert';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess, SpawnOptions } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import {
  captureNativeTestClientScreenshotWithDependencies,
  discoverNativeTestClientsWithDependencies,
  inspectNativeTestClientPortOwnersWithDependencies,
  isLocalNativeTestClientHost,
  NativeScreenshotError,
  NativeScreenshotDependencies,
  NativeScreenshotDiscovery,
  NativeScreenshotWindow,
  resolveTestClientProcess,
  selectTestClientAnchor,
  selectTestClientCaptureLayers,
} from '../../src/services/forms/nativeScreenshot';
import type { ProcessTreeTerminationOutcome } from '../../src/services/ibcmd/processTreeTermination';

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

interface FakePowerShellChild {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  process: ChildProcess;
  close(code: number | null): void;
}

function createPowerShellSpawn(
  onInput: (script: string, child: FakePowerShellChild, call: number) => void,
  terminationOutcome?: ProcessTreeTerminationOutcome,
) {
  const children: FakePowerShellChild[] = [];
  const spawnOptions: SpawnOptions[] = [];
  const scripts: string[] = [];
  let terminationCalls = 0;
  const spawnImpl = ((
    _command: string,
    _args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess => {
    spawnOptions.push(options);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const process = new EventEmitter() as ChildProcess;
    Object.assign(process, {
      stdin,
      stdout,
      stderr,
      pid: 43210 + children.length,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: () => true,
    });
    let script = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => { script += chunk; });
    const fake: FakePowerShellChild = {
      stdin,
      stdout,
      stderr,
      process,
      close: (code) => {
        Object.assign(process, { exitCode: code });
        process.emit('close', code, null);
      },
    };
    const call = children.length;
    children.push(fake);
    stdin.once('finish', () => {
      scripts.push(script);
      onInput(script, fake, call);
    });
    setImmediate(() => process.emit('spawn'));
    return process;
  }) as unknown as typeof import('child_process').spawn;
  const terminateProcessTreeImpl = async (): Promise<ProcessTreeTerminationOutcome> => {
    terminationCalls++;
    return terminationOutcome ?? {
      terminated: true,
      hardKillUsed: false,
      survivingPids: [],
      errors: [],
    };
  };
  return {
    spawnImpl,
    terminateProcessTreeImpl,
    children,
    spawnOptions,
    scripts,
    getTerminationCalls: () => terminationCalls,
  };
}

async function withUnavailablePowerShell<T>(run: () => Promise<T>): Promise<T> {
  const previousSystemRoot = process.env.SystemRoot;
  process.env.SystemRoot = path.join(os.tmpdir(), 'missing-powershell-for-native-screenshot-tests');
  try {
    return await run();
  } finally {
    if (previousSystemRoot === undefined) {
      delete process.env.SystemRoot;
    } else {
      process.env.SystemRoot = previousSystemRoot;
    }
  }
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

  test('streams the PowerShell script through stdin and parses complete JSON beyond the diagnostic ring limit', async () => {
    const file = path.join(os.tmpdir(), 'native-testclient-large-json.png');
    const first = JSON.stringify({
      ok: true,
      ...discovery({ windows: [windowRecord({ foreground: true })] }),
      diagnosticPadding: 'я'.repeat(220_000),
    });
    const second = JSON.stringify({ ok: true, width: 800, height: 600 });
    const fake = createPowerShellSpawn((_script, child, call) => {
      const bytes = Buffer.from(call === 0 ? first : second, 'utf8');
      const russian = bytes.indexOf(Buffer.from('я', 'utf8'));
      const splitAt = russian >= 0 ? russian + 1 : 1;
      child.stdout.write(bytes.subarray(0, splitAt));
      child.stdout.write(bytes.subarray(splitAt));
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.close(0));
    });
    const dependencies = {
      platform: 'win32',
      spawnImpl: fake.spawnImpl,
      terminateProcessTreeImpl: fake.terminateProcessTreeImpl,
    } as unknown as NativeScreenshotDependencies;

    await withUnavailablePowerShell(async () => {
      const result = await captureNativeTestClientScreenshotWithDependencies(
        { host: '127.0.0.1', port: PORT, file, timeoutMs: 5_000 },
        dependencies,
      );
      assert.deepStrictEqual(result, { file: path.resolve(file), width: 800, height: 600 });
    });

    assert.strictEqual(fake.scripts.length, 2, 'both PowerShell scripts are sent via stdin');
    assert.match(fake.scripts[0], /Get-NetTCPConnection -LocalPort/);
    assert.match(fake.scripts[1], /PrintWindow/);
    assert.ok(fake.spawnOptions.every((options) => JSON.stringify(options.stdio) === JSON.stringify(['pipe', 'pipe', 'pipe'])));
    assert.strictEqual(fake.getTerminationCalls(), 0);
  });

  test('terminates the shared process tree and rejects stdout exceeding the complete-response limit', async () => {
    const fake = createPowerShellSpawn((_script, child) => {
      const chunk = Buffer.alloc(32 * 1024, 0x61);
      for (let sent = 0; sent < 2 * 1024 * 1024 + 1; sent += chunk.length) {
        child.stdout.write(chunk);
      }
      child.stdout.end();
      child.stderr.end();
    });
    const dependencies = {
      platform: 'win32',
      spawnImpl: fake.spawnImpl,
      terminateProcessTreeImpl: fake.terminateProcessTreeImpl,
    } as unknown as NativeScreenshotDependencies;

    await withUnavailablePowerShell(() => assert.rejects(
      captureNativeTestClientScreenshotWithDependencies(
        { host: '127.0.0.1', port: PORT, file: 'shot.png', timeoutMs: 5_000 },
        dependencies,
      ),
      expectNativeError('NATIVE_SCREENSHOT_OUTPUT_TOO_LARGE'),
    ));
    assert.strictEqual(fake.getTerminationCalls(), 1);
    assert.strictEqual(fake.scripts.length, 1, 'truncated discovery output is never parsed or followed by capture');
  });

  test('applies the complete-response limit independently to stderr', async () => {
    const fake = createPowerShellSpawn((_script, child) => {
      const chunk = Buffer.alloc(32 * 1024, 0x65);
      for (let sent = 0; sent < 2 * 1024 * 1024 + 1; sent += chunk.length) {
        child.stderr.write(chunk);
      }
      child.stdout.end();
      child.stderr.end();
    });
    const dependencies = {
      platform: 'win32',
      spawnImpl: fake.spawnImpl,
      terminateProcessTreeImpl: fake.terminateProcessTreeImpl,
    } as unknown as NativeScreenshotDependencies;

    await withUnavailablePowerShell(() => assert.rejects(
      captureNativeTestClientScreenshotWithDependencies(
        { host: '127.0.0.1', port: PORT, file: 'shot.png', timeoutMs: 5_000 },
        dependencies,
      ),
      expectNativeError('NATIVE_SCREENSHOT_OUTPUT_TOO_LARGE'),
    ));
    assert.strictEqual(fake.getTerminationCalls(), 1);
    assert.strictEqual(fake.scripts.length, 1, 'oversized diagnostics prevent following any parsed response');
  });

  test('reports typed inDoubt when oversized output cannot confirm process-tree termination', async () => {
    const terminationFailure: ProcessTreeTerminationOutcome = {
      terminated: false,
      hardKillUsed: true,
      survivingPids: [43210],
      errors: ['PowerShell child survived termination'],
    };
    const fake = createPowerShellSpawn((_script, child) => {
      const chunk = Buffer.alloc(32 * 1024, 0x61);
      for (let sent = 0; sent < 2 * 1024 * 1024 + 1; sent += chunk.length) {
        child.stdout.write(chunk);
      }
      child.stdout.end();
      child.stderr.end();
    }, terminationFailure);
    const dependencies = {
      platform: 'win32',
      spawnImpl: fake.spawnImpl,
      terminateProcessTreeImpl: fake.terminateProcessTreeImpl,
    } as unknown as NativeScreenshotDependencies;
    let observed: NativeScreenshotError | undefined;

    await withUnavailablePowerShell(() => assert.rejects(
      captureNativeTestClientScreenshotWithDependencies(
        { host: '127.0.0.1', port: PORT, file: 'shot.png', timeoutMs: 5_000 },
        dependencies,
      ),
      (error: unknown) => {
        observed = error instanceof NativeScreenshotError ? error : undefined;
        const inDoubt = (observed as (NativeScreenshotError & { inDoubt?: boolean }) | undefined)?.inDoubt;
        return observed?.code === 'PROCESS_TREE_TERMINATION_FAILED'
          && inDoubt === true
          && observed.processOutcome?.spawnErrorCode === 'PROCESS_TREE_TERMINATION_FAILED';
      },
    ));
    assert.strictEqual(fake.getTerminationCalls(), 1);
    assert.deepStrictEqual(observed?.processOutcome?.termination?.survivingPids, [43210]);
    assert.match(observed?.message ?? '', /слишком большой ответ/);
  });

  test('routes stdin write errors through shared tree termination and preserves a typed domain error', async () => {
    const fake = createPowerShellSpawn((_script, child) => {
      setImmediate(() => {
        const error = Object.assign(new Error('pipe closed'), { code: 'EPIPE' });
        child.stdin.emit('error', error);
      });
    });
    const dependencies = {
      platform: 'win32',
      spawnImpl: fake.spawnImpl,
      terminateProcessTreeImpl: fake.terminateProcessTreeImpl,
    } as unknown as NativeScreenshotDependencies;
    let observed: NativeScreenshotError | undefined;

    await withUnavailablePowerShell(() => assert.rejects(
      captureNativeTestClientScreenshotWithDependencies(
        { host: '127.0.0.1', port: PORT, file: 'shot.png', timeoutMs: 5_000 },
        dependencies,
      ),
      (error: unknown) => {
        observed = error instanceof NativeScreenshotError ? error : undefined;
        return observed?.code === 'NATIVE_SCREENSHOT_FAILED'
          && observed.message.includes('pipe closed')
          && observed.processOutcome?.stdinErrorCode === 'EPIPE';
      },
    ));
    assert.strictEqual(fake.getTerminationCalls(), 1);
    assert.strictEqual(fake.scripts.length, 1);
  });

  test('uses shared process-tree termination for cancellation after PowerShell starts', async () => {
    const fake = createPowerShellSpawn(() => undefined);
    const dependencies = {
      platform: 'win32',
      spawnImpl: fake.spawnImpl,
      terminateProcessTreeImpl: fake.terminateProcessTreeImpl,
    } as unknown as NativeScreenshotDependencies;
    const controller = new AbortController();

    const pending = withUnavailablePowerShell(() => captureNativeTestClientScreenshotWithDependencies(
      { host: '127.0.0.1', port: PORT, file: 'shot.png', timeoutMs: 5_000, signal: controller.signal },
      dependencies,
    ));
    const rejection = assert.rejects(pending, expectNativeError('NATIVE_SCREENSHOT_CANCELLED'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await rejection;
    assert.strictEqual(fake.getTerminationCalls(), 1);
    assert.strictEqual(fake.scripts.length, 1);
  });

  test('timeout uses common termination and retains failed tree cleanup details', async () => {
    const failure: ProcessTreeTerminationOutcome = {
      terminated: false,
      hardKillUsed: true,
      survivingPids: [43210],
      errors: ['child survived termination'],
    };
    const fake = createPowerShellSpawn(() => undefined, failure);
    const dependencies = {
      platform: 'win32',
      spawnImpl: fake.spawnImpl,
      terminateProcessTreeImpl: fake.terminateProcessTreeImpl,
    } as unknown as NativeScreenshotDependencies;
    let observed: NativeScreenshotError | undefined;

    await withUnavailablePowerShell(() => assert.rejects(
      captureNativeTestClientScreenshotWithDependencies(
        { host: '127.0.0.1', port: PORT, file: 'shot.png', timeoutMs: 20 },
        dependencies,
      ),
      (error: unknown) => {
        observed = error instanceof NativeScreenshotError ? error : undefined;
        return observed?.code === 'PROCESS_TREE_TERMINATION_FAILED'
          && observed.inDoubt
          && observed.processOutcome?.timedOut === true;
      },
    ));
    assert.strictEqual(fake.getTerminationCalls(), 1);
    assert.deepStrictEqual(observed?.processOutcome?.termination?.survivingPids, [43210]);
  });

  test('timeout with confirmed process-tree termination remains a typed timeout', async () => {
    const fake = createPowerShellSpawn(() => undefined);
    const dependencies = {
      platform: 'win32',
      spawnImpl: fake.spawnImpl,
      terminateProcessTreeImpl: fake.terminateProcessTreeImpl,
    } as unknown as NativeScreenshotDependencies;
    let observed: NativeScreenshotError | undefined;

    await withUnavailablePowerShell(() => assert.rejects(
      captureNativeTestClientScreenshotWithDependencies(
        { host: '127.0.0.1', port: PORT, file: 'shot.png', timeoutMs: 20 },
        dependencies,
      ),
      (error: unknown) => {
        observed = error instanceof NativeScreenshotError ? error : undefined;
        return observed?.code === 'NATIVE_SCREENSHOT_TIMEOUT'
          && observed.processOutcome?.timedOut === true
          && observed.inDoubt === false;
      },
    ));
    assert.strictEqual(fake.getTerminationCalls(), 1);
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
