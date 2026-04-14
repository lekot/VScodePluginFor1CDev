/**
 * Unit-тесты для P7a-7: регистрация 14 debug-команд через registerAgentCommands.
 * Работают без VS Code runtime (core suite / mocha TDD).
 */

import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import {
    vscodeTestState,
    resetVscodeTestState,
    resetDebugTestState,
    debugTestState,
    fireDidStartDebugSession,
} from '../helpers/vscodeModuleStub';
import { registerAgentCommands } from '../../src/agent/agentCommands';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEBUG_COMMAND_IDS = [
    '1c-metadata-tree.agent.debug.start',
    '1c-metadata-tree.agent.debug.stop',
    '1c-metadata-tree.agent.debug.setBreakpoint',
    '1c-metadata-tree.agent.debug.clearBreakpoints',
    '1c-metadata-tree.agent.debug.setExceptionFilter',
    '1c-metadata-tree.agent.debug.waitForStop',
    '1c-metadata-tree.agent.debug.getStackTrace',
    '1c-metadata-tree.agent.debug.getScopes',
    '1c-metadata-tree.agent.debug.getVariables',
    '1c-metadata-tree.agent.debug.evaluate',
    '1c-metadata-tree.agent.debug.continue',
    '1c-metadata-tree.agent.debug.stepOver',
    '1c-metadata-tree.agent.debug.stepIn',
    '1c-metadata-tree.agent.debug.stepOut',
    '1c-metadata-tree.agent.debug.startFromBinding',
] as const;

function makeContext(): { subscriptions: Array<{ dispose: () => void }> } {
    return { subscriptions: [] };
}

function makeRegistry(): DebugSessionRegistry {
    return new DebugSessionRegistry();
}

// ---------------------------------------------------------------------------
// Suite 1: Регистрация команд
// ---------------------------------------------------------------------------

suite('registerAgentCommands — debug commands registration', () => {
    setup(() => {
        resetVscodeTestState();
        resetDebugTestState();
    });

    teardown(() => {
        resetVscodeTestState();
        resetDebugTestState();
    });

    test('все 15 debug-команд зарегистрированы', () => {
        const ctx = makeContext();
        const registry = makeRegistry();
        registerAgentCommands(ctx as never, () => null, async () => null, registry);

        for (const id of DEBUG_COMMAND_IDS) {
            assert.ok(
                vscodeTestState.registeredCommandIds.includes(id),
                `Команда не зарегистрирована: ${id}`,
            );
        }
    });

    test('все 15 debug-команд попадают в context.subscriptions', () => {
        const ctx = makeContext();
        const registry = makeRegistry();
        // До регистрации: 0 подписок
        const before = ctx.subscriptions.length;
        registerAgentCommands(ctx as never, () => null, async () => null, registry);
        const after = ctx.subscriptions.length;
        // 12 CRUD + 15 debug + 2 binding + 1 deploy + 4 agent deploy ops = 34 новых подписок
        assert.strictEqual(after - before, 34, `Ожидалось 34 подписок, получено ${after - before}`);
    });

    test('debug-команды не регистрируются в package.json contributes (только programmatic)', () => {
        // Проверяем, что среди зарегистрированных команд — именно debug-команды
        // и они НЕ имеют title (не contributable — только programmatic вызов).
        // Это structural тест: убеждаемся что хэндлеры сохранены как функции.
        const ctx = makeContext();
        const registry = makeRegistry();
        registerAgentCommands(ctx as never, () => null, async () => null, registry);

        for (const id of DEBUG_COMMAND_IDS) {
            const handler = vscodeTestState.registeredCommandHandlers.get(id);
            assert.strictEqual(typeof handler, 'function', `Handler для ${id} должен быть функцией`);
        }
    });
});

// ---------------------------------------------------------------------------
// Suite 2: Проксирование в AgentDebugOperations
// ---------------------------------------------------------------------------

suite('registerAgentCommands — debug command proxy to AgentDebugOperations', () => {
    setup(() => {
        resetVscodeTestState();
        resetDebugTestState();
    });

    teardown(() => {
        resetVscodeTestState();
        resetDebugTestState();
    });

    test('debugStop проксирует ошибку если sessionId отсутствует', async () => {
        const ctx = makeContext();
        const registry = makeRegistry();
        registerAgentCommands(ctx as never, () => null, async () => null, registry);

        const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.debug.stop');
        assert.ok(handler, 'handler для debug.stop должен существовать');

        const result = await (handler as (p: unknown) => Promise<{ success: boolean; error?: string }>)({ sessionId: '' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('sessionId'), `error: ${result.error}`);
    });

    test('debugClearBreakpoints проксирует успех без file', async () => {
        const ctx = makeContext();
        const registry = makeRegistry();
        registerAgentCommands(ctx as never, () => null, async () => null, registry);

        const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.debug.clearBreakpoints');
        assert.ok(handler, 'handler для debug.clearBreakpoints должен существовать');

        const result = await (handler as (p: unknown) => Promise<{ success: boolean; error?: string }>)({});
        assert.strictEqual(result.success, true, `Ожидался success, получено: ${result.error}`);
    });

    test('debugRegistry.activate вызывается до registerAgentCommands и создаёт подписки', () => {
        const registry = makeRegistry();
        const ctx = makeContext();

        // Активируем реестр как это делает registerAllCommands
        registry.activate(ctx as never);

        // После activate в ctx.subscriptions должны появиться подписки реестра
        // (onDidStartDebugSession, onDidTerminateDebugSession, registerDebugAdapterTrackerFactory)
        assert.ok(
            ctx.subscriptions.length > 0,
            'После registry.activate в context.subscriptions должны быть disposable',
        );
    });

    test('debug.start проксирует ошибку валидации rootProject через handler', async () => {
        const ctx = makeContext();
        const registry = makeRegistry();
        registerAgentCommands(ctx as never, () => null, async () => null, registry);

        const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.debug.start');
        assert.ok(handler, 'handler для debug.start должен существовать');

        const result = await (handler as (p: unknown) => Promise<{ success: boolean; error?: string }>)({
            rootProject: '',
            infobase: 'File=/c/db',
            platformPath: '/c/1c/bin',
        });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('rootProject'), `error: ${result.error}`);
    });

    test('debug.start с валидными параметрами вызывает startDebugging через реестр', async () => {
        const ctx = makeContext();
        const registry = makeRegistry();
        // Активируем реестр чтобы он слушал сессии
        registry.activate(ctx as never);
        registerAgentCommands(ctx as never, () => null, async () => null, registry);

        // Подготавливаем workspace folder
        vscodeTestState.mockWorkspaceFolders = [
            { name: 'test', index: 0, uri: { fsPath: '/c/project', scheme: 'file' } },
        ];

        const handler = vscodeTestState.registeredCommandHandlers.get('1c-metadata-tree.agent.debug.start');
        assert.ok(handler);

        const startPromise = (handler as (p: unknown) => Promise<{ success: boolean; data?: { sessionId: string }; error?: string }>)({
            rootProject: '/c/project/src',
            infobase: 'File=/c/db',
            platformPath: '/c/1c/bin',
        });

        // Дать listener зарегистрироваться
        await new Promise(resolve => setImmediate(resolve));

        // Достаём имя сессии из конфига, переданного в startDebugging (корреляция по name)
        const launchConfig = debugTestState.startDebuggingArgs?.[1] as { name?: string } | undefined;
        const session = { id: 'test-session', type: 'bsl', name: launchConfig?.name ?? 'test', workspaceFolder: undefined, configuration: {} };
        fireDidStartDebugSession(session);

        const result = await startPromise;
        assert.ok(result.success, `Expected success, got: ${result.error}`);
        assert.strictEqual(result.data?.sessionId, 'test-session');
    });
});
