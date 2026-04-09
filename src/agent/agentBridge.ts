// src/agent/agentBridge.ts
// HTTP-bridge для Agent API — принимает JSON-команды на 127.0.0.1:<random-port>.
// P7b-2: whitelist + executeCommand dispatch.

import * as http from 'http';
import * as net from 'net';
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BODY_LIMIT_BYTES = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentBridgeOptions {
    /** Whitelist regex для имён команд. Команды НЕ соответствующие паттерну будут отбиты с 403. */
    commandPattern: RegExp;
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

    constructor(opts: AgentBridgeOptions) {
        this._commandPattern = opts.commandPattern;
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

    private _readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            req.on('data', (c: Buffer) => {
                totalBytes += c.length;
                if (totalBytes > BODY_LIMIT_BYTES) {
                    reject(new Error('body too large'));
                    return;
                }
                chunks.push(c);
            });
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', reject);
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
