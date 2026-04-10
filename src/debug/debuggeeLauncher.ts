import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DebuggeeLauncherOptions {
  /** Absolute path to the directory containing dbgs.exe / 1cv8c.exe. */
  platformBin: string;
  /** Host for the debug server HTTP endpoint. */
  host: string;
  /** Port for the debug server HTTP endpoint. */
  port: number;
}

export interface DebuggeeArgs {
  /** Absolute path to 1cv8c.exe (or 1cv8c on Linux). */
  exe: string;
  /** Base arguments for launching 1C (without /Debug flags). */
  args: string[];
  /** HTTP URL of the debug server, e.g. "http://localhost:1550". */
  debugServerUrl: string;
}

// ---------------------------------------------------------------------------
// Pure helper functions — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Build the argument list for dbgs.exe.
 * On all platforms uses --port=<port>. On non-Windows also adds --addr=<host>
 * so dbgs binds to a specific interface rather than all interfaces.
 */
export function buildDbgsArgs(host: string, port: number): string[] {
  const args: string[] = [`--port=${port}`];
  if (process.platform !== 'win32' && host !== 'localhost' && host !== '127.0.0.1') {
    args.push(`--addr=${host}`);
  }
  return args;
}

/**
 * Append the 1C debug-attach flags to a base argument list.
 * Returns a new array; does not mutate baseArgs.
 */
export function buildDebuggeeArgs(baseArgs: string[], debugServerUrl: string): string[] {
  return [...baseArgs, '/Debug', '-http', '-attach', '/DebuggerURL', debugServerUrl];
}

// ---------------------------------------------------------------------------
// DebuggeeLauncher class
// ---------------------------------------------------------------------------

const DBGS_POLL_INTERVAL_MS = 500;
const DBGS_READY_TIMEOUT_MS = 10_000;
const PROCESS_KILL_TIMEOUT_MS = 2_000;

export class DebuggeeLauncher {
  private _dbgsProcess: ChildProcess | undefined;
  private _debuggeeProcess: ChildProcess | undefined;
  private _externalDbgs = false;
  private _onDbgsExitHandler: ((code: number | null) => void) | undefined;
  private _onDebuggeeExitHandler: ((code: number | null) => void) | undefined;
  private _onDbgsOutputHandler: ((chunk: string, stream: 'stdout' | 'stderr') => void) | undefined;

  /** true if startDbgs() reused an externally-running dbgs rather than spawning its own. */
  get isExternalDbgs(): boolean { return this._externalDbgs; }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Spawn dbgs.exe and wait until it responds on HTTP.
   * Throws if dbgs.exe not found, fails to start, or does not become ready
   * within DBGS_READY_TIMEOUT_MS.
   */
  async startDbgs(opts: DebuggeeLauncherOptions): Promise<void> {
    const dbgsName = process.platform === 'win32' ? 'dbgs.exe' : 'dbgs';
    const dbgsPath = path.join(opts.platformBin, dbgsName);

    if (!fs.existsSync(dbgsPath)) {
      throw new Error(
        `dbgs не найден по пути: ${dbgsPath}. ` +
        `Убедитесь, что platformPath указывает на каталог с исполняемыми файлами платформы.`
      );
    }

    // Preflight: если порт уже отвечает по HTTP — dbgs уже запущен (платформенный сервис
    // или прошлая сессия). Переиспользуем его: не спавним свой, _dbgsProcess остаётся undefined,
    // dispose() не будет убивать чужой процесс.
    if (await this._isPortAlreadyServingDbgs(opts.host, opts.port)) {
      this._externalDbgs = true;
      return;
    }

    const args = buildDbgsArgs(opts.host, opts.port);
    const proc = spawn(dbgsPath, args, {
      detached: false,
      stdio: 'pipe',
      windowsHide: true,
    });

    this._dbgsProcess = proc;

    // Capture dbgs stdout/stderr — без этого диагностика падений теряется (exit code 1 без объяснения).
    const forward = (stream: 'stdout' | 'stderr') => (buf: Buffer | string) => {
      const text = typeof buf === 'string' ? buf : buf.toString('utf8');
      if (text) {
        this._onDbgsOutputHandler?.(text, stream);
      }
    };
    proc.stdout?.on('data', forward('stdout'));
    proc.stderr?.on('data', forward('stderr'));

    proc.on('exit', (code) => {
      this._onDbgsExitHandler?.(code);
    });

    proc.on('error', (_err) => {
      // error event fires before exit — cleanup happens in exit handler
    });

    // Wait for HTTP readiness
    const ready = await this._waitForDbgs(opts.host, opts.port, proc);
    if (!ready) {
      this._killProcess(proc);
      this._dbgsProcess = undefined;
      throw new Error(
        `Сервер отладки (dbgs) не запустился за ${DBGS_READY_TIMEOUT_MS / 1000} секунд. ` +
        `Проверьте, не занят ли порт ${opts.port}.`
      );
    }
  }

  /**
   * Spawn 1cv8c.exe with /Debug flags pointing at the debug server URL.
   */
  async startDebuggee(opts: DebuggeeArgs): Promise<void> {
    const launchArgs = buildDebuggeeArgs(opts.args, opts.debugServerUrl);

    const proc = spawn(opts.exe, launchArgs, {
      detached: false,
      stdio: 'ignore',
      windowsHide: false,
      shell: false,
    });

    this._debuggeeProcess = proc;

    proc.on('exit', (code) => {
      this._onDebuggeeExitHandler?.(code);
    });

    proc.on('error', (_err) => {
      // error event is informational — exit fires next
    });
  }

  /**
   * Kill both processes (debuggee first, then dbgs) and wait for their exit.
   * Swallows all errors — safe to call from finally blocks.
   */
  async dispose(): Promise<void> {
    if (this._debuggeeProcess) {
      await this._killAndWait(this._debuggeeProcess);
      this._debuggeeProcess = undefined;
    }
    if (this._dbgsProcess) {
      await this._killAndWait(this._dbgsProcess);
      this._dbgsProcess = undefined;
    }
  }

  /** Register a handler called when dbgs exits. */
  onDbgsExit(handler: (code: number | null) => void): void {
    this._onDbgsExitHandler = handler;
  }

  /** Register a handler that receives raw dbgs stdout/stderr chunks (UTF-8 best-effort). */
  onDbgsOutput(handler: (chunk: string, stream: 'stdout' | 'stderr') => void): void {
    this._onDbgsOutputHandler = handler;
  }

  /** Register a handler called when the 1C debuggee process exits. */
  onDebuggeeExit(handler: (code: number | null) => void): void {
    this._onDebuggeeExitHandler = handler;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Однократный HTTP-зонд: возвращает true, если кто-то уже отвечает по `/e1crdbg/rdbg`. */
  private async _isPortAlreadyServingDbgs(host: string, port: number): Promise<boolean> {
    const url = `http://${host}:${port}/e1crdbg/rdbg`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(DBGS_POLL_INTERVAL_MS) });
      return res.status < 600;
    } catch {
      return false;
    }
  }

  private async _waitForDbgs(
    host: string,
    port: number,
    proc: ChildProcess
  ): Promise<boolean> {
    const url = `http://${host}:${port}/e1crdbg/rdbg`;
    const deadline = Date.now() + DBGS_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      // If dbgs already exited — no point waiting
      if (proc.exitCode !== null || proc.killed) {
        return false;
      }

      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(DBGS_POLL_INTERVAL_MS) });
        // Any HTTP response — including 404/400 — means dbgs is up.
        // The /e1crdbg/rdbg endpoint only accepts POST with XML body, so a probe
        // GET typically returns 404 or 405 once the server is ready to serve.
        // Carried over from the original debugLauncher.ts implementation,
        // which used the same predicate against a real platform.
        if (res.status < 600) {
          return true;
        }
      } catch {
        // not ready yet — connection refused or timeout
      }

      await new Promise<void>((resolve) => setTimeout(resolve, DBGS_POLL_INTERVAL_MS));
    }

    return false;
  }

  private _killProcess(proc: ChildProcess): void {
    try {
      if (!proc.killed && proc.exitCode === null) {
        proc.kill();
      }
    } catch {
      // swallow
    }
  }

  private async _killAndWait(proc: ChildProcess): Promise<void> {
    if (proc.killed || proc.exitCode !== null) {
      return;
    }

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, PROCESS_KILL_TIMEOUT_MS);

      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });

      this._killProcess(proc);
    });
  }
}
