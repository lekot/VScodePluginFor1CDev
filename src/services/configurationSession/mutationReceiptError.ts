import type { MutationOutcomeStatus, MutationReceipt } from './ConfigurationMutationEngine';
import { MutationPlanError } from './mutationPlan';

export type MutationFailureStatus = Exclude<MutationOutcomeStatus, 'committed'>;

export type NonCommittedMutationReceipt<T = unknown> = MutationReceipt<T> & {
  readonly status: MutationFailureStatus;
};

export interface MutationFailureProjection {
  readonly status: MutationFailureStatus;
  readonly code: string;
  readonly effectPossible: boolean;
  readonly message: string;
}

const FALLBACK_CODES: Record<MutationFailureStatus, string> = {
  conflict: 'MUTATION_CONFLICT',
  rolledBack: 'MUTATION_ROLLED_BACK',
  recoveryRequired: 'MUTATION_RECOVERY_REQUIRED',
  inDoubt: 'MUTATION_IN_DOUBT',
};
const DEFAULT_MESSAGES: Record<MutationFailureStatus, string> = {
  conflict: 'Изменение не выполнено: обнаружен конфликт.',
  rolledBack: 'Изменение отменено, исходное состояние восстановлено.',
  recoveryRequired: 'Не удалось подтвердить результат изменения.',
  inDoubt: 'Результат изменения не подтверждён.',
};
const UNCERTAIN_EFFECT_WARNING =
  'Изменения могли сохраниться; требуется проверка состояния и при необходимости восстановление конфигурации.';

const PLAN_ERROR_STATUS: Record<MutationPlanError['code'], MutationFailureStatus> = {
  PLAN_CONFLICT: 'conflict',
  PLAN_FAILED: 'rolledBack',
  RECOVERY_REQUIRED: 'recoveryRequired',
};

function buildErrorMessage(receipt: NonCommittedMutationReceipt<unknown>, message?: string): string {
  const context = message ?? receipt.message ?? DEFAULT_MESSAGES[receipt.status];
  return receipt.status === 'recoveryRequired' || receipt.status === 'inDoubt'
    ? `${context} ${UNCERTAIN_EFFECT_WARNING}`
    : context;
}

export class MutationReceiptError extends Error {
  public readonly status: MutationFailureStatus;
  public readonly code: string;
  public readonly effectPossible: boolean;

  constructor(
    public readonly receipt: NonCommittedMutationReceipt<unknown>,
    message?: string,
  ) {
    super(buildErrorMessage(receipt, message));
    this.name = 'MutationReceiptError';
    this.status = receipt.status;
    this.code = receipt.code && receipt.code.trim()
      ? receipt.code
      : FALLBACK_CODES[receipt.status];
    this.effectPossible = receipt.status === 'recoveryRequired' || receipt.status === 'inDoubt';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Return a committed result or preserve the engine's typed failure at an adapter boundary. */
export function unwrapMutationReceipt<T>(receipt: MutationReceipt<T>, message?: string): T {
  if (receipt.status !== 'committed') {
    throw new MutationReceiptError(receipt as NonCommittedMutationReceipt<T>, message);
  }
  return receipt.result as T;
}

/** Build user-facing text and machine fields only for a typed mutation failure. */
export function projectMutationFailure(error: unknown): MutationFailureProjection | undefined {
  const visited = new Set<unknown>();
  let current: unknown = error;
  let status: MutationFailureStatus | undefined;
  let code: string | undefined;
  let effectPossible = false;

  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current instanceof MutationReceiptError) {
      status = current.status;
      code = current.code;
      effectPossible = current.effectPossible;
      break;
    }
    if (current instanceof MutationPlanError) {
      status = PLAN_ERROR_STATUS[current.code];
      code = current.code;
      effectPossible = status === 'recoveryRequired';
      break;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }

  if (!status || !code) { return undefined; }

  const outerMessage = error instanceof Error && error.message.trim() ? error.message : undefined;
  const message = outerMessage ?? DEFAULT_MESSAGES[status];
  const userMessage = effectPossible && !message.includes(UNCERTAIN_EFFECT_WARNING)
    ? `${message} ${UNCERTAIN_EFFECT_WARNING}`
    : message;

  return {
    status,
    code,
    effectPossible,
    message: userMessage,
  };
}
