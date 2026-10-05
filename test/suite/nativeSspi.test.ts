import * as assert from 'assert';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { WindowsSspiAuthenticator } from '../../src/services/forms/nativeSspi';

interface FakeHelperOptions {
  respond?: boolean;
  closeInput?: boolean;
  failSpawn?: boolean;
}

class FakeHelperProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 456;
  exitCode: number | null = null;
  killed = false;
  readonly received: string[] = [];

  constructor(options: FakeHelperOptions) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.received.push(line);
        if (line === 'dispose') this.exitSoon(0);
        else if (options.respond) this.stdout.write('OK:MORE:dG9rZW4=\n');
      }
    });
    if (!options.failSpawn) process.nextTick(() => this.stdout.write('READY\n'));
    if (options.closeInput) {
      setTimeout(() => this.stdin.destroy(Object.assign(new Error('EPIPE'), { code: 'EPIPE' })), 1);
    }
    if (options.failSpawn) {
      this.pid = undefined;
      process.nextTick(() => this.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })));
    }
  }

  kill(): boolean {
    this.killed = true;
    this.exitSoon(1);
    return true;
  }

  private exitSoon(code: number): void {
    if (this.exitCode !== null) return;
    setImmediate(() => {
      this.exitCode = code;
      this.emit('exit', code, null);
    });
  }
}

function makeAuthenticator(options: FakeHelperOptions & { timeoutMs?: number } = {}) {
  let child: FakeHelperProcess | undefined;
  const spawnProcess = (() => {
    child = new FakeHelperProcess(options);
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof import('child_process').spawn;
  const authenticator = new WindowsSspiAuthenticator({
    platform: 'win32',
    spawnProcess,
    responseTimeoutMs: options.timeoutMs ?? 50,
    startupTimeoutMs: 50,
  });
  return { authenticator, getChild: () => child! };
}

suite('Windows SSPI helper lifecycle', () => {
  test('exchanges opaque tokens and exits cleanly on dispose', async () => {
    const { authenticator, getChild } = makeAuthenticator({ respond: true });
    const result = await authenticator.nextToken();

    assert.strictEqual(result.complete, false);
    assert.strictEqual(result.token.toString('utf8'), 'token');
    assert.deepStrictEqual(getChild().received, ['start']);
    await authenticator.dispose();
    assert.ok(getChild().received.includes('dispose'));
    assert.strictEqual(getChild().killed, false);
  });

  test('aborting an in-flight token exchange closes its helper process', async () => {
    const { authenticator, getChild } = makeAuthenticator();
    const controller = new AbortController();
    const pending = authenticator.nextToken(undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(getChild().received.includes('dispose'));
    await authenticator.dispose();
  });

  test('a helper response timeout terminates the helper', async () => {
    const { authenticator, getChild } = makeAuthenticator({ timeoutMs: 10 });

    await assert.rejects(authenticator.nextToken(), /Таймаут ответа Windows SSPI helper/);
    assert.ok(getChild().received.includes('dispose'));
    await authenticator.dispose();
  });

  test('closed stdin and a failed spawn are handled without unhandled pipe errors', async () => {
    const closedPipe = makeAuthenticator({ closeInput: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(closedPipe.authenticator.nextToken(), /EPIPE|input is closed/i);
    await closedPipe.authenticator.dispose();

    const failedSpawn = makeAuthenticator({ failSpawn: true });
    await assert.rejects(failedSpawn.authenticator.nextToken(), /spawn failed|SSPI helper/i);
    await assert.doesNotReject(failedSpawn.authenticator.dispose());
  });
});
