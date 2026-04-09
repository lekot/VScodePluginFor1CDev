// src/agent/agentDebugOperations.ts
// Agent Debug API — заглушки операций отладки 1С.
// Полная реализация методов — в коммитах P7a-3..P7a-6.

import * as vscode from 'vscode';
import * as path from 'path';
import type { AgentResult } from './types';
import type {
    DebugStartParams,
    DebugStartResult,
    DebugStopParams,
    DebugSetBreakpointParams,
    DebugSetBreakpointResult,
    DebugClearBreakpointsParams,
    DebugSetExceptionFilterParams,
    DebugWaitForStopParams,
    DebugWaitForStopResult,
    DebugThreadParams,
    DebugGetStackTraceResult,
    DebugFrameParams,
    DebugGetScopesResult,
    DebugGetVariablesParams,
    DebugGetVariablesResult,
    DebugEvaluateParams,
    DebugEvaluateResult,
} from './agentDebugTypes';
import { DebugSessionRegistry } from './debugSessionRegistry';
import type { LastStop } from './debugSessionRegistry';
import type { BslLaunchConfiguration } from '../debug/types';

/** Настройки, доступные для переопределения в тестах. */
export const debugStartConfig = {
    /** Таймаут ожидания старта сессии (в мс). */
    timeoutMs: 5000,
    /** Таймаут ожидания верификации точки останова (в мс). */
    bpVerifyTimeoutMs: 2000,
};

/** Внутренняя константа по умолчанию (используется при сборке без переопределения). */
const BP_VERIFY_TIMEOUT_MS = 2000;

/** Свежесть кэшированного lastStop: если остановка произошла менее N мс назад, используется без ожидания. */
const WAIT_FOR_STOP_FRESHNESS_MS = 500;

// ─── AgentDebugOperations ─────────────────────────────────────────────────────

/** Класс операций Agent Debug API. Инстанциируется в extension.ts с общим реестром сессий. */
export class AgentDebugOperations {
    constructor(private readonly registry: DebugSessionRegistry) {}

    // ─── Запуск / остановка ──────────────────────────────────────────────────

    /** Запускает отладочную сессию 1С с заданными параметрами. */
    async debugStart(params: DebugStartParams): Promise<AgentResult<DebugStartResult>> {
        // Валидация обязательных параметров
        if (!params.rootProject) {
            return { success: false, error: 'параметр rootProject обязателен' };
        }
        if (!params.infobase) {
            return { success: false, error: 'параметр infobase обязателен' };
        }
        if (!params.platformPath) {
            return { success: false, error: 'параметр platformPath обязателен' };
        }

        // Найти workspace folder
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(params.rootProject));
        if (!folder) {
            return { success: false, error: 'workspace folder для rootProject не найден' };
        }

        // Построить конфигурацию запуска
        const launchConfig: BslLaunchConfiguration = {
            type: 'bsl',
            request: 'launch',
            name: 'Agent Debug Session',
            rootProject: params.rootProject,
            infobase: params.infobase,
            platformPath: params.platformPath,
            debugServerHost: params.debugServerHost ?? 'localhost',
            debugServerPort: params.debugServerPort ?? 1550,
            ...(params.extensions ? { extensions: params.extensions } : {}),
        };

        // Подписаться на старт сессии ДО вызова startDebugging
        let resolveSession: (s: vscode.DebugSession) => void;
        let rejectTimeout: () => void;

        const sessionPromise = new Promise<vscode.DebugSession>((resolve, reject) => {
            resolveSession = resolve;
            rejectTimeout = () => reject(new Error('timeout'));
        });

        const disposable = vscode.debug.onDidStartDebugSession((session) => {
            if (session.type === 'bsl') {
                disposable.dispose();
                resolveSession(session);
            }
        });

        const timeoutHandle = setTimeout(() => {
            disposable.dispose();
            rejectTimeout();
        }, debugStartConfig.timeoutMs);

        // Запустить отладку
        const started = await vscode.debug.startDebugging(folder, launchConfig);
        if (!started) {
            clearTimeout(timeoutHandle);
            disposable.dispose();
            return { success: false, error: 'vscode.debug.startDebugging вернул false' };
        }

        // Дождаться сессии или таймаута
        try {
            const session = await sessionPromise;
            clearTimeout(timeoutHandle);
            return { success: true, data: { sessionId: session.id } };
        } catch {
            return { success: false, error: 'timeout waiting for session start' };
        }
    }

    /** Останавливает отладочную сессию по идентификатору. */
    async debugStop(params: DebugStopParams): Promise<AgentResult<void>> {
        if (!params.sessionId) {
            return { success: false, error: 'параметр sessionId обязателен' };
        }

        const entry = this.registry.get(params.sessionId);
        if (!entry) {
            return { success: false, error: 'session not found in registry' };
        }

        await vscode.debug.stopDebugging(entry.session);
        return { success: true };
    }

    // ─── Точки останова ──────────────────────────────────────────────────────

    /** Устанавливает точку останова в файле на указанной строке. */
    async debugSetBreakpoint(params: DebugSetBreakpointParams): Promise<AgentResult<DebugSetBreakpointResult>> {
        // Валидация
        if (!params.file) {
            return { success: false, error: 'параметр file обязателен' };
        }
        if (!params.line || !Number.isInteger(params.line) || params.line <= 0) {
            return { success: false, error: 'параметр line обязателен и должен быть целым числом > 0' };
        }

        // Создаём BP
        const bp = new vscode.SourceBreakpoint(
            new vscode.Location(vscode.Uri.file(params.file), new vscode.Position(params.line - 1, 0)),
            true,
            params.condition,
            params.hitCondition,
            params.logMessage,
        );

        const timeoutMs = debugStartConfig.bpVerifyTimeoutMs ?? BP_VERIFY_TIMEOUT_MS;

        return new Promise<AgentResult<DebugSetBreakpointResult>>((resolve) => {
            let listener: vscode.Disposable | undefined;
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            let settled = false;

            const finish = (verified: boolean, id: string) => {
                if (settled) { return; }
                settled = true;
                if (timeoutHandle !== undefined) { clearTimeout(timeoutHandle); }
                listener?.dispose();
                resolve({ success: true, data: { verified, id } });
            };

            // Подписываемся ДО addBreakpoints
            listener = vscode.debug.onDidChangeBreakpoints((e) => {
                // Проверяем added — ищем наш BP по содержимому (VS Code может вернуть новый instance)
                const findOurBp = (arr: readonly vscode.Breakpoint[]): vscode.SourceBreakpoint | undefined => {
                    for (const item of arr) {
                        if (
                            item instanceof vscode.SourceBreakpoint &&
                            item.location.uri.fsPath === params.file &&
                            item.location.range.start.line === params.line - 1
                        ) {
                            return item;
                        }
                    }
                    return undefined;
                };

                // Сначала ищем в added — обновляем id
                const addedMatch = findOurBp(e.added);
                if (addedMatch) {
                    // Если уже verified — завершаемся
                    if ((addedMatch as any).verified) {
                        finish(true, (addedMatch as any).id ?? bp.id ?? '');
                        return;
                    }
                    // Обновляем id у нашего bp
                    (bp as any).id = (addedMatch as any).id ?? bp.id;
                }

                // Ищем в changed — verified обновился
                const changedMatch = findOurBp(e.changed);
                if (changedMatch && (changedMatch as any).verified) {
                    finish(true, (changedMatch as any).id ?? (bp as any).id ?? '');
                }
            });

            timeoutHandle = setTimeout(() => {
                finish(false, (bp as any).id ?? '');
            }, timeoutMs);

            // Вызываем addBreakpoints
            vscode.debug.addBreakpoints([bp]);
        });
    }

    /** Очищает точки останова в файле или все точки если файл не задан. */
    async debugClearBreakpoints(params: DebugClearBreakpointsParams): Promise<AgentResult<void>> {
        const all = [...vscode.debug.breakpoints];

        let toRemove: vscode.Breakpoint[];
        if (params.file) {
            const normalized = path.resolve(params.file);
            toRemove = all.filter(
                (bp): bp is vscode.SourceBreakpoint =>
                    bp instanceof vscode.SourceBreakpoint &&
                    path.resolve(bp.location.uri.fsPath) === normalized,
            );
        } else {
            toRemove = all;
        }

        if (toRemove.length > 0) {
            vscode.debug.removeBreakpoints(toRemove);
        }

        return { success: true };
    }

    /** Настраивает фильтр остановки при исключениях 1С. */
    async debugSetExceptionFilter(params: DebugSetExceptionFilterParams): Promise<AgentResult<void>> {
        if (!params.sessionId) {
            return { success: false, error: 'параметр sessionId обязателен' };
        }
        if (typeof params.enabled !== 'boolean') {
            return { success: false, error: 'параметр enabled обязателен (boolean)' };
        }

        const entry = this.registry.get(params.sessionId);
        if (!entry) {
            return { success: false, error: 'session not found in registry' };
        }

        let args: { filters: string[]; filterOptions: Array<{ filterId: string; condition?: string }> };
        if (!params.enabled) {
            args = { filters: [], filterOptions: [] };
        } else if (params.substring) {
            args = { filters: [], filterOptions: [{ filterId: 'all', condition: params.substring }] };
        } else {
            args = { filters: ['all'], filterOptions: [] };
        }

        try {
            await entry.session.customRequest('setExceptionBreakpoints', args);
            return { success: true };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // ─── Ожидание и навигация ────────────────────────────────────────────────

    /** Ожидает остановки отладчика (breakpoint, exception, step) с таймаутом. */
    async debugWaitForStop(params: DebugWaitForStopParams): Promise<AgentResult<DebugWaitForStopResult>> {
        // Валидация
        if (!params.sessionId) {
            return { success: false, error: 'параметр sessionId обязателен' };
        }

        const entry = this.registry.get(params.sessionId);
        if (!entry) {
            return { success: false, error: 'session not found in registry' };
        }

        let stop: LastStop | null;

        // Использовать кэшированный stop если он достаточно свежий
        if (entry.lastStop && Date.now() - entry.lastStop.receivedAt < WAIT_FOR_STOP_FRESHNESS_MS) {
            stop = entry.lastStop;
        } else {
            // Ждать через Promise с добавлением в waiters
            const timeoutMs = params.timeoutMs ?? 30_000;
            stop = await new Promise<LastStop | null>((resolve) => {
                let resolver: ((s: LastStop) => void) | undefined;
                const timer = setTimeout(() => {
                    if (resolver !== undefined) {
                        const idx = entry.waiters.indexOf(resolver);
                        if (idx >= 0) { entry.waiters.splice(idx, 1); }
                    }
                    resolve(null);
                }, timeoutMs);
                resolver = (s: LastStop) => {
                    clearTimeout(timer);
                    resolve(s);
                };
                entry.waiters.push(resolver);
            });

            if (!stop) {
                return { success: false, error: 'timeout waiting for stop' };
            }
            if (stop.reason === 'terminated') {
                return { success: false, error: 'session terminated while waiting for stop' };
            }
        }

        // Получить top frame через stackTrace
        try {
            const trace = await entry.session.customRequest('stackTrace', {
                threadId: stop.threadId,
                startFrame: 0,
                levels: 1,
            }) as { stackFrames?: Array<{ id: number; source?: { path?: string }; line?: number }> };

            const top = trace?.stackFrames?.[0];
            if (!top) {
                return { success: false, error: 'stackTrace returned no frames' };
            }

            return {
                success: true,
                data: {
                    reason: stop.reason,
                    threadId: stop.threadId,
                    frameId: top.id,
                    file: top.source?.path ?? '',
                    line: top.line ?? 0,
                },
            };
        } catch (err) {
            return {
                success: false,
                error: 'stackTrace failed: ' + (err instanceof Error ? err.message : String(err)),
            };
        }
    }

    /** Возвращает стек вызовов для указанного потока. */
    async debugGetStackTrace(params: DebugThreadParams): Promise<AgentResult<DebugGetStackTraceResult>> {
        if (!params.sessionId) {
            return { success: false, error: 'параметр sessionId обязателен' };
        }
        if (typeof params.threadId !== 'number') {
            return { success: false, error: 'параметр threadId обязателен (число)' };
        }

        const entry = this.registry.get(params.sessionId);
        if (!entry) {
            return { success: false, error: 'session not found in registry' };
        }

        try {
            const trace = await entry.session.customRequest('stackTrace', {
                threadId: params.threadId,
                startFrame: 0,
                levels: 1000,
            }) as { stackFrames?: Array<{ id: number; name?: string; source?: { path?: string }; line?: number }> };

            const frames = (trace?.stackFrames ?? []).map(f => ({
                id: f.id,
                name: f.name ?? '',
                file: f.source?.path ?? '',
                line: f.line ?? 0,
            }));

            return { success: true, data: { frames } };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // ─── Переменные и выражения ───────────────────────────────────────────────

    /** Возвращает области видимости переменных для указанного фрейма. */
    async debugGetScopes(params: DebugFrameParams): Promise<AgentResult<DebugGetScopesResult>> {
        if (!params.sessionId) {
            return { success: false, error: 'параметр sessionId обязателен' };
        }
        if (typeof params.frameId !== 'number') {
            return { success: false, error: 'параметр frameId обязателен (число)' };
        }

        const entry = this.registry.get(params.sessionId);
        if (!entry) {
            return { success: false, error: 'session not found in registry' };
        }

        try {
            const resp = await entry.session.customRequest('scopes', { frameId: params.frameId }) as { scopes?: Array<{ name: string; variablesReference: number }> };

            const scopes = (resp?.scopes ?? []).map(s => ({ name: s.name, varRef: s.variablesReference }));
            return { success: true, data: { scopes } };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    /** Возвращает переменные по ссылке (varRef) из области видимости или дочернего объекта. */
    async debugGetVariables(params: DebugGetVariablesParams): Promise<AgentResult<DebugGetVariablesResult>> {
        if (!params.sessionId) {
            return { success: false, error: 'параметр sessionId обязателен' };
        }
        if (typeof params.varRef !== 'number') {
            return { success: false, error: 'параметр varRef обязателен (число)' };
        }

        const entry = this.registry.get(params.sessionId);
        if (!entry) {
            return { success: false, error: 'session not found in registry' };
        }

        try {
            const resp = await entry.session.customRequest('variables', { variablesReference: params.varRef }) as { variables?: Array<{ name: string; type?: string; value: string; variablesReference: number }> };

            const vars = (resp?.variables ?? []).map(v => ({
                name: v.name,
                type: v.type ?? '',
                value: v.value,
                varRef: v.variablesReference,
            }));

            return { success: true, data: { vars } };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    /** Вычисляет BSL-выражение в контексте указанного фрейма. */
    async debugEvaluate(params: DebugEvaluateParams): Promise<AgentResult<DebugEvaluateResult>> {
        if (!params.sessionId) {
            return { success: false, error: 'параметр sessionId обязателен' };
        }
        if (!params.expression) {
            return { success: false, error: 'параметр expression обязателен' };
        }

        const entry = this.registry.get(params.sessionId);
        if (!entry) {
            return { success: false, error: 'session not found in registry' };
        }

        try {
            const resp = await entry.session.customRequest('evaluate', {
                expression: params.expression,
                frameId: params.frameId,
                context: 'watch',
            }) as { result: string; type?: string; variablesReference?: number };

            return {
                success: true,
                data: {
                    value: resp?.result ?? '',
                    type: resp?.type ?? '',
                    varRef: resp?.variablesReference ?? 0,
                },
            };
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // ─── Управление выполнением ───────────────────────────────────────────────

    /** Продолжает выполнение после остановки для указанного потока. */
    async debugContinue(_params: DebugThreadParams): Promise<AgentResult<void>> {
        return { success: false, error: 'not implemented' };
    }

    /** Выполняет шаг через строку (step over) в указанном потоке. */
    async debugStepOver(_params: DebugThreadParams): Promise<AgentResult<void>> {
        return { success: false, error: 'not implemented' };
    }

    /** Выполняет шаг внутрь вызова (step in) в указанном потоке. */
    async debugStepIn(_params: DebugThreadParams): Promise<AgentResult<void>> {
        return { success: false, error: 'not implemented' };
    }

    /** Выполняет шаг из текущей процедуры (step out) в указанном потоке. */
    async debugStepOut(_params: DebugThreadParams): Promise<AgentResult<void>> {
        return { success: false, error: 'not implemented' };
    }
}
