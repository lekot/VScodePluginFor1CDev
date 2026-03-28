import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Same as ibcmd gate / matrix adapter. */
export const IBCMD_EXEC_MAX_BUFFER = 4 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 600_000;

export type ExecFileFn = (
  file: string,
  args: readonly string[] | string[],
  options: {
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  }
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/**
 * Timeout: positive `settingsTimeoutMs` wins; else `IBCMD_TIMEOUT_MS` if valid; else 600000.
 */
export function resolveIbcmdTimeoutMs(settingsTimeoutMs: number | undefined, envTimeoutRaw: string | undefined): number {
  if (typeof settingsTimeoutMs === 'number' && settingsTimeoutMs > 0 && Number.isFinite(settingsTimeoutMs)) {
    return settingsTimeoutMs;
  }
  const envMs = parseInt(envTimeoutRaw ?? '', 10);
  if (Number.isFinite(envMs) && envMs > 0) {
    return envMs;
  }
  return DEFAULT_TIMEOUT_MS;
}

export async function runIbcmdExecutable(
  executable: string,
  args: string[],
  timeoutMs: number,
  execImpl: ExecFileFn = execFileAsync as ExecFileFn
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execImpl(executable, args, {
    timeout: timeoutMs,
    maxBuffer: IBCMD_EXEC_MAX_BUFFER,
    windowsHide: true,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}
