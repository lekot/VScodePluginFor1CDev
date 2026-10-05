import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import { FormsOperations } from '../../src/agent/agentFormsOperations';
import { FormsContext } from '../../src/services/forms/FormsContext';
import type { NativeFormsSession } from '../../src/services/forms/nativeFormsSession';

function makeSession(): NativeFormsSession & { closeCount: number; finishClose(): void } {
    let connected = true;
    let closeCount = 0;
    return {
        host: '127.0.0.1',
        port: 32150,
        get connected() { return connected; },
        get closeCount() { return closeCount; },
        async execute() { return { matches: [] }; },
        async close() {
            closeCount += 1;
            connected = false;
        },
        finishClose() { connected = false; },
    };
}

suite('Forms native session lifecycle', () => {
    test('stop closes the owned TestClient socket and is idempotent', async () => {
        const context = new FormsContext();
        const session = makeSession();
        context.setNativeSession(session);

        assert.deepStrictEqual(await context.stop(), { errors: [] });
        assert.strictEqual(session.closeCount, 1);
        assert.strictEqual(context.nativeSession, undefined);
        assert.deepStrictEqual(await context.stop(), { errors: [] });
        assert.strictEqual(session.closeCount, 1);
    });

    test('retains a connected session after close fails so a later stop can retry', async () => {
        const context = new FormsContext();
        let closeCount = 0;
        let connected = true;
        const session: NativeFormsSession = {
            host: '127.0.0.1',
            port: 32151,
            get connected() { return connected; },
            async execute() { return { matches: [] }; },
            async close() {
                closeCount += 1;
                if (closeCount === 1) { throw new Error('socket still busy'); }
                connected = false;
            },
        };
        context.setNativeSession(session);

        assert.deepStrictEqual(await context.stop(), { errors: ['native TestClient connection: socket still busy'] });
        assert.strictEqual(context.nativeSession, session);
        assert.deepStrictEqual(await context.stop(), { errors: [] });
        assert.strictEqual(closeCount, 2);
        assert.strictEqual(context.nativeSession, undefined);
    });

    test('serializes start and stop so stop closes the session created by the pending start', async () => {
        const context = new FormsContext();
        const session = makeSession();
        let finishConnect: ((value: NativeFormsSession) => void) | undefined;
        const operations = new FormsOperations({
            context,
            connectNativeClient: () => new Promise((resolve) => { finishConnect = resolve; }),
        });

        const starting = operations.formsStart({ port: 32150 });
        while (!finishConnect) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const stopping = operations.formsStop({});
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.strictEqual(session.closeCount, 0, 'stop waits behind the in-progress start');

        finishConnect(session);
        assert.strictEqual((await starting).success, true);
        assert.strictEqual((await stopping).success, true);
        assert.strictEqual(session.closeCount, 1);
        assert.strictEqual(context.nativeSession, undefined);
    });
});
