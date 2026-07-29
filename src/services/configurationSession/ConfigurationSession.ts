import { randomUUID } from 'crypto';
import { AtomicFileStorage } from './atomicFileStorage';
import { MutationPlan, MutationPlanExecutor } from './mutationPlan';
import { MutationPlanError } from './mutationPlan';
import { PathBoundaryError } from './pathBoundary';
import type { ConfigurationIdentity } from './types';

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

export type MutationOutcome<T> =
  | MutationEnvelope<T> & { status: 'committed'; value: T }
  | MutationEnvelope<T> & { status: 'failed'; value?: T; error?: Error }
  | MutationEnvelope<T> & {
      status: 'conflict';
      code: 'STALE_SNAPSHOT' | 'PLAN_CONFLICT' | 'TARGET_OUTSIDE_ROOT' | 'PATH_UNAVAILABLE';
      error: Error;
    }
  | MutationEnvelope<T> & { status: 'cancelled' };

interface MutationEnvelope<T> {
  readonly configurationId: ConfigurationIdentity['configurationId'];
  readonly operationId: string;
  readonly snapshotVersion: number;
  readonly _valueType?: T;
}

/** Thin per-configuration facade: FIFO mutation ownership plus Tier-1 storage. */
export class ConfigurationSession {
  private queueTail: Promise<void> = Promise.resolve();
  private accepting = true;
  private _snapshotVersion = 0;
  readonly storage: AtomicFileStorage;
  readonly mutations: MutationPlanExecutor;

  constructor(private _identity: ConfigurationIdentity) {
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
    this._identity = identity;
  }

  enqueue<T>(request: MutationRequest<T>): Promise<MutationOutcome<T>> {
    const operationId = request.operationId ?? randomUUID();
    const run = async (): Promise<MutationOutcome<T>> => {
      const envelope = (): MutationEnvelope<T> => ({
        configurationId: this.identity.configurationId,
        operationId,
        snapshotVersion: this._snapshotVersion,
      });
      if (!this.accepting || request.cancellation?.isCancellationRequested) {
        return { ...envelope(), status: 'cancelled' };
      }
      if (
        request.clientSnapshotVersion !== undefined
        && request.clientSnapshotVersion !== this._snapshotVersion
      ) {
        return {
          ...envelope(),
          status: 'conflict',
          code: 'STALE_SNAPSHOT',
          error: new Error('Версия конфигурации изменилась до начала операции.'),
        };
      }

      const baseSnapshotVersion = this._snapshotVersion;
      try {
        const value = await request.execute({ operationId, baseSnapshotVersion, storage: this.storage });
        if (request.commitWhen && !request.commitWhen(value)) {
          return { ...envelope(), status: 'failed', value };
        }
        this._snapshotVersion += 1;
        return { ...envelope(), snapshotVersion: this._snapshotVersion, status: 'committed', value };
      } catch (error) {
        if (error instanceof MutationPlanError && error.code === 'PLAN_CONFLICT') {
          return { ...envelope(), status: 'conflict', code: 'PLAN_CONFLICT', error };
        }
        if (error instanceof PathBoundaryError) {
          return {
            ...envelope(),
            status: 'conflict',
            code: error.code === 'PATH_UNAVAILABLE' ? 'PATH_UNAVAILABLE' : 'TARGET_OUTSIDE_ROOT',
            error,
          };
        }
        return {
          ...envelope(),
          status: 'failed',
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    };

    const result = this.queueTail.then(run, run);
    this.queueTail = result.then(() => undefined, () => undefined);
    return result;
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
    await this.queueTail;
  }
}
