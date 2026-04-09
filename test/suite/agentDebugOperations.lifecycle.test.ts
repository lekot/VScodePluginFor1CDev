/**
 * Unit-тесты для AgentDebugOperations.debugStart / debugStop.
 * Работают без VS Code runtime (core suite / mocha TDD).
 */

import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import {
    debugTestState,
    resetDebugTestState,
    vscodeTestState,
    resetVscodeTestState,
    fireDidStartDebugSession,
} from '../helpers/vscodeModuleStub';
import { AgentDebugOperations, debugStartConfig } from '../../src/agent/agentDebugOperations';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id: string, type: string): unknown {
    return { id, type, name: `session-${id}`, workspaceFolder: undefined, configuration: {} };
}

function makeWorkspaceFolder(fsPath: string): { name: string; index: number; uri: { fsPath: string; scheme: string } } {
    return { name: 'test-workspace', index: 0, uri: { fsPath, scheme: 'file' } };
}

function makeRegistry(): DebugSessionRegistry {
    return new DebugSessionRegistry();
}

// ---------------------------------------------------------------------------
// Suite: debugStart
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugStart', () => {
    let ops: AgentDebugOperations;

    setup(() => {
        resetDebugTestState();
        resetVscodeTestState();
        // Ускоряем таймаут для тестов таймаута
        debugStartConfig.timeoutMs = 50;
        ops = new AgentDebugOperations(makeRegistry());
    });

    teardown(() => {
        debugStartConfig.timeoutMs = 5000;
        resetDebugTestState();
        resetVscodeTestState();
    });

    test('успешный запуск — возвращает sessionId', async () => {
        const folder = makeWorkspaceFolder('/c/project');
        vscodeTestState.mockWorkspaceFolders = [folder];

        const session = makeSession('sess-ok', 'bsl');

        // Запустим debugStart, и одновременно эмулируем старт сессии
        const startPromise = ops.debugStart({
            rootProject: '/c/project/src',
            infobase: 'File=/c/db',
            platformPath: '/c/1c/bin',
        });

        // Дадим Promise зарегистрировать listener
        await new Promise(resolve => setImmediate(resolve));
        fireDidStartDebugSession(session);

        const result = await startPromise;
        assert.ok(result.success, `Expected success, got: ${result.error}`);
        assert.strictEqual(result.data?.sessionId, 'sess-ok');
    });

    test('отсутствует rootProject — ошибка валидации', async () => {
        const result = await ops.debugStart({
            rootProject: '',
            infobase: 'File=/c/db',
            platformPath: '/c/1c/bin',
        });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('rootProject'), `error: ${result.error}`);
    });

    test('отсутствует infobase — ошибка валидации', async () => {
        const result = await ops.debugStart({
            rootProject: '/c/project',
            infobase: '',
            platformPath: '/c/1c/bin',
        });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('infobase'), `error: ${result.error}`);
    });

    test('отсутствует platformPath — ошибка валидации', async () => {
        const result = await ops.debugStart({
            rootProject: '/c/project',
            infobase: 'File=/c/db',
            platformPath: '',
        });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('platformPath'), `error: ${result.error}`);
    });

    test('workspace folder не найден — ошибка', async () => {
        vscodeTestState.mockWorkspaceFolders = []; // пустой список — folder не найдётся

        const result = await ops.debugStart({
            rootProject: '/c/unknown/project',
            infobase: 'File=/c/db',
            platformPath: '/c/1c/bin',
        });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('workspace folder'), `error: ${result.error}`);
    });

    test('startDebugging вернул false — ошибка', async () => {
        const folder = makeWorkspaceFolder('/c/project');
        vscodeTestState.mockWorkspaceFolders = [folder];
        debugTestState.startDebuggingResult = false;

        const result = await ops.debugStart({
            rootProject: '/c/project/src',
            infobase: 'File=/c/db',
            platformPath: '/c/1c/bin',
        });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('startDebugging вернул false'), `error: ${result.error}`);
    });

    test('таймаут ожидания сессии — ошибка timeout', async () => {
        const folder = makeWorkspaceFolder('/c/project');
        vscodeTestState.mockWorkspaceFolders = [folder];
        // startDebugging успешен, но сессия не приходит → таймаут (50мс в тесте)

        const result = await ops.debugStart({
            rootProject: '/c/project/src',
            infobase: 'File=/c/db',
            platformPath: '/c/1c/bin',
        });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('timeout'), `error: ${result.error}`);
    });

    test('debugStart передаёт правильные параметры в startDebugging', async () => {
        const folder = makeWorkspaceFolder('/c/project');
        vscodeTestState.mockWorkspaceFolders = [folder];

        const session = makeSession('sess-params', 'bsl');
        const startPromise = ops.debugStart({
            rootProject: '/c/project/src',
            infobase: 'File=/c/db',
            platformPath: '/c/1c/bin',
            debugServerHost: '127.0.0.1',
            debugServerPort: 1551,
            extensions: ['/c/ext1'],
        });

        await new Promise(resolve => setImmediate(resolve));
        fireDidStartDebugSession(session);

        const result = await startPromise;
        assert.ok(result.success);

        assert.ok(debugTestState.startDebuggingCalled, 'startDebugging должен быть вызван');
        const config = debugTestState.startDebuggingArgs?.[1] as Record<string, unknown>;
        assert.strictEqual(config.type, 'bsl');
        assert.strictEqual(config.request, 'launch');
        assert.strictEqual(config.debugServerHost, '127.0.0.1');
        assert.strictEqual(config.debugServerPort, 1551);
        assert.deepStrictEqual(config.extensions, ['/c/ext1']);
    });
});

// ---------------------------------------------------------------------------
// Suite: debugStop
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugStop', () => {
    let registry: DebugSessionRegistry;
    let ops: AgentDebugOperations;

    setup(() => {
        resetDebugTestState();
        resetVscodeTestState();
        registry = makeRegistry();
        ops = new AgentDebugOperations(registry);

        // Активируем реестр для ручного добавления сессий
        const ctx = { subscriptions: [] as Array<{ dispose: () => void }> };
        registry.activate(ctx as never);
    });

    teardown(() => {
        registry.dispose();
        resetDebugTestState();
        resetVscodeTestState();
    });

    test('успешная остановка — stopDebugging вызван', async () => {
        // Добавляем сессию через fireDidStartDebugSession
        const session = makeSession('sess-stop', 'bsl');
        fireDidStartDebugSession(session);

        const result = await ops.debugStop({ sessionId: 'sess-stop' });
        assert.ok(result.success, `Expected success, got: ${result.error}`);
        assert.ok(debugTestState.stopDebuggingCalled, 'stopDebugging должен быть вызван');
        assert.strictEqual(debugTestState.stopDebuggingSession, session);
    });

    test('сессия не найдена — ошибка session not found', async () => {
        const result = await ops.debugStop({ sessionId: 'nonexistent' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('session not found'), `error: ${result.error}`);
    });

    test('отсутствует sessionId — ошибка валидации', async () => {
        const result = await ops.debugStop({ sessionId: '' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('sessionId'), `error: ${result.error}`);
    });
});
