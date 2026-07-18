// src/services/forms/runFormsScript.ts
// Обёртка spawn node resources/web-test/run.mjs.
// Использует NODE_PATH → node_modules в extensionPath (playwright уже в deps расширения).

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { terminateChildProcess } from './processLifecycle';

const DEFAULT_TIMEOUT_MS = 30_000;
const RING_BUFFER_MAX_BYTES = 256 * 1024;
const TIMEOUT_TERM_WAIT_MS = 1_000;
const TIMEOUT_KILL_WAIT_MS = 1_000;

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
}

/**
 * Запускает run.mjs с заданной командой и аргументами.
 * Playwright разрешается через NODE_PATH → extensionPath/node_modules
 * (playwright задекларирован в dependencies расширения, не нужен отдельный npm install).
 */
export async function runFormsScript(opts: RunFormsOptions): Promise<RunFormsResult> {
    const scriptPath = path.join(opts.extensionPath, 'resources', 'web-test', 'run.mjs');

    if (!fs.existsSync(scriptPath)) {
        throw new Error(`run.mjs не найден: ${scriptPath}`);
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const nodeModulesPath = path.join(opts.extensionPath, 'node_modules');
    await fs.promises.mkdir(path.dirname(opts.sessionFilePath), { recursive: true });

    return new Promise<RunFormsResult>((resolve, reject) => {
        let outBuf: Buffer = Buffer.alloc(0);
        let errBuf: Buffer = Buffer.alloc(0);
        let outTruncated = false;
        let errTruncated = false;
        let settled = false;
        let timedOut = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

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

        const finish = (code: number) => {
            if (settled || timedOut) { return; }
            settled = true;
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
                timeoutHandle = undefined;
            }
            resolve({ output: outBuf.toString('utf8'), stderr: errBuf.toString('utf8'), exitCode: code });
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
                // Keep draining bounded buffers. Removing listeners can fill the
                // child pipes and block the long-lived HTTP server.
                proc.unref();
                resolve({
                    output: outBuf.toString('utf8'),
                    stderr: errBuf.toString('utf8'),
                    exitCode: 0,
                    detachedProc: proc,
                });
            }
        });

        proc.stderr?.on('data', (chunk: Buffer | string) => {
            [errBuf, errTruncated] = appendRing(chunk, errBuf, errTruncated);
        });

        proc.on('error', (err) => {
            if (!settled && !timedOut) {
                settled = true;
                if (timeoutHandle !== undefined) { clearTimeout(timeoutHandle); }
                reject(err);
            }
        });

        proc.on('close', (code) => {
            finish(code ?? 1);
        });

        timeoutHandle = setTimeout(() => {
            if (!settled) {
                timedOut = true;
                timeoutHandle = undefined;
                void terminateChildProcess(
                    proc,
                    'forms runner',
                    TIMEOUT_TERM_WAIT_MS,
                    TIMEOUT_KILL_WAIT_MS,
                ).then(
                    () => {
                        settled = true;
                        resolve({
                            output: outBuf.toString('utf8'),
                            stderr: `${errBuf.toString('utf8')}\n[timeout]`,
                            exitCode: 124,
                        });
                    },
                    () => {
                        settled = true;
                        proc.unref();
                        resolve({
                            output: outBuf.toString('utf8'),
                            stderr: `${errBuf.toString('utf8')}\n[timeout: process did not exit]`,
                            exitCode: 124,
                            unclosedProc: proc,
                        });
                    },
                );
            }
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
