import * as path from 'path';
import { Logger } from '../utils/logger';
import {
  ReloadOperationResult,
  ReloadReason,
  ReloadRunContext,
  ReloadScheduleOptions,
  ReloadState,
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
  private readonly defaultDebounceMs: number;
  private readonly mutationWindowTtlMs: number;

  constructor(
    private readonly runReload: ReloadRunner,
    cfg?: ReloadCoordinatorConfig
  ) {
    this.defaultDebounceMs = cfg?.defaultDebounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.mutationWindowTtlMs = cfg?.mutationWindowTtlMs ?? DEFAULT_MUTATION_WINDOW_TTL_MS;
  }

  scheduleReload(configPath: string, reason: ReloadReason, options?: ReloadScheduleOptions): void {
    const slot = this.getOrCreateSlot(configPath);
    const now = Date.now();
    slot.state.lastReason = reason;
    slot.state.scheduledAt = now;
    slot.state.scheduledCount += 1;

    const mutationWindowActive = !!slot.state.mutationWindowUntil && now <= slot.state.mutationWindowUntil;
    if (reason === 'watcher' && mutationWindowActive && (slot.state.inFlight || slot.timer || slot.state.pending)) {
      slot.state.coalescedCount += 1;
      slot.state.suppressedWatcherCount += 1;
      Logger.debug('Suppressed watcher reload inside mutation window', { configPath, reason });
      return;
    }

    if (slot.state.inFlight) {
      slot.state.pending = true;
      slot.pendingReason = slot.pendingReason ?? reason;
      slot.pendingOperationId = slot.pendingOperationId ?? options?.operationId;
      slot.state.coalescedCount += 1;
      Logger.debug('Coalesced reload while in-flight', { configPath, reason });
      return;
    }

    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.state.coalescedCount += 1;
    }

    slot.pendingReason = reason;
    slot.pendingOperationId = options?.operationId;
    const debounceMs = options?.debounceMs ?? this.defaultDebounceMs;
    slot.timer = setTimeout(() => {
      void this.executeSlot(slot);
    }, debounceMs);
  }

  markMutationWindow(configPath: string, operationId: string, ttlMs?: number): void {
    const slot = this.getOrCreateSlot(configPath);
    const now = Date.now();
    slot.state.mutationWindowUntil = now + (ttlMs ?? this.mutationWindowTtlMs);
    slot.state.mutationOpId = operationId;
  }

  getState(configPath: string): ReloadState {
    const slot = this.getOrCreateSlot(configPath);
    return { ...slot.state };
  }

  getOperationResult(configPath: string, operationId: string): ReloadOperationResult | null {
    const slot = this.getOrCreateSlot(configPath);
    return slot.operationResults.get(operationId) ?? null;
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      if (slot.timer) {
        clearTimeout(slot.timer);
      }
    }
    this.slots.clear();
  }

  private async executeSlot(slot: ConfigReloadSlot): Promise<void> {
    slot.timer = undefined;
    if (slot.state.inFlight) {
      slot.state.pending = true;
      return;
    }

    const reason = slot.pendingReason ?? slot.state.lastReason ?? 'unknown';
    const operationId = slot.pendingOperationId;
    slot.pendingReason = null;
    slot.pendingOperationId = undefined;
    slot.state.pending = false;
    slot.state.inFlight = true;
    slot.state.startedAt = Date.now();

    try {
      await this.runReload({ configPath: slot.configPath, reason, operationId });
      slot.state.executedCount += 1;
      slot.state.lastRunSucceeded = true;
      slot.state.lastError = undefined;
      if (operationId) {
        slot.operationResults.set(operationId, {
          operationId,
          reason,
          succeeded: true,
          completedAt: Date.now(),
        });
        this.trimOperationResults(slot);
      }
    } catch (error) {
      slot.state.executedCount += 1;
      slot.state.lastRunSucceeded = false;
      slot.state.lastError = error instanceof Error ? error.message : String(error);
      if (operationId) {
        slot.operationResults.set(operationId, {
          operationId,
          reason,
          succeeded: false,
          error: error instanceof Error ? error.message : String(error),
          completedAt: Date.now(),
        });
        this.trimOperationResults(slot);
      }
      Logger.error('Coordinated reload failed', {
        configPath: slot.configPath,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      slot.state.inFlight = false;
      slot.state.completedAt = Date.now();

      if (slot.state.pending) {
        slot.state.pending = false;
        slot.timer = setTimeout(() => {
          void this.executeSlot(slot);
        }, 0);
      }
    }
  }

  private getOrCreateSlot(configPath: string): ConfigReloadSlot {
    const key = normalizeConfigPath(configPath);
    const existing = this.slots.get(key);
    if (existing) {
      return existing;
    }

    const slot: ConfigReloadSlot = {
      configPath,
      state: {
        pending: false,
        inFlight: false,
        lastReason: null,
        lastRunSucceeded: undefined,
        lastError: undefined,
        scheduledCount: 0,
        executedCount: 0,
        coalescedCount: 0,
        suppressedWatcherCount: 0,
      },
      timer: undefined,
      pendingReason: null,
      pendingOperationId: undefined,
      operationResults: new Map(),
    };
    this.slots.set(key, slot);
    return slot;
  }

  private trimOperationResults(slot: ConfigReloadSlot): void {
    while (slot.operationResults.size > OPERATION_RESULT_LIMIT) {
      const oldest = slot.operationResults.keys().next().value as string | undefined;
      if (!oldest) {
        return;
      }
      slot.operationResults.delete(oldest);
    }
  }
}

function normalizeConfigPath(configPath: string): string {
  return path.normalize(configPath).replace(/\\/g, '/').toLowerCase();
}
