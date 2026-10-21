import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ReloadOrchestratorLifecycleContext } from '../extension/extensionFeatureContexts';
import { Logger } from '../utils/logger';
import {
  DELETE_RECONCILE_TIMEOUT_MS,
  recoverDeleteUiStateAfterReconcileIssue,
} from '../services/deleteReconcileRecovery';
import {
  ReloadFailure,
  ReloadFailureCode,
  ReloadOperationResult,
  ReloadReason,
  ReloadRequestHandle,
  ReloadScheduleOptions,
  toReloadFailure,
} from '../types/reloadContracts';

/** Dependencies for coordinated reload / delete-reconcile (injected from extension activation). */
export type ReloadOrchestratorDeps = {
  state: ReloadOrchestratorLifecycleContext;
  /** Test seam for the bounded delete-reconcile wait; production uses the preserved 3-second deadline. */
  reconcileTimeoutMs?: number;
};

class ReloadOrchestratorError extends Error {
  constructor(readonly code: ReloadFailureCode, message: string) {
    super(message);
    this.name = 'ReloadOrchestratorError';
  }
}

type ReloadCompletionOutcome =
  | { status: 'completed'; result: ReloadOperationResult }
  | { status: 'timeout'; error: ReloadOrchestratorError }
  | { status: 'rejected'; error: unknown };

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

function requestCoordinatedReload(
  deps: ReloadOrchestratorDeps,
  configPath: string,
  reason: ReloadReason,
  options?: ReloadScheduleOptions,
): ReloadRequestHandle {
  const coordinator = deps.state.reloadCoordinator;
  if (!coordinator) {
    throw new ReloadOrchestratorError(
      'RELOAD_COORDINATOR_UNAVAILABLE',
      'Reload coordinator is unavailable.',
    );
  }
  return coordinator.requestReload(configPath, reason, options);
}

function awaitBoundedCompletion(
  handle: ReloadRequestHandle,
  timeoutMs: number,
): Promise<ReloadCompletionOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    function finish(outcome: ReloadCompletionOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    }

    const timer = setTimeout(() => {
      finish({
        status: 'timeout',
        error: new ReloadOrchestratorError(
          'RELOAD_TIMEOUT',
          `Reload did not complete within ${timeoutMs} ms.`,
        ),
      });
    }, timeoutMs);

    void Promise.resolve(handle.completed).then(
      (result) => finish({ status: 'completed', result }),
      (error: unknown) => finish({ status: 'rejected', error }),
    );
  });
}

function failureFromResult(result: ReloadOperationResult): ReloadFailure {
  if (result.failure) {
    return result.failure;
  }
  return toReloadFailure(new Error(result.error ?? 'Reload did not complete successfully.'));
}

function errorFromFailure(failure: ReloadFailure): ReloadOrchestratorError {
  return new ReloadOrchestratorError(failure.code, failure.message);
}

function outcomeFailure(outcome: ReloadCompletionOutcome): ReloadFailure | undefined {
  if (outcome.status === 'timeout') {
    return toReloadFailure(outcome.error);
  }
  if (outcome.status === 'rejected') {
    return toReloadFailure(outcome.error);
  }
  return outcome.result.succeeded ? undefined : failureFromResult(outcome.result);
}

function observeBackgroundReload(
  handle: ReloadRequestHandle,
  configPath: string,
  reason: ReloadReason,
): void {
  void Promise.resolve(handle.completed).then((result) => {
    if (!result.succeeded) {
      Logger.warn('reload.coordinated.failed', {
        configPath,
        reason,
        operationId: result.operationId,
        failure: failureFromResult(result),
      });
    }
  }).catch((error: unknown) => {
    Logger.error('reload.coordinated.completion.failed', {
      configPath,
      reason,
      operationId: handle.operationId,
      failure: toReloadFailure(error),
    });
  });
}

function logRequestFailure(error: unknown, configPath: string, reason: ReloadReason): void {
  const failure = toReloadFailure(error);
  Logger.warn(
    failure.code === 'RELOAD_COORDINATOR_UNAVAILABLE'
      ? 'reload.coordinator.unavailable'
      : 'reload.coordinated.request.failed',
    {
      configPath,
      reason,
      failure,
    },
  );
}

/** Bound handlers for extension activation (deps closed over). */
export type ReloadOrchestratorHandlers = {
  scheduleCoordinatedReload: (
    configPath: string,
    reason: ReloadReason,
    options?: ReloadScheduleOptions
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
  options?: ReloadScheduleOptions
): void {
  try {
    const handle = requestCoordinatedReload(deps, configPath, reason, options);
    observeBackgroundReload(handle, configPath, reason);
    Logger.info('reload.schedule', {
      configPath,
      reason,
      operationId: options?.operationId ?? handle.operationId,
      state: deps.state.reloadCoordinator?.getState(configPath),
    });
  } catch (error) {
    logRequestFailure(error, configPath, reason);
  }
}

export async function recoverDeleteUiState(
  deps: ReloadOrchestratorDeps,
  configPath: string,
  elementName: string,
  deletedNodeId: string,
  reason: 'timeout' | 'failed'
): Promise<void> {
  const timeoutMs = deps.reconcileTimeoutMs ?? DELETE_RECONCILE_TIMEOUT_MS;
  const recovery = await recoverDeleteUiStateAfterReconcileIssue({
    elementName,
    reason,
    forceRefresh: async () => {
      const handle = requestCoordinatedReload(deps, configPath, 'delete-command', {
        operationId: randomUUID(),
        debounceMs: 0,
      });
      const outcome = await awaitBoundedCompletion(handle, timeoutMs);
      if (outcome.status === 'timeout') {
        throw outcome.error;
      }
      if (outcome.status === 'rejected') {
        throw outcome.error;
      }
      if (!outcome.result.succeeded) {
        throw errorFromFailure(failureFromResult(outcome.result));
      }
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
    refreshFailure: recovery.refreshFailure,
    verificationFailure: recovery.verificationFailure,
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
  const timeoutMs = deps.reconcileTimeoutMs ?? DELETE_RECONCILE_TIMEOUT_MS;
  let initialHandle: ReloadRequestHandle;
  try {
    coordinator?.markMutationWindow(configPath, operationId);
    initialHandle = requestCoordinatedReload(deps, configPath, 'delete-command', {
      operationId,
      debounceMs: 0,
    });
  } catch (error) {
    const failure = toReloadFailure(error);
    Logger.warn('delete.reconcile.request.failed', { operationId, elementName, failure });
    void recoverDeleteUiState(deps, configPath, elementName, deletedNodeId, 'failed').catch((recoveryError: unknown) => {
      Logger.error('delete.reconcile.monitor.failed', recoveryError);
    });
    return;
  }

  const finalize = async (): Promise<void> => {
    const outcome = await awaitBoundedCompletion(initialHandle, timeoutMs);
    const failure = outcomeFailure(outcome);
    if (failure) {
      Logger.warn('delete.reconcile.failed', {
        operationId: initialHandle.operationId,
        elementName,
        timeoutMs,
        failure,
      });
      await recoverDeleteUiState(
        deps,
        configPath,
        elementName,
        deletedNodeId,
        outcome.status === 'timeout' ? 'timeout' : 'failed',
      );
      return;
    }

    const state = deps.state.reloadCoordinator?.getState(configPath);
    Logger.info('delete.reconcile.completed', {
      operationId: initialHandle.operationId,
      success: true,
      executed: state?.executedCount,
      coalesced: state?.coalescedCount,
      suppressedWatcher: state?.suppressedWatcherCount,
    });
    vscode.window.showInformationMessage(`Удалён элемент: ${elementName}`);
  };

  void finalize().catch((error: unknown) => {
    Logger.error('delete.reconcile.monitor.failed', error);
  });
}
