import * as assert from 'assert';
import { EventEmitter, once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type * as vscode from 'vscode';
import '../helpers/vscodeStubRegister';
import { FormsOperations } from '../../src/agent/agentFormsOperations';
import { FormsContext } from '../../src/services/forms/FormsContext';
import { runFormsScript } from '../../src/services/forms/runFormsScript';
import { vscodeTestState } from '../helpers/vscodeModuleStub';

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  pid = 4242;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.killed = true;
    setImmediate(() => this.completeExit());
    return true;
  }

  completeExit(code = 0): void {
    if (this.exitCode !== null) {
      return;
    }
    this.exitCode = code;
    this.emit('exit', code);
    this.emit('close', code);
  }
}

class StubbornChildProcess extends FakeChildProcess {
  override kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.killed = true;
    return false;
  }
}

function outputChannel(): vscode.OutputChannel {
  return {
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
    name: 'Forms lifecycle test',
    append: () => undefined,
    clear: () => undefined,
    hide: () => undefined,
    replace: () => undefined,
  } as unknown as vscode.OutputChannel;
}

suite('Forms process lifecycle', () => {
  test('compensates ibsrv when browser setup fails and removes its data directory', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forms-partial-start-'));
    const dataDir = path.join(tempDir, 'ibsrv-data');
    await fs.promises.mkdir(dataDir);
    const context = new FormsContext();
    context.configureStoragePath(path.join(tempDir, 'storage'));
    const ibsrv = new FakeChildProcess();
    const operations = new FormsOperations({
      extensionPath: tempDir,
      outputChannel: outputChannel(),
      context,
      startIbsrv: async () => ({
        url: 'http://localhost:18000/',
        port: 18000,
        proc: ibsrv as unknown as ChildProcess,
        dataDir,
      }),
      ensureChromiumInstalled: async () => {
        throw new Error('chromium install failed');
      },
      runFormsScript: async () => {
        throw new Error('browser start must not run');
      },
    });

    try {
      const result = await operations.formsStart({
        dbPath: path.join(tempDir, 'db'),
        platformPath: path.join(tempDir, 'platform'),
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error ?? '', /chromium install failed/);
      assert.ok(ibsrv.signals.includes('SIGTERM'));
      assert.strictEqual(context.ibsrvProc, undefined);
      assert.strictEqual(await exists(dataDir), false);
    } finally {
      await context.dispose().catch(() => undefined);
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('retains ibsrv acquired before readiness failure until exit is proven', async function () {
    this.timeout(10_000);
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forms-readiness-stubborn-'));
    const dataDir = path.join(tempDir, 'ibsrv-data');
    await fs.promises.mkdir(dataDir);
    const context = new FormsContext();
    context.configureStoragePath(path.join(tempDir, 'storage'));
    const ibsrv = new StubbornChildProcess();
    const operations = new FormsOperations({
      extensionPath: tempDir,
      outputChannel: outputChannel(),
      context,
      startIbsrv: async (options) => {
        options.onSpawned?.({
          url: 'http://localhost:18005/',
          port: 18005,
          proc: ibsrv as unknown as ChildProcess,
          dataDir,
        });
        throw new Error('ibsrv readiness failed');
      },
      ensureChromiumInstalled: async () => {
        throw new Error('chromium install must not run');
      },
    });

    try {
      const result = await operations.formsStart({
        dbPath: path.join(tempDir, 'db'),
        platformPath: path.join(tempDir, 'platform'),
      });

      assert.strictEqual(result.success, false);
      assert.match(result.error ?? '', /ibsrv readiness failed/);
      assert.match(result.error ?? '', /did not exit/);
      assert.strictEqual(context.ibsrvProc, ibsrv as unknown as ChildProcess);
      assert.strictEqual(context.ibsrvDataDir, dataDir);
      assert.strictEqual(await exists(dataDir), true);
      assert.deepStrictEqual(ibsrv.signals, ['SIGTERM', 'SIGKILL']);

      ibsrv.completeExit();
      const retry = await context.stop();
      assert.deepStrictEqual(retry.errors, []);
      assert.strictEqual(context.ibsrvProc, undefined);
      assert.strictEqual(await exists(dataDir), false);
    } finally {
      ibsrv.completeExit();
      await context.dispose().catch(() => undefined);
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('continues reverse-order cleanup when browser stop fails and is idempotent', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forms-stop-'));
    const dataDir = path.join(tempDir, 'ibsrv-data');
    await fs.promises.mkdir(dataDir);
    const context = new FormsContext();
    context.configureStoragePath(path.join(tempDir, 'storage'));
    const browser = new FakeChildProcess();
    const ibsrv = new FakeChildProcess();
    const order: string[] = [];
    const originalBrowserKill = browser.kill.bind(browser);
    browser.kill = (signal?: NodeJS.Signals | number) => {
      order.push('browser-process');
      return originalBrowserKill(signal);
    };
    const originalIbsrvKill = ibsrv.kill.bind(ibsrv);
    ibsrv.kill = (signal?: NodeJS.Signals | number) => {
      order.push('ibsrv-process');
      return originalIbsrvKill(signal);
    };
    context.setIbsrv(ibsrv as unknown as ChildProcess, 18001, 'db', dataDir);
    context.setBrowserProc(browser as unknown as ChildProcess, async () => {
      order.push('browser-cleanup');
      throw new Error('stop endpoint unavailable');
    });

    try {
      const first = await context.stop();
      const second = await context.stop();

      assert.deepStrictEqual(order.slice(0, 3), [
        'browser-cleanup',
        'browser-process',
        'ibsrv-process',
      ]);
      assert.ok(first.errors.some((error) => error.includes('stop endpoint unavailable')));
      assert.deepStrictEqual(second.errors, []);
      assert.strictEqual(await exists(dataDir), false);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('uses the configured per-host session file for every browser command', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forms-session-path-'));
    const context = new FormsContext();
    context.configureStoragePath(path.join(tempDir, 'global-storage'));
    const seen: Array<{ command: string; sessionFilePath: string }> = [];
    const browser = new FakeChildProcess();
    const operations = new FormsOperations({
      extensionPath: tempDir,
      outputChannel: outputChannel(),
      context,
      ensureChromiumInstalled: async () => undefined,
      runFormsScript: async (options) => {
        seen.push({ command: options.command, sessionFilePath: options.sessionFilePath });
        if (options.command === 'stop') {
          browser.completeExit();
        }
        return options.command === 'start'
          ? { output: 'Browser ready', stderr: '', exitCode: 0, detachedProc: browser as unknown as ChildProcess }
          : { output: '', stderr: '', exitCode: 0 };
      },
    });

    try {
      const start = await operations.formsStart({ url: 'http://localhost/app' });
      const stop = await operations.formsStop({});

      assert.strictEqual(start.success, true);
      assert.strictEqual(stop.success, true);
      assert.deepStrictEqual(seen.map((entry) => entry.command), ['start', 'stop']);
      assert.ok(seen.every((entry) => entry.sessionFilePath === context.sessionFilePath));
      assert.ok(context.sessionFilePath.startsWith(path.join(tempDir, 'global-storage')));
      assert.match(path.basename(context.sessionFilePath), new RegExp(String(process.pid)));
    } finally {
      await context.dispose().catch(() => undefined);
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('waits for graceful browser disconnect before considering a kill', async () => {
    const context = new FormsContext();
    const browser = new FakeChildProcess();
    context.setBrowserProc(browser as unknown as ChildProcess, async () => {
      setTimeout(() => browser.completeExit(), 10);
    });

    const outcome = await context.stop();

    assert.deepStrictEqual(outcome.errors, []);
    assert.deepStrictEqual(browser.signals, []);
    assert.strictEqual(context.browserProc, undefined);
  });

  test('retains ownership and diagnostics when browser ignores graceful and hard shutdown', async function () {
    this.timeout(7_000);
    const context = new FormsContext();
    const browser = new StubbornChildProcess();
    context.setBrowserProc(browser as unknown as ChildProcess, async () => {
      throw new Error('stop endpoint unavailable');
    });

    const outcome = await context.stop();

    assert.strictEqual(context.browserProc, browser as unknown as ChildProcess);
    assert.deepStrictEqual(browser.signals, ['SIGTERM', 'SIGKILL']);
    assert.ok(outcome.errors.some((error) => error.includes('did not exit')));

    browser.completeExit();
    await context.stop();
  });

  test('serializes exec with stop for the same browser session', async () => {
    const context = new FormsContext();
    const browser = new FakeChildProcess();
    const order: string[] = [];
    let finishExec: (() => void) | undefined;
    const execGate = new Promise<void>((resolve) => { finishExec = resolve; });
    context.setBrowserProc(browser as unknown as ChildProcess, async () => {
      order.push('stop');
      browser.completeExit();
    });
    const operations = new FormsOperations({
      extensionPath: 'unused',
      outputChannel: outputChannel(),
      context,
      runFormsScript: async (options) => {
        order.push(options.command);
        if (options.command === 'exec') {
          await execGate;
        }
        return { output: '', stderr: '', exitCode: 0 };
      },
    });

    const exec = operations.formsExec({ script: 'return 1;' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stop = operations.formsStop({});
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(order, ['exec']);

    finishExec!();
    await Promise.all([exec, stop]);
    assert.deepStrictEqual(order, ['exec', 'stop']);
  });

  test('formsExec reports a non-zero runner exit as failure', async () => {
    const operations = new FormsOperations({
      extensionPath: 'unused',
      outputChannel: outputChannel(),
      context: new FormsContext(),
      runFormsScript: async () => ({ output: '', stderr: 'BSL failed', exitCode: 17 }),
    });

    const result = await operations.formsExec({ script: 'raise;' });

    assert.strictEqual(result.success, false);
    assert.match(result.error ?? '', /кодом 17/);
    assert.match(result.error ?? '', /BSL failed/);
  });

  test('formsExec retains a timeout survivor until a later proven exit', async function () {
    this.timeout(10_000);
    const context = new FormsContext();
    const runner = new StubbornChildProcess();
    const operations = new FormsOperations({
      extensionPath: 'unused',
      outputChannel: outputChannel(),
      context,
      runFormsScript: async () => ({
        output: '',
        stderr: 'timeout',
        exitCode: 124,
        unclosedProc: runner as unknown as ChildProcess,
      }),
    });

    try {
      const exec = await operations.formsExec({ script: 'return 1;', timeoutMs: 25 });

      assert.strictEqual(exec.success, false);
      assert.match(exec.error ?? '', /124/);
      assert.strictEqual(context.ownsTransientProcess(runner as unknown as ChildProcess), true);

      const firstStop = await operations.formsStop({});
      assert.strictEqual(firstStop.success, false);
      assert.match(firstStop.error ?? '', /did not exit/);
      assert.deepStrictEqual(runner.signals, ['SIGTERM', 'SIGKILL']);
      assert.strictEqual(context.ownsTransientProcess(runner as unknown as ChildProcess), true);

      runner.completeExit();
      const retry = await operations.formsStop({});
      assert.strictEqual(retry.success, true);
      assert.strictEqual(context.ownsTransientProcess(runner as unknown as ChildProcess), false);
    } finally {
      runner.completeExit();
      await context.dispose().catch(() => undefined);
    }
  });

  test('signalCode proves process termination without another kill', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forms-signaled-'));
    const context = new FormsContext();
    const ibsrv = new FakeChildProcess();
    ibsrv.signalCode = 'SIGTERM';
    context.setIbsrv(ibsrv as unknown as ChildProcess, 18003, 'db', tempDir);

    const outcome = await context.stop();

    assert.deepStrictEqual(outcome.errors, []);
    assert.deepStrictEqual(ibsrv.signals, []);
    assert.strictEqual(context.ibsrvProc, undefined);
    assert.strictEqual(await exists(tempDir), false);
  });

  test('retains ibsrv ownership and data when TERM and KILL cannot prove exit', async function () {
    this.timeout(7_000);
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forms-ibsrv-stubborn-'));
    const context = new FormsContext();
    const ibsrv = new StubbornChildProcess();
    context.setIbsrv(ibsrv as unknown as ChildProcess, 18004, 'db', tempDir);

    const outcome = await context.stop();

    assert.strictEqual(context.ibsrvProc, ibsrv as unknown as ChildProcess);
    assert.strictEqual(context.ibsrvDataDir, tempDir);
    assert.strictEqual(await exists(tempDir), true);
    assert.deepStrictEqual(ibsrv.signals, ['SIGTERM', 'SIGKILL']);
    assert.ok(outcome.errors.some((error) => error.includes('did not exit')));
    assert.ok(outcome.errors.some((error) => error.includes('TERM→KILL')));

    ibsrv.completeExit();
    const retry = await context.stop();
    assert.deepStrictEqual(retry.errors, []);
    assert.strictEqual(context.ibsrvProc, undefined);
    assert.strictEqual(await exists(tempDir), false);
  });

  test('runFormsScript timeout waits through TERM to a verified hard exit', async function () {
    this.timeout(5_000);
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forms-timeout-runner-'));
    try {
      const resourcesDir = path.join(tempDir, 'resources', 'web-test');
      await fs.promises.mkdir(resourcesDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(resourcesDir, 'run.mjs'),
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
        'utf8',
      );

      const result = await runFormsScript({
        extensionPath: tempDir,
        sessionFilePath: path.join(tempDir, 'storage', 'session.json'),
        command: 'start',
        args: [],
        timeoutMs: 25,
      });

      assert.strictEqual(result.exitCode, 124);
      assert.strictEqual(result.unclosedProc, undefined);
      assert.match(result.stderr, /timeout/);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('runFormsScript keeps retained stdout within the UTF-8 byte limit', async function () {
    this.timeout(5_000);
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forms-byte-ring-'));
    try {
      const resourcesDir = path.join(tempDir, 'resources', 'web-test');
      await fs.promises.mkdir(resourcesDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(resourcesDir, 'run.mjs'),
        "process.stdout.write(String.fromCodePoint(0x1f642).repeat(100000));\n",
        'utf8',
      );

      const result = await runFormsScript({
        extensionPath: tempDir,
        sessionFilePath: path.join(tempDir, 'storage', 'session.json'),
        command: 'run',
        args: [],
      });

      assert.strictEqual(result.exitCode, 0);
      assert.ok(Buffer.byteLength(result.output, 'utf8') <= 256 * 1024);
      assert.ok(!result.output.includes('\ufffd'), 'ring must start on a UTF-8 code point boundary');
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('runFormsScript preserves a multibyte UTF-8 character split across chunks', async function () {
    this.timeout(5_000);
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forms-utf8-split-'));
    try {
      const resourcesDir = path.join(tempDir, 'resources', 'web-test');
      await fs.promises.mkdir(resourcesDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(resourcesDir, 'run.mjs'),
        [
          "const emoji = Buffer.from(String.fromCodePoint(0x1f642));",
          'process.stdout.write(emoji.subarray(0, 2));',
          'setTimeout(() => process.stdout.write(emoji.subarray(2)), 25);',
        ].join('\n'),
        'utf8',
      );

      const result = await runFormsScript({
        extensionPath: tempDir,
        sessionFilePath: path.join(tempDir, 'storage', 'session.json'),
        command: 'run',
        args: [],
      });

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.output, String.fromCodePoint(0x1f642));
      assert.ok(!result.output.includes('\ufffd'));
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('runFormsScript timeout terminates a real descendant process tree', async function () {
    this.timeout(15_000);
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forms-process-tree-'));
    const descendantPidFile = path.join(tempDir, 'descendant.pid');
    let descendantPid: number | undefined;
    try {
      const resourcesDir = path.join(tempDir, 'resources', 'web-test');
      await fs.promises.mkdir(resourcesDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(resourcesDir, 'run.mjs'),
        [
          "import { spawn } from 'child_process';",
          "import { writeFileSync } from 'fs';",
          "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore', windowsHide: true });",
          `writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
          "process.on('SIGTERM', () => {});",
          'setInterval(() => {}, 1000);',
        ].join('\n'),
        'utf8',
      );

      const result = await runFormsScript({
        extensionPath: tempDir,
        sessionFilePath: path.join(tempDir, 'storage', 'session.json'),
        command: 'start',
        args: [],
        timeoutMs: 100,
      });
      descendantPid = Number.parseInt(await fs.promises.readFile(descendantPidFile, 'utf8'), 10);

      assert.strictEqual(result.exitCode, 124);
      assert.strictEqual(result.unclosedProc, undefined);
      assert.strictEqual(isPidAlive(descendantPid), false);
    } finally {
      if (descendantPid && isPidAlive(descendantPid)) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch { /* best-effort */ }
      }
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('uses 1cMetadataTree.platform.path and rejects start without a detached process', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forms-platform-setting-'));
    const context = new FormsContext();
    const platformPath = path.join(tempDir, 'platform');
    let receivedPlatformPath: string | undefined;
    vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'] = `  ${platformPath}  `;
    const ibsrv = new FakeChildProcess();
    const dataDir = path.join(tempDir, 'data');
    await fs.promises.mkdir(dataDir);
    const operations = new FormsOperations({
      extensionPath: tempDir,
      outputChannel: outputChannel(),
      context,
      startIbsrv: async (options) => {
        receivedPlatformPath = options.platformPath;
        return {
          url: 'http://localhost:18002/',
          port: 18002,
          proc: ibsrv as unknown as ChildProcess,
          dataDir,
        };
      },
      ensureChromiumInstalled: async () => undefined,
      runFormsScript: async () => ({ output: '', stderr: '', exitCode: 0 }),
    });

    try {
      const result = await operations.formsStart({ dbPath: path.join(tempDir, 'db') });
      assert.strictEqual(receivedPlatformPath, platformPath);
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? '', /подтверждения готовности browser session/);
      assert.strictEqual(context.ibsrvProc, undefined);
      assert.strictEqual(await exists(dataDir), false);
    } finally {
      delete vscodeTestState.workspaceConfig['1cMetadataTree.platform.path'];
      await context.dispose().catch(() => undefined);
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('run.mjs /stop waits for browser disconnect and closes the server process', async () => {
    const fixture = await startFakeBrowserRunner('forms-runner-stop-');
    try {
      const stop = spawn(process.execPath, [fixture.runnerPath, 'stop'], {
        windowsHide: true,
        env: fixture.env,
        stdio: 'pipe',
      });
      const [stopCode] = await waitForExit(stop, 5_000);
      const [serverCode] = await waitForExit(fixture.server, 5_000);

      assert.strictEqual(stopCode, 0);
      assert.strictEqual(serverCode, 0);
      assert.match(await fs.promises.readFile(fixture.disconnectLog, 'utf8'), /disconnect/);
      assert.strictEqual(await exists(fixture.sessionFile), false);
    } finally {
      if (fixture.server.exitCode === null) {
        fixture.server.kill('SIGKILL');
      }
      await fs.promises.rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  test('run.mjs SIGTERM uses the same graceful browser cleanup', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const fixture = await startFakeBrowserRunner('forms-runner-sigterm-');
    try {
      fixture.server.kill('SIGTERM');
      const [serverCode] = await waitForExit(fixture.server, 5_000);

      assert.strictEqual(serverCode, 0);
      assert.match(await fs.promises.readFile(fixture.disconnectLog, 'utf8'), /disconnect/);
      assert.strictEqual(await exists(fixture.sessionFile), false);
    } finally {
      if (fixture.server.exitCode === null) {
        fixture.server.kill('SIGKILL');
      }
      await fs.promises.rm(fixture.tempDir, { recursive: true, force: true });
    }
  });
});

async function startFakeBrowserRunner(prefix: string): Promise<{
  tempDir: string;
  runnerPath: string;
  sessionFile: string;
  disconnectLog: string;
  env: NodeJS.ProcessEnv;
  server: ChildProcess;
}> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  const runnerPath = path.join(tempDir, 'run.mjs');
  const browserPath = path.join(tempDir, 'browser.mjs');
  const sessionFile = path.join(tempDir, 'session.json');
  const disconnectLog = path.join(tempDir, 'disconnect.log');
  await fs.promises.copyFile(path.resolve(__dirname, '../../../resources/web-test/run.mjs'), runnerPath);
  await fs.promises.writeFile(browserPath, [
    "import { appendFileSync } from 'fs';",
    'let connected = false;',
    'export async function connect(url) { connected = true; return { url }; }',
    'export async function disconnect() {',
    '  await new Promise(resolve => setTimeout(resolve, 25));',
    "  appendFileSync(process.env.FORMS_DISCONNECT_LOG, 'disconnect\\n');",
    '  connected = false;',
    '}',
    'export function isConnected() { return connected; }',
    "export async function screenshot() { return Buffer.from('png'); }",
  ].join('\n'), 'utf8');
  const env = {
    ...process.env,
    CDT_FORMS_SESSION_FILE: sessionFile,
    FORMS_DISCONNECT_LOG: disconnectLog,
  };
  const server = spawn(process.execPath, [runnerPath, 'start', 'http://localhost/fake'], {
    windowsHide: true,
    env,
    stdio: 'pipe',
  });
  await waitForOutput(server, /Browser ready/, 5_000);
  return { tempDir, runnerPath, sessionFile, disconnectLog, env, server };
}

function waitForOutput(proc: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${pattern}: ${output}`)), timeoutMs);
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        finish();
      }
    };
    const onExit = (code: number | null) => finish(new Error(`Process exited ${code}: ${output}`));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      proc.stdout?.removeListener('data', onData);
      proc.removeListener('exit', onExit);
      error ? reject(error) : resolve();
    };
    proc.stdout?.on('data', onData);
    proc.once('exit', onExit);
  });
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<[number | null, NodeJS.Signals | null]> {
  if (proc.exitCode !== null) {
    return [proc.exitCode, null];
  }
  return Promise.race([
    once(proc, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Process ${proc.pid ?? 'unknown'} did not exit`)), timeoutMs);
    }),
  ]);
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
