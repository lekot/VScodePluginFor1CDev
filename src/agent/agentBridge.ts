// src/agent/agentBridge.ts
// HTTP-bridge для Agent API — принимает JSON-команды на 127.0.0.1:<random-port>.
// P7b-3: bridge discovery file (write/remove .vscode/cdt-agent-bridge.json).

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import {
    createMcpSessionRouter,
    McpSessionRouter,
    McpSessionRouterOptions,
} from './mcpAdapter/sessionRouter';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BODY_LIMIT_BYTES = 16 * 1024 * 1024; // 16 MB, enough for large XDTO/XSD payloads

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentBridgeOptions {
    /** Whitelist regex для имён команд. Команды НЕ соответствующие паттерну будут отбиты с 403. */
    commandPattern: RegExp;
    /** Папка workspace для записи bridge.json. Если не задана — bridge file НЕ создаётся. */
    workspaceFolder?: string;
    /** Версия расширения — пишется в bridge.json для диагностики. */
    extensionVersion?: string;
    /** Путь установки расширения — используется для резолвинга helperScriptPath в bridge.json. */
    extensionPath?: string;
    /** Factory seam for transport tests; production uses the official MCP SDK router. */
    mcpRouterFactory?: (options: McpSessionRouterOptions) => Promise<McpSessionRouter>;
}

export interface AgentBridgeStartResult {
    port: number;
    token: string;
}

// ---------------------------------------------------------------------------
// AgentBridge
// ---------------------------------------------------------------------------

export class AgentBridge {
    private _server: http.Server | undefined;
    private _token: string | undefined;
    private _port: number | undefined;
    private _commandPattern: RegExp;
    private _workspaceFolder?: string;
    private _bridgeFilePath?: string;
    private _extensionVersion?: string;
    private _extensionPath?: string;
    private _instanceId: string | undefined;
    private _mcpRouter: McpSessionRouter | undefined;
    private _mcpRouterFactory: (options: McpSessionRouterOptions) => Promise<McpSessionRouter>;
    private _connections = new Set<net.Socket>();
    private _stopping = false;
    private _lifecycleTail: Promise<void> = Promise.resolve();

    constructor(opts: AgentBridgeOptions) {
        this._commandPattern = opts.commandPattern;
        this._workspaceFolder = opts.workspaceFolder;
        this._extensionVersion = opts.extensionVersion;
        this._extensionPath = opts.extensionPath;
        this._mcpRouterFactory = opts.mcpRouterFactory ?? createMcpSessionRouter;
    }

    /**
     * Стартует HTTP сервер на 127.0.0.1:0 (random port), генерирует token.
     * В P7b-1: только биндинг + endpoint stubs.
     */
    async start(): Promise<AgentBridgeStartResult> {
        return this.enqueueLifecycle(async () => {
            try {
                return await this.startInternal();
            } catch (error) {
                await this.stopInternal();
                throw error;
            }
        });
    }

    private async startInternal(): Promise<AgentBridgeStartResult> {
        if (this._server !== undefined) {
            throw new Error('AgentBridge already started');
        }

        this._token = randomBytes(32).toString('hex');
        this._instanceId = randomUUID();
        this._stopping = false;
        this._mcpRouter = await this._mcpRouterFactory({
            version: this._extensionVersion ?? 'unknown',
        });

        const server = http.createServer((req, res) => {
            void this._handleRequest(req, res).catch((error: unknown) => {
                console.error('[AgentBridge] request failed:', error);
                if (!res.headersSent) {
                    this._sendJson(res, 500, { error: 'internal server error' });
                } else if (!res.writableEnded) {
                    res.end();
                }
            });
        });
        server.on('connection', (socket) => {
            this._connections.add(socket);
            socket.once('close', () => this._connections.delete(socket));
        });

        await new Promise<void>((resolve, reject) => {
            server.listen(0, '127.0.0.1', resolve);
            server.once('error', reject);
        });

        this._port = (server.address() as net.AddressInfo).port;
        this._server = server;

        if (this._workspaceFolder) {
            const vscodeDir = path.join(this._workspaceFolder, '.vscode');
            await fs.promises.mkdir(vscodeDir, { recursive: true });
            const bridgeFile = path.join(vscodeDir, 'cdt-agent-bridge.json');
            this._bridgeFilePath = bridgeFile;
            const helperScriptPath = this._extensionPath
                ? path.join(this._extensionPath, 'resources', 'agent-bridge', 'call.sh')
                : undefined;
            const discoverScriptPath = this._extensionPath
                ? path.join(this._extensionPath, 'resources', 'agent-bridge', 'discover.sh')
                : undefined;
            const content = {
                schemaVersion: 2,
                instanceId: this._instanceId,
                port: this._port,
                token: this._token,
                pid: process.pid,
                workspaceFolder: this._workspaceFolder,
                createdAt: new Date().toISOString(),
                extensionVersion: this._extensionVersion ?? 'unknown',
                docs: 'https://github.com/lekot/VScodePluginFor1CDev/blob/main/docs/features/agent-api/agent-skill.md',
                mcp: {
                    url: `http://127.0.0.1:${this._port}/mcp`,
                    transport: 'streamable-http',
                    authorization: 'bearer',
                },
                quickstart: 'POST http://127.0.0.1:<port>/command с заголовком Authorization: Bearer <token>, телом {"name":"1c-metadata-tree.agent.<cmd>","args":{...}}. Whitelist: /^1c-metadata-tree\\.agent(\\.debug|\\.forms|\\.skd|\\.xdto)?\\.[a-zA-Z]+$/. Для работы с формами используй agent.forms.start с debuggeeType=\'webServer\' или dbPath → потом playwright на webServerUrl. XDTO: agent.xdto.listPackages/getPackage/exportXsd/importXsd/createFromXsd/compare/merge. Отладка BSL — agent.debug.start (debuggeeType=\'webServer\' чтобы агент мог управлять формой; thinClient — нативное окно Windows, недоступно без ui-test).',
                ...(helperScriptPath ? { helperScriptPath } : {}),
                ...(discoverScriptPath ? { discoverScriptPath } : {}),
            };
            await this.writeDiscoveryFileAtomic(bridgeFile, content);
        }

        return { port: this._port, token: this._token };
    }

    /**
     * Останавливает HTTP сервер. Идемпотентен.
     */
    async stop(): Promise<void> {
        return this.enqueueLifecycle(() => this.stopInternal());
    }

    private async stopInternal(): Promise<void> {
        this._stopping = true;
        const server = this._server;
        const router = this._mcpRouter;
        this._mcpRouter = undefined;

        if (router) {
            await router.close();
        }

        if (server === undefined) {
            await this.removeBridgeFile();
            this.clearRuntimeState();
            return;
        }

        server.closeAllConnections();
        for (const socket of this._connections) {
            socket.destroy();
        }
        this._connections.clear();
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
        this._server = undefined;
        await this.removeBridgeFile();
        this.clearRuntimeState();
    }

    private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
        const result = this._lifecycleTail.then(operation, operation);
        this._lifecycleTail = result.then(() => undefined, () => undefined);
        return result;
    }

    private async removeBridgeFile(): Promise<void> {
        const bridgeFilePath = this._bridgeFilePath;
        this._bridgeFilePath = undefined;
        if (!bridgeFilePath) { return; }
        try {
            const raw = await fs.promises.readFile(bridgeFilePath, 'utf8');
            const current = JSON.parse(raw) as { instanceId?: unknown; token?: unknown };
            if (current.instanceId !== this._instanceId || current.token !== this._token) {
                return;
            }
            await fs.promises.unlink(bridgeFilePath);
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                console.error('[AgentBridge] failed to remove bridge file:', err);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Private — request routing
    // -------------------------------------------------------------------------

    private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (this._stopping) {
            this._sendJson(res, 503, { error: 'server stopping' });
            return;
        }

        const rawUrl = req.url ?? '/';
        const queryIndex = rawUrl.indexOf('?');
        const pathname = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
        const method = req.method ?? 'GET';

        if (pathname === '/health' && method === 'GET') {
            this._sendJson(res, 200, { ok: true, pid: process.pid });
            return;
        }

        if (pathname === '/command' && method === 'POST') {
            await this._handleCommand(req, res);
            return;
        }

        if (pathname === '/command') {
            // Any non-POST on /command
            this._sendJson(res, 405, { error: 'method not allowed' });
            return;
        }

        if (pathname === '/mcp') {
            await this._handleMcp(req, res, queryIndex >= 0);
            return;
        }

        this._sendJson(res, 404, { error: 'not found' });
    }

    private async _handleMcp(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        hasQuery: boolean,
    ): Promise<void> {
        const method = req.method ?? 'GET';
        if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
            this._sendJson(res, 405, { error: 'method not allowed' });
            return;
        }
        if (hasQuery || !this.isLoopbackPeer(req) || !this.hasAllowedHostAndOrigin(req)) {
            this._sendJson(res, 403, { error: 'forbidden' });
            return;
        }
        if (!this.hasValidBearer(req)) {
            this._sendJson(res, 401, { error: 'unauthorized' });
            return;
        }

        let parsedBody: unknown;
        if (method === 'POST') {
            try {
                const rawBody = await this._readBody(req);
                parsedBody = JSON.parse(rawBody);
            } catch (error) {
                const tooLarge = error instanceof Error && error.message === 'body too large';
                this._sendJson(res, tooLarge ? 413 : 400, {
                    error: tooLarge ? 'payload too large' : 'invalid json',
                });
                return;
            }
        }

        const router = this._mcpRouter;
        if (!router) {
            this._sendJson(res, 503, { error: 'MCP unavailable' });
            return;
        }
        await router.handleRequest(req, res, parsedBody);
    }

    private async _handleCommand(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // Check Authorization header
        if (!this.hasValidBearer(req)) {
            this._sendJson(res, 401, { error: 'unauthorized' });
            return;
        }

        // Read body
        let rawBody: string;
        try {
            rawBody = await this._readBody(req);
        } catch (err) {
            if (err instanceof Error && err.message === 'body too large') {
                this._sendJson(res, 413, { error: 'payload too large' });
            } else {
                this._sendJson(res, 400, { error: 'invalid json' });
            }
            return;
        }

        // Parse JSON
        let body: unknown;
        try {
            body = JSON.parse(rawBody);
        } catch {
            this._sendJson(res, 400, { error: 'invalid json' });
            return;
        }

        // Validate structure
        if (
            typeof body !== 'object' ||
            body === null ||
            typeof (body as Record<string, unknown>)['name'] !== 'string'
        ) {
            this._sendJson(res, 400, { error: 'missing name' });
            return;
        }

        const name = (body as Record<string, unknown>)['name'] as string;
        const args = (body as Record<string, unknown>)['args'];

        // Check whitelist
        if (!this._commandPattern.test(name)) {
            this._sendJson(res, 403, { error: 'forbidden command', name });
            return;
        }

        // Dispatch to vscode.commands.executeCommand
        try {
            const result = await vscode.commands.executeCommand(name, args ?? {});
            this._sendJson(res, 200, result);
        } catch (err) {
            this._sendJson(res, 200, {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // -------------------------------------------------------------------------
    // Private — helpers
    // -------------------------------------------------------------------------

    private hasValidBearer(req: http.IncomingMessage): boolean {
        const authorization = req.headers.authorization;
        if (Array.isArray(authorization) || typeof authorization !== 'string' || !this._token) {
            return false;
        }
        const actual = Buffer.from(authorization, 'utf8');
        const expected = Buffer.from(`Bearer ${this._token}`, 'utf8');
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }

    private isLoopbackPeer(req: http.IncomingMessage): boolean {
        const address = req.socket.remoteAddress ?? '';
        return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    }

    private hasAllowedHostAndOrigin(req: http.IncomingMessage): boolean {
        if (!this._port) {
            return false;
        }
        const suffix = `:${this._port}`;
        const allowed = new Set([
            `127.0.0.1${suffix}`,
            `localhost${suffix}`,
            `[::1]${suffix}`,
        ]);
        const host = req.headers.host?.toLowerCase();
        if (!host || !allowed.has(host)) {
            return false;
        }
        const origin = req.headers.origin;
        if (origin === undefined) {
            return true;
        }
        if (Array.isArray(origin)) {
            return false;
        }
        try {
            const parsed = new URL(origin);
            return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
                && allowed.has(parsed.host.toLowerCase());
        } catch {
            return false;
        }
    }

    private async writeDiscoveryFileAtomic(filePath: string, content: unknown): Promise<void> {
        const temporaryPath = `${filePath}.${this._instanceId ?? randomUUID()}.tmp`;
        try {
            await fs.promises.writeFile(temporaryPath, JSON.stringify(content, null, 2), 'utf8');
            await fs.promises.rename(temporaryPath, filePath);
        } finally {
            try {
                await fs.promises.unlink(temporaryPath);
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                    console.error('[AgentBridge] failed to remove temporary discovery file:', error);
                }
            }
        }
    }

    private clearRuntimeState(): void {
        this._token = undefined;
        this._port = undefined;
        this._instanceId = undefined;
        this._stopping = false;
    }

    private _readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            let rejected = false;
            req.on('data', (c: Buffer) => {
                if (rejected) { return; }
                totalBytes += c.length;
                if (totalBytes > BODY_LIMIT_BYTES) {
                    rejected = true;
                    reject(new Error('body too large'));
                    return;
                }
                chunks.push(c);
            });
            req.on('end', () => { if (!rejected) { resolve(Buffer.concat(chunks).toString('utf8')); } });
            req.on('error', (err) => { if (!rejected) { reject(err); } });
        });
    }

    private _sendJson(res: http.ServerResponse, status: number, body: unknown): void {
        // JSON.stringify(undefined) returns JS undefined — fallback to null to keep valid JSON.
        const json = JSON.stringify(body) ?? 'null';
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(json),
        });
        res.end(json);
    }
}
