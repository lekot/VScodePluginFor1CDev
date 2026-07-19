import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentBridge } from '../../src/agent/agentBridge';
import {
  createMcpSessionRouter,
  McpSessionRouter,
} from '../../src/agent/mcpAdapter/sessionRouter';

interface HttpResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function request(
  port: number,
  method: string,
  requestPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

function authorizedHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jsonRpcHeaders(token: string): Record<string, string> {
  return {
    ...authorizedHeaders(token),
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
}

function stubRouter(methods: string[] = []): McpSessionRouter {
  return {
    async handleRequest(req, res): Promise<void> {
      methods.push(req.method ?? 'GET');
      const payload = JSON.stringify({ ok: true });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    },
    async close(): Promise<void> {},
  };
}

async function expectPortClosed(port: number): Promise<void> {
  await assert.rejects(
    request(port, 'GET', '/health'),
    (error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ECONNREFUSED' || code === 'ECONNRESET';
    },
  );
}

suite('MCP bridge: transport and security gate', () => {
  let bridge: AgentBridge | undefined;

  teardown(async () => {
    await bridge?.stop();
    bridge = undefined;
  });

  test('allows only authenticated GET, POST and DELETE and forwards each method', async () => {
    const methods: string[] = [];
    bridge = new AgentBridge({
      commandPattern: /^test\./,
      mcpRouterFactory: async () => stubRouter(methods),
    });
    const { port, token } = await bridge.start();

    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await request(
        port,
        method,
        '/mcp',
        method === 'POST' ? jsonRpcHeaders(token) : authorizedHeaders(token),
        method === 'POST' ? '{}' : undefined,
      );
      assert.strictEqual(response.status, 200, method);
    }
    assert.deepStrictEqual(methods, ['GET', 'POST', 'DELETE']);

    const unsupported = await request(port, 'PUT', '/mcp', authorizedHeaders(token));
    assert.strictEqual(unsupported.status, 405);
    assert.deepStrictEqual(methods, ['GET', 'POST', 'DELETE'], 'unsupported method must not reach router');
  });

  test('rejects missing/wrong bearer, URL query, hostile Host and hostile Origin before routing', async () => {
    const methods: string[] = [];
    bridge = new AgentBridge({
      commandPattern: /^test\./,
      mcpRouterFactory: async () => stubRouter(methods),
    });
    const { port, token } = await bridge.start();

    assert.strictEqual((await request(port, 'GET', '/mcp')).status, 401);
    assert.strictEqual((await request(port, 'GET', '/mcp', authorizedHeaders('wrong'))).status, 401);
    assert.strictEqual((await request(port, 'GET', '/mcp?token=' + token, authorizedHeaders(token))).status, 403);
    assert.strictEqual((await request(port, 'GET', '/mcp', {
      ...authorizedHeaders(token),
      Host: 'attacker.example',
    })).status, 403);
    assert.strictEqual((await request(port, 'GET', '/mcp', {
      ...authorizedHeaders(token),
      Origin: 'https://attacker.example',
    })).status, 403);
    assert.strictEqual(methods.length, 0);
  });

  test('loopback peer guard rejects a non-loopback address through its transport seam', async () => {
    bridge = new AgentBridge({
      commandPattern: /^test\./,
      mcpRouterFactory: async () => stubRouter(),
    });
    await bridge.start();
    const guard = bridge as unknown as {
      isLoopbackPeer(req: { socket: { remoteAddress?: string } }): boolean;
    };
    assert.strictEqual(guard.isLoopbackPeer({ socket: { remoteAddress: '10.20.30.40' } }), false);
    assert.strictEqual(guard.isLoopbackPeer({ socket: { remoteAddress: '127.0.0.1' } }), true);
    assert.strictEqual(guard.isLoopbackPeer({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  });

  test('missing and unknown sessions are rejected by the real stateful router', async () => {
    bridge = new AgentBridge({ commandPattern: /^test\./ });
    const { port, token } = await bridge.start();
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    const missingPost = await request(port, 'POST', '/mcp', jsonRpcHeaders(token), notification);
    assert.strictEqual(missingPost.status, 400);
    const missingGet = await request(port, 'GET', '/mcp', {
      ...authorizedHeaders(token),
      Accept: 'text/event-stream',
    });
    assert.strictEqual(missingGet.status, 400);
    const missingDelete = await request(port, 'DELETE', '/mcp', authorizedHeaders(token));
    assert.strictEqual(missingDelete.status, 400);

    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await request(port, method, '/mcp', {
        ...(method === 'POST' ? jsonRpcHeaders(token) : authorizedHeaders(token)),
        'Mcp-Session-Id': 'unknown-session',
      }, method === 'POST' ? notification : undefined);
      assert.strictEqual(response.status, 404, method);
    }
  });
});

suite('MCP bridge: official SDK client and lifecycle', () => {
  let bridge: AgentBridge | undefined;
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;

  teardown(async () => {
    await client?.close().catch(() => undefined);
    await bridge?.stop();
    client = undefined;
    transport = undefined;
    bridge = undefined;
  });

  test('official client completes initialize, tools/list, tools/call and session termination', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    bridge = new AgentBridge({
      commandPattern: /^test\./,
      extensionVersion: 'test-version',
      mcpRouterFactory: async ({ version }) => createMcpSessionRouter({
        version,
        executeCommand: async (command, args) => {
          calls.push({ command, args });
          return { success: true, data: { configurations: [{ id: 'cfg' }] } };
        },
      }),
    });
    const { port, token } = await bridge.start();
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    client = new Client({ name: 'mcp-contract-test', version: '1.0.0' });

    await client.connect(transport);
    assert.ok(transport.sessionId, 'initialize must establish a stateful MCP session');
    const listed = await client.listTools();
    assert.deepStrictEqual(listed.tools.map((tool) => tool.name), [
      'cdt_list_configurations',
      'cdt_list_objects',
      'cdt_get_yaml',
      'cdt_get_properties',
      'cdt_list_bindings',
      'cdt_export_status',
    ]);

    const called = await client.callTool({ name: 'cdt_list_configurations', arguments: {} });
    assert.deepStrictEqual(called.structuredContent, {
      success: true,
      data: { configurations: [{ id: 'cfg' }] },
    });
    assert.deepStrictEqual(calls, [{
      command: '1c-metadata-tree.agent.listConfigurations',
      args: {},
    }]);

    const terminatedSessionId = transport.sessionId;
    assert.ok(terminatedSessionId);
    await transport.terminateSession();
    assert.strictEqual(transport.sessionId, undefined);

    const afterDelete = await request(port, 'GET', '/mcp', {
      ...authorizedHeaders(token),
      Accept: 'text/event-stream',
      'Mcp-Session-Id': terminatedSessionId,
    });
    assert.strictEqual(afterDelete.status, 404);
    assert.match(afterDelete.body, /Session not found/);
  });

  test('official SDK validation rejects unknown input without Agent dispatch', async () => {
    let dispatchCount = 0;
    bridge = new AgentBridge({
      commandPattern: /^test\./,
      mcpRouterFactory: async ({ version }) => createMcpSessionRouter({
        version,
        executeCommand: async () => {
          dispatchCount += 1;
          return { success: true };
        },
      }),
    });
    const { port, token } = await bridge.start();
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    client = new Client({ name: 'mcp-validation-test', version: '1.0.0' });
    await client.connect(transport);

    const result = await client.callTool({
      name: 'cdt_list_configurations',
      arguments: { unknown: true },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(dispatchCount, 0);
  });

  test('stop closes an active MCP session/SSE stream and frees the listener port', async () => {
    bridge = new AgentBridge({
      commandPattern: /^test\./,
      mcpRouterFactory: async ({ version }) => createMcpSessionRouter({
        version,
        executeCommand: async () => ({ success: true }),
      }),
    });
    const { port, token } = await bridge.start();
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    client = new Client({ name: 'mcp-stop-test', version: '1.0.0' });
    await client.connect(transport);
    assert.ok(transport.sessionId);

    let markSseReady!: () => void;
    const sseReady = new Promise<void>((resolve) => { markSseReady = resolve; });
    const sseClosed = new Promise<void>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/mcp',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
          'Mcp-Session-Id': transport!.sessionId!,
          'MCP-Protocol-Version': transport!.protocolVersion ?? '2025-06-18',
        },
      }, (res) => {
        assert.ok(
          res.statusCode === 200 || res.statusCode === 409,
          `expected a new SSE stream or proof of the client's existing stream, got ${res.statusCode}`,
        );
        markSseReady();
        res.resume();
        res.once('end', resolve);
        res.once('close', resolve);
        res.once('error', (error) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ECONNRESET') { resolve(); } else { reject(error); }
        });
      });
      req.once('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ECONNRESET') { resolve(); } else { reject(error); }
      });
      req.end();
    });
    await sseReady;

    await bridge.stop();
    bridge = undefined;
    await sseClosed;
    await expectPortClosed(port);
  });
});

suite('MCP bridge: discovery ownership', () => {
  let temporaryWorkspace: string;

  setup(() => {
    temporaryWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-mcp-discovery-'));
  });

  teardown(() => {
    fs.rmSync(temporaryWorkspace, { recursive: true, force: true });
  });

  test('writes additive schema v2 atomically and removes it only while still owned', async () => {
    const bridge = new AgentBridge({
      commandPattern: /^test\./,
      workspaceFolder: temporaryWorkspace,
      extensionVersion: '0.test',
      mcpRouterFactory: async () => stubRouter(),
    });
    const { port, token } = await bridge.start();
    const vscodeDirectory = path.join(temporaryWorkspace, '.vscode');
    const discoveryPath = path.join(vscodeDirectory, 'cdt-agent-bridge.json');
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8')) as {
      schemaVersion: number;
      instanceId: string;
      port: number;
      token: string;
      pid: number;
      workspaceFolder: string;
      extensionVersion: string;
      mcp: { url: string; transport: string; authorization: string };
    };

    assert.strictEqual(discovery.schemaVersion, 2);
    assert.ok(discovery.instanceId);
    assert.strictEqual(discovery.port, port);
    assert.strictEqual(discovery.token, token);
    assert.strictEqual(discovery.pid, process.pid);
    assert.strictEqual(discovery.workspaceFolder, temporaryWorkspace);
    assert.strictEqual(discovery.extensionVersion, '0.test');
    assert.deepStrictEqual(discovery.mcp, {
      url: `http://127.0.0.1:${port}/mcp`,
      transport: 'streamable-http',
      authorization: 'bearer',
    });
    assert.deepStrictEqual(
      fs.readdirSync(vscodeDirectory).filter((name) => name.endsWith('.tmp')),
      [],
      'atomic write must not leave a temporary discovery file',
    );

    const foreign = { ...discovery, instanceId: 'newer-owner', token: 'newer-token' };
    fs.writeFileSync(discoveryPath, JSON.stringify(foreign), 'utf8');
    await bridge.stop();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(discoveryPath, 'utf8')), foreign);
  });
});
