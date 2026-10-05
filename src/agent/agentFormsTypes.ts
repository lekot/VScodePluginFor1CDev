// src/agent/agentFormsTypes.ts
// Agent Forms API — types for native 1C TestClient operations.
// No VS Code dependencies; these are plain input and result contracts.

// ─── start ───────────────────────────────────────────────────────────────────

/** Connect to an already-running native TestClient. */
export interface FormsStartParams {
    /** The only supported driver; omitted for backwards-compatible native calls. */
    driver?: 'native';
    /** TestClient TCP port. Required at runtime. */
    port: number;
    /** TestClient host (defaults to 127.0.0.1). */
    host?: string;
    /** Informational platform version supplied by the caller. */
    platformVersion?: string;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

export interface FormsStartResult {
    driver: 'native';
    host: string;
    port: number;
    uiAccessHint: string;
}

/** Start operation could not verify that the connection has no remaining effect. */
export interface FormsStartInDoubtResult {
    status: 'inDoubt';
    effectPossible: boolean;
}

/** A native operation was interrupted after it may have performed its requested effect. */
export interface FormsOperationInDoubtResult {
    status: 'inDoubt';
    effectPossible: true;
}

// ─── stop ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FormsStopParams {}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FormsStopResult {}

// ─── shot ────────────────────────────────────────────────────────────────────

export interface FormsShotParams {
    /** Path to the PNG file. If omitted, a temporary file is used. */
    file?: string;
    /** Native window capture timeout in milliseconds (default 15000). */
    timeoutMs?: number;
    /** Run as a tracked background Agent task when true. MCP defaults this to true. */
    background?: boolean;
}

export interface FormsShotResult {
    /** Absolute path to the saved PNG. */
    file: string;
}

// ─── status ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FormsStatusParams {}

export interface FormsStatusResult {
    driver?: 'native';
    nativeConnected: boolean;
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
