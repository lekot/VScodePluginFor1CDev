/**
 * CLI argument builders for `ibcmd infobase config` (import / export / check).
 *
 * ADR (§1E): For Infobase Manager catalog operations, credentials are written into
 * generated YAML by `ibcmdConfigPathResolver.prepareIbcmdConfigYaml` so they are not duplicated in
 * process argv. Optional `--user` / `--password` here mirror {@link runIbcmdConfigCheckGate}
 * for callers that keep creds outside YAML (e.g. env-driven gate).
 *
 * @see docs/WOW/ibcmd-api-reference.md
 */

import * as fs from 'fs';

/**
 * On Windows, `os.tmpdir()` / `path.resolve` may yield 8.3 short components (e.g. `2BA0~1`).
 * ibcmd has been observed to mis-associate `--config` with the wrong infobase when the config path
 * is short-form; expand via `realpathSync.native` for existing paths.
 */
export function resolveIbcmdCliPathForWindowsSpawn(absPath: string): string {
  const t = absPath.trim();
  if (process.platform !== 'win32' || !t) {
    return t;
  }
  try {
    if (fs.existsSync(t)) {
      return fs.realpathSync.native(t);
    }
  } catch {
    /* keep logical path */
  }
  return t;
}

export interface IbcmdConfigCliCredentials {
  user?: string;
  password?: string;
}

function appendCredentials(args: string[], creds?: IbcmdConfigCliCredentials): void {
  if (!creds) {
    return;
  }
  const u = creds.user?.trim();
  if (u) {
    args.push(`--user=${u}`);
  }
  const p = creds.password;
  if (typeof p === 'string' && p.length > 0) {
    args.push(`--password=${p}`);
  }
}

export function buildInfobaseConfigCheckArgs(
  absoluteConfigPath: string,
  options?: { credentials?: IbcmdConfigCliCredentials; force?: boolean },
): string[] {
  const cfg = resolveIbcmdCliPathForWindowsSpawn(absoluteConfigPath);
  const args = ['infobase', 'config', 'check', `--config=${cfg}`];
  appendCredentials(args, options?.credentials);
  if (options?.force) {
    args.push('--force');
  }
  return args;
}

export function buildInfobaseConfigImportArgs(
  absoluteConfigPath: string,
  sourcePath: string,
  options?: { credentials?: IbcmdConfigCliCredentials; force?: boolean; extension?: string },
): string[] {
  const cfg = resolveIbcmdCliPathForWindowsSpawn(absoluteConfigPath);
  const src = resolveIbcmdCliPathForWindowsSpawn(sourcePath);
  const args = ['infobase', 'config', 'import', `--config=${cfg}`];
  appendCredentials(args, options?.credentials);
  if (options?.force) {
    args.push('--force');
  }
  const ext = options?.extension?.trim();
  if (ext) {
    args.push(`--extension=${ext}`);
  }
  args.push(src);
  return args;
}

export function buildInfobaseConfigExportArgs(
  absoluteConfigPath: string,
  outPath: string,
  options?: { credentials?: IbcmdConfigCliCredentials; extension?: string; format?: string },
): string[] {
  const cfg = resolveIbcmdCliPathForWindowsSpawn(absoluteConfigPath);
  const out = resolveIbcmdCliPathForWindowsSpawn(outPath);
  const args = ['infobase', 'config', 'export', `--config=${cfg}`, `--out=${out}`];
  appendCredentials(args, options?.credentials);
  const ext = options?.extension?.trim();
  if (ext) {
    args.push(`--extension=${ext}`);
  }
  const fmt = options?.format?.trim();
  if (fmt) {
    args.push(`--format=${fmt}`);
  }
  return args;
}
