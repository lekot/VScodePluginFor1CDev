import * as assert from 'assert';
import * as http from 'http';
import Module = require('module');
import { createMcpSessionRouter, McpSessionRouter } from '../../src/agent/mcpAdapter/sessionRouter';

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface FakeSdkState {
  readonly connectStarted: Deferred;
  readonly releaseConnect: Deferred;
  serverCount: number;
  transportCount: number;
  serverCloseCount: number;
  transportCloseCount: number;
  transportHandleCount: number;
  initializedCount: number;
}

interface RecordedResponse {
  headersSent: boolean;
  writableEnded: boolean;
  statusCode?: number;
  body: string;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function responseRecorder(): { response: http.ServerResponse; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { headersSent: false, writableEnded: false, body: '' };
  const response = {
    get headersSent(): boolean { return recorded.headersSent; },
    get writableEnded(): boolean { return recorded.writableEnded; },
    writeHead(statusCode: number): unknown {
      recorded.statusCode = statusCode;
      recorded.headersSent = true;
      return this;
    },
    end(chunk?: string | Buffer): unknown {
      if (chunk !== undefined) {
        recorded.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      }
      recorded.writableEnded = true;
      return this;
    },
  } as unknown as http.ServerResponse;
  return { response, recorded };
}

async function createRouterWithFakeSdk(): Promise<{ router: McpSessionRouter; state: FakeSdkState }> {
  const state: FakeSdkState = {
    connectStarted: deferred(),
    releaseConnect: deferred(),
    serverCount: 0,
    transportCount: 0,
    serverCloseCount: 0,
    transportCloseCount: 0,
    transportHandleCount: 0,
    initializedCount: 0,
  };

  class FakeMcpServer {
    constructor() { state.serverCount += 1; }
    registerTool(): void {}
    async connect(): Promise<void> {
      state.connectStarted.resolve();
      await state.releaseConnect.promise;
    }
    async close(): Promise<void> { state.serverCloseCount += 1; }
  }

  class FakeTransport {
    sessionId: string | undefined;
    onclose: (() => void) | undefined;
    private readonly onInitialized: (sessionId: string) => void;

    constructor(options: { onsessioninitialized(sessionId: string): void }) {
      state.transportCount += 1;
      this.onInitialized = options.onsessioninitialized;
    }

    async handleRequest(): Promise<void> {
      state.transportHandleCount += 1;
      this.sessionId = 'fake-session';
      state.initializedCount += 1;
      this.onInitialized(this.sessionId);
    }

    async close(): Promise<void> {
      state.transportCloseCount += 1;
      this.onclose?.();
    }
  }

  const moduleLoader = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === '@modelcontextprotocol/sdk/server/mcp.js') {
      return { McpServer: FakeMcpServer };
    }
    if (request === '@modelcontextprotocol/sdk/server/streamableHttp.js') {
      return { StreamableHTTPServerTransport: FakeTransport };
    }
    if (request === '@modelcontextprotocol/sdk/types.js') {
      return { isInitializeRequest: (body: unknown) => (body as { valid?: boolean })?.valid === true };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const router = await createMcpSessionRouter({ version: 'race-test' });
    return { router, state };
  } finally {
    moduleLoader._load = originalLoad;
  }
}

function request(): http.IncomingMessage {
  return { method: 'POST', headers: {} } as unknown as http.IncomingMessage;
}

suite('MCP session router: pending initialization lifecycle', () => {
  test('invalid initialize does not allocate a server/transport pair', async () => {
    const { router, state } = await createRouterWithFakeSdk();
    const { response, recorded } = responseRecorder();

    await router.handleRequest(request(), response, { valid: false });

    assert.strictEqual(recorded.statusCode, 400);
    assert.strictEqual(state.serverCount, 0);
    assert.strictEqual(state.transportCount, 0);
    state.releaseConnect.resolve();
    await router.close();
  });

  test('close racing a pending create prevents registration and closes the pair exactly once', async () => {
    const { router, state } = await createRouterWithFakeSdk();
    const { response, recorded } = responseRecorder();
    const initialization = router.handleRequest(request(), response, { valid: true });
    await state.connectStarted.promise;

    await router.close();
    state.releaseConnect.resolve();
    await initialization;

    assert.strictEqual(recorded.statusCode, 503);
    assert.strictEqual(state.serverCount, 1);
    assert.strictEqual(state.transportCount, 1);
    assert.strictEqual(state.transportHandleCount, 0, 'closed router must not initialize/register a session');
    assert.strictEqual(state.initializedCount, 0);
    assert.strictEqual(state.transportCloseCount, 1);
    assert.strictEqual(state.serverCloseCount, 1);
  });
});
