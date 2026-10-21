/**
 * Unit-тесты для DebugSessionRegistry.
 * Работают без VS Code runtime (core suite / mocha TDD).
 */

import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import {
    debugTestState,
    resetDebugTestState,
    fireDidStartDebugSession,
    fireDidTerminateDebugSession,
} from '../helpers/vscodeModuleStub';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';
import type { LastStop } from '../../src/agent/debugSessionRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id: string, type: string): unknown {
    return { id, type, name: `session-${id}`, workspaceFolder: undefined, configuration: {} };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('DebugSessionRegistry — activate', () => {
    let registry: DebugSessionRegistry;

    setup(() => {
        resetDebugTestState();
        registry = new DebugSessionRegistry();
    });

    teardown(() => {
        registry.dispose();
        resetDebugTestState();
    });

    test('после activate созданы 3 подписки', () => {
        registry.activate();

        // onDidStartDebugSession, onDidTerminateDebugSession, registerDebugAdapterTrackerFactory
        assert.strictEqual(debugTestState.onDidStartDebugSessionListeners.length, 1, 'start listener');
        assert.strictEqual(debugTestState.onDidTerminateDebugSessionListeners.length, 1, 'terminate listener');
        assert.strictEqual(debugTestState.registeredTrackerFactories.length, 1, 'tracker factory');
        assert.strictEqual(debugTestState.registeredTrackerFactories[0].type, 'bsl');
    });

    test('сессия типа bsl попадает в реестр', () => {
        registry.activate();

        const session = makeSession('sess-1', 'bsl');
        fireDidStartDebugSession(session);

        const entry = registry.get('sess-1');
        assert.ok(entry, 'entry должен быть в реестре');
        assert.strictEqual(entry.session, session);
        assert.deepStrictEqual(entry.waiters, []);
    });

    test('сессия другого типа игнорируется', () => {
        registry.activate();

        const session = makeSession('sess-2', 'node');
        fireDidStartDebugSession(session);

        assert.strictEqual(registry.get('sess-2'), undefined);
    });

    test('onDidTerminateDebugSession удаляет запись', () => {
        registry.activate();

        const session = makeSession('sess-3', 'bsl');
        fireDidStartDebugSession(session);
        assert.ok(registry.get('sess-3'), 'сессия должна быть до terminate');

        fireDidTerminateDebugSession(session);
        assert.strictEqual(registry.get('sess-3'), undefined, 'сессия должна быть удалена');
    });

    test('onDidTerminateDebugSession резолвит waiters с reason terminated', () => {
        registry.activate();

        const session = makeSession('sess-4', 'bsl');
        fireDidStartDebugSession(session);

        const entry = registry.get('sess-4');
        assert.ok(entry);

        let receivedStop: LastStop | undefined;
        entry.waiters.push((stop) => { receivedStop = stop; });

        fireDidTerminateDebugSession(session);

        assert.ok(receivedStop, 'waiter должен быть вызван');
        assert.strictEqual(receivedStop.reason, 'terminated');
        assert.strictEqual(receivedStop.threadId, -1);
    });

    test('DebugAdapterTracker сохраняет lastStop при stopped event', () => {
        registry.activate();

        const session = makeSession('sess-5', 'bsl');
        fireDidStartDebugSession(session);

        const entry = registry.get('sess-5');
        assert.ok(entry);

        // Получаем фабрику из стаба
        const factoryRecord = debugTestState.registeredTrackerFactories[0];
        assert.ok(factoryRecord);
        const factory = factoryRecord.factory as {
            createDebugAdapterTracker: (s: unknown) => { onDidSendMessage: (m: unknown) => void };
        };

        const tracker = factory.createDebugAdapterTracker(session);
        tracker.onDidSendMessage({
            type: 'event',
            event: 'stopped',
            body: { reason: 'breakpoint', threadId: 5 },
        });

        assert.ok(entry.lastStop, 'lastStop должен быть установлен');
        assert.strictEqual(entry.lastStop.reason, 'breakpoint');
        assert.strictEqual(entry.lastStop.threadId, 5);
    });

    test('DebugAdapterTracker игнорирует non-stopped events', () => {
        registry.activate();

        const session = makeSession('sess-5b', 'bsl');
        fireDidStartDebugSession(session);

        const entry = registry.get('sess-5b');
        assert.ok(entry);

        const factory = debugTestState.registeredTrackerFactories[0].factory as {
            createDebugAdapterTracker: (s: unknown) => { onDidSendMessage: (m: unknown) => void };
        };
        const tracker = factory.createDebugAdapterTracker(session);
        tracker.onDidSendMessage({ type: 'event', event: 'continued' });

        assert.strictEqual(entry.lastStop, undefined, 'lastStop не должен быть установлен');
    });

    test('activate идемпотентен — повторный вызов не создаёт двойных подписок', () => {
        registry.activate();
        registry.activate(); // вызов второй раз

        assert.strictEqual(debugTestState.onDidStartDebugSessionListeners.length, 1, 'только 1 start listener');
        assert.strictEqual(debugTestState.onDidTerminateDebugSessionListeners.length, 1, 'только 1 terminate listener');
        assert.strictEqual(debugTestState.registeredTrackerFactories.length, 1, 'только 1 factory');
    });

    test('dispose releases subscriptions owned by the returned activation disposable', () => {
        const activation = registry.activate();

        // Убеждаемся что подписки есть
        assert.strictEqual(debugTestState.onDidStartDebugSessionListeners.length, 1);

        registry.dispose();
        activation.dispose();

        // После dispose слушатели убраны
        assert.strictEqual(debugTestState.onDidStartDebugSessionListeners.length, 0, 'start listeners очищены');
        assert.strictEqual(debugTestState.onDidTerminateDebugSessionListeners.length, 0, 'terminate listeners очищены');
    });
});

suite('DebugSessionRegistry — list', () => {
    let registry: DebugSessionRegistry;

    setup(() => {
        resetDebugTestState();
        registry = new DebugSessionRegistry();
    });

    teardown(() => {
        registry.dispose();
        resetDebugTestState();
    });

    test('list возвращает все активные bsl-сессии', () => {
        registry.activate();

        const s1 = makeSession('s-1', 'bsl');
        const s2 = makeSession('s-2', 'bsl');
        fireDidStartDebugSession(s1);
        fireDidStartDebugSession(s2);

        const sessions = registry.list();
        assert.strictEqual(sessions.length, 2);
    });

    test('list пуст до activate и старта сессий', () => {
        assert.strictEqual(registry.list().length, 0);
    });
});
