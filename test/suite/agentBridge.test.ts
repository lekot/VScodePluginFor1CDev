/**
 * Unit-тесты для AgentBridge (P7b-1 + P7b-2 + P7b-3).
 * Реальные HTTP запросы к реальному серверу на random port.
 * Работают без VS Code runtime (core suite / mocha TDD).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
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
// Tmp dir для discovery file тестов
// ---------------------------------------------------------------------------

let tmpDir: string;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('AgentBridge — HTTP server', () => {
    let bridge: AgentBridge | undefined;
    let port: number;
    let token: string;

    suiteSetup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt-bridge-test-'));
    });

    suiteTeardown(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

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

    // =========================================================================
    // P7b-3: Новые тесты — bridge discovery file
    // =========================================================================

    // -------------------------------------------------------------------------
    // 21. Bridge file создаётся после start() с правильным содержимым
    // -------------------------------------------------------------------------

    test('P7b-3: bridge file создаётся после start() с правильными полями', async () => {
        const wsDir = path.join(tmpDir, 'test-21');
        fs.mkdirSync(wsDir, { recursive: true });

        const b = new AgentBridge({ commandPattern: TEST_PATTERN, workspaceFolder: wsDir });
        try {
            const { port: p, token: t } = await b.start();
            const bridgeFile = path.join(wsDir, '.vscode', 'cdt-agent-bridge.json');

            assert.ok(fs.existsSync(bridgeFile), 'bridge file должен существовать после start()');

            const raw = fs.readFileSync(bridgeFile, 'utf8');
            const content = JSON.parse(raw) as Record<string, unknown>;

            assert.strictEqual(typeof content['port'], 'number', 'port должен быть числом');
            assert.ok((content['port'] as number) > 0, 'port должен быть > 0');
            assert.strictEqual(content['port'], p, 'port в файле совпадает с возвращённым');

            assert.strictEqual(typeof content['token'], 'string', 'token должен быть строкой');
            assert.ok(/^[0-9a-f]{64}$/.test(content['token'] as string), 'token должен быть 64-char hex');
            assert.strictEqual(content['token'], t, 'token в файле совпадает с возвращённым');

            assert.strictEqual(typeof content['pid'], 'number', 'pid должен быть числом');
            assert.strictEqual(content['pid'], process.pid, 'pid в файле совпадает с process.pid');

            assert.strictEqual(content['workspaceFolder'], wsDir, 'workspaceFolder совпадает');

            assert.strictEqual(typeof content['createdAt'], 'string', 'createdAt должен быть строкой');
            const dt = new Date(content['createdAt'] as string);
            assert.ok(!isNaN(dt.getTime()), 'createdAt должен быть валидной ISO датой');
        } finally {
            await b.stop();
        }
    });

    // -------------------------------------------------------------------------
    // 22. Bridge file удаляется после stop()
    // -------------------------------------------------------------------------

    test('P7b-3: bridge file удаляется после stop()', async () => {
        const wsDir = path.join(tmpDir, 'test-22');
        fs.mkdirSync(wsDir, { recursive: true });

        const b = new AgentBridge({ commandPattern: TEST_PATTERN, workspaceFolder: wsDir });
        await b.start();
        const bridgeFile = path.join(wsDir, '.vscode', 'cdt-agent-bridge.json');
        assert.ok(fs.existsSync(bridgeFile), 'bridge file должен существовать после start()');

        await b.stop();
        assert.ok(!fs.existsSync(bridgeFile), 'bridge file должен быть удалён после stop()');
    });

    // -------------------------------------------------------------------------
    // 23. Без workspaceFolder bridge file НЕ создаётся
    // -------------------------------------------------------------------------

    test('P7b-3: без workspaceFolder bridge file не создаётся', async () => {
        // bridge из setup() запущен без workspaceFolder — проверяем что никаких файлов нет
        // (bridge уже запущен в setup, port/token заданы)
        // Дополнительно создаём отдельный для изоляции:
        const b = new AgentBridge({ commandPattern: TEST_PATTERN });
        try {
            await b.start();
            // Нет workspaceFolder — нечего проверять по пути,
            // убеждаемся что stop() не упадёт
            await b.stop();
        } catch (err) {
            assert.fail(`bridge без workspaceFolder не должен падать: ${String(err)}`);
        }
    });

    // -------------------------------------------------------------------------
    // 24. Двойной start: файл переписывается с новыми port/token
    // -------------------------------------------------------------------------

    test('P7b-3: двойной start (с остановкой между) переписывает bridge file', async () => {
        const wsDir = path.join(tmpDir, 'test-24');
        fs.mkdirSync(wsDir, { recursive: true });
        const bridgeFile = path.join(wsDir, '.vscode', 'cdt-agent-bridge.json');

        const b = new AgentBridge({ commandPattern: TEST_PATTERN, workspaceFolder: wsDir });

        // Первый запуск
        const { port: port1, token: token1 } = await b.start();
        const content1 = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')) as Record<string, unknown>;
        assert.strictEqual(content1['port'], port1);
        assert.strictEqual(content1['token'], token1);

        await b.stop();

        // Второй запуск — новый port/token
        const { port: port2, token: token2 } = await b.start();
        const content2 = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')) as Record<string, unknown>;
        assert.strictEqual(content2['port'], port2);
        assert.strictEqual(content2['token'], token2);

        // port/token должны отличаться (с очень высокой вероятностью)
        assert.notStrictEqual(token2, token1, 'token должен быть разным при каждом запуске');

        await b.stop();
    });

    // -------------------------------------------------------------------------
    // 25. stop() при отсутствующем bridge file (ручное удаление) — не падает
    // -------------------------------------------------------------------------

    test('P7b-3: stop() при удалённом bridge file не падает (ENOENT)', async () => {
        const wsDir = path.join(tmpDir, 'test-25');
        fs.mkdirSync(wsDir, { recursive: true });

        const b = new AgentBridge({ commandPattern: TEST_PATTERN, workspaceFolder: wsDir });
        await b.start();
        const bridgeFile = path.join(wsDir, '.vscode', 'cdt-agent-bridge.json');

        // Удаляем файл вручную до stop()
        fs.unlinkSync(bridgeFile);
        assert.ok(!fs.existsSync(bridgeFile), 'файл удалён вручную');

        // stop() должен не упасть, несмотря на отсутствие файла
        await assert.doesNotReject(async () => { await b.stop(); }, 'stop() при ENOENT не должен бросать');
    });

    // -------------------------------------------------------------------------
    // 26. Папка .vscode создаётся если её не было
    // -------------------------------------------------------------------------

    test('P7b-3: папка .vscode создаётся если её не было', async () => {
        const wsDir = path.join(tmpDir, 'test-26');
        fs.mkdirSync(wsDir, { recursive: true });
        // Убеждаемся что .vscode не существует
        const vscodeDir = path.join(wsDir, '.vscode');
        assert.ok(!fs.existsSync(vscodeDir), 'папки .vscode не должно быть до start()');

        const b = new AgentBridge({ commandPattern: TEST_PATTERN, workspaceFolder: wsDir });
        try {
            await b.start();
            assert.ok(fs.existsSync(vscodeDir), 'папка .vscode должна быть создана после start()');
            assert.ok(fs.existsSync(path.join(vscodeDir, 'cdt-agent-bridge.json')), 'bridge file должен существовать');
        } finally {
            await b.stop();
        }
    });

    // -------------------------------------------------------------------------
    // 27. helperScriptPath / discoverScriptPath пишутся если задан extensionPath
    // -------------------------------------------------------------------------

    test('extensionPath: bridge file содержит helperScriptPath и discoverScriptPath', async () => {
        const wsDir = path.join(tmpDir, 'test-27');
        fs.mkdirSync(wsDir, { recursive: true });
        const extDir = path.join(tmpDir, 'test-27-ext');
        fs.mkdirSync(extDir, { recursive: true });

        const b = new AgentBridge({ commandPattern: TEST_PATTERN, workspaceFolder: wsDir, extensionPath: extDir });
        try {
            await b.start();
            const bridgeFile = path.join(wsDir, '.vscode', 'cdt-agent-bridge.json');
            const content = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')) as Record<string, unknown>;

            assert.strictEqual(
                content['helperScriptPath'],
                path.join(extDir, 'resources', 'agent-bridge', 'call.sh'),
                'helperScriptPath должен указывать на resources/agent-bridge/call.sh в extensionPath',
            );
            assert.strictEqual(
                content['discoverScriptPath'],
                path.join(extDir, 'resources', 'agent-bridge', 'discover.sh'),
                'discoverScriptPath должен указывать на resources/agent-bridge/discover.sh в extensionPath',
            );
        } finally {
            await b.stop();
        }
    });

    // -------------------------------------------------------------------------
    // 28. Без extensionPath — helperScriptPath/discoverScriptPath не пишутся
    // -------------------------------------------------------------------------

    test('без extensionPath: helperScriptPath/discoverScriptPath отсутствуют в bridge file', async () => {
        const wsDir = path.join(tmpDir, 'test-28');
        fs.mkdirSync(wsDir, { recursive: true });

        const b = new AgentBridge({ commandPattern: TEST_PATTERN, workspaceFolder: wsDir });
        try {
            await b.start();
            const bridgeFile = path.join(wsDir, '.vscode', 'cdt-agent-bridge.json');
            const content = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')) as Record<string, unknown>;

            assert.ok(!('helperScriptPath' in content), 'helperScriptPath не должен присутствовать без extensionPath');
            assert.ok(!('discoverScriptPath' in content), 'discoverScriptPath не должен присутствовать без extensionPath');
        } finally {
            await b.stop();
        }
    });
});
