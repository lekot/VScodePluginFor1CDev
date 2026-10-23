import * as assert from 'assert';
import * as http from 'http';
import Module = require('module');
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  StreamableHTTPServerTransport,
  StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AgentBridge } from '../../src/agent/agentBridge';
import {
  createMcpSessionRouter,
  McpSessionRouter,
  McpSessionRouterOptions,
} from '../../src/agent/mcpAdapter/sessionRouter';

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

    let closeSettled = false;
    const closing = router.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    const closeSettledBeforeConnect = closeSettled;
    const transportClosesBeforeConnect = state.transportCloseCount;
    state.releaseConnect.resolve();
    await Promise.all([initialization, closing]);

    assert.strictEqual(closeSettledBeforeConnect, false, 'shutdown waits for an in-flight SDK connect');
    assert.strictEqual(transportClosesBeforeConnect, 0, 'cleanup waits until SDK connect settles');
    assert.strictEqual(recorded.statusCode, 503);
    assert.strictEqual(state.serverCount, 1);
    assert.strictEqual(state.transportCount, 1);
    assert.strictEqual(state.transportHandleCount, 0, 'closed router must not initialize/register a session');
    assert.strictEqual(state.initializedCount, 0);
    assert.strictEqual(state.transportCloseCount, 1);
    assert.strictEqual(state.serverCloseCount, 1);
  });
});

interface DeferredVoid {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface TestTimer {
  readonly callback: () => void;
  readonly intervalMs: number;
  unrefCalls: number;
  cleared: boolean;
  unref(): void;
}

interface TestClock {
  now(): number;
  setInterval(callback: () => void, intervalMs: number): TestTimer;
  clearInterval(timer: TestTimer): void;
  advance(milliseconds: number): void;
  fire(): void;
  readonly timers: TestTimer[];
}

interface McpRouterSettings {
  readonly maxSessions?: number;
  readonly idleTimeoutMs?: number;
  readonly initializationTimeoutMs?: number;
  readonly sweepIntervalMs?: number;
}

interface McpRouterTestDependencies {
  readonly clock: Pick<TestClock, 'now' | 'setInterval' | 'clearInterval'>;
  readonly sdkFactory: {
    createServer(options: ConstructorParameters<typeof McpServer>[0]): McpServer;
    createTransport(options: StreamableHTTPServerTransportOptions): StreamableHTTPServerTransport;
  };
}

interface RealSdkState {
  serverAllocations: number;
  transportAllocations: number;
  connectStarted: number;
  transportCloseCalls: number;
  serverCloseCalls: number;
  responseFinishCalls: number;
  responseCloseCalls: number;
  sessionIds: string[];
  readonly firstConnectStarted: DeferredVoid;
  readonly firstInitializeCallback: DeferredVoid;
  readonly firstSessionCloseCallback: DeferredVoid;
  readonly firstTransportCloseStarted: DeferredVoid;
  readonly firstServerCloseStarted: DeferredVoid;
  readonly firstResponseClose: DeferredVoid;
  readonly firstToolStarted: DeferredVoid;
  readonly firstToolFinished: DeferredVoid;
}

interface RealSdkBehavior {
  readonly connectGate?: DeferredVoid;
  readonly initializeCallbackGate?: DeferredVoid;
  readonly cleanupGate?: DeferredVoid;
  readonly executeCommand?: McpSessionRouterOptions['executeCommand'];
  readonly releaseGates?: readonly (() => void)[];
}

interface RealMcpHarness {
  readonly bridge: AgentBridge;
  readonly clock: TestClock;
  readonly state: RealSdkState;
  readonly port: number;
  readonly token: string;
  readonly getRouter: () => McpSessionRouter;
  releaseAll(): void;
}

interface HttpResult {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

const createRouterWithTestDependencies = createMcpSessionRouter as unknown as (
  options: McpSessionRouterOptions & McpRouterSettings,
  dependencies: McpRouterTestDependencies,
) => Promise<McpSessionRouter>;

function deferredVoid(): DeferredVoid {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function controlledClock(initialTime = 1_000): TestClock {
  let currentTime = initialTime;
  const timers: TestTimer[] = [];
  return {
    now: () => currentTime,
    setInterval(callback, intervalMs): TestTimer {
      const timer: TestTimer = {
        callback,
        intervalMs,
        unrefCalls: 0,
        cleared: false,
        unref(): void { this.unrefCalls += 1; },
      };
      timers.push(timer);
      return timer;
    },
    clearInterval(timer): void {
      timer.cleared = true;
    },
    advance(milliseconds): void {
      currentTime += milliseconds;
    },
    fire(): void {
      for (const timer of timers) {
        if (!timer.cleared) {
          timer.callback();
        }
      }
    },
    timers,
  };
}

function createRealSdkState(): RealSdkState {
  return {
    serverAllocations: 0,
    transportAllocations: 0,
    connectStarted: 0,
    transportCloseCalls: 0,
    serverCloseCalls: 0,
    responseFinishCalls: 0,
    responseCloseCalls: 0,
    sessionIds: [],
    firstConnectStarted: deferredVoid(),
    firstInitializeCallback: deferredVoid(),
    firstSessionCloseCallback: deferredVoid(),
    firstTransportCloseStarted: deferredVoid(),
    firstServerCloseStarted: deferredVoid(),
    firstResponseClose: deferredVoid(),
    firstToolStarted: deferredVoid(),
    firstToolFinished: deferredVoid(),
  };
}

function trackedTransportOptions(
  options: StreamableHTTPServerTransportOptions,
  state: RealSdkState,
  behavior: RealSdkBehavior,
): StreamableHTTPServerTransportOptions {
  return {
    ...options,
    onsessioninitialized: async (sessionId): Promise<void> => {
      state.sessionIds.push(sessionId);
      state.firstInitializeCallback.resolve();
      await behavior.initializeCallbackGate?.promise;
      await options.onsessioninitialized?.(sessionId);
    },
    onsessionclosed: async (sessionId): Promise<void> => {
      state.firstSessionCloseCallback.resolve();
      await options.onsessionclosed?.(sessionId);
    },
  };
}

function trackServer(server: McpServer, state: RealSdkState, behavior: RealSdkBehavior): McpServer {
  const connect = server.connect.bind(server);
  server.connect = async (transport): Promise<void> => {
    state.connectStarted += 1;
    state.firstConnectStarted.resolve();
    await behavior.connectGate?.promise;
    await connect(transport);
  };
  const close = server.close.bind(server);
  server.close = async (): Promise<void> => {
    state.serverCloseCalls += 1;
    state.firstServerCloseStarted.resolve();
    await behavior.cleanupGate?.promise;
    await close();
  };
  return server;
}

function trackTransport(
  transport: StreamableHTTPServerTransport,
  state: RealSdkState,
  behavior: RealSdkBehavior,
): StreamableHTTPServerTransport {
  const close = transport.close.bind(transport);
  transport.close = async (): Promise<void> => {
    state.transportCloseCalls += 1;
    state.firstTransportCloseStarted.resolve();
    await behavior.cleanupGate?.promise;
    await close();
  };
  return transport;
}

function trackRouterResponses(router: McpSessionRouter, state: RealSdkState): McpSessionRouter {
  const handleRequest = router.handleRequest.bind(router);
  router.handleRequest = async (req, res, parsedBody): Promise<void> => {
    res.once('finish', () => { state.responseFinishCalls += 1; });
    res.once('close', () => {
      state.responseCloseCalls += 1;
      state.firstResponseClose.resolve();
    });
    await handleRequest(req, res, parsedBody);
  };
  return router;
}

function installLegacySdkTestAdapters(state: RealSdkState, behavior: RealSdkBehavior): () => void {
  class InstrumentedMcpServer extends McpServer {
    constructor(options: ConstructorParameters<typeof McpServer>[0]) {
      super(options);
      state.serverAllocations += 1;
      trackServer(this, state, behavior);
    }
  }

  class InstrumentedStreamableHTTPServerTransport extends StreamableHTTPServerTransport {
    constructor(options: StreamableHTTPServerTransportOptions) {
      super(trackedTransportOptions(options, state, behavior));
      state.transportAllocations += 1;
      trackTransport(this, state, behavior);
    }
  }

  const moduleLoader = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    const loaded = originalLoad.call(this, request, parent, isMain);
    if (request === '@modelcontextprotocol/sdk/server/mcp.js') {
      return { ...(loaded as object), McpServer: InstrumentedMcpServer };
    }
    if (request === '@modelcontextprotocol/sdk/server/streamableHttp.js') {
      return {
        ...(loaded as object),
        StreamableHTTPServerTransport: InstrumentedStreamableHTTPServerTransport,
      };
    }
    return loaded;
  };
  return () => { moduleLoader._load = originalLoad; };
}

async function createRealMcpHarness(
  settings: McpRouterSettings = {},
  behavior: RealSdkBehavior = {},
): Promise<RealMcpHarness> {
  const state = createRealSdkState();
  const clock = controlledClock();
  let router: McpSessionRouter | undefined;
  const dependencies: McpRouterTestDependencies = {
    clock,
    sdkFactory: {
      createServer(options): McpServer {
        state.serverAllocations += 1;
        return trackServer(new McpServer(options), state, behavior);
      },
      createTransport(options): StreamableHTTPServerTransport {
        state.transportAllocations += 1;
        return trackTransport(
          new StreamableHTTPServerTransport(trackedTransportOptions(options, state, behavior)),
          state,
          behavior,
        );
      },
    },
  };
  const bridge = new AgentBridge({
    commandPattern: /^test\./,
    mcpRouterFactory: async (options) => {
      const restoreSdkAdapters = installLegacySdkTestAdapters(state, behavior);
      try {
        const createdRouter = await createRouterWithTestDependencies({
          ...options,
          ...settings,
          executeCommand: behavior.executeCommand ?? (async () => ({ success: true, data: {} })),
        }, dependencies);
        router = trackRouterResponses(createdRouter, state);
        return router;
      } finally {
        restoreSdkAdapters();
      }
    },
  });
  const { port, token } = await bridge.start();
  return {
    bridge,
    clock,
    state,
    port,
    token,
    getRouter: () => {
      assert.ok(router, 'bridge factory should have created the router');
      return router;
    },
    releaseAll(): void {
      behavior.connectGate?.resolve();
      behavior.initializeCallbackGate?.resolve();
      behavior.cleanupGate?.resolve();
      for (const releaseGate of behavior.releaseGates ?? []) {
        releaseGate();
      }
    },
  };
}

function jsonRpcHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
}

function initializeBody(id = 1): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'session-router-race-test', version: '1.0.0' },
    },
  });
}

function toolCallBody(id = 10): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'cdt_read',
      arguments: { operation: 'cdt_list_configurations', arguments: {} },
    },
  });
}

function postHeaders(token: string, sessionId?: string): Record<string, string> {
  return {
    ...jsonRpcHeaders(token),
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  };
}

function httpRequest(
  port: number,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: '/mcp', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    if (body === undefined) {
      request.end();
    } else {
      request.end(body);
    }
  });
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function assertDefaultSweep(harness: RealMcpHarness): void {
  assert.strictEqual(harness.clock.timers.length, 1, 'the router owns one periodic sweep');
  assert.strictEqual(harness.clock.timers[0].intervalMs, 60_000);
  assert.strictEqual(harness.clock.timers[0].unrefCalls, 1);
}

function createOfficialClient(port: number, token: string): {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
} {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'session-router-lifecycle-test', version: '1.0.0' });
  return { client, transport };
}

function openSseRequest(port: number, token: string, sessionId: string): {
  readonly request: http.ClientRequest;
  readonly response: Promise<{ readonly status: number; readonly closed: Promise<void> }>;
  readonly isClosed: () => boolean;
} {
  let closed = false;
  let clientRequest!: http.ClientRequest;
  const response = new Promise<{ readonly status: number; readonly closed: Promise<void> }>((resolve, reject) => {
    clientRequest = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/mcp',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        'Mcp-Session-Id': sessionId,
        'MCP-Protocol-Version': '2025-06-18',
      },
    }, (res) => {
      const closedPromise = new Promise<void>((done) => {
        const markClosed = (): void => {
          closed = true;
          done();
        };
        res.once('end', markClosed);
        res.once('close', markClosed);
        res.once('error', markClosed);
      });
      res.resume();
      resolve({ status: res.statusCode ?? 0, closed: closedPromise });
    });
    clientRequest.once('error', reject);
    clientRequest.end();
  });
  return {
    request: clientRequest,
    response,
    isClosed: () => closed,
  };
}

suite('MCP session router: bounded lifetime with real SDK and HTTP', function () {
  this.timeout(15_000);

  const harnesses: RealMcpHarness[] = [];

  teardown(async () => {
    for (const harness of harnesses.splice(0)) {
      harness.releaseAll();
      await harness.bridge.stop();
    }
  });

  async function startHarness(
    settings: McpRouterSettings = {},
    behavior: RealSdkBehavior = {},
  ): Promise<RealMcpHarness> {
    const harness = await createRealMcpHarness(settings, behavior);
    harnesses.push(harness);
    return harness;
  }

  test('rejects every non-finite or non-positive-integer limit before allocating SDK objects', async () => {
    const state = createRealSdkState();
    const clock = controlledClock();
    const dependencies: McpRouterTestDependencies = {
      clock,
      sdkFactory: {
        createServer: (options) => {
          state.serverAllocations += 1;
          return new McpServer(options);
        },
        createTransport: (options) => {
          state.transportAllocations += 1;
          return new StreamableHTTPServerTransport(options);
        },
      },
    };
    const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
    const settings: Array<keyof Required<McpRouterSettings>> = [
      'maxSessions',
      'idleTimeoutMs',
      'initializationTimeoutMs',
      'sweepIntervalMs',
    ];

    for (const key of settings) {
      for (const value of invalidValues) {
        await assert.rejects(
          createRouterWithTestDependencies({
            version: 'invalid-options-test',
            [key]: value,
          } as McpSessionRouterOptions & McpRouterSettings, dependencies),
          `${key}=${String(value)} must be rejected`,
        );
      }
    }

    assert.strictEqual(state.serverAllocations, 0);
    assert.strictEqual(state.transportAllocations, 0);
    assert.strictEqual(clock.timers.length, 0, 'invalid configuration must not allocate its sweep timer');
  });

  test('uses one unrefed default sweep and rejects the 33rd pending session before SDK allocation', async () => {
    const connectGate = deferredVoid();
    const harness = await startHarness({}, { connectGate });
    const pending = Array.from({ length: 32 }, (_, index) => httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(index + 1),
    ));

    await waitFor(() => harness.state.serverAllocations === 32, '32 pending SDK server allocations');
    await waitFor(() => harness.state.connectStarted === 32, 'all 32 initializations to reach the connect gate');
    assert.strictEqual(harness.state.transportAllocations, 32);
    let overflowFinished = false;
    const overflowPromise = httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(33),
    ).then((response) => {
      overflowFinished = true;
      return response;
    });
    await waitFor(
      () => harness.state.serverAllocations > 32 || overflowFinished,
      'capacity decision for the 33rd pending session',
    );
    assert.strictEqual(harness.state.serverAllocations, 32, 'overload must be rejected before server allocation');
    const overflow = await overflowPromise;
    assert.strictEqual(overflow.status, 503);
    assert.match(overflow.headers['content-type'] ?? '', /application\/json/i);
    const error = JSON.parse(overflow.body) as {
      jsonrpc?: string;
      id?: unknown;
      error?: { code?: number; message?: string };
    };
    assert.strictEqual(error.jsonrpc, '2.0');
    assert.strictEqual(error.id, 33, 'overload error preserves the JSON-RPC request ID');
    assert.ok(error.error && Number.isInteger(error.error.code));
    assert.ok(error.error.message);
    assert.strictEqual(harness.state.transportAllocations, 32, 'overload must be rejected before transport allocation');
    assertDefaultSweep(harness);

    connectGate.resolve();
    const initialized = await Promise.all(pending);
    assert.ok(initialized.every((response) => response.status === 200));
  });

  test('counts an active session against the cap before allocating another SDK pair', async () => {
    const harness = await startHarness({ maxSessions: 1 });
    const { client, transport } = createOfficialClient(harness.port, harness.token);
    await client.connect(transport);
    assert.ok(transport.sessionId);

    const overflow = await httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(2),
    );
    assert.strictEqual(overflow.status, 503);
    assert.strictEqual(harness.state.serverAllocations, 1);
    assert.strictEqual(harness.state.transportAllocations, 1);
    await client.close().catch(() => undefined);
  });

  test('keeps an expired pending connect reserved until it settles, then permits a fresh session', async () => {
    const connectGate = deferredVoid();
    const harness = await startHarness(
      { maxSessions: 1, initializationTimeoutMs: 100 },
      { connectGate },
    );
    const pending = httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(1),
    );
    void pending.catch(() => undefined);
    await waitFor(() => harness.state.connectStarted === 1, 'pending SDK connect before initialization deadline');

    harness.clock.advance(101);
    harness.clock.fire();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closeCallsBeforeConnectSettles = harness.state.transportCloseCalls;
    let overflowFinished = false;
    const overflowPromise = httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(2),
    ).then((response) => {
      overflowFinished = true;
      return response;
    });
    await waitFor(
      () => harness.state.serverAllocations > 1 || overflowFinished,
      'capacity decision while the expired connect is unresolved',
    );
    const allocationsBeforeConnectSettles = harness.state.serverAllocations;

    connectGate.resolve();
    await pending.catch(() => undefined);
    const overflow = await overflowPromise;
    await waitFor(() => harness.state.transportCloseCalls >= 1, 'expired pending transport cleanup');
    await waitFor(() => harness.state.serverCloseCalls >= 1, 'expired pending server cleanup');

    assert.strictEqual(overflow.status, 503, 'an expired but connecting reservation still occupies capacity');
    assert.strictEqual(allocationsBeforeConnectSettles, 1, 'no second SDK pair is allocated while connect is unresolved');
    assert.strictEqual(harness.state.transportAllocations, 1);
    assert.strictEqual(closeCallsBeforeConnectSettles, 0, 'the pair is not closed while SDK connect is in flight');
    assert.strictEqual(harness.state.transportCloseCalls, 1);
    assert.strictEqual(harness.state.serverCloseCalls, 1);
    assert.strictEqual(harness.state.sessionIds.length, 0, 'the expired connect cannot register a live session');

    const admitted = await httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(3),
    );
    assert.strictEqual(admitted.status, 200, 'capacity is released after connect and cleanup settle');
    assert.strictEqual(harness.state.serverAllocations, 2);
    assert.strictEqual(harness.state.transportAllocations, 2);
  });

  test('shutdown waits for a pending SDK connect and closes its pair exactly once after release', async () => {
    const connectGate = deferredVoid();
    const harness = await startHarness({ maxSessions: 1 }, { connectGate });
    const pending = httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(1),
    );
    void pending.catch(() => undefined);
    await waitFor(() => harness.state.connectStarted === 1, 'SDK connect before router shutdown');

    const router = harness.getRouter();
    let closeSettled = false;
    const closing = router.close().then(() => { closeSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closeSettledBeforeConnect = closeSettled;
    const transportClosesBeforeConnect = harness.state.transportCloseCalls;
    const serverClosesBeforeConnect = harness.state.serverCloseCalls;
    const rejected = await httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(2),
    );
    assert.strictEqual(rejected.status, 503, 'shutdown stops admission while existing connect drains');
    assert.strictEqual(harness.state.serverAllocations, 1);
    assert.strictEqual(harness.state.transportAllocations, 1);

    connectGate.resolve();
    await Promise.all([pending.catch(() => undefined), closing]);
    await waitFor(() => harness.state.transportCloseCalls === 1, 'shutdown transport cleanup');
    await waitFor(() => harness.state.serverCloseCalls === 1, 'shutdown server cleanup');
    assert.strictEqual(closeSettledBeforeConnect, false, 'router close remains pending until SDK connect settles');
    assert.strictEqual(transportClosesBeforeConnect, 0);
    assert.strictEqual(serverClosesBeforeConnect, 0);
    assert.strictEqual(harness.state.transportCloseCalls, 1);
    assert.strictEqual(harness.state.serverCloseCalls, 1);
    assert.strictEqual(harness.state.sessionIds.length, 0, 'a connect finishing after shutdown cannot resurrect a session');
  });

  test('counts a session being deleted until its one-time cleanup finishes', async () => {
    const cleanupGate = deferredVoid();
    const harness = await startHarness({ maxSessions: 1 }, { cleanupGate });
    const { client, transport } = createOfficialClient(harness.port, harness.token);
    await client.connect(transport);
    const sessionId = transport.sessionId;
    assert.ok(sessionId);

    const deleteRequest = httpRequest(
      harness.port,
      'DELETE',
      { Authorization: `Bearer ${harness.token}`, 'Mcp-Session-Id': sessionId },
    );
    await harness.state.firstTransportCloseStarted.promise;
    assert.strictEqual(harness.state.transportCloseCalls, 1);

    const overflow = await httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(2),
    );
    assert.strictEqual(overflow.status, 503, 'closing session still occupies the sole slot');
    assert.strictEqual(harness.state.serverAllocations, 1);
    assert.strictEqual(harness.state.transportAllocations, 1);

    cleanupGate.resolve();
    const deleted = await deleteRequest;
    assert.strictEqual(deleted.status, 200);
    assert.strictEqual(harness.state.transportCloseCalls, 1);
    assert.strictEqual(harness.state.serverCloseCalls, 1);
    await client.close().catch(() => undefined);
  });

  test('expires an idle session at the default cutoff and answers later requests with 404', async () => {
    const harness = await startHarness();
    assertDefaultSweep(harness);
    const { client, transport } = createOfficialClient(harness.port, harness.token);
    await client.connect(transport);
    const sessionId = transport.sessionId;
    assert.ok(sessionId);

    harness.clock.advance(30 * 60_000);
    harness.clock.fire();
    await waitFor(() => harness.state.transportCloseCalls === 1, 'idle session cleanup');
    assert.strictEqual(harness.state.serverCloseCalls, 1);

    const expired = await httpRequest(
      harness.port,
      'GET',
      { Authorization: `Bearer ${harness.token}`, 'Mcp-Session-Id': sessionId },
    );
    assert.strictEqual(expired.status, 404);
    await client.close().catch(() => undefined);
  });

  test('starts the idle interval again when a slow tool response finishes', async () => {
    const executionGate = deferredVoid();
    const toolStarted = deferredVoid();
    const harness = await startHarness({}, {
      executeCommand: async () => {
        toolStarted.resolve();
        await executionGate.promise;
        return { success: true, data: {} };
      },
      releaseGates: [() => executionGate.resolve()],
    });
    assertDefaultSweep(harness);
    const initialized = await httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(),
    );
    assert.strictEqual(initialized.status, 200);
    const sessionId = initialized.headers['mcp-session-id'];
    assert.strictEqual(typeof sessionId, 'string');
    const toolResponse = httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token, sessionId as string),
      toolCallBody(),
    );
    await toolStarted.promise;

    harness.clock.advance(30 * 60_000 + 1);
    harness.clock.fire();
    assert.strictEqual(harness.state.transportCloseCalls, 0, 'active response and tool execution prevent expiry');
    executionGate.resolve();
    await toolResponse;
    await waitFor(() => harness.state.responseFinishCalls >= 2, 'tool response finish event');
    await new Promise<void>((resolve) => setImmediate(resolve));

    harness.clock.advance(30 * 60_000 - 1);
    harness.clock.fire();
    assert.strictEqual(harness.state.transportCloseCalls, 0, 'response finish refreshes the idle deadline');
    harness.clock.advance(2);
    harness.clock.fire();
    await waitFor(() => harness.state.transportCloseCalls === 1, 'idle cleanup after completed tool response');
    const expired = await httpRequest(
      harness.port,
      'GET',
      { Authorization: `Bearer ${harness.token}`, 'Mcp-Session-Id': sessionId as string },
    );
    assert.strictEqual(expired.status, 404);
  });

  test('does not expire while an SSE response is open, then expires after its close and idle period', async () => {
    const harness = await startHarness();
    assertDefaultSweep(harness);
    const initialized = await httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(),
    );
    assert.strictEqual(initialized.status, 200);
    const sessionId = initialized.headers['mcp-session-id'];
    assert.strictEqual(typeof sessionId, 'string');
    const stream = openSseRequest(harness.port, harness.token, sessionId as string);
    const opened = await stream.response;
    assert.ok(opened.status === 200 || opened.status === 409, `unexpected SSE status ${opened.status}`);
    assert.strictEqual(opened.status, 200, 'the fixture must hold a live response, not reuse an existing stream');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(stream.isClosed(), false);

    harness.clock.advance(30 * 60_000 + 1);
    harness.clock.fire();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(harness.state.transportCloseCalls, 0, 'a live response prevents idle eviction');

    stream.request.destroy();
    await opened.closed;
    harness.clock.advance(30 * 60_000);
    harness.clock.fire();
    await waitFor(() => harness.state.transportCloseCalls === 1, 'SSE-idle session cleanup after close');
    const expired = await httpRequest(
      harness.port,
      'GET',
      { Authorization: `Bearer ${harness.token}`, 'Mcp-Session-Id': sessionId as string },
    );
    assert.strictEqual(expired.status, 404);
  });

  test('keeps a tool execution alive after its HTTP client disconnects, then expires it after completion', async () => {
    const executionGate = deferredVoid();
    const toolStarted = deferredVoid();
    const toolFinished = deferredVoid();
    const harness = await startHarness({}, {
      executeCommand: async () => {
        toolStarted.resolve();
        await executionGate.promise;
        toolFinished.resolve();
        return { success: true, data: {} };
      },
      releaseGates: [() => executionGate.resolve()],
    });
    assertDefaultSweep(harness);
    const initialized = await httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(),
    );
    assert.strictEqual(initialized.status, 200);
    const sessionId = initialized.headers['mcp-session-id'];
    assert.strictEqual(typeof sessionId, 'string');
    const request = http.request({
      host: '127.0.0.1',
      port: harness.port,
      method: 'POST',
      path: '/mcp',
      headers: {
        ...postHeaders(harness.token, sessionId as string),
        'MCP-Protocol-Version': '2025-06-18',
      },
    });
    request.on('error', () => undefined);
    request.end(toolCallBody());
    await toolStarted.promise;
    const closeEventsBeforeTool = harness.state.responseCloseCalls;
    request.destroy();
    await waitFor(
      () => harness.state.responseCloseCalls > closeEventsBeforeTool,
      'HTTP response close while the tool remains in flight',
    );

    harness.clock.advance(30 * 60_000 + 1);
    harness.clock.fire();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(harness.state.transportCloseCalls, 0);

    executionGate.resolve();
    await toolFinished.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    harness.clock.advance(30 * 60_000);
    harness.clock.fire();
    await waitFor(() => harness.state.transportCloseCalls === 1, 'cleanup after tool execution and idle period');
    const expired = await httpRequest(
      harness.port,
      'GET',
      { Authorization: `Bearer ${harness.token}`, 'Mcp-Session-Id': sessionId as string },
    );
    assert.strictEqual(expired.status, 404);
  });

  test('expires a pending initialization at 30 seconds and rejects its late registration callback', async () => {
    const initializeCallbackGate = deferredVoid();
    const harness = await startHarness({}, { initializeCallbackGate });
    assertDefaultSweep(harness);
    const pendingResponse = httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(),
    );
    void pendingResponse.catch(() => undefined);
    await harness.state.firstInitializeCallback.promise;
    assert.strictEqual(harness.state.sessionIds.length, 1);
    const sessionId = harness.state.sessionIds[0];

    harness.clock.advance(30_001);
    harness.clock.fire();
    await waitFor(() => harness.state.transportCloseCalls === 1, 'pending initialization deadline cleanup');

    initializeCallbackGate.resolve();
    const lateLookup = await httpRequest(
      harness.port,
      'GET',
      { Authorization: `Bearer ${harness.token}`, 'Mcp-Session-Id': sessionId },
    );
    assert.strictEqual(lateLookup.status, 404, 'late SDK callback must not resurrect an expired session');
    assert.strictEqual(harness.state.transportCloseCalls, 1);
    assert.strictEqual(harness.state.serverCloseCalls, 1);
  });

  test('checks the initialization deadline in a late callback even before the next sweep', async () => {
    const initializeCallbackGate = deferredVoid();
    const harness = await startHarness({}, { initializeCallbackGate });
    assertDefaultSweep(harness);
    const pendingResponse = httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(),
    );
    await harness.state.firstInitializeCallback.promise;
    assert.strictEqual(harness.state.sessionIds.length, 1);
    const sessionId = harness.state.sessionIds[0];

    harness.clock.advance(30_001);
    initializeCallbackGate.resolve();
    await pendingResponse.catch(() => undefined);
    await waitFor(() => harness.state.transportCloseCalls === 1, 'late callback deadline cleanup');
    const lateLookup = await httpRequest(
      harness.port,
      'GET',
      { Authorization: `Bearer ${harness.token}`, 'Mcp-Session-Id': sessionId },
    );
    assert.strictEqual(lateLookup.status, 404, 'deadline checks cannot depend on the next sweep callback');
    assert.strictEqual(harness.state.transportCloseCalls, 1);
    assert.strictEqual(harness.state.serverCloseCalls, 1);
  });

  test('memoizes cleanup across DELETE and shutdown and rejects admissions after close begins', async () => {
    const cleanupGate = deferredVoid();
    const harness = await startHarness({ maxSessions: 1 }, { cleanupGate });
    const { client, transport } = createOfficialClient(harness.port, harness.token);
    await client.connect(transport);
    const sessionId = transport.sessionId;
    assert.ok(sessionId);

    const deleting = httpRequest(
      harness.port,
      'DELETE',
      { Authorization: `Bearer ${harness.token}`, 'Mcp-Session-Id': sessionId },
    );
    await harness.state.firstSessionCloseCallback.promise;
    const router = harness.getRouter();
    const closeA = router.close();
    const closeB = router.close();
    await harness.state.firstTransportCloseStarted.promise;

    const rejectedAfterClose = await httpRequest(
      harness.port,
      'POST',
      postHeaders(harness.token),
      initializeBody(2),
    );
    assert.strictEqual(rejectedAfterClose.status, 503);
    assert.strictEqual(harness.state.serverAllocations, 1);
    assert.strictEqual(harness.state.transportAllocations, 1);
    assert.strictEqual(harness.state.transportCloseCalls, 1);

    cleanupGate.resolve();
    await Promise.all([closeA, closeB, deleting]);
    await router.close();
    assert.strictEqual(harness.clock.timers.length, 1);
    assert.strictEqual(harness.clock.timers[0].cleared, true, 'close stops the router-owned sweep');
    assert.strictEqual(harness.state.transportCloseCalls, 1);
    assert.strictEqual(harness.state.serverCloseCalls, 1);
    await client.close().catch(() => undefined);
  });
});
