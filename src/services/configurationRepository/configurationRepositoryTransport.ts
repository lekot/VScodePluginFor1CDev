import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildConfigurationRepositoryBatchArgs,
  formatConfiguratorDiagnosticCommand,
  type ConfiguratorBatchArguments,
} from '../configurator/configuratorBatchArgs';
import {
  resolveConfiguratorExecutable,
  type ConfiguratorExecutableResolution,
} from '../configurator/configuratorExecutableResolver';
import {
  runConfiguratorProcess,
  type ConfiguratorProcessOutcome,
  type ConfiguratorProcessRunnerOptions,
} from '../configurator/configuratorProcessRunner';
import { resolveInfobaseCanonicalIdentity } from '../../infobases/infobaseCanonicalIdentity';
import type { InfobaseEntry } from '../../infobases/models/infobaseEntry';
import type {
  ConfigurationRepositoryOperation,
  ConfigurationRepositoryTransportOutcome,
  ConfigurationRepositoryTransportRequest,
} from './types';

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ConfigurationRepositoryTransportDeps {
  readonly resolveExecutable?: (
    entry: InfobaseEntry,
  ) => ConfiguratorExecutableResolution;
  readonly runProcess?: (options: ConfiguratorProcessRunnerOptions) => Promise<ConfiguratorProcessOutcome>;
  readonly timeoutMs?: number;
  readonly mkdtemp?: typeof fs.mkdtemp;
  readonly rm?: typeof fs.rm;
}

/** Isolated transport: it knows Designer argv/process semantics, not tree or state. */
export class ConfigurationRepositoryTransport {
  constructor(private readonly deps: ConfigurationRepositoryTransportDeps = {}) {}

  async run(
    request: ConfigurationRepositoryTransportRequest,
  ): Promise<ConfigurationRepositoryTransportOutcome> {
    const executable = (this.deps.resolveExecutable ?? defaultResolveExecutable)(request.infobase);
    if (executable.status !== 'resolved') {
      return {
        status: 'failed',
        operation: request.operation,
        errorCode: executable.errorCode,
        message: executable.message,
        retryable: true,
        log: '',
      };
    }

    if (request.infobase.type !== 'file') {
      return {
        status: 'failed',
        operation: request.operation,
        errorCode: 'CONFIGURATOR_TARGET_UNSUPPORTED',
        message: 'Для операций Хранилища поддерживаются только файловые ИБ.',
        retryable: false,
        log: '',
      };
    }

    const identity = await resolveInfobaseCanonicalIdentity(request.infobase);
    if (identity.kind !== 'file' || identity.connectionKind !== 'databasePath') {
      return {
        status: 'failed',
        operation: request.operation,
        errorCode: 'CONFIGURATOR_TARGET_UNSUPPORTED',
        message: 'Не удалось определить физический путь файловой ИБ.',
        retryable: false,
        log: '',
      };
    }

    const tempRoot = await (this.deps.mkdtemp ?? fs.mkdtemp)(path.join(os.tmpdir(), 'cdt-repository-run-'));
    const outputFilePath = path.join(tempRoot, 'designer.log');
    try {
      const batchArguments = buildConfigurationRepositoryBatchArgs({
        operation: operationToBatchOperation(request.operation),
        target: { type: 'file', filePath: identity.resolvedPath },
        outputFilePath,
        repositoryPath: request.binding.repositoryPath,
        repositoryCredentials: {
          user: request.binding.repositoryUser,
          password: request.binding.repositoryPassword,
        },
        ...(request.infobaseCredentials ? { credentials: request.infobaseCredentials } : {}),
        ...(request.target.extensionName ? { extensionName: request.target.extensionName } : {}),
        ...(request.objectListPath ? { objectListPath: request.objectListPath } : {}),
        ...(request.comment ? { comment: request.comment } : {}),
        ...(request.keepLocked !== undefined ? { keepLocked: request.keepLocked } : {}),
        ...(request.force !== undefined ? { force: request.force } : {}),
      });
      const objectFullNames = request.objectListPath
        ? await readRepositoryObjectNames(request.objectListPath)
        : [];
      const outcome = await (this.deps.runProcess ?? runConfiguratorProcess)({
        executablePath: executable.path,
        batchArguments,
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        cancellation: request.cancellation,
      });
      return mapOutcome(request.operation, outcome, batchArguments, executable.path, objectFullNames);
    } catch (error) {
      return {
        status: 'failed',
        operation: request.operation,
        errorCode: 'CONFIGURATOR_BATCH_ARGUMENTS_INVALID',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        log: '',
      };
    } finally {
      await (this.deps.rm ?? fs.rm)(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function defaultResolveExecutable(entry: InfobaseEntry): ConfiguratorExecutableResolution {
  return resolveConfiguratorExecutable(entry);
}

function operationToBatchOperation(
  operation: ConfigurationRepositoryOperation,
): Extract<
  import('../configurator/configuratorBatchArgs').ConfiguratorBatchOperation,
  `repository${string}`
> {
  const map: Record<ConfigurationRepositoryOperation, Extract<
    import('../configurator/configuratorBatchArgs').ConfiguratorBatchOperation,
    `repository${string}`
  >> = {
    bind: 'repositoryBind',
    unbind: 'repositoryUnbind',
    lock: 'repositoryLock',
    unlock: 'repositoryUnlock',
    commit: 'repositoryCommit',
    updateObject: 'repositoryUpdateObject',
    updateConfiguration: 'repositoryUpdateConfiguration',
  };
  return map[operation];
}

function mapOutcome(
  operation: ConfigurationRepositoryOperation,
  outcome: ConfiguratorProcessOutcome,
  args: ConfiguratorBatchArguments,
  executablePath: string,
  objectFullNames: readonly string[],
): ConfigurationRepositoryTransportOutcome {
  const log = outcome.combinedLog;
  if (outcome.status === 'acknowledged') {
    return { status: 'acknowledged', operation, log };
  }
  if (outcome.status === 'failed') {
    return {
      status: 'failed',
      operation,
      errorCode: outcome.errorCode,
      message: outcome.errorMessage ?? `Операция ${operation} не запущена.`,
      retryable: outcome.retryable,
      log,
    };
  }
  if (
    outcome.errorCode === 'CONFIGURATOR_EXIT_FAILED'
    && outcome.exitCode !== null
    && outcome.outputFileReadable === true
  ) {
    const objectLabel = objectFullNames.length > 0 ? ` (${objectFullNames.join(', ')})` : '';
    const reason = summarizeRepositoryFailure(outcome.combinedLog)
      || `код выхода ${outcome.exitCode}`;
    return {
      status: 'failed',
      operation,
      errorCode: 'CONFIGURATOR_REPOSITORY_OPERATION_FAILED',
      message: `Операция Хранилища «${operation}»${objectLabel} завершилась ошибкой: ${reason}`,
      retryable: false,
      log,
    };
  }
  return {
    status: 'inDoubt',
    operation,
    errorCode: outcome.errorCode,
    message: outcome.errorMessage
      ?? `Результат операции ${operation} не определён после запуска Конфигуратора.`,
    log: [
      log,
      `Команда: ${formatConfiguratorDiagnosticCommand(executablePath, args)}`,
    ].filter(Boolean).join('\n'),
  };
}

async function readRepositoryObjectNames(filePath: string): Promise<readonly string[]> {
  try {
    const xml = await fs.readFile(filePath, 'utf8');
    return Object.freeze([...new Set(
      [...xml.matchAll(/\bfullName="([^"]+)"/gu)].map((match) => match[1]!).filter(Boolean),
    )]);
  } catch {
    return Object.freeze([]);
  }
}

function summarizeRepositoryFailure(log: string): string {
  const compact = log.replace(/\s+/gu, ' ').trim();
  return compact.length > 1000 ? `${compact.slice(0, 997)}...` : compact;
}
