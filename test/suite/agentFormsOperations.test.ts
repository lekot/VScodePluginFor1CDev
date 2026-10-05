import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import type {
    FormsStartParams,
    NativeFormsAction,
    NativeFormsActionResult,
} from '../../src/agent/agentFormsTypes';
import { FormsOperations } from '../../src/agent/agentFormsOperations';
import { FormsContext } from '../../src/services/forms/FormsContext';
import type { NativeFormsSession } from '../../src/services/forms/nativeFormsSession';

function nativeSession(
    host = '127.0.0.1',
    port = 32138,
    execute: NativeFormsSession['execute'] = async () => ({ matches: [] }),
): NativeFormsSession {
    let connected = true;
    return {
        host,
        port,
        get connected() { return connected; },
        execute,
        async close() { connected = false; },
    };
}

function start(operations: FormsOperations, input: unknown) {
    return operations.formsStart(input as FormsStartParams);
}

suite('FormsOperations — native TestClient contract', () => {
    test('forms.start requires a valid port, defaults the host, and accepts an omitted native driver', async () => {
        const context = new FormsContext();
        let receivedOptions: { host: string; port: number; platformVersion?: string; timeoutMs: number } | undefined;
        const session = nativeSession();
        const operations = new FormsOperations({
            context,
            connectNativeClient: async (options) => {
                receivedOptions = options;
                return session;
            },
        });

        const missingPort = await start(operations, {});
        assert.strictEqual(missingPort.success, false);
        assert.match(missingPort.error ?? '', /port/);

        const invalidPort = await start(operations, { port: 65536 });
        assert.strictEqual(invalidPort.success, false);

        const result = await operations.formsStart({ port: 32138, platformVersion: '8.3.27' });
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(receivedOptions, {
            host: '127.0.0.1',
            port: 32138,
            platformVersion: '8.3.27',
            timeoutMs: 15_000,
        });
        assert.deepStrictEqual(result.data, {
            driver: 'native',
            host: '127.0.0.1',
            port: 32138,
            uiAccessHint: 'Используйте forms.native для чтения формы, команд, таблиц, снимков состояния и UI log. forms.shot снимает окно локального TestClient на Windows.',
        });
    });

    test('forms.start rejects web driver and every web-only startup field', async () => {
        const operations = new FormsOperations({
            context: new FormsContext(),
            connectNativeClient: async () => { throw new Error('must not connect'); },
        });
        const invalidInputs = [
            { driver: 'web', port: 32138 },
            { port: 32138, url: 'http://localhost/app' },
            { port: 32138, dbPath: 'C:/db' },
            { port: 32138, platformPath: 'C:/1cv8/bin' },
            { port: 32138, readyTimeoutMs: 1000 },
        ];

        for (const input of invalidInputs) {
            const result = await start(operations, input);
            assert.strictEqual(result.success, false, JSON.stringify(input));
        }
    });

    test('status, shot, and stop use only the active native session', async () => {
        const context = new FormsContext();
        const session = nativeSession('localhost', 32139);
        let closed = 0;
        const originalClose = session.close.bind(session);
        session.close = async () => { closed += 1; await originalClose(); };
        context.setNativeSession(session);
        let screenshotRequest: { host: string; port: number; file: string } | undefined;
        const operations = new FormsOperations({
            context,
            captureNativeScreenshot: async (options) => {
                screenshotRequest = { host: options.host, port: options.port, file: options.file };
                return { file: options.file, width: 1280, height: 720 };
            },
        });

        const status = await operations.formsStatus({});
        assert.deepStrictEqual(status, {
            success: true,
            data: { driver: 'native', nativeConnected: true, host: 'localhost', port: 32139 },
        });

        const shot = await operations.formsShot({ file: 'C:/temp/form.png' });
        assert.deepStrictEqual(screenshotRequest, {
            host: 'localhost',
            port: 32139,
            file: 'C:/temp/form.png',
        });
        assert.deepStrictEqual(shot, { success: true, data: { file: 'C:/temp/form.png' } });

        const stopped = await operations.formsStop({});
        assert.deepStrictEqual(stopped, { success: true, data: {} });
        assert.strictEqual(closed, 1);
        assert.strictEqual(context.nativeSession, undefined);
        assert.deepStrictEqual(await operations.formsStatus({}), { success: true, data: { nativeConnected: false } });
    });

    test('shot fails without a connected native session and never starts another runner', async () => {
        let captureCalled = false;
        const operations = new FormsOperations({
            context: new FormsContext(),
            captureNativeScreenshot: async () => {
                captureCalled = true;
                throw new Error('must not capture');
            },
        });

        const result = await operations.formsShot({});

        assert.strictEqual(result.success, false);
        assert.match(result.error ?? '', /Нет активной native TestClient сессии/);
        assert.strictEqual(captureCalled, false);
    });

    test('native actions forward typed parameters and report uncertain mutations', async () => {
        const context = new FormsContext();
        let receivedAction: NativeFormsAction | undefined;
        let receivedTimeout: number | undefined;
        context.setNativeSession(nativeSession('localhost', 32140, async (action, options) => {
            receivedAction = action;
            receivedTimeout = options.timeoutMs;
            return { ref: { id: 'field-1' }, accepted: true, text: '42' } as NativeFormsActionResult;
        }));
        const operations = new FormsOperations({ context });
        const result = await operations.formsNative({
            action: 'writeField',
            ref: { id: 'field-1' },
            value: '42',
            timeoutMs: 7000,
            background: false,
        });

        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(receivedAction, {
            action: 'writeField',
            ref: { id: 'field-1' },
            value: '42',
        });
        assert.strictEqual(receivedTimeout, 7000);

        const failedContext = new FormsContext();
        failedContext.setNativeSession(nativeSession('localhost', 32141, async () => {
            throw Object.assign(new Error('response timed out after write'), {
                code: 'FORMS_OPERATION_IN_DOUBT',
                effectPossible: true,
            });
        }));
        const failed = await new FormsOperations({ context: failedContext }).formsNative({
            action: 'act',
            ref: { id: 'button-1' },
            method: 'click',
        });
        assert.strictEqual(failed.success, false);
        assert.strictEqual(failed.code, 'FORMS_OPERATION_IN_DOUBT');
        assert.deepStrictEqual(failed.data, { status: 'inDoubt', effectPossible: true });
    });

    test('forms.stop reports an unclosed socket and retains ownership for retry', async () => {
        const context = new FormsContext();
        const session: NativeFormsSession = {
            host: 'localhost',
            port: 32142,
            connected: true,
            async execute(): Promise<NativeFormsActionResult> { throw new Error('not called'); },
            async close() { throw new Error('socket close failed'); },
        };
        context.setNativeSession(session);
        const operations = new FormsOperations({ context });

        const result = await operations.formsStop({});

        assert.strictEqual(result.success, false);
        assert.match(result.error ?? '', /socket close failed/);
        assert.strictEqual(context.nativeSession, session);
    });
});
