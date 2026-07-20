import * as http from 'http';
import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ensureWebCrypto } from './webCrypto';
import { AgentCommandExecutor, registerMcpTools } from './toolCatalog';

interface McpSession {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
}

export interface McpSessionRouter {
  handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody?: unknown,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface McpSessionRouterOptions {
  readonly version: string;
  readonly executeCommand?: AgentCommandExecutor;
}

export async function createMcpSessionRouter(
  options: McpSessionRouterOptions,
): Promise<McpSessionRouter> {
  ensureWebCrypto();
  const [{ McpServer }, { StreamableHTTPServerTransport }, { isInitializeRequest }] =
    await Promise.all([
      import('@modelcontextprotocol/sdk/server/mcp.js'),
      import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/types.js'),
    ]);

  const sessions = new Map<string, McpSession>();
  const pendingSessions = new Set<McpSession>();
  const closingSessions = new WeakMap<McpSession, Promise<void>>();
  let closed = false;

  const closeSession = (session: McpSession): Promise<void> => {
    const current = closingSessions.get(session);
    if (current) {
      return current;
    }
    const operation = Promise.resolve().then(async () => {
      await Promise.allSettled([session.transport.close()]);
      await Promise.allSettled([session.server.close()]);
    });
    closingSessions.set(session, operation);
    return operation;
  };

  const writeJsonRpcError = (
    res: http.ServerResponse,
    status: number,
    code: number,
    message: string,
  ): void => {
    const json = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(json),
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(json);
  };

  const createSession = async (): Promise<McpSession> => {
    let initializedSessionId: string | undefined;
    const server = new McpServer({ name: 'cdt-41', version: options.version });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        initializedSessionId = sessionId;
        pendingSessions.delete(session);
        if (closed) {
          void closeSession(session);
          return;
        }
        sessions.set(sessionId, session);
      },
      onsessionclosed: async (sessionId) => {
        if (sessions.get(sessionId) === session) {
          sessions.delete(sessionId);
        }
        pendingSessions.delete(session);
        await closeSession(session);
      },
    });
    const session: McpSession = { server, transport };
    transport.onclose = () => {
      const sessionId = transport.sessionId ?? initializedSessionId;
      if (sessionId && sessions.get(sessionId) === session) {
        sessions.delete(sessionId);
      }
      pendingSessions.delete(session);
    };
    registerMcpTools(server, options.executeCommand);
    pendingSessions.add(session);
    try {
      await server.connect(transport);
      if (closed) {
        pendingSessions.delete(session);
        await closeSession(session);
      }
      return session;
    } catch (error) {
      pendingSessions.delete(session);
      await closeSession(session);
      throw error;
    }
  };

  return {
    async handleRequest(req, res, parsedBody): Promise<void> {
      if (closed) {
        writeJsonRpcError(res, 503, -32000, 'MCP server is stopping');
        return;
      }

      const sessionHeader = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        await existing.transport.handleRequest(req, res, parsedBody);
        return;
      }
      if (sessionId) {
        writeJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      if (req.method !== 'POST') {
        writeJsonRpcError(res, 400, -32000, 'Mcp-Session-Id header is required');
        return;
      }
      if (!isInitializeRequest(parsedBody)) {
        writeJsonRpcError(res, 400, -32000, 'No valid session ID provided');
        return;
      }

      const session = await createSession();
      if (closed) {
        await closeSession(session);
        if (!res.headersSent) {
          writeJsonRpcError(res, 503, -32000, 'MCP server is stopping');
        }
        return;
      }
      try {
        await session.transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        pendingSessions.delete(session);
        await closeSession(session);
        throw error;
      } finally {
        if (pendingSessions.delete(session)) {
          await closeSession(session);
        }
      }
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      const active = new Set([...sessions.values(), ...pendingSessions]);
      sessions.clear();
      pendingSessions.clear();
      await Promise.all([...active].map((session) => closeSession(session)));
    },
  };
}
