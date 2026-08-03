import { AsyncLocalStorage } from 'async_hooks';
import type { InfobaseEntry } from './models/infobaseEntry';
import {
  resolveInfobaseCanonicalIdentity,
  type InfobaseCanonicalIdentity,
} from './infobaseCanonicalIdentity';

export type InfobaseConfigurationQueueIdentity = InfobaseCanonicalIdentity | string;

export interface InfobaseConfigurationOperationLease {
  readonly canonicalTargetIds: readonly string[];
  owns(identity: InfobaseConfigurationQueueIdentity): boolean;
  runExclusive<T>(
    identity: InfobaseConfigurationQueueIdentity,
    operation: (lease: InfobaseConfigurationOperationLease) => Promise<T>,
  ): Promise<T>;
}

interface OwnershipContext {
  readonly keys: ReadonlySet<string>;
  active: boolean;
}

export class InfobaseConfigurationQueueReentrancyError extends Error {
  constructor(readonly heldKeys: readonly string[], readonly requestedKeys: readonly string[]) {
    super(
      `Нельзя расширить уже удерживаемый lease очереди ИБ: held=${heldKeys.join(', ')}; requested=${requestedKeys.join(', ')}.`,
    );
    this.name = 'InfobaseConfigurationQueueReentrancyError';
  }
}

export interface InfobaseConfigurationQueueQuarantine {
  readonly canonicalTargetId: string;
  readonly reason: string;
  readonly quarantinedAt: string;
}

export class InfobaseConfigurationQueueQuarantinedError extends Error {
  constructor(readonly quarantines: readonly InfobaseConfigurationQueueQuarantine[]) {
    super(
      `Configuration operation resources require closed recovery: ${quarantines
        .map(({ canonicalTargetId }) => canonicalTargetId)
        .join(', ')}.`,
    );
    this.name = 'InfobaseConfigurationQueueQuarantinedError';
  }
}

function identityKey(identity: InfobaseConfigurationQueueIdentity): string {
  const key = typeof identity === 'string' ? identity.trim() : identity.canonicalTargetId.trim();
  if (!key) {
    throw new Error('Canonical infobase target identity must be non-empty.');
  }
  return key;
}

/** Per-canonical-target FIFO. Different targets can execute concurrently. */
export class InfobaseConfigurationOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly ownership = new AsyncLocalStorage<OwnershipContext>();
  private readonly quarantines = new Map<string, InfobaseConfigurationQueueQuarantine>();

  quarantine(
    identities: readonly InfobaseConfigurationQueueIdentity[],
    reason: string,
  ): readonly InfobaseConfigurationQueueQuarantine[] {
    const quarantinedAt = new Date().toISOString();
    const entries = [...new Set(identities.map(identityKey))].sort().map((canonicalTargetId) => {
      const existing = this.quarantines.get(canonicalTargetId);
      if (existing) {
        return existing;
      }
      const quarantine = Object.freeze({
        canonicalTargetId,
        reason,
        quarantinedAt,
      });
      this.quarantines.set(canonicalTargetId, quarantine);
      return quarantine;
    });
    return Object.freeze(entries);
  }

  getQuarantines(
    identities: readonly InfobaseConfigurationQueueIdentity[],
  ): readonly InfobaseConfigurationQueueQuarantine[] {
    return Object.freeze(
      [...new Set(identities.map(identityKey))]
        .sort()
        .flatMap((key) => {
          const quarantine = this.quarantines.get(key);
          return quarantine ? [quarantine] : [];
        }),
    );
  }

  runExclusive<T>(
    identity: InfobaseConfigurationQueueIdentity,
    operation: (lease: InfobaseConfigurationOperationLease) => Promise<T>,
  ): Promise<T> {
    return this.runComposite([identity], operation);
  }

  async runComposite<T>(
    identities: readonly InfobaseConfigurationQueueIdentity[],
    operation: (lease: InfobaseConfigurationOperationLease) => Promise<T>,
  ): Promise<T> {
    const requestedKeys = [...new Set(identities.map(identityKey))].sort();
    const current = this.ownership.getStore();
    if (current?.active) {
      if (requestedKeys.every((key) => current.keys.has(key))) {
        return operation(this.createLease(current));
      }
      throw new InfobaseConfigurationQueueReentrancyError([...current.keys], requestedKeys);
    }
    this.assertNotQuarantined(requestedKeys);
    if (requestedKeys.length === 0) {
      const emptyContext: OwnershipContext = { keys: new Set<string>(), active: true };
      try {
        return await this.ownership.run(emptyContext, () => operation(this.createLease(emptyContext)));
      } finally {
        emptyContext.active = false;
      }
    }

    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const predecessors = requestedKeys.map((key) => this.tails.get(key) ?? Promise.resolve());
    for (const key of requestedKeys) {
      this.tails.set(key, gate);
    }
    await Promise.all(predecessors);
    try {
      this.assertNotQuarantined(requestedKeys);
    } catch (error) {
      releaseGate?.();
      for (const key of requestedKeys) {
        if (this.tails.get(key) === gate) {
          this.tails.delete(key);
        }
      }
      throw error;
    }

    const context: OwnershipContext = { keys: new Set(requestedKeys), active: true };
    try {
      return await this.ownership.run(context, () => operation(this.createLease(context)));
    } finally {
      context.active = false;
      releaseGate?.();
      for (const key of requestedKeys) {
        if (this.tails.get(key) === gate) {
          this.tails.delete(key);
        }
      }
    }
  }

  private createLease(context: OwnershipContext): InfobaseConfigurationOperationLease {
    const canonicalTargetIds = [...context.keys];
    return {
      canonicalTargetIds,
      owns: (identity) => context.active && context.keys.has(identityKey(identity)),
      runExclusive: (identity, operation) => this.runExclusive(identity, operation),
    };
  }

  private assertNotQuarantined(keys: readonly string[]): void {
    const quarantines = keys.flatMap((key) => {
      const quarantine = this.quarantines.get(key);
      return quarantine ? [quarantine] : [];
    });
    if (quarantines.length > 0) {
      throw new InfobaseConfigurationQueueQuarantinedError(quarantines);
    }
  }
}

export const sharedInfobaseConfigurationOperationQueue = new InfobaseConfigurationOperationQueue();

export async function runInfobaseConfigurationOperation<T>(
  entry: InfobaseEntry,
  operation: (lease: InfobaseConfigurationOperationLease) => Promise<T>,
): Promise<T> {
  const identity = await resolveInfobaseCanonicalIdentity(entry);
  return sharedInfobaseConfigurationOperationQueue.runExclusive(identity, operation);
}

export async function runCompositeInfobaseConfigurationOperation<T>(
  entries: readonly InfobaseEntry[],
  operation: (lease: InfobaseConfigurationOperationLease) => Promise<T>,
): Promise<T> {
  const identities = await Promise.all(entries.map(resolveInfobaseCanonicalIdentity));
  return sharedInfobaseConfigurationOperationQueue.runComposite(identities, operation);
}
