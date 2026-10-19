/**
 * Regression tests for `test/matrix/ibcmdAdapter.ts` (container matrix / instrument-smoke path),
 * separate from `src/services/ibcmdConfigCheckGate.ts` used by the extension.
 */
import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import type { NativeFormsAction, NativeFormsActionResult } from '../../src/agent/agentFormsTypes';
import type {
  NativeFormsConnectionOptions,
  NativeFormsSession,
} from '../../src/services/forms/nativeFormsSession';
import type {
  NativeTestClientChild,
  NativeTestClientLaunchRequest,
  NativeTestClientLifecycleDeps,
} from '../../src/services/forms/nativeTestClientLifecycle';
import type { ProcessTreeTerminationOutcome } from '../../src/services/ibcmd/processTreeTermination';
import { runIbcmdConfigCheck, runIbcmdOnWorkDir, runInfobaseStartupCheck } from '../matrix/ibcmdAdapter';
import {
  runNativeTestClientStartupCheck,
  type NativeTestClientStartupDependencies,
} from '../matrix/startupReadiness';

suite('ibcmdMatrixAdapter', () => {
  const envKeys = [
    'IBCMD_PATH',
    'IBCMD_INFOBASE_CONFIG',
    'IBCMD_USER',
    'IBCMD_PASSWORD',
    'IBCMD_TIMEOUT_MS',
    'IBCMD_CONFIG_CHECK_FORCE',
    'ONE_C_CLIENT_PATH',
    'IBMATRIX_STARTUP_READY_TIMEOUT_MS',
  ] as const;
  let savedEnv: Record<string, string | undefined>;
  let tempDir: string;

  setup(() => {
    savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibcmd-matrix-'));
  });

  teardown(() => {
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('runIbcmdOnWorkDir skipped when IBCMD_PATH unset', async () => {
    const result = await runIbcmdOnWorkDir(path.join(tempDir, 'cfg'));
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.exitCode, null);
  });

  test('runIbcmdConfigCheck skipped when IBCMD_PATH unset', async () => {
    const result = await runIbcmdConfigCheck();
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.exitCode, null);
  });

  test('runInfobaseStartupCheck skipped when IBCMD_PATH unset', async () => {
    const result = await runInfobaseStartupCheck();
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.exitCode, null);
  });

  test('runInfobaseStartupCheck skips without a file infobase configuration', async () => {
    const configPath = path.join(tempDir, 'ib.yml');
    const ibcmdPath = path.join(tempDir, 'ibcmd.exe');
    const clientPath = path.join(tempDir, '1cv8c.exe');
    fs.writeFileSync(configPath, 'infobase:\n  server: server\n  name: test\n', 'utf8');
    fs.writeFileSync(ibcmdPath, '', 'utf8');
    fs.writeFileSync(clientPath, '', 'utf8');
    process.env.IBCMD_PATH = ibcmdPath;
    process.env.IBCMD_INFOBASE_CONFIG = configPath;
    process.env.ONE_C_CLIENT_PATH = clientPath;

    const result = await runInfobaseStartupCheck();
    assert.strictEqual(result.status, 'skipped');
    assert.match(result.logSnippet, /requires a file infobase/);
  });

  test('runInfobaseStartupCheck skips when the platform client is unavailable', async () => {
    const configPath = path.join(tempDir, 'ib.yml');
    const ibcmdPath = path.join(tempDir, 'ibcmd.exe');
    fs.writeFileSync(configPath, `infobase:\n  file: "${tempDir.replace(/\\/g, '\\\\')}"\n`, 'utf8');
    fs.writeFileSync(ibcmdPath, '', 'utf8');
    process.env.IBCMD_PATH = ibcmdPath;
    process.env.IBCMD_INFOBASE_CONFIG = configPath;

    const result = await runInfobaseStartupCheck();
    assert.strictEqual(result.status, 'skipped');
    assert.match(result.logSnippet, /client executable found/);
  });

  test('runInfobaseStartupCheck delegates a file infobase to native readiness with bounded timeout', async () => {
    const configPath = path.join(tempDir, 'ib.yml');
    const ibcmdPath = path.join(tempDir, 'ibcmd.exe');
    const clientPath = path.join(tempDir, '1cv8c.exe');
    fs.writeFileSync(configPath, `infobase:\n  file: "${tempDir.replace(/\\/g, '\\\\')}"\n`, 'utf8');
    fs.writeFileSync(ibcmdPath, '', 'utf8');
    fs.writeFileSync(clientPath, '', 'utf8');
    process.env.IBCMD_PATH = ibcmdPath;
    process.env.IBCMD_INFOBASE_CONFIG = configPath;
    process.env.IBCMD_USER = 'matrix-user';
    process.env.IBCMD_PASSWORD = 'matrix-password';
    process.env.ONE_C_CLIENT_PATH = clientPath;
    process.env.IBMATRIX_STARTUP_READY_TIMEOUT_MS = '999999';

    let capturedRequest: NativeTestClientLaunchRequest | undefined;
    const result = await runInfobaseStartupCheck({
      platform: 'win32',
      createOutLogPath: () => path.join(tempDir, 'startup.log'),
      lifecycleFactory: (dependencies) => ({
        start: async (request) => {
          capturedRequest = request;
          const child = dependencies.spawnProcess!('1cv8c.exe', ['ENTERPRISE']);
          return {
            child,
            pid: child.pid ?? 0,
            port: 18448,
            platformVersion: '8.3.27.1859',
          };
        },
      }),
      spawnProcess: () => fakeChild(8424) as unknown as ChildProcess,
      connectNativeClient: async () => fakeSession(),
      terminateProcessTree: async () => terminatedTree(),
    });

    assert.strictEqual(result.status, 'executed');
    assert.ok(capturedRequest);
    assert.strictEqual(capturedRequest.entry.filePath, fs.realpathSync.native(tempDir));
    assert.strictEqual(capturedRequest.user, 'matrix-user');
    assert.strictEqual(capturedRequest.password, 'matrix-password');
    assert.strictEqual(capturedRequest.platformPath, clientPath);
    assert.strictEqual(capturedRequest.waitTimeoutMs, 120000);
  });

  test('native readiness requires attach, confirmed MainFrame overview, and complete process cleanup', async () => {
    const fixture = createStartupFixture(tempDir);
    const result = await runNativeTestClientStartupCheck({
      fileDbPath: path.join(tempDir, 'db'),
      platformPath: '1cv8c.exe',
      user: 'test-user',
      password: 'test-password',
      waitTimeoutMs: 999999,
    }, fixture.dependencies);

    assert.strictEqual(result.status, 'executed');
    assert.strictEqual(result.exitCode, 0);
    assert.match(result.logSnippet, /TestClient attach and overview confirmed: MainFrame/);
    assert.doesNotMatch(result.logSnippet, /started cleanly|startup completed/i);
    assert.strictEqual(fixture.launchRequest?.entry.filePath, path.join(tempDir, 'db'));
    assert.strictEqual(fixture.launchRequest?.waitTimeoutMs, 120000);
    assert.strictEqual(fixture.connectionOptions?.host, '127.0.0.1');
    assert.strictEqual(fixture.connectionOptions?.port, 18448);
    assert.strictEqual(fixture.connectionOptions?.platformVersion, '8.3.27.1859');
    assert.deepStrictEqual(fixture.overviewAction, { action: 'overview', maxDepth: 0, maxNodes: 1 });
    assert.strictEqual(fixture.overviewTimeoutMs, 15000);
    assert.strictEqual(fixture.trace.join(','), 'start,connect,execute,close,terminate');
    assert.ok(fixture.spawnArgs.includes('/Out'));
    assert.strictEqual(fixture.spawnArgs[fixture.spawnArgs.indexOf('/Out') + 1], fixture.outLogPath);
    assert.ok(fixture.spawnArgs.includes('/DisableStartupDialogs'));
    assert.ok(fixture.spawnArgs.includes('/DisableStartupMessages'));
    assert.ok(!fs.existsSync(fixture.outLogPath), 'successful diagnostics are removed after process cleanup');
  });

  test('explicit /Out error prevents success even after attach and MainFrame overview', async () => {
    const fixture = createStartupFixture(tempDir, { logAfterOverview: '[ERROR] License unavailable. Startup failed.' });
    const result = await runNativeTestClientStartupCheck({ fileDbPath: path.join(tempDir, 'db') }, fixture.dependencies);

    assert.strictEqual(result.status, 'failed');
    assert.ok(fixture.connectionOptions, 'native attach and overview succeeded before the /Out error was checked');
    assert.strictEqual(fixture.trace.join(','), 'start,connect,execute,close,terminate');
    assert.match(result.logSnippet, /License unavailable/);
    assert.match(result.logSnippet, /startup\.log/);
    assert.ok(fs.existsSync(fixture.outLogPath), 'failure log is preserved for diagnosis');
  });

  test('startup /Out error blocks native attach even when the process stays alive', async () => {
    const fixture = createStartupFixture(tempDir, { logAtSpawn: '[ERROR] License unavailable. Startup failed.' });
    const result = await runNativeTestClientStartupCheck({ fileDbPath: path.join(tempDir, 'db') }, fixture.dependencies);

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(fixture.connectionOptions, undefined);
    assert.strictEqual(fixture.trace.join(','), 'start,terminate');
    assert.match(result.logSnippet, /License unavailable/);
    assert.ok(fs.existsSync(fixture.outLogPath), 'failure log is preserved for diagnosis');
  });

  test('attach failure is failed and still closes and terminates the owned client', async () => {
    const fixture = createStartupFixture(tempDir, { connectionError: new Error('attach rejected') });
    const result = await runNativeTestClientStartupCheck({ fileDbPath: path.join(tempDir, 'db') }, fixture.dependencies);

    assert.strictEqual(result.status, 'failed');
    assert.match(result.logSnippet, /attach rejected/);
    assert.strictEqual(fixture.trace.join(','), 'start,connect,terminate');
    assert.match(result.logSnippet, /startup\.log/);
  });

  test('overview RPC failure is failed and closes the session before terminating the process tree', async () => {
    const fixture = createStartupFixture(tempDir, { overviewError: new Error('overview RPC rejected') });
    const result = await runNativeTestClientStartupCheck({ fileDbPath: path.join(tempDir, 'db') }, fixture.dependencies);

    assert.strictEqual(result.status, 'failed');
    assert.match(result.logSnippet, /overview RPC rejected/);
    assert.strictEqual(fixture.trace.join(','), 'start,connect,execute,close,terminate');
  });

  test('spawn failure is failed and does not claim startup readiness', async () => {
    const fixture = createStartupFixture(tempDir, { spawnError: new Error('spawn denied') });
    const result = await runNativeTestClientStartupCheck({ fileDbPath: path.join(tempDir, 'db') }, fixture.dependencies);

    assert.strictEqual(result.status, 'failed');
    assert.match(result.logSnippet, /spawn denied/);
    assert.strictEqual(fixture.trace.join(','), 'start');
  });

  test('overview does not confirm a modal or malformed active window', async () => {
    const fixture = createStartupFixture(tempDir, {
      overviewResult: {
        activeWindow: { ref: { id: 'not-a-guid' }, className: 'MessageWindow', text: 'License unavailable' },
        truncated: false,
      } as NativeFormsActionResult,
    });
    const result = await runNativeTestClientStartupCheck({ fileDbPath: path.join(tempDir, 'db') }, fixture.dependencies);

    assert.strictEqual(result.status, 'failed');
    assert.match(result.logSnippet, /confirmed MainFrame/);
  });

  test('early process exit and startup timeout cannot count as successful readiness', async () => {
    for (const code of ['TESTCLIENT_EXITED', 'TESTCLIENT_LAUNCH_TIMEOUT']) {
      const fixture = createStartupFixture(tempDir, { startError: errorWithCode(code, `${code} observed`) });
      const result = await runNativeTestClientStartupCheck({ fileDbPath: path.join(tempDir, 'db') }, fixture.dependencies);
      assert.strictEqual(result.status, 'failed', code);
      assert.match(result.logSnippet, new RegExp(code));
      assert.strictEqual(fixture.trace.join(','), 'start,terminate', code);
      assert.match(result.logSnippet, /startup\.log/);
    }
  });

  test('missing platform client and unsupported platform are explicit skips', async () => {
    const missing = createStartupFixture(tempDir, {
      startError: errorWithCode('TESTCLIENT_PLATFORM_NOT_FOUND', 'No 1cv8c installation'),
      spawnBeforeStartError: false,
    });
    const missingResult = await runNativeTestClientStartupCheck({ fileDbPath: path.join(tempDir, 'db') }, missing.dependencies);
    assert.strictEqual(missingResult.status, 'skipped');
    assert.match(missingResult.logSnippet, /unavailable in this environment/);
    assert.strictEqual(missing.trace.join(','), 'start');

    let lifecycleCreated = false;
    const unsupportedResult = await runNativeTestClientStartupCheck(
      { fileDbPath: path.join(tempDir, 'db') },
      { ...missing.dependencies, platform: 'linux', lifecycleFactory: () => { lifecycleCreated = true; return { start: async () => { throw new Error('must not start'); } }; } },
    );
    assert.strictEqual(unsupportedResult.status, 'skipped');
    assert.match(unsupportedResult.logSnippet, /only on Windows/);
    assert.strictEqual(lifecycleCreated, false);
  });

  test('unconfirmed process-tree cleanup converts a successful overview to failed', async () => {
    const fixture = createStartupFixture(tempDir, {
      terminationOutcome: {
        terminated: false,
        hardKillUsed: true,
        survivingPids: [8421],
        errors: ['taskkill did not complete'],
      },
    });
    const result = await runNativeTestClientStartupCheck({ fileDbPath: path.join(tempDir, 'db') }, fixture.dependencies);

    assert.strictEqual(result.status, 'failed');
    assert.match(result.logSnippet, /surviving PIDs: 8421/);
    assert.strictEqual(fixture.trace[fixture.trace.length - 1], 'terminate');
  });

  (process.platform === 'win32' ? test.skip : test)('runIbcmdConfigCheck passes --force when IBCMD_CONFIG_CHECK_FORCE=1', async () => {
    const scriptPath = path.join(tempDir, 'fake-ibcmd-force.sh');
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
set -euo pipefail
joined="$*"
if [[ "$joined" != *"--force"* ]]; then
  echo "missing --force: $joined" >&2
  exit 3
fi
if [ "$1" = "infobase" ] && [ "$2" = "config" ] && [ "$3" = "check" ]; then
  echo "matrix check ok"
  exit 0
fi
exit 2
`,
      'utf-8'
    );
    fs.chmodSync(scriptPath, 0o755);
    process.env.IBCMD_PATH = scriptPath;
    process.env.IBCMD_INFOBASE_CONFIG = path.join(tempDir, 'ib.yml');
    fs.writeFileSync(process.env.IBCMD_INFOBASE_CONFIG, 'kind: fake\n', 'utf-8');
    process.env.IBCMD_CONFIG_CHECK_FORCE = '1';

    const result = await runIbcmdConfigCheck();
    assert.strictEqual(result.status, 'executed');
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.logSnippet.includes('matrix check ok'));
  });

  test.skip('runIbcmdConfigCheck fails when ibcmd output contains fake-ibcmd', async () => {
    const scriptPath =
      process.platform === 'win32'
        ? (() => {
            const p = path.join(tempDir, 'ibcmd-fake.cmd');
            fs.writeFileSync(p, '@echo fake-ibcmd\r\n@exit /b 0\r\n', 'utf8');
            return p;
          })()
        : (() => {
            const p = path.join(tempDir, 'ibcmd-fake');
            fs.writeFileSync(p, '#!/usr/bin/env sh\necho fake-ibcmd\nexit 0\n', 'utf8');
            fs.chmodSync(p, 0o755);
            return p;
          })();

    process.env.IBCMD_PATH = scriptPath;
    process.env.IBCMD_INFOBASE_CONFIG = path.join(tempDir, 'ib.yml');
    fs.writeFileSync(process.env.IBCMD_INFOBASE_CONFIG, 'kind: fake\n', 'utf-8');
    delete process.env.IBCMD_CONFIG_CHECK_FORCE;

    const result = await runIbcmdConfigCheck();
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.logSnippet.toLowerCase().includes('fake-ibcmd'));
  });

  test.skip('runIbcmdOnWorkDir fails when ibcmd output contains fake-ibcmd', async () => {
    const workDir = path.join(tempDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'Configuration.xml'), '<Configuration></Configuration>', 'utf8');

    const scriptPath =
      process.platform === 'win32'
        ? (() => {
            const p = path.join(tempDir, 'ibcmd-fake-import.cmd');
            fs.writeFileSync(p, '@echo fake-ibcmd\r\n@exit /b 0\r\n', 'utf8');
            return p;
          })()
        : (() => {
            const p = path.join(tempDir, 'ibcmd-fake-import');
            fs.writeFileSync(p, '#!/usr/bin/env sh\necho fake-ibcmd\nexit 0\n', 'utf8');
            fs.chmodSync(p, 0o755);
            return p;
          })();

    process.env.IBCMD_PATH = scriptPath;
    process.env.IBCMD_INFOBASE_CONFIG = path.join(tempDir, 'ib.yml');
    fs.writeFileSync(process.env.IBCMD_INFOBASE_CONFIG, 'kind: fake\n', 'utf-8');

    const result = await runIbcmdOnWorkDir(workDir);
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.logSnippet.toLowerCase().includes('fake-ibcmd'));
  });
});

interface StartupFixtureOptions {
  startError?: Error & { code?: string };
  spawnBeforeStartError?: boolean;
  logAtSpawn?: string;
  logAfterOverview?: string;
  spawnError?: Error;
  connectionError?: Error;
  overviewError?: Error;
  overviewResult?: NativeFormsActionResult;
  terminationOutcome?: ProcessTreeTerminationOutcome;
}

interface StartupFixture {
  dependencies: NativeTestClientStartupDependencies;
  child: FakeChild;
  outLogPath: string;
  trace: string[];
  spawnArgs: string[];
  launchRequest?: NativeTestClientLaunchRequest;
  connectionOptions?: NativeFormsConnectionOptions;
  overviewAction?: NativeFormsAction;
  overviewTimeoutMs?: number;
}

class FakeChild extends EventEmitter {
  constructor(readonly pid: number) {
    super();
  }

  kill(): boolean {
    return true;
  }
}

function fakeChild(pid: number): FakeChild {
  return new FakeChild(pid);
}

function fakeSession(): NativeFormsSession {
  return {
    host: '127.0.0.1',
    port: 18448,
    connected: true,
    async execute() {
      return confirmedMainFrameResult();
    },
    async close() {},
  };
}

function createStartupFixture(tempDir: string, options: StartupFixtureOptions = {}): StartupFixture {
  const child = fakeChild(8421);
  const outLogPath = path.join(tempDir, 'startup.log');
  const trace: string[] = [];
  const fixture: StartupFixture = {
    dependencies: {},
    child,
    outLogPath,
    trace,
    spawnArgs: [],
  };
  const session: NativeFormsSession = {
    host: '127.0.0.1',
    port: 18448,
    connected: true,
    async execute(action, executeOptions) {
      trace.push('execute');
      fixture.overviewAction = action;
      fixture.overviewTimeoutMs = executeOptions.timeoutMs;
      if (options.overviewError) {
        throw options.overviewError;
      }
      if (options.logAfterOverview) {
        fs.writeFileSync(outLogPath, options.logAfterOverview, 'utf8');
      }
      return options.overviewResult ?? confirmedMainFrameResult();
    },
    async close() {
      trace.push('close');
    },
  };

  const lifecycleFactory = (lifecycleDependencies: NativeTestClientLifecycleDeps) => ({
    start: async (request: NativeTestClientLaunchRequest) => {
      trace.push('start');
      fixture.launchRequest = request;
      const launchedChild = options.spawnBeforeStartError === false
        ? child
        : lifecycleDependencies.spawnProcess!('1cv8c.exe', ['ENTERPRISE', '/F', request.entry.filePath ?? '']);
      if (options.startError) {
        throw options.startError;
      }
      return {
        child: launchedChild as NativeTestClientChild,
        pid: launchedChild.pid ?? child.pid,
        port: 18448,
        platformVersion: '8.3.27.1859',
      };
    },
  });

  fixture.dependencies = {
    platform: 'win32',
    lifecycleFactory,
    createOutLogPath: () => outLogPath,
    spawnProcess: (_exe, args) => {
      fixture.spawnArgs = [...args];
      if (options.spawnError) {
        throw options.spawnError;
      }
      const outLogIndex = args.lastIndexOf('/Out');
      if (options.logAtSpawn && outLogIndex >= 0) {
        fs.writeFileSync(args[outLogIndex + 1], options.logAtSpawn, 'utf8');
      }
      return child as unknown as ChildProcess;
    },
    connectNativeClient: async (connectionOptions) => {
      trace.push('connect');
      fixture.connectionOptions = connectionOptions;
      if (options.connectionError) {
        throw options.connectionError;
      }
      return session;
    },
    terminateProcessTree: async (terminatedChild) => {
      trace.push('terminate');
      assert.strictEqual(terminatedChild.pid, child.pid);
      return options.terminationOutcome ?? terminatedTree();
    },
  };
  return fixture;
}

function confirmedMainFrameResult(): NativeFormsActionResult {
  return {
    activeWindow: {
      ref: { id: '12345678-1234-4234-8234-123456789abc' },
      className: 'MainFrame',
      text: 'Конфигурация',
    },
    truncated: false,
  };
}

function terminatedTree(): ProcessTreeTerminationOutcome {
  return { terminated: true, hardKillUsed: false, survivingPids: [], errors: [] };
}

function errorWithCode(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
