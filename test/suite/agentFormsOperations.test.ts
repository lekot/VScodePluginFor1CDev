/**
 * Smoke-тесты для FormsOperations.
 * Работают без VS Code runtime (core suite / mocha TDD).
 * НЕ запускают реальные ibsrv/chromium — только проверяют что код компилируется
 * и методы не бросают при отсутствующей сессии.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import '../helpers/vscodeStubRegister';
import { FormsContext } from '../../src/services/forms/FormsContext';
import type { FormsStartResult, NativeFormsAction, NativeFormsActionResult } from '../../src/agent/agentFormsTypes';
import type { NativeFormsSession } from '../../src/services/forms/nativeFormsSession';
import { FormsOperations } from '../../src/agent/agentFormsOperations';

// ─── Mock output channel ─────────────────────────────────────────────────────

function makeMockOutputChannel() {
    return {
        appendLine(_msg: string): void { /* noop */ },
        show(_preserveFocus?: boolean): void { /* noop */ },
        dispose(): void { /* noop */ },
        name: 'MockFormsOutput',
        append(_msg: string): void { /* noop */ },
        clear(): void { /* noop */ },
        hide(): void { /* noop */ },
        replace(_msg: string): void { /* noop */ },
    };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('FormsOperations — smoke', () => {
    let ops: FormsOperations;

    setup(() => {
        ops = new FormsOperations({
            extensionPath: '/fake/extension/path',
            outputChannel: makeMockOutputChannel() as unknown as import('vscode').OutputChannel,
        });
    });

    test('formsStatus — не бросает, возвращает browserAlive:false и ibsrvAlive:false', async () => {
        // formsStatus вызывает runFormsScript → run.mjs не существует по fake path →
        // ловит исключение и возвращает success:false с error.
        // В любом случае — не должен бросить необработанное исключение.
        let result: Awaited<ReturnType<typeof ops.formsStatus>>;
        try {
            result = await ops.formsStatus({});
        } catch (err) {
            assert.fail(`formsStatus не должен бросать, получили: ${err}`);
        }

        // Должен вернуть либо success:true (если вдруг run.mjs найден), либо success:false с error.
        // В любом случае — поле success должно присутствовать.
        assert.ok(typeof result.success === 'boolean', 'result.success должен быть boolean');

        if (result.success) {
            // Если каким-то чудом прошло — ibsrvAlive:false (нет реального процесса)
            assert.strictEqual(result.data?.ibsrvAlive, false, 'ibsrvAlive должен быть false без реального ibsrv');
        } else {
            // Нормальный путь в тестах — ошибка из-за отсутствия run.mjs
            assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error должен быть непустой строкой');
        }
    });

    test('formsStart — возвращает error при отсутствии url и dbPath', async () => {
        const result = await ops.formsStart({});
        assert.strictEqual(result.success, false);
        assert.ok(result.error, 'должна быть ошибка');
    });

    test('formsExec — возвращает error при пустом script', async () => {
        const result = await ops.formsExec({ script: '' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error);
    });
});

suite('FormsOperations — task cancellation contract', () => {
    test('forms.exec passes its task token and keeps possible BSL effects inDoubt after cancellation', async () => {
        const source = new vscode.CancellationTokenSource();
        const context = new FormsContext();
        let receivedToken: vscode.CancellationToken | undefined;
        const reported: string[] = [];
        const operations = new FormsOperations({
            extensionPath: '/fake/extension/path',
            outputChannel: makeMockOutputChannel() as unknown as vscode.OutputChannel,
            context,
            runFormsScript: async (options) => {
                receivedToken = options.token;
                assert.strictEqual(options.command, 'exec');
                source.cancel();
                return {
                    output: 'partial result',
                    stderr: '',
                    exitCode: -2,
                    cancelled: true,
                    effectPossible: true,
                };
            },
        });

        const result = await operations.formsExec({ script: 'DoSomething();' }, source.token, (message) => reported.push(message));

        assert.strictEqual(receivedToken, source.token);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.code, 'FORMS_OPERATION_IN_DOUBT');
        assert.deepStrictEqual(result.data, { status: 'inDoubt', effectPossible: true });
        assert.ok(reported.some((message) => message.includes('Выполнение BSL')));
        source.dispose();
    });

    test('forms.start exits before touching the session when already cancelled', async () => {
        const source = new vscode.CancellationTokenSource();
        source.cancel();
        let startIbsrvCalled = false;
        const context = new FormsContext();
        const operations = new FormsOperations({
            extensionPath: '/fake/extension/path',
            outputChannel: makeMockOutputChannel() as unknown as vscode.OutputChannel,
            context,
            startIbsrv: async () => {
                startIbsrvCalled = true;
                throw new Error('must not start');
            },
        });

        const result = await operations.formsStart({ url: 'http://localhost/' }, source.token);

        assert.strictEqual(startIbsrvCalled, false);
        assert.strictEqual(result.code, 'REQUEST_CANCELLED');
        source.dispose();
    });
});

suite('FormsOperations — native TestClient contract', () => {
    test('native start requires an explicit port and status/stop own only the socket', async () => {
        const context = new FormsContext();
        let connected = false;
        let closeCount = 0;
        let clientProcessStopped = false;
        const session: NativeFormsSession = {
            host: '127.0.0.1',
            port: 32138,
            get connected() { return connected; },
            async execute(): Promise<NativeFormsActionResult> { throw new Error('not called'); },
            async close() {
                closeCount += 1;
                connected = false;
            },
        };
        const operations = new FormsOperations({
            extensionPath: '/fake/extension/path',
            outputChannel: makeMockOutputChannel() as unknown as vscode.OutputChannel,
            context,
            connectNativeClient: async (options) => {
                assert.strictEqual(options.host, '127.0.0.1');
                assert.strictEqual(options.port, 32138);
                connected = true;
                return session;
            },
        });

        const missingPort = await operations.formsStart({ driver: 'native' });
        assert.strictEqual(missingPort.success, false);
        assert.match(missingPort.error ?? '', /port/);

        const started = await operations.formsStart({ driver: 'native', port: 32138 });
        assert.strictEqual(started.success, true);
        const nativeStart = started.data as FormsStartResult | undefined;
        assert.strictEqual(nativeStart?.driver, 'native');
        assert.strictEqual(nativeStart?.port, 32138);

        const status = await operations.formsStatus({});
        assert.strictEqual(status.success, true);
        assert.deepStrictEqual(status.data, {
            driver: 'native',
            browserAlive: false,
            ibsrvAlive: false,
            nativeConnected: true,
            host: '127.0.0.1',
            port: 32138,
        });

        const stopped = await operations.formsStop({});
        assert.strictEqual(stopped.success, true);
        assert.strictEqual(closeCount, 1);
        assert.strictEqual(clientProcessStopped, false);
        assert.strictEqual((await operations.formsStatus({})).success, false);
        clientProcessStopped = false;
    });

    test('native action routes typed parameters and rejects web-only exec/shot', async () => {
        const context = new FormsContext();
        let receivedAction: NativeFormsAction | undefined;
        let receivedTimeout: number | undefined;
        const session: NativeFormsSession = {
            host: 'localhost',
            port: 32139,
            connected: true,
            async execute(action, options) {
                receivedAction = action;
                receivedTimeout = options.timeoutMs;
                return { ref: action.action === 'writeField' ? action.ref : { id: 'field-1' }, accepted: true, text: '42' } as NativeFormsActionResult;
            },
            async close() { /* leave the fake server/client alive */ },
        };
        context.setNativeSession(session);
        let webRunnerCalled = false;
        const operations = new FormsOperations({
            extensionPath: '/fake/extension/path',
            outputChannel: makeMockOutputChannel() as unknown as vscode.OutputChannel,
            context,
            runFormsScript: async () => {
                webRunnerCalled = true;
                throw new Error('web runner must not be called for native');
            },
        });

        const action = {
            action: 'writeField',
            ref: { id: 'field-1' },
            value: '42',
            timeoutMs: 7000,
            background: false,
        } as const;
        const result = await operations.formsNative(action);
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(receivedAction, {
            action: 'writeField',
            ref: { id: 'field-1' },
            value: '42',
        });
        assert.strictEqual(receivedTimeout, 7000);

        const exec = await operations.formsExec({ script: 'DoSomething();' });
        const shot = await operations.formsShot({});
        assert.strictEqual(exec.success, false);
        assert.match(exec.error ?? '', /только для driver="web"/);
        assert.strictEqual(shot.success, false);
        assert.match(shot.error ?? '', /только для driver="web"/);
        assert.strictEqual(webRunnerCalled, false);
    });

    test('native mutation uncertainty is surfaced as inDoubt', async () => {
        const context = new FormsContext();
        context.setNativeSession({
            host: 'localhost',
            port: 32140,
            connected: true,
            async execute() {
                throw Object.assign(new Error('response timed out after write'), {
                    code: 'FORMS_OPERATION_IN_DOUBT',
                    effectPossible: true,
                });
            },
            async close() { /* no-op */ },
        });
        const operations = new FormsOperations({
            extensionPath: '/fake/extension/path',
            outputChannel: makeMockOutputChannel() as unknown as vscode.OutputChannel,
            context,
        });

        const result = await operations.formsNative({
            action: 'act',
            ref: { id: 'button-1' },
            method: 'click',
        });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.code, 'FORMS_OPERATION_IN_DOUBT');
        assert.deepStrictEqual(result.data, { status: 'inDoubt', effectPossible: true });
    });
});
