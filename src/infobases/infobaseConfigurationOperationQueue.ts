import { AsyncLocalStorage } from 'async_hooks';
import { compareCodeUnits } from '../utils/compareCodeUnits';
import type { InfobaseEntry } from './models/infobaseEntry';
import {
  resolveInfobaseCanonicalIdentity,
  type InfobaseCanonicalIdentity,
} from './infobaseCanonicalIdentity';

export type InfobaseConfigurationQueueIdentity = InfobaseCanonicalIdentity | string;

export interface InfobaseConfigurationQueueCancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export class InfobaseConfigurationOperationCancelledError extends Error {
  constructor() {
    super('Configuration operation was cancelled before it acquired its queue lease.');
    this.name = 'InfobaseConfigurationOperationCancelledError';
  }
}

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
    const entries = [...new Set(identities.map(identityKey))].sort(compareCodeUnits).map((canonicalTargetId) => {
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
        .sort(compareCodeUnits)
        .flatMap((key) => {
          const quarantine = this.quarantines.get(key);
          return quarantine ? [quarantine] : [];
        }),
    );
  }

  runExclusive<T>(
    identity: InfobaseConfigurationQueueIdentity,
    operation: (lease: InfobaseConfigurationOperationLease) => Promise<T>,
    cancellation?: InfobaseConfigurationQueueCancellation,
  ): Promise<T> {
    return this.runComposite([identity], operation, cancellation);
  }

  async runComposite<T>(
    identities: readonly InfobaseConfigurationQueueIdentity[],
    operation: (lease: InfobaseConfigurationOperationLease) => Promise<T>,
    cancellation?: InfobaseConfigurationQueueCancellation,
  ): Promise<T> {
    if (cancellation?.isCancellationRequested) {
      throw new InfobaseConfigurationOperationCancelledError();
    }
    const requestedKeys = [...new Set(identities.map(identityKey))].sort(compareCodeUnits);
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

    let gateReleased = false;
    const releaseQueueGate = (): void => {
      if (gateReleased) {
        return;
      }
      gateReleased = true;
      releaseGate?.();
      for (const key of requestedKeys) {
        if (this.tails.get(key) === gate) {
          this.tails.delete(key);
        }
      }
    };

    const predecessorsCompleted = Promise.all(predecessors).then(() => undefined);
    if (cancellation) {
      let signalCancellation!: () => void;
      const cancellationRequested = new Promise<'cancelled'>((resolve) => {
        signalCancellation = () => resolve('cancelled');
      });
      const disposable = cancellation.onCancellationRequested(signalCancellation);
      if (cancellation.isCancellationRequested) {
        signalCancellation();
      }
      const waitResult = await Promise.race([
        predecessorsCompleted.then(() => 'ready' as const),
        cancellationRequested,
      ]);
      disposable.dispose();
      if (waitResult === 'cancelled' || cancellation.isCancellationRequested) {
        // Keep the FIFO gate in place until every predecessor has released its lease.
        void predecessorsCompleted.then(releaseQueueGate);
        throw new InfobaseConfigurationOperationCancelledError();
      }
    } else {
      await predecessorsCompleted;
    }

    try {
      this.assertNotQuarantined(requestedKeys);
    } catch (error) {
      releaseQueueGate();
      throw error;
    }

    if (cancellation?.isCancellationRequested) {
      releaseQueueGate();
      throw new InfobaseConfigurationOperationCancelledError();
    }

    const context: OwnershipContext = { keys: new Set(requestedKeys), active: true };
    try {
      return await this.ownership.run(context, () => operation(this.createLease(context)));
    } finally {
      context.active = false;
      releaseQueueGate();
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
  cancellation?: InfobaseConfigurationQueueCancellation,
): Promise<T> {
  if (cancellation?.isCancellationRequested) {
    throw new InfobaseConfigurationOperationCancelledError();
  }
  const identity = await resolveInfobaseCanonicalIdentity(entry);
  if (cancellation?.isCancellationRequested) {
    throw new InfobaseConfigurationOperationCancelledError();
  }
  return sharedInfobaseConfigurationOperationQueue.runExclusive(identity, operation, cancellation);
}

export async function runCompositeInfobaseConfigurationOperation<T>(
  entries: readonly InfobaseEntry[],
  operation: (lease: InfobaseConfigurationOperationLease) => Promise<T>,
  cancellation?: InfobaseConfigurationQueueCancellation,
): Promise<T> {
  if (cancellation?.isCancellationRequested) {
    throw new InfobaseConfigurationOperationCancelledError();
  }
  const identities = await Promise.all(entries.map(resolveInfobaseCanonicalIdentity));
  if (cancellation?.isCancellationRequested) {
    throw new InfobaseConfigurationOperationCancelledError();
  }
  return sharedInfobaseConfigurationOperationQueue.runComposite(identities, operation, cancellation);
}
