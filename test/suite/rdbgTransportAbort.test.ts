import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import { RdbgTransport } from '../../src/debug/rdbg/rdbgTransport';
import { BslDebugSession } from '../../src/debug/bslDebugSession';

suite('RdbgTransport and disconnect abort (#188)', () => {
  test('abortPending() cancels an in-flight hanging request without timeout', async () => {
    let fetchAborted = false;
    let fetchCalled = false;

    const mockFetch = (_input: any, init?: RequestInit): Promise<Response> => {
      fetchCalled = true;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          fetchAborted = true;
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      });
    };

    // timeoutMs = 0 (default: no timeout)
    const transport = new RdbgTransport('http://localhost:1234', 'test-ui-id', mockFetch as any, 0);

    let sendError: Error | undefined;
    const sendPromise = transport.send('testCmd', '<xml/>').catch((err) => {
      sendError = err;
    });

    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(fetchCalled, true, 'fetch must be called');
    assert.strictEqual(fetchAborted, false, 'fetch must not be aborted before abortPending');

    transport.abortPending();
    await sendPromise;

    assert.strictEqual(fetchAborted, true, 'fetch signal must receive abort');
    assert.ok(sendError, 'send() must reject when aborted');
    assert.ok(sendError!.message.includes('aborted'), `Expected abort error message, got: ${sendError?.message}`);
  });

  test('dispose() cancels active in-flight request and rejects subsequent sends', async () => {
    let fetchAborted = false;

    const mockFetch = (_input: any, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          fetchAborted = true;
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      });
    };

    const transport = new RdbgTransport('http://localhost:1234', 'test-ui-id', mockFetch as any, 0);

    let sendError: Error | undefined;
    const sendPromise = transport.send('testCmd', '<xml/>').catch((err) => {
      sendError = err;
    });

    await new Promise((r) => setTimeout(r, 20));
    transport.dispose();
    await sendPromise;

    assert.strictEqual(fetchAborted, true, 'fetch must be aborted on transport dispose');
    assert.ok(sendError, 'send() must reject on dispose');

    // Subsequent send should reject immediately
    await assert.rejects(
      async () => transport.send('anotherCmd', '<xml/>'),
      /disposed|aborted/
    );
  });

  test('BslDebugSession._doDisconnect cleans up launcher even when client.detach hangs', async () => {
    const session = new BslDebugSession();

    let launcherDisposed = false;
    const mockLauncher = {
      dispose: async () => {
        launcherDisposed = true;
      },
    };

    // Client whose detach() hangs indefinitely
    const mockClient = {
      stopPolling: () => {},
      detach: () => new Promise<void>(() => {}), // never resolves
    };

    const mockTransport = {
      abortPending: () => {},
      dispose: () => {},
    };

    (session as any)._launcher = mockLauncher;
    (session as any)._client = mockClient;
    (session as any)._transport = mockTransport;

    const start = Date.now();
    await (session as any)._doDisconnect();
    const elapsed = Date.now() - start;

    assert.strictEqual(launcherDisposed, true, 'Launcher must be disposed');
    assert.ok(elapsed < 4000, `_doDisconnect must complete within bounded timeout, took ${elapsed}ms`);
  });
});
