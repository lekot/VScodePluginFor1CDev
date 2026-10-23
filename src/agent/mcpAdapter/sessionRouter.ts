import * as http from 'http';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  StreamableHTTPServerTransport,
  StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ensureWebCrypto } from './webCrypto';
import { AgentCommandExecutor, registerMcpTools } from './toolCatalog';

interface McpSession {
  server?: McpServer;
  transport?: StreamableHTTPServerTransport;
  sessionId?: string;
  state: 'pending' | 'active' | 'closing' | 'closed';
  readonly initializationDeadline: number;
  lastActivity: number;
  openResponses: number;
  activeToolExecutions: number;
  connectPromise?: Promise<void>;
  closePromise?: Promise<void>;
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
  readonly maxSessions?: number;
  readonly idleTimeoutMs?: number;
  readonly initializationTimeoutMs?: number;
  readonly sweepIntervalMs?: number;
}

export interface McpSessionRouterTimer {
  unref?(): unknown;
}

export interface McpSessionRouterClock {
  now(): number;
  setInterval(callback: () => void, intervalMs: number): McpSessionRouterTimer;
  clearInterval(timer: McpSessionRouterTimer): void;
}

export interface McpSessionRouterSdkFactory {
  createServer(options: ConstructorParameters<typeof McpServer>[0]): McpServer;
  createTransport(options: StreamableHTTPServerTransportOptions): StreamableHTTPServerTransport;
}

export interface McpSessionRouterDependencies {
  readonly clock?: McpSessionRouterClock;
  readonly sdkFactory?: McpSessionRouterSdkFactory;
}

const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

const systemClock: McpSessionRouterClock = {
  now: () => Date.now(),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

function validatePositiveInteger(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || !Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a finite positive integer.`);
  }
  return resolved;
}

function jsonRpcRequestId(body: unknown): string | number | null {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'id')) {
    return null;
  }
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export async function createMcpSessionRouter(
  options: McpSessionRouterOptions,
  dependencies: McpSessionRouterDependencies = {},
): Promise<McpSessionRouter> {
  const maxSessions = validatePositiveInteger('maxSessions', options.maxSessions, DEFAULT_MAX_SESSIONS);
  const idleTimeoutMs = validatePositiveInteger('idleTimeoutMs', options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
  const initializationTimeoutMs = validatePositiveInteger(
    'initializationTimeoutMs',
    options.initializationTimeoutMs,
    DEFAULT_INITIALIZATION_TIMEOUT_MS,
  );
  const sweepIntervalMs = validatePositiveInteger('sweepIntervalMs', options.sweepIntervalMs, DEFAULT_SWEEP_INTERVAL_MS);

  ensureWebCrypto();
  const [{ McpServer }, { StreamableHTTPServerTransport }, { isInitializeRequest }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);

  const clock = dependencies.clock ?? systemClock;
  const sdkFactory = dependencies.sdkFactory ?? {
    createServer: (serverOptions: ConstructorParameters<typeof McpServer>[0]): McpServer =>
      new McpServer(serverOptions),
    createTransport: (transportOptions: StreamableHTTPServerTransportOptions): StreamableHTTPServerTransport =>
      new StreamableHTTPServerTransport(transportOptions),
  };
  const sessions = new Map<string, McpSession>();
  const reservations = new Set<McpSession>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const touch = (session: McpSession): void => {
    if (session.state === 'pending' || session.state === 'active') {
      session.lastActivity = clock.now();
    }
  };

  const removeSessionMapping = (session: McpSession): void => {
    if (session.sessionId && sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId);
    }
  };

  const closeSession = (session: McpSession): Promise<void> => {
    if (session.closePromise) {
      return session.closePromise;
    }

    session.state = 'closing';
    removeSessionMapping(session);
    const operation = Promise.resolve().then(async () => {
      try {
        await session.connectPromise;
      } catch {
        // A failed connect still needs the same one-time pair cleanup.
      }
      try {
        await session.transport?.close();
      } catch {
        // Cleanup remains best-effort; transport and server closure are both attempted once.
      }
      try {
        await session.server?.close();
      } catch {
        // Do not retain a slot forever when SDK shutdown reports an error.
      }
    }).finally(() => {
      session.state = 'closed';
      reservations.delete(session);
    });
    session.closePromise = operation;
    return operation;
  };

  const expireDueSessions = (): void => {
    const now = clock.now();
    for (const session of reservations) {
      if (session.state === 'pending' && now >= session.initializationDeadline) {
        void closeSession(session);
        continue;
      }
      if (
        session.state === 'active'
        && session.openResponses === 0
        && session.activeToolExecutions === 0
        && now - session.lastActivity >= idleTimeoutMs
      ) {
        void closeSession(session);
      }
    }
  };

  const writeJsonRpcError = (
    res: http.ServerResponse,
    status: number,
    code: number,
    message: string,
    id: string | number | null = null,
  ): void => {
    const json = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id });
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(json),
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(json);
  };

  const trackResponse = (session: McpSession, res: http.ServerResponse): void => {
    if (typeof res.once !== 'function') {
      return;
    }
    let completed = false;
    session.openResponses += 1;
    touch(session);

    const complete = (): void => {
      if (completed) {
        return;
      }
      completed = true;
      session.openResponses = Math.max(0, session.openResponses - 1);
      touch(session);
    };

    res.once('finish', complete);
    res.once('close', complete);
  };

  const createSessionReservation = (): McpSession => {
    const now = clock.now();
    const session: McpSession = {
      state: 'pending',
      initializationDeadline: now + initializationTimeoutMs,
      lastActivity: now,
      openResponses: 0,
      activeToolExecutions: 0,
    };
    reservations.add(session);

    try {
      const server = sdkFactory.createServer({ name: 'cdt-41', version: options.version });
      session.server = server;
      const transport = sdkFactory.createTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          session.sessionId = sessionId;
          if (
            session.state !== 'pending'
            || closed
            || clock.now() >= session.initializationDeadline
          ) {
            if (session.state === 'pending') {
              session.state = 'closing';
              removeSessionMapping(session);
              setImmediate(() => { void closeSession(session); });
            }
            return;
          }

          session.state = 'active';
          sessions.set(sessionId, session);
          touch(session);
        },
        onsessionclosed: async (sessionId) => {
          if (session.sessionId === sessionId) {
            removeSessionMapping(session);
          }
          await closeSession(session);
        },
      });
      session.transport = transport;
      transport.onclose = () => {
        if (transport.sessionId) {
          session.sessionId = transport.sessionId;
        }
        removeSessionMapping(session);
        void closeSession(session);
      };

      const baseExecutor: AgentCommandExecutor = options.executeCommand ?? ((command, args, cancellation) =>
        Promise.resolve(vscode.commands.executeCommand(command, args, cancellation)));
      const trackedExecutor: AgentCommandExecutor = async (command, args, cancellation) => {
        session.activeToolExecutions += 1;
        touch(session);
        try {
          return await baseExecutor(command, args, cancellation);
        } finally {
          session.activeToolExecutions = Math.max(0, session.activeToolExecutions - 1);
          touch(session);
        }
      };
      registerMcpTools(server, trackedExecutor);
      return session;
    } catch (error) {
      void closeSession(session);
      throw error;
    }
  };

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> => {
    const requestId = jsonRpcRequestId(parsedBody);
    if (closed) {
      writeJsonRpcError(res, 503, -32000, 'MCP server is stopping', requestId);
      return;
    }

    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      const transport = existing.transport;
      if (!transport || existing.state !== 'active') {
        writeJsonRpcError(res, 404, -32001, 'Session not found', requestId);
        return;
      }
      trackResponse(existing, res);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }
    if (sessionId) {
      writeJsonRpcError(res, 404, -32001, 'Session not found', requestId);
      return;
    }
    if (req.method !== 'POST') {
      writeJsonRpcError(res, 400, -32000, 'Mcp-Session-Id header is required', requestId);
      return;
    }
    if (!isInitializeRequest(parsedBody)) {
      writeJsonRpcError(res, 400, -32000, 'No valid session ID provided', requestId);
      return;
    }

    expireDueSessions();
    if (reservations.size >= maxSessions) {
      writeJsonRpcError(res, 503, -32000, 'MCP session capacity is full', requestId);
      return;
    }

    const session = createSessionReservation();
    const server = session.server;
    const transport = session.transport;
    if (!server || !transport) {
      await closeSession(session);
      writeJsonRpcError(res, 503, -32000, 'MCP session could not be started', requestId);
      return;
    }
    trackResponse(session, res);

    try {
      const connectPromise = Promise.resolve().then(() => server.connect(transport));
      session.connectPromise = connectPromise;
      await connectPromise;
      if (closed || session.state === 'closing' || session.state === 'closed') {
        if (!res.headersSent) {
          writeJsonRpcError(res, 503, -32000, 'MCP server is stopping', requestId);
        }
        return;
      }
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      await closeSession(session);
      throw error;
    } finally {
      if (session.state === 'pending') {
        await closeSession(session);
      }
    }
  };

  const sweep = (): void => {
    expireDueSessions();
  };
  const sweepTimer = clock.setInterval(sweep, sweepIntervalMs);
  sweepTimer.unref?.();

  const close = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    closed = true;
    if (sweepTimer) {
      clock.clearInterval(sweepTimer);
    }
    const sessionsToClose = [...reservations];
    closePromise = Promise.all(sessionsToClose.map((session) => closeSession(session))).then(() => undefined);
    return closePromise;
  };

  return { handleRequest, close };
}
