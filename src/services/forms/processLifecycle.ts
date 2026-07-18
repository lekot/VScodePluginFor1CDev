import type { ChildProcess } from 'child_process';
import { terminateProcessTree } from '../ibcmd/processTreeTermination';

export class ChildProcessTerminationError extends Error {
    readonly code = 'CHILD_PROCESS_TERMINATION_FAILED';
    readonly retryable = true;

    constructor(
        readonly resource: string,
        readonly proc: ChildProcess,
        readonly diagnostics: readonly string[],
    ) {
        super(
            `${resource} process ${proc.pid ?? 'unknown'} did not exit after TERM→KILL` +
            (diagnostics.length > 0 ? ` (${diagnostics.join('; ')})` : ''),
        );
        this.name = 'ChildProcessTerminationError';
    }
}

export function isChildProcessTerminated(proc: ChildProcess): boolean {
    return proc.exitCode !== null || proc.signalCode != null;
}

export function waitForChildProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (isChildProcessTerminated(proc)) {
        return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (exited: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            proc.removeListener('close', onExit);
            proc.removeListener('exit', onExit);
            resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(isChildProcessTerminated(proc)), timeoutMs);
        proc.once('close', onExit);
        proc.once('exit', onExit);
    });
}

export async function terminateChildProcess(
    proc: ChildProcess,
    resource: string,
    termWaitMs: number,
    killWaitMs: number,
): Promise<void> {
    if (isChildProcessTerminated(proc)) {
        return;
    }
    if (proc.pid && proc.spawnfile) {
        const outcome = await terminateProcessTree(proc, {
            graceMs: termWaitMs,
            hardKillGraceMs: killWaitMs,
        });
        if (outcome.terminated) {
            return;
        }
        throw new ChildProcessTerminationError(resource, proc, [
            ...outcome.errors,
            ...(outcome.survivingPids.length > 0
                ? [`surviving PIDs: ${outcome.survivingPids.join(', ')}`]
                : []),
        ]);
    }

    // Lightweight injected children in unit tests do not have spawn metadata.
    // Preserve the same verified TERM -> KILL contract for that seam.
    const diagnostics: string[] = [];
    if (!sendSignal(proc, 'SIGTERM', diagnostics)) {
        diagnostics.push('SIGTERM rejected');
    }
    if (await waitForChildProcessExit(proc, termWaitMs)) {
        return;
    }
    if (!sendSignal(proc, 'SIGKILL', diagnostics)) {
        diagnostics.push('SIGKILL rejected');
    }
    if (await waitForChildProcessExit(proc, killWaitMs)) {
        return;
    }
    throw new ChildProcessTerminationError(resource, proc, diagnostics);
}

function sendSignal(
    proc: ChildProcess,
    signal: NodeJS.Signals,
    diagnostics: string[],
): boolean {
    try {
        return proc.kill(signal);
    } catch (error) {
        diagnostics.push(`${signal}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
