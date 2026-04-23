// src/services/forms/FormsIbsrvLauncher.ts
// Запускает/останавливает ibsrv для forms-сессии (без отладки).

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { getFreePort } from '../../debug/debuggeeLauncher';

const IBSRV_POLL_INTERVAL_MS = 500;
const IBSRV_DEFAULT_READY_TIMEOUT_MS = 30_000;
const IBSRV_KILL_WAIT_MS = 1_500;

export interface IbsrvStartOptions {
    /** Каталог bin платформы (содержит ibsrv.exe / ibsrv). */
    platformPath: string;
    /** Путь к файловой ИБ. */
    dbPath: string;
    /** HTTP-порт ibsrv. Если не задан — getFreePort(). */
    httpPort?: number;
    /** Таймаут readiness в мс (default 30000). */
    readyTimeoutMs?: number;
}

export interface IbsrvStartResult {
    /** http://localhost:<port>/ */
    url: string;
    port: number;
    proc: ChildProcess;
    /** Временный каталог --data. */
    dataDir: string;
}

/**
 * Запускает ibsrv и ждёт, пока он начнёт отвечать на HTTP-запросы.
 * Возвращает url, port, proc и dataDir.
 * Выбрасывает ошибку если ibsrv не найден, не стартует или не готов к readyTimeoutMs.
 */
export async function startIbsrv(
    opts: IbsrvStartOptions,
    outputChannel: vscode.OutputChannel,
): Promise<IbsrvStartResult> {
    const ibsrvName = process.platform === 'win32' ? 'ibsrv.exe' : 'ibsrv';
    const ibsrvExe = path.join(opts.platformPath, ibsrvName);

    if (!fs.existsSync(ibsrvExe)) {
        throw new Error(
            `ibsrv не найден: ${ibsrvExe}. ` +
            `Убедитесь, что platformPath указывает на каталог с исполняемыми файлами платформы 1С.`,
        );
    }

    const port = opts.httpPort ?? await getFreePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), '1c-ibsrv-'));
    const readyTimeoutMs = opts.readyTimeoutMs ?? IBSRV_DEFAULT_READY_TIMEOUT_MS;

    const args = [
        `--database-path=${opts.dbPath}`,
        `--http-port=${port}`,
        '--http-address=localhost',
        '--enable-http-gate',
        '--disable-direct-gate',
        '--disable-ssh-gate',
        `--data=${dataDir}`,
    ];

    outputChannel.appendLine(`[FormsIbsrv] Запуск: ${ibsrvExe} ${args.join(' ')}`);

    const proc = spawn(ibsrvExe, args, {
        detached: false,
        stdio: 'pipe',
        windowsHide: true,
    });

    proc.stdout?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (text.trim()) {
            outputChannel.appendLine(`[ibsrv] ${text.trimEnd()}`);
        }
    });

    proc.stderr?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (text.trim()) {
            outputChannel.appendLine(`[ibsrv stderr] ${text.trimEnd()}`);
        }
    });

    proc.on('error', (err) => {
        outputChannel.appendLine(`[FormsIbsrv] Ошибка процесса: ${err.message}`);
    });

    const url = `http://localhost:${port}/`;

    // Ждём готовности ibsrv
    const ready = await _waitForIbsrv(url, proc, readyTimeoutMs, outputChannel);
    if (!ready) {
        // Убиваем процесс если он ещё жив
        await stopIbsrv(proc);
        throw new Error(
            `ibsrv не стал готов за ${readyTimeoutMs}мс (port ${port}). ` +
            `Проверьте путь к базе: ${opts.dbPath}`,
        );
    }

    outputChannel.appendLine(`[FormsIbsrv] Готов: ${url}`);
    return { url, port, proc, dataDir };
}

/**
 * Грациозная остановка ibsrv: SIGTERM → SIGKILL через IBSRV_KILL_WAIT_MS.
 */
export async function stopIbsrv(proc: ChildProcess): Promise<void> {
    if (!proc || proc.killed || proc.exitCode !== null) {
        return;
    }

    try {
        proc.kill('SIGTERM');
    } catch {
        // игнорируем ошибки
    }

    // На Windows SIGTERM может не работать — через небольшой промежуток SIGKILL
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            try {
                if (!proc.killed && proc.exitCode === null) {
                    proc.kill('SIGKILL');
                }
            } catch {
                // игнорируем
            }
            resolve();
        }, IBSRV_KILL_WAIT_MS);

        // Если процесс сам завершился до таймаута — досрочно резолвим
        proc.once('close', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

// ─── private ─────────────────────────────────────────────────────────────────

async function _waitForIbsrv(
    url: string,
    proc: ChildProcess,
    readyTimeoutMs: number,
    outputChannel: vscode.OutputChannel,
): Promise<boolean> {
    const deadline = Date.now() + readyTimeoutMs;

    while (Date.now() < deadline) {
        // Если процесс уже завершился — нет смысла ждать
        if (proc.exitCode !== null || proc.killed) {
            outputChannel.appendLine('[FormsIbsrv] Процесс завершился до готовности.');
            return false;
        }

        try {
            const ok = await _httpProbe(url);
            if (ok) {
                return true;
            }
        } catch {
            // не готов
        }

        await new Promise<void>((resolve) => setTimeout(resolve, IBSRV_POLL_INTERVAL_MS));
    }

    return false;
}

function _httpProbe(url: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const req = http.get(url, (res) => {
            res.resume();
            resolve(res.statusCode !== undefined && res.statusCode < 600);
        });
        req.setTimeout(IBSRV_POLL_INTERVAL_MS, () => {
            req.destroy();
            resolve(false);
        });
        req.on('error', () => resolve(false));
    });
}
