// src/agent/agentDebugOperations.ts
// Agent Debug API — заглушки операций отладки 1С.
// Полная реализация методов — в коммитах P7a-3..P7a-6.

import * as vscode from 'vscode';
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
import type { BslLaunchConfiguration } from '../debug/types';

/** Настройки, доступные для переопределения в тестах. */
export const debugStartConfig = {
    /** Таймаут ожидания старта сессии (в мс). */
    timeoutMs: 5000,
};

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
    async debugSetBreakpoint(_params: DebugSetBreakpointParams): Promise<AgentResult<DebugSetBreakpointResult>> {
        return { success: false, error: 'not implemented' };
    }

    /** Очищает точки останова в файле или все точки если файл не задан. */
    async debugClearBreakpoints(_params: DebugClearBreakpointsParams): Promise<AgentResult<void>> {
        return { success: false, error: 'not implemented' };
    }

    /** Настраивает фильтр остановки при исключениях 1С. */
    async debugSetExceptionFilter(_params: DebugSetExceptionFilterParams): Promise<AgentResult<void>> {
        return { success: false, error: 'not implemented' };
    }

    // ─── Ожидание и навигация ────────────────────────────────────────────────

    /** Ожидает остановки отладчика (breakpoint, exception, step) с таймаутом. */
    async debugWaitForStop(_params: DebugWaitForStopParams): Promise<AgentResult<DebugWaitForStopResult>> {
        return { success: false, error: 'not implemented' };
    }

    /** Возвращает стек вызовов для указанного потока. */
    async debugGetStackTrace(_params: DebugThreadParams): Promise<AgentResult<DebugGetStackTraceResult>> {
        return { success: false, error: 'not implemented' };
    }

    // ─── Переменные и выражения ───────────────────────────────────────────────

    /** Возвращает области видимости переменных для указанного фрейма. */
    async debugGetScopes(_params: DebugFrameParams): Promise<AgentResult<DebugGetScopesResult>> {
        return { success: false, error: 'not implemented' };
    }

    /** Возвращает переменные по ссылке (varRef) из области видимости или дочернего объекта. */
    async debugGetVariables(_params: DebugGetVariablesParams): Promise<AgentResult<DebugGetVariablesResult>> {
        return { success: false, error: 'not implemented' };
    }

    /** Вычисляет BSL-выражение в контексте указанного фрейма. */
    async debugEvaluate(_params: DebugEvaluateParams): Promise<AgentResult<DebugEvaluateResult>> {
        return { success: false, error: 'not implemented' };
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
