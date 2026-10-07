import { Logger } from '../utils/logger';
import { configurationPathKey } from '../utils/configurationPathIdentity';
import {
  ReloadOperationResult,
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
  operationResults: Map<string, ReloadOperationResult>;
}

type ReloadRunner = (ctx: ReloadRunContext) => Promise<void>;

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MUTATION_WINDOW_TTL_MS = 1500;
// Results are stored per-config, up to 50 entries; oldest are evicted FIFO (insertion order).
// Callers should retrieve operation results promptly after completion — results may be lost
// under high-frequency reload scenarios before they are consumed.
const OPERATION_RESULT_LIMIT = 50;

export class ReloadCoordinatorService {
  private readonly slots = new Map<string, ConfigReloadSlot>();
  private readonly inFlightReloads = new Set<Promise<void>>();
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
    if (this.disposed) {
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
      return;
    }

    if (slot.state.inFlight) {
      slot.state.pending = true;
      slot.pendingReason = slot.pendingReason ?? reason;
      slot.pendingOperationId = slot.pendingOperationId ?? options?.operationId;
      this.addPendingOperation(slot, options?.operationId, reason);
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
    this.addPendingOperation(slot, options?.operationId, reason);
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
    slot.pendingReason = null;
    slot.pendingOperationId = undefined;
    slot.pendingOperations.clear();
    slot.state.pending = false;
    slot.state.inFlight = true;
    slot.state.startedAt = Date.now();

    let failure: ReturnType<typeof toReloadFailure> | undefined;
    let reloadPromise: Promise<void> | undefined;
    try {
      reloadPromise = this.runReload({ configPath: slot.configPath, reason, operationId });
      this.inFlightReloads.add(reloadPromise);
      await reloadPromise;
    } catch (error) {
      failure = toReloadFailure(error);
    } finally {
      if (reloadPromise) {
        this.inFlightReloads.delete(reloadPromise);
      }
    }

    if (this.disposed) {
      slot.state.inFlight = false;
      return;
    }

    const completedAt = Date.now();
    slot.state.executedCount += 1;
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
      slot.operationResults.set(pendingOperationId, failure
        ? {
          operationId: pendingOperationId,
          reason: pendingReason,
          succeeded: false,
          error: failure.message,
          failure,
          completedAt,
        }
        : {
          operationId: pendingOperationId,
          reason: pendingReason,
          succeeded: true,
          completedAt,
        });
      this.trimOperationResults(slot);
    }

    slot.state.inFlight = false;
    slot.state.completedAt = completedAt;

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
      operationResults: new Map(),
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
