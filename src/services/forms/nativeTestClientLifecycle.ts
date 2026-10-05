import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { PlatformDetectorDeps, PlatformInstall } from '../platformDetector';
import {
  createDefaultPlatformDetectorDeps,
  discoverPlatformInstallations,
  filterPlatformInstallsForLaunch,
  inferVersionFromExePath,
} from '../platformDetector';
import { buildLaunchArgs } from '../platformLauncher';
import type { InfobaseEntry, InfobaseLaunchSettings } from '../../infobases/models/infobaseEntry';
import {
  discoverNativeTestClientsWithDependencies,
  inspectNativeTestClientPortOwnersWithDependencies,
  type NativeScreenshotDependencies,
  type NativeTestClientEndpoint,
  type NativeTestClientPortOwner,
  NativeScreenshotError,
} from './nativeScreenshot';

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const MAX_READY_TIMEOUT_MS = 120_000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 250;
const STOP_TIMEOUT_MS = 2_000;
const STOP_POLL_MS = 100;

export interface NativeTestClientChild {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: () => void): this;
}

export interface ResolvedTestClientExecutable {
  exe: string;
  platformVersion: string;
}

export interface TestClientExecutableRequest {
  platformPath?: string;
  configuredPlatformPath?: string;
  launchSettings?: InfobaseLaunchSettings;
}

export interface TestClientExecutableResolutionDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  existsSync?: (candidate: string) => boolean;
  statSync?: (candidate: string) => { isDirectory(): boolean };
  detectorDeps?: PlatformDetectorDeps;
  discoverInstalls?: (deps: PlatformDetectorDeps) => PlatformInstall[];
}

export interface NativeTestClientLifecycleDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  getConfiguredPlatformPath?: () => string;
  discoverInstalls?: (deps: PlatformDetectorDeps) => PlatformInstall[];
  discoverTestClients?: (timeoutMs: number, signal?: AbortSignal) => Promise<NativeTestClientEndpoint[]>;
  discoverPortOwners?: (timeoutMs: number, signal?: AbortSignal, targetPort?: number) => Promise<NativeTestClientPortOwner[]>;
  discoveryDependencies?: NativeScreenshotDependencies;
  validateInfobase?: (entry: InfobaseEntry) => string | undefined;
  resolveExecutable?: (
    request: TestClientExecutableRequest,
  ) => ResolvedTestClientExecutable;
  spawnProcess?: (exe: string, args: string[]) => NativeTestClientChild;
  isPortAvailable?: (port?: number) => Promise<number>;
  isProcessRunning?: (pid: number) => boolean;
  now?: () => number;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface NativeTestClientLaunchRequest {
  entry: InfobaseEntry;
  user?: string;
  password?: string;
  platformPath?: string;
  port?: number;
  waitTimeoutMs?: number;
}

export interface NativeTestClientLaunchHandle {
  readonly child: NativeTestClientChild;
  readonly pid: number;
  readonly port: number;
  readonly platformVersion: string;
}

export type NativeTestClientProcessStatus = 'stopped' | 'unknown';

export class NativeTestClientLaunchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly pid?: number,
    readonly port?: number,
    readonly processStatus?: NativeTestClientProcessStatus,
  ) {
    super(message);
    this.name = 'NativeTestClientLaunchError';
  }
}

/** Process discovery and launch lifecycle for a local TestClient, with no UI prompts. */
export class NativeTestClientLifecycleService {
  constructor(private readonly deps: NativeTestClientLifecycleDeps = {}) {}

  async discover(signal?: AbortSignal): Promise<NativeTestClientEndpoint[]> {
    const platform = this.deps.platform ?? process.platform;
    if (platform !== 'win32') {
      throw new NativeTestClientLaunchError(
        'Поиск локального TestClient доступен только в Windows.',
        'TESTCLIENT_UNSUPPORTED_PLATFORM',
      );
    }
    if (signal?.aborted) {
      throw new NativeTestClientLaunchError('Поиск TestClient отменён.', 'REQUEST_CANCELLED');
    }
    try {
      const discover = this.deps.discoverTestClients
        ?? ((timeout, cancellation) => discoverNativeTestClientsWithDependencies(
          timeout,
          { ...this.deps.discoveryDependencies, platform },
          cancellation,
        ));
      return await discover(DISCOVERY_TIMEOUT_MS, signal);
    } catch (error) {
      if (signal?.aborted || isCancelledError(error)) {
        throw new NativeTestClientLaunchError('Поиск TestClient отменён.', 'REQUEST_CANCELLED');
      }
      throw new NativeTestClientLaunchError(
        error instanceof NativeScreenshotError ? error.message : 'Не удалось получить список локальных TestClient.',
        error instanceof NativeScreenshotError ? error.code : 'TESTCLIENT_DISCOVERY_FAILED',
      );
    }
  }

  private async inspectPortOwners(
    targetPort: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<NativeTestClientPortOwner[]> {
    const platform = this.deps.platform ?? process.platform;
    if (platform !== 'win32') {
      throw new NativeTestClientLaunchError(
        'Проверка PID и TCP-порта TestClient доступна только в Windows.',
        'TESTCLIENT_UNSUPPORTED_PLATFORM',
      );
    }
    if (signal?.aborted) {
      throw new NativeTestClientLaunchError('Запуск TestClient отменён.', 'REQUEST_CANCELLED');
    }
    const inspect = this.deps.discoverPortOwners
      ?? ((timeout, cancellation, requestedPort) => inspectNativeTestClientPortOwnersWithDependencies(
        timeout,
        { ...this.deps.discoveryDependencies, platform },
        cancellation,
        requestedPort,
      ));
    try {
      return await inspect(timeoutMs, signal, targetPort);
    } catch (error) {
      if (signal?.aborted || isCancelledError(error)) {
        throw new NativeTestClientLaunchError('Запуск TestClient отменён.', 'REQUEST_CANCELLED');
      }
      throw asLaunchError(error);
    }
  }

  async start(
    request: NativeTestClientLaunchRequest,
    signal?: AbortSignal,
    reportStage?: (message: string) => void,
  ): Promise<NativeTestClientLaunchHandle> {
    const platform = this.deps.platform ?? process.platform;
    if (platform !== 'win32') {
      throw new NativeTestClientLaunchError(
        'Локальный запуск TestClient доступен только в Windows.',
        'TESTCLIENT_UNSUPPORTED_PLATFORM',
      );
    }
    const waitTimeoutMs = request.waitTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1_000 || waitTimeoutMs > MAX_READY_TIMEOUT_MS) {
      throw new NativeTestClientLaunchError(
        `waitTimeoutMs должен быть от 1000 до ${MAX_READY_TIMEOUT_MS} мс.`,
        'INVALID_ARGUMENTS',
      );
    }
    const infobaseError = (this.deps.validateInfobase ?? validateTestClientInfobase)(request.entry);
    if (infobaseError) {
      throw new NativeTestClientLaunchError(infobaseError, 'TESTCLIENT_INVALID_INFOBASE');
    }
    if (signal?.aborted) {
      throw new NativeTestClientLaunchError('Запуск TestClient отменён до старта.', 'REQUEST_CANCELLED');
    }

    const configuredPlatformPath = request.platformPath?.trim()
      ? undefined
      : this.deps.getConfiguredPlatformPath?.();
    const resolver = this.deps.resolveExecutable ?? ((candidate) => resolveTestClientExecutable(
      candidate,
      {
        platform,
        arch: this.deps.arch,
        discoverInstalls: this.deps.discoverInstalls,
      },
    ));
    let resolved: ResolvedTestClientExecutable;
    try {
      resolved = resolver({
        platformPath: request.platformPath,
        configuredPlatformPath,
        launchSettings: request.entry.launchSettings,
      });
    } catch (error) {
      throw asLaunchError(error);
    }

    let port: number;
    try {
      port = await (this.deps.isPortAvailable ?? allocateTestClientPort)(request.port);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
        ? 'TESTCLIENT_PORT_IN_USE'
        : 'TESTCLIENT_PORT_UNAVAILABLE';
      const message = code === 'TESTCLIENT_PORT_IN_USE'
        ? `Порт ${request.port} уже занят; TestClient не запускался.`
        : `Не удалось подготовить TCP-порт${request.port ? ` ${request.port}` : ''}: ${safeErrorMessage(error)}`;
      throw new NativeTestClientLaunchError(message, code, undefined, request.port);
    }
    if (signal?.aborted) {
      throw new NativeTestClientLaunchError('Запуск TestClient отменён до старта.', 'REQUEST_CANCELLED', undefined, port);
    }

    let args: string[];
    try {
      args = [
        ...buildLaunchArgs(request.entry, 'enterprise', 'win32', {
          user: request.user,
          password: request.password,
        }),
        '/TestClient',
        '-TPort',
        String(port),
      ];
    } catch (error) {
      throw new NativeTestClientLaunchError(safeErrorMessage(error), 'TESTCLIENT_INVALID_INFOBASE', undefined, port);
    }

    reportStage?.(`Запуск TestClient на порту ${port}.`);
    let child: NativeTestClientChild;
    try {
      child = (this.deps.spawnProcess ?? spawnNativeTestClient)(resolved.exe, args);
    } catch (error) {
      throw new NativeTestClientLaunchError(
        `Не удалось запустить TestClient: ${safeErrorMessage(error)}`,
        'TESTCLIENT_SPAWN_FAILED',
        undefined,
        port,
      );
    }
    let processError: Error | undefined;
    let exited = false;
    child.once('error', (error) => { processError = error; });
    child.once('exit', () => { exited = true; });
    const pid = child.pid;
    if (!Number.isInteger(pid) || !pid || pid < 1) {
      await this.delay(0, signal).catch(() => undefined);
      throw new NativeTestClientLaunchError(
        `Не удалось получить PID запускаемого TestClient${processError ? `: ${safeErrorMessage(processError)}` : '.'}`,
        'TESTCLIENT_SPAWN_FAILED',
        undefined,
        port,
      );
    }

    const handle: NativeTestClientLaunchHandle = { child, pid, port, platformVersion: resolved.platformVersion };
    const deadline = this.now() + waitTimeoutMs;
    try {
      while (this.now() < deadline) {
        if (signal?.aborted) {
          throw new NativeTestClientLaunchError('Запуск TestClient отменён.', 'REQUEST_CANCELLED', pid, port);
        }
        if (processError) {
          throw new NativeTestClientLaunchError(
            `Процесс TestClient завершил запуск с ошибкой: ${safeErrorMessage(processError)}`,
            'TESTCLIENT_SPAWN_FAILED',
            pid,
            port,
          );
        }
        if (exited) {
          throw new NativeTestClientLaunchError('Процесс TestClient завершился до открытия TCP-порта.', 'TESTCLIENT_EXITED', pid, port);
        }
        const owners = await this.inspectPortOwners(
          port,
          Math.min(DISCOVERY_TIMEOUT_MS, Math.max(1, deadline - this.now())),
          signal,
        );
        if (owners.some((candidate) => candidate.pid === pid && candidate.port === port && candidate.testClient)) {
          reportStage?.(`TestClient PID ${pid} слушает порт ${port}; подключение готово.`);
          return handle;
        }
        if (owners.some((candidate) => candidate.port === port && (candidate.pid !== pid || !candidate.testClient))) {
          throw new NativeTestClientLaunchError(
            `Порт ${port} занял процесс, который не удалось подтвердить как запущенный TestClient.`,
            'TESTCLIENT_PORT_COLLISION',
            pid,
            port,
          );
        }
        await this.delay(Math.min(READY_POLL_MS, Math.max(1, deadline - this.now())), signal);
      }
      throw new NativeTestClientLaunchError(
        `TestClient PID ${pid} не открыл порт ${port} за ${waitTimeoutMs} мс.`,
        'TESTCLIENT_LAUNCH_TIMEOUT',
        pid,
        port,
      );
    } catch (error) {
      const failure = asLaunchError(error);
      const processStatus = await this.stop(handle);
      throw new NativeTestClientLaunchError(
        `${failure.message} ${processStatus === 'stopped'
          ? 'Запущенный процесс остановлен.'
          : `Процесс может оставаться запущенным; PID ${pid}, порт ${port}.`}`,
        failure.code,
        pid,
        port,
        processStatus,
      );
    }
  }

  async stop(handle: NativeTestClientLaunchHandle): Promise<NativeTestClientProcessStatus> {
    const deadline = this.now() + STOP_TIMEOUT_MS;
    try {
      handle.child.kill();
    } catch {
      // Verify below whether the process is still around.
    }
    while (this.now() < deadline) {
      if (!this.isProcessRunning(handle.pid)) {
        return 'stopped';
      }
      await this.delay(STOP_POLL_MS).catch(() => undefined);
    }
    return this.isProcessRunning(handle.pid) ? 'unknown' : 'stopped';
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return (this.deps.delay ?? delay)(milliseconds, signal);
  }

  private isProcessRunning(pid: number): boolean {
    if (this.deps.isProcessRunning) {
      return this.deps.isProcessRunning(pid);
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}

export function resolveTestClientExecutable(
  request: TestClientExecutableRequest,
  dependencies: TestClientExecutableResolutionDeps = {},
): ResolvedTestClientExecutable {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new NativeTestClientLaunchError('Локальный запуск TestClient доступен только в Windows.', 'TESTCLIENT_UNSUPPORTED_PLATFORM');
  }
  const join = path.win32.join;
  const basename = path.win32.basename;
  const exists = dependencies.existsSync ?? fs.existsSync.bind(fs);
  const stat = dependencies.statSync ?? fs.statSync.bind(fs);
  const requestedPath = request.platformPath?.trim();
  const settingsPath = request.configuredPlatformPath?.trim();
  const selectedPath = requestedPath || settingsPath;
  if (selectedPath) {
    const exe = resolveThinPath(selectedPath, { exists, stat, join, basename });
    if (!exe) {
      throw new NativeTestClientLaunchError(
        `${requestedPath ? 'Указанный platformPath' : 'Настройка пути к платформе 1С'} не содержит 1cv8c.exe: ${selectedPath}`,
        'TESTCLIENT_PLATFORM_NOT_FOUND',
      );
    }
    return { exe, platformVersion: inferVersionFromExePath(exe, platform) ?? 'configured' };
  }

  const detectorDeps = dependencies.detectorDeps ?? createDefaultPlatformDetectorDeps();
  const installs = (dependencies.discoverInstalls ?? discoverPlatformInstallations)(detectorDeps);
  const constrained = filterPlatformInstallsForLaunch(installs, request.launchSettings)
    .filter((install) => Boolean(install.thinExe) && exists(install.thinExe!));
  if (request.launchSettings?.platformVersion && constrained.length === 0) {
    throw new NativeTestClientLaunchError(
      `Не найдена версия платформы «${request.launchSettings.platformVersion}» с тонким клиентом 1cv8c.exe. Укажите platformPath или проверьте установку 1С.`,
      'TESTCLIENT_PLATFORM_NOT_FOUND',
    );
  }
  if (request.launchSettings?.bitness && constrained.length === 0) {
    throw new NativeTestClientLaunchError(
      `Не найдена установка платформы разрядности ${request.launchSettings.bitness} с тонким клиентом 1cv8c.exe.`,
      'TESTCLIENT_PLATFORM_NOT_FOUND',
    );
  }
  if (constrained.length === 0) {
    throw new NativeTestClientLaunchError(
      'Не найдена установленная платформа 1С с 1cv8c.exe. Укажите platformPath или настройте путь к платформе.',
      'TESTCLIENT_PLATFORM_NOT_FOUND',
    );
  }

  const versionSorted = [...constrained].sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true, sensitivity: 'base' }),
  );
  const newestVersion = versionSorted[0].version;
  let preferred = versionSorted.filter((install) => install.version === newestVersion);
  const preferredBitness = request.launchSettings?.bitness
    ?? (['x64', 'arm64'].includes(dependencies.arch ?? os.arch()) ? '64' : '32');
  if (!request.launchSettings?.bitness) {
    const sameBitness = preferred.filter((install) => install.bitness === preferredBitness);
    if (sameBitness.length > 0) {
      preferred = sameBitness;
    }
  }
  if (preferred.length !== 1) {
    throw new NativeTestClientLaunchError(
      `Найдено несколько подходящих установок платформы ${newestVersion}; укажите platformPath или platformVersion в настройках базы.`,
      'TESTCLIENT_PLATFORM_AMBIGUOUS',
    );
  }
  return {
    exe: preferred[0].thinExe!,
    platformVersion: preferred[0].version,
  };
}

function resolveThinPath(
  candidate: string,
  helpers: {
    exists: (candidate: string) => boolean;
    stat: (candidate: string) => { isDirectory(): boolean };
    join: (...segments: string[]) => string;
    basename: (candidate: string) => string;
  },
): string | undefined {
  const thinName = '1cv8c.exe';
  const thickName = '1cv8.exe';
  try {
    if (helpers.exists(candidate) && !helpers.stat(candidate).isDirectory()) {
      const base = helpers.basename(candidate).toLowerCase();
      if (base === thinName) {return candidate;}
      if (base === thickName) {
        const sibling = helpers.join(path.win32.dirname(candidate), thinName);
        return helpers.exists(sibling) ? sibling : undefined;
      }
      return undefined;
    }
    if (!helpers.exists(candidate) || !helpers.stat(candidate).isDirectory()) {
      return undefined;
    }
    const candidates = [
      helpers.join(candidate, thinName),
      helpers.join(candidate, 'bin', thinName),
      helpers.join(candidate, thickName),
      helpers.join(candidate, 'bin', thickName),
    ];
    for (const possible of candidates) {
      if (!helpers.exists(possible)) {continue;}
      const base = helpers.basename(possible).toLowerCase();
      if (base === thinName) {return possible;}
      if (base === thickName) {
        const sibling = helpers.join(path.win32.dirname(possible), thinName);
        if (helpers.exists(sibling)) {return sibling;}
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function validateTestClientInfobase(entry: InfobaseEntry): string | undefined {
  if (entry.type === 'server') {
    if (!entry.server?.trim() || !entry.database?.trim()) {
      return 'Для серверной информационной базы требуются непустые server и database.';
    }
    return undefined;
  }
  if (entry.type !== 'file') {
    return 'Для forms.launch поддерживаются только файловые и серверные информационные базы.';
  }
  const filePath = entry.filePath?.trim();
  if (!filePath) {
    return 'Для файловой информационной базы требуется dbPath.';
  }
  const resolvedPath = path.resolve(filePath);
  const markerPath = path.join(resolvedPath, '1Cv8.1CD');
  try {
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      return `Каталог файловой информационной базы не найден: ${resolvedPath}`;
    }
    if (!fs.existsSync(markerPath) || !fs.statSync(markerPath).isFile()) {
      return `В каталоге файловой базы не найден файл 1Cv8.1CD: ${resolvedPath}`;
    }
  } catch {
    return `Не удалось проверить файловую информационную базу: ${resolvedPath}`;
  }
  return undefined;
}

function spawnNativeTestClient(exe: string, args: string[]): NativeTestClientChild {
  return spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  }) as ChildProcess;
}

function allocateTestClientPort(port?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('TCP server returned an invalid address.')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new NativeTestClientLaunchError('Запуск TestClient отменён.', 'REQUEST_CANCELLED'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    const cancel = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new NativeTestClientLaunchError('Запуск TestClient отменён.', 'REQUEST_CANCELLED'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function isCancelledError(error: unknown): boolean {
  return error instanceof NativeTestClientLaunchError && error.code === 'REQUEST_CANCELLED'
    || error instanceof NativeScreenshotError && error.code === 'NATIVE_SCREENSHOT_CANCELLED';
}

function asLaunchError(error: unknown): NativeTestClientLaunchError {
  if (error instanceof NativeTestClientLaunchError) {return error;}
  if (error instanceof NativeScreenshotError) {
    return new NativeTestClientLaunchError(error.message, error.code);
  }
  return new NativeTestClientLaunchError(safeErrorMessage(error), 'TESTCLIENT_LAUNCH_FAILED');
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
