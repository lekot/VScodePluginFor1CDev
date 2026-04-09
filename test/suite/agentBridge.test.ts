/**
 * Unit-тесты для AgentBridge (P7b-1 + P7b-2).
 * Реальные HTTP запросы к реальному серверу на random port.
 * Работают без VS Code runtime (core suite / mocha TDD).
 */

import * as assert from 'assert';
import * as http from 'http';
import { AgentBridge } from '../../src/agent/agentBridge';
import {
    setExecuteCommandHandler,
    getExecuteCommandHistory,
    resetVscodeTestState,
} from '../helpers/vscodeModuleStub';

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

// Whitelist для тестов — разрешает test.allowed.<lowercase>
const TEST_PATTERN = /^test\.allowed\.[a-z]+$/;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('AgentBridge — HTTP server', () => {
    let bridge: AgentBridge | undefined;
    let port: number;
    let token: string;

    setup(async () => {
        bridge = new AgentBridge({ commandPattern: TEST_PATTERN });
        ({ port, token } = await bridge.start());
    });

    teardown(async () => {
        setExecuteCommandHandler(undefined);
        resetVscodeTestState();
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
    // 5. POST /command — whitelisted команда без handler → undefined → 200
    // -------------------------------------------------------------------------

    test('POST /command с whitelisted name → 200, тело undefined (executeCommand не задан)', async () => {
        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'test.allowed.foo', args: {} }),
        });
        assert.strictEqual(res.status, 200);
        // executeCommand возвращает undefined → JSON.stringify(undefined) ?? 'null' → тело 'null'
        assert.strictEqual(res.body, 'null', `ожидалось "null", получено: ${res.body}`);
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
            body: JSON.stringify({ name: 'test.allowed.foo' }),
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
            body: JSON.stringify({ name: 'test.allowed.foo' }),
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
        bridge = undefined; // teardown не будет вызывать stop() повторно

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

    // =========================================================================
    // P7b-2: Новые тесты — whitelist + executeCommand dispatch
    // =========================================================================

    // -------------------------------------------------------------------------
    // 13. Whitelisted команда вызывает executeCommand и возвращает результат
    // -------------------------------------------------------------------------

    test('whitelisted команда → executeCommand вызван → результат проксируется в response', async () => {
        setExecuteCommandHandler((_name, _args) => ({ success: true, data: { x: 1 } }));

        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'test.allowed.run', args: {} }),
        });

        assert.strictEqual(res.status, 200);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.strictEqual(json['success'], true);
        const data = json['data'] as Record<string, unknown>;
        assert.strictEqual(data['x'], 1);
    });

    // -------------------------------------------------------------------------
    // 14. executeCommand вызывается с правильным name и args
    // -------------------------------------------------------------------------

    test('executeCommand вызывается с правильным name и args', async () => {
        let capturedName: string | undefined;
        let capturedArgs: unknown;

        setExecuteCommandHandler((name, args) => {
            capturedName = name;
            capturedArgs = args;
            return { ok: true };
        });

        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'test.allowed.check', args: { foo: 'bar' } }),
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(capturedName, 'test.allowed.check');
        assert.deepStrictEqual(capturedArgs, { foo: 'bar' });

        const history = getExecuteCommandHistory();
        assert.strictEqual(history.length, 1);
        assert.strictEqual(history[0].name, 'test.allowed.check');
        assert.deepStrictEqual(history[0].args, { foo: 'bar' });
    });

    // -------------------------------------------------------------------------
    // 15. args undefined → executeCommand вызывается с {}
    // -------------------------------------------------------------------------

    test('POST без args → executeCommand вызывается с {}', async () => {
        let capturedArgs: unknown = 'not-set';

        setExecuteCommandHandler((_name, args) => {
            capturedArgs = args;
            return null;
        });

        await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'test.allowed.noargs' }),
        });

        assert.deepStrictEqual(capturedArgs, {});
    });

    // -------------------------------------------------------------------------
    // 16. Non-whitelisted команда → 403
    // -------------------------------------------------------------------------

    test('non-whitelisted команда → 403 с error и name', async () => {
        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'evil.command', args: {} }),
        });

        assert.strictEqual(res.status, 403);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.strictEqual(json['error'], 'forbidden command');
        assert.strictEqual(json['name'], 'evil.command');
    });

    // -------------------------------------------------------------------------
    // 17. executeCommand бросает Error → 200 + { success: false, error: msg }
    // -------------------------------------------------------------------------

    test('executeCommand бросает Error → 200 + { success: false, error: "msg" }', async () => {
        setExecuteCommandHandler((_name, _args) => {
            throw new Error('command failed for testing');
        });

        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'test.allowed.throw', args: {} }),
        });

        assert.strictEqual(res.status, 200);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.strictEqual(json['success'], false);
        assert.strictEqual(json['error'], 'command failed for testing');
    });

    // -------------------------------------------------------------------------
    // 18. executeCommand бросает не-Error (строку) → 200 + { success: false, error: '<строка>' }
    // -------------------------------------------------------------------------

    test('executeCommand бросает строку → 200 + { success: false, error: "<строка>" }', async () => {
        setExecuteCommandHandler((_name, _args) => {
            // eslint-disable-next-line no-throw-literal
            throw 'string error thrown';
        });

        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'test.allowed.throwstr', args: {} }),
        });

        assert.strictEqual(res.status, 200);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.strictEqual(json['success'], false);
        assert.strictEqual(json['error'], 'string error thrown');
    });

    // -------------------------------------------------------------------------
    // 19. Body > 1MB → 413 + { error: 'payload too large' }
    // -------------------------------------------------------------------------

    test('body > 1MB → 413 + { error: "payload too large" }', async () => {
        const hugeValue = 'x'.repeat(1024 * 1024 + 100);
        const largeBody = JSON.stringify({ name: 'test.allowed.big', data: hugeValue });

        const res = await httpRequest({
            port,
            method: 'POST',
            path: '/command',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: largeBody,
        });

        assert.strictEqual(res.status, 413);
        const json = JSON.parse(res.body) as Record<string, unknown>;
        assert.strictEqual(json['error'], 'payload too large');
    });

    // -------------------------------------------------------------------------
    // 20. Разные regex: whitelist принимает foo.bar, отбивает bar.foo
    // -------------------------------------------------------------------------

    test('разные commandPattern: /^foo\\.\\w+$/ принимает foo.bar, отбивает bar.foo', async () => {
        // Отдельный bridge с другим паттерном
        const fooBridge = new AgentBridge({ commandPattern: /^foo\.\w+$/ });
        const { port: fooPort, token: fooToken } = await fooBridge.start();

        try {
            setExecuteCommandHandler(() => ({ matched: true }));

            // foo.bar — должен пройти
            const resOk = await httpRequest({
                port: fooPort,
                method: 'POST',
                path: '/command',
                headers: {
                    'Authorization': `Bearer ${fooToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: 'foo.bar', args: {} }),
            });
            assert.strictEqual(resOk.status, 200, 'foo.bar должен вернуть 200');

            // bar.foo — должен быть отбит
            const resFail = await httpRequest({
                port: fooPort,
                method: 'POST',
                path: '/command',
                headers: {
                    'Authorization': `Bearer ${fooToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: 'bar.foo', args: {} }),
            });
            assert.strictEqual(resFail.status, 403, 'bar.foo должен вернуть 403');
            const failJson = JSON.parse(resFail.body) as Record<string, unknown>;
            assert.strictEqual(failJson['name'], 'bar.foo');
        } finally {
            await fooBridge.stop();
        }
    });
});
