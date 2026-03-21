import { TreeNode } from '../models/treeNode';

export type ReloadReason =
  | 'delete-command'
  | 'watcher'
  | 'manual-refresh'
  | 'create-command'
  | 'duplicate-command'
  | 'rename-command'
  | 'unknown';

export interface ReloadState {
  pending: boolean;
  inFlight: boolean;
  lastReason: ReloadReason | null;
  lastRunSucceeded?: boolean;
  lastError?: string;
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
