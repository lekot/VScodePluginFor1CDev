import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ChildProcess } from 'child_process';

const execFileAsync = promisify(execFile);

export interface ProcessTreeTerminationOutcome {
  terminated: boolean;
  hardKillUsed: boolean;
  survivingPids: number[];
  errors: string[];
}

export interface ProcessTreeTerminationOptions {
  platform?: NodeJS.Platform;
  graceMs?: number;
  hardKillGraceMs?: number;
  pollIntervalMs?: number;
}

export async function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminationOptions = {}
): Promise<ProcessTreeTerminationOutcome> {
  const platform = options.platform ?? process.platform;
  const graceMs = Math.max(0, options.graceMs ?? 1500);
  const hardKillGraceMs = Math.max(0, options.hardKillGraceMs ?? graceMs);
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 25);
  const pid = child.pid;

  if (!pid) {
    try {
      child.kill('SIGTERM');
      return { terminated: true, hardKillUsed: false, survivingPids: [], errors: [] };
    } catch (error) {
      return {
        terminated: false,
        hardKillUsed: false,
        survivingPids: [],
        errors: [errorMessage(error)],
      };
    }
  }

  return platform === 'win32'
    ? terminateWindowsProcessTree(pid, graceMs, hardKillGraceMs, pollIntervalMs)
    : terminatePosixProcessGroup(pid, graceMs, hardKillGraceMs, pollIntervalMs);
}

async function terminatePosixProcessGroup(
  pid: number,
  graceMs: number,
  hardKillGraceMs: number,
  pollIntervalMs: number
): Promise<ProcessTreeTerminationOutcome> {
  const errors: string[] = [];
  signalProcessGroup(pid, 'SIGTERM', errors);
  if (await waitForProcessGroupExit(pid, graceMs, pollIntervalMs)) {
    return { terminated: true, hardKillUsed: false, survivingPids: [], errors };
  }

  signalProcessGroup(pid, 'SIGKILL', errors);
  const terminated = await waitForProcessGroupExit(pid, hardKillGraceMs, pollIntervalMs);
  return {
    terminated,
    hardKillUsed: true,
    survivingPids: terminated ? [] : [pid],
    errors,
  };
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals, errors: string[]): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      errors.push(errorMessage(error));
    }
  }
}

async function waitForProcessGroupExit(
  pid: number,
  waitMs: number,
  pollIntervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (isPosixProcessGroupAlive(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

async function terminateWindowsProcessTree(
  pid: number,
  graceMs: number,
  hardKillGraceMs: number,
  pollIntervalMs: number
): Promise<ProcessTreeTerminationOutcome> {
  const errors: string[] = [];
  const knownPids = await listWindowsProcessTree(pid, errors);
  await runTaskkill(pid, false, errors);
  let survivingPids = await waitForWindowsProcessesExit(knownPids, graceMs, pollIntervalMs);
  if (survivingPids.length === 0) {
    return { terminated: true, hardKillUsed: false, survivingPids: [], errors };
  }

  for (const survivingPid of survivingPids) {
    await runTaskkill(survivingPid, true, errors);
  }
  survivingPids = await waitForWindowsProcessesExit(
    survivingPids,
    hardKillGraceMs,
    pollIntervalMs
  );
  return {
    terminated: survivingPids.length === 0,
    hardKillUsed: true,
    survivingPids,
    errors,
  };
}

async function listWindowsProcessTree(pid: number, errors: string[]): Promise<number[]> {
  const script = [
    `$root=${pid}`,
    '$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId',
    '$ids=New-Object System.Collections.Generic.List[int]',
    '$ids.Add($root)',
    'for($i=0;$i -lt $ids.Count;$i++){',
    '  $parent=$ids[$i]',
    '  $all | Where-Object ParentProcessId -eq $parent | ForEach-Object {',
    '    if(-not $ids.Contains([int]$_.ProcessId)){$ids.Add([int]$_.ProcessId)}',
    '  }',
    '}',
    '$ids -join ","',
  ].join(';');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf-8', windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 }
    );
    const discovered = String(stdout)
      .trim()
      .split(',')
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
    return [...new Set([pid, ...discovered])];
  } catch (error) {
    errors.push(`Failed to enumerate Windows process tree: ${errorMessage(error)}`);
    return [pid];
  }
}

async function runTaskkill(pid: number, force: boolean, errors: string[]): Promise<void> {
  try {
    await execFileAsync(
      'taskkill.exe',
      ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
      { encoding: 'utf-8', windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 }
    );
  } catch (error) {
    if (isProcessAlive(pid)) {
      errors.push(`taskkill ${pid}${force ? ' /F' : ''}: ${errorMessage(error)}`);
    }
  }
}

async function waitForWindowsProcessesExit(
  pids: readonly number[],
  waitMs: number,
  pollIntervalMs: number
): Promise<number[]> {
  const deadline = Date.now() + waitMs;
  let survivors = pids.filter(isProcessAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    survivors = survivors.filter(isProcessAlive);
  }
  return survivors;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
