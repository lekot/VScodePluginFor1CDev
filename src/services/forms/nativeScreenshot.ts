import { spawn } from 'child_process';
import * as net from 'net';
import * as path from 'path';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_PIXELS = 16_777_216;
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface NativeTestClientScreenshotOptions {
  host: string;
  port: number;
  file: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NativeTestClientScreenshotResult {
  file: string;
  width: number;
  height: number;
}

export interface NativeScreenshotProcess {
  pid: number;
  name: string;
  commandLine: string;
  createdTicks: string;
}

export interface NativeScreenshotWindow {
  hwnd: string;
  pid: number;
  threadId: number;
  visible: boolean;
  minimized: boolean;
  cloaked: boolean;
  rootOwner: string;
  owner: string;
  zOrder: number;
  active: boolean;
  foreground: boolean;
  rect: { left: number; top: number; right: number; bottom: number };
}

export interface NativeScreenshotDiscovery {
  listenerPids: number[];
  processes: NativeScreenshotProcess[];
  windows: NativeScreenshotWindow[];
}

export interface NativeTestClientEndpoint {
  pid: number;
  port: number;
}

export interface NativeTestClientPortOwner extends NativeTestClientEndpoint {
  testClient: boolean;
  /** Internal process creation identity for safe follow-up operations; never returned by forms.discover. */
  createdTicks?: string;
}

interface NativeTestClientProcessDiscovery {
  listenerPorts: Array<{ pid: number; port: number }>;
  processes: NativeScreenshotProcess[];
}

export class NativeScreenshotError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'NativeScreenshotError';
  }
}

export interface NativeScreenshotDependencies {
  platform?: NodeJS.Platform;
  runPowerShell?: (script: string, timeoutMs: number, signal?: AbortSignal) => Promise<string>;
}

/** Lists local Windows TestClient listeners without returning their command lines. */
export async function discoverNativeTestClientsWithDependencies(
  timeoutMs = 15_000,
  dependencies: NativeScreenshotDependencies = {},
  signal?: AbortSignal,
): Promise<NativeTestClientEndpoint[]> {
  const owners = await inspectNativeTestClientPortOwnersWithDependencies(timeoutMs, dependencies, signal);
  return owners
    .filter((owner) => owner.testClient)
    .map(({ pid, port }) => ({ pid, port }));
}

/** Internal readiness inventory that never includes executable paths or command lines. */
export async function inspectNativeTestClientPortOwnersWithDependencies(
  timeoutMs = 15_000,
  dependencies: NativeScreenshotDependencies = {},
  signal?: AbortSignal,
  targetPort?: number,
): Promise<NativeTestClientPortOwner[]> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new NativeScreenshotError('NATIVE_TESTCLIENT_UNSUPPORTED_PLATFORM', 'Поиск локального TestClient доступен только в Windows.');
  }
  if (targetPort !== undefined && (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)) {
    throw new NativeScreenshotError('NATIVE_TESTCLIENT_INVALID_PORT', 'TCP-порт TestClient должен быть от 1 до 65535.');
  }
  const runner = dependencies.runPowerShell ?? runPowerShell;
  const output = await runner(buildProcessDiscoveryScript(targetPort), timeoutMs, signal);
  const discovery = parseProcessDiscovery(output);
  const endpoints = new Map<string, NativeTestClientPortOwner>();
  for (const listener of discovery.listenerPorts) {
    const processInfo = discovery.processes.find((candidate) => candidate.pid === listener.pid);
    endpoints.set(`${listener.pid}:${listener.port}`, {
      pid: listener.pid,
      port: listener.port,
      testClient: Boolean(processInfo && isNativeTestClientProcess(processInfo, listener.port)),
      ...(processInfo ? { createdTicks: processInfo.createdTicks } : {}),
    });
  }
  return [...endpoints.values()].sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** Captures a local Windows TestClient window without activating or restoring it. */
export async function captureNativeTestClientScreenshot(
  options: NativeTestClientScreenshotOptions,
): Promise<NativeTestClientScreenshotResult> {
  return captureNativeTestClientScreenshotWithDependencies(options, {});
}

/** Dependency seam for validating the adapter without requiring a live Windows desktop. */
export async function captureNativeTestClientScreenshotWithDependencies(
  options: NativeTestClientScreenshotOptions,
  dependencies: NativeScreenshotDependencies,
): Promise<NativeTestClientScreenshotResult> {
  const platform = dependencies.platform ?? process.platform;
  const validated = validateOptions(options, platform);
  const runner = dependencies.runPowerShell ?? runPowerShell;
  const deadline = Date.now() + validated.timeoutMs;

  throwIfAborted(options.signal);
  const discoveryText = await runner(buildDiscoveryScript(validated.port), remainingTime(deadline), options.signal);
  const discovery = parseDiscovery(discoveryText);
  const targetProcess = resolveTestClientProcess(discovery, validated.port);
  const anchor = selectTestClientAnchor(discovery.windows, targetProcess.pid);
  const captureLayers = selectTestClientCaptureLayers(discovery.windows, anchor);

  throwIfAborted(options.signal);
  const captureText = await runner(
    buildCaptureScript({
      port: validated.port,
      process: targetProcess,
      anchorHwnd: anchor.hwnd,
      windowSpecs: captureLayers.map((window) => [
        window.hwnd,
        window.rect.left,
        window.rect.top,
        window.rect.right,
        window.rect.bottom,
        window.rootOwner,
      ].join('|')),
      file: validated.file,
    }),
    remainingTime(deadline),
    options.signal,
  );
  const capture = parseCapture(captureText);
  return { file: validated.file, width: capture.width, height: capture.height };
}

/** Allows only explicit loopback names and addresses; native HWND capture cannot target a remote host. */
export function isLocalNativeTestClientHost(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0 || host !== host.trim()) {return false;}
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === 'localhost.') {return true;}
  if (net.isIP(normalized) === 4) {return normalized.startsWith('127.');}
  const mappedAddress = normalized.slice('::ffff:'.length);
  return normalized === '::1'
    || (normalized.startsWith('::ffff:') && net.isIP(normalized) === 6 && net.isIP(mappedAddress) === 4 && mappedAddress.startsWith('127.'));
}

/** Resolves the listener PID and proves that its process is a TestClient for this exact port. */
export function resolveTestClientProcess(
  discovery: NativeScreenshotDiscovery,
  port: number,
): NativeScreenshotProcess {
  const listenerPids = [...new Set(discovery.listenerPids)];
  if (listenerPids.length === 0) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_CLIENT_NOT_FOUND', `На локальном порту ${port} нет слушателя TestClient.`);
  }
  if (listenerPids.length !== 1) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_CLIENT_AMBIGUOUS', `С портом ${port} связано несколько процессов.`);
  }

  const targetPid = listenerPids[0];
  if (!Number.isInteger(targetPid) || targetPid <= 0) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_CLIENT_NOT_FOUND', `Не удалось определить PID слушателя порта ${port}.`);
  }
  const candidate = discovery.processes.find((item) => item.pid === targetPid);
  if (!candidate) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_CLIENT_NOT_FOUND', `Процесс слушателя порта ${port} завершился или недоступен.`);
  }
  if (!isNativeTestClientProcess(candidate, port)) {
    throw new NativeScreenshotError(
      'NATIVE_SCREENSHOT_CLIENT_NOT_FOUND',
      `Порт ${port} принадлежит не процессу 1С TestClient с параметрами /TESTCLIENT и -TPort ${port}.`,
    );
  }
  if (!/^\d+$/.test(candidate.createdTicks)) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_CLIENT_CHANGED', 'Не удалось закрепить экземпляр процесса TestClient по времени запуска.');
  }
  return candidate;
}

/** Selects the active/root window by process and GUI thread state, never by title text. */
export function selectTestClientAnchor(
  windows: NativeScreenshotWindow[],
  pid: number,
): NativeScreenshotWindow {
  const ownWindows = windows.filter((window) => window.pid === pid && window.visible && !window.cloaked && validRect(window.rect));
  if (ownWindows.length === 0) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_WINDOW_NOT_FOUND', 'У TestClient нет видимого окна в текущем сеансе Windows.');
  }

  const byHandle = new Map(ownWindows.map((window) => [window.hwnd, window]));
  const rootFor = (window: NativeScreenshotWindow): NativeScreenshotWindow =>
    byHandle.get(window.rootOwner) ?? window;
  const foregroundRoots = uniqueWindows(ownWindows.filter((window) => window.foreground).map(rootFor));
  const activeRoots = uniqueWindows(ownWindows.filter((window) => window.active).map(rootFor));
  const roots = foregroundRoots.length > 0 ? foregroundRoots : activeRoots;
  if (roots.length > 1) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_WINDOW_AMBIGUOUS', 'Не удалось однозначно определить активное окно TestClient.');
  }

  let anchor = roots[0];
  if (!anchor) {
    const visibleRoots = uniqueWindows(ownWindows.filter((window) => !window.rootOwner || window.rootOwner === window.hwnd));
    if (visibleRoots.length === 1) {anchor = visibleRoots[0];}
    else if (visibleRoots.length === 0 && ownWindows.length === 1) {anchor = ownWindows[0];}
    else {
      throw new NativeScreenshotError('NATIVE_SCREENSHOT_WINDOW_AMBIGUOUS', 'У TestClient несколько окон, активное окно определить нельзя.');
    }
  }

  if (anchor.minimized) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_WINDOW_MINIMIZED', 'Окно TestClient свёрнуто. Разверните его перед снимком.');
  }
  return anchor;
}

/** Returns the anchor and visible same-process popup layers that can cover it. */
export function selectTestClientCaptureLayers(
  windows: NativeScreenshotWindow[],
  anchor: NativeScreenshotWindow,
): NativeScreenshotWindow[] {
  const layers = windows.filter((window) => {
    if (window.hwnd === anchor.hwnd) {return true;}
    if (window.pid !== anchor.pid || !window.visible || window.cloaked || window.minimized || window.zOrder >= anchor.zOrder) {return false;}
    const related = window.rootOwner === anchor.hwnd || intersects(window.rect, anchor.rect);
    return related && validRect(window.rect);
  });
  const anchorIncluded = layers.some((window) => window.hwnd === anchor.hwnd);
  if (!anchorIncluded) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_WINDOW_NOT_FOUND', 'Окно TestClient исчезло во время подготовки снимка.');
  }
  const ordered = [anchor, ...layers.filter((window) => window.hwnd !== anchor.hwnd).sort((a, b) => b.zOrder - a.zOrder)];
  const rects = ordered.map((window) => window.rect);
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  if ((right - left) * (bottom - top) > MAX_CAPTURE_PIXELS) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_TOO_LARGE', 'Окна TestClient превышают допустимый размер снимка.');
  }
  return ordered;
}

function validateOptions(
  options: NativeTestClientScreenshotOptions,
  platform: NodeJS.Platform,
): Required<Pick<NativeTestClientScreenshotOptions, 'host' | 'port' | 'file' | 'timeoutMs'>> {
  if (platform !== 'win32') {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_UNSUPPORTED_PLATFORM', 'Снимок native TestClient доступен только в Windows.');
  }
  if (!isLocalNativeTestClientHost(options.host)) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_LOCAL_ONLY', 'Снимок доступен только для локального TestClient на localhost.');
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_INVALID_PORT', 'Порт TestClient должен быть целым числом от 1 до 65535.');
  }
  if (typeof options.file !== 'string' || options.file.trim().length === 0) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_INVALID_FILE', 'Укажите путь к файлу PNG для снимка.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_INVALID_TIMEOUT', `Таймаут должен быть целым числом от 1 до ${MAX_TIMEOUT_MS} мс.`);
  }
  return { host: options.host, port: options.port, file: path.resolve(options.file), timeoutMs };
}

export function isNativeTestClientProcess(candidate: NativeScreenshotProcess, port: number): boolean {
  const name = path.win32.basename(candidate.name).toLowerCase();
  if (name !== '1cv8.exe' && name !== '1cv8c.exe') {return false;}
  const args = candidate.commandLine;
  if (!/(?:^|\s)\/TESTCLIENT(?=\s|$)/i.test(args)) {return false;}
  const match = args.match(/(?:^|\s)-TPort(?:\s*=\s*|\s+)(?:"([^"]+)"|'([^']+)'|(\d+))(?=\s|$)/i);
  return Boolean(match && (match[1] ?? match[2] ?? match[3]) === String(port));
}

function uniqueWindows(windows: NativeScreenshotWindow[]): NativeScreenshotWindow[] {
  const unique = new Map<string, NativeScreenshotWindow>();
  for (const window of windows) {unique.set(window.hwnd, window);}
  return [...unique.values()];
}

function validRect(rect: NativeScreenshotWindow['rect']): boolean {
  return Number.isFinite(rect?.left) && Number.isFinite(rect?.top)
    && Number.isFinite(rect?.right) && Number.isFinite(rect?.bottom)
    && rect.right > rect.left && rect.bottom > rect.top
    && (rect.right - rect.left) * (rect.bottom - rect.top) <= MAX_CAPTURE_PIXELS;
}

function intersects(
  left: NativeScreenshotWindow['rect'],
  right: NativeScreenshotWindow['rect'],
): boolean {
  return left.left < right.right && right.left < left.right && left.top < right.bottom && right.top < left.bottom;
}

function parseDiscovery(output: string): NativeScreenshotDiscovery {
  const response = parsePowerShellResponse(output);
  if (!response.ok) {throw response.error;}
  const value = response.value as Partial<NativeScreenshotDiscovery>;
  if (!Array.isArray(value.listenerPids) || !Array.isArray(value.processes) || !Array.isArray(value.windows)) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_INVALID_RESPONSE', 'Windows вернула неполные сведения о TestClient.');
  }
  return value as NativeScreenshotDiscovery;
}

function parseProcessDiscovery(output: string): NativeTestClientProcessDiscovery {
  const response = parsePowerShellResponse(output);
  if (!response.ok) {throw response.error;}
  const value = response.value as Partial<NativeTestClientProcessDiscovery>;
  if (!Array.isArray(value.listenerPorts) || !Array.isArray(value.processes)) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_INVALID_RESPONSE', 'Windows вернула неполные сведения о слушателях TestClient.');
  }
  const listenerPorts = value.listenerPorts.filter((listener): listener is { pid: number; port: number } =>
    Boolean(listener)
    && Number.isInteger((listener as { pid?: unknown }).pid)
    && Number.isInteger((listener as { port?: unknown }).port)
    && (listener as { pid: number }).pid > 0
    && (listener as { port: number }).port >= 1
    && (listener as { port: number }).port <= 65535,
  );
  const processes = value.processes.filter((processInfo): processInfo is NativeScreenshotProcess =>
    Boolean(processInfo)
    && Number.isInteger((processInfo as NativeScreenshotProcess).pid)
    && typeof (processInfo as NativeScreenshotProcess).name === 'string'
    && typeof (processInfo as NativeScreenshotProcess).commandLine === 'string'
    && typeof (processInfo as NativeScreenshotProcess).createdTicks === 'string',
  );
  return { listenerPorts, processes };
}

function parseCapture(output: string): { width: number; height: number } {
  const response = parsePowerShellResponse(output);
  if (!response.ok) {throw response.error;}
  const value = response.value as { width?: unknown; height?: unknown };
  if (!Number.isInteger(value.width) || !Number.isInteger(value.height)
    || (value.width as number) <= 0 || (value.height as number) <= 0
    || (value.width as number) * (value.height as number) > MAX_CAPTURE_PIXELS) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_INVALID_RESPONSE', 'Снимок TestClient имеет некорректные размеры.');
  }
  return { width: value.width as number, height: value.height as number };
}

function parsePowerShellResponse(output: string): { ok: true; value: unknown } | { ok: false; error: NativeScreenshotError } {
  let value: unknown;
  try {
    value = JSON.parse(output.trim().replace(/^\uFEFF/, '')) as unknown;
  } catch {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_INVALID_RESPONSE', 'Не удалось разобрать ответ Windows при создании снимка TestClient.');
  }
  if (!value || typeof value !== 'object') {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_INVALID_RESPONSE', 'Windows вернула пустой ответ при создании снимка TestClient.');
  }
  const response = value as { ok?: unknown; code?: unknown; error?: unknown };
  if (response.ok === true) {return { ok: true, value };}
  const code = typeof response.code === 'string' ? response.code : 'NATIVE_SCREENSHOT_FAILED';
  const message = typeof response.error === 'string' ? response.error : 'Windows не смогла создать снимок TestClient.';
  return { ok: false, error: new NativeScreenshotError(code, message) };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new NativeScreenshotError('NATIVE_SCREENSHOT_CANCELLED', 'Создание снимка TestClient отменено.');
  }
}

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {throw new NativeScreenshotError('NATIVE_SCREENSHOT_TIMEOUT', 'Истёк таймаут создания снимка TestClient.');}
  return remaining;
}

function runPowerShell(script: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const bootstrap = "$source = [System.IO.StreamReader]::new([System.Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8).ReadToEnd(); Invoke-Expression $source";
  const encodedCommand = Buffer.from(bootstrap, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let settled = false;
    let timedOut = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const cancel = (): void => { child.kill(); };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    const fail = (error: NativeScreenshotError): void => {
      if (settled) {return;}
      settled = true;
      cleanup();
      reject(error);
    };
    if (signal?.aborted) {
      child.kill();
      fail(new NativeScreenshotError('NATIVE_SCREENSHOT_CANCELLED', 'Создание снимка TestClient отменено.'));
      return;
    }
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill();
        fail(new NativeScreenshotError('NATIVE_SCREENSHOT_OUTPUT_TOO_LARGE', 'Windows вернула слишком большой ответ при создании снимка.'));
      } else {stdout.push(Buffer.from(chunk));}
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill();
        fail(new NativeScreenshotError('NATIVE_SCREENSHOT_OUTPUT_TOO_LARGE', 'Windows вернула слишком большой диагностический ответ при создании снимка.'));
      } else {stderr.push(Buffer.from(chunk));}
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      fail(new NativeScreenshotError('NATIVE_SCREENSHOT_FAILED', `Не удалось запустить Windows PowerShell: ${error.message}`));
    });
    child.once('close', (code) => {
      if (settled) {return;}
      if (signal?.aborted) {
        fail(new NativeScreenshotError('NATIVE_SCREENSHOT_CANCELLED', 'Создание снимка TestClient отменено.'));
      } else if (timedOut) {
        fail(new NativeScreenshotError('NATIVE_SCREENSHOT_TIMEOUT', 'Истёк таймаут создания снимка TestClient.'));
      } else if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        fail(new NativeScreenshotError(
          'NATIVE_SCREENSHOT_FAILED',
          `Не удалось выполнить захват окна TestClient средствами Windows${detail ? `: ${detail}` : '.'}`,
        ));
      } else {
        settled = true;
        cleanup();
        resolve(Buffer.concat(stdout).toString('utf8'));
      }
    });
    child.stdin.once('error', (error: NodeJS.ErrnoException) => {
      if (!settled) {fail(new NativeScreenshotError('NATIVE_SCREENSHOT_FAILED', `Не удалось передать скрипт Windows PowerShell: ${error.message}`));}
    });
    child.stdin.end(script, 'utf8');
  });
}

function buildDiscoveryScript(port: number): string {
  return `${buildPowerShellPreamble()}
$port = ${port}
try {
  $listenerPids = @((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) | ForEach-Object { [int]$_ })
  $processes = @($listenerPids | ForEach-Object {
    $targetPid = [int]$_
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue
    if ($process) {
      $runtime = [System.Diagnostics.Process]::GetProcessById($targetPid)
      [ordered]@{ pid = $targetPid; name = [string]$process.Name; commandLine = [string]$process.CommandLine; createdTicks = [string]$runtime.StartTime.ToUniversalTime().Ticks }
    }
  })
  $windows = @([NativeScreenshotCapture]::Enumerate() | ForEach-Object {
    [ordered]@{
      hwnd = $_.Hwnd; pid = $_.Pid; threadId = $_.ThreadId; visible = $_.Visible; minimized = $_.Minimized; cloaked = $_.Cloaked
      rootOwner = $_.RootOwner; owner = $_.Owner; zOrder = $_.ZOrder; active = $_.Active; foreground = $_.Foreground
      rect = [ordered]@{ left = $_.Rect.Left; top = $_.Rect.Top; right = $_.Rect.Right; bottom = $_.Rect.Bottom }
    }
  })
  Write-Json ([ordered]@{ ok = $true; listenerPids = @($listenerPids); processes = @($processes); windows = @($windows) })
} catch {
  Write-Json ([ordered]@{ ok = $false; code = 'NATIVE_SCREENSHOT_DISCOVERY_FAILED'; error = $_.Exception.Message })
}`;
}

function buildProcessDiscoveryScript(targetPort?: number): string {
  const listenerQuery = targetPort === undefined
    ? 'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue'
    : `Get-NetTCPConnection -LocalPort ${targetPort} -State Listen -ErrorAction SilentlyContinue`;
  return `${buildPowerShellOutputHelpers()}
try {
  $listenerPorts = @((${listenerQuery} | ForEach-Object {
    [ordered]@{ pid = [int]$_.OwningProcess; port = [int]$_.LocalPort }
  }))
  $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '1cv8c.exe' OR Name = '1cv8.exe'" -ErrorAction SilentlyContinue | Where-Object {
    [string]$_.CommandLine -match '(?i)(?:^|\\s)/TESTCLIENT(?:\\s|$)'
  } | ForEach-Object {
    $targetPid = [int]$_.ProcessId
    try {
      $runtime = [System.Diagnostics.Process]::GetProcessById($targetPid)
      [ordered]@{ pid = $targetPid; name = [string]$_.Name; commandLine = [string]$_.CommandLine; createdTicks = [string]$runtime.StartTime.ToUniversalTime().Ticks }
    } catch {
      # A process may exit between CIM enumeration and the runtime identity check.
    }
  })
  Write-Json ([ordered]@{ ok = $true; listenerPorts = @($listenerPorts); processes = @($processes) })
} catch {
  Write-Json ([ordered]@{ ok = $false; code = 'NATIVE_TESTCLIENT_DISCOVERY_FAILED'; error = $_.Exception.Message })
}`;
}

function buildPowerShellOutputHelpers(): string {
  return `function Write-Json($value) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Depth 8 -Compress))
}`;
}

function buildCaptureScript(input: {
  port: number;
  process: NativeScreenshotProcess;
  anchorHwnd: string;
  windowSpecs: string[];
  file: string;
}): string {
  const targetPathBase64 = Buffer.from(input.file, 'utf8').toString('base64');
  const windowSpecsBase64 = Buffer.from(JSON.stringify(input.windowSpecs), 'utf8').toString('base64');
  return `${buildPowerShellPreamble()}
$port = ${input.port}
$expectedPid = ${input.process.pid}
$expectedTicks = '${input.process.createdTicks}'
$anchorHwnd = '${input.anchorHwnd}'
$targetPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${targetPathBase64}'))
$windowSpecs = [string[]]@([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${windowSpecsBase64}')) | ConvertFrom-Json)
try {
  $listenerPids = @((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) | ForEach-Object { [int]$_ })
  if ($listenerPids.Count -ne 1 -or $listenerPids[0] -ne $expectedPid) { throw [NativeScreenshotCaptureException]::new('NATIVE_SCREENSHOT_CLIENT_CHANGED', 'Процесс, слушающий порт TestClient, изменился во время снимка.') }
  $runtime = [System.Diagnostics.Process]::GetProcessById($expectedPid)
  if ([string]$runtime.StartTime.ToUniversalTime().Ticks -ne $expectedTicks) { throw [NativeScreenshotCaptureException]::new('NATIVE_SCREENSHOT_CLIENT_CHANGED', 'Процесс TestClient завершился или был заменён во время снимка.') }
  $result = [NativeScreenshotCapture]::Capture($expectedPid, $anchorHwnd, $windowSpecs, $targetPath, ${MAX_CAPTURE_PIXELS}, ${MAX_PNG_BYTES})
  Write-Json ([ordered]@{ ok = $true; width = $result.Width; height = $result.Height })
} catch {
  $exception = $_.Exception
  while ($exception.InnerException) { $exception = $exception.InnerException }
  $code = if ($exception -is [NativeScreenshotCaptureException]) { $exception.Code } else { 'NATIVE_SCREENSHOT_FAILED' }
  Write-Json ([ordered]@{ ok = $false; code = $code; error = $exception.Message })
}`;
}

function buildPowerShellPreamble(): string {
  return `$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$stdout = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
[Console]::SetOut($stdout)
$stderr = [System.IO.StreamWriter]::new([Console]::OpenStandardError(), $utf8)
$stderr.AutoFlush = $true
[Console]::SetError($stderr)
$OutputEncoding = $utf8
Add-Type -TypeDefinition @'
${NATIVE_CAPTURE_CSHARP}
'@ -ReferencedAssemblies 'System.Drawing'
function Write-Json($value) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Depth 8 -Compress))
}`;
}

const NATIVE_CAPTURE_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

public sealed class NativeScreenshotCaptureException : Exception {
  public string Code { get; private set; }
  public NativeScreenshotCaptureException(string code, string message) : base(message) { Code = code; }
}

public sealed class NativeScreenshotRect {
  public int Left { get; set; }
  public int Top { get; set; }
  public int Right { get; set; }
  public int Bottom { get; set; }
}

public sealed class NativeScreenshotWindowInfo {
  public string Hwnd { get; set; }
  public int Pid { get; set; }
  public int ThreadId { get; set; }
  public bool Visible { get; set; }
  public bool Minimized { get; set; }
  public bool Cloaked { get; set; }
  public string RootOwner { get; set; }
  public string Owner { get; set; }
  public int ZOrder { get; set; }
  public bool Active { get; set; }
  public bool Foreground { get; set; }
  public NativeScreenshotRect Rect { get; set; }
}

public sealed class NativeScreenshotSize {
  public int Width { get; set; }
  public int Height { get; set; }
}

public static class NativeScreenshotCapture {
  private const uint GA_ROOTOWNER = 3;
  private const uint GW_OWNER = 4;
  private const uint PW_RENDERFULLCONTENT = 2;
  private const uint SRCCOPY = 0x00CC0020;
  private const int DWMWA_CLOAKED = 14;

  [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] private struct GUITHREADINFO {
    public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus;
    public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize;
    public IntPtr hwndCaret; public RECT rcCaret;
  }
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)] private static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError = true)] private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
  [DllImport("user32.dll", SetLastError = true)] private static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("gdi32.dll", SetLastError = true)] private static extern bool BitBlt(IntPtr dst, int x, int y, int width, int height, IntPtr src, int srcX, int srcY, uint rop);
  [DllImport("dwmapi.dll", PreserveSig = true)] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

  public static NativeScreenshotWindowInfo[] Enumerate() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    var result = new List<NativeScreenshotWindowInfo>();
    var foreground = GetForegroundWindow();
    int z = 0;
    EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr _) {
      uint processId;
      uint threadId = GetWindowThreadProcessId(hwnd, out processId);
      var info = new NativeScreenshotWindowInfo {
        Hwnd = HandleText(hwnd), Pid = unchecked((int)processId), ThreadId = unchecked((int)threadId),
        Visible = IsWindowVisible(hwnd), Minimized = IsIconic(hwnd), Cloaked = IsCloaked(hwnd),
        RootOwner = HandleText(GetAncestor(hwnd, GA_ROOTOWNER)), Owner = HandleText(GetWindow(hwnd, GW_OWNER)),
        ZOrder = z++, Active = false, Foreground = false, Rect = ReadRect(hwnd)
      };
      var threadInfo = new GUITHREADINFO { cbSize = Marshal.SizeOf(typeof(GUITHREADINFO)) };
      if (GetGUIThreadInfo(threadId, ref threadInfo) && threadInfo.hwndActive != IntPtr.Zero) {
        info.Active = threadInfo.hwndActive == hwnd || GetAncestor(threadInfo.hwndActive, GA_ROOTOWNER) == GetAncestor(hwnd, GA_ROOTOWNER);
      }
      if (foreground != IntPtr.Zero) {
        info.Foreground = GetAncestor(foreground, GA_ROOTOWNER) == GetAncestor(hwnd, GA_ROOTOWNER);
      }
      result.Add(info);
      return true;
    };
    if (!EnumWindows(callback, IntPtr.Zero)) {
      throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_WINDOW_NOT_FOUND", "Windows не смогла перечислить окна TestClient.");
    }
    GC.KeepAlive(callback);
    return result.ToArray();
  }

  public static NativeScreenshotSize Capture(int pid, string anchorHandle, string[] windowSpecs, string targetPath, int maxPixels, long maxBytes) {
    var windows = Enumerate();
    var anchor = windows.FirstOrDefault(w => w.Hwnd == anchorHandle && w.Pid == pid && w.Visible && !w.Cloaked);
    if (anchor == null) throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_WINDOW_NOT_FOUND", "Окно TestClient исчезло перед захватом.");
    if (anchor.Minimized) throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_WINDOW_MINIMIZED", "Окно TestClient свёрнуто. Разверните его перед снимком.");
    ValidateRect(anchor.Rect, maxPixels);

    var captureWindows = new List<NativeScreenshotWindowInfo> { anchor };
    foreach (var spec in windowSpecs) {
      var fields = spec.Split('|');
      int leftExpected, topExpected, rightExpected, bottomExpected;
      if (fields.Length != 6 || !Int32.TryParse(fields[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out leftExpected)
          || !Int32.TryParse(fields[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out topExpected)
          || !Int32.TryParse(fields[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out rightExpected)
          || !Int32.TryParse(fields[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out bottomExpected))
        throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_WINDOW_CHANGED", "Сведения об окне TestClient изменились перед снимком.");
      var layer = windows.FirstOrDefault(w => w.Hwnd == fields[0] && w.Pid == pid && w.Visible && !w.Cloaked && !w.Minimized);
      if (layer == null || layer.Rect.Left != leftExpected || layer.Rect.Top != topExpected
          || layer.Rect.Right != rightExpected || layer.Rect.Bottom != bottomExpected
          || layer.RootOwner != fields[5])
        throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_WINDOW_CHANGED", "Окно TestClient переместилось или изменилось во время снимка.");
      if (layer.Hwnd != anchor.Hwnd) {
        ValidateRect(layer.Rect, maxPixels);
        captureWindows.Add(layer);
      }
    }
    captureWindows = captureWindows.OrderByDescending(w => w.ZOrder).ToList();
    int left = captureWindows.Min(w => w.Rect.Left), top = captureWindows.Min(w => w.Rect.Top);
    int right = captureWindows.Max(w => w.Rect.Right), bottom = captureWindows.Max(w => w.Rect.Bottom);
    long widthLong = (long)right - left, heightLong = (long)bottom - top;
    if (widthLong <= 0 || heightLong <= 0 || widthLong * heightLong > maxPixels)
      throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_TOO_LARGE", "Окна TestClient превышают допустимый размер снимка.");
    int width = (int)widthLong, height = (int)heightLong;

    using (var canvas = new Bitmap(width, height, PixelFormat.Format32bppRgb)) {
      using (var graphics = Graphics.FromImage(canvas)) {
        graphics.Clear(Color.Black);
        foreach (var window in captureWindows) {
          using (var layer = CaptureLayer(window, windows, pid)) {
            graphics.DrawImageUnscaled(layer, window.Rect.Left - left, window.Rect.Top - top);
          }
        }
      }
      SaveAtomicPng(canvas, targetPath, maxBytes);
    }
    return new NativeScreenshotSize { Width = width, Height = height };
  }

  private static Bitmap CaptureLayer(NativeScreenshotWindowInfo window, NativeScreenshotWindowInfo[] all, int pid) {
    int width = window.Rect.Right - window.Rect.Left, height = window.Rect.Bottom - window.Rect.Top;
    var bitmap = new Bitmap(width, height, PixelFormat.Format32bppRgb);
    bool captured = false;
    using (var graphics = Graphics.FromImage(bitmap)) {
      IntPtr destination = graphics.GetHdc();
      try {
        if (IsOnVirtualScreen(window.Rect) && IsUnobstructed(window, all)) {
          IntPtr desktop = GetDC(IntPtr.Zero);
          try { if (desktop != IntPtr.Zero) captured = BitBlt(destination, 0, 0, width, height, desktop, window.Rect.Left, window.Rect.Top, SRCCOPY); }
          finally { if (desktop != IntPtr.Zero) ReleaseDC(IntPtr.Zero, desktop); }
        }
        if (!captured) captured = PrintWindow(ParseHandle(window.Hwnd), destination, PW_RENDERFULLCONTENT);
      } finally { graphics.ReleaseHdc(destination); }
    }
    if (!captured) {
      bitmap.Dispose();
      throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_CAPTURE_FAILED", "Windows не смогла получить изображение окна или всплывающего окна TestClient.");
    }
    return bitmap;
  }

  private static bool IsUnobstructed(NativeScreenshotWindowInfo window, NativeScreenshotWindowInfo[] all) {
    return !all.Any(other => other.Hwnd != window.Hwnd && other.Visible && !other.Cloaked
      && other.ZOrder < window.ZOrder && Intersects(other.Rect, window.Rect));
  }

  private static bool IsOnVirtualScreen(NativeScreenshotRect rect) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
    int right = left + GetSystemMetrics(78), bottom = top + GetSystemMetrics(79);
    return rect.Left >= left && rect.Top >= top && rect.Right <= right && rect.Bottom <= bottom;
  }

  private static void SaveAtomicPng(Bitmap image, string targetPath, long maxBytes) {
    string fullPath = Path.GetFullPath(targetPath);
    string directory = Path.GetDirectoryName(fullPath);
    if (String.IsNullOrEmpty(directory) || !Directory.Exists(directory))
      throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_INVALID_FILE", "Каталог для файла снимка не существует.");
    string temporaryPath = fullPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
    try {
      using (var stream = new MemoryStream()) {
        image.Save(stream, ImageFormat.Png);
        if (stream.Length > maxBytes) throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_TOO_LARGE", "PNG превышает допустимый размер файла.");
        using (var file = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
          stream.Position = 0;
          stream.CopyTo(file);
          file.Flush(true);
        }
      }
      if (File.Exists(fullPath)) {
        try { File.Replace(temporaryPath, fullPath, null); }
        catch (IOException) {
          if (!File.Exists(fullPath)) File.Move(temporaryPath, fullPath);
          else throw;
        }
      } else {
        try { File.Move(temporaryPath, fullPath); }
        catch (IOException) {
          if (File.Exists(fullPath)) File.Replace(temporaryPath, fullPath, null);
          else throw;
        }
      }
    } catch (NativeScreenshotCaptureException) { throw; }
    catch (Exception ex) {
      throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_WRITE_FAILED", "Не удалось атомарно записать PNG снимка: " + ex.Message);
    } finally {
      try { if (File.Exists(temporaryPath)) File.Delete(temporaryPath); } catch { }
    }
  }

  private static bool IsCloaked(IntPtr hwnd) {
    try { int value; return DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out value, sizeof(int)) == 0 && value != 0; }
    catch { return false; }
  }

  private static NativeScreenshotRect ReadRect(IntPtr hwnd) {
    RECT rect;
    if (!GetWindowRect(hwnd, out rect)) return new NativeScreenshotRect();
    return new NativeScreenshotRect { Left = rect.Left, Top = rect.Top, Right = rect.Right, Bottom = rect.Bottom };
  }

  private static bool IsValidRect(NativeScreenshotRect rect, int maxPixels) {
    long width = (long)rect.Right - rect.Left, height = (long)rect.Bottom - rect.Top;
    return width > 0 && height > 0 && width * height <= maxPixels;
  }

  private static void ValidateRect(NativeScreenshotRect rect, int maxPixels) {
    if (!IsValidRect(rect, maxPixels)) throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_TOO_LARGE", "Размер окна TestClient выходит за допустимый предел.");
  }

  private static bool Intersects(NativeScreenshotRect a, NativeScreenshotRect b) {
    return a.Left < b.Right && b.Left < a.Right && a.Top < b.Bottom && b.Top < a.Bottom;
  }

  private static string HandleText(IntPtr handle) { return handle == IntPtr.Zero ? "0" : handle.ToInt64().ToString(CultureInfo.InvariantCulture); }
  private static IntPtr ParseHandle(string handle) {
    long value;
    if (!Int64.TryParse(handle, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
      throw new NativeScreenshotCaptureException("NATIVE_SCREENSHOT_WINDOW_NOT_FOUND", "Windows вернула некорректный дескриптор окна TestClient.");
    return new IntPtr(value);
  }
}`;
