// src/agent/agentBridge.ts
// HTTP-bridge для Agent API — принимает JSON-команды на 127.0.0.1:<random-port>.
// P7b-3: bridge discovery file (write/remove .vscode/cdt-agent-bridge.json).

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
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
    /** Папка workspace для записи bridge.json. Если не задана — bridge file НЕ создаётся. */
    workspaceFolder?: string;
    /** Версия расширения — пишется в bridge.json для диагностики. */
    extensionVersion?: string;
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

    constructor(opts: AgentBridgeOptions) {
        this._commandPattern = opts.commandPattern;
        this._workspaceFolder = opts.workspaceFolder;
        this._extensionVersion = opts.extensionVersion;
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

        if (this._workspaceFolder) {
            const vscodeDir = path.join(this._workspaceFolder, '.vscode');
            await fs.promises.mkdir(vscodeDir, { recursive: true });
            const bridgeFile = path.join(vscodeDir, 'cdt-agent-bridge.json');
            const content = {
                port: this._port,
                token: this._token,
                pid: process.pid,
                workspaceFolder: this._workspaceFolder,
                createdAt: new Date().toISOString(),
                extensionVersion: this._extensionVersion ?? 'unknown',
                docs: 'https://github.com/lekot/VScodePluginFor1CDev/blob/main/docs/features/agent-api/agent-skill.md',
                quickstart: 'POST http://127.0.0.1:<port>/command с заголовком Authorization: Bearer <token>, телом {"name":"1c-metadata-tree.agent.<cmd>","args":{...}}. Whitelist: /^1c-metadata-tree\\.agent(\\.debug|\\.forms|\\.skd)?\\.[a-zA-Z]+$/. Для работы с формами используй agent.forms.start с debuggeeType=\'webServer\' или dbPath → потом playwright на webServerUrl. Отладка BSL — agent.debug.start (debuggeeType=\'webServer\' чтобы агент мог управлять формой; thinClient — нативное окно Windows, недоступно без ui-test).',
            };
            await fs.promises.writeFile(bridgeFile, JSON.stringify(content, null, 2), 'utf8');
            this._bridgeFilePath = bridgeFile;
        }

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

        if (this._bridgeFilePath) {
            try {
                await fs.promises.unlink(this._bridgeFilePath);
            } catch (err: unknown) {
                // Игнорируем ENOENT — файл уже удалён
                if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                    // Логируем но не пробрасываем
                    console.error('[AgentBridge] failed to remove bridge file:', err);
                }
            }
            this._bridgeFilePath = undefined;
        }
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
