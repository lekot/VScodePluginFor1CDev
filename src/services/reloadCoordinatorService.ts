import { randomUUID } from 'crypto';
import { Logger } from '../utils/logger';
import { configurationPathKey } from '../utils/configurationPathIdentity';
import {
  ReloadOperationResult,
  ReloadAttemptOutcome,
  ReloadRequestHandle,
  ReloadReason,
  ReloadRunContext,
  ReloadScheduleOptions,
  ReloadState,
  toReloadFailure,
} from '../types/reloadContracts';

interface ReloadCoordinatorConfig {
  defaultDebounceMs?: number;
  mutationWindowTtlMs?: number;
}

interface ConfigReloadSlot {
  configPath: string;
  state: ReloadState;
  timer: ReturnType<typeof setTimeout> | undefined;
  pendingReason: ReloadReason | null;
  pendingOperationId: string | undefined;
  pendingOperations: Map<string, ReloadReason>;
  pendingWaiters: ReloadRequestWaiter[];
  activeOperations: Map<string, ReloadReason> | undefined;
  activeWaiters: ReloadRequestWaiter[];
  operationResults: Map<string, ReloadOperationResult>;
  freshnessGeneration: number;
}

interface ReloadRequestWaiter {
  operationId: string;
  reason: ReloadReason;
  resolve: (result: ReloadOperationResult) => void;
  settled: boolean;
}

type ReloadRunner = (ctx: ReloadRunContext) => Promise<void | ReloadAttemptOutcome>;

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MUTATION_WINDOW_TTL_MS = 1500;
// Results are stored per-config, up to 50 entries; oldest are evicted FIFO (insertion order).
// Awaitable request completion is owned by its batch waiter and does not depend on this cache.
const OPERATION_RESULT_LIMIT = 50;

export class ReloadCoordinatorService {
  private readonly slots = new Map<string, ConfigReloadSlot>();
  private readonly inFlightReloads = new Set<Promise<void | ReloadAttemptOutcome>>();
  private readonly defaultDebounceMs: number;
  private readonly mutationWindowTtlMs: number;
  private disposed = false;

  constructor(
    private readonly runReload: ReloadRunner,
    cfg?: ReloadCoordinatorConfig
  ) {
    this.defaultDebounceMs = cfg?.defaultDebounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.mutationWindowTtlMs = cfg?.mutationWindowTtlMs ?? DEFAULT_MUTATION_WINDOW_TTL_MS;
  }

  scheduleReload(configPath: string, reason: ReloadReason, options?: ReloadScheduleOptions): void {
    this.admitReload(configPath, reason, options);
  }

  requestReload(
    configPath: string,
    reason: ReloadReason,
    options?: ReloadScheduleOptions,
  ): ReloadRequestHandle {
    const operationId = options?.operationId ?? randomUUID();
    let resolveCompleted!: (result: ReloadOperationResult) => void;
    const completed = new Promise<ReloadOperationResult>((resolve) => {
      resolveCompleted = resolve;
    });
    const waiter: ReloadRequestWaiter = {
      operationId,
      reason,
      resolve: resolveCompleted,
      settled: false,
    };

    if (this.disposed) {
      this.settleWaiter(waiter, this.disposedResult(operationId, reason));
      return { operationId, completed };
    }

    this.admitReload(configPath, reason, options, waiter);
    return { operationId, completed };
  }

  private admitReload(
    configPath: string,
    reason: ReloadReason,
    options?: ReloadScheduleOptions,
    waiter?: ReloadRequestWaiter,
  ): void {
    if (this.disposed) {
      if (waiter) {
        this.settleWaiter(waiter, this.disposedResult(waiter.operationId, waiter.reason));
      }
      return;
    }

    const slot = this.getOrCreateSlot(configPath);
    const now = Date.now();
    slot.state.lastReason = reason;
    slot.state.scheduledAt = now;
    slot.state.scheduledCount += 1;

    const mutationWindowActive = !!slot.state.mutationWindowUntil && now <= slot.state.mutationWindowUntil;
    if (reason === 'watcher' && options?.operationId === undefined && mutationWindowActive
      && (slot.state.inFlight || slot.timer || slot.state.pending)) {
      slot.state.coalescedCount += 1;
      slot.state.suppressedWatcherCount += 1;
      Logger.debug('Suppressed watcher reload inside mutation window', { configPath, reason });
      if (waiter) {
        this.attachSuppressedWaiter(slot, waiter);
      }
      return;
    }

    if (slot.state.inFlight) {
      // A newly admitted trailing request invalidates the active runner's publication token.
      // Suppressed watchers return above and intentionally keep the active batch current.
      slot.freshnessGeneration += 1;
      slot.state.pending = true;
      slot.pendingReason = slot.pendingReason ?? reason;
      slot.pendingOperationId = slot.pendingOperationId ?? options?.operationId;
      this.addPendingOperation(slot, waiter?.operationId ?? options?.operationId, reason);
      if (waiter) {
        slot.pendingWaiters.push(waiter);
      }
      slot.state.coalescedCount += 1;
      Logger.debug('Coalesced reload while in-flight', { configPath, reason });
      return;
    }

    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.state.coalescedCount += 1;
    }

    slot.pendingReason = reason;
    if (options?.operationId !== undefined) {
      slot.pendingOperationId = options.operationId;
    }
    this.addPendingOperation(slot, waiter?.operationId ?? options?.operationId, reason);
    if (waiter) {
      slot.pendingWaiters.push(waiter);
    }
    const debounceMs = options?.debounceMs ?? this.defaultDebounceMs;
    slot.timer = setTimeout(() => {
      void this.executeSlot(slot);
    }, debounceMs);
  }

  markMutationWindow(configPath: string, operationId: string, ttlMs?: number): void {
    if (this.disposed) {
      return;
    }

    const slot = this.getOrCreateSlot(configPath);
    const now = Date.now();
    slot.state.mutationWindowUntil = now + (ttlMs ?? this.mutationWindowTtlMs);
    slot.state.mutationOpId = operationId;
  }

  getState(configPath: string): ReloadState {
    if (this.disposed) {
      return createNeutralReloadState();
    }

    const slot = this.getOrCreateSlot(configPath);
    return { ...slot.state };
  }

  getOperationResult(configPath: string, operationId: string): ReloadOperationResult | null {
    if (this.disposed) {
      return null;
    }

    const slot = this.getOrCreateSlot(configPath);
    return slot.operationResults.get(operationId) ?? null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    for (const slot of this.slots.values()) {
      if (slot.timer) {
        clearTimeout(slot.timer);
      }
      slot.timer = undefined;
      slot.pendingReason = null;
      slot.pendingOperationId = undefined;
      slot.pendingOperations.clear();
      slot.state.pending = false;
      for (const waiter of slot.pendingWaiters) {
        this.settleWaiter(waiter, this.disposedResult(waiter.operationId, waiter.reason));
      }
      slot.pendingWaiters = [];
      for (const waiter of slot.activeWaiters) {
        this.settleWaiter(waiter, this.disposedResult(waiter.operationId, waiter.reason));
      }
      slot.activeWaiters = [];
    }

    const pendingReloads = Array.from(this.inFlightReloads);
    if (pendingReloads.length > 0) {
      await Promise.allSettled(pendingReloads);
    }

    this.slots.clear();
  }

  private async executeSlot(slot: ConfigReloadSlot): Promise<void> {
    if (this.disposed) {
      return;
    }

    slot.timer = undefined;
    if (slot.state.inFlight) {
      slot.state.pending = true;
      return;
    }

    const reason = slot.pendingReason ?? slot.state.lastReason ?? 'unknown';
    const operationId = slot.pendingOperationId;
    const operations = new Map(slot.pendingOperations);
    const waiters = slot.pendingWaiters;
    slot.pendingReason = null;
    slot.pendingOperationId = undefined;
    slot.pendingOperations.clear();
    slot.pendingWaiters = [];
    slot.activeOperations = operations;
    slot.activeWaiters = waiters;
    slot.state.pending = false;
    slot.state.inFlight = true;
    slot.state.startedAt = Date.now();

    let failure: ReturnType<typeof toReloadFailure> | undefined;
    let outcome: void | ReloadAttemptOutcome = undefined;
    let reloadPromise: Promise<void | ReloadAttemptOutcome> | undefined;
    try {
      const attemptGeneration = slot.freshnessGeneration;
      reloadPromise = this.runReload({
        configPath: slot.configPath,
        reason,
        operationId,
        canPublish: () => !this.disposed && attemptGeneration === slot.freshnessGeneration,
      });
      this.inFlightReloads.add(reloadPromise);
      outcome = await reloadPromise;
    } catch (error) {
      failure = toReloadFailure(error);
    } finally {
      if (reloadPromise) {
        this.inFlightReloads.delete(reloadPromise);
      }
    }

    if (this.disposed) {
      slot.state.inFlight = false;
      slot.activeOperations = undefined;
      slot.activeWaiters = [];
      return;
    }

    const completedAt = Date.now();
    slot.state.executedCount += 1;

    if (!failure && outcome && outcome.status === 'superseded') {
      // Keep every handle and reason alive: none of this attempt's work was published.
      // Merge active and already pending batches before scheduling one immediate retry.
      const mergedOperations = new Map(operations);
      for (const [pendingOperationId, pendingReason] of slot.pendingOperations) {
        if (!mergedOperations.has(pendingOperationId)) {
          mergedOperations.set(pendingOperationId, pendingReason);
        }
      }
      slot.pendingReason = reason;
      slot.pendingOperationId = operationId ?? slot.pendingOperationId;
      slot.pendingOperations = mergedOperations;
      slot.pendingWaiters = [...waiters, ...slot.pendingWaiters];
      slot.state.pending = true;
      slot.state.lastRunSucceeded = undefined;
      slot.state.lastError = undefined;
      slot.state.lastFailure = undefined;
      slot.state.inFlight = false;
      slot.state.completedAt = completedAt;
      slot.activeOperations = undefined;
      slot.activeWaiters = [];
      slot.timer = setTimeout(() => {
        void this.executeSlot(slot);
      }, 0);
      return;
    }

    slot.state.lastRunSucceeded = !failure;
    slot.state.lastError = failure?.message;
    slot.state.lastFailure = failure;

    if (failure) {
      Logger.error('Coordinated reload failed', {
        configPath: slot.configPath,
        reason,
        error: failure.message,
      });
    }

    for (const [pendingOperationId, pendingReason] of operations) {
      slot.operationResults.set(pendingOperationId, this.createOperationResult(
        pendingOperationId,
        pendingReason,
        failure,
        completedAt,
      ));
      this.trimOperationResults(slot);
    }
    for (const waiter of waiters) {
      this.settleWaiter(waiter, this.createOperationResult(
        waiter.operationId,
        waiter.reason,
        failure,
        completedAt,
      ));
    }

    slot.state.inFlight = false;
    slot.state.completedAt = completedAt;
    slot.activeOperations = undefined;
    slot.activeWaiters = [];

    if (slot.state.pending) {
      slot.state.pending = false;
      slot.timer = setTimeout(() => {
        void this.executeSlot(slot);
      }, 0);
    }
  }

  private addPendingOperation(slot: ConfigReloadSlot, operationId: string | undefined, reason: ReloadReason): void {
    if (operationId !== undefined && !slot.pendingOperations.has(operationId)) {
      slot.pendingOperations.set(operationId, reason);
    }
  }

  private addActiveOperation(slot: ConfigReloadSlot, operationId: string, reason: ReloadReason): void {
    if (slot.activeOperations && !slot.activeOperations.has(operationId)) {
      slot.activeOperations.set(operationId, reason);
    }
  }

  private attachSuppressedWaiter(slot: ConfigReloadSlot, waiter: ReloadRequestWaiter): void {
    if (slot.state.pending || slot.timer) {
      slot.pendingWaiters.push(waiter);
      this.addPendingOperation(slot, waiter.operationId, waiter.reason);
      return;
    }

    if (slot.state.inFlight) {
      slot.activeWaiters.push(waiter);
      this.addActiveOperation(slot, waiter.operationId, waiter.reason);
      return;
    }

    // The suppression predicate guarantees there is an existing scheduled or active batch.
    // If state is inconsistent, resolve rather than leave the caller waiting forever.
    const failure = toReloadFailure(new Error('Suppressed reload has no active batch to join.'));
    this.settleWaiter(waiter, this.createOperationResult(
      waiter.operationId,
      waiter.reason,
      failure,
      Date.now(),
    ));
  }

  private settleWaiter(waiter: ReloadRequestWaiter, result: ReloadOperationResult): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    waiter.resolve(result);
  }

  private createOperationResult(
    operationId: string,
    reason: ReloadReason,
    failure: ReturnType<typeof toReloadFailure> | undefined,
    completedAt: number,
  ): ReloadOperationResult {
    return failure
      ? {
        operationId,
        reason,
        succeeded: false,
        error: failure.message,
        failure,
        completedAt,
      }
      : {
        operationId,
        reason,
        succeeded: true,
        completedAt,
      };
  }

  private disposedResult(operationId: string, reason: ReloadReason): ReloadOperationResult {
    const failure = { code: 'RELOAD_DISPOSED' as const, message: 'Reload coordinator has been disposed.' };
    return this.createOperationResult(operationId, reason, failure, Date.now());
  }

  private getOrCreateSlot(configPath: string): ConfigReloadSlot {
    const key = configurationPathKey(configPath);
    const existing = this.slots.get(key);
    if (existing) {
      return existing;
    }

    const slot: ConfigReloadSlot = {
      configPath,
      state: createNeutralReloadState(),
      timer: undefined,
      pendingReason: null,
      pendingOperationId: undefined,
      pendingOperations: new Map(),
      pendingWaiters: [],
      activeOperations: undefined,
      activeWaiters: [],
      operationResults: new Map(),
      freshnessGeneration: 0,
    };
    this.slots.set(key, slot);
    return slot;
  }

  private trimOperationResults(slot: ConfigReloadSlot): void {
    while (slot.operationResults.size > OPERATION_RESULT_LIMIT) {
      const oldest = slot.operationResults.keys().next().value as string | undefined;
      if (oldest === undefined) {
        return;
      }
      slot.operationResults.delete(oldest);
    }
  }
}

function createNeutralReloadState(): ReloadState {
  return {
    pending: false,
    inFlight: false,
    lastReason: null,
    lastRunSucceeded: undefined,
    lastError: undefined,
    scheduledCount: 0,
    executedCount: 0,
    coalescedCount: 0,
    suppressedWatcherCount: 0,
  };
}
