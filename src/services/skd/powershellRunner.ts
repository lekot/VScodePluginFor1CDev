// src/services/skd/powershellRunner.ts
// Запуск PowerShell-скриптов через общий lifecycle runner.
// Потоковый вывод декодируется как UTF-8 или OEM866 на Windows.

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createPowerShellStreamChunkDecoders } from './powershellStreamDecoder';
import type { ProcessTreeTerminationOutcome } from '../ibcmd/processTreeTermination';
import {
  runStreamingProcess,
  type StreamCancellation,
  type StreamingProcessRawOutcome,
} from '../process/streamingProcessRunner';

const execFileAsync = promisify(execFile);
const TERMINATION_GRACE_MS = 1500;
export const POWERSHELL_OUTPUT_MAX_BYTES = 1024 * 1024;

const NO_CANCELLATION: StreamCancellation = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
};

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
    /** True when stdout was clipped to the configured payload limit. */
    stdoutTruncated?: boolean;
    /** True when stderr was clipped to the configured payload limit. */
    stderrTruncated?: boolean;
    /** Complete low-level lifecycle outcome retained for callers that need its diagnostics. */
    processOutcome?: StreamingProcessRawOutcome;
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

/** Runs a PowerShell script through the shared owned-process lifecycle. */
export async function runPowerShellScript(
    opts: PowerShellRunOptions,
    dependencies: PowerShellRunnerDependencies = {},
): Promise<PowerShellRunResult> {
    const cancellation = opts.token ?? NO_CANCELLATION;
    const timeoutMs = opts.timeoutMs ?? 60000;
    if (cancellation.isCancellationRequested) {
        const outcome = await runStreamingProcess({
            executablePath: '',
            args: [],
            timeoutMs,
            cancellation,
        });
        return toPowerShellResult(outcome, new BoundedPayload(POWERSHELL_OUTPUT_MAX_BYTES),
            new BoundedPayload(POWERSHELL_OUTPUT_MAX_BYTES));
    }

    const exe = await (dependencies.resolveExecutable ?? resolvePowerShellExecutable)();
    if (cancellation.isCancellationRequested) {
        const outcome = await runStreamingProcess({
            executablePath: '',
            args: [],
            timeoutMs,
            cancellation,
        });
        return toPowerShellResult(outcome, new BoundedPayload(POWERSHELL_OUTPUT_MAX_BYTES),
            new BoundedPayload(POWERSHELL_OUTPUT_MAX_BYTES));
    }
    if (!exe) {
        return {
            stdout: '',
            stderr: 'PowerShell не найден. Установите PowerShell Core (pwsh) или используйте Windows.',
            exitCode: -2,
            started: false,
            effectPossible: false,
        };
    }

    const stdout = new BoundedPayload(POWERSHELL_OUTPUT_MAX_BYTES);
    const stderr = new BoundedPayload(POWERSHELL_OUTPUT_MAX_BYTES);
    const spawnArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', opts.scriptPath, ...opts.args];
    const outcome = await runStreamingProcess({
        executablePath: exe,
        args: spawnArgs,
        timeoutMs,
        cancellation,
        spawnOptions: { cwd: opts.cwd },
        streamDecoders: createPowerShellStreamChunkDecoders(),
        terminationGraceMs: TERMINATION_GRACE_MS,
        onStreamChunk: (chunk, stream) => {
            (stream === 'stdout' ? stdout : stderr).append(chunk);
            opts.onOutput?.(chunk);
        },
        ...(dependencies.spawnImpl ? { spawnImpl: dependencies.spawnImpl } : {}),
        ...(dependencies.terminateProcessTreeImpl
            ? { terminateProcessTreeImpl: dependencies.terminateProcessTreeImpl }
            : {}),
    });

    return toPowerShellResult(outcome, stdout, stderr);
}

function toPowerShellResult(
    outcome: StreamingProcessRawOutcome,
    stdout: BoundedPayload,
    stderr: BoundedPayload,
): PowerShellRunResult {
    const reportedStderr = outcome.spawnErrorMessage === undefined
        ? stderr
        : new BoundedPayload(POWERSHELL_OUTPUT_MAX_BYTES);
    if (outcome.spawnErrorMessage !== undefined) {
        reportedStderr.append(outcome.spawnErrorMessage);
    }
    const result: PowerShellRunResult = {
        stdout: stdout.text,
        stderr: reportedStderr.text,
        exitCode: outcome.timedOut
            ? -1
            : (outcome.cancelled && !outcome.effectPossible ? -3 : (outcome.exitCode ?? -1)),
        started: outcome.started,
        effectPossible: outcome.effectPossible,
        processOutcome: outcome,
    };
    if (outcome.cancelled) {
        if (outcome.effectPossible) {
            result.cancellationRequested = true;
        }
        result.cancelled = !outcome.effectPossible || outcome.termination?.terminated === true;
    }
    if (outcome.timedOut) {
        result.timedOut = true;
    }
    if (outcome.termination) {
        result.termination = outcome.termination;
    }
    if (stdout.truncated) {
        result.stdoutTruncated = true;
    }
    if (reportedStderr.truncated) {
        result.stderrTruncated = true;
    }
    return result;
}

class BoundedPayload {
    private readonly chunks: string[] = [];
    private retainedBytes = 0;
    truncated = false;

    constructor(private readonly maxBytes: number) {}

    get text(): string {
        return this.chunks.join('');
    }

    append(chunk: string): void {
        if (!chunk || this.truncated) {
            return;
        }
        const remainingBytes = this.maxBytes - this.retainedBytes;
        if (Buffer.byteLength(chunk, 'utf8') <= remainingBytes) {
            this.chunks.push(chunk);
            this.retainedBytes += Buffer.byteLength(chunk, 'utf8');
            return;
        }

        let prefix = '';
        for (const character of chunk) {
            const characterBytes = Buffer.byteLength(character, 'utf8');
            if (characterBytes > this.maxBytes - this.retainedBytes) {
                break;
            }
            prefix += character;
            this.retainedBytes += characterBytes;
        }
        if (prefix) {
            this.chunks.push(prefix);
        }
        this.truncated = true;
    }
}
