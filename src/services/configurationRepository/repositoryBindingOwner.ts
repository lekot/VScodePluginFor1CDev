import type {
  RepositoryBindingStorage,
  RepositorySecretStore,
  RepositoryStateStorage,
} from './repositoryStores';
import {
  getRepositoryTargetMutationRevision,
  withRepositoryTargetMutationLock,
} from './repositoryStores';
import type { RepositoryStateProjection } from './repositoryTreeDecorations';
import type {
  RepositoryBinding,
  RepositoryObservedState,
  RepositoryTarget,
} from './types';

export interface RepositoryBindingSnapshot {
  readonly binding?: RepositoryBinding;
  readonly password?: string;
  readonly state: RepositoryObservedState;
  readonly storedState?: RepositoryObservedState;
  readonly mutationRevision: number;
}

export type RepositoryOwnerCapture =
  | {
      readonly status: 'ready';
      readonly snapshot: RepositoryBindingSnapshot;
      readonly binding: RepositoryBinding & { readonly repositoryPassword?: string };
    }
  | { readonly status: 'missing' }
  | { readonly status: 'conflict' };

export type RepositoryOwnerAcknowledgement =
  | { readonly status: 'updated'; readonly owner: RepositoryBindingSnapshot }
  | { readonly status: 'conflict' }
  | { readonly status: 'failed'; readonly error: unknown };

export interface RepositoryOwnerAcknowledgementOptions {
  readonly fullNames?: readonly string[];
  readonly lockState?: 'heldByCurrentCredentials' | 'unlocked';
  readonly resetLocks?: boolean;
}

export type RepositoryOwnerStage<T> =
  | { readonly status: 'started'; readonly pending: Promise<T> }
  | { readonly status: 'conflict' };

export type RepositoryCandidatePreparation =
  | {
      readonly status: 'ready';
      readonly previous: RepositoryBindingSnapshot;
      readonly candidate: RepositoryBindingSnapshot;
    }
  | { readonly status: 'failed'; readonly restoreFailed?: true };

export type RepositoryOwnerCleanup =
  | { readonly status: 'cleared' }
  | { readonly status: 'conflict' }
  | { readonly status: 'failed'; readonly error: unknown };

export interface RepositoryBindingOwnerDeps {
  readonly bindingStore: RepositoryBindingStorage;
  readonly secretStore: RepositorySecretStore;
  readonly stateStore: RepositoryStateStorage;
  readonly stateProjection?: RepositoryStateProjection;
  readonly onStateChanged?: (target: RepositoryTarget) => void;
}

/** Owns atomic snapshots and guarded target-store transitions for repository operations. */
export class RepositoryBindingOwner {
  constructor(private readonly deps: RepositoryBindingOwnerDeps) {}

  async capture(target: RepositoryTarget): Promise<RepositoryBindingSnapshot> {
    return withRepositoryTargetMutationLock(target, async () => {
      const [binding, password, state, storedState] = await Promise.all([
        this.deps.bindingStore.get(target),
        this.deps.secretStore.get(target),
        this.deps.stateStore.get(target),
        this.deps.stateStore.getStored(target),
      ]);
      return Object.freeze({
        binding,
        password,
        state,
        storedState,
        mutationRevision: getRepositoryTargetMutationRevision(target),
      });
    });
  }

  async captureExecutionOwner(
    target: RepositoryTarget,
    executionInfobaseId: string,
  ): Promise<RepositoryOwnerCapture> {
    const snapshot = await this.capture(target);
    if (!snapshot.binding) {
      return { status: 'missing' };
    }
    if (snapshot.binding.executionInfobaseId !== executionInfobaseId) {
      return { status: 'conflict' };
    }
    return {
      status: 'ready',
      snapshot,
      binding: Object.freeze({
        ...snapshot.binding,
        ...(snapshot.password !== undefined ? { repositoryPassword: snapshot.password } : {}),
      }),
    };
  }

  async prepareCandidate(
    target: RepositoryTarget,
    binding: RepositoryBinding & { readonly repositoryPassword?: string },
  ): Promise<RepositoryCandidatePreparation> {
    // Snapshot, candidate persistence and candidate witness are one short target-locked stage.
    return withRepositoryTargetMutationLock(target, async () => {
      let previous: RepositoryBindingSnapshot;
      try {
        previous = await this.capture(target);
      } catch {
        return { status: 'failed' as const };
      }
      try {
        await this.persistCandidate(target, binding);
        const candidate = await this.capture(target);
        return { status: 'ready' as const, previous, candidate };
      } catch {
        try {
          await this.restore(previous, target);
          return { status: 'failed' as const };
        } catch {
          return { status: 'failed' as const, restoreFailed: true as const };
        }
      }
    });
  }

  async restoreIfCandidateOwned(
    target: RepositoryTarget,
    previous: RepositoryBindingSnapshot,
    candidate: RepositoryBindingSnapshot,
  ): Promise<{ readonly status: 'restored' } | { readonly status: 'conflict' } | { readonly status: 'failed'; readonly message: string }> {
    return withRepositoryTargetMutationLock(target, async () => {
      if (!await this.matches(target, candidate)) {
        return { status: 'conflict' as const };
      }
      try {
        await this.restore(previous, target);
        return { status: 'restored' as const };
      } catch {
        return { status: 'failed' as const, message: 'ошибка восстановления' };
      }
    });
  }

  async clearIfOwned(target: RepositoryTarget, expected: RepositoryBindingSnapshot): Promise<RepositoryOwnerCleanup> {
    return withRepositoryTargetMutationLock(target, async () => {
      if (!await this.matches(target, expected)) {
        return { status: 'conflict' as const };
      }
      try {
        await this.deps.stateStore.clear(target);
        await this.deps.secretStore.delete(target);
        await this.deps.bindingStore.delete(target);
        this.deps.stateProjection?.delete(target.key);
        this.deps.onStateChanged?.(target);
        return { status: 'cleared' as const };
      } catch (error) {
        return { status: 'failed' as const, error };
      }
    });
  }

  async matches(target: RepositoryTarget, expected: RepositoryBindingSnapshot): Promise<boolean> {
    const current = await this.capture(target);
    return sameBindingSnapshot(current, expected);
  }

  async startStageIfOwned<T>(
    target: RepositoryTarget,
    expected: RepositoryBindingSnapshot,
    start: () => Promise<T>,
  ): Promise<RepositoryOwnerStage<T>> {
    return withRepositoryTargetMutationLock(target, async () => {
      if (!await this.matches(target, expected)) {
        return { status: 'conflict' as const };
      }
      return adaptSynchronousStageStart(start);
    });
  }

  async acknowledgeStateIfOwned(
    target: RepositoryTarget,
    expected: RepositoryBindingSnapshot,
    options: RepositoryOwnerAcknowledgementOptions = {},
  ): Promise<RepositoryOwnerAcknowledgement> {
    return withRepositoryTargetMutationLock(target, async () => {
      try {
        if (!await this.matches(target, expected)) {
          return { status: 'conflict' as const };
        }
        const current = await this.deps.stateStore.get(target);
        const locks = options.resetLocks ? {} : { ...current.locks };
        if (options.lockState) {
          for (const fullName of options.fullNames ?? []) {
            locks[fullName] = options.lockState;
          }
        }
        await this.saveState(target, {
          ...current,
          connection: 'connected',
          locks,
          source: 'configuratorAcknowledgement',
        });
        return { status: 'updated' as const, owner: await this.capture(target) };
      } catch (error) {
        return { status: 'failed' as const, error };
      }
    });
  }

  async markUnknownIfOwned(
    target: RepositoryTarget,
    expected: RepositoryBindingSnapshot,
    fullNames: readonly string[],
  ): Promise<'updated' | 'conflict' | 'failed'> {
    return withRepositoryTargetMutationLock(target, async () => {
      try {
        if (!await this.matches(target, expected)) {
          return 'conflict' as const;
        }
        await this.markUnknown(target, fullNames);
        return 'updated' as const;
      } catch {
        return 'failed' as const;
      }
    });
  }

  private async persistCandidate(
    target: RepositoryTarget,
    binding: RepositoryBinding & { readonly repositoryPassword?: string },
  ): Promise<void> {
    await this.deps.bindingStore.set(target, binding);
    if (binding.repositoryPassword) {
      await this.deps.secretStore.set(target, binding.repositoryPassword);
    } else {
      await this.deps.secretStore.delete(target);
    }
    await this.deps.stateStore.set(target, {
      connection: 'unknown',
      locks: {},
      source: 'unknown',
    });
    this.deps.stateProjection?.set(target.key, await this.deps.stateStore.get(target));
    this.deps.onStateChanged?.(target);
  }

  private async restore(snapshot: RepositoryBindingSnapshot, target: RepositoryTarget): Promise<void> {
    if (snapshot.binding) {
      await this.deps.bindingStore.set(target, snapshot.binding);
    } else {
      await this.deps.bindingStore.delete(target);
    }
    if (snapshot.password !== undefined) {
      await this.deps.secretStore.set(target, snapshot.password);
    } else {
      await this.deps.secretStore.delete(target);
    }
    if (snapshot.storedState) {
      await this.deps.stateStore.set(target, snapshot.storedState);
      this.deps.stateProjection?.set(target.key, snapshot.state);
    } else {
      await this.deps.stateStore.clear(target);
      this.deps.stateProjection?.delete(target.key);
    }
    this.deps.onStateChanged?.(target);
  }

  private async saveState(
    target: RepositoryTarget,
    state: Omit<RepositoryObservedState, 'lastConfirmedAt'> & { readonly lastConfirmedAt?: string },
  ): Promise<void> {
    const next = Object.freeze({
      ...state,
      locks: Object.freeze({ ...state.locks }),
      lastConfirmedAt: state.lastConfirmedAt ?? new Date().toISOString(),
    });
    await this.deps.stateStore.set(target, next);
    this.deps.stateProjection?.set(target.key, next);
    this.deps.onStateChanged?.(target);
  }

  private async markUnknown(target: RepositoryTarget, fullNames: readonly string[]): Promise<void> {
    const current = await this.deps.stateStore.get(target);
    const locks = { ...current.locks };
    for (const fullName of fullNames) {
      locks[fullName] = 'unknown';
    }
    const next = Object.freeze({
      connection: 'unknown',
      locks: Object.freeze(locks),
      ...(current.lastConfirmedAt ? { lastConfirmedAt: current.lastConfirmedAt } : {}),
      source: 'unknown',
    });
    await this.deps.stateStore.set(target, next);
    this.deps.stateProjection?.set(target.key, next);
    this.deps.onStateChanged?.(target);
  }
}

function sameBindingSnapshot(left: RepositoryBindingSnapshot, right: RepositoryBindingSnapshot): boolean {
  return left.mutationRevision === right.mutationRevision
    && left.password === right.password
    && sameRepositoryBinding(left.binding, right.binding)
    && sameRepositoryState(left.state, right.state)
    && sameOptionalRepositoryState(left.storedState, right.storedState);
}

function adaptSynchronousStageStart<T>(start: () => Promise<T>): RepositoryOwnerStage<T> {
  try {
    return { status: 'started', pending: start() };
  } catch (error) {
    return { status: 'started', pending: Promise.reject(error) };
  }
}

function sameOptionalRepositoryState(
  left: RepositoryObservedState | undefined,
  right: RepositoryObservedState | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : sameRepositoryState(left, right);
}

function sameRepositoryBinding(
  left: RepositoryBinding | undefined,
  right: RepositoryBinding | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.repositoryPath === right.repositoryPath
      && left.repositoryUser === right.repositoryUser
      && left.executionInfobaseId === right.executionInfobaseId;
}

function sameRepositoryState(left: RepositoryObservedState, right: RepositoryObservedState): boolean {
  if (
    left.connection !== right.connection
    || left.source !== right.source
    || left.lastConfirmedAt !== right.lastConfirmedAt
  ) {
    return false;
  }
  const leftLocks = Object.entries(left.locks).sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  const rightLocks = Object.entries(right.locks).sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  return leftLocks.length === rightLocks.length
    && leftLocks.every(([name, value], index) => rightLocks[index]?.[0] === name && rightLocks[index]?.[1] === value);
}
