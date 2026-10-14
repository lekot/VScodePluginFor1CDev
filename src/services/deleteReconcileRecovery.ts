import { ReloadFailure, toReloadFailure } from '../types/reloadContracts';

// Preserve the previous total delete-reconcile deadline while completion moves to coordinator handles.
export const DELETE_RECONCILE_TIMEOUT_MS = 20 * 150;

type DeleteReconcileIssueReason = 'timeout' | 'failed';

interface RecoverDeleteUiStateArgs {
  elementName: string;
  reason: DeleteReconcileIssueReason;
  forceRefresh: () => Promise<void>;
  verifyDeletionConverged: () => Promise<boolean | null>;
}

export interface DeleteReconcileRecoveryResult {
  rollbackApplied: boolean;
  refreshAttempted: boolean;
  refreshSucceeded: boolean;
  converged: boolean | null;
  shouldNotifyUser: boolean;
  message?: string;
  refreshFailure?: ReloadFailure;
  verificationFailure?: ReloadFailure;
}

export async function recoverDeleteUiStateAfterReconcileIssue(
  args: RecoverDeleteUiStateArgs
): Promise<DeleteReconcileRecoveryResult> {
  let refreshSucceeded = false;
  let converged: boolean | null = null;
  let refreshFailure: ReloadFailure | undefined;
  let verificationFailure: ReloadFailure | undefined;
  try {
    await args.forceRefresh();
    refreshSucceeded = true;
  } catch (error) {
    refreshFailure = toReloadFailure(error);
  }
  if (refreshSucceeded) {
    try {
      converged = await args.verifyDeletionConverged();
    } catch (error) {
      verificationFailure = toReloadFailure(error);
    }
  }

  const incident = buildDeleteReconcileIncidentMessage({
    elementName: args.elementName,
    reason: args.reason,
    refreshSucceeded,
    converged,
  });

  return {
    rollbackApplied: false,
    refreshAttempted: true,
    refreshSucceeded,
    converged,
    shouldNotifyUser: incident !== null,
    message: incident ?? undefined,
    refreshFailure,
    verificationFailure,
  };
}

function buildDeleteReconcileIncidentMessage(args: {
  elementName: string;
  reason: DeleteReconcileIssueReason;
  refreshSucceeded: boolean;
  converged: boolean | null;
}): string | null {
  if (args.refreshSucceeded && args.converged === true) {
    return null;
  }

  if (!args.refreshSucceeded) {
    return `Не удалось подтвердить удаление «${args.elementName}»: автообновление дерева не завершилось. Нажмите «Обновить дерево» и проверьте элемент вручную.`;
  }

  if (args.converged === false) {
    return `Удаление «${args.elementName}» выполнено, но дерево не сошлось с текущим состоянием. Обновите дерево и проверьте, не возникла ли коллизия изменений.`;
  }

  const failureHint = args.reason === 'failed'
    ? 'фоновая проверка завершилась ошибкой'
    : 'фоновая проверка заняла больше ожидаемого';
  return `Не удалось однозначно подтвердить удаление «${args.elementName}»: ${failureHint}. Обновите дерево и проверьте результат.`;
}
