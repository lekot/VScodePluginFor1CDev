// src/agent/agentBridge.ts
// HTTP-bridge для Agent API — принимает JSON-команды на 127.0.0.1:<random-port>.
// P7b-1: скелет (биндинг, /health, /command заглушка).

import * as http from 'http';
import * as net from 'net';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentBridgeOptions {
    // commandPattern и workspaceFolder будут добавлены в P7b-2 и P7b-3.
    _placeholder?: never;
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

    constructor(_opts?: AgentBridgeOptions) {
        // Options will be used in P7b-2 (commandPattern) and P7b-3 (workspaceFolder).
    }

    /**
     * Стартует HTTP сервер на 127.0.0.1:0 (random port), генерирует token.
     * В P7b-1: только биндинг + endpoint stubs.
     */
    async start(): Promise<AgentBridgeStartResult> {
        if (this._server !== undefined) {
            throw new Error('AgentBridge already started');
        }

        this._token = randomBytes(32).toString('hex');

        const server = http.createServer((req, res) => this._handleRequest(req, res));

        await new Promise<void>((resolve, reject) => {
            server.listen(0, '127.0.0.1', resolve);
            server.once('error', reject);
        });

        this._port = (server.address() as net.AddressInfo).port;
        this._server = server;

        return { port: this._port, token: this._token };
    }

    /**
     * Останавливает HTTP сервер. Идемпотентен.
     */
    async stop(): Promise<void> {
        if (this._server === undefined) {
            return;
        }
        await new Promise<void>((resolve) => {
            this._server!.close(() => resolve());
        });
        this._server = undefined;
        this._token = undefined;
        this._port = undefined;
    }

    // -------------------------------------------------------------------------
    // Private — request routing
    // -------------------------------------------------------------------------

    private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = req.url ?? '/';
        const method = req.method ?? 'GET';

        if (url === '/health' && method === 'GET') {
            this._sendJson(res, 200, { ok: true, pid: process.pid });
            return;
        }

        if (url === '/command' && method === 'POST') {
            // async handler — swallow floating promise intentionally
            void this._handleCommand(req, res);
            return;
        }

        if (url === '/command') {
            // Any non-POST on /command
            this._sendJson(res, 405, { error: 'method not allowed' });
            return;
        }

        this._sendJson(res, 404, { error: 'not found' });
    }

    private async _handleCommand(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // Check Authorization header
        const authHeader = req.headers['authorization'] ?? '';
        const expectedAuth = `Bearer ${this._token ?? ''}`;
        if (!authHeader || authHeader !== expectedAuth) {
            this._sendJson(res, 401, { error: 'unauthorized' });
            return;
        }

        // Read body
        let rawBody: string;
        try {
            rawBody = await this._readBody(req);
        } catch {
            this._sendJson(res, 400, { error: 'invalid json' });
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

        // In P7b-1: no executeCommand — stub response
        this._sendJson(res, 200, { success: false, error: 'not implemented' });
    }

    // -------------------------------------------------------------------------
    // Private — helpers
    // -------------------------------------------------------------------------

    private _readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', reject);
        });
    }

    private _sendJson(res: http.ServerResponse, status: number, body: unknown): void {
        const json = JSON.stringify(body);
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(json),
        });
        res.end(json);
    }
}
