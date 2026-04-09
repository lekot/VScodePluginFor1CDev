/**
 * Unit-тесты для AgentBridge (P7b-1).
 * Реальные HTTP запросы к реальному серверу на random port.
 * Работают без VS Code runtime (core suite / mocha TDD).
 */

import * as assert from 'assert';
import * as http from 'http';
import { AgentBridge } from '../../src/agent/agentBridge';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface HttpRequestOptions {
    port: number;
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
}

interface HttpResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}

function httpRequest(opts: HttpRequestOptions): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: opts.port,
                path: opts.path,
                method: opts.method,
                headers: opts.headers,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode!,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    })
                );
            }
        );
        req.on('error', reject);
        if (opts.body) {
            req.write(opts.body);
        }
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('AgentBridge — HTTP server', () => {
    let bridge: AgentBridge | undefined;
    let port: number;
    let token: string;

    setup(async () => {
        bridge = new AgentBridge();
        ({ port, token } = await bridge.start());
    });

    teardown(async () => {
        await bridge?.stop();
        bridge = undefined;
    });

    // -------------------------------------------------------------------------
    // 1. Старт сервера
    // -------------------------------------------------------------------------

    test('start() возвращает port > 0 и непустой 64-char hex token', () => {
        assert.ok(port > 0, `port должен быть > 0, получено: ${port}`);
        assert.ok(typeof token === 'string', 'token должен быть строкой');
        assert.strictEqual(token.length, 64, `token должен быть 64 символа, получено: ${token.length}`);
        assert.ok(/^[0-9a-f]{64}$/.test(token), 'token должен быть hex-строкой');
    });

    // -------------------------------------------------------------------------
    // 2. Двойной start
    // -------------------------------------------------------------------------

    test('повторный start() бросает "already started"', async () => {
        let threw = false;
        try {
            await bridge!.start();
        } catch (err: unknown) {
            threw = true;
            assert.ok(
                err instanceof Error && err.message.includes('already started'),
                `Ожидалось сообщение "already started", получено: ${String(err)}`
            );
        }
        assert.ok(threw, 'Второй start() должен бросить ошибку');
    });

    // -------------------------------------------------------------------------
    // 3. stop() идемпотентен
    // -------------------------------------------------------------------------

    test('двойной stop() не бросает', async () => {
        await bridge!.stop();
        // второй вызов не должен бросать
        await bridge!.stop();
    });

    // -------------------------------------------------------------------------
    // 4. GET /health
    // -------------------------------------------------------------------------

    test('GET /health → 200 с ok: true и pid', async () => {
        const res = await httpRequest({ port, method: 'GET', path: '/health' });
        assert.strictEqual(res.status, 200);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.strictEqual(json['ok'], true);
        assert.ok(typeof json['pid'] === 'number', 'pid должен быть числом');
        assert.ok((json['pid'] as number) > 0, 'pid должен быть > 0');
    });

    // -------------------------------------------------------------------------
    // 5. POST /command с правильным token
    // -------------------------------------------------------------------------

    test('POST /command с правильным token → 200 { success: false, error: "not implemented" }', async () => {
        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'listObjects', args: {} }),
        });
        assert.strictEqual(res.status, 200);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.strictEqual(json['success'], false);
        assert.strictEqual(json['error'], 'not implemented');
    });

    // -------------------------------------------------------------------------
    // 6. POST /command без Authorization
    // -------------------------------------------------------------------------

    test('POST /command без Authorization → 401', async () => {
        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'listObjects' }),
        });
        assert.strictEqual(res.status, 401);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.ok(typeof json['error'] === 'string', 'Ответ должен содержать error');
    });

    // -------------------------------------------------------------------------
    // 7. POST /command с неправильным token
    // -------------------------------------------------------------------------

    test('POST /command с неправильным token → 401', async () => {
        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': 'Bearer invalidtoken',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'listObjects' }),
        });
        assert.strictEqual(res.status, 401);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.ok(typeof json['error'] === 'string', 'Ответ должен содержать error');
    });

    // -------------------------------------------------------------------------
    // 8. POST /command с не-JSON телом
    // -------------------------------------------------------------------------

    test('POST /command с не-JSON телом → 400', async () => {
        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: 'not valid json{{',
        });
        assert.strictEqual(res.status, 400);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.strictEqual(json['error'], 'invalid json');
    });

    // -------------------------------------------------------------------------
    // 9. POST /command без поля name
    // -------------------------------------------------------------------------

    test('POST /command без поля name → 400', async () => {
        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
        });
        assert.strictEqual(res.status, 400);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.strictEqual(json['error'], 'missing name');
    });

    // -------------------------------------------------------------------------
    // 10. GET /command → 405
    // -------------------------------------------------------------------------

    test('GET /command → 405', async () => {
        const res = await httpRequest({
            port,
            method: 'GET',
            path: '/command',
        });
        assert.strictEqual(res.status, 405);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.strictEqual(json['error'], 'method not allowed');
    });

    // -------------------------------------------------------------------------
    // 11. GET /unknown → 404
    // -------------------------------------------------------------------------

    test('GET /unknown → 404', async () => {
        const res = await httpRequest({
            port,
            method: 'GET',
            path: '/unknown-endpoint',
        });
        assert.strictEqual(res.status, 404);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.strictEqual(json['error'], 'not found');
    });

    // -------------------------------------------------------------------------
    // 12. stop() закрывает сервер
    // -------------------------------------------------------------------------

    test('после stop() новые соединения отбиваются (ECONNREFUSED)', async () => {
        const stoppedPort = port;
        await bridge!.stop();
        bridge = undefined; // afterEach не будет вызывать stop() повторно

        let connectionError: Error | undefined;
        try {
            await httpRequest({ port: stoppedPort, method: 'GET', path: '/health' });
        } catch (err: unknown) {
            connectionError = err as Error;
        }
        assert.ok(
            connectionError !== undefined,
            'После stop() запрос должен отбиться с ошибкой соединения'
        );
        const code = (connectionError as NodeJS.ErrnoException).code;
        assert.ok(
            code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET',
            `Ожидался ECONNREFUSED/ETIMEDOUT/ECONNRESET, получено: ${code}`
        );
    });
});
