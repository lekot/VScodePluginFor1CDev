import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodeConsoleStreamAuto } from '../../src/services/ibcmd/consoleStreamDecoder';
import type { NativeFormsConnector, NativeFormsSession } from '../../src/services/forms/nativeFormsSession';
import {
  NativeTestClientLifecycleService,
  type NativeTestClientChild,
  type NativeTestClientLaunchHandle,
  type NativeTestClientLifecycleDeps,
  type NativeTestClientLaunchRequest,
} from '../../src/services/forms/nativeTestClientLifecycle';
import { connectNativeTestClient } from '../../src/services/forms/nativeTestClient';
import {
  terminateProcessTree,
  type ProcessTreeTerminationOutcome,
} from '../../src/services/ibcmd/processTreeTermination';
import type { InfobaseEntry } from '../../src/infobases/models/infobaseEntry';
import type { IbcmdStepOutcome } from './ibcmdAdapter';

const LOG_MAX = 8000;
const DEFAULT_READY_TIMEOUT_MS = 90_000;
const MAX_READY_TIMEOUT_MS = 120_000;
const NATIVE_RPC_TIMEOUT_MS = 15_000;
const STARTUP_ERROR_PATTERN = /\[\s*(?:ERROR|FATAL)\s*\]|\b(?:fatal|startup failed|license unavailable)\b|ошибк[а-яё]*/i;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NativeStartupLifecycle = Pick<NativeTestClientLifecycleService, 'start'>;

export interface NativeTestClientStartupDependencies {
  platform?: NodeJS.Platform;
  lifecycleFactory?: (dependencies: NativeTestClientLifecycleDeps) => NativeStartupLifecycle;
  spawnProcess?: (exe: string, args: string[]) => ChildProcess;
  connectNativeClient?: NativeFormsConnector;
  terminateProcessTree?: (child: ChildProcess) => Promise<ProcessTreeTerminationOutcome>;
  createOutLogPath?: () => string;
  readOutLog?: (filePath: string) => string;
  removeOutLog?: (filePath: string) => void;
}

export interface NativeTestClientStartupRequest {
  fileDbPath: string;
  user?: string;
  password?: string;
  platformPath?: string;
  waitTimeoutMs?: number;
}

/**
 * Confirms that a matrix file infobase accepts a native TestClient attach and returns its main window.
 * This is a narrow readiness signal; it does not exercise every application startup scenario.
 */
export async function runNativeTestClientStartupCheck(
  request: NativeTestClientStartupRequest,
  dependencies: NativeTestClientStartupDependencies = {},
): Promise<IbcmdStepOutcome> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') {
    return {
      status: 'skipped',
      exitCode: null,
      logSnippet: 'Native TestClient startup readiness is supported only on Windows.',
    };
  }
  if (!request.fileDbPath.trim()) {
    return { status: 'failed', exitCode: null, logSnippet: 'The file infobase path is empty.' };
  }

  const outLogPath = (dependencies.createOutLogPath ?? defaultOutLogPath)();
  let ownedChild: ChildProcess | undefined;
  let launchHandle: NativeTestClientLaunchHandle | undefined;
  let session: NativeFormsSession | undefined;
  let outcome: IbcmdStepOutcome = { status: 'failed', exitCode: null, logSnippet: '' };
  const cleanupErrors: string[] = [];

  const lifecycleDependencies: NativeTestClientLifecycleDeps = {
    platform,
    spawnProcess: (exe, args) => {
      const child = (dependencies.spawnProcess ?? spawnNativeProcess)(exe, [
        ...args,
        '/DisableStartupDialogs',
        '/DisableStartupMessages',
        '/Out',
        outLogPath,
      ]);
      ownedChild = child;
      return child as NativeTestClientChild;
    },
  };
  const lifecycle = (dependencies.lifecycleFactory ?? ((deps) => new NativeTestClientLifecycleService(deps)))(
    lifecycleDependencies,
  );
  const launchRequest: NativeTestClientLaunchRequest = {
    entry: createFileInfobaseEntry(request),
    user: request.user,
    password: request.password,
    platformPath: request.platformPath,
    waitTimeoutMs: boundedReadyTimeout(request.waitTimeoutMs),
  };

  try {
    launchHandle = await lifecycle.start(launchRequest);
    ownedChild ??= launchHandle.child as ChildProcess;
    assertNoExplicitStartupError(readStartupLog(outLogPath, dependencies));

    session = await (dependencies.connectNativeClient ?? connectNativeTestClient)({
      host: '127.0.0.1',
      port: launchHandle.port,
      platformVersion: launchHandle.platformVersion,
      timeoutMs: NATIVE_RPC_TIMEOUT_MS,
    });
    assertNoExplicitStartupError(readStartupLog(outLogPath, dependencies));

    const overview = await session.execute(
      { action: 'overview', maxDepth: 0, maxNodes: 1 },
      { timeoutMs: NATIVE_RPC_TIMEOUT_MS },
    );
    const mainWindow = getConfirmedMainWindow(overview);
    if (!mainWindow) {
      throw new Error('Native TestClient overview did not return a confirmed MainFrame window.');
    }
    assertNoExplicitStartupError(readStartupLog(outLogPath, dependencies));
    outcome = {
      status: 'executed',
      exitCode: 0,
      logSnippet: `TestClient attach and overview confirmed: MainFrame "${mainWindow.text.trim()}" (PID ${launchHandle.pid}, port ${launchHandle.port}, platform ${launchHandle.platformVersion}).`,
    };
  } catch (error) {
    const code = errorCode(error);
    const detail = errorMessage(error);
    outcome = code === 'TESTCLIENT_UNSUPPORTED_PLATFORM' || code === 'TESTCLIENT_PLATFORM_NOT_FOUND'
      ? { status: 'skipped', exitCode: null, logSnippet: `Native TestClient is unavailable in this environment: ${detail}` }
      : { status: 'failed', exitCode: null, logSnippet: `${code ? `${code}: ` : ''}${detail}` };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (error) {
        cleanupErrors.push(`Failed to close native TestClient session: ${errorMessage(error)}`);
      }
    }

    const child = ownedChild ?? (launchHandle?.child as ChildProcess | undefined);
    if (child) {
      try {
        const termination = await (dependencies.terminateProcessTree ?? terminateProcessTree)(child);
        if (!termination.terminated || termination.survivingPids.length > 0) {
          cleanupErrors.push(
            `TestClient process tree did not terminate (surviving PIDs: ${termination.survivingPids.join(', ') || 'unknown'}).`,
          );
        }
        if (termination.errors.length > 0) {
          cleanupErrors.push(...termination.errors.map((message) => `Process cleanup: ${message}`));
        }
      } catch (error) {
        cleanupErrors.push(`Failed to terminate TestClient process tree: ${errorMessage(error)}`);
      }
    }

    let finalLog = '';
    try {
      finalLog = readStartupLog(outLogPath, dependencies);
    } catch (error) {
      cleanupErrors.push(`Failed to read /Out startup log: ${errorMessage(error)}`);
    }
    if (containsExplicitStartupError(finalLog)) {
      cleanupErrors.push('The /Out log contains an explicit startup error.');
    }
    if (cleanupErrors.length > 0) {
      outcome = {
        status: 'failed',
        exitCode: null,
        logSnippet: appendDiagnostics(outcome.logSnippet, cleanupErrors, finalLog, outLogPath),
      };
    } else if (outcome.status === 'failed') {
      outcome.logSnippet = appendDiagnostics(outcome.logSnippet, [], finalLog, outLogPath);
    } else if (outcome.status === 'executed') {
      outcome.logSnippet = appendDiagnostics(outcome.logSnippet, [], finalLog);
      try {
        (dependencies.removeOutLog ?? removeOutLog)(outLogPath);
      } catch {
        // A verified startup result does not depend on deleting its temporary diagnostic file.
      }
    }
  }

  return outcome;
}

function createFileInfobaseEntry(request: NativeTestClientStartupRequest): InfobaseEntry {
  return {
    id: 'matrix-startup-readiness',
    name: 'Matrix startup readiness',
    type: 'file',
    filePath: request.fileDbPath,
    hasStoredPassword: false,
    createdAt: new Date().toISOString(),
  };
}

function spawnNativeProcess(exe: string, args: string[]): ChildProcess {
  return spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
}

function defaultOutLogPath(): string {
  return path.join(os.tmpdir(), `matrix-1cv8-startup-${process.pid}-${randomUUID()}.log`);
}

function readStartupLog(filePath: string, dependencies: NativeTestClientStartupDependencies): string {
  if (dependencies.readOutLog) {
    return dependencies.readOutLog(filePath);
  }
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return decodeConsoleStreamAuto(fs.readFileSync(filePath)).trim();
}

function removeOutLog(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function boundedReadyTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_READY_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.min(MAX_READY_TIMEOUT_MS, Math.floor(value)));
}

function assertNoExplicitStartupError(log: string): void {
  if (containsExplicitStartupError(log)) {
    throw new Error(`The /Out log contains an explicit startup error: ${log.slice(0, 1000)}`);
  }
}

function containsExplicitStartupError(log: string): boolean {
  return STARTUP_ERROR_PATTERN.test(log);
}

function getConfirmedMainWindow(result: unknown): { text: string } | undefined {
  if (!result || typeof result !== 'object' || !('activeWindow' in result)) {
    return undefined;
  }
  const window = (result as { activeWindow?: unknown }).activeWindow;
  if (!window || typeof window !== 'object') {
    return undefined;
  }
  const candidate = window as { className?: unknown; ref?: { id?: unknown }; text?: unknown };
  if (
    candidate.className !== 'MainFrame'
    || typeof candidate.ref?.id !== 'string'
    || !GUID_PATTERN.test(candidate.ref.id)
    || typeof candidate.text !== 'string'
    || candidate.text.trim().length === 0
  ) {
    return undefined;
  }
  return { text: candidate.text };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendDiagnostics(base: string, errors: string[], log: string, logPath?: string): string {
  const details = [
    ...errors,
    ...(logPath ? [`/Out log preserved at ${logPath}.`] : []),
    ...(log ? [`/Out log:\n${log}`] : []),
  ];
  return [base, ...details].filter(Boolean).join('\n').slice(0, LOG_MAX);
}
