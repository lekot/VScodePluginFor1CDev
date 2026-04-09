// src/agent/debugSessionRegistry.ts
// Реестр активных отладочных сессий 1С.
// Хранит сессии VS Code Debug API и последние события остановки.

import * as vscode from 'vscode';

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Информация о последней остановке отладчика в сессии. */
export interface LastStop {
    /** Причина остановки: 'breakpoint', 'step', 'exception' и др. */
    reason: string;
    /** Идентификатор потока. */
    threadId: number;
    /** Метка времени получения события (Date.now()). */
    receivedAt: number;
}

/** Запись о сессии в реестре. */
export interface SessionEntry {
    /** Объект сессии VS Code. */
    session: vscode.DebugSession;
    /** Последняя зафиксированная остановка (undefined если сессия не останавливалась). */
    lastStop?: LastStop;
    /** Ожидающие колбэки остановки (для debugWaitForStop). */
    waiters: Array<(stop: LastStop) => void>;
}

// ─── DebugSessionRegistry ────────────────────────────────────────────────────

/** Реестр активных отладочных сессий. Инстанциируется в extension.ts. */
export class DebugSessionRegistry {
    private _sessions = new Map<string, SessionEntry>();
    private _disposables: vscode.Disposable[] = [];

    /**
     * Активирует реестр — подписывается на события VS Code Debug API.
     * Идемпотентен: повторный вызов ничего не делает.
     */
    activate(context: vscode.ExtensionContext): void {
        if (this._disposables.length > 0) {
            return;
        }

        const startSub = vscode.debug.onDidStartDebugSession((session) => {
            if (session.type === 'bsl') {
                this._sessions.set(session.id, { session, waiters: [] });
            }
        });

        const terminateSub = vscode.debug.onDidTerminateDebugSession((session) => {
            const entry = this._sessions.get(session.id);
            if (entry) {
                const waiters = entry.waiters.splice(0);
                waiters.forEach(w => w({ reason: 'terminated', threadId: -1, receivedAt: Date.now() }));
            }
            this._sessions.delete(session.id);
        });

        const trackerSub = vscode.debug.registerDebugAdapterTrackerFactory('bsl', {
            createDebugAdapterTracker: (session) => ({
                onDidSendMessage: (msg: unknown) => {
                    const m = msg as Record<string, unknown> | null | undefined;
                    if (m?.type === 'event' && m?.event === 'stopped') {
                        const entry = this._sessions.get(session.id);
                        if (!entry) { return; }
                        const body = m.body as Record<string, unknown> | undefined;
                        const stop = {
                            reason: (body?.reason as string | undefined) ?? 'unknown',
                            threadId: (body?.threadId as number | undefined) ?? 1,
                            receivedAt: Date.now(),
                        };
                        entry.lastStop = stop;
                        // NOTE: waiters не резолвятся здесь — это P7a-4
                    }
                },
            }),
        });

        this._disposables.push(startSub, terminateSub, trackerSub);
        context.subscriptions.push(startSub, terminateSub, trackerSub);
    }

    /**
     * Возвращает запись сессии по идентификатору.
     */
    get(sessionId: string): SessionEntry | undefined {
        return this._sessions.get(sessionId);
    }

    /**
     * Возвращает массив всех активных сессий.
     */
    list(): vscode.DebugSession[] {
        return Array.from(this._sessions.values()).map(e => e.session);
    }

    /**
     * Освобождает все подписки реестра.
     */
    dispose(): void {
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }
}
