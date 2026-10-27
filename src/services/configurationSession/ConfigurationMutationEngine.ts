import * as fs from 'fs';
import * as path from 'path';
import { AtomicFileStorage, hashContent, type AtomicFileSystem } from './atomicFileStorage';
import { assertPathWithinRoot, PathBoundaryError } from './pathBoundary';
import {
  runConfigurationMutation,
  runConfigurationPlan,
  runExclusiveConfigurationOperation,
  type MutationRunner,
  type MutationOutcomeRunner,
  type PlanRunner,
  type PlanOutcomeRunner,
} from './configurationMutationGateway';
import type { MutationOutcome } from './ConfigurationSession';
import { MutationPlan, MutationPlanError } from './mutationPlan';
import { executePlanUnderWriterLease } from './executePlanWriterLease';
import type { ConfigurationCapabilities, ConfigurationContext, ConfigurationId } from './types';
import type { ReconciliationOutcome } from '../../types/reloadContracts';
import {
  ConfigurationContextResolver,
  type ResourceLike,
} from './ConfigurationContextResolver';

export type MutationOutcomeStatus =
  | 'committed'
  | 'conflict'
  | 'rolledBack'
  | 'recoveryRequired'
  | 'inDoubt';

export interface MutationReceipt<T = unknown> {
  readonly status: MutationOutcomeStatus;
  readonly kind: string;
  readonly resourcePath: string;
  readonly configurationId?: ConfigurationId;
  readonly oldRevision?: string;
  readonly newRevision?: string;
  readonly result?: T;
  readonly code?: string;
  readonly message?: string;
  readonly operationId?: string;
  readonly snapshotVersion?: number;
  readonly reconciliation?: ReconciliationOutcome;
  readonly session?: { readonly id: string; readonly generation: number };
}

export interface SingleFileMutationState {
  readonly exists: boolean;
  readonly content: string;
  readonly revision?: string;
}

export interface SingleFileMutationChange<T> {
  readonly content: string;
  readonly result: T;
}

export type SingleFileTransform<T> = (
  state: SingleFileMutationState,
) => Promise<SingleFileMutationChange<T>> | SingleFileMutationChange<T>;

export interface MutationSessionInfo {
  readonly id: string;
  readonly generation: number;
}

export interface MutationIntent {
  readonly kind: string;
  readonly resourcePath?: string;
  readonly expectedConfigurationId?: ConfigurationId;
  /** `null` records that the target was expected to be absent; `undefined` makes no revision assertion. */
  readonly expectedRevision?: string | null;
  readonly session?: MutationSessionInfo;
}

export interface ExecutePlanOptions {
  /** Runs the plan builder only after entering the existing configuration writer lease. */
  readonly buildUnderLease?: boolean;
}

export interface SingleFileMutationIntent extends MutationIntent {
  readonly resourcePath: string;
}

export interface ExternalProcessContext {
  readonly rootPath: string;
  readonly configurationId?: ConfigurationId;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface ConfigurationMutationEngineDeps {
  readonly contextResolver?: ConfigurationContextResolver;
  readonly runMutation?: MutationRunner;
  readonly runPlan?: PlanRunner;
  readonly runMutationWithOutcome?: MutationOutcomeRunner;
  readonly runPlanWithOutcome?: PlanOutcomeRunner;
  readonly fileSystem?: AtomicFileSystem;
}

const fileMutationTails = new Map<string, Promise<void>>();

function getFileMutationKey(filePath: string): string {
  const canonical = path.resolve(filePath);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function hasCommittedFileChange(receipt: MutationReceipt<unknown>): boolean {
  return receipt.status === 'committed' && receipt.oldRevision !== receipt.newRevision;
}

function isUncertainMutationReceipt(receipt: MutationReceipt<unknown> | undefined): boolean {
  return receipt?.status === 'inDoubt' || receipt?.status === 'recoveryRequired';
}

function isRecoveryRequiredError(error: unknown): error is MutationPlanError {
  return error instanceof MutationPlanError && error.code === 'RECOVERY_REQUIRED';
}

function mutationReceiptFromOutcome<T>(
  outcome: MutationOutcome<MutationReceipt<T>>,
  kind: string,
  resourcePath: string,
  configurationId?: ConfigurationId,
  session?: MutationSessionInfo,
): MutationReceipt<T> {
  const metadata = {
    configurationId: outcome.configurationId ?? configurationId,
    operationId: outcome.operationId,
    snapshotVersion: outcome.snapshotVersion,
    ...(outcome.reconciliation ? { reconciliation: outcome.reconciliation } : {}),
  };
  if ('value' in outcome && outcome.value !== undefined) {
    return { ...outcome.value, ...metadata };
  }
  if (outcome.status === 'conflict') {
    return {
      status: 'conflict',
      code: outcome.code,
      message: outcome.error.message,
      kind,
      resourcePath,
      ...metadata,
      session,
    };
  }
  if (outcome.status === 'cancelled') {
    return {
      status: 'rolledBack',
      code: 'CANCELLED',
      message: 'Configuration mutation was cancelled.',
      kind,
      resourcePath,
      ...metadata,
      session,
    };
  }
  const error = 'error' in outcome ? outcome.error : undefined;
  return {
    status: isRecoveryRequiredError(error) ? 'recoveryRequired' : 'rolledBack',
    code: isRecoveryRequiredError(error) ? 'RECOVERY_REQUIRED' : 'MUTATION_FAILED',
    message: error?.message ?? 'Configuration mutation failed.',
    kind,
    resourcePath,
    ...metadata,
    session,
  };
}

async function acquireFileLock(canonicalPath: string): Promise<() => void> {
  const lockKey = getFileMutationKey(canonicalPath);
  const previous = fileMutationTails.get(lockKey) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.then(
    () => gate,
    () => gate,
  );
  fileMutationTails.set(lockKey, tail);

  await previous.catch(() => undefined);
  return () => {
    releaseGate();
    if (fileMutationTails.get(lockKey) === tail) {
      fileMutationTails.delete(lockKey);
    }
  };
}

function isConfigurationContext(target: unknown): target is ConfigurationContext {
  return (
    typeof target === 'object' &&
    target !== null &&
    'configurationId' in target &&
    'rootPath' in target &&
    'capabilities' in target &&
    'session' in target
  );
}

async function findRootPathForFile(filePath: string): Promise<string> {
  let cursor = path.resolve(filePath);
  try {
    const stat = await fs.promises.stat(cursor);
    if (!stat.isDirectory()) {
      cursor = path.dirname(cursor);
    }
  } catch {
    cursor = path.dirname(cursor);
  }
  let depth = 0;
  let firstExistingDir: string | undefined;
  while (depth < 16) {
    let exists = false;
    try {
      const stat = await fs.promises.stat(cursor);
      exists = stat.isDirectory();
      if (exists && !firstExistingDir) {
        firstExistingDir = cursor;
      }
    } catch {
      // Directory does not exist yet
    }

    if (exists) {
      try {
        if (
          (await fs.promises.access(path.join(cursor, 'Configuration.xml')).then(
            () => true,
            () => false,
          )) ||
          (await fs.promises.access(path.join(cursor, 'src', 'Configuration', 'Configuration.mdo')).then(
            () => true,
            () => false,
          ))
        ) {
          return cursor;
        }
      } catch {
        // Continue upwards
      }
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
    depth++;
  }
  return firstExistingDir || path.dirname(path.resolve(filePath));
}

interface ResolvedTargetContext {
  readonly rootPath: string;
  readonly configurationId?: ConfigurationId;
  readonly capabilities?: ConfigurationCapabilities;
  readonly resolutionError?: string;
}

/**
 * Unified mutation facade for configuration modifications (#242).
 *
 * Coordinates:
 * 1. Target resolution to configuration root & ConfigurationId.
 * 2. Configuration-level mutual exclusion via configurationMutationGateway.
 * 3. File-level mutual exclusion via sequencing queues.
 * 4. Optimistic concurrency control (CAS) via content hash verification.
 * 5. Atomic file replacement with fsync & temp file quarantine.
 * 6. Safe atomic create-if-absent with parallel creation collision recovery.
 * 7. Path containment and boundary assertions.
 * 8. Unified outcome taxonomy (committed, conflict, rolledBack, recoveryRequired, inDoubt).
 */
export class ConfigurationMutationEngine {
  constructor(private readonly deps: ConfigurationMutationEngineDeps = {}) {}

  /**
   * Resolves target into configuration identity and capabilities.
   */
  private async resolveTarget(
    target: ResourceLike | ConfigurationContext,
    fallbackResourcePath?: string,
  ): Promise<ResolvedTargetContext> {
    if (isConfigurationContext(target)) {
      return {
        rootPath: target.rootPath,
        configurationId: target.configurationId,
        capabilities: target.capabilities,
      };
    }

    const candidate = fallbackResourcePath ?? target;

    if (this.deps.contextResolver) {
      try {
        const resolved = await this.deps.contextResolver.resolveFromResource(candidate);
        return {
          rootPath: resolved.rootPath,
          configurationId: resolved.configurationId,
          capabilities: resolved.capabilities,
        };
      } catch (error) {
        return {
          rootPath: fallbackResourcePath ?? (typeof target === 'string' ? target : process.cwd()),
          resolutionError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const fallbackPath = fallbackResourcePath ?? (typeof target === 'string' ? target : undefined);
    const rootPath = fallbackPath ? await findRootPathForFile(fallbackPath) : process.cwd();
    return { rootPath };
  }

  /**
   * Transforms a single file atomically with compare-and-swap guarantees.
   */
  async transformFile<T>(
    target: ResourceLike | ConfigurationContext,
    intent: SingleFileMutationIntent,
    transform: SingleFileTransform<T>,
  ): Promise<MutationReceipt<T>> {
    const rawPath = intent.resourcePath || (typeof target === 'string' ? target : undefined);
    if (!rawPath) {
      return {
        status: 'conflict',
        code: 'INVALID_RESOURCE_PATH',
        message: 'Resource path is required for single-file transform.',
        kind: intent.kind,
        resourcePath: '',
        session: intent.session,
      };
    }

    const canonicalTarget = path.resolve(rawPath);
    const resolved = await this.resolveTarget(target, canonicalTarget);

    if (resolved.resolutionError) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_CONTEXT_UNAVAILABLE',
        message: `Не удалось определить конфигурацию для изменения: ${resolved.resolutionError}`,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        session: intent.session,
      };
    }

    if (resolved.capabilities && !resolved.capabilities.write) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_CAPABILITY_UNSUPPORTED',
        message: 'Конфигурация открыта только для чтения.',
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }

    if (
      intent.expectedConfigurationId &&
      resolved.configurationId &&
      intent.expectedConfigurationId !== resolved.configurationId
    ) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_ID_MISMATCH',
        message: 'Идентификатор конфигурации не совпадает с ожидаемым.',
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }

    try {
      await assertPathWithinRoot(resolved.rootPath, canonicalTarget);
    } catch (err) {
      if (err instanceof PathBoundaryError) {
        return {
          status: 'conflict',
          code: 'TARGET_OUTSIDE_ROOT',
          message: err.message,
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId: resolved.configurationId,
          session: intent.session,
        };
      }
      throw err;
    }

    const execute = async (): Promise<MutationReceipt<T>> => {
      const releaseLock = await acquireFileLock(canonicalTarget);
      try {
        return await this.executeFileTransform(
          resolved.rootPath,
          canonicalTarget,
          intent,
          transform,
          resolved.configurationId,
        );
      } finally {
        releaseLock();
      }
    };

    if (this.deps.runMutationWithOutcome) {
      const outcome = await this.deps.runMutationWithOutcome(canonicalTarget, intent.kind, execute, {
        commitWhen: (receipt) => receipt.status === 'committed',
        shouldReconcile: (result) => result.status === 'committed'
          ? hasCommittedFileChange(result.value)
          : result.status === 'failed'
            ? isUncertainMutationReceipt(result.value) || isRecoveryRequiredError(result.error)
            : false,
      });
      return mutationReceiptFromOutcome(outcome, intent.kind, canonicalTarget, resolved.configurationId, intent.session);
    }

    const runMut = this.deps.runMutation ?? runConfigurationMutation;
    return runMut(canonicalTarget, intent.kind, execute);
  }

  private async executeFileTransform<T>(
    rootPath: string,
    canonicalTarget: string,
    intent: SingleFileMutationIntent,
    transform: SingleFileTransform<T>,
    configurationId?: ConfigurationId,
  ): Promise<MutationReceipt<T>> {
    let exists = true;
    let rawContent = '';
    try {
      rawContent = await fs.promises.readFile(canonicalTarget, 'utf-8');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        exists = false;
      } else {
        throw err;
      }
    }

    const currentHash = exists ? hashContent(rawContent) : undefined;

    const expectedRevisionMismatch = intent.expectedRevision === null
      ? exists
      : intent.expectedRevision !== undefined && currentHash !== intent.expectedRevision;
    if (expectedRevisionMismatch) {
      return {
        status: 'conflict',
        code: 'STALE_TARGET_REVISION',
        message: 'Файл изменился после чтения; запись отменена.',
        oldRevision: currentHash,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }

    let change: SingleFileMutationChange<T>;
    try {
      change = await transform({ exists, content: rawContent, revision: currentHash });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'rolledBack',
        code: 'TRANSFORM_FAILED',
        message,
        oldRevision: currentHash,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }

    if (exists && change.content === rawContent) {
      return {
        status: 'committed',
        result: change.result,
        oldRevision: currentHash,
        newRevision: currentHash,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }

    const storage = new AtomicFileStorage(rootPath, this.deps.fileSystem);

    if (exists) {
      const outcome = await storage.replace(canonicalTarget, change.content, currentHash!);
      if (outcome.status === 'committed') {
        return {
          status: 'committed',
          result: change.result,
          oldRevision: currentHash,
          newRevision: outcome.newHash,
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId,
          session: intent.session,
        };
      }
      if (outcome.status === 'conflict') {
        return {
          status: 'conflict',
          code: outcome.code,
          message: outcome.message,
          oldRevision: currentHash,
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId,
          session: intent.session,
        };
      }
      if (outcome.status === 'recoveryRequired') {
        return {
          status: 'recoveryRequired',
          code: outcome.code,
          message: outcome.message,
          oldRevision: currentHash,
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId,
          session: intent.session,
        };
      }
      return {
        status: 'rolledBack',
        code: outcome.code,
        message: outcome.message,
        oldRevision: currentHash,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }

    // Missing file creation
    const createOutcome = await storage.createIfAbsent(canonicalTarget, change.content);
    if (createOutcome.status === 'committed') {
      return {
        status: 'committed',
        result: change.result,
        oldRevision: undefined,
        newRevision: createOutcome.newHash,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }
    if (createOutcome.status === 'conflict' && createOutcome.code === 'TARGET_ALREADY_EXISTS') {
      if (intent.expectedRevision === null) {
        return {
          status: 'conflict',
          code: 'STALE_TARGET_REVISION',
          message: 'Файл появился после чтения отсутствующего состояния; создание отменено.',
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId,
          session: intent.session,
        };
      }
      // Parallel creator race: re-read freshly created file and retry transform once
      const freshContent = await fs.promises.readFile(canonicalTarget, 'utf-8');
      const freshHash = hashContent(freshContent);
      let retryChange: SingleFileMutationChange<T>;
      try {
        retryChange = await transform({ exists: true, content: freshContent, revision: freshHash });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: 'rolledBack',
          code: 'TRANSFORM_FAILED',
          message: msg,
          oldRevision: freshHash,
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId,
          session: intent.session,
        };
      }

      const retryOutcome = await storage.replace(canonicalTarget, retryChange.content, freshHash);
      if (retryOutcome.status === 'committed') {
        return {
          status: 'committed',
          result: retryChange.result,
          oldRevision: freshHash,
          newRevision: retryOutcome.newHash,
          kind: intent.kind,
          resourcePath: canonicalTarget,
          configurationId,
          session: intent.session,
        };
      }
      return {
        status: 'conflict',
        code: 'CONCURRENT_CREATE_COLLISION',
        message: `Конфликт создания файла с параллельным процессом: ${canonicalTarget}. ${retryOutcome.message}`,
        oldRevision: freshHash,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }

    if (createOutcome.status === 'conflict') {
      return {
        status: 'conflict',
        code: createOutcome.code,
        message: createOutcome.message,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }
    if (createOutcome.status === 'recoveryRequired') {
      return {
        status: 'recoveryRequired',
        code: createOutcome.code,
        message: createOutcome.message,
        kind: intent.kind,
        resourcePath: canonicalTarget,
        configurationId,
        session: intent.session,
      };
    }
    return {
      status: 'rolledBack',
      code: createOutcome.code,
      message: createOutcome.message,
      kind: intent.kind,
      resourcePath: canonicalTarget,
      configurationId,
      session: intent.session,
    };
  }

  /**
   * Executes a multi-file mutation plan atomically.
   */
  async executePlan<T>(
    target: ResourceLike | ConfigurationContext,
    intent: MutationIntent,
    builder: (snapshot: { rootPath: string; configurationId?: ConfigurationId }) => Promise<MutationPlan<T>> | MutationPlan<T>,
    options?: ExecutePlanOptions,
  ): Promise<MutationReceipt<T>> {
    const resolved = await this.resolveTarget(target);

    if (resolved.resolutionError) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_CONTEXT_UNAVAILABLE',
        message: `Не удалось определить конфигурацию для изменения: ${resolved.resolutionError}`,
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        session: intent.session,
      };
    }

    if (resolved.capabilities && !resolved.capabilities.write) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_CAPABILITY_UNSUPPORTED',
        message: 'Конфигурация открыта только для чтения.',
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }

    if (
      intent.expectedConfigurationId &&
      resolved.configurationId &&
      intent.expectedConfigurationId !== resolved.configurationId
    ) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_ID_MISMATCH',
        message: 'Идентификатор конфигурации не совпадает с ожидаемым.',
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }

    const executeResolvedPlan = async (): Promise<MutationReceipt<T>> => {
      try {
        const plan = await builder({ rootPath: resolved.rootPath, configurationId: resolved.configurationId });
        if (this.deps.runPlanWithOutcome) {
          const outcome = await this.deps.runPlanWithOutcome(resolved.rootPath, plan);
          if (outcome.status === 'committed') {
            return {
              status: 'committed',
              result: outcome.value,
              kind: intent.kind,
              resourcePath: resolved.rootPath,
              configurationId: resolved.configurationId,
              operationId: outcome.operationId,
              snapshotVersion: outcome.snapshotVersion,
              ...(outcome.reconciliation ? { reconciliation: outcome.reconciliation } : {}),
              session: intent.session,
            };
          }
          const error = 'error' in outcome ? outcome.error : undefined;
          if (outcome.status === 'conflict') {
            return {
              status: 'conflict',
              code: outcome.code,
              message: error?.message ?? 'Configuration mutation conflicted.',
              kind: intent.kind,
              resourcePath: resolved.rootPath,
              configurationId: resolved.configurationId,
              operationId: outcome.operationId,
              snapshotVersion: outcome.snapshotVersion,
              ...(outcome.reconciliation ? { reconciliation: outcome.reconciliation } : {}),
              session: intent.session,
            };
          }
          if (outcome.status === 'cancelled') {
            return {
              status: 'rolledBack',
              code: 'CANCELLED',
              message: 'Configuration mutation was cancelled.',
              kind: intent.kind,
              resourcePath: resolved.rootPath,
              configurationId: resolved.configurationId,
              operationId: outcome.operationId,
              snapshotVersion: outcome.snapshotVersion,
              ...(outcome.reconciliation ? { reconciliation: outcome.reconciliation } : {}),
              session: intent.session,
            };
          }
          if (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT') {
            return {
              status: 'conflict',
              code: 'PLAN_CONFLICT',
              message: error.message,
              kind: intent.kind,
              resourcePath: resolved.rootPath,
              configurationId: resolved.configurationId,
              operationId: outcome.operationId,
              snapshotVersion: outcome.snapshotVersion,
              ...(outcome.reconciliation ? { reconciliation: outcome.reconciliation } : {}),
              session: intent.session,
            };
          }
          if (isRecoveryRequiredError(error)) {
            return {
              status: 'recoveryRequired',
              code: 'RECOVERY_REQUIRED',
              message: error!.message,
              kind: intent.kind,
              resourcePath: resolved.rootPath,
              configurationId: resolved.configurationId,
              operationId: outcome.operationId,
              snapshotVersion: outcome.snapshotVersion,
              ...(outcome.reconciliation ? { reconciliation: outcome.reconciliation } : {}),
              session: intent.session,
            };
          }
          return {
            status: 'rolledBack',
            code: error instanceof MutationPlanError ? error.code : 'PLAN_FAILED',
            message: error?.message ?? 'Configuration mutation failed.',
            kind: intent.kind,
            resourcePath: resolved.rootPath,
            configurationId: resolved.configurationId,
            operationId: outcome.operationId,
            snapshotVersion: outcome.snapshotVersion,
            ...(outcome.reconciliation ? { reconciliation: outcome.reconciliation } : {}),
            session: intent.session,
          };
        }
        const runPl = this.deps.runPlan ?? runConfigurationPlan;
        const result = await runPl(resolved.rootPath, plan);
        return {
          status: 'committed',
          result,
          kind: intent.kind,
          resourcePath: resolved.rootPath,
          configurationId: resolved.configurationId,
          session: intent.session,
        };
      } catch (err: unknown) {
        if (err instanceof MutationPlanError) {
          if (err.code === 'PLAN_CONFLICT') {
            return {
              status: 'conflict',
              code: 'PLAN_CONFLICT',
              message: err.message,
              kind: intent.kind,
              resourcePath: resolved.rootPath,
              configurationId: resolved.configurationId,
              session: intent.session,
            };
          }
          if (err.code === 'RECOVERY_REQUIRED') {
            return {
              status: 'recoveryRequired',
              code: 'RECOVERY_REQUIRED',
              message: err.message,
              kind: intent.kind,
              resourcePath: resolved.rootPath,
              configurationId: resolved.configurationId,
              session: intent.session,
            };
          }
          return {
            status: 'rolledBack',
            code: 'PLAN_FAILED',
            message: err.message,
            kind: intent.kind,
            resourcePath: resolved.rootPath,
            configurationId: resolved.configurationId,
            session: intent.session,
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: 'rolledBack',
          code: 'PLAN_FAILED',
          message: msg,
          kind: intent.kind,
          resourcePath: resolved.rootPath,
          configurationId: resolved.configurationId,
          session: intent.session,
        };
      }
    };

    if (options?.buildUnderLease) {
      return executePlanUnderWriterLease({
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        intent,
        executePlan: executeResolvedPlan,
        runMutation: this.deps.runMutation,
        runMutationWithOutcome: this.deps.runMutationWithOutcome,
        receiptFromOutcome: (outcome) => mutationReceiptFromOutcome(
          outcome,
          intent.kind,
          resolved.rootPath,
          resolved.configurationId,
          intent.session,
        ),
      });
    }
    return executeResolvedPlan();
  }

  /**
   * Executes an external subprocess operation under configuration lease.
   */
  async executeExternal<T>(
    target: ResourceLike | ConfigurationContext,
    intent: MutationIntent,
    runner: (context: ExternalProcessContext) => Promise<T>,
  ): Promise<MutationReceipt<T>> {
    const resolved = await this.resolveTarget(target);

    if (resolved.resolutionError) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_CONTEXT_UNAVAILABLE',
        message: `Не удалось определить конфигурацию для изменения: ${resolved.resolutionError}`,
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        session: intent.session,
      };
    }

    if (resolved.capabilities && !resolved.capabilities.process) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_CAPABILITY_UNSUPPORTED',
        message: 'Выполнение процессов не поддерживается для данной конфигурации.',
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }

    if (
      intent.expectedConfigurationId &&
      resolved.configurationId &&
      intent.expectedConfigurationId !== resolved.configurationId
    ) {
      return {
        status: 'conflict',
        code: 'CONFIGURATION_ID_MISMATCH',
        message: 'Идентификатор конфигурации не совпадает с ожидаемым.',
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }

    try {
      const result = await runExclusiveConfigurationOperation(
        resolved.rootPath,
        intent.kind,
        async () => {
          return await runner({
            rootPath: resolved.rootPath,
            configurationId: resolved.configurationId,
            cwd: resolved.rootPath,
          });
        },
      );

      return {
        status: 'committed',
        result,
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCancelled =
        (err instanceof Error && err.name === 'AbortError') ||
        msg.toLowerCase().includes('cancel');

      return {
        status: 'rolledBack',
        code: isCancelled ? 'CANCELLED' : 'PROCESS_FAILED',
        message: msg,
        kind: intent.kind,
        resourcePath: resolved.rootPath,
        configurationId: resolved.configurationId,
        session: intent.session,
      };
    }
  }
}

let defaultMutationEngine: ConfigurationMutationEngine | undefined;

export function getConfigurationMutationEngine(): ConfigurationMutationEngine {
  if (!defaultMutationEngine) {
    defaultMutationEngine = new ConfigurationMutationEngine();
  }
  return defaultMutationEngine;
}

export function setConfigurationMutationEngine(engine: ConfigurationMutationEngine | undefined): void {
  defaultMutationEngine = engine;
}
