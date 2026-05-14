/**
 * State-machine client for the RDBG debug protocol.
 * Wraps RdbgTransport and RdbgXmlCodec into a high-level API
 * with polling-based event delivery.
 *
 * Does not depend on VS Code API.
 */

import { EventEmitter } from 'events';
import { RdbgTransport } from './rdbgTransport';
import * as codec from './rdbgXmlCodec';
import { RdbgTargetRef } from './rdbgXmlCodec';
import {
    RdbgTargetInfo,
    RdbgBreakpointRequest,
    RdbgBreakpoint,
    RdbgCallStackItem,
    RdbgVariable,
    RdbgEvalOptions,
    RdbgEvalResult,
    RdbgExceptionBreakpointState,
    ViewInterface,
    SourceCalcItem,
    RdbgVariableNode,
    DecodedEvalResult,
} from './rdbgTypes';
import {
    RdbgEvent,
    RdbgStoppedEvent,
    RdbgContinuedEvent,
    RdbgTargetStartedEvent,
    RdbgTargetQuitEvent,
    RdbgRuntimeErrorEvent,
    RdbgBreakpointCorrectedEvent,
    RdbgExpressionEvaluatedEvent,
} from './rdbgEvents';

function describeExpressionPath(path: SourceCalcItem[]): string {
    const firstExpression = path.find((item) => item.type === 'expression');
    if (!firstExpression || firstExpression.type !== 'expression') {
        return '<path>';
    }
    return firstExpression.expression.replace(/\s+/g, ' ').slice(0, 80);
}

// ---------------------------------------------------------------------------
// State machine type
// ---------------------------------------------------------------------------

type ClientState = 'disconnected' | 'attaching' | 'attached' | 'detaching';

// ---------------------------------------------------------------------------
// Typed EventEmitter overloads
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface RdbgClient {
    on(event: 'stopped', listener: (e: RdbgStoppedEvent) => void): this;
    on(event: 'continued', listener: (e: RdbgContinuedEvent) => void): this;
    on(event: 'targetStarted', listener: (e: RdbgTargetStartedEvent) => void): this;
    on(event: 'targetQuit', listener: (e: RdbgTargetQuitEvent) => void): this;
    on(event: 'runtimeError', listener: (e: RdbgRuntimeErrorEvent) => void): this;
    on(event: 'breakpointCorrected', listener: (e: RdbgBreakpointCorrectedEvent) => void): this;
    on(event: 'expressionEvaluated', listener: (e: RdbgExpressionEvaluatedEvent) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'log', listener: (msg: string) => void): this;

    emit(event: 'stopped', e: RdbgStoppedEvent): boolean;
    emit(event: 'continued', e: RdbgContinuedEvent): boolean;
    emit(event: 'targetStarted', e: RdbgTargetStartedEvent): boolean;
    emit(event: 'targetQuit', e: RdbgTargetQuitEvent): boolean;
    emit(event: 'runtimeError', e: RdbgRuntimeErrorEvent): boolean;
    emit(event: 'breakpointCorrected', e: RdbgBreakpointCorrectedEvent): boolean;
    emit(event: 'expressionEvaluated', e: RdbgExpressionEvaluatedEvent): boolean;
    emit(event: 'error', err: Error): boolean;
    emit(event: 'log', msg: string): boolean;
}

// ---------------------------------------------------------------------------
// RdbgClient
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class RdbgClient extends EventEmitter {
    private readonly transport: RdbgTransport;
    private readonly debugUiId: string;

    private _state: ClientState = 'disconnected';
    private _infobaseAlias?: string;
    private _pollingTimer: ReturnType<typeof setInterval> | undefined;
    /** After this many failed polls in a row, emit `error` and stop (was 3; raised for transient load at breakpoint). */
    private _consecutiveFailures = 0;
    private static readonly _maxPollFailures = 8;
    /** Only one `_poll` at a time — `setInterval` must not overlap awaits (was inflating failure count / duplicate `error`). */
    private _pollInFlight = false;
    /** After fatal transport loss: ignore further poll ticks until new `startPolling`. */
    private _sessionLost = false;
    /** Maps targetId → seanceId, populated from getTargets() and targetStarted events. */
    private readonly _seanceMap = new Map<string, string>();
    private readonly _targetDiscoveryInterval: number;

    constructor(transport: RdbgTransport, debugUiId: string, targetDiscoveryInterval = 5) {
        super();
        this.transport = transport;
        this.debugUiId = debugUiId;
        this._targetDiscoveryInterval = targetDiscoveryInterval;
    }

    // -----------------------------------------------------------------------
    // State helpers
    // -----------------------------------------------------------------------

    get state(): ClientState {
        return this._state;
    }

    private requireAttached(method: string): void {
        if (this._state !== 'attached') {
            throw new Error(
                `RdbgClient.${method}() requires state 'attached', current state: '${this._state}'`
            );
        }
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    async attach(infobaseAlias?: string): Promise<void> {
        if (this._state !== 'disconnected') {
            throw new Error(
                `RdbgClient.attach() requires state 'disconnected', current state: '${this._state}'`
            );
        }

        this._state = 'attaching';
        try {
            const body = codec.encodeAttachDebugUI(this.debugUiId, infobaseAlias);
            const responseText = await this.transport.send('attachDebugUI', body);
            this.emit('log', `[attachDebugUI] RESPONSE: ${responseText.slice(0, 300)}`);
            if (responseText.includes('ibInDebug')) {
                this.emit('log', 'WARNING: attachDebugUI returned ibInDebug — another debugger is already connected');
            }
            this._infobaseAlias = infobaseAlias;
            this._state = 'attached';
        } catch (err) {
            this._state = 'disconnected';
            throw err;
        }

        try {
            await this.initSettings(infobaseAlias);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.emit('log', `WARNING: initSettings failed (non-fatal): ${message}`);
        }

        try {
            await this.setAutoAttachSettings(infobaseAlias);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.emit('log', `WARNING: setAutoAttachSettings failed (non-fatal): ${message}`);
        }
    }

    async detach(): Promise<void> {
        if (this._state !== 'attached') {
            throw new Error(
                `RdbgClient.detach() requires state 'attached', current state: '${this._state}'`
            );
        }

        this._state = 'detaching';
        try {
            const body = codec.encodeDetachDebugUI(this.debugUiId, this._infobaseAlias);
            await this.transport.send('detachDebugUI', body);
        } catch {
            // swallow detach errors
        } finally {
            this._infobaseAlias = undefined;
            this._state = 'disconnected';
        }
    }

    async initSettings(infobaseAlias?: string): Promise<void> {
        this.requireAttached('initSettings');
        const body = codec.encodeInitSettings(this.debugUiId, infobaseAlias);
        await this.transport.send('initSettings', body);
    }

    async setAutoAttachSettings(infobaseAlias?: string): Promise<void> {
        this.requireAttached('setAutoAttachSettings');
        const body = codec.encodeSetAutoAttachSettings(this.debugUiId, infobaseAlias);
        await this.transport.send('setAutoAttachSettings', body);
    }

    // -----------------------------------------------------------------------
    // Targets
    // -----------------------------------------------------------------------

    async getTargets(): Promise<RdbgTargetInfo[]> {
        this.requireAttached('getTargets');
        const body = codec.encodeGetTargets(this.debugUiId, this._infobaseAlias);
        const xml = await this.transport.send('getDbgTargets', body);
        const targets = codec.decodeTargets(xml);
        for (const t of targets) {
            this._seanceMap.set(t.id, t.seanceId);
        }
        return targets;
    }

    async attachTargets(targets: RdbgTargetRef[]): Promise<void> {
        this.requireAttached('attachTargets');
        const body = codec.encodeAttachTargets(this.debugUiId, targets, true, this._infobaseAlias);
        this.emit('log', `[attachTargets] REQUEST: ${body.slice(0, 500)}`);
        const xml = await this.transport.send('attachDetachDbgTargets', body);
        this.emit('log', `[attachTargets] RESPONSE: ${xml.slice(0, 300)}`);
    }

    async detachTargets(targets: RdbgTargetRef[]): Promise<void> {
        this.requireAttached('detachTargets');
        const body = codec.encodeAttachTargets(this.debugUiId, targets, false, this._infobaseAlias);
        await this.transport.send('attachDetachDbgTargets', body);
    }

    // -----------------------------------------------------------------------
    // Breakpoints
    // -----------------------------------------------------------------------

    async setBreakpoints(bps: RdbgBreakpointRequest[]): Promise<RdbgBreakpoint[]> {
        this.requireAttached('setBreakpoints');
        const body = codec.encodeSetBreakpoints(this.debugUiId, bps, this._infobaseAlias);
        this.emit('log', `[setBreakpoints] REQUEST (${bps.length} bp): ${body.slice(0, 800)}`);
        const xml = await this.transport.send('setBreakpoints', body);
        this.emit('log', `[setBreakpoints] RESPONSE (${xml.length} bytes): ${xml.slice(0, 800)}`);
        // Server often returns 200 with empty body — breakpoints are still applied.
        if (!xml || xml.trim() === '') {
            const fallback = bps.map((bp) => ({
                moduleId: bp.moduleId,
                lineNo: bp.lineNo,
                enabled: true,
            }));
            this.emit('log', `[setBreakpoints] empty body — treating ${fallback.length} breakpoint(s) as confirmed`);
            return fallback;
        }
        const result = codec.decodeBreakpoints(xml);
        this.emit('log', `[setBreakpoints] DECODED: ${result.length} confirmed breakpoints`);
        return result;
    }

    async removeBreakpoints(bps: RdbgBreakpointRequest[]): Promise<void> {
        this.requireAttached('removeBreakpoints');
        // Reuse the set-breakpoints encoder; an empty list signals removal in the codec
        const body = codec.encodeSetBreakpoints(this.debugUiId, bps, this._infobaseAlias);
        await this.transport.send('setBreakpoints', body);
    }

    /**
     * Send the exception breakpoint (stop-on-RTE) state to the server.
     * Maps to the RDBG command `setBreakOnRTE` / RDBGSetRunTimeErrorProcessingRequest.
     * The server returns an empty body on success.
     */
    async setExceptionBreakpoints(state: RdbgExceptionBreakpointState): Promise<void> {
        this.requireAttached('setExceptionBreakpoints');
        const body = codec.encodeSetBreakOnRTE(this.debugUiId, state, this._infobaseAlias);
        this.emit('log', `[setExceptionBreakpoints] REQUEST: stopOnErrors=${state.stopOnErrors} analyzeErrorStr=${state.analyzeErrorStr ?? false} filters=${state.filters?.length ?? 0}`);
        await this.transport.send('setBreakOnRTE', body);
        this.emit('log', `[setExceptionBreakpoints] done`);
    }

    // -----------------------------------------------------------------------
    // Execution control
    // -----------------------------------------------------------------------

    async step(targetId: string, action: 'into' | 'over' | 'out'): Promise<void> {
        this.requireAttached('step');
        const seanceId = this._seanceMap.get(targetId) ?? '';
        const body = codec.encodeStep(this.debugUiId, targetId, seanceId, action, this._infobaseAlias);
        this.emit('log', `[step] action=${action} target=${targetId}`);
        await this.transport.send('step', body);
        this.emit('log', `[step] done`);
    }

    async continue(targetId: string): Promise<void> {
        this.requireAttached('continue');
        const seanceId = this._seanceMap.get(targetId) ?? '';
        const body = codec.encodeContinue(this.debugUiId, targetId, seanceId, this._infobaseAlias);
        this.emit('log', `[continue] target=${targetId}`);
        await this.transport.send('step', body);
        this.emit('log', `[continue] done`);
    }

    // -----------------------------------------------------------------------
    // Inspection
    // -----------------------------------------------------------------------

    async getCallStack(targetId: string): Promise<RdbgCallStackItem[]> {
        this.requireAttached('getCallStack');
        const seanceId = this._seanceMap.get(targetId) ?? '';
        const body = codec.encodeGetCallStack(this.debugUiId, targetId, seanceId, this._infobaseAlias);
        const xml = await this.transport.send('getCallStack', body);
        return codec.decodeCallStack(xml);
    }

    /**
     * Evaluate a path-based expression and return root result + direct children.
     * Phase 4: path-based drilldown into object properties and collection elements.
     */
    async evalExpressionPath(
        targetId: string,
        frameLevel: number,
        path: SourceCalcItem[],
        view: ViewInterface,
        options?: RdbgEvalOptions
    ): Promise<DecodedEvalResult> {
        this.requireAttached('evalExpressionPath');
        const body = codec.encodeEvalExpressionPath(
            this.debugUiId, targetId, frameLevel, path, view, this._infobaseAlias, options
        );
        const started = Date.now();
        const wait = options?.calcWaitingTimeMs ?? 5000;
        const expressionLabel = describeExpressionPath(path);
        this.emit('log', `[evalExpressionPath] purpose=${options?.purpose ?? 'unknown'} wait=${wait} path=${path.length} expr=${expressionLabel} view=${view} target=${targetId} frame=${frameLevel}`);
        const xml = await this.transport.send('evalExpr', body);
        this.emit('log', `[evalExpressionPath] purpose=${options?.purpose ?? 'unknown'} duration=${Date.now() - started}ms path=${path.length} expr=${expressionLabel}`);
        return codec.decodeEvalResultExpanded(xml);
    }

    /**
     * Get local variables at a specific stack frame.
     * Top-level locals are intentionally disabled: dbgs can terminate on both the
     * wire-level evalLocalVariables command and the empty-path evalExpr fallback.
     */
    async evalLocalVariables(targetId: string, frameLevel: number): Promise<RdbgVariableNode[]> {
        this.requireAttached('evalLocalVariables');
        this.emit('log', `[evalLocalVariables] skipped unsafe top-level locals target=${targetId} frame=${frameLevel}`);
        return [];
    }

    /**
     * Evaluate a single expression and return the result.
     * Signature preserved for backward compatibility — existing consumers unchanged.
     */
    async evaluate(
        targetId: string,
        expression: string,
        frameIndex: number,
        options?: RdbgEvalOptions
    ): Promise<RdbgEvalResult> {
        this.requireAttached('evaluate');
        const result = await this.evalExpressionPath(
            targetId,
            frameIndex,
            [{ type: 'expression', expression }],
            'context',
            options
        );
        return result.root;
    }

    /** @deprecated Use evalLocalVariables(). Kept for test backward compatibility. */
    async getLocalVariables(targetId: string, frameIndex: number): Promise<RdbgVariable[]> {
        const nodes = await this.evalLocalVariables(targetId, frameIndex);
        // Map RdbgVariableNode → legacy RdbgVariable shape
        return nodes.map(n => ({
            name: n.name,
            typeName: n.typeName,
            value: n.value,
            isExpandable: n.isExpandable,
            variableReference: 0,
        }));
    }

    // -----------------------------------------------------------------------
    // Polling
    // -----------------------------------------------------------------------

    startPolling(intervalMs: number): void {
        if (this._pollingTimer !== undefined) {
            return;
        }
        this._consecutiveFailures = 0;
        this._sessionLost = false;
        this._pollingTimer = setInterval(() => {
            void this._poll();
        }, intervalMs);
    }

    stopPolling(): void {
        if (this._pollingTimer !== undefined) {
            clearInterval(this._pollingTimer);
            this._pollingTimer = undefined;
        }
    }

    private _pollCount = 0;
    private async _poll(): Promise<void> {
        if (this._pollingTimer === undefined || this._sessionLost) {
            return;
        }
        if (this._pollInFlight) {
            return;
        }
        this._pollInFlight = true;
        try {
            const body = codec.encodePing(this.debugUiId);
            const xml = await this.transport.send('pingDebugUI', body);
            this._pollCount++;
            let events: RdbgEvent[];
            try {
                events = codec.decodePingEvents(xml);
            } catch (decodeErr) {
                const msg = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
                this.emit('log', `[poll #${this._pollCount}] decodePingEvents failed: ${msg}`);
                events = [];
            }

            if (events.length > 0 || (xml && xml.trim().length > 0)) {
                this.emit('log', `[poll #${this._pollCount}] events=${events.length} xmlLen=${xml.length} types=${events.map(e => e.type).join(',')}`);
                if (this._pollCount <= 5 && xml.length > 0) {
                    this.emit('log', `[poll #${this._pollCount}] RAW XML: ${xml.slice(0, 500)}`);
                }
            }
            if (this._pollCount % 30 === 1) {
                this.emit('log', `[poll #${this._pollCount}] alive, xmlLen=${xml.length}`);
            }

            for (const event of events) {
                this._emitTypedEvent(event);
            }

            // Periodic target discovery
            if (this._pollCount % this._targetDiscoveryInterval === 0 && this._state === 'attached') {
                try {
                    const knownBefore = new Set(this._seanceMap.keys());
                    const targets = await this.getTargets();
                    for (const t of targets) {
                        if (!knownBefore.has(t.id)) {
                            this.emit('targetStarted', { type: 'targetStarted', target: t });
                        }
                    }
                } catch {
                    // non-fatal — target discovery is best-effort
                }
            }

            this._consecutiveFailures = 0;
        } catch (err) {
            this._consecutiveFailures++;
            const message = err instanceof Error ? err.message : String(err);
            const max = RdbgClient._maxPollFailures;
            if (this._consecutiveFailures < max) {
                this.emit('log', `[poll] transient failure ${this._consecutiveFailures}/${max}: ${message}`);
                console.warn(`[RdbgClient] Poll warning (${this._consecutiveFailures}/${max}): ${message}`);
            } else if (!this._sessionLost) {
                this._sessionLost = true;
                this.stopPolling();
                const lostErr = new Error(
                    `Lost connection to RDBG server after ${this._consecutiveFailures} consecutive ping failures. Last error: ${message}`
                );
                this.emit('error', lostErr);
            }
        } finally {
            this._pollInFlight = false;
        }
    }

    private _emitTypedEvent(event: RdbgEvent): void {
        switch (event.type) {
            case 'stopped':
                this.emit('stopped', event);
                break;
            case 'continued':
                this.emit('continued', event);
                break;
            case 'targetStarted':
                this._seanceMap.set(event.target.id, event.target.seanceId);
                this.emit('targetStarted', event);
                break;
            case 'targetQuit':
                this._seanceMap.delete(event.targetId);
                this.emit('targetQuit', event);
                break;
            case 'runtimeError':
                this.emit('runtimeError', event);
                break;
            case 'breakpointCorrected':
                this.emit('breakpointCorrected', event);
                break;
            case 'expressionEvaluated':
                this.emit('expressionEvaluated', event);
                break;
        }
    }

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    dispose(): void {
        this.stopPolling();
        this.transport.dispose();
    }
}
