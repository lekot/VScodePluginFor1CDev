import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 600_000;
const LOG_MAX = 8000;

export interface IbcmdConfigCheckResult {
  ok: boolean;
  message: string;
}

function resolveTimeoutMs(): number {
  const timeoutMs = parseInt(process.env.IBCMD_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

function trimLog(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`.trim().slice(0, LOG_MAX);
}

/**
 * Mandatory pre-write gate for subsystem composition updates.
 * Requires the same ibcmd environment as matrix runs:
 * - IBCMD_PATH
 * - IBCMD_INFOBASE_CONFIG
 * Optional: IBCMD_USER / IBCMD_PASSWORD / IBCMD_TIMEOUT_MS / IBCMD_CONFIG_CHECK_FORCE (=1 → append `--force`).
 */
export async function runIbcmdConfigCheckGate(): Promise<IbcmdConfigCheckResult> {
  const ibcmdPath = process.env.IBCMD_PATH?.trim();
  if (!ibcmdPath) {
    return {
      ok: false,
      message:
        'IBCMD_PATH is not set. Set IBCMD_PATH and IBCMD_INFOBASE_CONFIG before updating subsystem composition.',
    };
  }
  const configPath = process.env.IBCMD_INFOBASE_CONFIG?.trim();
  if (!configPath) {
    return {
      ok: false,
      message:
        'IBCMD_INFOBASE_CONFIG is not set. Set YAML infobase config before updating subsystem composition.',
    };
  }

  const args = ['infobase', 'config', 'check', `--config=${path.resolve(configPath)}`];
  const user = process.env.IBCMD_USER?.trim();
  const password = process.env.IBCMD_PASSWORD?.trim();
  if (user) {
    args.push(`--user=${user}`);
  }
  if (password) {
    args.push(`--password=${password}`);
  }
  if (process.env.IBCMD_CONFIG_CHECK_FORCE?.trim() === '1') {
    args.push('--force');
  }

  try {
    const { stdout, stderr } = await execFileAsync(ibcmdPath, args, {
      timeout: resolveTimeoutMs(),
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      ok: true,
      message: trimLog(stdout, stderr),
    };
  } catch (err: unknown) {
    const e = err as {
      code?: string | number;
      status?: number;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    const code =
      typeof e.status === 'number'
        ? `exitCode=${e.status}`
        : typeof e.code === 'number'
          ? `exitCode=${e.code}`
          : e.signal
            ? `signal=${e.signal}`
            : 'failed';
    const details = trimLog((e.stdout ?? '').toString(), (e.stderr ?? '').toString());
    const tail = details ? `\n${details}` : e.message ? `\n${e.message}` : '';
    return {
      ok: false,
      message: `ibcmd config check failed (${code}).${tail}`,
    };
  }
}
