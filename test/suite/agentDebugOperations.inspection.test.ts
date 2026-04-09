/**
 * Unit-тесты для AgentDebugOperations: inspection команды.
 * debugGetStackTrace, debugGetScopes, debugGetVariables, debugEvaluate.
 * Работают без VS Code runtime (core suite / mocha TDD).
 */

import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import {
    debugTestState,
    resetDebugTestState,
    resetVscodeTestState,
    makeMockSession,
    setNextCustomRequestResponse,
    setCustomRequestHandler,
    resetCustomRequestState,
} from '../helpers/vscodeModuleStub';
import { AgentDebugOperations } from '../../src/agent/agentDebugOperations';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistryWithSession(sessionId: string) {
    const registry = new DebugSessionRegistry();
    const ctx = { subscriptions: [] as Array<{ dispose: () => void }> };
    registry.activate(ctx as never);

    const session = makeMockSession(sessionId);
    for (const l of [...debugTestState.onDidStartDebugSessionListeners]) {
        (l as (s: unknown) => void)(session);
    }

    const ops = new AgentDebugOperations(registry);
    return { registry, ops, session };
}

// ---------------------------------------------------------------------------
// debugGetStackTrace
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugGetStackTrace: success', () => {
    setup(() => {
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
    });

    teardown(() => {
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
    });

    test('успех — 3 фрейма, правильный маппинг id/name/file/line', async () => {
        const { ops, session } = makeRegistryWithSession('sess-st-1');

        let capturedCommand = '';
        let capturedArgs: unknown = null;
        setCustomRequestHandler(async (command, args) => {
            capturedCommand = command;
            capturedArgs = args;
            return {
                stackFrames: [
                    { id: 1, name: 'ОсновнаяПроцедура', source: { path: 'C:/module1.bsl' }, line: 10 },
                    { id: 2, name: 'ВспомогательнаяФункция', source: { path: 'C:/module2.bsl' }, line: 25 },
                    { id: 3, name: 'ВнешняяПроцедура', source: { path: 'C:/ext/module3.bsl' }, line: 5 },
                ],
            };
        });

        const result = await ops.debugGetStackTrace({ sessionId: session.id, threadId: 42 });

        assert.strictEqual(result.success, true);
        assert.ok(result.data);
        assert.strictEqual(capturedCommand, 'stackTrace');
        assert.deepStrictEqual(capturedArgs, { threadId: 42, startFrame: 0, levels: 1000 });
        assert.strictEqual(result.data.frames.length, 3);
        assert.deepStrictEqual(result.data.frames[0], { id: 1, name: 'ОсновнаяПроцедура', file: 'C:/module1.bsl', line: 10 });
        assert.deepStrictEqual(result.data.frames[1], { id: 2, name: 'ВспомогательнаяФункция', file: 'C:/module2.bsl', line: 25 });
        assert.deepStrictEqual(result.data.frames[2], { id: 3, name: 'ВнешняяПроцедура', file: 'C:/ext/module3.bsl', line: 5 });
    });

    test('пустые фреймы — stackFrames:[] → frames:[]', async () => {
        const { ops, session } = makeRegistryWithSession('sess-st-2');

        setNextCustomRequestResponse({ stackFrames: [] });

        const result = await ops.debugGetStackTrace({ sessionId: session.id, threadId: 1 });

        assert.strictEqual(result.success, true);
        assert.ok(result.data);
        assert.deepStrictEqual(result.data.frames, []);
    });

    test('маппинг fallback: name отсутствует → "", source отсутствует → file "", line отсутствует → 0', async () => {
        const { ops, session } = makeRegistryWithSession('sess-st-fallback');

        setNextCustomRequestResponse({
            stackFrames: [
                { id: 99 },
                { id: 100, name: 'Known', source: undefined, line: undefined },
            ],
        });

        const result = await ops.debugGetStackTrace({ sessionId: session.id, threadId: 1 });

        assert.strictEqual(result.success, true);
        assert.ok(result.data);
        assert.deepStrictEqual(result.data.frames[0], { id: 99, name: '', file: '', line: 0 });
        assert.deepStrictEqual(result.data.frames[1], { id: 100, name: 'Known', file: '', line: 0 });
    });

    test('customRequest бросает → ошибка', async () => {
        const { ops, session } = makeRegistryWithSession('sess-st-err');

        setNextCustomRequestResponse('connection lost', true);

        const result = await ops.debugGetStackTrace({ sessionId: session.id, threadId: 1 });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('connection lost'), `error: ${result.error}`);
    });

    test('сессия не найдена → ошибка', async () => {
        resetDebugTestState();
        const registry = new DebugSessionRegistry();
        const ops = new AgentDebugOperations(registry);

        const result = await ops.debugGetStackTrace({ sessionId: 'nonexistent', threadId: 1 });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'session not found in registry');
    });
});

// ---------------------------------------------------------------------------
// debugGetScopes
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugGetScopes: success', () => {
    setup(() => {
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
    });

    teardown(() => {
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
    });

    test('успех — 2 scope, проверить маппинг varRef ← variablesReference и command/args', async () => {
        const { ops, session } = makeRegistryWithSession('sess-scopes-1');

        let capturedCommand = '';
        let capturedArgs: unknown = null;
        setCustomRequestHandler(async (command, args) => {
            capturedCommand = command;
            capturedArgs = args;
            return {
                scopes: [
                    { name: 'Локальные', variablesReference: 100 },
                    { name: 'Глобальные', variablesReference: 200 },
                ],
            };
        });

        const result = await ops.debugGetScopes({ sessionId: session.id, frameId: 55 });

        assert.strictEqual(result.success, true);
        assert.ok(result.data);
        assert.strictEqual(capturedCommand, 'scopes');
        assert.deepStrictEqual(capturedArgs, { frameId: 55 });
        assert.strictEqual(result.data.scopes.length, 2);
        assert.deepStrictEqual(result.data.scopes[0], { name: 'Локальные', varRef: 100 });
        assert.deepStrictEqual(result.data.scopes[1], { name: 'Глобальные', varRef: 200 });
    });

    test('пустые scope → []', async () => {
        const { ops, session } = makeRegistryWithSession('sess-scopes-2');

        setNextCustomRequestResponse({ scopes: [] });

        const result = await ops.debugGetScopes({ sessionId: session.id, frameId: 1 });

        assert.strictEqual(result.success, true);
        assert.ok(result.data);
        assert.deepStrictEqual(result.data.scopes, []);
    });

    test('сессия не найдена → ошибка', async () => {
        resetDebugTestState();
        const registry = new DebugSessionRegistry();
        const ops = new AgentDebugOperations(registry);

        const result = await ops.debugGetScopes({ sessionId: 'nonexistent', frameId: 1 });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'session not found in registry');
    });

    test('customRequest бросает → ошибка', async () => {
        const { ops, session } = makeRegistryWithSession('sess-scopes-err');

        setNextCustomRequestResponse('scopes error', true);

        const result = await ops.debugGetScopes({ sessionId: session.id, frameId: 1 });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('scopes error'), `error: ${result.error}`);
    });
});

// ---------------------------------------------------------------------------
// debugGetVariables
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugGetVariables: success', () => {
    setup(() => {
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
    });

    teardown(() => {
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
    });

    test('успех — 3 переменные, varRef=0 для примитивов и >0 для объектов', async () => {
        const { ops, session } = makeRegistryWithSession('sess-vars-1');

        let capturedCommand = '';
        let capturedArgs: unknown = null;
        setCustomRequestHandler(async (command, args) => {
            capturedCommand = command;
            capturedArgs = args;
            return {
                variables: [
                    { name: 'Число', type: 'Number', value: '42', variablesReference: 0 },
                    { name: 'Строка', type: 'String', value: 'Привет', variablesReference: 0 },
                    { name: 'Объект', type: 'Object', value: 'СправочникСсылка.Товары', variablesReference: 300 },
                ],
            };
        });

        const result = await ops.debugGetVariables({ sessionId: session.id, varRef: 100 });

        assert.strictEqual(result.success, true);
        assert.ok(result.data);
        assert.strictEqual(capturedCommand, 'variables');
        assert.deepStrictEqual(capturedArgs, { variablesReference: 100 });
        assert.strictEqual(result.data.vars.length, 3);
        assert.deepStrictEqual(result.data.vars[0], { name: 'Число', type: 'Number', value: '42', varRef: 0 });
        assert.deepStrictEqual(result.data.vars[1], { name: 'Строка', type: 'String', value: 'Привет', varRef: 0 });
        assert.deepStrictEqual(result.data.vars[2], { name: 'Объект', type: 'Object', value: 'СправочникСсылка.Товары', varRef: 300 });
    });

    test('пустой список переменных → vars:[]', async () => {
        const { ops, session } = makeRegistryWithSession('sess-vars-2');

        setNextCustomRequestResponse({ variables: [] });

        const result = await ops.debugGetVariables({ sessionId: session.id, varRef: 1 });

        assert.strictEqual(result.success, true);
        assert.ok(result.data);
        assert.deepStrictEqual(result.data.vars, []);
    });

    test('маппинг fallback type → "" когда type отсутствует', async () => {
        const { ops, session } = makeRegistryWithSession('sess-vars-fallback');

        setNextCustomRequestResponse({
            variables: [
                { name: 'БезТипа', value: 'значение', variablesReference: 0 },
            ],
        });

        const result = await ops.debugGetVariables({ sessionId: session.id, varRef: 1 });

        assert.strictEqual(result.success, true);
        assert.ok(result.data);
        assert.deepStrictEqual(result.data.vars[0], { name: 'БезТипа', type: '', value: 'значение', varRef: 0 });
    });

    test('сессия не найдена → ошибка', async () => {
        resetDebugTestState();
        const registry = new DebugSessionRegistry();
        const ops = new AgentDebugOperations(registry);

        const result = await ops.debugGetVariables({ sessionId: 'nonexistent', varRef: 1 });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'session not found in registry');
    });

    test('customRequest бросает → ошибка', async () => {
        const { ops, session } = makeRegistryWithSession('sess-vars-err');

        setNextCustomRequestResponse('variables error', true);

        const result = await ops.debugGetVariables({ sessionId: session.id, varRef: 1 });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('variables error'), `error: ${result.error}`);
    });
});

// ---------------------------------------------------------------------------
// debugEvaluate
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugEvaluate: success', () => {
    setup(() => {
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
    });

    teardown(() => {
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
    });

    test('успех — expression передан, получен result/type/varRef', async () => {
        const { ops, session } = makeRegistryWithSession('sess-eval-1');

        let capturedCommand = '';
        let capturedArgs: unknown = null;
        setCustomRequestHandler(async (command, args) => {
            capturedCommand = command;
            capturedArgs = args;
            return {
                result: '84',
                type: 'Number',
                variablesReference: 0,
            };
        });

        const result = await ops.debugEvaluate({ sessionId: session.id, expression: 'a+b' });

        assert.strictEqual(result.success, true);
        assert.ok(result.data);
        assert.strictEqual(capturedCommand, 'evaluate');
        assert.deepStrictEqual(capturedArgs, { expression: 'a+b', frameId: undefined, context: 'watch' });
        assert.strictEqual(result.data.value, '84');
        assert.strictEqual(result.data.type, 'Number');
        assert.strictEqual(result.data.varRef, 0);
    });

    test('frameId передан в customRequest', async () => {
        const { ops, session } = makeRegistryWithSession('sess-eval-2');

        let capturedArgs: unknown = null;
        setCustomRequestHandler(async (_command, args) => {
            capturedArgs = args;
            return { result: 'true', type: 'Boolean', variablesReference: 0 };
        });

        await ops.debugEvaluate({ sessionId: session.id, expression: 'Истина', frameId: 77 });

        assert.deepStrictEqual(capturedArgs, { expression: 'Истина', frameId: 77, context: 'watch' });
    });

    test('expression пустой → ошибка валидации', async () => {
        const { ops, session } = makeRegistryWithSession('sess-eval-3');

        const result = await ops.debugEvaluate({ sessionId: session.id, expression: '' });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('expression'), `error: ${result.error}`);
    });

    test('сессия не найдена → ошибка', async () => {
        resetDebugTestState();
        const registry = new DebugSessionRegistry();
        const ops = new AgentDebugOperations(registry);

        const result = await ops.debugEvaluate({ sessionId: 'nonexistent', expression: '1+1' });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'session not found in registry');
    });

    test('customRequest бросает → ошибка', async () => {
        const { ops, session } = makeRegistryWithSession('sess-eval-err');

        setNextCustomRequestResponse('evaluate failed', true);

        const result = await ops.debugEvaluate({ sessionId: session.id, expression: 'СложноеВыражение()' });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('evaluate failed'), `error: ${result.error}`);
    });
});
