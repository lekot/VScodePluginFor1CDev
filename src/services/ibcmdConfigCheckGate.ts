import * as path from 'path';
import { IBCMD_PATH_SETTINGS_QUERY } from './metadataTreeSettings';
import { getIbcmdService } from './ibcmd/ibcmdServiceSingleton';
import { runIbcmdExecutable } from './ibcmd/IbcmdProcessRunner';

const LOG_MAX = 8000;

export interface IbcmdConfigCheckResult {
  ok: boolean;
  message: string;
  /** Set when ibcmd executable cannot be resolved (UI may offer setup). */
  code?: 'IBCMD_NOT_FOUND';
}

function trimLog(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`.trim().slice(0, LOG_MAX);
}

function notFoundResult(hint: string): IbcmdConfigCheckResult {
  return {
    ok: false,
    code: 'IBCMD_NOT_FOUND',
    message: `ibcmd executable not found. Set ${IBCMD_PATH_SETTINGS_QUERY} in Settings (or deprecated 1cInfobaseManager.ibcmdPath) or IBCMD_PATH in the environment. ${hint} Command: "CDT 41: Configure ibcmd…".`,
  };
}

/**
 * Mandatory pre-write gate for subsystem composition updates.
 * Uses IbcmdService (settings → IBCMD_PATH → auto-detect), same env as matrix for YAML and credentials:
 * - IBCMD_INFOBASE_CONFIG
 * Optional: IBCMD_USER / IBCMD_PASSWORD / IBCMD_TIMEOUT_MS / IBCMD_CONFIG_CHECK_FORCE (=1 → append `--force`).
 */
export async function runIbcmdConfigCheckGate(): Promise<IbcmdConfigCheckResult> {
  const ibcmdService = getIbcmdService();
  const pathResult = ibcmdService.resolveExecutablePath();
  if (pathResult.kind === 'notFound') {
    return notFoundResult(pathResult.hint);
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
    const { stdout, stderr } = await runIbcmdExecutable(
      pathResult.path,
      args,
      ibcmdService.getTimeoutMs()
    );
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
    if (e.code === 'ENOENT') {
      ibcmdService.invalidatePathCache();
    }
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
