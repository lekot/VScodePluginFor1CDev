// src/agent/agentDebugTypes.ts
// Agent Debug API — типы параметров и результатов отладочных команд.
// Без зависимостей от vscode — только чистые типы.

// ─── Запуск / остановка ──────────────────────────────────────────────────────

/** Параметры запуска отладочной сессии 1С. */
export interface DebugStartParams {
    /** Путь к корню проекта (папка конфигурации или EDT-проект). */
    rootProject: string;
    /** Строка подключения или имя информационной базы. */
    infobase: string;
    /** Путь к исполняемому файлу платформы 1С. */
    platformPath: string;
    /** Список расширений для подключения при старте. */
    extensions?: string[];
    /** Хост отладочного сервера (по умолчанию localhost). */
    debugServerHost?: string;
    /** Порт отладочного сервера. */
    debugServerPort?: number;
}

/** Результат запуска отладочной сессии. */
export interface DebugStartResult {
    /** Идентификатор созданной сессии. */
    sessionId: string;
}

/** Параметры остановки отладочной сессии. */
export interface DebugStopParams {
    /** Идентификатор сессии, полученный из debugStart. */
    sessionId: string;
}

// ─── Точки останова ──────────────────────────────────────────────────────────

/** Параметры установки точки останова. */
export interface DebugSetBreakpointParams {
    /** Абсолютный путь к файлу исходного кода. */
    file: string;
    /** Номер строки (1-based). */
    line: number;
    /** Условие срабатывания (BSL-выражение). */
    condition?: string;
    /** Условие по количеству срабатываний. */
    hitCondition?: string;
    /** Сообщение для логирования вместо остановки. */
    logMessage?: string;
}

/** Результат установки точки останова. */
export interface DebugSetBreakpointResult {
    /** Подтверждена ли точка останова отладчиком. */
    verified: boolean;
    /** Идентификатор точки останова. */
    id: string;
}

/** Параметры очистки точек останова. */
export interface DebugClearBreakpointsParams {
    /** Путь к файлу; если не задан — очищаются все точки останова. */
    file?: string;
}

// ─── Фильтр исключений ───────────────────────────────────────────────────────

/** Параметры настройки фильтра исключений 1С. */
export interface DebugSetExceptionFilterParams {
    /** Идентификатор сессии. */
    sessionId: string;
    /** Включить остановку при исключениях. */
    enabled: boolean;
    /** Подстрока для фильтрации текста исключения. */
    substring?: string;
}

// ─── Ожидание остановки ──────────────────────────────────────────────────────

/** Параметры ожидания остановки отладчика. */
export interface DebugWaitForStopParams {
    /** Идентификатор сессии. */
    sessionId: string;
    /** Таймаут в миллисекундах (по умолчанию 30000). */
    timeoutMs?: number;
}

/** Результат ожидания остановки отладчика. */
export interface DebugWaitForStopResult {
    /** Причина остановки: 'breakpoint', 'step', 'exception' и др. */
    reason: string;
    /** Идентификатор потока, на котором произошла остановка. */
    threadId: number;
    /** Идентификатор фрейма верхнего уровня стека. */
    frameId: number;
    /** Файл, в котором произошла остановка. */
    file: string;
    /** Номер строки остановки (1-based). */
    line: number;
}

// ─── Навигация по стеку ──────────────────────────────────────────────────────

/**
 * Параметры команд, требующих сессию и поток.
 * Используется для: debugContinue, debugStepOver, debugStepIn, debugStepOut, debugGetStackTrace.
 */
export interface DebugThreadParams {
    /** Идентификатор сессии. */
    sessionId: string;
    /** Идентификатор потока. */
    threadId: number;
}

/** Результат получения стека вызовов. */
export interface DebugGetStackTraceResult {
    /** Фреймы стека вызовов от верхнего к нижнему. */
    frames: Array<{
        /** Идентификатор фрейма. */
        id: number;
        /** Имя процедуры/функции. */
        name: string;
        /** Файл исходного кода. */
        file: string;
        /** Номер строки (1-based). */
        line: number;
    }>;
}

// ─── Переменные ──────────────────────────────────────────────────────────────

/**
 * Параметры команд, требующих сессию и фрейм.
 * Используется для: debugGetScopes.
 */
export interface DebugFrameParams {
    /** Идентификатор сессии. */
    sessionId: string;
    /** Идентификатор фрейма стека. */
    frameId: number;
}

/** Результат получения областей видимости переменных. */
export interface DebugGetScopesResult {
    /** Области видимости (локальные, глобальные и т.д.). */
    scopes: Array<{
        /** Имя области видимости. */
        name: string;
        /** Ссылка на переменные для вызова debugGetVariables. */
        varRef: number;
    }>;
}

/** Параметры получения переменных по ссылке. */
export interface DebugGetVariablesParams {
    /** Идентификатор сессии. */
    sessionId: string;
    /** Ссылка на область переменных (из scopes или дочерних varRef). */
    varRef: number;
}

/** Результат получения переменных. */
export interface DebugGetVariablesResult {
    /** Список переменных. */
    vars: Array<{
        /** Имя переменной. */
        name: string;
        /** Тип значения. */
        type: string;
        /** Строковое представление значения. */
        value: string;
        /** Ссылка для разворачивания дочерних переменных (0 если нет). */
        varRef: number;
    }>;
}

// ─── Вычисление выражений ────────────────────────────────────────────────────

/** Параметры вычисления BSL-выражения. */
export interface DebugEvaluateParams {
    /** Идентификатор сессии. */
    sessionId: string;
    /** BSL-выражение для вычисления. */
    expression: string;
    /** Идентификатор фрейма для контекста вычисления. */
    frameId?: number;
}

/** Результат вычисления BSL-выражения. */
export interface DebugEvaluateResult {
    /** Строковое представление результата. */
    value: string;
    /** Тип результата. */
    type: string;
    /** Ссылка для разворачивания (0 если нет). */
    varRef: number;
}

// ─── Запуск по привязке ───────────────────────────────────────────────────────

/** Параметры запуска отладочной сессии по уже привязанной конфигурации. */
export interface DebugStartFromBindingParams {
    /** Абсолютный путь к Configuration.xml или к корню конфигурации (binding резолвится по нему). */
    configPath: string;
}
