import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { InfobaseEntry } from '../../infobases/models/infobaseEntry';
import {
  buildConfiguratorDumpExternalArgs,
  buildConfiguratorLoadExternalArgs,
  type ConfiguratorCredentials,
} from '../configurator/configuratorBatchArgs';
import { resolveConfiguratorExecutable } from '../configurator/configuratorExecutableResolver';
import { runConfiguratorProcess, type ConfiguratorProcessRunnerOptions } from '../configurator/configuratorProcessRunner';

export interface ExternalProcessorOperationOptions {
  /** Target EPF or ERF file path */
  externalFilePath: string;
  /** Directory for XML source files */
  directoryPath: string;
  /** File infobase path if available; if omitted, a disposable temp infobase is created */
  infobasePath?: string;
  credentials?: ConfiguratorCredentials;
  format?: 'Hierarchical' | 'Plain';
  timeoutMs?: number;
}

export interface ExternalProcessorResult {
  success: boolean;
  message?: string;
  outputLog?: string;
}

export async function dumpExternalProcessor(
  options: ExternalProcessorOperationOptions
): Promise<ExternalProcessorResult> {
  return runExternalProcessorOperation('dump', options);
}

export async function buildExternalProcessor(
  options: ExternalProcessorOperationOptions
): Promise<ExternalProcessorResult> {
  return runExternalProcessorOperation('load', options);
}

async function runExternalProcessorOperation(
  mode: 'dump' | 'load',
  options: ExternalProcessorOperationOptions
): Promise<ExternalProcessorResult> {
  const ext = path.extname(options.externalFilePath).toLowerCase();
  if (ext !== '.epf' && ext !== '.erf') {
    return {
      success: false,
      message: `Unsupported external processor file extension: '${ext}'. Must be .epf or .erf.`,
    };
  }

  let tempDir: string | undefined;
  let ibPath = options.infobasePath;

  if (!ibPath) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '1cv-ext-proc-'));
    ibPath = path.join(tempDir, '1Cv8.1CD');
    fs.writeFileSync(ibPath, '');
  }

  const dummyEntry: InfobaseEntry = {
    id: 'temp-epf-ib',
    name: 'TempEPF',
    type: 'file',
    filePath: ibPath,
    hasStoredPassword: false,
    createdAt: new Date().toISOString(),
  };

  const executable = resolveConfiguratorExecutable(dummyEntry);
  if (executable.status !== 'resolved') {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return {
      success: false,
      message: `Configurator executable resolution failed: ${executable.message}`,
    };
  }

  const logPath = path.join(
    tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), '1cv-ext-log-')),
    'configurator.log'
  );

  try {
    const batchArgs =
      mode === 'dump'
        ? buildConfiguratorDumpExternalArgs({
            target: { type: 'file', filePath: ibPath },
            outputFilePath: logPath,
            dumpDirectory: options.directoryPath,
            externalFilePath: options.externalFilePath,
            credentials: options.credentials,
            format: options.format,
          })
        : buildConfiguratorLoadExternalArgs({
            target: { type: 'file', filePath: ibPath },
            outputFilePath: logPath,
            sourceDirectory: options.directoryPath,
            externalFilePath: options.externalFilePath,
            credentials: options.credentials,
            format: options.format,
          });

    const processOpts: ConfiguratorProcessRunnerOptions = {
      executablePath: executable.path,
      batchArguments: batchArgs,
      timeoutMs: options.timeoutMs ?? 120000,
      cancellation: {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      },
    };

    const outcome = await runConfiguratorProcess(processOpts);

    let outputLog = '';
    if (fs.existsSync(logPath)) {
      outputLog = fs.readFileSync(logPath, 'utf-8');
    }

    if (outcome.status === 'acknowledged' && outcome.exitCode === 0) {
      return {
        success: true,
        message: mode === 'dump' ? 'Unpacked external processor successfully.' : 'Built external processor successfully.',
        outputLog,
      };
    }

    return {
      success: false,
      message: `Configurator operation failed (${outcome.status}). ${outputLog.slice(-500)}`,
      outputLog,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // quiet cleanup
      }
    }
  }
}
