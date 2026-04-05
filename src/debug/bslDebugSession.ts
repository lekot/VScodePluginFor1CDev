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
import { RdbgRuntimeError, RdbgBreakpointRequest, RdbgCallStackItem } from './rdbg/rdbgTypes';
import { BslAttachConfiguration } from './types';
import { resolveModuleId, resolveBslPathFromRdbgModule } from './moduleIdResolver';

export class BslDebugSession extends DebugSession {
    private _client: RdbgClient | undefined;
    private _transport: RdbgTransport | undefined;
    private readonly _debugUiId: string;
    private readonly _threadMap: Map<number, string> = new Map();
    private readonly _reverseThreadMap: Map<string, number> = new Map();
    private _nextThreadId: number = 1;
    private _lastError: RdbgRuntimeError | undefined;
    private _workspaceRoot: string = '';
    private readonly _knownBreakpoints: Map<string, { moduleId: { objectId: string; propertyId: string }; lineNos: number[] }> = new Map();
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
            const rdbgBps: RdbgBreakpointRequest[] = requestedBps.map((bp) => ({
                moduleId,
                lineNo: bp.line,
            }));

            this._knownBreakpoints.set(sourcePath, {
                moduleId: resolved.moduleId,
                lineNos: requestedBps.map(bp => bp.line),
            });

            const confirmed = await this._client.setBreakpoints(rdbgBps);

            const dapBreakpoints: Breakpoint[] = confirmed.map((bp) => {
                const b = new Breakpoint(true, bp.lineNo);
                return b;
            });

            response.body = { breakpoints: dapBreakpoints };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.sendErrorResponse(response, 1002, `Ошибка установки точек останова: ${message}`);
            return;
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
        if (!this._client || this._knownBreakpoints.size === 0) return;
        for (const [sourcePath, entry] of this._knownBreakpoints) {
            try {
                const rdbgBps = entry.lineNos.map(lineNo => ({
                    moduleId: entry.moduleId,
                    lineNo,
                }));
                await this._client.setBreakpoints(rdbgBps);
                this.sendEvent(new OutputEvent(`BSL Debug: re-set ${rdbgBps.length} breakpoint(s) for ${sourcePath}\n`, 'console'));
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.sendEvent(new OutputEvent(`BSL Debug: failed to re-set breakpoints for ${sourcePath}: ${msg}\n`, 'stderr'));
            }
        }
    }
}
