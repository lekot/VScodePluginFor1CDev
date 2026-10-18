import type { RequestConfigurationReload } from './requestConfigurationReload';
import type { ReconciliationOutcome, ReloadReason } from '../types/reloadContracts';

export async function reconcileAfterCommit(
  configPath: string,
  reason: ReloadReason,
  requestConfigurationReload: RequestConfigurationReload,
): Promise<ReconciliationOutcome> {
  try {
    await requestConfigurationReload(configPath, reason);
    return { status: 'succeeded' };
  } catch (error) {
    return {
      status: 'failed',
      code: originalErrorCode(error),
      message: originalErrorMessage(error),
    };
  }
}

function originalErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'UNKNOWN_RELOAD_FAILURE';
}

function originalErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}
