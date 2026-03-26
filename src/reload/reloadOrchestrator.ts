import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { Logger } from '../utils/logger';
import {
  DELETE_RECONCILE_ATTEMPTS,
  DELETE_RECONCILE_POLL_MS,
  DELETE_RECONCILE_TIMEOUT_MS,
  recoverDeleteUiStateAfterReconcileIssue,
} from '../services/deleteReconcileRecovery';
import { ReloadReason } from '../types/reloadContracts';

/** Dependencies for coordinated reload / delete-reconcile (injected from extension activation). */
export type ReloadOrchestratorDeps = {
  state: ExtensionState;
  invalidateCacheAndReload: (configPath: string) => Promise<void>;
};

async function verifyNodeDeletedInTree(
  deps: ReloadOrchestratorDeps,
  configPath: string,
  deletedNodeId: string
): Promise<boolean | null> {
  const provider = deps.state.treeDataProvider;
  if (!provider) {
    return null;
  }
  const existing = provider.findNodeById(deletedNodeId);
  if (!existing) {
    return true;
  }
  const existingConfigPath = provider.getConfigPathForNode(existing);
  if (!existingConfigPath) {
    return null;
  }
  return path.normalize(existingConfigPath) !== path.normalize(configPath);
}

/** Bound handlers for extension activation (deps closed over). */
export type ReloadOrchestratorHandlers = {
  scheduleCoordinatedReload: (
    configPath: string,
    reason: ReloadReason,
    options?: { debounceMs?: number; operationId?: string }
  ) => void;
  scheduleDeleteReconcile: (
    configPath: string,
    operationId: string,
    deletedNodeId: string,
    elementName: string
  ) => void;
};

export function createReloadOrchestratorHandlers(deps: ReloadOrchestratorDeps): ReloadOrchestratorHandlers {
  return {
    scheduleCoordinatedReload: (configPath, reason, options) =>
      scheduleCoordinatedReload(deps, configPath, reason, options),
    scheduleDeleteReconcile: (configPath, operationId, deletedNodeId, elementName) =>
      scheduleDeleteReconcile(deps, configPath, operationId, deletedNodeId, elementName),
  };
}

export function scheduleCoordinatedReload(
  deps: ReloadOrchestratorDeps,
  configPath: string,
  reason: ReloadReason,
  options?: { debounceMs?: number; operationId?: string }
): void {
  if (!deps.state.reloadCoordinator) {
    void deps.invalidateCacheAndReload(configPath).catch((error) => Logger.error('Fallback reload failed', error));
    return;
  }
  deps.state.reloadCoordinator.scheduleReload(configPath, reason, options);
  Logger.info('reload.schedule', {
    configPath,
    reason,
    operationId: options?.operationId,
    state: deps.state.reloadCoordinator.getState(configPath),
  });
}

export async function recoverDeleteUiState(
  deps: ReloadOrchestratorDeps,
  configPath: string,
  elementName: string,
  deletedNodeId: string,
  reason: 'timeout' | 'failed'
): Promise<void> {
  const recovery = await recoverDeleteUiStateAfterReconcileIssue({
    elementName,
    reason,
    forceRefresh: async () => {
      await deps.invalidateCacheAndReload(configPath);
    },
    verifyDeletionConverged: async () => verifyNodeDeletedInTree(deps, configPath, deletedNodeId),
  });

  const logPayload = {
    configPath,
    elementName,
    deletedNodeId,
    reason,
    rollbackApplied: recovery.rollbackApplied,
    refreshAttempted: recovery.refreshAttempted,
    refreshSucceeded: recovery.refreshSucceeded,
    converged: recovery.converged,
    shouldNotifyUser: recovery.shouldNotifyUser,
  };
  if (recovery.shouldNotifyUser) {
    Logger.warn('delete.reconcile.recovery', logPayload);
    if (recovery.message) {
      vscode.window.showWarningMessage(recovery.message);
    }
  } else {
    Logger.info('delete.reconcile.recovery.silent', logPayload);
  }
}

export function scheduleDeleteReconcile(
  deps: ReloadOrchestratorDeps,
  configPath: string,
  operationId: string,
  deletedNodeId: string,
  elementName: string
): void {
  const coordinator = deps.state.reloadCoordinator;
  if (!coordinator) {
    void deps.invalidateCacheAndReload(configPath).catch((error) => Logger.error('Fallback delete reconcile failed', error));
    return;
  }

  coordinator.markMutationWindow(configPath, operationId);
  const initialState = coordinator.getState(configPath);
  const baselineExecuted = initialState.executedCount;
  scheduleCoordinatedReload(deps, configPath, 'delete-command', { operationId, debounceMs: 0 });

  const finalize = async (): Promise<void> => {
    for (let i = 0; i < DELETE_RECONCILE_ATTEMPTS; i++) {
      await new Promise((resolve) => setTimeout(resolve, DELETE_RECONCILE_POLL_MS));
      const result = coordinator.getOperationResult(configPath, operationId);
      if (result) {
        if (!result.succeeded) {
          Logger.warn('delete.reconcile.failed', {
            operationId,
            elementName,
            reason: result.reason,
            error: result.error,
          });
          await recoverDeleteUiState(deps, configPath, elementName, deletedNodeId, 'failed');
          return;
        }

        const state = coordinator.getState(configPath);
        Logger.info('delete.reconcile.completed', {
          operationId,
          success: true,
          baselineExecuted,
          scheduled: state.scheduledCount,
          executed: state.executedCount,
          coalesced: state.coalescedCount,
          suppressedWatcher: state.suppressedWatcherCount,
        });
        vscode.window.showInformationMessage(`Удалён элемент: ${elementName}`);
        return;
      }
    }

    Logger.warn('delete.reconcile.timeout', { operationId, elementName, timeoutMs: DELETE_RECONCILE_TIMEOUT_MS });
    await recoverDeleteUiState(deps, configPath, elementName, deletedNodeId, 'timeout');
  };

  void finalize().catch((error) => {
    Logger.error('delete.reconcile.monitor.failed', error);
  });
}
