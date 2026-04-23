// src/services/forms/FormsContext.ts
// Singleton — хранит состояние ibsrv-процесса на стороне TS.
// Browser-state (порт сервера run.mjs) живёт в resources/web-test/.browser-session.json.

import type { ChildProcess } from 'child_process';

export class FormsContext {
    private static _instance: FormsContext | undefined;

    static get(): FormsContext {
        if (!FormsContext._instance) {
            FormsContext._instance = new FormsContext();
        }
        return FormsContext._instance;
    }

    // ─── ibsrv state ─────────────────────────────────────────────────────────

    ibsrvProc?: ChildProcess;
    ibsrvPort?: number;
    ibsrvDbPath?: string;
    ibsrvDataDir?: string;

    /** Флаг готовности node_modules в resources/web-test (либо NODE_PATH уже задан). */
    webTestDepsReady = false;

    setIbsrv(proc: ChildProcess, port: number, dbPath: string, dataDir: string): void {
        this.ibsrvProc = proc;
        this.ibsrvPort = port;
        this.ibsrvDbPath = dbPath;
        this.ibsrvDataDir = dataDir;
    }

    clearIbsrv(): void {
        this.ibsrvProc = undefined;
        this.ibsrvPort = undefined;
        this.ibsrvDbPath = undefined;
        this.ibsrvDataDir = undefined;
    }

    /** Проверяет, жив ли ibsrv-процесс (kill -0 аналог: exitCode === null). */
    isIbsrvAlive(): boolean {
        if (!this.ibsrvProc) {
            return false;
        }
        // exitCode !== null — процесс уже завершился
        // killed — процесс был убит через .kill()
        return this.ibsrvProc.exitCode === null && !this.ibsrvProc.killed;
    }

    // ─── browser (run.mjs start) state ───────────────────────────────────────

    /** ChildProcess детача run.mjs start (HTTP-сервер для exec/shot/stop). */
    browserProc?: ChildProcess;

    setBrowserProc(proc: ChildProcess): void {
        this.browserProc = proc;
    }

    clearBrowserProc(): void {
        this.browserProc = undefined;
    }

    isBrowserAlive(): boolean {
        if (!this.browserProc) {
            return false;
        }
        return this.browserProc.exitCode === null && !this.browserProc.killed;
    }
}
