/**
 * Unit-тесты для AgentDebugOperations: control flow команды.
 * debugContinue, debugStepOver, debugStepIn, debugStepOut.
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
// debugContinue
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugContinue', () => {
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

    test('успех — вызван customRequest("continue", {threadId}), возврат {success:true}', async () => {
        const { ops, session } = makeRegistryWithSession('sess-continue-1');

        let capturedCommand = '';
        let capturedArgs: unknown = null;
        setCustomRequestHandler(async (command, args) => {
            capturedCommand = command;
            capturedArgs = args;
            return {};
        });

        const result = await ops.debugContinue({ sessionId: session.id, threadId: 10 });

        assert.strictEqual(result.success, true);
        assert.strictEqual(capturedCommand, 'continue');
        assert.deepStrictEqual(capturedArgs, { threadId: 10 });
    });

    test('сессия не найдена → ошибка "session not found in registry"', async () => {
        resetDebugTestState();
        const registry = new DebugSessionRegistry();
        const ops = new AgentDebugOperations(registry);

        const result = await ops.debugContinue({ sessionId: 'nonexistent', threadId: 1 });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'session not found in registry');
    });

    test('customRequest бросает → ошибка с префиксом "continue failed:"', async () => {
        const { ops, session } = makeRegistryWithSession('sess-continue-err');

        setNextCustomRequestResponse('network error', true);

        const result = await ops.debugContinue({ sessionId: session.id, threadId: 5 });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.startsWith('continue failed:'), `error: ${result.error}`);
        assert.ok(result.error?.includes('network error'), `error: ${result.error}`);
    });

    test('sessionId пустой → ошибка валидации', async () => {
        const registry = new DebugSessionRegistry();
        const ops = new AgentDebugOperations(registry);

        const result = await ops.debugContinue({ sessionId: '', threadId: 1 });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('sessionId'), `error: ${result.error}`);
    });
});

// ---------------------------------------------------------------------------
// debugStepOver
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugStepOver', () => {
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

    test('успех — вызван customRequest("next", {threadId}), возврат {success:true}', async () => {
        const { ops, session } = makeRegistryWithSession('sess-stepover-1');

        let capturedCommand = '';
        let capturedArgs: unknown = null;
        setCustomRequestHandler(async (command, args) => {
            capturedCommand = command;
            capturedArgs = args;
            return {};
        });

        const result = await ops.debugStepOver({ sessionId: session.id, threadId: 20 });

        assert.strictEqual(result.success, true);
        assert.strictEqual(capturedCommand, 'next');
        assert.deepStrictEqual(capturedArgs, { threadId: 20 });
    });

    test('сессия не найдена → ошибка "session not found in registry"', async () => {
        resetDebugTestState();
        const registry = new DebugSessionRegistry();
        const ops = new AgentDebugOperations(registry);

        const result = await ops.debugStepOver({ sessionId: 'nonexistent', threadId: 1 });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'session not found in registry');
    });

    test('customRequest бросает → ошибка с префиксом "stepOver failed:"', async () => {
        const { ops, session } = makeRegistryWithSession('sess-stepover-err');

        setNextCustomRequestResponse('step error', true);

        const result = await ops.debugStepOver({ sessionId: session.id, threadId: 5 });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.startsWith('stepOver failed:'), `error: ${result.error}`);
        assert.ok(result.error?.includes('step error'), `error: ${result.error}`);
    });

    test('threadId не число → ошибка валидации', async () => {
        const registry = new DebugSessionRegistry();
        const ops = new AgentDebugOperations(registry);

        const result = await ops.debugStepOver({ sessionId: 'some-id', threadId: 'not-a-number' as unknown as number });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('threadId'), `error: ${result.error}`);
    });
});

// ---------------------------------------------------------------------------
// debugStepIn
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugStepIn', () => {
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

    test('успех — вызван customRequest("stepIn", {threadId}), возврат {success:true}', async () => {
        const { ops, session } = makeRegistryWithSession('sess-stepin-1');

        let capturedCommand = '';
        let capturedArgs: unknown = null;
        setCustomRequestHandler(async (command, args) => {
            capturedCommand = command;
            capturedArgs = args;
            return {};
        });

        const result = await ops.debugStepIn({ sessionId: session.id, threadId: 30 });

        assert.strictEqual(result.success, true);
        assert.strictEqual(capturedCommand, 'stepIn');
        assert.deepStrictEqual(capturedArgs, { threadId: 30 });
    });

    test('сессия не найдена → ошибка "session not found in registry"', async () => {
        resetDebugTestState();
        const registry = new DebugSessionRegistry();
        const ops = new AgentDebugOperations(registry);

        const result = await ops.debugStepIn({ sessionId: 'nonexistent', threadId: 1 });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'session not found in registry');
    });

    test('customRequest бросает → ошибка с префиксом "stepIn failed:"', async () => {
        const { ops, session } = makeRegistryWithSession('sess-stepin-err');

        setNextCustomRequestResponse('stepin error', true);

        const result = await ops.debugStepIn({ sessionId: session.id, threadId: 5 });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.startsWith('stepIn failed:'), `error: ${result.error}`);
        assert.ok(result.error?.includes('stepin error'), `error: ${result.error}`);
    });
});

// ---------------------------------------------------------------------------
// debugStepOut
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugStepOut', () => {
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

    test('успех — вызван customRequest("stepOut", {threadId}), возврат {success:true}', async () => {
        const { ops, session } = makeRegistryWithSession('sess-stepout-1');

        let capturedCommand = '';
        let capturedArgs: unknown = null;
        setCustomRequestHandler(async (command, args) => {
            capturedCommand = command;
            capturedArgs = args;
            return {};
        });

        const result = await ops.debugStepOut({ sessionId: session.id, threadId: 40 });

        assert.strictEqual(result.success, true);
        assert.strictEqual(capturedCommand, 'stepOut');
        assert.deepStrictEqual(capturedArgs, { threadId: 40 });
    });

    test('сессия не найдена → ошибка "session not found in registry"', async () => {
        resetDebugTestState();
        const registry = new DebugSessionRegistry();
        const ops = new AgentDebugOperations(registry);

        const result = await ops.debugStepOut({ sessionId: 'nonexistent', threadId: 1 });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'session not found in registry');
    });

    test('customRequest бросает → ошибка с префиксом "stepOut failed:"', async () => {
        const { ops, session } = makeRegistryWithSession('sess-stepout-err');

        setNextCustomRequestResponse('stepout error', true);

        const result = await ops.debugStepOut({ sessionId: session.id, threadId: 5 });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.startsWith('stepOut failed:'), `error: ${result.error}`);
        assert.ok(result.error?.includes('stepout error'), `error: ${result.error}`);
    });
});
