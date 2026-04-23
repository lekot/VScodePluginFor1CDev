// src/services/forms/runFormsScript.ts
// Обёртка spawn node resources/web-test/run.mjs.
// Использует NODE_PATH → node_modules в extensionPath (playwright уже в deps расширения).

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const RING_BUFFER_MAX_BYTES = 256 * 1024;

export interface RunFormsOptions {
    /** Корень расширения (extensionContext.extensionPath). */
    extensionPath: string;
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

    return new Promise<RunFormsResult>((resolve, reject) => {
        let outBuf = '';
        let errBuf = '';
        let outTruncated = false;
        let errTruncated = false;
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const appendRing = (
            s: string,
            buf: string,
            truncated: boolean,
        ): [string, boolean] => {
            buf += s;
            if (buf.length > RING_BUFFER_MAX_BYTES) {
                truncated = true;
                buf = buf.slice(buf.length - RING_BUFFER_MAX_BYTES);
            }
            return [buf, truncated];
        };

        const finish = (code: number) => {
            if (settled) { return; }
            settled = true;
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
                timeoutHandle = undefined;
            }
            resolve({ output: outBuf, stderr: errBuf, exitCode: code });
        };

        const proc = spawn(process.execPath, [scriptPath, opts.command, ...opts.args], {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                // Позволяет ESM run.mjs / browser.mjs использовать playwright
                // из node_modules расширения без отдельного npm install в web-test
                NODE_PATH: nodeModulesPath,
            },
        });

        proc.stdout?.on('data', (chunk: Buffer | string) => {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            [outBuf, outTruncated] = appendRing(text, outBuf, outTruncated);
            if (!settled && opts.detachOnReady && opts.detachOnReady(outBuf)) {
                settled = true;
                if (timeoutHandle !== undefined) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = undefined;
                }
                // Отцепляем процесс — он продолжит работать как HTTP-сервер.
                // stdout/stderr больше не читаем (иначе backpressure → SIGPIPE).
                proc.stdout?.removeAllListeners('data');
                proc.stderr?.removeAllListeners('data');
                proc.unref();
                resolve({ output: outBuf, stderr: errBuf, exitCode: 0, detachedProc: proc });
            }
        });

        proc.stderr?.on('data', (chunk: Buffer | string) => {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            [errBuf, errTruncated] = appendRing(text, errBuf, errTruncated);
        });

        proc.on('error', (err) => {
            if (!settled) {
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
                settled = true;
                try { proc.kill('SIGTERM'); } catch { /* ignore */ }
                resolve({ output: outBuf, stderr: errBuf + '\n[timeout]', exitCode: 124 });
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
