import { TreeNode } from '../models/treeNode';

export type ReloadReason =
  | 'delete-command'
  | 'watcher'
  | 'manual-refresh'
  | 'create-command'
  | 'duplicate-command'
  | 'rename-command'
  | 'unknown';

export type ReloadFailureCode =
  | 'RELOAD_DISPOSED'
  | 'CONFIGURATION_NOT_LOADED'
  | 'CONFIGURATION_PARSE_FAILED'
  | 'UNKNOWN_RELOAD_FAILURE';

export interface ReloadFailure {
  code: ReloadFailureCode;
  message: string;
}

export function toReloadFailure(error: unknown): ReloadFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error && typeof error === 'object' && 'code' in error) {
    const code = error.code;
    if (
      code === 'RELOAD_DISPOSED'
      || code === 'CONFIGURATION_NOT_LOADED'
      || code === 'CONFIGURATION_PARSE_FAILED'
    ) {
      return { code, message };
    }
  }
  return { code: 'UNKNOWN_RELOAD_FAILURE', message };
}

export interface ReloadState {
  pending: boolean;
  inFlight: boolean;
  lastReason: ReloadReason | null;
  lastRunSucceeded?: boolean;
  lastError?: string;
  lastFailure?: ReloadFailure;
  scheduledAt?: number;
  startedAt?: number;
  completedAt?: number;
  scheduledCount: number;
  executedCount: number;
  coalescedCount: number;
  suppressedWatcherCount: number;
  mutationWindowUntil?: number;
  mutationOpId?: string;
}

export interface ReloadScheduleOptions {
  debounceMs?: number;
  operationId?: string;
}

export interface ReloadRunContext {
  configPath: string;
  reason: ReloadReason;
  operationId?: string;
}

export interface ReloadOperationResult {
  operationId: string;
  reason: ReloadReason;
  succeeded: boolean;
  error?: string;
  failure?: ReloadFailure;
  completedAt: number;
}

export interface OptimisticDeleteToken {
  configRootId: string;
  parentId: string;
  removedNodeId: string;
  removedNodeSnapshot: TreeNode;
  removedIndex: number;
  operationId: string;
}
