import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
    DebugSession,
    InitializedEvent,
    StoppedEvent,
    ContinuedEvent,
    ThreadEvent,
    TerminatedEvent,
    OutputEvent,
    Thread,
    StackFrame,
    Scope,
    Variable,
    Source,
    Breakpoint,
    Event,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { RdbgClient } from './rdbg/rdbgClient';
import { RdbgTransport } from './rdbg/rdbgTransport';
import { RdbgRuntimeError, RdbgBreakpointRequest, RdbgCallStackItem, RdbgModuleId, RdbgExceptionBreakpointState, RdbgExceptionFilterItem, ViewInterface, SourceCalcItem, RdbgVariableNode, RdbgEvalResult, RdbgEvalOptions } from './rdbg/rdbgTypes';
import { ReferencesTable } from './referencesTable';
import { BslAttachConfiguration, BslLaunchConfiguration } from './types';
import { DebuggeeLauncher, getFreePort } from './debuggeeLauncher';
import { resolveModuleId, resolveBslPathFromRdbgModule, readExtensionName, ResolverConfigRoot } from './moduleIdResolver';
import { BslLocalCandidate, extractLocalCandidatesFromBsl } from './bslSourceLocals';

const FAST_EVALUATE_WAIT_MS = 500;
const FULL_EVALUATE_WAIT_MS = 5000;
const MAX_SOURCE_LOCAL_EVALUATIONS = 12;
const UNEVALUATED_LOCAL_VALUE = 'не вычислено';

// ---------------------------------------------------------------------------
// BpWorkspaceEntry — internal state for one BSL module's breakpoints.
// Not exported to rdbgTypes.ts — this is session-scoped state only.
// ---------------------------------------------------------------------------
interface BpWorkspaceEntry {
    source: string;         // absolute BSL file path, used for DAP response filtering
    moduleId: RdbgModuleId;
    bps: RdbgBreakpointRequest[];
}

// ---------------------------------------------------------------------------
// FrameRef — payload stored in _frameRefs for each DAP frameId.
// ---------------------------------------------------------------------------
interface FrameRef {
    threadId: number;
    frameLevel: number;
    sourcePath?: string;
    sourceLine?: number;
}

// ---------------------------------------------------------------------------
// VariableRef — payload stored in _variableRefs for each variablesReference.
// ---------------------------------------------------------------------------
export interface VariableRef {
    threadId: number;
    frameLevel: number;
    path: SourceCalcItem[];
    view: ViewInterface;
    sourcePath?: string;
    sourceLine?: number;
}

// ---------------------------------------------------------------------------
// buildDapVariables — pure mapping function, exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * Map an array of RdbgVariableNode to DAP Variable objects.
 * For expandable nodes, adds a new entry to variableRefs and sets variablesReference > 0.
 * Pure function w.r.t. business logic; has a side effect on variableRefs (adds entries).
 */
export function buildDapVariables(
    parent: VariableRef,
    children: RdbgVariableNode[],
    variableRefs: ReferencesTable<VariableRef>
): DebugProtocol.Variable[] {
    return children.map((node, i) => {
        let variablesReference = 0;
        if (node.isIndexedCollection && parent.view === 'context') {
            // Switch to collection view for this node
            variablesReference = variableRefs.add({
                threadId: parent.threadId,
                frameLevel: parent.frameLevel,
                path: [...parent.path, { type: 'property', property: node.name }],
                view: 'collection',
            });
        } else if (node.isExpandable && !node.isIndexedCollection) {
            // Drill down into object properties
            variablesReference = variableRefs.add({
                threadId: parent.threadId,
                frameLevel: parent.frameLevel,
                path: [...parent.path, { type: 'property', property: node.name }],
                view: 'context',
            });
        } else if (node.isIndexedCollection && parent.view === 'collection') {
            // Nested collection inside a collection — use index path
            variablesReference = variableRefs.add({
                threadId: parent.threadId,
                frameLevel: parent.frameLevel,
                path: [...parent.path, { type: 'index', index: i }],
                view: 'collection',
            });
        }
        return new Variable(
            `${node.name} (${node.typeName})`,
            node.value,
            variablesReference
        ) as DebugProtocol.Variable;
    });
}

function buildSourceLocalVariables(candidates: BslLocalCandidate[]): DebugProtocol.Variable[] {
    return candidates.map((candidate) => {
        const variable = new Variable(candidate.name, UNEVALUATED_LOCAL_VALUE, 0) as DebugProtocol.Variable;
        variable.evaluateName = candidate.name;
        return variable;
    });
}

// ---------------------------------------------------------------------------
// Pure helper functions — exported for unit testing only.
// ---------------------------------------------------------------------------

/**
 * Build the extKey string for a moduleId.
 * Key: "${extensionName}|${objectId}|${propertyId}"
 * Base configuration modules get extensionName="" (empty string prefix).
 */
export function makeExtKey(moduleId: { extensionName?: string; objectId: string; propertyId: string }): string {
    return `${moduleId.extensionName ?? ''}|${moduleId.objectId}|${moduleId.propertyId}`;
}

/**
 * Update the workspace snapshot map and return the full flat array of all BPs.
 * @param state  mutable map (modified in-place)
 * @param extKey key for the module being added/removed
 * @param entry  new entry, or undefined to delete the key
 */
export function buildWorkspaceSnapshot(
    state: Map<string, BpWorkspaceEntry>,
    extKey: string,
    entry: BpWorkspaceEntry | undefined
): RdbgBreakpointRequest[] {
    if (entry === undefined) {
        state.delete(extKey);
    } else {
        state.set(extKey, entry);
    }
    return Array.from(state.values()).flatMap(e => e.bps);
}

/**
 * Parse a DAP hitCondition string into a numeric hitCount.
 * Supports:
 *   '5'      → 5
 *   '>= 3'   → 3
 *   '> 3'    → 4  (strictly greater-than: first hit at 4)
 *   '% 7'    → 7  (multiple-of: treat as count for server default)
 * Anything else → undefined (caller should log a warning and skip hitCount).
 */
function parseHitCondition(raw: string): number | undefined {
    const trimmed = raw.trim();

    // Plain integer: '5'
    if (/^\d+$/.test(trimmed)) {
        return parseInt(trimmed, 10);
    }

    // '>= N'
    const geMatch = /^>=\s*(\d+)$/.exec(trimmed);
    if (geMatch) {
        return parseInt(geMatch[1], 10);
    }

    // '> N'  — pause when hit count EXCEEDS N, so first pause at N+1
    const gtMatch = /^>\s*(\d+)$/.exec(trimmed);
    if (gtMatch) {
        return parseInt(gtMatch[1], 10) + 1;
    }

    // '% N'  — every N-th hit
    const modMatch = /^%\s*(\d+)$/.exec(trimmed);
    if (modMatch) {
        return parseInt(modMatch[1], 10);
    }

    return undefined;
}

/**
 * Convert DAP SourceBreakpoint[] to RdbgBreakpointRequest[].
 *
 * OQ-8: hitCountVariant is intentionally NOT set — the platform decimal field
 * would be corrupted by our string-union encoder. We rely on server default (0).
 */
export function dapToRdbgBreakpoints(
    moduleId: RdbgModuleId,
    dapBps: DebugProtocol.SourceBreakpoint[]
): RdbgBreakpointRequest[] {
    return dapBps.map(bp => {
        const req: RdbgBreakpointRequest = {
            moduleId,
            lineNo: bp.line,
        };

        if (bp.condition && bp.condition.trim() !== '') {
            req.condition = bp.condition;
        }

        if (bp.logMessage && bp.logMessage.trim() !== '') {
            req.logMessage = bp.logMessage;
        }

        if (bp.hitCondition && bp.hitCondition.trim() !== '') {
            const hitCount = parseHitCondition(bp.hitCondition);
            if (hitCount !== undefined) {
                req.hitCount = hitCount;
                // hitCountVariant intentionally NOT set (OQ-8: server default=0)
            }
            // if parse fails, hitCount stays unset; caller will emit warning via OutputEvent
        }

        return req;
    });
}

/**
 * Transform DAP setExceptionBreakpoints arguments into RdbgExceptionBreakpointState.
 * Exported for unit testing.
 *
 * Rules:
 *  - stopOnErrors = true if any filter is selected (filterOptions or legacyFilters).
 *  - analyzeErrorStr = true only if at least one filterOption has a non-empty condition.
 *  - Each filterOption with a non-empty condition → RdbgExceptionFilterItem { include: true, text: condition }.
 *  - Empty condition strings are ignored (no filter entry added).
 */
export function dapToExceptionState(
    filterOptions: DebugProtocol.ExceptionFilterOptions[] | undefined,
    legacyFilters: string[] | undefined
): RdbgExceptionBreakpointState {
    const opts = filterOptions ?? [];
    const legacy = legacyFilters ?? [];

    const stopOnErrors = opts.length > 0 || legacy.length > 0;

    const filters: RdbgExceptionFilterItem[] = [];
    for (const opt of opts) {
        if (opt.condition && opt.condition.trim() !== '') {
            filters.push({ include: true, text: opt.condition });
        }
    }

    const analyzeErrorStr = filters.length > 0 ? true : undefined;

    const state: RdbgExceptionBreakpointState = { stopOnErrors };
    if (analyzeErrorStr !== undefined) {
        state.analyzeErrorStr = analyzeErrorStr;
    }
    if (filters.length > 0) {
        state.filters = filters;
    }
    return state;
}

export class BslDebugSession extends DebugSession {
    private _client: RdbgClient | undefined;
    private _transport: RdbgTransport | undefined;
    private readonly _debugUiId: string;
    private readonly _threadMap: Map<number, string> = new Map();
    private readonly _reverseThreadMap: Map<string, number> = new Map();
    private _nextThreadId: number = 1;
    private _lastError: RdbgRuntimeError | undefined;
    /** Ordered list of configuration roots: [mainRoot, ...extensionRoots] */
    private _configRoots: string[] = [];
    /** Workspace snapshot: extKey → BpWorkspaceEntry (replaces old _knownBreakpoints). */
    private readonly _bpWorkspace: Map<string, BpWorkspaceEntry> = new Map();
    /** Frames from last DBGUIExtCmdInfoCallStackFormed (ping); 1C often does not fill HTTP getCallStack for UI. */
    private readonly _stackTraceCacheByThreadId: Map<number, RdbgCallStackItem[]> = new Map();
    /** Thread that last received `stopped` — Locals/Evaluate must use its targetId (not arbitrary Map iteration). */
    private _pausedThreadId: number | undefined;
    /** DebuggeeLauncher instance for DAP launch sessions (null for attach sessions). */
    private _launcher: DebuggeeLauncher | undefined;
    /** Dedup key for last StoppedEvent — prevents repeated UI refresh on each ping tick while paused. */
    private _lastStoppedKey: string = '';
    /** Successful DAP watch evaluations cached while execution stays on the same stop. */
    private readonly _watchEvaluateCache = new Map<string, RdbgEvalResult>();
    /** Maps DAP frameId → {threadId, frameLevel}. Cleared on continued for the relevant thread. */
    private readonly _frameRefs = new ReferencesTable<FrameRef>();
    /** Maps DAP variablesReference → {threadId, frameLevel, path, view}. Cleared on continued. */
    private readonly _variableRefs = new ReferencesTable<VariableRef>();
    private _isWebServer = false;

    constructor() {
        super();
        this._debugUiId = crypto.randomUUID();
    }

    // -------------------------------------------------------------------------
    // Initialize
    // -------------------------------------------------------------------------

    protected initializeRequest(
        response: DebugProtocol.InitializeResponse,
        _args: DebugProtocol.InitializeRequestArguments
    ): void {
        response.body = response.body ?? {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsTerminateRequest = true;
        response.body.supportsExceptionInfoRequest = true;
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsLogPoints = true;
        response.body.supportsExceptionFilterOptions = true;
        response.body.supportsSingleThreadExecutionRequests = true;
        response.body.exceptionBreakpointFilters = [
            {
                filter: 'all',
                label: 'Остановка по ошибке',
                description: 'Останов при возникновении исключения времени выполнения',
                supportsCondition: true,
                conditionDescription: 'Подстрока текста ошибки',
            },
        ];

        this.sendResponse(response);
    }

    // -------------------------------------------------------------------------
    // Launch
    // -------------------------------------------------------------------------

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: DebugProtocol.LaunchRequestArguments
    ): Promise<void> {
        const cfg = args as unknown as BslLaunchConfiguration;

        // 1. Resolve platformBin — required field
        const platformBin = cfg.platformPath ?? '';
        if (!platformBin) {
            this.sendErrorResponse(
                response, 1100,
                'platformPath не задан. Укажите каталог установки 1С в launch.json.'
            );
            return;
        }

        // 2. Setup DebuggeeLauncher
        this._launcher = new DebuggeeLauncher();
        this._launcher.onDbgsOutput((chunk, stream) => {
            // Префикс [dbgs:stderr]/[dbgs:stdout] чтобы было видно происхождение в Debug Console.
            const prefix = stream === 'stderr' ? '[dbgs:stderr]' : '[dbgs:stdout]';
            this.sendEvent(new OutputEvent(`${prefix} ${chunk}`, stream === 'stderr' ? 'stderr' : 'console'));
        });
        this._launcher.onDbgsExit((code) => {
            this.sendEvent(new OutputEvent(
                `BSL Debug: dbgs завершился с кодом ${code}\n`, 'console'
            ));
            this.sendEvent(new TerminatedEvent());
        });
        this._launcher.onDebuggeeExit((code) => {
            this.sendEvent(new OutputEvent(
                `BSL Debug: 1С клиент завершился с кодом ${code}\n`, 'console'
            ));
            this.sendEvent(new TerminatedEvent());
        });

        // 3. Start debug server
        const host = cfg.debugServerHost ?? 'localhost';
        let port = cfg.debugServerPort ?? 1550;

        if (cfg.debuggeeType === 'webServer') {
            this._isWebServer = true;
            // ibsrv with --debug=http --debug-port=<free> acts as its own RDBG server.
            // No external dbgs needed. Start ibsrv first, then attach DAP transport to debug-port.
            const ibsrvName = process.platform === 'win32' ? 'ibsrv.exe' : 'ibsrv';
            const exe = path.join(platformBin, ibsrvName);

            let databasePath = cfg.databasePath ?? '';
            if (!databasePath) {
                const fileMatch = /File\s*=\s*([^;]+)/i.exec(cfg.infobase);
                if (fileMatch) {
                    databasePath = fileMatch[1].trim().replace(/^"+|"+$/g, '');
                }
            }
            if (!databasePath) {
                if (this._launcher) { try { await this._launcher.dispose(); } catch { /* */ } }
                this._launcher = undefined;
                this.sendErrorResponse(response, 1105,
                    'debuggeeType=webServer требует databasePath.');
                return;
            }

            const httpPort = cfg.webServerHttpPort ?? 8080;
            const debugPort = await getFreePort();
            let dataDir: string;
            try {
                dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibsrv-'));
            } catch (err) {
                if (this._launcher) { try { await this._launcher.dispose(); } catch { /* */ } }
                this._launcher = undefined;
                this.sendErrorResponse(response, 1106,
                    `Не удалось создать tmpdir: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }

            try {
                this._launcher.startWebServerDebuggee({ exe, databasePath, debugPort, httpPort, dataDir });
                this.sendEvent(new OutputEvent(
                    `BSL Debug: ibsrv запущен: ${exe} (http=${httpPort}, debug=${debugPort})\n`, 'console'));
            } catch (err) {
                if (this._launcher) { try { await this._launcher.dispose(); } catch { /* */ } }
                this._launcher = undefined;
                this.sendErrorResponse(response, 1107,
                    `Не удалось запустить ibsrv: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }

            // Wait for ibsrv HTTP + RDBG readiness
            try {
                await this._waitForHttpReady(`http://${host}:${httpPort}/`, 30000, 500);
                await this._waitForHttpReady(`http://${host}:${debugPort}/e1crdbg/rdbg`, 10000, 500);
                this.sendEvent(new OutputEvent('BSL Debug: ibsrv ready\n', 'console'));
            } catch (err) {
                if (this._launcher) { try { await this._launcher.dispose(); } catch { /* */ } }
                this._launcher = undefined;
                this.sendErrorResponse(response, 1108,
                    `ibsrv не готов: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }

            // DAP transport connects to ibsrv debug-port (built-in RDBG)
            port = debugPort;
        } else {
            // thinClient: start external dbgs
            try {
                await this._launcher.startDbgs({ platformBin, host, port });
                const dbgsMsg = this._launcher.isExternalDbgs
                    ? `BSL Debug: подключение к существующему dbgs на http://${host}:${port}\n`
                    : `BSL Debug: dbgs запущен на http://${host}:${port}\n`;
                this.sendEvent(new OutputEvent(dbgsMsg, 'console'));
            } catch (err) {
                if (this._launcher) {
                    try { await this._launcher.dispose(); } catch { /* no-op */ }
                }
                this._launcher = undefined;
                this.sendErrorResponse(
                    response, 1101,
                    `Не удалось запустить dbgs: ${err instanceof Error ? err.message : String(err)}`
                );
                return;
            }
        }

        // 4. Build _configRoots
        this._configRoots = [cfg.rootProject, ...(cfg.extensions ?? [])].filter(
            (r): r is string => typeof r === 'string' && r.length > 0
        );

        // 5. Setup transport + client
        this._transport = new RdbgTransport(
            `http://${host}:${port}`,
            this._debugUiId,
            undefined,
            cfg.connectTimeoutMs
        );
        const discoveryInterval = cfg.debuggeeType === 'webServer' ? 1 : 5;
        this._client = new RdbgClient(this._transport, this._debugUiId, discoveryInterval);
        this._setupClientListeners(this._client);

        // 6. Attach to debug server
        try {
            await this._client.attach(cfg.infobaseAlias);
            this.sendEvent(new OutputEvent(
                `BSL Debug: подключено к серверу отладки, UI=${this._debugUiId}\n`, 'console'
            ));
        } catch (err) {
            if (this._launcher) {
                try { await this._launcher.dispose(); } catch { /* no-op */ }
            }
            this._launcher = undefined;
            this._transport?.dispose();
            this._client = undefined;
            this._transport = undefined;
            this.sendErrorResponse(
                response, 1102,
                `Ошибка подключения к серверу отладки: ${err instanceof Error ? err.message : String(err)}`
            );
            return;
        }

        // 7. Spawn debuggee (thinClient only; ibsrv is already started in step 3)
        const debugServerUrl = `http://${host}:${port}`;

        // Defensive: _launcher could be nulled by a concurrent disconnect/exit handler
        const launcherForDebuggee = this._launcher;
        if (!launcherForDebuggee) {
            this.sendErrorResponse(
                response, 1104,
                'Внутренняя ошибка: launcher был сброшен до запуска 1С (возможно, dbgs упал или сессия отключена).'
            );
            return;
        }

        if (cfg.debuggeeType === 'webServer') {
            // ibsrv already started in step 3 with built-in RDBG — nothing to do here.
        } else {
            // --- default: thin client (1cv8c.exe) ---
            // Determine connection argument based on infobase string format.
            // If it contains "Srvr=" or "File=" — treat as connection string,
            // otherwise treat as named infobase (/IBNAME).
            const exeName = process.platform === 'win32' ? '1cv8c.exe' : '1cv8c';
            const exe = path.join(platformBin, exeName);
            const ib = cfg.infobase;
            const isConnStr = /Srvr\s*=/i.test(ib) || /File\s*=/i.test(ib);
            const baseArgs = isConnStr
                ? ['/IBConnectionString', ib]
                : ['/IBNAME', ib];

            try {
                await launcherForDebuggee.startDebuggee({ exe, args: baseArgs, debugServerUrl });
                this.sendEvent(new OutputEvent(
                    `BSL Debug: 1С клиент запущен: ${exe}\n`, 'console'
                ));
            } catch (err) {
                try { await launcherForDebuggee.dispose(); } catch { /* no-op */ }
                this._launcher = undefined;
                this._transport?.dispose();
                this._client = undefined;
                this._transport = undefined;
                this.sendErrorResponse(
                    response, 1103,
                    `Не удалось запустить 1С: ${err instanceof Error ? err.message : String(err)}`
                );
                return;
            }
        }

        // 8. OQ-1: autoAttachTypes not yet fully implemented — log warning and skip
        if (cfg.autoAttachTypes && cfg.autoAttachTypes.length > 0) {
            this.sendEvent(new OutputEvent(
                `BSL Debug: autoAttachTypes указан, но encoder OQ-1 не реализован; ` +
                `используется поведение платформы по умолчанию\n`,
                'console'
            ));
        }

        // 9. Start polling
        this._client.startPolling(cfg.pingIntervalMs ?? 1000);

        // 10. Signal DAP client that we are ready
        this.sendEvent(new InitializedEvent());
        this.sendResponse(response);
    }

    // -------------------------------------------------------------------------
    // Attach
    // -------------------------------------------------------------------------

    protected async attachRequest(
        response: DebugProtocol.AttachResponse,
        args: DebugProtocol.AttachRequestArguments
    ): Promise<void> {
        const cfg = args as unknown as BslAttachConfiguration;

        this._transport = new RdbgTransport(
            `http://${cfg.host}:${cfg.port}`,
            this._debugUiId,
            undefined,
            cfg.connectTimeoutMs
        );
        this._client = new RdbgClient(this._transport, this._debugUiId);

        this._setupClientListeners(this._client);

        this.sendEvent(new OutputEvent(`BSL Debug: connecting to http://${cfg.host}:${cfg.port}, UI=${this._debugUiId}\n`, 'console'));
        try {
            await this._client.attach(cfg.infobaseAlias);
            this.sendEvent(new OutputEvent(`BSL Debug: attached successfully\n`, 'console'));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendEvent(new OutputEvent(`BSL Debug: ошибка подключения: ${message}\n`, 'stderr'));
            this.sendEvent(new TerminatedEvent());
            this.sendErrorResponse(response, 1001, `Ошибка подключения к отладчику: ${message}`);
            return;
        }

        if (cfg.autoAttachTargets) {
            try {
                const targets = await this._client.getTargets();
                if (targets.length > 0) {
                    await this._client.attachTargets(targets.map((t) => ({ id: t.id, seanceId: t.seanceId })));
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.sendEvent(
                    new OutputEvent(`BSL Debug: не удалось подключить цели: ${message}\n`, 'stderr')
                );
            }
        }

        this._client.startPolling(cfg.pingIntervalMs ?? 1000);

        // Build config roots list for module ID resolution
        {
            const workspaceRoot = (cfg as Record<string, unknown>)['workspaceRoot'] as string | undefined;
            const extensions = cfg.extensions ?? [];
            this._configRoots = [workspaceRoot, ...extensions].filter(
                (r): r is string => typeof r === 'string' && r.length > 0
            );
        }

        this.sendEvent(new InitializedEvent());
        this.sendResponse(response);
    }

    // -------------------------------------------------------------------------
    // Disconnect / Terminate
    // -------------------------------------------------------------------------

    protected async disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        _args: DebugProtocol.DisconnectArguments
    ): Promise<void> {
        await this._doDisconnect();
        this.sendResponse(response);
    }

    protected async terminateRequest(
        response: DebugProtocol.TerminateResponse,
        _args: DebugProtocol.TerminateArguments
    ): Promise<void> {
        await this._doDisconnect();
        this.sendResponse(response);
    }

    private async _doDisconnect(): Promise<void> {
        try {
            this._client?.stopPolling();
            if (this._client) {
                await this._client.detach();
            }
        } catch {
            // swallow
        } finally {
            this._transport?.dispose();
            this._client = undefined;
            this._transport = undefined;
            this._pausedThreadId = undefined;
            if (this._launcher) {
                await this._launcher.dispose();
                this._launcher = undefined;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Breakpoints
    // -------------------------------------------------------------------------

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): Promise<void> {
        if (!this._client) {
            response.body = { breakpoints: [] };
            this.sendResponse(response);
            return;
        }

        try {
            const sourcePath = args.source.path ?? '';
            const requestedBps = args.breakpoints ?? [];

            // Resolve BSL file path to RDBG module ID (objectUUID + propertyId suffix)
            const resolved = await resolveModuleId(sourcePath, this._configRoots);
            this.sendEvent(new OutputEvent(
                `[bsl-debug] setBreakpoints: source=${sourcePath} configRoots=${JSON.stringify(this._configRoots)} resolved=${resolved ? `${resolved.label} (${resolved.moduleId.objectId}:${resolved.moduleId.propertyId})` : 'UNRESOLVED'}\n`,
                'console'
            ));

            if (!resolved) {
                if (requestedBps.length === 0) {
                    response.body = { breakpoints: [] };
                    this.sendResponse(response);
                    return;
                }
                this.sendEvent(
                    new OutputEvent(
                        `BSL Debug: cannot map "${sourcePath}" to RDBG module — breakpoints not sent to server (remove them or fix path).\n`,
                        'stderr'
                    )
                );
                response.body = {
                    breakpoints: requestedBps.map((bp) => new Breakpoint(false, bp.line)),
                };
                this.sendResponse(response);
                return;
            }

            const moduleId = resolved.moduleId;
            const extKey = makeExtKey(moduleId);

            // Warn about unparseable hitCondition strings
            for (const bp of requestedBps) {
                if (bp.hitCondition && bp.hitCondition.trim() !== '') {
                    const parsed = parseHitCondition(bp.hitCondition);
                    if (parsed === undefined) {
                        this.sendEvent(new OutputEvent(
                            `BSL Debug: hitCondition "${bp.hitCondition}" (line ${bp.line}) could not be parsed — hitCount not set for this breakpoint.\n`,
                            'console'
                        ));
                    }
                }
            }

            if (requestedBps.length === 0) {
                // Clear breakpoints for this module
                const hadEntry = this._bpWorkspace.has(extKey);
                const allBps = buildWorkspaceSnapshot(this._bpWorkspace, extKey, undefined);
                if (hadEntry) {
                    await this._client.setBreakpoints(allBps);
                }
                response.body = { breakpoints: [] };
                this.sendResponse(response);
                return;
            }

            // Build converted BPs and update snapshot
            const convertedBps = dapToRdbgBreakpoints(moduleId, requestedBps);
            const entry: BpWorkspaceEntry = { source: sourcePath, moduleId, bps: convertedBps };
            const allBps = buildWorkspaceSnapshot(this._bpWorkspace, extKey, entry);

            // Send full workspace snapshot to server (platform treats setBreakpoints as full replacement)
            const confirmed = await this._client.setBreakpoints(allBps);

            // Build DAP response: filter confirmed BPs to those belonging to the current module
            // Fallback: if confirmed is empty/uninformative, verify locally
            const currentLinenos = new Set(requestedBps.map(bp => bp.line));
            const confirmedForModule = confirmed.filter(b =>
                makeExtKey(b.moduleId) === extKey && currentLinenos.has(b.lineNo)
            );

            let dapBreakpoints: Breakpoint[];
            if (confirmedForModule.length > 0) {
                dapBreakpoints = confirmedForModule.map(bp => new Breakpoint(true, bp.lineNo));
            } else {
                // Fallback: verify all requested BPs locally (server may return empty confirmed list)
                dapBreakpoints = requestedBps.map(bp => new Breakpoint(true, bp.line));
            }

            response.body = { breakpoints: dapBreakpoints };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendErrorResponse(response, 1002, `Ошибка установки точек останова: ${message}`);
            return;
        }

        this.sendResponse(response);
    }

    // -------------------------------------------------------------------------
    // Exception breakpoints
    // -------------------------------------------------------------------------

    protected async setExceptionBreakPointsRequest(
        response: DebugProtocol.SetExceptionBreakpointsResponse,
        args: DebugProtocol.SetExceptionBreakpointsArguments
    ): Promise<void> {
        if (!this._client) {
            response.body = { breakpoints: [] };
            this.sendResponse(response);
            return;
        }

        try {
            const state = dapToExceptionState(args.filterOptions, args.filters);
            await this._client.setExceptionBreakpoints(state);

            const filterCount = state.filters?.length ?? 0;
            this.sendEvent(new OutputEvent(
                `BSL Debug: exception breakpoints updated — stopOnErrors=${state.stopOnErrors}` +
                (filterCount > 0 ? `, ${filterCount} filter(s)` : '') +
                '\n',
                'console'
            ));

            response.body = { breakpoints: [{ verified: true }] };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendEvent(new OutputEvent(`BSL Debug: ошибка установки exception breakpoint: ${message}\n`, 'stderr'));
            response.body = { breakpoints: [] };
        }

        this.sendResponse(response);
    }

    // -------------------------------------------------------------------------
    // Threads
    // -------------------------------------------------------------------------

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        if (this._threadMap.size === 0) {
            response.body = { threads: [new Thread(1, 'Main')] };
        } else {
            const threads: Thread[] = [];
            this._threadMap.forEach((targetId, threadId) => {
                threads.push(new Thread(threadId, targetId));
            });
            response.body = { threads };
        }
        this.sendResponse(response);
    }

    // -------------------------------------------------------------------------
    // Stack trace
    // -------------------------------------------------------------------------

    protected async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): Promise<void> {
        const targetId = this._threadMap.get(args.threadId);

        if (!targetId || !this._client) {
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
            return;
        }

        try {
            let callStack = this._stackTraceCacheByThreadId.get(args.threadId);
            if (!callStack || callStack.length === 0) {
                try {
                    callStack = await this._client.getCallStack(targetId);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.sendEvent(new OutputEvent(`BSL Debug: getCallStack failed (using empty): ${msg}\n`, 'console'));
                    callStack = [];
                }
            }

            const stackFrames = await this._rdbgItemsToStackFramesAsync(callStack, args.threadId);

            response.body = { stackFrames, totalFrames: stackFrames.length };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendErrorResponse(response, 1003, `Ошибка получения стека вызовов: ${message}`);
            return;
        }

        this.sendResponse(response);
    }

    // -------------------------------------------------------------------------
    // Scopes
    // -------------------------------------------------------------------------

    protected scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments
    ): void {
        const frameRef = this._frameRefs.get(args.frameId);
        if (!frameRef) {
            // Fallback: unknown frameId — return empty scopes
            response.body = { scopes: [] };
            this.sendResponse(response);
            return;
        }
        // Create a variableRef for the "Locals" scope (empty path = all local variables)
        const varRef = this._variableRefs.add({
            threadId: frameRef.threadId,
            frameLevel: frameRef.frameLevel,
            path: [],
            view: 'context',
            sourcePath: frameRef.sourcePath,
            sourceLine: frameRef.sourceLine,
        });
        const scope = new Scope('Локальные', varRef, false);
        response.body = { scopes: [scope] };
        this.sendResponse(response);
    }

    // -------------------------------------------------------------------------
    // Variables
    // -------------------------------------------------------------------------

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        if (!this._client) {
            response.body = { variables: [] };
            this.sendResponse(response);
            return;
        }

        // Resolve the variable reference to its stored state
        const state = this._variableRefs.get(args.variablesReference);
        if (!state) {
            response.body = { variables: [] };
            this.sendResponse(response);
            return;
        }

        const targetId = this._threadMap.get(state.threadId);
        if (!targetId) {
            response.body = { variables: [] };
            this.sendResponse(response);
            return;
        }

        try {
            let children: RdbgVariableNode[];
            if (state.path.length === 0 && state.sourcePath && state.sourceLine !== undefined) {
                const source = await fs.promises.readFile(state.sourcePath, 'utf8');
                const candidates = extractLocalCandidatesFromBsl(source, state.sourceLine);
                response.body = {
                    variables: await this._buildSourceLocalVariables(targetId, state.frameLevel, candidates),
                };
                this.sendResponse(response);
                return;
            }
            if (state.path.length === 0 && this._isWebServer) {
                // ibsrv crashes on evalLocalVariables — skip locals enumeration.
                // Individual expressions work via evaluateRequest (evalExpr).
                children = [];
            } else if (state.path.length === 0) {
                // Top-level locals scope is intentionally safe-empty in RdbgClient.
                children = await this._client.evalLocalVariables(targetId, state.frameLevel);
            } else {
                // Drilldown: evaluate path to get nested properties/elements
                const result = await this._client.evalExpressionPath(
                    targetId, state.frameLevel, state.path, state.view
                );
                children = result.children;
            }

            const variables = buildDapVariables(state, children, this._variableRefs);
            response.body = { variables };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendEvent(new OutputEvent(
                `BSL Debug: ошибка получения переменных: ${message}\n`, 'stderr'
            ));
            response.body = { variables: [] };
        }

        this.sendResponse(response);
    }

    // -------------------------------------------------------------------------
    // Evaluate
    // -------------------------------------------------------------------------

    protected async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments
    ): Promise<void> {
        if (!this._client) {
            this.sendErrorResponse(response, 1005, 'Отладчик не подключён');
            return;
        }

        const threadIdForEval = this._pausedThreadId;
        const targetId =
            threadIdForEval !== undefined
                ? this._threadMap.get(threadIdForEval)
                : this._threadMap.size > 0
                  ? (this._threadMap.values().next().value as string)
                  : undefined;

        if (!targetId) {
            this.sendErrorResponse(response, 1005, 'Нет активных целей отладки');
            return;
        }

        try {
            // args.frameId is a DAP-side identifier (a value handed out by _frameRefs.add()),
            // NOT a stack-frame index. Resolve it back to the real frameLevel before sending
            // to the platform — otherwise hover-evaluate hits the wrong stack frame and reads
            // variables from the wrong activation.
            const frameRef = args.frameId !== undefined ? this._frameRefs.get(args.frameId) : undefined;
            const frameLevel = frameRef?.frameLevel ?? 0;

            const watchCacheKey =
                args.context === 'watch'
                    ? `${targetId}\n${frameLevel}\n${args.expression}`
                    : undefined;

            let result: RdbgEvalResult | undefined =
                watchCacheKey !== undefined ? this._watchEvaluateCache.get(watchCacheKey) : undefined;
            if (result === undefined) {
                result = await this._client.evaluate(
                    targetId,
                    args.expression,
                    frameLevel,
                    this._evaluateOptionsForContext(args.context)
                );
                if (watchCacheKey !== undefined && !result.error) {
                    this._watchEvaluateCache.set(watchCacheKey, result);
                }
            }

            if (result.error) {
                this.sendErrorResponse(response, 1006, result.error);
                return;
            }

            response.body = {
                result: result.value,
                type: result.typeName,
                variablesReference: 0,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendErrorResponse(response, 1006, `Ошибка вычисления выражения: ${message}`);
            return;
        }

        this.sendResponse(response);
    }

    private _evaluateOptionsForContext(context: DebugProtocol.EvaluateArguments['context']): RdbgEvalOptions {
        const purpose = context ?? 'repl';
        const calcWaitingTimeMs =
            purpose === 'watch' || purpose === 'hover'
                ? FAST_EVALUATE_WAIT_MS
                : FULL_EVALUATE_WAIT_MS;
        return { purpose, calcWaitingTimeMs };
    }

    private async _buildSourceLocalVariables(
        targetId: string,
        frameLevel: number,
        candidates: BslLocalCandidate[]
    ): Promise<DebugProtocol.Variable[]> {
        const variables = buildSourceLocalVariables(candidates);
        if (!this._client) {
            return variables;
        }

        for (let index = 0; index < Math.min(variables.length, MAX_SOURCE_LOCAL_EVALUATIONS); index += 1) {
            const candidate = candidates[index];
            const variable = variables[index];
            try {
                const result = await this._client.evaluate(targetId, candidate.name, frameLevel, {
                    purpose: 'variables',
                    calcWaitingTimeMs: FAST_EVALUATE_WAIT_MS,
                });
                if (!result.error) {
                    variable.value = result.value;
                    variable.type = result.typeName;
                }
            } catch {
                // Keep the source-derived local visible even when the platform cannot evaluate it quickly.
            }
        }

        return variables;
    }

    // -------------------------------------------------------------------------
    // Execution control
    // -------------------------------------------------------------------------

    protected async continueRequest(
        response: DebugProtocol.ContinueResponse,
        args: DebugProtocol.ContinueArguments
    ): Promise<void> {
        const targetId = this._threadMap.get(args.threadId);

        if (!this._client || !targetId) {
            this.sendErrorResponse(response, 1007, 'Нет активной цели для продолжения');
            return;
        }

        try {
            this._lastStoppedKey = '';
            await this._client.continue(targetId);
            this._stackTraceCacheByThreadId.delete(args.threadId);
            response.body = { allThreadsContinued: false };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendErrorResponse(response, 1007, `Ошибка продолжения выполнения: ${message}`);
            return;
        }

        this.sendResponse(response);
    }

    protected async nextRequest(
        response: DebugProtocol.NextResponse,
        args: DebugProtocol.NextArguments
    ): Promise<void> {
        const targetId = this._threadMap.get(args.threadId);

        if (!this._client || !targetId) {
            this.sendErrorResponse(response, 1008, 'Нет активной цели для шага');
            return;
        }

        try {
            this._lastStoppedKey = '';
            await this._client.step(targetId, 'over');
            this._stackTraceCacheByThreadId.delete(args.threadId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendErrorResponse(response, 1008, `Ошибка шага (over): ${message}`);
            return;
        }

        this.sendResponse(response);
    }

    protected async stepInRequest(
        response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments
    ): Promise<void> {
        const targetId = this._threadMap.get(args.threadId);

        if (!this._client || !targetId) {
            this.sendErrorResponse(response, 1009, 'Нет активной цели для шага внутрь');
            return;
        }

        try {
            this._lastStoppedKey = '';
            await this._client.step(targetId, 'into');
            this._stackTraceCacheByThreadId.delete(args.threadId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendErrorResponse(response, 1009, `Ошибка шага (into): ${message}`);
            return;
        }

        this.sendResponse(response);
    }

    protected async stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        args: DebugProtocol.StepOutArguments
    ): Promise<void> {
        const targetId = this._threadMap.get(args.threadId);

        if (!this._client || !targetId) {
            this.sendErrorResponse(response, 1010, 'Нет активной цели для шага наружу');
            return;
        }

        try {
            this._lastStoppedKey = '';
            await this._client.step(targetId, 'out');
            this._stackTraceCacheByThreadId.delete(args.threadId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendErrorResponse(response, 1010, `Ошибка шага (out): ${message}`);
            return;
        }

        this.sendResponse(response);
    }

    protected pauseRequest(
        response: DebugProtocol.PauseResponse,
        _args: DebugProtocol.PauseArguments
    ): void {
        // Not supported in MVP
        this.sendErrorResponse(response, 1011, 'Приостановка выполнения не поддерживается');
    }

    // -------------------------------------------------------------------------
    // Exception info
    // -------------------------------------------------------------------------

    protected exceptionInfoRequest(
        response: DebugProtocol.ExceptionInfoResponse,
        _args: DebugProtocol.ExceptionInfoArguments
    ): void {
        if (this._lastError) {
            response.body = {
                exceptionId: 'runtime',
                description: this._lastError.description,
                breakMode: 'always',
            };
        }
        this.sendResponse(response);
    }

    // -------------------------------------------------------------------------
    // Client event listeners
    // -------------------------------------------------------------------------

    private async _rdbgItemsToStackFramesAsync(items: RdbgCallStackItem[], threadId: number): Promise<StackFrame[]> {
        // 1C platform sends call stack bottom-up (caller first, current frame last).
        // DAP expects top-down (current frame first). Reverse.
        const reversed = [...items].reverse();
        const out: StackFrame[] = [];
        for (let index = 0; index < reversed.length; index++) {
            const item = reversed[index];
            const label =
                item.presentation.trim() !== ''
                    ? item.presentation
                    : item.moduleId.objectId
                      ? path.basename(item.moduleId.objectId)
                      : `Frame ${index + 1}`;
            let resolvedPath: string | undefined;
            if (this._configRoots.length > 0) {
                try {
                    const resolverRoots = await this._buildResolverRoots();
                    resolvedPath = await resolveBslPathFromRdbgModule(
                        item.moduleId,
                        resolverRoots
                    );
                } catch {
                    resolvedPath = undefined;
                }
            }
            const sourceName = resolvedPath ? path.basename(resolvedPath) : label;
            const source = resolvedPath
                ? new Source(sourceName, resolvedPath)
                : new Source(label);
            // Phase 4: use ReferencesTable for frameId (1-based, monotonic, thread-aware)
            const frameId = this._frameRefs.add({
                threadId,
                frameLevel: index,
                sourcePath: resolvedPath,
                sourceLine: item.lineNo,
            });
            out.push(new StackFrame(frameId, label, source, item.lineNo));
        }
        return out;
    }

    /**
     * Build an array of ResolverConfigRoot by reading extensionName from each config root.
     * Cached by readExtensionName — repeated calls are cheap.
     */
    private async _buildResolverRoots(): Promise<ResolverConfigRoot[]> {
        const result: ResolverConfigRoot[] = [];
        for (const root of this._configRoots) {
            const extensionName = await readExtensionName(root);
            result.push({ extensionName, root });
        }
        return result;
    }

    private _setupClientListeners(client: RdbgClient): void {
        client.on('stopped', (e) => {
            let threadId = this._reverseThreadMap.get(e.targetId);
            if (threadId === undefined && this._threadMap.size > 0) {
                const first = this._threadMap.keys().next();
                threadId = first.done ? 1 : first.value;
            }
            if (threadId === undefined) {
                threadId = 1;
            }

            // Update stack cache regardless of dedup
            if (e.callStack && e.callStack.length > 0) {
                this._stackTraceCacheByThreadId.set(threadId, e.callStack);
            } else {
                this._stackTraceCacheByThreadId.delete(threadId);
            }
            if (e.reason === 'exception' && e.error) {
                this._lastError = e.error;
            }

            // Log decoded call stack for diagnostics
            const csInfo = (e.callStack ?? []).map((f, i) =>
                `  [${i}] line=${f.lineNo} obj=${f.moduleId.objectId?.slice(0, 8)} prop=${f.moduleId.propertyId?.slice(0, 8)} pres=${f.presentation?.slice(0, 40)}`
            ).join('\n');
            this.sendEvent(new OutputEvent(
                `BSL Debug: stopped reason=${e.reason} target=${e.targetId?.slice(0, 8)} frames=${e.callStack?.length ?? 0}\n${csInfo}\n`,
                'console'
            ));

            // Dedup: skip StoppedEvent if same position/reason as last ping
            const stoppedKey = `${e.targetId}:${e.callStack?.[0]?.lineNo ?? ''}:${e.reason}`;
            if (stoppedKey !== this._lastStoppedKey) {
                this._watchEvaluateCache.clear();
            }
            if (stoppedKey === this._lastStoppedKey) {
                return;
            }
            this._lastStoppedKey = stoppedKey;

            // Full stopped body (allThreadsStopped, description) helps some clients show pause + thread UI.
            this._pausedThreadId = threadId;
            this.sendEvent(
                new Event('stopped', {
                    reason: e.reason,
                    threadId,
                    allThreadsStopped: true,
                    ...(e.reason === 'breakpoint'
                        ? { description: 'Paused on breakpoint' }
                        : e.reason === 'step'
                          ? { description: 'Paused on step' }
                          : {}),
                })
            );
        });

        client.on('continued', (e) => {
            const threadId = this._reverseThreadMap.get(e.targetId) ?? 1;
            this._stackTraceCacheByThreadId.delete(threadId);
            if (this._pausedThreadId === threadId) {
                this._pausedThreadId = undefined;
            }
            this._lastStoppedKey = '';
            this._watchEvaluateCache.clear();
            // Phase 4: clear stale frame/variable references for this thread
            this._frameRefs.clear(f => f.threadId === threadId);
            this._variableRefs.clear(v => v.threadId === threadId);
            this.sendEvent(new ContinuedEvent(threadId));
        });

        client.on('targetStarted', (e) => {
            const threadId = this._nextThreadId++;
            this._threadMap.set(threadId, e.target.id);
            this._reverseThreadMap.set(e.target.id, threadId);
            this.sendEvent(new OutputEvent(`BSL Debug: target started id=${e.target.id} seance=${e.target.seanceId}\n`, 'console'));
            this.sendEvent(new ThreadEvent('started', threadId));
            // Auto-attach new target so breakpoints fire
            void this._client?.attachTargets([{ id: e.target.id, seanceId: e.target.seanceId ?? '' }])
                .then(() => {
                    this.sendEvent(new OutputEvent(`BSL Debug: target attached OK\n`, 'console'));
                    return this._reapplyBreakpoints();
                })
                .catch((err) => this.sendEvent(new OutputEvent(`BSL Debug: target attach FAILED: ${err}\n`, 'stderr')));
        });

        client.on('targetQuit', (e) => {
            const threadId = this._reverseThreadMap.get(e.targetId);
            if (threadId !== undefined) {
                this.sendEvent(new ThreadEvent('exited', threadId));
                this._threadMap.delete(threadId);
                this._reverseThreadMap.delete(e.targetId);
                this._stackTraceCacheByThreadId.delete(threadId);

                if (this._threadMap.size === 0) {
                    this.sendEvent(new TerminatedEvent());
                }
            }
        });

        client.on('runtimeError', (e) => {
            this._lastError = e.error;
            const threadId = this._reverseThreadMap.get(e.targetId) ?? 1;
            this._pausedThreadId = threadId;
            this.sendEvent(new StoppedEvent('exception', threadId));
        });

        client.on('error', (err) => {
            this.sendEvent(new OutputEvent(err.message + '\n', 'stderr'));
            this.sendEvent(new TerminatedEvent());
        });

        client.on('log', (msg: string) => {
            this.sendEvent(new OutputEvent(`BSL Debug: ${msg}\n`, 'console'));
        });
    }

    /**
     * Poll the given URL via HTTP GET until it responds (any status < 600),
     * or until timeoutMs elapses. Returns true if the server became ready.
     */
    private _waitForHttpReady(url: string, timeoutMs: number, intervalMs: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const deadline = Date.now() + timeoutMs;

            const probe = () => {
                if (Date.now() >= deadline) {
                    resolve(false);
                    return;
                }
                const req = http.get(url, (res) => {
                    res.resume(); // consume response to free socket
                    if (res.statusCode !== undefined && res.statusCode < 600) {
                        resolve(true);
                    } else {
                        setTimeout(probe, intervalMs);
                    }
                });
                req.on('error', () => {
                    setTimeout(probe, intervalMs);
                });
                req.end();
            };

            probe();
        });
    }

    private async _reapplyBreakpoints(): Promise<void> {
        if (!this._client || this._bpWorkspace.size === 0) {
            return;
        }
        // Send the full workspace snapshot in a single call.
        // Platform treats setBreakpoints as a full replacement — sending per-module
        // would cause each call to overwrite the previous one.
        const allBps = Array.from(this._bpWorkspace.values()).flatMap(e => e.bps);
        try {
            await this._client.setBreakpoints(allBps);
            this.sendEvent(new OutputEvent(
                `BSL Debug: re-applied ${allBps.length} breakpoint(s) from ${this._bpWorkspace.size} module(s)\n`,
                'console'
            ));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.sendEvent(new OutputEvent(`BSL Debug: failed to re-apply breakpoints: ${msg}\n`, 'stderr'));
        }
    }
}
