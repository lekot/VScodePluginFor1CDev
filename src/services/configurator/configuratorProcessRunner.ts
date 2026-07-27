import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import type { ProcessTreeTerminationOutcome } from '../ibcmd/processTreeTermination';
import {
  RingBufferText,
  STREAMING_PROCESS_RING_BUFFER_MAX_BYTES,
  runStreamingProcess,
  type StreamCancellation,
} from '../process/streamingProcessRunner';
import type { ConfiguratorBatchArguments } from './configuratorBatchArgs';

export const DEFAULT_CONFIGURATOR_FATAL_MARKERS: readonly RegExp[] = Object.freeze([
  /(?:^|[\r\n])\s*(?:fatal|exception|error)(?:\s|:|\[)/iu,
  /(?:^|[\r\n])\s*(?:\u043a\u0440\u0438\u0442\u0438\u0447\u0435\u0441\u043a\u0430\u044f\s+)?\u043e\u0448\u0438\u0431\u043a\u0430(?:\s|:|\[)/iu,
  /(?:^|[\r\n])\s*\u0438\u0441\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435(?:\s|:|\[)/iu,
]);

interface ConfiguratorProcessOutcomeBase {
  started: boolean;
  effectPossible: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  combinedLog: string;
  logTruncated: boolean;
  diagnostic: {
    executablePath: string;
    args: readonly string[];
  };
}

export type ConfiguratorProcessOutcome =
  | ConfiguratorProcessOutcomeBase & {
      status: 'acknowledged';
      started: true;
      exitCode: 0;
      signal: null;
    }
  | ConfiguratorProcessOutcomeBase & {
      status: 'failed';
      errorCode:
        | 'CONFIGURATOR_CANCELLED_BEFORE_START'
        | 'CONFIGURATOR_OUTPUT_PREPARE_FAILED'
        | 'CONFIGURATOR_SPAWN_FAILED'
        | 'CONFIGURATOR_EXIT_FAILED'
        | 'CONFIGURATOR_FATAL_MARKER';
      retryable: boolean;
      errorMessage?: string;
    }
  | ConfiguratorProcessOutcomeBase & {
      status: 'inDoubt';
      effectPossible: true;
      errorCode:
        | 'CONFIGURATOR_CANCELLED_AFTER_START'
        | 'CONFIGURATOR_TIMED_OUT_AFTER_START'
        | 'CONFIGURATOR_PROCESS_START_UNCERTAIN'
        | 'CONFIGURATOR_PROCESS_CRASHED'
        | 'CONFIGURATOR_ACKNOWLEDGEMENT_LOST'
        | 'CONFIGURATOR_OUTPUT_UNREADABLE';
      errorMessage?: string;
    };

export interface ConfiguratorProcessRunnerOptions {
  executablePath: string;
  batchArguments: ConfiguratorBatchArguments;
  timeoutMs: number;
  cancellation: StreamCancellation;
  ringBufferMaxBytes?: number;
  fatalMarkers?: readonly RegExp[];
  terminationGraceMs?: number;
  spawnImpl?: typeof spawn;
  terminateProcessTreeImpl?: (
    child: ChildProcess,
    graceMs: number
  ) => Promise<ProcessTreeTerminationOutcome>;
  readOutputFile?: (filePath: string) => Promise<string>;
  removeOutputFile?: (filePath: string) => Promise<void>;
}

/** Runs one hidden, awaited Designer batch command and classifies ambiguous post-start states. */
export async function runConfiguratorProcess(
  options: ConfiguratorProcessRunnerOptions
): Promise<ConfiguratorProcessOutcome> {
  const diagnostic = Object.freeze({
    executablePath: options.executablePath,
    args: Object.freeze([...options.batchArguments.diagnosticArgs]),
  });
  if (options.cancellation.isCancellationRequested) {
    return {
      status: 'failed',
      errorCode: 'CONFIGURATOR_CANCELLED_BEFORE_START',
      retryable: true,
      started: false,
      effectPossible: false,
      exitCode: null,
      signal: null,
      combinedLog: '',
      logTruncated: false,
      diagnostic,
    };
  }
  const removeOutputFile = options.removeOutputFile ?? removeFileIfPresent;
  try {
    await removeOutputFile(options.batchArguments.outputFilePath);
  } catch (error) {
    return {
      status: 'failed',
      errorCode: 'CONFIGURATOR_OUTPUT_PREPARE_FAILED',
      retryable: true,
      errorMessage: redactBatchSecrets(
        errorMessage(error),
        options.batchArguments.executionArgs
      ),
      started: false,
      effectPossible: false,
      exitCode: null,
      signal: null,
      combinedLog: '',
      logTruncated: false,
      diagnostic,
    };
  }

  const fatalMarkers = options.fatalMarkers ?? DEFAULT_CONFIGURATOR_FATAL_MARKERS;
  const stdoutFatalScanner = new FatalMarkerScanner(fatalMarkers);
  const stderrFatalScanner = new FatalMarkerScanner(fatalMarkers);
  const raw = await runStreamingProcess({
    executablePath: options.executablePath,
    args: options.batchArguments.executionArgs,
    timeoutMs: options.timeoutMs,
    cancellation: options.cancellation,
    redactedValues: batchSecrets(options.batchArguments.executionArgs),
    inspectStreamChunk: (chunk, stream) => {
      (stream === 'stdout' ? stdoutFatalScanner : stderrFatalScanner).accept(chunk);
    },
    ...(options.ringBufferMaxBytes !== undefined
      ? { ringBufferMaxBytes: options.ringBufferMaxBytes }
      : {}),
    ...(options.terminationGraceMs !== undefined
      ? { terminationGraceMs: options.terminationGraceMs }
      : {}),
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
    ...(options.terminateProcessTreeImpl
      ? { terminateProcessTreeImpl: options.terminateProcessTreeImpl }
      : {}),
  });

  const readOutputFile = options.readOutputFile ?? readUtf8File;
  let outputFileLog = '';
  let outputReadError: string | undefined;
  try {
    outputFileLog = await readOutputFile(options.batchArguments.outputFilePath);
  } catch (error) {
    outputReadError = redactBatchSecrets(
      errorMessage(error),
      options.batchArguments.executionArgs
    );
  }
  const redactedOutputFileLog = redactBatchSecrets(
    outputFileLog,
    options.batchArguments.executionArgs
  );
  const fatalMarkerMatched = stdoutFatalScanner.matched
    || stderrFatalScanner.matched
    || matchesFatalMarker(redactedOutputFileLog, fatalMarkers);
  const ring = new RingBufferText(
    options.ringBufferMaxBytes ?? STREAMING_PROCESS_RING_BUFFER_MAX_BYTES
  );
  ring.append(raw.combinedLog);
  ring.append(redactedOutputFileLog);
  const retained = ring.state;
  const combinedLog = redactBatchSecrets(retained.text, options.batchArguments.executionArgs);
  const base: ConfiguratorProcessOutcomeBase = {
    started: raw.started,
    effectPossible: raw.effectPossible,
    exitCode: raw.exitCode,
    signal: raw.signal,
    combinedLog,
    logTruncated: raw.logTruncated || retained.truncated,
    diagnostic,
  };
  const processErrorMessage = raw.spawnErrorMessage
    ? redactBatchSecrets(raw.spawnErrorMessage, options.batchArguments.executionArgs)
    : undefined;

  if (!raw.effectPossible) {
    if (raw.cancelled) {
      return {
        ...base,
        status: 'failed',
        errorCode: 'CONFIGURATOR_CANCELLED_BEFORE_START',
        retryable: true,
      };
    }
    return {
      ...base,
      status: 'failed',
      errorCode: 'CONFIGURATOR_SPAWN_FAILED',
      retryable: true,
      ...(processErrorMessage ? { errorMessage: processErrorMessage } : {}),
    };
  }

  if (raw.cancelled) {
    return {
      ...base,
      status: 'inDoubt',
      effectPossible: true,
      errorCode: 'CONFIGURATOR_CANCELLED_AFTER_START',
      ...(processErrorMessage ? { errorMessage: processErrorMessage } : {}),
    };
  }
  if (raw.timedOut) {
    return {
      ...base,
      status: 'inDoubt',
      effectPossible: true,
      errorCode: 'CONFIGURATOR_TIMED_OUT_AFTER_START',
      ...(processErrorMessage ? { errorMessage: processErrorMessage } : {}),
    };
  }
  if (!raw.started) {
    return {
      ...base,
      status: 'inDoubt',
      effectPossible: true,
      errorCode: 'CONFIGURATOR_PROCESS_START_UNCERTAIN',
      ...(processErrorMessage ? { errorMessage: processErrorMessage } : {}),
    };
  }
  if (raw.signal !== null || raw.spawnErrorCode) {
    return {
      ...base,
      status: 'inDoubt',
      started: true,
      effectPossible: true,
      errorCode: 'CONFIGURATOR_PROCESS_CRASHED',
      ...(processErrorMessage ? { errorMessage: processErrorMessage } : {}),
    };
  }
  if (raw.exitCode === null) {
    return {
      ...base,
      status: 'inDoubt',
      started: true,
      effectPossible: true,
      errorCode: 'CONFIGURATOR_ACKNOWLEDGEMENT_LOST',
    };
  }
  if (raw.exitCode !== 0) {
    return {
      ...base,
      status: 'failed',
      errorCode: 'CONFIGURATOR_EXIT_FAILED',
      retryable: true,
      ...(outputReadError ? { errorMessage: outputReadError } : {}),
    };
  }
  if (fatalMarkerMatched) {
    return {
      ...base,
      status: 'failed',
      errorCode: 'CONFIGURATOR_FATAL_MARKER',
      retryable: false,
    };
  }
  if (outputReadError) {
    return {
      ...base,
      status: 'inDoubt',
      started: true,
      effectPossible: true,
      errorCode: 'CONFIGURATOR_OUTPUT_UNREADABLE',
      errorMessage: outputReadError,
    };
  }
  return {
    ...base,
    status: 'acknowledged',
    started: true,
    effectPossible: true,
    exitCode: 0,
    signal: null,
  };
}

class FatalMarkerScanner {
  private static readonly BOUNDARY_CHARACTERS = 4096;
  private tail = '';
  matched = false;

  constructor(private readonly markers: readonly RegExp[]) {}

  accept(chunk: string): void {
    if (!chunk || this.matched) {
      return;
    }
    const candidate = this.tail + chunk;
    this.matched = matchesFatalMarker(candidate, this.markers);
    this.tail = candidate.slice(-FatalMarkerScanner.BOUNDARY_CHARACTERS);
  }
}

function matchesFatalMarker(log: string, markers: readonly RegExp[]): boolean {
  return markers.some((marker) => {
    marker.lastIndex = 0;
    return marker.test(log);
  });
}

function redactBatchSecrets(log: string, executionArgs: readonly string[]): string {
  return batchSecrets(executionArgs).reduce(
    (redacted, secret) => redacted.split(secret).join('<redacted>'),
    log
  );
}

function batchSecrets(executionArgs: readonly string[]): string[] {
  const secrets: string[] = [];
  for (let index = 0; index < executionArgs.length - 1; index += 1) {
    if (executionArgs[index].toLocaleLowerCase() === '/p' && executionArgs[index + 1]) {
      secrets.push(executionArgs[index + 1]);
    }
  }
  return secrets;
}

async function readUtf8File(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
