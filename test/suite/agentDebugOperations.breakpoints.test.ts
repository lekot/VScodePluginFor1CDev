/**
 * Unit-тесты для AgentDebugOperations: debugSetBreakpoint, debugClearBreakpoints, debugSetExceptionFilter.
 * Работают без VS Code runtime (core suite / mocha TDD).
 */

import * as assert from 'assert';
import '../helpers/vscodeStubRegister';
import {
    debugTestState,
    resetDebugTestState,
    resetVscodeTestState,
    fireBreakpointVerified,
    makeMockSession,
    setNextCustomRequestResponse,
    resetCustomRequestState,
} from '../helpers/vscodeModuleStub';
import { AgentDebugOperations, debugStartConfig } from '../../src/agent/agentDebugOperations';
import { DebugSessionRegistry } from '../../src/agent/debugSessionRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(): DebugSessionRegistry {
    return new DebugSessionRegistry();
}

/**
 * Creates a registry with a pre-populated session entry.
 * Returns { registry, ops, session }.
 */
function makeRegistryWithSession(sessionId: string) {
    const registry = makeRegistry();
    const ctx = { subscriptions: [] as Array<{ dispose: () => void }> };
    registry.activate(ctx as never);

    const session = makeMockSession(sessionId);
    // Inject session into registry via fireDidStartDebugSession path
    // We simulate the onDidStartDebugSession event manually by using the listeners
    for (const l of [...debugTestState.onDidStartDebugSessionListeners]) {
        (l as (s: unknown) => void)(session);
    }

    const ops = new AgentDebugOperations(registry);
    return { registry, ops, session };
}

// ---------------------------------------------------------------------------
// Suite: debugSetBreakpoint
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugSetBreakpoint', () => {
    setup(() => {
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
        // Ускоряем таймаут BP для тестов
        debugStartConfig.bpVerifyTimeoutMs = 50;
    });

    teardown(() => {
        debugStartConfig.bpVerifyTimeoutMs = 2000;
        resetDebugTestState();
        resetVscodeTestState();
        resetCustomRequestState();
    });

    // --- 1. Успешно поставлен и сразу verified=true ---
    test('BP поставлен, verified=true в added → возврат с verified=true и id', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        // Настраиваем addBreakpoints: сразу ставим verified=true перед добавлением в список
        const origAdd = debugTestState;
        // Переопределим addBreakpoints через bpListeners: после addBreakpoints слушатели
        // получат added. Нам нужно чтобы bp.verified = true в момент added.
        // Патчим: добавляем listener который перед нашим listener-ом ставит verified.
        // Проще: добавляем listener в bpListeners ПЕРЕД тем как ops подпишется.
        // Но ops подписывается внутри debugSetBreakpoint ДО addBreakpoints.
        // Поэтому добавим "pre-listener" что ставит verified на added bp.
        debugTestState.bpListeners.push((e) => {
            for (const bp of e.added) {
                bp.verified = true;
            }
        });

        const result = await ops.debugSetBreakpoint({
            file: '/c/project/Module.bsl',
            line: 10,
        });

        assert.ok(result.success, `Expected success, got: ${result.error}`);
        assert.strictEqual(result.data?.verified, true);
        assert.ok(result.data?.id, 'id должен быть непустой строкой');
    });

    // --- 2. Поставлен, verified=false → таймаут → verified=false ---
    test('BP поставлен, verified не приходит → таймаут → verified=false, success=true', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        const result = await ops.debugSetBreakpoint({
            file: '/c/project/Module.bsl',
            line: 5,
        });

        assert.ok(result.success, `Expected success=true, got: ${result.error}`);
        assert.strictEqual(result.data?.verified, false);
    });

    // --- 3. verified приходит ПОСЛЕ added, через changed ---
    test('verified приходит через onDidChangeBreakpoints changed → возврат с verified=true', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        // Запускаем debugSetBreakpoint асинхронно
        const resultPromise = ops.debugSetBreakpoint({
            file: '/c/project/Module.bsl',
            line: 7,
        });

        // Даём BP зарегистрироваться
        await new Promise(resolve => setImmediate(resolve));

        // Получаем bp из state и стреляем verified через changed
        const bp = debugTestState.breakpoints[0];
        assert.ok(bp, 'BP должен быть в debugTestState.breakpoints');
        fireBreakpointVerified(bp, true);

        const result = await resultPromise;
        assert.ok(result.success, `Expected success, got: ${result.error}`);
        assert.strictEqual(result.data?.verified, true);
        assert.ok(result.data?.id, 'id должен быть установлен');
    });

    // --- 4. Отсутствует file → ошибка валидации ---
    test('отсутствует file → ошибка валидации', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        const result = await ops.debugSetBreakpoint({
            file: '',
            line: 10,
        });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.toLowerCase().includes('file'), `error: ${result.error}`);
    });

    // --- 5. Отсутствует line или line ≤ 0 → ошибка валидации ---
    test('line = 0 → ошибка валидации', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        const result = await ops.debugSetBreakpoint({
            file: '/c/project/Module.bsl',
            line: 0,
        });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.toLowerCase().includes('line'), `error: ${result.error}`);
    });

    test('line отрицательный → ошибка валидации', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        const result = await ops.debugSetBreakpoint({
            file: '/c/project/Module.bsl',
            line: -5,
        });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.toLowerCase().includes('line'), `error: ${result.error}`);
    });

    // --- 6. condition/hitCondition/logMessage пробрасываются в SourceBreakpoint ---
    test('condition, hitCondition, logMessage пробрасываются в SourceBreakpoint', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        // Делаем so что taймаут ещё не истёк, берём bp из state
        let capturedBp: any = null;
        debugTestState.bpListeners.push((e) => {
            if (e.added.length > 0) {
                capturedBp = e.added[0];
            }
        });

        const resultPromise = ops.debugSetBreakpoint({
            file: '/c/project/Module.bsl',
            line: 3,
            condition: 'X > 5',
            hitCondition: '3',
            logMessage: 'hit!',
        });

        await new Promise(resolve => setImmediate(resolve));

        // Проверяем содержимое BP
        assert.ok(capturedBp, 'BP должен быть захвачен');
        assert.strictEqual(capturedBp.condition, 'X > 5');
        assert.strictEqual(capturedBp.hitCondition, '3');
        assert.strictEqual(capturedBp.logMessage, 'hit!');

        // Ждём таймаута
        await resultPromise;
    });

    // --- 7. Listener очищается (dispose вызван) даже на таймауте ---
    test('listener очищается после таймаута (dispose вызван)', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        const listenerCountBefore = debugTestState.bpListeners.length;

        await ops.debugSetBreakpoint({
            file: '/c/project/Module.bsl',
            line: 1,
        });

        // После завершения (таймаут) listener должен быть удалён
        const listenerCountAfter = debugTestState.bpListeners.length;
        assert.strictEqual(
            listenerCountAfter,
            listenerCountBefore,
            `listener должен быть удалён: было ${listenerCountBefore}, стало ${listenerCountAfter}`,
        );
    });
});

// ---------------------------------------------------------------------------
// Suite: debugClearBreakpoints
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugClearBreakpoints', () => {
    setup(() => {
        resetDebugTestState();
        resetVscodeTestState();
    });

    teardown(() => {
        resetDebugTestState();
        resetVscodeTestState();
    });

    function makeSourceBp(fsPath: string, line: number): any {
        // Используем напрямую стаб SourceBreakpoint через vscode (уже подменён)
        const vscode = require('vscode');
        const bp = new vscode.SourceBreakpoint(
            new vscode.Location(vscode.Uri.file(fsPath), new vscode.Position(line - 1, 0)),
            true,
        );
        bp.id = String(++debugTestState.bpIdCounter);
        return bp;
    }

    // --- 1. Без file → удаляет все ---
    test('без file → удаляет все BP', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        // Добавляем BP напрямую в state
        const bp1 = makeSourceBp('/c/project/A.bsl', 1);
        const bp2 = makeSourceBp('/c/project/B.bsl', 2);
        debugTestState.breakpoints.push(bp1, bp2);

        const result = await ops.debugClearBreakpoints({});

        assert.ok(result.success, `Expected success, got: ${result.error}`);
        assert.strictEqual(debugTestState.breakpoints.length, 0, 'все BP должны быть удалены');
    });

    // --- 2. С file → удаляет только BP с этим путём ---
    test('с file → удаляет только BP указанного файла', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        const bpA = makeSourceBp('/c/project/A.bsl', 1);
        const bpA2 = makeSourceBp('/c/project/A.bsl', 5);
        const bpB = makeSourceBp('/c/project/B.bsl', 3);
        debugTestState.breakpoints.push(bpA, bpA2, bpB);

        const result = await ops.debugClearBreakpoints({ file: '/c/project/A.bsl' });

        assert.ok(result.success, `Expected success, got: ${result.error}`);
        assert.strictEqual(debugTestState.breakpoints.length, 1, 'должен остаться только BP из B.bsl');
        assert.ok(
            (debugTestState.breakpoints[0] as any).location.uri.fsPath === '/c/project/B.bsl',
            'оставшийся BP должен быть из B.bsl',
        );
    });

    // --- 3. Нормализация пути ---
    test('путь нормализуется при фильтрации', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        // Добавляем BP с нормализованным путём
        const normalizedPath = require('path').resolve('/c/project/Module.bsl');
        const bp = makeSourceBp(normalizedPath, 1);
        debugTestState.breakpoints.push(bp);

        // Передаём тот же путь — должен найти и удалить
        const result = await ops.debugClearBreakpoints({ file: normalizedPath });

        assert.ok(result.success, `Expected success, got: ${result.error}`);
        assert.strictEqual(debugTestState.breakpoints.length, 0, 'BP должен быть удалён');
    });

    // --- 4. Пустой список → success без ошибки ---
    test('breakpoints пуст → success без ошибки', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        assert.strictEqual(debugTestState.breakpoints.length, 0);

        const result = await ops.debugClearBreakpoints({});

        assert.ok(result.success, `Expected success, got: ${result.error}`);
    });
});

// ---------------------------------------------------------------------------
// Suite: debugSetExceptionFilter
// ---------------------------------------------------------------------------

suite('AgentDebugOperations — debugSetExceptionFilter', () => {
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

    // --- 1. Включить с substring ---
    test('enabled=true + substring → customRequest с filterOptions: [{ filterId: all, condition }]', async () => {
        const { ops, session } = makeRegistryWithSession('sess-1');
        setNextCustomRequestResponse({ success: true });

        const result = await ops.debugSetExceptionFilter({
            sessionId: 'sess-1',
            enabled: true,
            substring: 'НДС',
        });

        assert.ok(result.success, `Expected success, got: ${result.error}`);
        assert.ok(session.lastCustomRequest, 'customRequest должен быть вызван');
        assert.strictEqual(session.lastCustomRequest.command, 'setExceptionBreakpoints');
        const args = session.lastCustomRequest.args as any;
        assert.deepStrictEqual(args.filters, []);
        assert.deepStrictEqual(args.filterOptions, [{ filterId: 'all', condition: 'НДС' }]);
    });

    // --- 2. Включить без substring ---
    test('enabled=true без substring → filters: [all], filterOptions: []', async () => {
        const { ops, session } = makeRegistryWithSession('sess-2');
        setNextCustomRequestResponse({ success: true });

        const result = await ops.debugSetExceptionFilter({
            sessionId: 'sess-2',
            enabled: true,
        });

        assert.ok(result.success, `Expected success, got: ${result.error}`);
        const args = session.lastCustomRequest?.args as any;
        assert.deepStrictEqual(args.filters, ['all']);
        assert.deepStrictEqual(args.filterOptions, []);
    });

    // --- 3. Выключить ---
    test('enabled=false → filters: [], filterOptions: []', async () => {
        const { ops, session } = makeRegistryWithSession('sess-3');
        setNextCustomRequestResponse({ success: true });

        const result = await ops.debugSetExceptionFilter({
            sessionId: 'sess-3',
            enabled: false,
        });

        assert.ok(result.success, `Expected success, got: ${result.error}`);
        const args = session.lastCustomRequest?.args as any;
        assert.deepStrictEqual(args.filters, []);
        assert.deepStrictEqual(args.filterOptions, []);
    });

    // --- 4. Сессия не найдена ---
    test('сессия не найдена → success=false с error', async () => {
        const ops = new AgentDebugOperations(makeRegistry());

        const result = await ops.debugSetExceptionFilter({
            sessionId: 'nonexistent',
            enabled: true,
        });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('session not found'), `error: ${result.error}`);
    });

    // --- 5. customRequest бросает → success: false с error message ---
    test('customRequest бросает → success=false с error message', async () => {
        const { ops } = makeRegistryWithSession('sess-5');
        setNextCustomRequestResponse('DAP error occurred', true);

        const result = await ops.debugSetExceptionFilter({
            sessionId: 'sess-5',
            enabled: false,
        });

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('DAP error occurred'), `error: ${result.error}`);
    });
});
