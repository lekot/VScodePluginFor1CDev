/**
 * Unit-тесты для AgentDebugOperations: debugWaitForStop.
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
import type { LastStop } from '../../src/agent/debugSessionRegistry';

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

function makeStackTraceResponse(frames: Array<{ id: number; source?: { path?: string }; line?: number }>) {
    return { stackFrames: frames };
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugWaitForStop: validation', () => {
    let registry: DebugSessionRegistry;
    let ops: AgentDebugOperations;

    setup(() => {
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
        registry = new DebugSessionRegistry();
        ops = new AgentDebugOperations(registry);
    });

    teardown(() => {
        registry.dispose();
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
    });

    // --- 9. Отсутствует sessionId ---
    test('sessionId пустая строка → ошибка валидации', async () => {
        const result = await ops.debugWaitForStop({ sessionId: '' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('sessionId'), `error: ${result.error}`);
    });

    // --- 8. session not found ---
    test('session not found in registry → ошибка', async () => {
        const result = await ops.debugWaitForStop({ sessionId: 'nonexistent-session' });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'session not found in registry');
    });
});

suite('AgentDebugOperations — debugWaitForStop: cached stop', () => {
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

    // --- 1. Cached stop (свежий) ---
    test('свежий lastStop (<500мс) — используется без ожидания, возврат success', async () => {
        const { ops, registry } = makeRegistryWithSession('sess-cached-1');

        const entry = registry.get('sess-cached-1');
        assert.ok(entry);

        // Устанавливаем свежий lastStop
        entry.lastStop = { reason: 'breakpoint', threadId: 3, receivedAt: Date.now() };

        // Мокаем customRequest для stackTrace
        setNextCustomRequestResponse(makeStackTraceResponse([
            { id: 42, source: { path: 'C:/foo.bsl' }, line: 10 },
        ]));

        const result = await ops.debugWaitForStop({ sessionId: 'sess-cached-1' });

        assert.strictEqual(result.success, true);
        assert.ok(result.data);
        assert.strictEqual(result.data.reason, 'breakpoint');
        assert.strictEqual(result.data.threadId, 3);
        assert.strictEqual(result.data.frameId, 42);
        assert.strictEqual(result.data.file, 'C:/foo.bsl');
        assert.strictEqual(result.data.line, 10);
    });

    // --- 2. Cached stop устарел (>500мс) ---
    test('устаревший lastStop (>500мс) — НЕ использует кэш, ждёт новый stop', async () => {
        const { ops, registry } = makeRegistryWithSession('sess-cached-2');

        const entry = registry.get('sess-cached-2');
        assert.ok(entry);

        // Устанавливаем УСТАРЕВШИЙ lastStop
        entry.lastStop = { reason: 'breakpoint', threadId: 1, receivedAt: Date.now() - 1000 };

        // Немного после вызова — резолвим через waiter
        let waitForStopPromise: Promise<unknown>;

        setNextCustomRequestResponse(makeStackTraceResponse([
            { id: 99, source: { path: 'C:/bar.bsl' }, line: 5 },
        ]));

        waitForStopPromise = ops.debugWaitForStop({ sessionId: 'sess-cached-2', timeoutMs: 200 });

        // Ждём пока waiter зарегистрируется
        await new Promise(r => setTimeout(r, 20));

        // Убеждаемся что waiter добавлен (кэш не использован)
        assert.strictEqual(entry.waiters.length, 1, 'waiter должен быть в очереди');

        // Резолвим с новым stop
        const newStop: LastStop = { reason: 'step', threadId: 2, receivedAt: Date.now() };
        entry.waiters[0](newStop);

        const result = await waitForStopPromise as { success: boolean; data?: { threadId: number } };
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data?.threadId, 2, 'должен использовать threadId нового stop');
    });
});

suite('AgentDebugOperations — debugWaitForStop: waiting', () => {
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

    // --- 3. Ожидание stop через waiter ---
    test('ожидание через waiter — после резолва возвращает success', async () => {
        const { ops, registry } = makeRegistryWithSession('sess-wait-1');

        const entry = registry.get('sess-wait-1');
        assert.ok(entry);
        // Нет lastStop, должен ждать

        setNextCustomRequestResponse(makeStackTraceResponse([
            { id: 7, source: { path: 'C:/module.bsl' }, line: 20 },
        ]));

        const waitPromise = ops.debugWaitForStop({ sessionId: 'sess-wait-1', timeoutMs: 500 });

        // Подождать пока waiter зарегистрируется
        await new Promise(r => setTimeout(r, 10));

        assert.strictEqual(entry.waiters.length, 1);

        // Симулируем stopped event через waiter
        const stop: LastStop = { reason: 'breakpoint', threadId: 1, receivedAt: Date.now() };
        entry.waiters[0](stop);

        const result = await waitPromise as { success: boolean; data?: { frameId: number; reason: string } };
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.data?.frameId, 7);
        assert.strictEqual(result.data?.reason, 'breakpoint');
    });

    // --- 4. Таймаут ---
    test('таймаут — возврат ошибки, waiter удалён из массива', async () => {
        const { ops, registry } = makeRegistryWithSession('sess-timeout-1');

        const entry = registry.get('sess-timeout-1');
        assert.ok(entry);

        const result = await ops.debugWaitForStop({ sessionId: 'sess-timeout-1', timeoutMs: 50 });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'timeout waiting for stop');
        assert.strictEqual(entry.waiters.length, 0, 'waiter должен быть удалён после таймаута');
    });

    // --- 5. Terminated во время ожидания ---
    test('terminated event во время ожидания → ошибка terminated', async () => {
        const { ops, registry } = makeRegistryWithSession('sess-term-1');

        const entry = registry.get('sess-term-1');
        assert.ok(entry);

        const waitPromise = ops.debugWaitForStop({ sessionId: 'sess-term-1', timeoutMs: 500 });

        await new Promise(r => setTimeout(r, 10));

        assert.strictEqual(entry.waiters.length, 1);

        // Симулируем terminate — резолвим с reason='terminated'
        const termStop: LastStop = { reason: 'terminated', threadId: -1, receivedAt: Date.now() };
        entry.waiters[0](termStop);

        const result = await waitPromise as { success: boolean; error?: string };
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'session terminated while waiting for stop');
    });
});

suite('AgentDebugOperations — debugWaitForStop: stackTrace handling', () => {
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

    // --- 6. stackTrace не вернул фреймы ---
    test('stackTrace пустой массив фреймов → ошибка', async () => {
        const { ops, registry } = makeRegistryWithSession('sess-st-empty');

        const entry = registry.get('sess-st-empty');
        assert.ok(entry);

        entry.lastStop = { reason: 'breakpoint', threadId: 1, receivedAt: Date.now() };
        setNextCustomRequestResponse({ stackFrames: [] });

        const result = await ops.debugWaitForStop({ sessionId: 'sess-st-empty' });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.error, 'stackTrace returned no frames');
    });

    // --- 7. stackTrace бросил исключение ---
    test('customRequest stackTrace бросает → ошибка с префиксом', async () => {
        const { ops, registry } = makeRegistryWithSession('sess-st-err');

        const entry = registry.get('sess-st-err');
        assert.ok(entry);

        entry.lastStop = { reason: 'step', threadId: 2, receivedAt: Date.now() };
        setNextCustomRequestResponse('DAP connection lost', true);

        const result = await ops.debugWaitForStop({ sessionId: 'sess-st-err' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.startsWith('stackTrace failed: '), `error: ${result.error}`);
    });

    // --- 10. Маппинг полей ---
    test('маппинг полей frameId, file, line из stackTrace', async () => {
        const { ops, registry } = makeRegistryWithSession('sess-map-1');

        const entry = registry.get('sess-map-1');
        assert.ok(entry);

        entry.lastStop = { reason: 'exception', threadId: 5, receivedAt: Date.now() };
        setNextCustomRequestResponse(makeStackTraceResponse([
            { id: 42, source: { path: 'C:/foo.bsl' }, line: 10 },
        ]));

        const result = await ops.debugWaitForStop({ sessionId: 'sess-map-1' });

        assert.strictEqual(result.success, true);
        assert.ok(result.data);
        assert.strictEqual(result.data.frameId, 42);
        assert.strictEqual(result.data.file, 'C:/foo.bsl');
        assert.strictEqual(result.data.line, 10);
        assert.strictEqual(result.data.reason, 'exception');
        assert.strictEqual(result.data.threadId, 5);
    });
});

suite('AgentDebugOperations — debugWaitForStop: Tracker integration', () => {
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

    // --- Tracker резолвит waiters ---
    test('Tracker.onDidSendMessage при stopped резолвит waiters', () => {
        const registry = new DebugSessionRegistry();
        const ctx = { subscriptions: [] as Array<{ dispose: () => void }> };
        registry.activate(ctx as never);

        const session = makeMockSession('sess-tracker-1');
        for (const l of [...debugTestState.onDidStartDebugSessionListeners]) {
            (l as (s: unknown) => void)(session);
        }

        const entry = registry.get('sess-tracker-1');
        assert.ok(entry);

        let receivedStop: LastStop | undefined;
        entry.waiters.push((stop) => { receivedStop = stop; });

        // Получаем tracker из фабрики
        const factoryRecord = debugTestState.registeredTrackerFactories[0];
        const factory = factoryRecord.factory as {
            createDebugAdapterTracker: (s: unknown) => { onDidSendMessage: (m: unknown) => void };
        };
        const tracker = factory.createDebugAdapterTracker(session);

        // Эмулируем stopped event
        tracker.onDidSendMessage({
            type: 'event',
            event: 'stopped',
            body: { reason: 'breakpoint', threadId: 3 },
        });

        assert.ok(receivedStop, 'waiter должен быть вызван');
        assert.strictEqual(receivedStop!.reason, 'breakpoint');
        assert.strictEqual(receivedStop!.threadId, 3);
        assert.strictEqual(entry.waiters.length, 0, 'waiter должен быть удалён из массива');
    });

    // --- splice(0) атомарность: новые waiters не попадают в текущий батч ---
    test('waiters добавленные из колбэка не вызываются в том же batche', () => {
        const registry = new DebugSessionRegistry();
        const ctx = { subscriptions: [] as Array<{ dispose: () => void }> };
        registry.activate(ctx as never);

        const session = makeMockSession('sess-tracker-2');
        for (const l of [...debugTestState.onDidStartDebugSessionListeners]) {
            (l as (s: unknown) => void)(session);
        }

        const entry = registry.get('sess-tracker-2');
        assert.ok(entry);

        let secondCallCount = 0;
        // Первый waiter при вызове добавляет второй waiter
        entry.waiters.push((_stop) => {
            entry.waiters.push((_s) => { secondCallCount++; });
        });

        const factoryRecord = debugTestState.registeredTrackerFactories[0];
        const factory = factoryRecord.factory as {
            createDebugAdapterTracker: (s: unknown) => { onDidSendMessage: (m: unknown) => void };
        };
        const tracker = factory.createDebugAdapterTracker(session);

        tracker.onDidSendMessage({
            type: 'event',
            event: 'stopped',
            body: { reason: 'step', threadId: 1 },
        });

        assert.strictEqual(secondCallCount, 0, 'второй waiter не должен быть вызван в текущем batche');
        assert.strictEqual(entry.waiters.length, 1, 'второй waiter остаётся в массиве для следующего события');
    });
});
