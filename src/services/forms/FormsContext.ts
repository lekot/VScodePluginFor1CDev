// src/services/forms/FormsContext.ts
// Extension-scoped owner for ibsrv and browser processes.
// Browser session descriptors live in the configured extension storage path.

import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stopIbsrv } from './FormsIbsrvLauncher';
import {
    isChildProcessTerminated,
    terminateChildProcess,
    waitForChildProcessExit,
} from './processLifecycle';

export interface FormsStopOutcome {
    errors: string[];
}

const BROWSER_GRACEFUL_WAIT_MS = 2_000;
const BROWSER_KILL_WAIT_MS = 1_500;

export class FormsContext {
    private static _instance: FormsContext | undefined;

    static get(): FormsContext {
        if (!FormsContext._instance) {
            FormsContext._instance = new FormsContext();
        }
        return FormsContext._instance;
    }

    private storagePath = path.join(os.tmpdir(), 'cdt41-forms');
    private lifecycleQueue: Promise<void> = Promise.resolve();
    private browserCleanup?: () => Promise<void>;
    private readonly transientProcesses = new Map<ChildProcess, string>();

    configureStoragePath(storagePath: string): void {
        this.storagePath = storagePath;
    }

    get sessionFilePath(): string {
        return path.join(this.storagePath, `browser-session-${process.pid}.json`);
    }

    runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.lifecycleQueue.then(operation, operation);
        this.lifecycleQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    // ─── ibsrv state ─────────────────────────────────────────────────────────

    ibsrvProc?: ChildProcess;
    ibsrvPort?: number;
    ibsrvDbPath?: string;
    ibsrvDataDir?: string;

    /** Флаг готовности node_modules в resources/web-test (либо NODE_PATH уже задан). */
    webTestDepsReady = false;

    setIbsrv(proc: ChildProcess, port: number, dbPath: string, dataDir: string): void {
        if (this.ibsrvProc && this.isIbsrvAlive()) {
            throw new Error('Forms ibsrv process is already owned by this context.');
        }
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
        return !isChildProcessTerminated(this.ibsrvProc);
    }

    // ─── browser (run.mjs start) state ───────────────────────────────────────

    /** ChildProcess детача run.mjs start (HTTP-сервер для exec/shot/stop). */
    browserProc?: ChildProcess;

    setBrowserProc(proc: ChildProcess | undefined, cleanup: () => Promise<void>): void {
        if (this.browserCleanup || (this.browserProc && this.isBrowserAlive())) {
            throw new Error('Forms browser process is already owned by this context.');
        }
        this.browserProc = proc;
        this.browserCleanup = cleanup;
    }

    clearBrowserProc(): void {
        this.browserProc = undefined;
        this.browserCleanup = undefined;
    }

    isBrowserAlive(): boolean {
        if (!this.browserProc) {
            return false;
        }
        return !isChildProcessTerminated(this.browserProc);
    }

    /** Retains a short-lived runner that survived its command timeout. */
    adoptTransientProcess(proc: ChildProcess, resource: string): void {
        if (isChildProcessTerminated(proc)) {
            return;
        }
        this.transientProcesses.set(proc, resource);
    }

    /** Test/diagnostic view; ownership is released only after proven exit. */
    ownsTransientProcess(proc: ChildProcess): boolean {
        return this.transientProcesses.has(proc);
    }

    /** Stops all owned resources in reverse acquisition order and always attempts every step. */
    async stop(): Promise<FormsStopOutcome> {
        const errors: string[] = [];
        const browserCleanup = this.browserCleanup;
        const browserProc = this.browserProc;

        let browserCleanupSucceeded = false;
        if (browserCleanup) {
            try {
                await browserCleanup();
                browserCleanupSucceeded = true;
            } catch (err) {
                errors.push(`browser cleanup: ${toErrorMessage(err)}`);
            }
        }
        let browserExited = !browserProc || isChildProcessTerminated(browserProc);
        if (browserProc && !browserExited && browserCleanupSucceeded) {
            browserExited = await waitForChildProcessExit(browserProc, BROWSER_GRACEFUL_WAIT_MS);
        }
        if (browserProc && !browserExited) {
            try {
                await terminateChildProcess(
                    browserProc,
                    'browser',
                    BROWSER_KILL_WAIT_MS,
                    BROWSER_KILL_WAIT_MS,
                );
                browserExited = true;
            } catch (error) {
                errors.push(`browser process: ${toErrorMessage(error)}`);
            }
        }
        if (browserExited) {
            this.clearBrowserProc();
            await fs.promises.rm(this.sessionFilePath, { force: true }).catch((err: unknown) => {
                errors.push(`browser session: ${toErrorMessage(err)}`);
            });
        } else if (browserProc) {
            errors.push(`browser process ${browserProc.pid ?? 'unknown'} did not exit after graceful and hard shutdown`);
            // Keep ownership so another stop/dispose attempt can retry and report it.
            this.browserProc = browserProc;
            this.browserCleanup = browserCleanup;
        } else {
            this.clearBrowserProc();
            await fs.promises.rm(this.sessionFilePath, { force: true }).catch((err: unknown) => {
                errors.push(`browser session: ${toErrorMessage(err)}`);
            });
        }

        // A browser cleanup command can itself time out and register a runner
        // here, so drain transient processes after the browser cleanup attempt.
        const transientEntries = [...this.transientProcesses.entries()].reverse();
        for (const [proc, resource] of transientEntries) {
            if (isChildProcessTerminated(proc)) {
                this.transientProcesses.delete(proc);
                continue;
            }
            try {
                await terminateChildProcess(
                    proc,
                    resource,
                    BROWSER_KILL_WAIT_MS,
                    BROWSER_KILL_WAIT_MS,
                );
                this.transientProcesses.delete(proc);
            } catch (error) {
                errors.push(`${resource} process: ${toErrorMessage(error)}`);
                // Keep ownership for the next stop/dispose attempt.
            }
        }

        const ibsrvProc = this.ibsrvProc;
        const ibsrvDataDir = this.ibsrvDataDir;
        let ibsrvExited = !ibsrvProc || isChildProcessTerminated(ibsrvProc);
        if (ibsrvProc) {
            try {
                await stopIbsrv(ibsrvProc);
                ibsrvExited = true;
            } catch (err) {
                errors.push(`ibsrv process: ${toErrorMessage(err)}`);
            }
        }
        if (ibsrvExited) {
            this.clearIbsrv();
        }
        if (ibsrvExited && ibsrvDataDir) {
            await fs.promises.rm(ibsrvDataDir, { recursive: true, force: true }).catch((err: unknown) => {
                errors.push(`ibsrv data: ${toErrorMessage(err)}`);
            });
        }

        return { errors };
    }

    async dispose(): Promise<void> {
        const outcome = await this.runExclusive(() => this.stop());
        if (outcome.errors.length > 0) {
            throw new Error(`Forms cleanup failed: ${outcome.errors.join('; ')}`);
        }
    }
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
