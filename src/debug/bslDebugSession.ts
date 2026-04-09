import * as crypto from 'crypto';
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
    // Variable,  // TODO: re-enable when Locals via evalExpr is implemented
    Source,
    Breakpoint,
    Event,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { RdbgClient } from './rdbg/rdbgClient';
import { RdbgTransport } from './rdbg/rdbgTransport';
import { RdbgRuntimeError, RdbgBreakpointRequest, RdbgCallStackItem, RdbgModuleId, RdbgExceptionBreakpointState, RdbgExceptionFilterItem } from './rdbg/rdbgTypes';
import { BslAttachConfiguration } from './types';
import { resolveModuleId, resolveBslPathFromRdbgModule } from './moduleIdResolver';

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
    private _workspaceRoot: string = '';
    /** Workspace snapshot: extKey → BpWorkspaceEntry (replaces old _knownBreakpoints). */
    private readonly _bpWorkspace: Map<string, BpWorkspaceEntry> = new Map();
    /** Frames from last DBGUIExtCmdInfoCallStackFormed (ping); 1C often does not fill HTTP getCallStack for UI. */
    private readonly _stackTraceCacheByThreadId: Map<number, RdbgCallStackItem[]> = new Map();
    /** Thread that last received `stopped` — Locals/Evaluate must use its targetId (not arbitrary Map iteration). */
    private _pausedThreadId: number | undefined;
    /** Dedup key for last StoppedEvent — prevents repeated UI refresh on each ping tick while paused. */
    private _lastStoppedKey: string = '';

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

        // Store workspace root for module ID resolution
        if ((cfg as Record<string, unknown>)['workspaceRoot']) {
            this._workspaceRoot = String((cfg as Record<string, unknown>)['workspaceRoot']);
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
            const resolved = await resolveModuleId(sourcePath, this._workspaceRoot);
            this.sendEvent(new OutputEvent(
                `[bsl-debug] setBreakpoints: source=${sourcePath} workspaceRoot=${this._workspaceRoot} resolved=${resolved ? `${resolved.label} (${resolved.moduleId.objectId}:${resolved.moduleId.propertyId})` : 'UNRESOLVED'}\n`,
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

            const stackFrames = await this._rdbgItemsToStackFramesAsync(callStack);

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
        // variablesReference must be > 0; use frameId + 1
        const variablesReference = args.frameId + 1;
        const scope = new Scope('Locals', variablesReference, false);
        response.body = { scopes: [scope] };
        this.sendResponse(response);
    }

    // -------------------------------------------------------------------------
    // Variables
    // -------------------------------------------------------------------------

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        _args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        if (!this._client) {
            response.body = { variables: [] };
            this.sendResponse(response);
            return;
        }

        const threadIdForVars = this._pausedThreadId;
        const targetId =
            threadIdForVars !== undefined
                ? this._threadMap.get(threadIdForVars)
                : this._threadMap.size > 0
                  ? (this._threadMap.values().next().value as string)
                  : undefined;

        if (!targetId) {
            response.body = { variables: [] };
            this.sendResponse(response);
            return;
        }

        // evalLocalVariables crashes dbgs (CalculationSourceDataStorage namespace bug in 8.3.27).
        // Configurator uses evalExpr instead. TODO: implement Locals via evalExpr.
        response.body = { variables: [] };

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
            const result = await this._client.evaluate(targetId, args.expression, args.frameId ?? 0);

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

    private async _rdbgItemsToStackFramesAsync(items: RdbgCallStackItem[]): Promise<StackFrame[]> {
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
            if (this._workspaceRoot.length > 0) {
                try {
                    resolvedPath = await resolveBslPathFromRdbgModule(
                        item.moduleId,
                        this._workspaceRoot
                    );
                } catch {
                    resolvedPath = undefined;
                }
            }
            const sourceName = resolvedPath ? path.basename(resolvedPath) : label;
            const source = resolvedPath
                ? new Source(sourceName, resolvedPath)
                : new Source(label);
            out.push(new StackFrame(index, label, source, item.lineNo));
        }
        return out;
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
