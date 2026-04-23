// src/agent/agentFormsTypes.ts
// Agent Forms API — типы параметров и результатов команд управления формами 1С.
// Без зависимостей от vscode — только чистые типы.

// ─── start ───────────────────────────────────────────────────────────────────

/** Параметры запуска сессии веб-клиента 1С. */
export interface FormsStartParams {
    /** URL готового ibsrv. Взаимоисключающий с dbPath. */
    url?: string;
    /** Путь к файловой базе — TS сам спавнит ibsrv. */
    dbPath?: string;
    /** Путь к платформе 1С (каталог bin), для spawn ibsrv.
     *  Если не задан — берётся из 1cMetadataTree.platformPath в настройках. */
    platformPath?: string;
    /** Таймаут readiness ibsrv+chromium в мс (default 60000). */
    readyTimeoutMs?: number;
}

/** Результат запуска сессии веб-клиента 1С. */
export interface FormsStartResult {
    /** URL, к которому подключён playwright. */
    url: string;
    /** true если TS запустил ibsrv (forms.stop тогда его гасит). */
    ibsrvSpawned: boolean;
    /** Подсказка агенту куда navigate в playwright. */
    uiAccessHint?: string;
}

// ─── exec ────────────────────────────────────────────────────────────────────

/** Параметры выполнения JS-скрипта в браузере. */
export interface FormsExecParams {
    /** JS-скрипт для run.mjs exec. */
    script: string;
    /** Таймаут в мс (default 30000). */
    timeoutMs?: number;
}

/** Результат выполнения JS-скрипта. */
export interface FormsExecResult {
    /** stdout run.mjs (JSON или plain). */
    output: string;
    stderr?: string;
    exitCode: number;
}

// ─── stop ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FormsStopParams {}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FormsStopResult {}

// ─── shot ────────────────────────────────────────────────────────────────────

/** Параметры скриншота. */
export interface FormsShotParams {
    /** Путь к PNG. Если не задан — temp-файл. */
    file?: string;
}

/** Результат скриншота. */
export interface FormsShotResult {
    /** Абсолютный путь сохранённого PNG. */
    file: string;
}

// ─── status ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FormsStatusParams {}

/** Результат проверки статуса сессии. */
export interface FormsStatusResult {
    browserAlive: boolean;
    url?: string;
    ibsrvAlive: boolean;
    ibsrvPid?: number;
}
