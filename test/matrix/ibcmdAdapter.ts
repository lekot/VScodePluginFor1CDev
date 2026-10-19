import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  resolveExistingPathToLongOnWin32,
  resolvePathForIbcmdYamlFileField,
  tryParseInfobaseFileScalarFromYaml,
} from '../../src/infobases/ibcmdConfigPathResolver';
import { decodeConsoleStreamAuto } from '../../src/services/ibcmd/consoleStreamDecoder';
import {
  runNativeTestClientStartupCheck,
  type NativeTestClientStartupDependencies,
} from './startupReadiness';

const execFileAsync = promisify(execFile);

const LOG_MAX = 8000;

const DEFAULT_TIMEOUT_MS = 600_000;

export interface IbcmdStepOutcome {
  status: 'executed' | 'skipped' | 'failed';
  exitCode: number | null;
  logSnippet: string;
}

function resolveConnectionArgsFromConfigYaml(configPath: string): {
  connectionArgs: string[];
  fileDbPath?: string;
} {
  const absConfig = resolveExistingPathToLongOnWin32(path.resolve(configPath));
  try {
    const content = fs.readFileSync(absConfig, 'utf8');
    const fileScalar = tryParseInfobaseFileScalarFromYaml(content);
    if (fileScalar && fileScalar.trim()) {
      const dbPath = resolvePathForIbcmdYamlFileField(fileScalar);
      return {
        connectionArgs: [`--db-path=${dbPath}`],
        fileDbPath: dbPath,
      };
    }
  } catch {
    /* fallback to --config */
  }
  return {
    connectionArgs: [`--config=${absConfig}`],
  };
}

function decodeExecStreams(stdout?: string | Buffer, stderr?: string | Buffer): string {
  const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '', 'utf8');
  const errBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '', 'utf8');
  return `${decodeConsoleStreamAuto(outBuf)}\n${decodeConsoleStreamAuto(errBuf)}`.trim();
}

/**
 * Optional subprocess: load hierarchical Designer dump into an infobase via `ibcmd`.
 *
 * **Environment (see `docs/design/e2e-container-matrix-ibcmd.md` §6.5):**
 * - `IBCMD_PATH` — path to `ibcmd` (Windows: `...\bin\ibcmd.exe`). If unset → `skipped`.
 * - `IBCMD_INFOBASE_CONFIG` — absolute path to YAML describing the target infobase.
 *   If `IBCMD_PATH` is set but this is unset → `skipped` (no silent “fake success”).
 * - `IBCMD_USER` / `IBCMD_PASSWORD` — optional; passed to import if non-empty.
 * - `IBCMD_TIMEOUT_MS` — optional subprocess timeout (default 600000).
 *
 * **Config check** (see design §6.6): `runIbcmdConfigCheck` — `ibcmd infobase config check ...`
 * Optional: `IBCMD_CONFIG_CHECK_FORCE=1` → append `--force`.
 */
export async function runIbcmdConfigCheck(): Promise<IbcmdStepOutcome> {
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
        'IBCMD_PATH is set but IBCMD_INFOBASE_CONFIG is not. Set IBCMD_INFOBASE_CONFIG (see docs/design/e2e-container-matrix-ibcmd.md §6.5).',
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

  const offlineDataDir = resolveExistingPathToLongOnWin32(
    fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-ibcmd-check-'))
  );
  const { connectionArgs } = resolveConnectionArgsFromConfigYaml(configPath);
  const args = ['infobase', 'config', 'check', ...connectionArgs];
  const user = process.env.IBCMD_USER?.trim();
  const password = process.env.IBCMD_PASSWORD?.trim();
  if (user) {
    args.push(`--user=${user}`);
  }
  if (password) {
    args.push(`--password=${password}`);
  }
  args.push(`--data=${offlineDataDir}`);
  if (process.env.IBCMD_CONFIG_CHECK_FORCE?.trim() === '1') {
    args.push('--force');
  }

  const timeoutMs = parseInt(process.env.IBCMD_TIMEOUT_MS ?? '', 10);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  try {
    const { stdout, stderr } = await execFileAsync(ibcmdPath, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'buffer',
    });
    const combined = decodeExecStreams(stdout, stderr);
    const logSnippet = combined.slice(0, LOG_MAX);
    // Guardrail: prevent fake/mocked `ibcmd` scripts from producing a false-positive `executed`.
    if (logSnippet.toLowerCase().includes('fake-ibcmd')) {
      return {
        status: 'failed',
        exitCode: 0,
        logSnippet: `${logSnippet}\nDetected fake-ibcmd output; refusing to mark executed.`,
      };
    }
    return {
      status: 'executed',
      exitCode: 0,
      logSnippet,
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
    const decoded = decodeExecStreams(e.stdout, e.stderr);
    const combined = [decoded, e.signal ? `signal:${e.signal}` : ''].join('\n').trim();
    return {
      status: 'failed',
      exitCode,
      logSnippet: combined.slice(0, LOG_MAX),
    };
  } finally {
    try {
      fs.rmSync(offlineDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function runIbcmdOnWorkDir(workDir: string): Promise<IbcmdStepOutcome> {
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

  const root = resolveExistingPathToLongOnWin32(path.resolve(workDir));
  const cfgXml = path.join(root, 'Configuration.xml');
  if (!fs.existsSync(cfgXml)) {
    return {
      status: 'failed',
      exitCode: null,
      logSnippet: `workDir has no Configuration.xml: ${root}`,
    };
  }

  const offlineDataDir = resolveExistingPathToLongOnWin32(
    fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-ibcmd-import-'))
  );
  const { connectionArgs } = resolveConnectionArgsFromConfigYaml(configPath);
  const args = ['infobase', 'config', 'import', ...connectionArgs];
  const user = process.env.IBCMD_USER?.trim();
  const password = process.env.IBCMD_PASSWORD?.trim();
  if (user) {
    args.push(`--user=${user}`);
  }
  if (password) {
    args.push(`--password=${password}`);
  }
  args.push(`--data=${offlineDataDir}`);
  args.push(root);

  const timeoutMs = parseInt(process.env.IBCMD_TIMEOUT_MS ?? '', 10);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  try {
    const { stdout, stderr } = await execFileAsync(ibcmdPath, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'buffer',
    });
    const combined = decodeExecStreams(stdout, stderr);
    const logSnippet = combined.slice(0, LOG_MAX);
    // Guardrail: prevent fake/mocked `ibcmd` scripts from producing a false-positive `executed`.
    if (logSnippet.toLowerCase().includes('fake-ibcmd')) {
      return {
        status: 'failed',
        exitCode: 0,
        logSnippet: `${logSnippet}\nDetected fake-ibcmd output; refusing to mark executed.`,
      };
    }
    return {
      status: 'executed',
      exitCode: 0,
      logSnippet,
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
    const decoded = decodeExecStreams(e.stdout, e.stderr);
    const combined = [decoded, e.signal ? `signal:${e.signal}` : ''].join('\n').trim();
    return {
      status: 'failed',
      exitCode,
      logSnippet: combined.slice(0, LOG_MAX),
    };
  } finally {
    try {
      fs.rmSync(offlineDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Apply the imported configuration to the database configuration (`ibcmd infobase config apply --force --session-terminate=force`).
 */
export async function runIbcmdConfigApply(): Promise<IbcmdStepOutcome> {
  const ibcmdPath = process.env.IBCMD_PATH?.trim();
  if (!ibcmdPath) {
    return { status: 'skipped', exitCode: null, logSnippet: '' };
  }

  const configPath = process.env.IBCMD_INFOBASE_CONFIG?.trim();
  if (!configPath) {
    return {
      status: 'skipped',
      exitCode: null,
      logSnippet: 'IBCMD_PATH is set but IBCMD_INFOBASE_CONFIG is not.',
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

  const offlineDataDir = resolveExistingPathToLongOnWin32(
    fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-ibcmd-apply-'))
  );
  const { connectionArgs } = resolveConnectionArgsFromConfigYaml(configPath);
  const args = ['infobase', 'config', 'apply', ...connectionArgs];
  const user = process.env.IBCMD_USER?.trim();
  const password = process.env.IBCMD_PASSWORD?.trim();
  if (user) {
    args.push(`--user=${user}`);
  }
  if (password) {
    args.push(`--password=${password}`);
  }
  args.push(`--data=${offlineDataDir}`);
  args.push('--force');
  args.push('--session-terminate=force');

  const timeoutMs = parseInt(process.env.IBCMD_TIMEOUT_MS ?? '', 10);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  try {
    const { stdout, stderr } = await execFileAsync(ibcmdPath, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'buffer',
    });
    const combined = decodeExecStreams(stdout, stderr);
    const logSnippet = combined.slice(0, LOG_MAX);
    if (logSnippet.toLowerCase().includes('fake-ibcmd')) {
      return {
        status: 'failed',
        exitCode: 0,
        logSnippet: `${logSnippet}\nDetected fake-ibcmd output; refusing to mark executed.`,
      };
    }
    return {
      status: 'executed',
      exitCode: 0,
      logSnippet,
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
    const decoded = decodeExecStreams(e.stdout, e.stderr);
    const combined = [decoded, e.signal ? `signal:${e.signal}` : ''].join('\n').trim();
    return {
      status: 'failed',
      exitCode,
      logSnippet: combined.slice(0, LOG_MAX),
    };
  } finally {
    try {
      fs.rmSync(offlineDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function resolvePlatformClientForIbcmd(ibcmdPath: string): string | undefined {
  const explicit = process.env.ONE_C_CLIENT_PATH?.trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }
  const binDir = path.dirname(path.resolve(ibcmdPath));
  const candidates =
    process.platform === 'win32'
      ? [path.join(binDir, '1cv8c.exe'), path.join(binDir, '1cv8.exe')]
      : [path.join(binDir, '1cv8c'), path.join(binDir, '1cv8')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Confirm the file infobase accepts a native TestClient attach and returns its main window.
 * The check does not claim to exercise all application startup scenarios.
 */
export async function runInfobaseStartupCheck(
  dependencies: NativeTestClientStartupDependencies = {},
): Promise<IbcmdStepOutcome> {
  const ibcmdPath = process.env.IBCMD_PATH?.trim();
  if (!ibcmdPath) {
    return { status: 'skipped', exitCode: null, logSnippet: '' };
  }
  const configPath = process.env.IBCMD_INFOBASE_CONFIG?.trim();
  if (!configPath || !fs.existsSync(configPath)) {
    return { status: 'skipped', exitCode: null, logSnippet: 'IBCMD_INFOBASE_CONFIG not set or missing.' };
  }
  const clientExe = resolvePlatformClientForIbcmd(ibcmdPath);
  if (!clientExe) {
    return {
      status: 'skipped',
      exitCode: null,
      logSnippet: `No 1cv8c/1cv8 client executable found next to ${ibcmdPath}.`,
    };
  }
  const { fileDbPath } = resolveConnectionArgsFromConfigYaml(configPath);
  if (!fileDbPath) {
    return {
      status: 'skipped',
      exitCode: null,
      logSnippet: 'Startup check requires a file infobase (file: in IBCMD_INFOBASE_CONFIG).',
    };
  }
  const user = process.env.IBCMD_USER?.trim();
  const password = process.env.IBCMD_PASSWORD?.trim();
  const startupTimeoutMs = Number.parseInt(process.env.IBMATRIX_STARTUP_READY_TIMEOUT_MS ?? '', 10);
  return runNativeTestClientStartupCheck({
    fileDbPath,
    user,
    password,
    platformPath: clientExe,
    waitTimeoutMs: Number.isFinite(startupTimeoutMs) && startupTimeoutMs > 0
      ? startupTimeoutMs
      : undefined,
  }, dependencies);
}

