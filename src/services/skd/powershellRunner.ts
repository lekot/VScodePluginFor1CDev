// src/services/skd/powershellRunner.ts
// Запуск PowerShell-скриптов через child_process.spawn.
// Декодирование вывода через decodeConsoleStreamAuto (UTF-8/OEM866 на Windows).

import { spawn } from 'child_process';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { decodeConsoleStreamAuto } from '../ibcmd/consoleStreamDecoder';

const execFileAsync = promisify(execFile);

// ─── Resolve PowerShell executable ───────────────────────────────────────────

let cachedPwshPath: string | null | undefined = undefined;

/**
 * Находит исполняемый файл PowerShell.
 * Приоритет: pwsh (PowerShell Core) → powershell.exe (Windows PowerShell).
 * Результат кешируется на уровне модуля.
 */
export async function resolvePowerShellExecutable(): Promise<string | undefined> {
    if (cachedPwshPath !== undefined) {
        return cachedPwshPath ?? undefined;
    }

    // Try pwsh (PowerShell Core — cross-platform)
    const pwshCandidate = await tryWhich('pwsh');
    if (pwshCandidate) {
        cachedPwshPath = pwshCandidate;
        return pwshCandidate;
    }

    // Try powershell.exe (Windows PowerShell 5.x)
    if (process.platform === 'win32') {
        const ps5Candidate = await tryWhich('powershell.exe');
        if (ps5Candidate) {
            cachedPwshPath = ps5Candidate;
            return ps5Candidate;
        }
    }

    cachedPwshPath = null;
    return undefined;
}

/** @internal Сбросить кеш (для тестов). */
export function _resetPwshCache(): void {
    cachedPwshPath = undefined;
}

async function tryWhich(name: string): Promise<string | undefined> {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    try {
        const { stdout } = await execFileAsync(cmd, [name], { timeout: 5000 });
        const first = stdout.trim().split(/\r?\n/)[0].trim();
        return first.length > 0 ? first : undefined;
    } catch {
        return undefined;
    }
}

// ─── Run PowerShell script ────────────────────────────────────────────────────

export interface PowerShellRunOptions {
    /** Абсолютный путь к PS1-скрипту. */
    scriptPath: string;
    /** Аргументы (без имени скрипта): ['-Param', 'Value', ...]. */
    args: string[];
    /** Рабочая директория. */
    cwd?: string;
    /** Таймаут в миллисекундах (по умолчанию 60000). */
    timeoutMs?: number;
}

export interface PowerShellRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Запускает PS1-скрипт и возвращает stdout/stderr/exitCode.
 * Stdout и stderr декодируются через decodeConsoleStreamAuto (UTF-8 → OEM866 fallback на Windows).
 * При таймауте процесс убивается, exitCode = -1.
 */
export async function runPowerShellScript(opts: PowerShellRunOptions): Promise<PowerShellRunResult> {
    const exe = await resolvePowerShellExecutable();
    if (!exe) {
        return {
            stdout: '',
            stderr: 'PowerShell не найден. Установите PowerShell Core (pwsh) или используйте Windows.',
            exitCode: -2,
        };
    }

    const { scriptPath, args, cwd, timeoutMs = 60000 } = opts;

    const spawnArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args];

    return new Promise<PowerShellRunResult>((resolve) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        const child = spawn(exe, spawnArgs, {
            cwd,
            windowsHide: true,
        });

        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, timeoutMs);

        child.on('close', (code) => {
            clearTimeout(timer);
            const rawOut = Buffer.concat(stdoutChunks);
            const rawErr = Buffer.concat(stderrChunks);
            resolve({
                stdout: decodeConsoleStreamAuto(rawOut),
                stderr: decodeConsoleStreamAuto(rawErr),
                exitCode: timedOut ? -1 : (code ?? -1),
            });
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({
                stdout: '',
                stderr: err.message,
                exitCode: -1,
            });
        });
    });
}
