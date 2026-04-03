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
import {
    RdbgTargetInfo,
    RdbgBreakpointRequest,
    RdbgBreakpoint,
    RdbgCallStackItem,
    RdbgVariable,
    RdbgEvalResult,
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

    emit(event: 'stopped', e: RdbgStoppedEvent): boolean;
    emit(event: 'continued', e: RdbgContinuedEvent): boolean;
    emit(event: 'targetStarted', e: RdbgTargetStartedEvent): boolean;
    emit(event: 'targetQuit', e: RdbgTargetQuitEvent): boolean;
    emit(event: 'runtimeError', e: RdbgRuntimeErrorEvent): boolean;
    emit(event: 'breakpointCorrected', e: RdbgBreakpointCorrectedEvent): boolean;
    emit(event: 'expressionEvaluated', e: RdbgExpressionEvaluatedEvent): boolean;
    emit(event: 'error', err: Error): boolean;
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
    private _consecutiveFailures = 0;

    constructor(transport: RdbgTransport, debugUiId: string) {
        super();
        this.transport = transport;
        this.debugUiId = debugUiId;
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
            await this.transport.send('attachDebugUI', body);
            this._infobaseAlias = infobaseAlias;
            this._state = 'attached';
        } catch (err) {
            this._state = 'disconnected';
            throw err;
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

    // -----------------------------------------------------------------------
    // Targets
    // -----------------------------------------------------------------------

    async getTargets(): Promise<RdbgTargetInfo[]> {
        this.requireAttached('getTargets');
        const body = codec.encodeGetTargets(this.debugUiId, this._infobaseAlias);
        const xml = await this.transport.send('getDbgTargets', body);
        return codec.decodeTargets(xml);
    }

    async attachTargets(targetIds: string[]): Promise<void> {
        this.requireAttached('attachTargets');
        const body = codec.encodeAttachTargets(this.debugUiId, targetIds, true, this._infobaseAlias);
        await this.transport.send('attachDbgTargetsRequest', body);
    }

    async detachTargets(targetIds: string[]): Promise<void> {
        this.requireAttached('detachTargets');
        const body = codec.encodeAttachTargets(this.debugUiId, targetIds, false, this._infobaseAlias);
        await this.transport.send('detachDbgTargetsRequest', body);
    }

    // -----------------------------------------------------------------------
    // Breakpoints
    // -----------------------------------------------------------------------

    async setBreakpoints(bps: RdbgBreakpointRequest[]): Promise<RdbgBreakpoint[]> {
        this.requireAttached('setBreakpoints');
        const body = codec.encodeSetBreakpoints(this.debugUiId, bps, this._infobaseAlias);
        const xml = await this.transport.send('setBreakpoints', body);
        return codec.decodeBreakpoints(xml);
    }

    async removeBreakpoints(bps: RdbgBreakpointRequest[]): Promise<void> {
        this.requireAttached('removeBreakpoints');
        // Reuse the set-breakpoints encoder; an empty list signals removal in the codec
        const body = codec.encodeSetBreakpoints(this.debugUiId, bps, this._infobaseAlias);
        await this.transport.send('setBreakpoints', body);
    }

    // -----------------------------------------------------------------------
    // Execution control
    // -----------------------------------------------------------------------

    async step(targetId: string, action: 'into' | 'over' | 'out'): Promise<void> {
        this.requireAttached('step');
        const body = codec.encodeStep(this.debugUiId, targetId, action, this._infobaseAlias);
        await this.transport.send('stepRequest', body);
    }

    async continue(targetId: string): Promise<void> {
        this.requireAttached('continue');
        const body = codec.encodeContinue(this.debugUiId, targetId, this._infobaseAlias);
        await this.transport.send('continueRequest', body);
    }

    // -----------------------------------------------------------------------
    // Inspection
    // -----------------------------------------------------------------------

    async getCallStack(targetId: string): Promise<RdbgCallStackItem[]> {
        this.requireAttached('getCallStack');
        const body = codec.encodeGetCallStack(this.debugUiId, targetId, this._infobaseAlias);
        const xml = await this.transport.send('getCallStackRequest', body);
        return codec.decodeCallStack(xml);
    }

    async getLocalVariables(targetId: string, frameIndex: number): Promise<RdbgVariable[]> {
        this.requireAttached('getLocalVariables');
        const body = codec.encodeEvalLocalVariables(this.debugUiId, targetId, frameIndex, this._infobaseAlias);
        const xml = await this.transport.send('evalLocalVariablesRequest', body);
        return codec.decodeVariables(xml);
    }

    async evaluate(
        targetId: string,
        expression: string,
        frameIndex: number
    ): Promise<RdbgEvalResult> {
        this.requireAttached('evaluate');
        const body = codec.encodeEvaluate(this.debugUiId, targetId, expression, frameIndex, this._infobaseAlias);
        const xml = await this.transport.send('evaluateRequest', body);
        return codec.decodeEvalResult(xml);
    }

    // -----------------------------------------------------------------------
    // Polling
    // -----------------------------------------------------------------------

    startPolling(intervalMs: number): void {
        if (this._pollingTimer !== undefined) {
            return;
        }
        this._consecutiveFailures = 0;
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

    private async _poll(): Promise<void> {
        try {
            const body = codec.encodePing(this.debugUiId);
            const xml = await this.transport.send('pingDebugUI', body);
            const events = codec.decodePingEvents(xml);

            for (const event of events) {
                this._emitTypedEvent(event);
            }

            this._consecutiveFailures = 0;
        } catch (err) {
            this._consecutiveFailures++;
            if (this._consecutiveFailures < 3) {
                // Non-fatal — log and continue polling
                const message = err instanceof Error ? err.message : String(err);
                console.warn(`[RdbgClient] Poll warning (failure ${this._consecutiveFailures}/3): ${message}`);
            } else {
                this.stopPolling();
                const lostErr = new Error(
                    `Lost connection to RDBG server after ${this._consecutiveFailures} consecutive failures`
                );
                this.emit('error', lostErr);
            }
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
                this.emit('targetStarted', event);
                break;
            case 'targetQuit':
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
