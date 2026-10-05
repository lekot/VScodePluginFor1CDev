// src/agent/agentFormsTypes.ts
// Agent Forms API — типы параметров и результатов команд управления формами 1С.
// Без зависимостей от vscode — только чистые типы.

// ─── start ───────────────────────────────────────────────────────────────────

/** Параметры запуска сессии веб-клиента 1С. */
export interface FormsStartParams {
    /** Session backend. The native backend connects to an already-running TestClient. */
    driver?: 'web' | 'native';
    /** URL готового ibsrv. Взаимоисключающий с dbPath. */
    url?: string;
    /** Путь к файловой базе — TS сам спавнит ibsrv. */
    dbPath?: string;
    /** Путь к платформе 1С (каталог bin), для spawn ibsrv.
     *  Если не задан — берётся из 1cMetadataTree.platformPath в настройках. */
    platformPath?: string;
    /** Таймаут readiness ibsrv+chromium в мс (default 60000). */
    readyTimeoutMs?: number;
    /** TestClient TCP port. Required when driver is native. */
    port?: number;
    /** TestClient host (native only, defaults to 127.0.0.1). */
    host?: string;
    /** Informational platform version supplied by the caller (native only). */
    platformVersion?: string;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

/** Результат запуска сессии веб-клиента 1С. */
export interface FormsStartResult {
    driver?: 'web' | 'native';
    /** URL, к которому подключён playwright. */
    url?: string;
    /** true если TS запустил ibsrv (forms.stop тогда его гасит). */
    ibsrvSpawned: boolean;
    /** Подсказка агенту куда navigate в playwright. */
    uiAccessHint?: string;
    host?: string;
    port?: number;
}

/** Start operation could not verify that browser/ibsrv startup had no remaining effect. */
export interface FormsStartInDoubtResult {
    status: 'inDoubt';
    effectPossible: boolean;
}

/** A forms process was interrupted after it may have performed its requested effect. */
export interface FormsOperationInDoubtResult {
    status: 'inDoubt';
    effectPossible: true;
}

// ─── exec ────────────────────────────────────────────────────────────────────

/** Параметры выполнения JS-скрипта в браузере. */
export interface FormsExecParams {
    /** JS-скрипт для run.mjs exec. */
    script: string;
    /** Таймаут в мс (default 30000). */
    timeoutMs?: number;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
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
    /** Native window capture timeout in milliseconds (default 15000). */
    timeoutMs?: number;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
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
    driver?: 'web' | 'native';
    browserAlive: boolean;
    url?: string;
    ibsrvAlive: boolean;
    ibsrvPid?: number;
    nativeConnected?: boolean;
    host?: string;
    port?: number;
}

export interface NativeFormsObjectRef {
    /** Opaque session-local reference; valid until the next overview/find refresh or disconnect. */
    id: string;
}

export interface NativeFormsObject {
    ref: NativeFormsObjectRef;
    className: string;
    name?: string;
    text?: string;
    url?: string;
    visible?: boolean;
    enabled?: boolean;
    children?: NativeFormsObject[];
}

export type NativeFormsAction =
    | { action: 'overview'; maxDepth?: number; maxNodes?: number }
    | { action: 'commandInterface'; maxDepth?: number; maxNodes?: number }
    | { action: 'executeCommand'; url: string }
    | { action: 'find'; name?: string; className?: string; text?: string; exact?: boolean }
    | { action: 'readField'; ref: NativeFormsObjectRef }
    | { action: 'writeField'; ref: NativeFormsObjectRef; value: string }
    | { action: 'readTable'; ref: NativeFormsObjectRef; maxRows?: number }
    | { action: 'formContext'; includeTables?: boolean; maxDepth?: number; maxNodes?: number; maxRows?: number }
    | { action: 'createSnapshot'; includeTables?: boolean; maxDepth?: number; maxNodes?: number; maxRows?: number }
    | { action: 'compareSnapshot'; snapshotId: string }
    | { action: 'listSnapshots' }
    | { action: 'deleteSnapshot'; snapshotId: string }
    | { action: 'uiLog'; operation: 'start' | 'finish' | 'pause' | 'resume' | 'cancel' }
    | { action: 'act'; ref: NativeFormsObjectRef; method: 'click' | 'activate' };

export interface NativeFormsOverviewResult {
    activeWindow: NativeFormsObject;
    truncated: boolean;
}

export interface NativeFormsFindResult {
    matches: NativeFormsObject[];
}

export interface NativeFormsCommandInterfaceResult {
    items: NativeFormsObject[];
    truncated: boolean;
}

export interface NativeFormsExecuteCommandResult {
    command: string;
    windowChanged: boolean;
    activeWindow: NativeFormsObject;
}

export type NativeFormsTableRow = Record<string, string | null>;

export interface NativeFormsReadTableResult {
    ref: NativeFormsObjectRef;
    rows: NativeFormsTableRow[];
    complete: boolean;
    truncated: boolean;
    rowCount?: number;
    selectionRestored: boolean;
    selectionRestoreError?: string;
}

export interface NativeFormsContextElement extends NativeFormsObject {
    value?: string;
    valueStatus?: 'read' | 'unavailable';
}

export interface NativeFormsFormContextResult {
    activeWindow: NativeFormsObject;
    elements: NativeFormsContextElement[];
    tables?: NativeFormsReadTableResult[];
    complete: boolean;
    truncated: boolean;
}

export interface NativeFormsSnapshotInfo {
    snapshotId: string;
    capturedAt: string;
    complete: boolean;
    elementCount: number;
}

export interface NativeFormsCreateSnapshotResult extends NativeFormsSnapshotInfo {}

export interface NativeFormsCompareSnapshotResult {
    snapshotId: string;
    complete: boolean;
    changes: Array<{ path: string; before?: unknown; after?: unknown }>;
}

export interface NativeFormsListSnapshotsResult {
    snapshots: NativeFormsSnapshotInfo[];
}

export interface NativeFormsDeleteSnapshotResult {
    snapshotId: string;
    deleted: boolean;
}

export interface NativeFormsUiLogResult {
    operation: 'start' | 'finish' | 'pause' | 'resume' | 'cancel';
    recording: boolean;
    uilog?: string;
}

export interface NativeFormsReadFieldResult {
    ref: NativeFormsObjectRef;
    text: string;
}

export interface NativeFormsWriteFieldResult {
    ref: NativeFormsObjectRef;
    accepted: boolean;
    text?: string;
}

export interface NativeFormsActResult {
    ref: NativeFormsObjectRef;
    performed: boolean;
}

export type NativeFormsActionResult =
    | NativeFormsOverviewResult
    | NativeFormsCommandInterfaceResult
    | NativeFormsExecuteCommandResult
    | NativeFormsReadTableResult
    | NativeFormsFormContextResult
    | NativeFormsCreateSnapshotResult
    | NativeFormsCompareSnapshotResult
    | NativeFormsListSnapshotsResult
    | NativeFormsDeleteSnapshotResult
    | NativeFormsUiLogResult
    | NativeFormsFindResult
    | NativeFormsReadFieldResult
    | NativeFormsWriteFieldResult
    | NativeFormsActResult;

export interface NativeFormsParams {
    action: NativeFormsAction['action'];
    /** Optional operation timeout in milliseconds. */
    timeoutMs?: number;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

export type NativeFormsCommandParams = NativeFormsAction & {
    timeoutMs?: number;
    background?: boolean;
};
