import * as assert from 'assert';
import { EventEmitter } from 'events';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { PassThrough } from 'stream';
import iconv from 'iconv-lite';
import {
  IBCMD_STREAM_RING_BUFFER_MAX_BYTES,
  RingBufferText,
  runIbcmdStreaming,
  type IbcmdStreamCancellation,
} from '../../src/services/ibcmd/IbcmdStreamingRunner';

function disposableNoop(): { dispose: () => void } {
  return { dispose: () => {} };
}

function staticCancellation(requested: boolean): IbcmdStreamCancellation {
  return {
    isCancellationRequested: requested,
    onCancellationRequested: () => disposableNoop(),
  };
}

function cancellable(): IbcmdStreamCancellation & { cancel: () => void } {
  let cancelled = false;
  const listeners: Array<() => void> = [];
  return {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(listener: () => void) {
      listeners.push(listener);
      return disposableNoop();
    },
    cancel() {
      if (!cancelled) {
        cancelled = true;
        listeners.forEach((l) => l());
      }
    },
  };
}

interface ControllableSpawn {
  spawnImpl: typeof spawn;
  pushStdout: (s: string | Buffer) => void;
  pushStderr: (s: string | Buffer) => void;
  close: (code: number | null, signal: NodeJS.Signals | null) => void;
  lastChild: () => ChildProcess | undefined;
}

function createControllableSpawn(): ControllableSpawn {
  let stdoutEE = new PassThrough();
  let stderrEE = new PassThrough();
  let childRef: ChildProcess | undefined;

  const spawnImpl = ((_command: string, _args: readonly string[], _options: object): ChildProcess => {
    stdoutEE = new PassThrough();
    stderrEE = new PassThrough();
    const c = new EventEmitter() as ChildProcess;
    (c as unknown as { stdout: PassThrough }).stdout = stdoutEE;
    (c as unknown as { stderr: PassThrough }).stderr = stderrEE;
    (c as unknown as { killed: boolean }).killed = false;
    (c as unknown as { exitCode: number | null }).exitCode = null;
    (c as unknown as { kill: (sig?: NodeJS.Signals) => boolean }).kill = (sig?: NodeJS.Signals) => {
      (c as unknown as { killed: boolean }).killed = true;
      setImmediate(() => c.emit('close', null, sig ?? 'SIGTERM'));
      return true;
    };
    childRef = c;
    return c;
  }) as typeof spawn;

  return {
    spawnImpl,
    pushStdout: (s: string | Buffer) => {
      stdoutEE.write(s);
    },
    pushStderr: (s: string | Buffer) => {
      stderrEE.write(s);
    },
    close: (code, signal) => {
      childRef?.emit('close', code, signal);
    },
    lastChild: () => childRef,
  };
}

suite('IbcmdStreamingRunner', () => {
  test('default ring buffer constant is in 256–512 KiB range', () => {
    assert.ok(IBCMD_STREAM_RING_BUFFER_MAX_BYTES >= 256 * 1024);
    assert.ok(IBCMD_STREAM_RING_BUFFER_MAX_BYTES <= 512 * 1024);
  });

  test('streams stdout/stderr and finishes on close', async () => {
    const ctrl = createControllableSpawn();
    const chunks: string[] = [];
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: ['infobase', 'config', 'check', '--config=x'],
      timeoutMs: 30_000,
      cancellation: staticCancellation(false),
      onStreamChunk: (c) => chunks.push(c),
      spawnImpl: ctrl.spawnImpl,
    });
    ctrl.pushStdout('out');
    ctrl.pushStderr('err');
    ctrl.close(0, null);
    const out = await p;
    assert.strictEqual(out.exitCode, 0);
    assert.ok(out.combinedLog.includes('out'));
    assert.ok(out.combinedLog.includes('err'));
    assert.strictEqual(out.timedOut, false);
    assert.strictEqual(out.cancelled, false);
    assert.ok(chunks.join('').includes('out'));
  });

  test('times out when process does not exit', async () => {
    const ctrl = createControllableSpawn();
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 80,
      cancellation: staticCancellation(false),
      spawnImpl: ctrl.spawnImpl,
    });
    ctrl.pushStdout('x');
    const out = await p;
    assert.strictEqual(out.timedOut, true);
    assert.strictEqual(out.cancelled, false);
  });

  test('immediate cancellation before close', async () => {
    const ctrl = createControllableSpawn();
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 30_000,
      cancellation: staticCancellation(true),
      spawnImpl: ctrl.spawnImpl,
    });
    const out = await p;
    assert.strictEqual(out.cancelled, true);
  });

  test('cancellation listener kills child', async () => {
    const ctrl = createControllableSpawn();
    const c = cancellable();
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 30_000,
      cancellation: c,
      spawnImpl: ctrl.spawnImpl,
    });
    assert.ok(ctrl.lastChild());
    c.cancel();
    const out = await p;
    assert.strictEqual(out.cancelled, true);
  });

  test('spawn throws → spawnErrorCode', async () => {
    const spawnImpl = ((): ChildProcess => {
      throw Object.assign(new Error('bad'), { code: 'BOOM' });
    }) as typeof spawn;
    const out = await runIbcmdStreaming({
      executablePath: '/missing',
      args: [],
      timeoutMs: 1000,
      cancellation: staticCancellation(false),
      spawnImpl,
    });
    assert.strictEqual(out.spawnErrorCode, 'BOOM');
    assert.strictEqual(out.exitCode, null);
  });

  test('ring buffer truncates and sets logTruncated', async () => {
    const ctrl = createControllableSpawn();
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 10_000,
      cancellation: staticCancellation(false),
      ringBufferMaxBytes: 12,
      spawnImpl: ctrl.spawnImpl,
    });
    ctrl.pushStdout('12345678901234567890');
    ctrl.close(0, null);
    const out = await p;
    assert.strictEqual(out.logTruncated, true);
    assert.ok(out.combinedLog.length <= 12);
  });

  test('ring physically releases discarded backing buffers', () => {
    const ring = new RingBufferText(32);
    ring.append('x'.repeat(1024 * 1024));
    assert.ok(ring.retainedStorageBytes <= 32);

    for (let index = 0; index < 100; index += 1) {
      ring.append(`chunk-${index}-${'y'.repeat(64)}`);
      assert.ok(ring.retainedStorageBytes <= 32);
    }
    assert.ok(Buffer.byteLength(ring.state.text, 'utf8') <= 32);
  });

  test('ring buffer enforces UTF-8 byte limit without retaining a broken code point', async () => {
    const ctrl = createControllableSpawn();
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 10_000,
      cancellation: staticCancellation(false),
      ringBufferMaxBytes: 5,
      spawnImpl: ctrl.spawnImpl,
    });
    ctrl.pushStdout('🙂🙂');
    ctrl.close(0, null);
    const out = await p;

    assert.strictEqual(out.logTruncated, true);
    assert.ok(Buffer.byteLength(out.combinedLog, 'utf-8') <= 5);
    assert.strictEqual(out.combinedLog, '🙂');
  });

  test('cancellation waits for verified process-tree termination outcome', async () => {
    const ctrl = createControllableSpawn();
    const cancellation = cancellable();
    let releaseTermination!: () => void;
    const termination = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    let completed = false;
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 10_000,
      cancellation,
      spawnImpl: ctrl.spawnImpl,
      terminateProcessTreeImpl: async () => {
        await termination;
        return { terminated: true, hardKillUsed: true, survivingPids: [], errors: [] };
      },
    }).then((outcome) => {
      completed = true;
      return outcome;
    });

    cancellation.cancel();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(completed, false);
    releaseTermination();
    const out = await p;

    assert.strictEqual(out.cancelled, true);
    assert.strictEqual(out.termination?.terminated, true);
    assert.strictEqual(out.termination?.hardKillUsed, true);
  });

  test('cancellation terminates a real child and grandchild process', async function () {
    this.timeout(20_000);
    const cancellation = cancellable();
    const childScript = [
      "const { spawn } = require('child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
      "process.stdout.write(JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }) + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join(' ');
    let captured = '';
    let reportedPids: { parent: number; grandchild: number } | undefined;
    let resolveReported!: (pids: { parent: number; grandchild: number }) => void;
    const reported = new Promise<{ parent: number; grandchild: number }>((resolve) => {
      resolveReported = resolve;
    });

    const running = runIbcmdStreaming({
      executablePath: process.execPath,
      args: ['-e', childScript],
      timeoutMs: 15_000,
      terminationGraceMs: 500,
      cancellation,
      onStreamChunk: (chunk, stream) => {
        if (stream !== 'stdout' || reportedPids) {
          return;
        }
        captured += chunk;
        const line = captured.split(/\r?\n/).find(Boolean);
        if (line) {
          reportedPids = JSON.parse(line) as { parent: number; grandchild: number };
          resolveReported(reportedPids);
        }
      },
    });

    try {
      const pids = await Promise.race([
        reported,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('Child process did not report PIDs')), 5000)
        ),
      ]);
      cancellation.cancel();
      const out = await running;

      assert.strictEqual(out.cancelled, true);
      assert.strictEqual(out.termination?.terminated, true, JSON.stringify(out.termination));
      assert.strictEqual(isPidAlive(pids.parent), false);
      assert.strictEqual(isPidAlive(pids.grandchild), false);
    } finally {
      if (reportedPids) {
        for (const pid of [reportedPids.grandchild, reportedPids.parent]) {
          if (isPidAlive(pid)) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // Best-effort test cleanup.
            }
          }
        }
      }
    }
  });

  test('consoleOutputEncoding utf8 merges split multibyte UTF-8 on close flush', async () => {
    const ctrl = createControllableSpawn();
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 30_000,
      cancellation: staticCancellation(false),
      consoleOutputEncoding: 'utf8',
      spawnImpl: ctrl.spawnImpl,
    });
    const b = Buffer.from('Я', 'utf8');
    ctrl.pushStdout(b.subarray(0, 1));
    ctrl.pushStdout(b.subarray(1, 2));
    ctrl.close(0, null);
    const out = await p;
    assert.strictEqual(out.combinedLog, 'Я');
  });

  test('consoleOutputEncoding utf16le merges split UTF-16 LE code units on stdout', async () => {
    const ctrl = createControllableSpawn();
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 30_000,
      cancellation: staticCancellation(false),
      consoleOutputEncoding: 'utf16le',
      spawnImpl: ctrl.spawnImpl,
    });
    const b = Buffer.from('Я', 'utf16le');
    ctrl.pushStdout(b.subarray(0, 1));
    ctrl.pushStdout(b.subarray(1, 2));
    ctrl.close(0, null);
    const out = await p;
    assert.strictEqual(out.combinedLog, 'Я');
  });

  test('consoleOutputEncoding oem866 decodes CP866 bytes from stderr', async () => {
    const ctrl = createControllableSpawn();
    const chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 30_000,
      cancellation: staticCancellation(false),
      consoleOutputEncoding: 'oem866',
      onStreamChunk: (text, stream) => chunks.push({ stream, text }),
      spawnImpl: ctrl.spawnImpl,
    });
    const msg = 'Файл не найден';
    ctrl.pushStderr(iconv.encode(msg, 'cp866'));
    ctrl.close(0, null);
    const out = await p;
    assert.ok(out.combinedLog.includes(msg));
    assert.ok(chunks.some((c) => c.stream === 'stderr' && c.text.includes(msg)));
  });

  test('consoleOutputEncoding windows1251 decodes CP1251 stdout', async () => {
    const ctrl = createControllableSpawn();
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 30_000,
      cancellation: staticCancellation(false),
      consoleOutputEncoding: 'windows1251',
      spawnImpl: ctrl.spawnImpl,
    });
    const line = 'Строка ошибки';
    ctrl.pushStdout(iconv.encode(line, 'cp1251'));
    ctrl.close(0, null);
    const out = await p;
    assert.strictEqual(out.combinedLog, line);
  });

  test('timeout flushes UTF-8 streaming decoder tail', async () => {
    const ctrl = createControllableSpawn();
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 80,
      cancellation: staticCancellation(false),
      consoleOutputEncoding: 'utf8',
      spawnImpl: ctrl.spawnImpl,
    });
    const incomplete = Buffer.from([0xf0, 0x9f, 0x98]);
    ctrl.pushStdout(incomplete);
    const out = await p;
    assert.strictEqual(out.timedOut, true);
    assert.ok(out.combinedLog.length > 0);
  });

  test('auto encoding on Windows decodes UTF-8 chunks (piped ibcmd)', async () => {
    if (process.platform !== 'win32') {
      return;
    }
    const ctrl = createControllableSpawn();
    const p = runIbcmdStreaming({
      executablePath: '/ibcmd',
      args: [],
      timeoutMs: 30_000,
      cancellation: staticCancellation(false),
      consoleOutputEncoding: 'auto',
      spawnImpl: ctrl.spawnImpl,
    });
    const line = 'Импорт конфигурации из XML успешно завершен';
    ctrl.pushStdout(Buffer.from(line, 'utf8'));
    ctrl.close(0, null);
    const out = await p;
    assert.ok(out.combinedLog.includes(line));
  });

  test('spawn strips IBCMD_* default-connection vars from child env for explicit --db-path', async () => {
    const prevCfg = process.env.IBCMD_INFOBASE_CONFIG;
    const prevUser = process.env.IBCMD_USER;
    const prevPwd = process.env.IBCMD_PASSWORD;
    process.env.IBCMD_INFOBASE_CONFIG = 'C:\\wrong-infobase.yml';
    process.env.IBCMD_USER = 'envUser';
    process.env.IBCMD_PASSWORD = 'envPwd';
    let childEnv: NodeJS.ProcessEnv | undefined;
    try {
      const spawnImpl = ((_command: string, _args: readonly string[], options: SpawnOptions): ChildProcess => {
        childEnv = options.env;
        const stdoutEE = new PassThrough();
        const stderrEE = new PassThrough();
        const c = new EventEmitter() as ChildProcess;
        (c as unknown as { stdout: PassThrough }).stdout = stdoutEE;
        (c as unknown as { stderr: PassThrough }).stderr = stderrEE;
        (c as unknown as { killed: boolean }).killed = false;
        (c as unknown as { exitCode: number | null }).exitCode = null;
        (c as unknown as { kill: (sig?: NodeJS.Signals) => boolean }).kill = () => true;
        setImmediate(() => c.emit('close', 0, null));
        return c;
      }) as typeof spawn;

      const out = await runIbcmdStreaming({
        executablePath: '/ibcmd',
        args: [
          'infobase',
          'config',
          'import',
          '--db-path=C:\\Bases\\X',
          '--data=C:\\tmp\\d',
          '/src',
        ],
        timeoutMs: 5000,
        cancellation: staticCancellation(false),
        spawnImpl,
      });
      assert.strictEqual(out.exitCode, 0);
      assert.ok(childEnv);
      assert.strictEqual(childEnv!.IBCMD_INFOBASE_CONFIG, undefined);
      assert.strictEqual(childEnv!.IBCMD_USER, undefined);
      assert.strictEqual(childEnv!.IBCMD_PASSWORD, undefined);
      assert.strictEqual(process.env.IBCMD_INFOBASE_CONFIG, 'C:\\wrong-infobase.yml');
      assert.strictEqual(process.env.IBCMD_USER, 'envUser');
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

  test('spawn strips IBCMD_* default-connection vars from child env for explicit --config', async () => {
    const prevCfg = process.env.IBCMD_INFOBASE_CONFIG;
    const prevUser = process.env.IBCMD_USER;
    const prevPwd = process.env.IBCMD_PASSWORD;
    process.env.IBCMD_INFOBASE_CONFIG = 'C:\\wrong-infobase.yml';
    process.env.IBCMD_USER = 'envUser';
    process.env.IBCMD_PASSWORD = 'envPwd';
    let childEnv: NodeJS.ProcessEnv | undefined;
    try {
      const spawnImpl = ((_command: string, _args: readonly string[], options: SpawnOptions): ChildProcess => {
        childEnv = options.env;
        const stdoutEE = new PassThrough();
        const stderrEE = new PassThrough();
        const c = new EventEmitter() as ChildProcess;
        (c as unknown as { stdout: PassThrough }).stdout = stdoutEE;
        (c as unknown as { stderr: PassThrough }).stderr = stderrEE;
        (c as unknown as { killed: boolean }).killed = false;
        (c as unknown as { exitCode: number | null }).exitCode = null;
        (c as unknown as { kill: (sig?: NodeJS.Signals) => boolean }).kill = () => true;
        setImmediate(() => c.emit('close', 0, null));
        return c;
      }) as typeof spawn;

      const out = await runIbcmdStreaming({
        executablePath: '/ibcmd',
        args: ['infobase', 'config', 'import', '--config=/tmp/a.yaml', '/src'],
        timeoutMs: 5000,
        cancellation: staticCancellation(false),
        spawnImpl,
      });
      assert.strictEqual(out.exitCode, 0);
      assert.ok(childEnv);
      assert.strictEqual(childEnv!.IBCMD_INFOBASE_CONFIG, undefined);
      assert.strictEqual(childEnv!.IBCMD_USER, undefined);
      assert.strictEqual(childEnv!.IBCMD_PASSWORD, undefined);
      assert.strictEqual(process.env.IBCMD_INFOBASE_CONFIG, 'C:\\wrong-infobase.yml');
      assert.strictEqual(process.env.IBCMD_USER, 'envUser');
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
