// src/services/skd/powershellRunner.ts
// Запуск PowerShell-скриптов через child_process.spawn.
// Декодирование вывода через decodeConsoleStreamAuto (UTF-8/OEM866 на Windows).

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createIbcmdStreamChunkDecoders, decodeConsoleStreamAuto } from '../ibcmd/consoleStreamDecoder';
import {
    terminateProcessTree,
    type ProcessTreeTerminationOutcome,
} from '../ibcmd/processTreeTermination';

const execFileAsync = promisify(execFile);
const TERMINATION_GRACE_MS = 1500;

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
    /** Cancellation token for the PowerShell child process. */
    token?: vscode.CancellationToken;
    /** Receives decoded stdout/stderr chunks while the child process runs. */
    onOutput?: (chunk: string) => void;
}

export interface PowerShellRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    /** True only when the child emitted its spawn event. */
    started?: boolean;
    /** True once a child handle exists and execution may have had an effect. */
    effectPossible?: boolean;
    /** True only when a cancellation request was confirmed by process-tree termination. */
    cancelled?: boolean;
    /** True when a cancellation request is still being reported as an uncertain outcome. */
    cancellationRequested?: boolean;
    /** True when the configured timeout expired. */
    timedOut?: boolean;
    /** Result of bounded process-tree termination after cancellation or timeout. */
    termination?: ProcessTreeTerminationOutcome;
}

/** Injectable process boundary for deterministic lifecycle tests. */
export interface PowerShellRunnerDependencies {
    resolveExecutable?: typeof resolvePowerShellExecutable;
    spawnImpl?: typeof spawn;
    terminateProcessTreeImpl?: (
        child: ChildProcess,
        graceMs: number,
    ) => Promise<ProcessTreeTerminationOutcome>;
}

/**
 * Запускает PS1-скрипт и возвращает stdout/stderr/exitCode.
 * Stdout и stderr декодируются через decodeConsoleStreamAuto (UTF-8 → OEM866 fallback на Windows).
 * При таймауте процесс убивается, exitCode = -1.
 */
export async function runPowerShellScript(
    opts: PowerShellRunOptions,
    dependencies: PowerShellRunnerDependencies = {},
): Promise<PowerShellRunResult> {
    if (opts.token?.isCancellationRequested) {
        return { stdout: '', stderr: '', exitCode: -3, started: false, cancelled: true };
    }
    const exe = await (dependencies.resolveExecutable ?? resolvePowerShellExecutable)();
    if (!exe) {
        return {
            stdout: '',
            stderr: 'PowerShell не найден. Установите PowerShell Core (pwsh) или используйте Windows.',
            exitCode: -2,
        };
    }

    const { scriptPath, args, cwd, timeoutMs = 60000 } = opts;

    if (opts.token?.isCancellationRequested) {
        return { stdout: '', stderr: '', exitCode: -3, started: false, cancelled: true };
    }

    const spawnArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args];

    return new Promise<PowerShellRunResult>((resolve) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        const decoders = createIbcmdStreamChunkDecoders('auto');
        let started = false;
        let childHandleCreated = false;
        let settled = false;
        let terminationReason: 'cancelled' | 'timedOut' | undefined;
        let terminationOutcome: ProcessTreeTerminationOutcome | undefined;
        let closeCode: number | null | undefined;
        let spawnErrorMessage: string | undefined;
        let streamsFlushed = false;
        const lifecycle: {
            timer: ReturnType<typeof setTimeout> | undefined;
            cancellation: vscode.Disposable | undefined;
        } = { timer: undefined, cancellation: undefined };
        const clearLifecycle = (): void => {
            if (lifecycle.timer !== undefined) {
                clearTimeout(lifecycle.timer);
                lifecycle.timer = undefined;
            }
            lifecycle.cancellation?.dispose();
            lifecycle.cancellation = undefined;
        };
        const flushStreams = (): void => {
            if (streamsFlushed) { return; }
            streamsFlushed = true;
            const stdoutRemainder = decoders.flushStdout();
            const stderrRemainder = decoders.flushStderr();
            if (stdoutRemainder) { opts.onOutput?.(stdoutRemainder); }
            if (stderrRemainder) { opts.onOutput?.(stderrRemainder); }
        };
        const finish = (): void => {
            if (settled) { return; }
            settled = true;
            clearLifecycle();
            flushStreams();
            const cancellationRequested = terminationReason === 'cancelled';
            resolve({
                stdout: decodeConsoleStreamAuto(Buffer.concat(stdoutChunks)),
                stderr: spawnErrorMessage ?? decodeConsoleStreamAuto(Buffer.concat(stderrChunks)),
                exitCode: terminationReason === 'timedOut' ? -1 : (closeCode ?? -1),
                started,
                effectPossible: childHandleCreated,
                ...(cancellationRequested ? { cancellationRequested: true } : {}),
                ...(cancellationRequested
                    ? { cancelled: terminationOutcome?.terminated === true }
                    : {}),
                ...(terminationReason === 'timedOut' ? { timedOut: true } : {}),
                ...(terminationOutcome ? { termination: terminationOutcome } : {}),
            });
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = (dependencies.spawnImpl ?? spawn)(exe, spawnArgs, {
                cwd,
                windowsHide: true,
                ...(process.platform === 'win32' ? {} : { detached: true }),
            });
            childHandleCreated = true;
        } catch (error) {
            spawnErrorMessage = error instanceof Error ? error.message : String(error);
            closeCode = -1;
            finish();
            return;
        }

        child.stdout?.on('data', (chunk: Buffer) => {
            if (settled) { return; }
            stdoutChunks.push(chunk);
            opts.onOutput?.(decoders.decodeStdout(chunk));
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            if (settled) { return; }
            stderrChunks.push(chunk);
            opts.onOutput?.(decoders.decodeStderr(chunk));
        });
        child.on('spawn', () => { started = true; });
        const terminate = dependencies.terminateProcessTreeImpl
            ?? ((target: ChildProcess, graceMs: number) => terminateProcessTree(target, {
                graceMs,
                hardKillGraceMs: graceMs,
            }));
        const requestTermination = (reason: 'cancelled' | 'timedOut'): void => {
            if (settled || terminationReason) { return; }
            terminationReason = reason;
            clearLifecycle();
            void Promise.resolve()
                .then(() => terminate(child, TERMINATION_GRACE_MS))
                .catch((error): ProcessTreeTerminationOutcome => ({
                    terminated: false,
                    hardKillUsed: false,
                    survivingPids: child.pid ? [child.pid] : [],
                    errors: [error instanceof Error ? error.message : String(error)],
                }))
                .then((outcome) => {
                    terminationOutcome = outcome;
                    finish();
                });
        };

        lifecycle.cancellation = opts.token?.onCancellationRequested(() => requestTermination('cancelled'));
        if (terminationReason) { clearLifecycle(); }
        if (opts.token?.isCancellationRequested) {
            requestTermination('cancelled');
        }
        if (!terminationReason) {
            lifecycle.timer = setTimeout(() => requestTermination('timedOut'), timeoutMs);
        }

        child.on('close', (code) => {
            closeCode = code;
            if (!terminationReason) { finish(); }
        });

        child.on('error', (err) => {
            spawnErrorMessage = err.message;
            if (!terminationReason) {
                closeCode = -1;
                finish();
            }
        });
    });
}
