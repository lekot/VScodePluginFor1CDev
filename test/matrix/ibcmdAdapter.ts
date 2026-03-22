import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const LOG_MAX = 8000;

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Optional subprocess: load hierarchical Designer dump into an infobase via `ibcmd`.
 *
 * **Environment (see `docs/design/e2e-container-matrix-ibcmd.md` §6.5):**
 * - `IBCMD_PATH` — path to `ibcmd` (Windows: `...\bin\ibcmd.exe`). If unset → `skipped`.
 * - `IBCMD_INFOBASE_CONFIG` — absolute path to YAML describing the target infobase (per 1C Administrator Guide,
 *   appendix on **ibcmd**, **infobase** mode; often produced with `ibcmd server config init ... --out=...`).
 *   If `IBCMD_PATH` is set but this is unset → `skipped` (no silent “fake success”).
 * - `IBCMD_USER` / `IBCMD_PASSWORD` — optional; passed to import if non-empty.
 * - `IBCMD_TIMEOUT_MS` — optional subprocess timeout (default 600000).
 *
 * **Command** (1C 8.3.27+ standalone server admin utility, KB: infobase `config import` from files):
 * `ibcmd infobase config import --config=<YAML> [--user=...] [--password=...] <absoluteWorkDir>`
 * where `absoluteWorkDir` is the Designer tree root (contains `Configuration.xml`).
 */
export async function runIbcmdOnWorkDir(
  workDir: string
): Promise<{ status: 'executed' | 'skipped' | 'failed'; exitCode: number | null; logSnippet: string }> {
  const ibcmdPath = process.env.IBCMD_PATH?.trim();
  if (!ibcmdPath) {
    return { status: 'skipped', exitCode: null, logSnippet: '' };
  }

  const configPath = process.env.IBCMD_INFOBASE_CONFIG?.trim();
  if (!configPath) {
    return {
      status: 'skipped',
      exitCode: null,
      logSnippet:
        'IBCMD_PATH is set but IBCMD_INFOBASE_CONFIG is not. Set IBCMD_INFOBASE_CONFIG to a YAML file describing the file or server infobase (see docs/design/e2e-container-matrix-ibcmd.md §6.5).',
    };
  }

  if (!fs.existsSync(ibcmdPath)) {
    return {
      status: 'failed',
      exitCode: null,
      logSnippet: `ibcmd executable not found: ${ibcmdPath}`,
    };
  }

  if (!fs.existsSync(configPath)) {
    return {
      status: 'failed',
      exitCode: null,
      logSnippet: `IBCMD_INFOBASE_CONFIG file not found: ${configPath}`,
    };
  }

  const root = path.resolve(workDir);
  const cfgXml = path.join(root, 'Configuration.xml');
  if (!fs.existsSync(cfgXml)) {
    return {
      status: 'failed',
      exitCode: null,
      logSnippet: `workDir has no Configuration.xml: ${root}`,
    };
  }

  const args = ['infobase', 'config', 'import', `--config=${path.resolve(configPath)}`];
  const user = process.env.IBCMD_USER?.trim();
  const password = process.env.IBCMD_PASSWORD?.trim();
  if (user) {
    args.push(`--user=${user}`);
  }
  if (password) {
    args.push(`--password=${password}`);
  }
  args.push(root);

  const timeoutMs = parseInt(process.env.IBCMD_TIMEOUT_MS ?? '', 10);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  try {
    const { stdout, stderr } = await execFileAsync(ibcmdPath, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const combined = `${stdout}\n${stderr}`.trim();
    return {
      status: 'executed',
      exitCode: 0,
      logSnippet: combined.slice(0, LOG_MAX),
    };
  } catch (err: unknown) {
    const e = err as {
      code?: string | number;
      status?: number;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const exitCode =
      typeof e.status === 'number'
        ? e.status
        : typeof e.code === 'number'
          ? e.code
          : null;
    const stdout = (e.stdout ?? '').toString();
    const stderr = (e.stderr ?? '').toString();
    const combined = [stdout, stderr, e.signal ? `signal:${e.signal}` : ''].join('\n').trim();
    return {
      status: 'failed',
      exitCode,
      logSnippet: combined.slice(0, LOG_MAX),
    };
  }
}
