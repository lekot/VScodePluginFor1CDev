import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { AtomicFileStorage } from './atomicFileStorage';
import { isReadOnlyAssertionStep, MutationPlan, MutationPlanExecutor } from './mutationPlan';
import { MutationPlanError } from './mutationPlan';
import { PathBoundaryError } from './pathBoundary';
import type { ConfigurationIdentity } from './types';
import { WorkspaceRegistryError } from './WorkspaceRegistry';
import type { ReconciliationOutcome } from '../../types/reloadContracts';
import { Logger } from '../../utils/logger';

export interface ConfigurationCommitContext {
  readonly configurationId: ConfigurationIdentity['configurationId'];
  readonly rootPath: string;
  readonly operationId: string;
  readonly snapshotVersion: number;
  readonly kind: string;
}

export type ConfigurationCommitObserver = (
  commit: ConfigurationCommitContext,
) => Promise<ReconciliationOutcome | undefined>;

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

export interface MutationExecutionOptions<T> {
  readonly commitWhen?: (value: T) => boolean;
  /** Defaults to reconciliation for accepted commits. */
  readonly reconcile?: boolean;
  /** Explicitly selects committed, failed-with-value, or uncertain outcomes that require reconciliation. */
  readonly shouldReconcile?: (outcome: MutationOutcome<T>) => boolean;
}

export interface MutationRequest<T> extends MutationExecutionOptions<T> {
  readonly kind: string;
  readonly operationId?: string;
  readonly clientSnapshotVersion?: number;
  readonly cancellation?: CancellationLike;
  readonly execute: (context: {
    operationId: string;
    baseSnapshotVersion: number;
    storage: AtomicFileStorage;
  }) => Promise<T>;
}

export interface ExclusiveConfigurationOperation<T> {
  readonly kind: string;
  readonly operationId?: string;
  readonly clientSnapshotVersion?: number;
  readonly cancellation?: CancellationLike;
  readonly reconcile?: boolean;
  readonly shouldReconcile?: (outcome: MutationOutcome<T>) => boolean;
  readonly execute: () => Promise<T>;
}

export interface ReadRequest<T> {
  readonly cancellation?: CancellationLike;
  readonly execute: (context: {
    snapshotVersion: number;
    rootPath: string;
  }) => Promise<T>;
}

export type ReadOutcome<T> =
  | { status: 'ok'; value: T; snapshotVersion: number; configurationId: ConfigurationIdentity['configurationId'] }
  | { status: 'failed'; error?: Error; configurationId: ConfigurationIdentity['configurationId'] }
  | { status: 'cancelled'; configurationId: ConfigurationIdentity['configurationId'] };

export type MutationOutcome<T> =
  | MutationEnvelope<T> & { status: 'committed'; value: T }
  | MutationEnvelope<T> & { status: 'failed'; value?: T; error?: Error }
  | MutationEnvelope<T> & {
      status: 'conflict';
      code: 'STALE_SNAPSHOT' | 'PLAN_CONFLICT' | 'TARGET_OUTSIDE_ROOT' | 'PATH_UNAVAILABLE' | 'CONFIGURATION_CAPABILITY_UNSUPPORTED';
      error: Error;
    }
  | MutationEnvelope<T> & { status: 'cancelled' };

interface MutationEnvelope<T> {
  readonly configurationId: ConfigurationIdentity['configurationId'];
  readonly operationId: string;
  readonly snapshotVersion: number;
  readonly reconciliation?: ReconciliationOutcome;
  readonly _valueType?: T;
}

export interface ValueMutationErrorMessages {
  readonly failureMessage: string;
  readonly cancelledMessage: string;
}

interface SessionExecutionLease {
  readonly session: ConfigurationSession;
  readonly mode: 'read' | 'write';
  readonly baseSnapshotVersion: number;
  readonly operationId?: string;
  readonly identity?: ConfigurationIdentity;
  reconciliationRequested: boolean;
  active: boolean;
}

export class ConfigurationSessionWriteFromReadError extends Error {
  readonly code = 'WRITE_FROM_READ';

  constructor() {
    super('Нельзя выполнять запись конфигурации внутри read-операции той же сессии.');
    this.name = 'ConfigurationSessionWriteFromReadError';
  }
}

const MUTATION_VALUE_ERROR_MESSAGES: ValueMutationErrorMessages = {
  failureMessage: 'Операция конфигурации не выполнена.',
  cancelledMessage: 'Операция конфигурации отменена.',
};

const PLAN_VALUE_ERROR_MESSAGES: ValueMutationErrorMessages = {
  failureMessage: 'Configuration plan failed.',
  cancelledMessage: 'Configuration plan was cancelled.',
};

type QueueEntry =
  | {
      type: 'write';
      run: () => Promise<void>;
      afterRelease: () => Promise<void>;
    }
  | {
      type: 'read';
      run: () => Promise<void>;
    };

/** Thin per-configuration facade: FIFO mutation ownership plus Tier-1 storage. */
export class ConfigurationSession {
  private accepting = true;
  private _snapshotVersion = 0;
  private runningWriters = 0;
  private runningReaders = 0;
  private runningPostCommitObservers = 0;
  private queue: QueueEntry[] = [];
  private drainResolvers: Array<() => void> = [];
  private readonly executionContext = new AsyncLocalStorage<SessionExecutionLease>();
  readonly storage: AtomicFileStorage;
  readonly mutations: MutationPlanExecutor;

  constructor(
    private _identity: ConfigurationIdentity,
    private readonly commitObserver?: ConfigurationCommitObserver,
  ) {
    this._identity = snapshotIdentity(this._identity);
    this.storage = new AtomicFileStorage(_identity.rootPath);
    this.mutations = new MutationPlanExecutor(_identity.rootPath);
  }

  get identity(): ConfigurationIdentity {
    return this._identity;
  }

  get snapshotVersion(): number {
    return this._snapshotVersion;
  }

  updateIdentity(identity: ConfigurationIdentity): void {
    if (identity.configurationId !== this._identity.configurationId) {
      throw new Error('Configuration identity cannot be reassigned to another session.');
    }
    this._identity = snapshotIdentity(identity);
  }

  private processQueue(): void {
    if (this.runningWriters > 0) {
      return;
    }
    if (this.queue.length === 0) {
      if (this.runningReaders === 0 && this.runningPostCommitObservers === 0 && !this.accepting) {
        const resolvers = this.drainResolvers;
        this.drainResolvers = [];
        resolvers.forEach((resolve) => resolve());
      }
      return;
    }
    const next = this.queue[0];
    if (next.type === 'write') {
      if (this.runningReaders > 0) {
        return;
      }
      this.queue.shift();
      this.runningWriters = 1;
      void next.run().catch((error) => {
        warnSafely('Configuration mutation queue entry failed unexpectedly', error);
      }).finally(() => {
        this.runningWriters = 0;
        this.runningPostCommitObservers++;
        const afterRelease = Promise.resolve().then(() => next.afterRelease());
        this.processQueue();
        void afterRelease.catch((error) => {
          warnSafely('Configuration commit observer failed after the writer was released', error);
        }).finally(() => {
          this.runningPostCommitObservers--;
          this.processQueue();
        });
      });
      return;
    }
    if (next.type === 'read') {
      const readers: QueueEntry[] = [];
      while (this.queue.length > 0 && this.queue[0].type === 'read') {
        readers.push(this.queue.shift()!);
      }
      for (const reader of readers) {
        this.runningReaders++;
        void reader.run().finally(() => {
          this.runningReaders--;
          if (this.runningReaders === 0) {
            this.processQueue();
          }
        });
      }
    }
  }

  enqueue<T>(request: MutationRequest<T>): Promise<MutationOutcome<T>> {
    const lease = this.executionContext.getStore();
    if (lease?.active && lease.session === this) {
      return this.runOutcomeWithinWriterLease(request, lease);
    }

    const operationId = request.operationId ?? randomUUID();
    return new Promise<MutationOutcome<T>>((resolve) => {
      let outcome: MutationOutcome<T> | undefined;
      let commitContext: ConfigurationCommitContext | undefined;
      let executionLease: SessionExecutionLease | undefined;
      const envelope = (): MutationEnvelope<T> => ({
        configurationId: this.identity.configurationId,
        operationId,
        snapshotVersion: this._snapshotVersion,
      });
      const finish = async (): Promise<void> => {
        try {
          if (!outcome) {
            outcome = { ...envelope(), status: 'failed', error: new Error('Configuration mutation ended without an outcome.') };
          }
          let shouldObserve = executionLease?.reconciliationRequested === true;
          try {
            shouldObserve = this.shouldReconcile(request, outcome) || shouldObserve;
          } catch (error) {
            warnSafely('Configuration mutation reconciliation predicate failed', error);
          }
          if (commitContext && this.commitObserver && shouldObserve) {
            try {
              const reconciliation = await this.commitObserver(commitContext);
              if (reconciliation) {
                outcome = { ...outcome, reconciliation };
                if (reconciliation.status === 'failed') {
                  warnSafely('Configuration mutation committed but reconciliation failed', {
                    configurationId: commitContext.configurationId,
                    rootPath: commitContext.rootPath,
                    operationId: commitContext.operationId,
                    snapshotVersion: commitContext.snapshotVersion,
                    kind: commitContext.kind,
                    reconciliation,
                  });
                }
              }
            } catch (error) {
              const reconciliation: ReconciliationOutcome = {
                status: 'failed',
                code: errorCode(error),
                message: errorMessage(error),
              };
              outcome = { ...outcome, reconciliation };
              warnSafely('Configuration mutation committed but reconciliation failed', {
                configurationId: commitContext.configurationId,
                rootPath: commitContext.rootPath,
                operationId: commitContext.operationId,
                snapshotVersion: commitContext.snapshotVersion,
                kind: commitContext.kind,
                reconciliation,
              });
            }
          }
        } catch (error) {
          if (outcome && commitContext) {
            outcome = {
              ...outcome,
              reconciliation: {
                status: 'failed',
                code: errorCode(error),
                message: errorMessage(error),
              },
            };
          }
          warnSafely('Configuration mutation post-commit finalizer failed', error);
        } finally {
          resolve(outcome ?? {
            ...envelope(),
            status: 'failed',
            error: new Error('Configuration mutation ended without an outcome.'),
          });
        }
      };

      if (!this.accepting || request.cancellation?.isCancellationRequested) {
        resolve({ ...envelope(), status: 'cancelled' });
        return;
      }
      if (!this.identity.capabilities.write) {
        resolve({
          ...envelope(),
          status: 'conflict',
          code: 'CONFIGURATION_CAPABILITY_UNSUPPORTED',
          error: new WorkspaceRegistryError(
            'CONFIGURATION_CAPABILITY_UNSUPPORTED',
            `Конфигурация ${this.identity.configurationId} не поддерживает запись.`,
          ),
        });
        return;
      }

      this.queue.push({
        type: 'write',
        run: async () => {
          if (!this.accepting || request.cancellation?.isCancellationRequested) {
            outcome = { ...envelope(), status: 'cancelled' };
            return;
          }
          if (
            request.clientSnapshotVersion !== undefined
            && request.clientSnapshotVersion !== this._snapshotVersion
          ) {
            outcome = {
              ...envelope(),
              status: 'conflict',
              code: 'STALE_SNAPSHOT',
              error: new Error('Версия конфигурации изменилась до начала операции.'),
            };
            return;
          }

          const baseSnapshotVersion = this._snapshotVersion;
          const operationIdentity = snapshotIdentity(this.identity);
          let lease: SessionExecutionLease | undefined;
          try {
            lease = {
              session: this,
              mode: 'write',
              baseSnapshotVersion,
              operationId,
              identity: operationIdentity,
              reconciliationRequested: false,
              active: true,
            };
            executionLease = lease;
            const value = await this.withExecutionLease(lease, () =>
              request.execute({ operationId, baseSnapshotVersion, storage: this.storage }),
            );
            if (request.commitWhen && !request.commitWhen(value)) {
              outcome = {
                configurationId: operationIdentity.configurationId,
                operationId,
                snapshotVersion: this._snapshotVersion,
                status: 'failed',
                value,
              };
              if (this.shouldReconcile(request, outcome) || lease.reconciliationRequested) {
                commitContext = {
                  configurationId: operationIdentity.configurationId,
                  rootPath: operationIdentity.rootPath,
                  operationId,
                  snapshotVersion: this._snapshotVersion,
                  kind: request.kind,
                };
              }
              return;
            }
            this._snapshotVersion += 1;
            outcome = {
              configurationId: operationIdentity.configurationId,
              operationId,
              snapshotVersion: this._snapshotVersion,
              status: 'committed',
              value,
            };
            commitContext = {
              configurationId: operationIdentity.configurationId,
              rootPath: operationIdentity.rootPath,
              operationId,
              snapshotVersion: this._snapshotVersion,
              kind: request.kind,
            };
          } catch (error) {
            if (lease?.reconciliationRequested) {
              commitContext = {
                configurationId: operationIdentity.configurationId,
                rootPath: operationIdentity.rootPath,
                operationId,
                snapshotVersion: this._snapshotVersion,
                kind: request.kind,
              };
            }
            if (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT') {
              outcome = {
                configurationId: operationIdentity.configurationId,
                operationId,
                snapshotVersion: this._snapshotVersion,
                status: 'conflict',
                code: 'PLAN_CONFLICT',
                error,
              };
              return;
            }
            if (error instanceof PathBoundaryError) {
              outcome = {
                configurationId: operationIdentity.configurationId,
                operationId,
                snapshotVersion: this._snapshotVersion,
                status: 'conflict',
                code: error.code === 'PATH_UNAVAILABLE' ? 'PATH_UNAVAILABLE' : 'TARGET_OUTSIDE_ROOT',
                error,
              };
              return;
            }
            outcome = {
              ...envelope(),
              status: 'failed',
              error: error instanceof Error ? error : new Error(String(error)),
            };
            if (error instanceof MutationPlanError && error.code === 'RECOVERY_REQUIRED') {
              commitContext = {
                configurationId: operationIdentity.configurationId,
                rootPath: operationIdentity.rootPath,
                operationId,
                snapshotVersion: this._snapshotVersion,
                kind: request.kind,
              };
            }
          }
        },
        afterRelease: finish,
      });

      this.processQueue();
    });
  }

  /** Runs an outcome-aware nested mutation inline when this session already owns the writer lease. */
  private async runOutcomeWithinWriterLease<T>(
    request: MutationRequest<T>,
    lease: SessionExecutionLease,
  ): Promise<MutationOutcome<T>> {
    const identity = lease.identity ?? snapshotIdentity(this.identity);
    const operationId = lease.operationId ?? request.operationId ?? randomUUID();
    const envelope = (): MutationEnvelope<T> => ({
      configurationId: identity.configurationId,
      operationId,
      snapshotVersion: this._snapshotVersion,
    });

    let outcome: MutationOutcome<T>;
    if (lease.mode === 'read') {
      outcome = {
        ...envelope(),
        status: 'failed',
        error: new ConfigurationSessionWriteFromReadError(),
      };
    } else if (request.cancellation?.isCancellationRequested) {
      outcome = { ...envelope(), status: 'cancelled' };
    } else if (
      request.clientSnapshotVersion !== undefined
      && request.clientSnapshotVersion !== lease.baseSnapshotVersion
    ) {
      outcome = {
        ...envelope(),
        status: 'conflict',
        code: 'STALE_SNAPSHOT',
        error: new Error('Версия конфигурации изменилась до начала операции.'),
      };
    } else {
      try {
        const value = await request.execute({
          operationId,
          baseSnapshotVersion: lease.baseSnapshotVersion,
          storage: this.storage,
        });
        outcome = request.commitWhen && !request.commitWhen(value)
          ? { ...envelope(), status: 'failed', value }
          : { ...envelope(), status: 'committed', value };
      } catch (error) {
        if (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT') {
          outcome = { ...envelope(), status: 'conflict', code: 'PLAN_CONFLICT', error };
        } else if (error instanceof PathBoundaryError) {
          outcome = {
            ...envelope(),
            status: 'conflict',
            code: error.code === 'PATH_UNAVAILABLE' ? 'PATH_UNAVAILABLE' : 'TARGET_OUTSIDE_ROOT',
            error,
          };
        } else {
          outcome = {
            ...envelope(),
            status: 'failed',
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      }
    }

    try {
      lease.reconciliationRequested = this.shouldReconcile(request, outcome) || lease.reconciliationRequested;
    } catch (error) {
      Logger.warn('Nested configuration mutation reconciliation predicate failed', error);
    }
    return outcome;
  }

  runRead<T>(
    operation: ((context: { snapshotVersion: number; rootPath: string }) => Promise<T>) | ReadRequest<T>,
    cancellation?: CancellationLike,
  ): Promise<ReadOutcome<T>> {
    const request: ReadRequest<T> = typeof operation === 'function'
      ? { execute: operation, cancellation }
      : operation;

    return new Promise<ReadOutcome<T>>((resolve) => {
      if (!this.accepting || request.cancellation?.isCancellationRequested) {
        resolve({
          status: 'cancelled',
          configurationId: this.identity.configurationId,
        });
        return;
      }

      this.queue.push({
        type: 'read',
        run: async () => {
          if (!this.accepting || request.cancellation?.isCancellationRequested) {
            resolve({
              status: 'cancelled',
              configurationId: this.identity.configurationId,
            });
            return;
          }

          const snapshotVersion = this._snapshotVersion;
          try {
            const lease: SessionExecutionLease = {
              session: this,
              mode: 'read',
              baseSnapshotVersion: snapshotVersion,
              identity: snapshotIdentity(this.identity),
              reconciliationRequested: false,
              active: true,
            };
            const value = await this.withExecutionLease(lease, () => request.execute({
              snapshotVersion,
              rootPath: this.identity.rootPath,
            }));
            resolve({
              status: 'ok',
              value,
              snapshotVersion,
              configurationId: this.identity.configurationId,
            });
          } catch (error) {
            resolve({
              status: 'failed',
              error: error instanceof Error ? error : new Error(String(error)),
              configurationId: this.identity.configurationId,
            });
          }
        },
      });

      this.processQueue();
    });
  }

  enqueuePlan<T>(
    plan: MutationPlan<T>,
    options: Omit<MutationRequest<T>, 'kind' | 'execute'> = {},
  ): Promise<MutationOutcome<T>> {
    const operationId = options.operationId ?? randomUUID();
    const mayWriteConfiguration = plan.steps.some((step) => !isReadOnlyAssertionStep(step));
    return this.enqueue({
      kind: plan.kind,
      ...options,
      operationId,
      reconcile: options.reconcile ?? mayWriteConfiguration,
      shouldReconcile: options.shouldReconcile ?? ((outcome) => {
        if (options.reconcile === false || !mayWriteConfiguration) {
          return false;
        }
        return outcome.status === 'committed'
          || (outcome.status === 'failed' && outcome.error instanceof MutationPlanError && outcome.error.code === 'RECOVERY_REQUIRED');
      }),
      execute: ({ operationId: executionOperationId }) => this.mutations.execute(plan, executionOperationId),
    });
  }

  /** Runs a mutation callback inline only when this session already owns an active writer lease. */
  runMutationValue<T>(
    request: MutationRequest<T>,
    errorMessages: ValueMutationErrorMessages = MUTATION_VALUE_ERROR_MESSAGES,
  ): Promise<T> {
    const operationId = request.operationId ?? randomUUID();
    const lease = this.executionContext.getStore();
    if (lease?.active && lease.session === this) {
      if (lease.mode === 'read') {
        return Promise.reject(new ConfigurationSessionWriteFromReadError());
      }
      // The nested call shares the outer operation's commit boundary. Keep its typed
      // outcome long enough to mark the outer lease for reconciliation, then preserve
      // the value-runner's existing throw-on-failure behavior for its caller.
      return this.runOutcomeWithinWriterLease({
        ...request,
        operationId: lease.operationId ?? operationId,
      }, lease).then((outcome) => unwrapMutationOutcome(outcome, errorMessages));
    }
    return this.enqueue({ ...request, operationId }).then((outcome) =>
      unwrapMutationOutcome(outcome, errorMessages),
    );
  }

  /** Runs a plan through this session, reusing an active writer lease without another FIFO entry. */
  runPlanValue<T>(
    plan: MutationPlan<T>,
    options: Omit<MutationRequest<T>, 'kind' | 'execute'> = {},
    errorMessages: ValueMutationErrorMessages = PLAN_VALUE_ERROR_MESSAGES,
  ): Promise<T> {
    const operationId = options.operationId ?? randomUUID();
    const mayWriteConfiguration = plan.steps.some((step) => !isReadOnlyAssertionStep(step));
    return this.runMutationValue({
      ...options,
      kind: plan.kind,
      operationId,
      reconcile: options.reconcile ?? mayWriteConfiguration,
      shouldReconcile: options.shouldReconcile ?? ((outcome) => {
        if (options.reconcile === false || !mayWriteConfiguration) {
          return false;
        }
        return outcome.status === 'committed'
          || (outcome.status === 'failed' && outcome.error instanceof MutationPlanError && outcome.error.code === 'RECOVERY_REQUIRED');
      }),
      execute: ({ operationId: executionOperationId }) => this.mutations.execute(plan, executionOperationId),
    }, errorMessages);
  }

  /** Uses the mutation FIFO for a short non-plan configuration critical section. */
  runExclusive<T>(operation: ExclusiveConfigurationOperation<T>): Promise<MutationOutcome<T>> {
    return this.enqueue({
      kind: operation.kind,
      operationId: operation.operationId,
      clientSnapshotVersion: operation.clientSnapshotVersion,
      cancellation: operation.cancellation,
      reconcile: operation.reconcile ?? false,
      shouldReconcile: operation.shouldReconcile,
      execute: operation.execute,
    });
  }

  async dispose(): Promise<void> {
    this.accepting = false;
    if (this.runningWriters === 0 && this.runningReaders === 0 && this.runningPostCommitObservers === 0 && this.queue.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
      this.processQueue();
    });
  }

  private withExecutionLease<T>(lease: SessionExecutionLease, operation: () => Promise<T>): Promise<T> {
    return this.executionContext.run(lease, async () => {
      try {
        return await operation();
      } finally {
        lease.active = false;
      }
    });
  }

  private shouldReconcile<T>(request: MutationRequest<T>, outcome: MutationOutcome<T>): boolean {
    if (request.reconcile === false) {
      return false;
    }
    if (request.shouldReconcile) {
      return request.shouldReconcile(outcome);
    }
    return outcome.status === 'committed'
      || (outcome.status === 'failed' && outcome.error instanceof MutationPlanError && outcome.error.code === 'RECOVERY_REQUIRED');
  }
}

function unwrapMutationOutcome<T>(
  outcome: MutationOutcome<T>,
  errorMessages: ValueMutationErrorMessages,
): T {
  if (outcome.status === 'committed') {
    return outcome.value;
  }
  if (outcome.status === 'failed' || outcome.status === 'conflict') {
    throw outcome.error ?? new Error(errorMessages.failureMessage);
  }
  throw new Error(errorMessages.cancelledMessage);
}

function snapshotIdentity(identity: ConfigurationIdentity): ConfigurationIdentity {
  return {
    ...identity,
    capabilities: Object.freeze({ ...identity.capabilities }),
  };
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN_RELOAD_FAILURE';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnSafely(message: string, ...args: unknown[]): void {
  try {
    Logger.warn(message, ...args);
  } catch {
    // Diagnostic output must never strand an already-executed configuration write.
  }
}
