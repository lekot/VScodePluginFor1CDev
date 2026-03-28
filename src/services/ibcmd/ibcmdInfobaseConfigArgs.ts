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
  const args = ['infobase', 'config', 'check', `--config=${absoluteConfigPath}`];
  appendCredentials(args, options?.credentials);
  if (options?.force) {
    args.push('--force');
  }
  return args;
}

export function buildInfobaseConfigImportArgs(
  absoluteConfigPath: string,
  sourcePath: string,
  options?: { credentials?: IbcmdConfigCliCredentials; force?: boolean },
): string[] {
  const args = ['infobase', 'config', 'import', `--config=${absoluteConfigPath}`];
  appendCredentials(args, options?.credentials);
  if (options?.force) {
    args.push('--force');
  }
  args.push(sourcePath);
  return args;
}

export function buildInfobaseConfigExportArgs(
  absoluteConfigPath: string,
  outPath: string,
  options?: { credentials?: IbcmdConfigCliCredentials; extension?: string; format?: string },
): string[] {
  const args = ['infobase', 'config', 'export', `--config=${absoluteConfigPath}`, `--out=${outPath}`];
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
