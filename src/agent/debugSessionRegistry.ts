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
     * TODO: реализовать в P7a-2.
     */
    activate(_context: vscode.ExtensionContext): void {
        // TODO P7a-2: подписки на vscode.debug.onDidStartDebugSession,
        // onDidTerminateDebugSession, onDidReceiveDebugSessionCustomEvent
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
