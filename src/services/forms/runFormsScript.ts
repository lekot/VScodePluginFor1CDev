// src/services/forms/runFormsScript.ts
// Обёртка spawn node resources/web-test/run.mjs.
// Использует NODE_PATH → node_modules в extensionPath (playwright уже в deps расширения).

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type * as vscode from 'vscode';
import { terminateChildProcess } from './processLifecycle';

const DEFAULT_TIMEOUT_MS = 30_000;
const RING_BUFFER_MAX_BYTES = 256 * 1024;
const TIMEOUT_TERM_WAIT_MS = 1_000;
const TIMEOUT_KILL_WAIT_MS = 1_000;
const CANCEL_TERM_WAIT_MS = 1_000;
const CANCEL_KILL_WAIT_MS = 1_000;

export interface RunFormsOptions {
    /** Корень расширения (extensionContext.extensionPath). */
    extensionPath: string;
    /** Per-extension-host session descriptor outside the extension installation. */
    sessionFilePath: string;
    /** Команда run.mjs: start | exec | stop | shot | status | run. */
    command: string;
    /** Дополнительные аргументы после команды. */
    args: string[];
    /** Данные для stdin (для exec). */
    stdin?: string;
    /** Таймаут в мс (default 30000). */
    timeoutMs?: number;
    /** Cancellation token for a foreground forms command process. */
    token?: vscode.CancellationToken;
    /**
     * Если задан — функция-предикат по накопленному stdout.
     * При первом возврате true промис резолвится, процесс ОТКРЕПЛЯЕТСЯ и живёт в фоне
     * (run.mjs start вешает HTTP-сервер и не завершается сам). Вызывающая сторона
     * получает proc в result.proc для хранения PID в FormsContext, чтобы потом убить.
     */
    detachOnReady?: (stdout: string) => boolean;
}

export interface RunFormsResult {
    output: string;
    stderr: string;
    exitCode: number;
    /** Заполняется только если detachOnReady сработал — процесс ещё жив. */
    detachedProc?: import('child_process').ChildProcess;
    /** Timed-out child that survived TERM→KILL. The caller must retain ownership and retry cleanup. */
    unclosedProc?: import('child_process').ChildProcess;
    /** Cancellation was requested while the runner process was active. */
    cancelled?: boolean;
    /** The process may have performed effects before it settled. */
    effectPossible?: boolean;
    /** The command timed out after process startup. */
    timedOut?: boolean;
}

/**
 * Запускает run.mjs с заданной командой и аргументами.
 * Playwright разрешается через NODE_PATH → extensionPath/node_modules
 * (playwright задекларирован в dependencies расширения, не нужен отдельный npm install).
 */
export async function runFormsScript(opts: RunFormsOptions): Promise<RunFormsResult> {
    if (opts.token?.isCancellationRequested) {
        return { output: '', stderr: '', exitCode: -2, cancelled: true, effectPossible: false };
    }
    const scriptPath = path.join(opts.extensionPath, 'resources', 'web-test', 'run.mjs');

    if (!fs.existsSync(scriptPath)) {
        throw new Error(`run.mjs не найден: ${scriptPath}`);
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const nodeModulesPath = path.join(opts.extensionPath, 'node_modules');
    await fs.promises.mkdir(path.dirname(opts.sessionFilePath), { recursive: true });
    if (opts.token?.isCancellationRequested) {
        return { output: '', stderr: '', exitCode: -2, cancelled: true, effectPossible: false };
    }

    return new Promise<RunFormsResult>((resolve, reject) => {
        let outBuf: Buffer = Buffer.alloc(0);
        let errBuf: Buffer = Buffer.alloc(0);
        let outTruncated = false;
        let errTruncated = false;
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let stopping = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const cancellationHolder: { value: vscode.Disposable | undefined } = { value: undefined };
        let termination: Promise<void> | undefined;

        const appendRing = (
            chunk: Buffer | string,
            buf: Buffer,
            truncated: boolean,
        ): [Buffer, boolean] => {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
            const combined = Buffer.concat([buf, bytes]);
            if (combined.length <= RING_BUFFER_MAX_BYTES) {
                return [combined, truncated];
            }
            let start = combined.length - RING_BUFFER_MAX_BYTES;
            while (start < combined.length && (combined[start] & 0xc0) === 0x80) {
                start += 1;
            }
            return [Buffer.from(combined.subarray(start)), true];
        };

        const finish = (code: number, unclosedProc?: import('child_process').ChildProcess) => {
            if (settled) { return; }
            settled = true;
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
                timeoutHandle = undefined;
            }
            cancellationHolder.value?.dispose();
            resolve({
                output: outBuf.toString('utf8'),
                stderr: `${errBuf.toString('utf8')}${timedOut ? '\n[timeout]' : cancelled ? '\n[cancelled]' : ''}${unclosedProc ? '\n[process did not exit]' : ''}`,
                exitCode: timedOut ? 124 : code,
                effectPossible: true,
                ...(cancelled ? { cancelled: true } : {}),
                ...(timedOut ? { timedOut: true } : {}),
                ...(unclosedProc ? { unclosedProc } : {}),
            });
        };

        const proc = spawn(process.execPath, [scriptPath, opts.command, ...opts.args], {
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                // Позволяет ESM run.mjs / browser.mjs использовать playwright
                // из node_modules расширения без отдельного npm install в web-test
                NODE_PATH: nodeModulesPath,
                CDT_FORMS_SESSION_FILE: opts.sessionFilePath,
            },
        });

        proc.stdout?.on('data', (chunk: Buffer | string) => {
            [outBuf, outTruncated] = appendRing(chunk, outBuf, outTruncated);
            if (!settled && opts.detachOnReady && opts.detachOnReady(outBuf.toString('utf8'))) {
                settled = true;
                if (timeoutHandle !== undefined) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = undefined;
                }
                cancellationHolder.value?.dispose();
                // Keep draining bounded buffers. Removing listeners can fill the
                // child pipes and block the long-lived HTTP server.
                proc.unref();
                resolve({
                    output: outBuf.toString('utf8'),
                    stderr: errBuf.toString('utf8'),
                    exitCode: 0,
                    detachedProc: proc,
                    effectPossible: true,
                });
            }
        });

        proc.stderr?.on('data', (chunk: Buffer | string) => {
            [errBuf, errTruncated] = appendRing(chunk, errBuf, errTruncated);
        });

        const stop = (reason: 'cancelled' | 'timedOut'): void => {
            if (settled || stopping) { return; }
            stopping = true;
            cancelled = reason === 'cancelled';
            timedOut = reason === 'timedOut';
            termination = terminateChildProcess(
                proc,
                'forms runner',
                reason === 'cancelled' ? CANCEL_TERM_WAIT_MS : TIMEOUT_TERM_WAIT_MS,
                reason === 'cancelled' ? CANCEL_KILL_WAIT_MS : TIMEOUT_KILL_WAIT_MS,
            ).then(
                () => finish(reason === 'cancelled' ? -2 : 124),
                () => {
                    proc.unref();
                    finish(reason === 'cancelled' ? -2 : 124, proc);
                },
            );
            void termination;
        };

        cancellationHolder.value = opts.token?.onCancellationRequested(() => stop('cancelled'));
        if (opts.token?.isCancellationRequested) { stop('cancelled'); }

        proc.on('error', (err) => {
            if (!settled && !stopping) {
                settled = true;
                if (timeoutHandle !== undefined) { clearTimeout(timeoutHandle); }
                cancellationHolder.value?.dispose();
                reject(err);
            }
        });

        proc.on('close', (code) => {
            finish(code ?? 1);
        });

        timeoutHandle = setTimeout(() => {
            timeoutHandle = undefined;
            stop('timedOut');
        }, timeoutMs);

        // Если нужно передать stdin (exec -)
        if (opts.stdin !== undefined) {
            proc.stdin?.write(opts.stdin, 'utf8');
            proc.stdin?.end();
        } else {
            proc.stdin?.end();
        }

        // Подавляем предупреждение компилятора про неиспользуемые переменные truncated
        void outTruncated;
        void errTruncated;
    });
}
