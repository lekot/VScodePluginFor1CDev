import { spawn, type ChildProcess } from 'child_process';
import type { IbcmdConsoleOutputEncoding } from './ibcmdConsoleEncodingTypes';
import { createIbcmdStreamChunkDecoders } from './consoleStreamDecoder';
import {
  envForIbcmdExplicitConfigSpawn,
  ibcmdArgvImpliesExplicitOfflineConnection,
} from './ibcmdSpawnEnv';
import type { ProcessTreeTerminationOutcome } from './processTreeTermination';
import {
  RingBufferText,
  STREAMING_PROCESS_RING_BUFFER_MAX_BYTES,
  runStreamingProcess,
  type DisposableLike,
  type StreamCancellation,
} from '../process/streamingProcessRunner';

export const IBCMD_STREAM_RING_BUFFER_MAX_BYTES = STREAMING_PROCESS_RING_BUFFER_MAX_BYTES;

export interface IDisposable extends DisposableLike {}

export interface IbcmdStreamCancellation extends StreamCancellation {}

export interface IbcmdStreamingRunnerOptions {
  executablePath: string;
  args: string[];
  timeoutMs: number;
  cancellation: IbcmdStreamCancellation;
  consoleOutputEncoding?: IbcmdConsoleOutputEncoding;
  onStreamChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Additional exact values to remove from live output before any callback. */
  redactedValues?: readonly string[];
  ringBufferMaxBytes?: number;
  spawnImpl?: typeof spawn;
  abortPattern?: RegExp;
  terminationGraceMs?: number;
  terminateProcessTreeImpl?: (
    child: ChildProcess,
    graceMs: number
  ) => Promise<ProcessTreeTerminationOutcome>;
}

export interface IbcmdStreamingRawOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  combinedLog: string;
  logTruncated: boolean;
  cancelled: boolean;
  timedOut: boolean;
  spawnErrorCode?: string;
  spawnErrorMessage?: string;
  abortPatternMatched?: boolean;
  termination?: ProcessTreeTerminationOutcome;
}

export { RingBufferText };

/**
 * Compatibility adapter over the generic streaming process runner.
 * Ibcmd-specific decoding and environment isolation remain here intentionally.
 */
export async function runIbcmdStreaming(
  options: IbcmdStreamingRunnerOptions
): Promise<IbcmdStreamingRawOutcome> {
  const outcome = await runStreamingProcess({
    executablePath: options.executablePath,
    args: options.args,
    timeoutMs: options.timeoutMs,
    cancellation: options.cancellation,
    streamDecoders: createIbcmdStreamChunkDecoders(
      options.consoleOutputEncoding ?? 'auto'
    ),
    ...(options.onStreamChunk ? { onStreamChunk: options.onStreamChunk } : {}),
    redactedValues: collectIbcmdSecrets(options.args, options.redactedValues),
    ...(options.ringBufferMaxBytes !== undefined
      ? { ringBufferMaxBytes: options.ringBufferMaxBytes }
      : {}),
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
    ...(options.abortPattern ? { abortPattern: options.abortPattern } : {}),
    ...(options.terminationGraceMs !== undefined
      ? { terminationGraceMs: options.terminationGraceMs }
      : {}),
    ...(options.terminateProcessTreeImpl
      ? { terminateProcessTreeImpl: options.terminateProcessTreeImpl }
      : {}),
    ...(ibcmdArgvImpliesExplicitOfflineConnection(options.args)
      ? { spawnOptions: { env: envForIbcmdExplicitConfigSpawn() } }
      : {}),
  });
  const {
    started: _started,
    effectPossible: _effectPossible,
    ...publicOutcome
  } = outcome;
  return publicOutcome;
}

function collectIbcmdSecrets(
  args: readonly string[],
  additionalValues: readonly string[] = [],
): readonly string[] {
  const secrets = new Set(additionalValues.filter((value) => value.length > 0));
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const normalizedArgument = argument.toLowerCase();
    if (normalizedArgument.startsWith('--password=')) {
      const inlinePassword = argument.slice('--password='.length);
      if (inlinePassword.length > 0) {
        secrets.add(inlinePassword);
      }
    } else if (normalizedArgument === '--password') {
      const nextArgument = args[index + 1];
      if (nextArgument) {
        secrets.add(nextArgument);
      }
      if (nextArgument !== undefined) {
        index += 1;
      }
    }
  }
  return [...secrets];
}
