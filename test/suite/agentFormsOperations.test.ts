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
