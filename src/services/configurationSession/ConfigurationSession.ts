import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { AtomicFileStorage } from './atomicFileStorage';
import { MutationPlan, MutationPlanExecutor } from './mutationPlan';
import { MutationPlanError } from './mutationPlan';
import { PathBoundaryError } from './pathBoundary';
import type { ConfigurationIdentity } from './types';
import { WorkspaceRegistryError } from './WorkspaceRegistry';

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

export interface MutationRequest<T> {
  readonly kind: string;
  readonly operationId?: string;
  readonly clientSnapshotVersion?: number;
  readonly cancellation?: CancellationLike;
  readonly execute: (context: {
    operationId: string;
    baseSnapshotVersion: number;
    storage: AtomicFileStorage;
  }) => Promise<T>;
  readonly commitWhen?: (value: T) => boolean;
}

export interface ExclusiveConfigurationOperation<T> {
  readonly kind: string;
  readonly operationId?: string;
  readonly clientSnapshotVersion?: number;
  readonly cancellation?: CancellationLike;
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
  private queue: QueueEntry[] = [];
  private drainResolvers: Array<() => void> = [];
  private readonly executionContext = new AsyncLocalStorage<SessionExecutionLease>();
  readonly storage: AtomicFileStorage;
  readonly mutations: MutationPlanExecutor;

  constructor(private _identity: ConfigurationIdentity) {
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
      if (this.runningReaders === 0 && !this.accepting) {
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
      void next.run().finally(() => {
        this.runningWriters = 0;
        this.processQueue();
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
    const operationId = request.operationId ?? randomUUID();
    return new Promise<MutationOutcome<T>>((resolve) => {
      const envelope = (): MutationEnvelope<T> => ({
        configurationId: this.identity.configurationId,
        operationId,
        snapshotVersion: this._snapshotVersion,
      });

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
            resolve({ ...envelope(), status: 'cancelled' });
            return;
          }
          if (
            request.clientSnapshotVersion !== undefined
            && request.clientSnapshotVersion !== this._snapshotVersion
          ) {
            resolve({
              ...envelope(),
              status: 'conflict',
              code: 'STALE_SNAPSHOT',
              error: new Error('Версия конфигурации изменилась до начала операции.'),
            });
            return;
          }

          const baseSnapshotVersion = this._snapshotVersion;
          try {
            const lease: SessionExecutionLease = {
              session: this,
              mode: 'write',
              baseSnapshotVersion,
              active: true,
            };
            const value = await this.withExecutionLease(lease, () =>
              request.execute({ operationId, baseSnapshotVersion, storage: this.storage }),
            );
            if (request.commitWhen && !request.commitWhen(value)) {
              resolve({ ...envelope(), status: 'failed', value });
              return;
            }
            this._snapshotVersion += 1;
            resolve({ ...envelope(), snapshotVersion: this._snapshotVersion, status: 'committed', value });
          } catch (error) {
            if (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT') {
              resolve({ ...envelope(), status: 'conflict', code: 'PLAN_CONFLICT', error });
              return;
            }
            if (error instanceof PathBoundaryError) {
              resolve({
                ...envelope(),
                status: 'conflict',
                code: error.code === 'PATH_UNAVAILABLE' ? 'PATH_UNAVAILABLE' : 'TARGET_OUTSIDE_ROOT',
                error,
              });
              return;
            }
            resolve({
              ...envelope(),
              status: 'failed',
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        },
      });

      this.processQueue();
    });
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
    options: Omit<MutationRequest<T>, 'kind' | 'execute' | 'commitWhen'> = {},
  ): Promise<MutationOutcome<T>> {
    const operationId = options.operationId ?? randomUUID();
    return this.enqueue({
      kind: plan.kind,
      ...options,
      operationId,
      execute: () => this.mutations.execute(plan, operationId),
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
      return this.executeWithinWriterLease({ ...request, operationId }, lease, errorMessages);
    }
    return this.enqueue({ ...request, operationId }).then((outcome) =>
      unwrapMutationOutcome(outcome, errorMessages),
    );
  }

  /** Runs a plan through this session, reusing an active writer lease without another FIFO entry. */
  runPlanValue<T>(
    plan: MutationPlan<T>,
    options: Omit<MutationRequest<T>, 'kind' | 'execute' | 'commitWhen'> = {},
    errorMessages: ValueMutationErrorMessages = PLAN_VALUE_ERROR_MESSAGES,
  ): Promise<T> {
    const operationId = options.operationId ?? randomUUID();
    return this.runMutationValue({
      ...options,
      kind: plan.kind,
      operationId,
      execute: () => this.mutations.execute(plan, operationId),
    }, errorMessages);
  }

  /** Uses the mutation FIFO for a short non-plan configuration critical section. */
  runExclusive<T>(operation: ExclusiveConfigurationOperation<T>): Promise<MutationOutcome<T>> {
    return this.enqueue({
      kind: operation.kind,
      operationId: operation.operationId,
      clientSnapshotVersion: operation.clientSnapshotVersion,
      cancellation: operation.cancellation,
      execute: operation.execute,
    });
  }

  async dispose(): Promise<void> {
    this.accepting = false;
    if (this.runningWriters === 0 && this.runningReaders === 0 && this.queue.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
      this.processQueue();
    });
  }

  private async executeWithinWriterLease<T>(
    request: MutationRequest<T>,
    lease: SessionExecutionLease,
    errorMessages: ValueMutationErrorMessages,
  ): Promise<T> {
    if (request.cancellation?.isCancellationRequested) {
      throw new Error(errorMessages.cancelledMessage);
    }
    if (
      request.clientSnapshotVersion !== undefined
      && request.clientSnapshotVersion !== lease.baseSnapshotVersion
    ) {
      throw new Error('Версия конфигурации изменилась до начала операции.');
    }
    try {
      const value = await request.execute({
        operationId: request.operationId ?? randomUUID(),
        baseSnapshotVersion: lease.baseSnapshotVersion,
        storage: this.storage,
      });
      if (request.commitWhen && !request.commitWhen(value)) {
        throw new Error(errorMessages.failureMessage);
      }
      return value;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
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
