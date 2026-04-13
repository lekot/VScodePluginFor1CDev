// src/agent/agentDebugOperations.ts
// Agent Debug API — заглушки операций отладки 1С.
// Полная реализация методов — в коммитах P7a-3..P7a-6.

import * as vscode from 'vscode';
import * as path from 'path';
import type { AgentResult } from './types';
import { resolveBindingCommand } from './agentBindingResolver';
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
    DebugStartFromBindingParams,
} from './agentDebugTypes';
import { DebugSessionRegistry } from './debugSessionRegistry';
import { Logger } from '../utils/logger';
import type { LastStop } from './debugSessionRegistry';
import type { BslLaunchConfiguration } from '../debug/types';
import { startDebuggingFromConfigPath } from '../debug/debugLauncher';
import { getFreePort } from '../debug/debuggeeLauncher';
import type { BindingManager } from '../bindings/bindingManager';
import type { InfobaseStorageService } from '../infobases/infobaseStorageService';

/** Настройки, доступные для переопределения в тестах. */
export const debugStartConfig = {
    /** Таймаут ожидания старта сессии (в мс). Реальный launch dbgs+1cv8c занимает 10-20с. */
    timeoutMs: 30000,
    /** Таймаут ожидания верификации точки останова (в мс). */
    bpVerifyTimeoutMs: 2000,
};

/** Внутренняя константа по умолчанию (используется при сборке без переопределения). */
const BP_VERIFY_TIMEOUT_MS = 2000;

/** Свежесть кэшированного lastStop: если остановка произошла менее N мс назад, используется без ожидания. */
const WAIT_FOR_STOP_FRESHNESS_MS = 500;

// ─── AgentDebugOperations ─────────────────────────────────────────────────────

/** Зависимости для операций, требующих доступа к привязкам и хранилищу инфобаз. */
export interface AgentDebugOperationsDeps {
    bindingManager: BindingManager;
    infobaseStorage: InfobaseStorageService;
    getConfigPath: () => string | null;
}

/** Класс операций Agent Debug API. Инстанциируется в extension.ts с общим реестром сессий. */
export class AgentDebugOperations {
    constructor(
        private readonly registry: DebugSessionRegistry,
        private readonly deps?: AgentDebugOperationsDeps,
    ) {}

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

        // Нормализовать пути — через JSON/HTTP backslashes могут быть съедены.
        const rootProject = path.resolve(params.rootProject);
        const platformPath = path.resolve(params.platformPath);

        // Найти workspace folder — getWorkspaceFolder может не сматчить путь в некоторых
        // редакторах (Cursor, Kiro), поэтому fallback на первый workspace folder.
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(rootProject))
            ?? vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return { success: false, error: 'workspace folder для rootProject не найден (нет открытых workspace folders)' };
        }

        // Построить конфигурацию запуска (уникальное имя для корреляции с onDidStartDebugSession)
        const sessionName = `Agent Debug Session ${Date.now()}`;

        // Resolve databasePath for webServer: explicit param or extract from File= connection string
        let resolvedDatabasePath = params.databasePath;
        if (params.debuggeeType === 'webServer' && !resolvedDatabasePath) {
            const fileMatch = /File=([^;]+)/i.exec(params.infobase);
            if (fileMatch) {
                resolvedDatabasePath = fileMatch[1].trim();
            }
        }

        // Pick a free HTTP port for ibsrv when webServer mode is requested
        let webServerHttpPort: number | undefined;
        if (params.debuggeeType === 'webServer') {
            webServerHttpPort = await getFreePort();
        }

        const launchConfig: BslLaunchConfiguration = {
            type: 'bsl',
            request: 'launch',
            name: sessionName,
            rootProject,
            infobase: params.infobase,
            platformPath,
            debugServerHost: params.debugServerHost ?? 'localhost',
            debugServerPort: params.debugServerPort ?? 1550,
            ...(params.extensions ? { extensions: params.extensions } : {}),
            ...(params.debuggeeType ? { debuggeeType: params.debuggeeType } : {}),
            ...(resolvedDatabasePath ? { databasePath: resolvedDatabasePath } : {}),
            ...(webServerHttpPort !== undefined ? { webServerHttpPort } : {}),
        };

        // Подписаться на старт сессии ДО вызова startDebugging
        let resolveSession: (s: vscode.DebugSession) => void;
        let rejectTimeout: () => void;

        const sessionPromise = new Promise<vscode.DebugSession>((resolve, reject) => {
            resolveSession = resolve;
            rejectTimeout = () => reject(new Error('timeout'));
        });

        const disposable = vscode.debug.onDidStartDebugSession((session) => {
            if (session.type === 'bsl' && session.name === sessionName) {
                disposable.dispose();
                resolveSession(session);
            }
        });

        const timeoutHandle = setTimeout(() => {
            disposable.dispose();
            rejectTimeout();
        }, debugStartConfig.timeoutMs);

        // Запустить отладку
        Logger.info('AgentDebug.debugStart pre-call', {
            folderName: folder.name,
            folderFsPath: folder.uri.fsPath,
            launchConfig,
        });
        const started = await vscode.debug.startDebugging(folder, launchConfig);
        Logger.info('AgentDebug.debugStart post-call', { started });
        if (!started) {
            clearTimeout(timeoutHandle);
            disposable.dispose();
            return {
                success: false,
                error: `vscode.debug.startDebugging вернул false. folder: ${folder.uri.toString()}, ` +
                    `config: ${JSON.stringify(launchConfig)}`,
            };
        }

        // Дождаться сессии или таймаута
        try {
            const session = await sessionPromise;
            clearTimeout(timeoutHandle);
            const data: DebugStartResult = { sessionId: session.id };
            if (webServerHttpPort !== undefined) {
                data.webServerUrl = `http://localhost:${webServerHttpPort}`;
            }
            return { success: true, data };
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
            const state = { settled: false, listener: undefined as vscode.Disposable | undefined, timeoutHandle: undefined as ReturnType<typeof setTimeout> | undefined };

            const finish = (verified: boolean, id: string) => {
                if (state.settled) { return; }
                state.settled = true;
                if (state.timeoutHandle !== undefined) { clearTimeout(state.timeoutHandle); }
                state.listener?.dispose();
                resolve({ success: true, data: { verified, id } });
            };

            // Подписываемся ДО addBreakpoints
            const listener = vscode.debug.onDidChangeBreakpoints((e) => {
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
                    const addedBp = addedMatch as unknown as { verified?: boolean; id?: string };
                    if (addedBp.verified) {
                        finish(true, addedBp.id ?? bp.id ?? '');
                        return;
                    }
                    // Обновляем id у нашего bp
                    (bp as unknown as { id?: string }).id = addedBp.id ?? bp.id;
                }

                // Ищем в changed — verified обновился
                const changedMatch = findOurBp(e.changed);
                if (changedMatch) {
                    const changedBp = changedMatch as unknown as { verified?: boolean; id?: string };
                    if (changedBp.verified) {
                        finish(true, changedBp.id ?? (bp as unknown as { id?: string }).id ?? '');
                    }
                }
            });
            state.listener = listener;

            const timeoutHandle = setTimeout(() => {
                finish(false, (bp as unknown as { id?: string }).id ?? '');
            }, timeoutMs);
            state.timeoutHandle = timeoutHandle;

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
                const resolverHolder: { fn: ((s: LastStop) => void) | undefined } = { fn: undefined };
                const timer = setTimeout(() => {
                    if (resolverHolder.fn !== undefined) {
                        const idx = entry.waiters.indexOf(resolverHolder.fn);
                        if (idx >= 0) { entry.waiters.splice(idx, 1); }
                    }
                    resolve(null);
                }, timeoutMs);
                const resolver = (s: LastStop) => {
                    clearTimeout(timer);
                    resolve(s);
                };
                resolverHolder.fn = resolver;
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
    async debugContinue(params: DebugThreadParams): Promise<AgentResult<void>> {
        if (!params.sessionId) {
            return { success: false, error: 'параметр sessionId обязателен' };
        }
        if (typeof params.threadId !== 'number') {
            return { success: false, error: 'параметр threadId обязателен' };
        }
        const entry = this.registry.get(params.sessionId);
        if (!entry) {
            return { success: false, error: 'session not found in registry' };
        }
        try {
            await entry.session.customRequest('continue', { threadId: params.threadId });
            return { success: true };
        } catch (err) {
            return { success: false, error: 'continue failed: ' + (err instanceof Error ? err.message : String(err)) };
        }
    }

    /** Выполняет шаг через строку (step over) в указанном потоке. */
    async debugStepOver(params: DebugThreadParams): Promise<AgentResult<void>> {
        if (!params.sessionId) {
            return { success: false, error: 'параметр sessionId обязателен' };
        }
        if (typeof params.threadId !== 'number') {
            return { success: false, error: 'параметр threadId обязателен' };
        }
        const entry = this.registry.get(params.sessionId);
        if (!entry) {
            return { success: false, error: 'session not found in registry' };
        }
        try {
            await entry.session.customRequest('next', { threadId: params.threadId });
            return { success: true };
        } catch (err) {
            return { success: false, error: 'stepOver failed: ' + (err instanceof Error ? err.message : String(err)) };
        }
    }

    /** Выполняет шаг внутрь вызова (step in) в указанном потоке. */
    async debugStepIn(params: DebugThreadParams): Promise<AgentResult<void>> {
        if (!params.sessionId) {
            return { success: false, error: 'параметр sessionId обязателен' };
        }
        if (typeof params.threadId !== 'number') {
            return { success: false, error: 'параметр threadId обязателен' };
        }
        const entry = this.registry.get(params.sessionId);
        if (!entry) {
            return { success: false, error: 'session not found in registry' };
        }
        try {
            await entry.session.customRequest('stepIn', { threadId: params.threadId });
            return { success: true };
        } catch (err) {
            return { success: false, error: 'stepIn failed: ' + (err instanceof Error ? err.message : String(err)) };
        }
    }

    /** Выполняет шаг из текущей процедуры (step out) в указанном потоке. */
    async debugStepOut(params: DebugThreadParams): Promise<AgentResult<void>> {
        if (!params.sessionId) {
            return { success: false, error: 'параметр sessionId обязателен' };
        }
        if (typeof params.threadId !== 'number') {
            return { success: false, error: 'параметр threadId обязателен' };
        }
        const entry = this.registry.get(params.sessionId);
        if (!entry) {
            return { success: false, error: 'session not found in registry' };
        }
        try {
            await entry.session.customRequest('stepOut', { threadId: params.threadId });
            return { success: true };
        } catch (err) {
            return { success: false, error: 'stepOut failed: ' + (err instanceof Error ? err.message : String(err)) };
        }
    }

    // ─── Запуск по привязке ───────────────────────────────────────────────────

    /** Запускает отладочную сессию по configPath, автоматически резолвя binding и инфобазу. */
    async debugStartFromBinding(params: DebugStartFromBindingParams): Promise<AgentResult<DebugStartResult>> {
        // 1. Проверка deps
        if (!this.deps?.bindingManager || !this.deps?.infobaseStorage) {
            return { success: false, error: 'AgentDebugOperations не сконфигурирован для startFromBinding (нет deps)' };
        }

        // 2. Resolve configPath — поддерживает короткие имена ("empty_conf", "uh")
        // через resolveBindingCommand (fuzzy match), а также полные/относительные пути.
        const rawConfigPath = params.configPath ?? this.deps.getConfigPath?.();
        if (!rawConfigPath) {
            return { success: false, error: 'configPath не указан и нет активной конфигурации в дереве' };
        }

        // Попробуем fuzzy-резолв через resolveBinding — он знает короткие имена фикстур.
        let configPath: string;
        const resolved = await resolveBindingCommand({ configPath: rawConfigPath }, this.deps);
        if (resolved.success && resolved.data) {
            // Убираем /Configuration.xml из конца — startDebuggingFromConfigPath ожидает каталог.
            configPath = resolved.data.configPath.replace(/[/\\]Configuration\.xml$/i, '');
        } else {
            // Fallback: path.resolve для абсолютных путей.
            configPath = path.resolve(rawConfigPath);
        }

        // 3. Найти workspace folder — fallback на первый (Cursor/Kiro могут не матчить URI)
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(configPath))
            ?? vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return { success: false, error: 'workspace folder не найден (нет открытых workspace folders)' };
        }

        // 4. Подписаться на старт сессии ДО вызова startDebuggingFromConfigPath
        const sessionName = `Agent Debug FromBinding ${Date.now()}`;
        let resolveSession: (s: vscode.DebugSession) => void;
        let rejectTimeout: () => void;

        const sessionPromise = new Promise<vscode.DebugSession>((resolve, reject) => {
            resolveSession = resolve;
            rejectTimeout = () => reject(new Error('timeout'));
        });

        const disposable = vscode.debug.onDidStartDebugSession((session) => {
            if (session.type === 'bsl' && session.name === sessionName) {
                disposable.dispose();
                resolveSession(session);
            }
        });

        const timeoutHandle = setTimeout(() => {
            disposable.dispose();
            rejectTimeout();
        }, debugStartConfig.timeoutMs);

        // Pick free ports for ibsrv when webServer mode is requested
        let webServerHttpPort: number | undefined;
        let debugServerPort: number | undefined;
        if (params.debuggeeType === 'webServer') {
            webServerHttpPort = await getFreePort();
            debugServerPort = await getFreePort();
        }

        // 5. Вызвать startDebuggingFromConfigPath
        let started: boolean;
        try {
            started = await startDebuggingFromConfigPath({
                configPath,
                workspaceFolder,
                bindingManager: this.deps.bindingManager,
                infobaseStorage: this.deps.infobaseStorage,
                sessionName,
                ...(params.debuggeeType ? { debuggeeType: params.debuggeeType } : {}),
                ...(webServerHttpPort !== undefined ? { webServerHttpPort } : {}),
                ...(debugServerPort !== undefined ? { debugServerPort } : {}),
            });
        } catch (err) {
            // 6. Ошибка из startDebuggingFromConfigPath
            clearTimeout(timeoutHandle);
            disposable.dispose();
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }

        // 7. startDebugging вернул false
        if (!started) {
            clearTimeout(timeoutHandle);
            disposable.dispose();
            return { success: false, error: 'startDebugging вернул false' };
        }

        // 8. Дождаться сессии или таймаута
        try {
            const session = await sessionPromise;
            clearTimeout(timeoutHandle);
            const data: DebugStartResult = { sessionId: session.id };
            if (webServerHttpPort !== undefined) {
                data.webServerUrl = `http://localhost:${webServerHttpPort}`;
            }
            return { success: true, data };
        } catch {
            return { success: false, error: 'timeout waiting for session start' };
        }
    }
}
