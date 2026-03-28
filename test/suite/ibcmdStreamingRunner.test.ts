import * as assert from 'assert';
import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { PassThrough } from 'stream';
import {
  IBCMD_STREAM_RING_BUFFER_MAX_BYTES,
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
  pushStdout: (s: string) => void;
  pushStderr: (s: string) => void;
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
    pushStdout: (s: string) => {
      stdoutEE.write(s);
    },
    pushStderr: (s: string) => {
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
});
