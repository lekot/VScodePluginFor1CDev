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

// Подавляем предупреждение об неиспользуемом импорте vscode — он потребуется в реализации P7a-3+.
void vscode;

// ─── AgentDebugOperations ─────────────────────────────────────────────────────

/** Класс операций Agent Debug API. Инстанциируется в extension.ts с общим реестром сессий. */
export class AgentDebugOperations {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(private readonly registry: DebugSessionRegistry) {
        // registry используется в реализации методов P7a-3+
        void this.registry;
    }

    // ─── Запуск / остановка ──────────────────────────────────────────────────

    /** Запускает отладочную сессию 1С с заданными параметрами. */
    async debugStart(_params: DebugStartParams): Promise<AgentResult<DebugStartResult>> {
        return { success: false, error: 'not implemented' };
    }

    /** Останавливает отладочную сессию по идентификатору. */
    async debugStop(_params: DebugStopParams): Promise<AgentResult<void>> {
        return { success: false, error: 'not implemented' };
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
