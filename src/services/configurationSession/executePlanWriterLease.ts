import type { ConfigurationId } from './types';
import type { MutationOutcome } from './ConfigurationSession';
import { MutationPlanError } from './mutationPlan';
import { MutationReceiptError, type NonCommittedMutationReceipt } from './mutationReceiptError';
import {
  runConfigurationMutation,
  type MutationOutcomeRunner,
  type MutationRunner,
} from './configurationMutationGateway';
import type { MutationIntent, MutationReceipt } from './ConfigurationMutationEngine';

export interface ExecutePlanWriterLeaseInput<T> {
  readonly resourcePath: string;
  readonly configurationId?: ConfigurationId;
  readonly intent: MutationIntent;
  readonly executePlan: () => Promise<MutationReceipt<T>>;
  readonly runMutation?: MutationRunner;
  readonly runMutationWithOutcome?: MutationOutcomeRunner;
  readonly receiptFromOutcome: (outcome: MutationOutcome<MutationReceipt<T>>) => MutationReceipt<T>;
}

/** Admits an async plan builder before running it, using the existing configuration mutation runner. */
export async function executePlanUnderWriterLease<T>(
  input: ExecutePlanWriterLeaseInput<T>,
): Promise<MutationReceipt<T>> {
  if (input.runMutationWithOutcome) {
    try {
      const outcome = await input.runMutationWithOutcome(input.resourcePath, input.intent.kind, input.executePlan, {
        commitWhen: (receipt) => receipt.status === 'committed',
        shouldReconcile: (result) => result.status === 'committed'
          ? result.value.status === 'committed'
          : result.status === 'failed'
            ? isUncertainMutationReceipt(result.value) || isRecoveryRequiredError(result.error)
            : false,
      });
      return input.receiptFromOutcome(outcome);
    } catch (error) {
      return failedPlanReceipt(input, error);
    }
  }

  const runMutation = input.runMutation ?? runConfigurationMutation;
  try {
    return await runMutation(input.resourcePath, input.intent.kind, async () => {
      const receipt = await input.executePlan();
      if (receipt.status !== 'committed') {
        throw new MutationReceiptError(receipt as NonCommittedMutationReceipt<T>);
      }
      return receipt;
    }, {
      shouldReconcile: (outcome) => outcome.status === 'failed'
        ? outcome.error instanceof MutationReceiptError
          ? isUncertainMutationReceipt(outcome.error.receipt)
          : isRecoveryRequiredError(outcome.error)
        : false,
    });
  } catch (error) {
    if (error instanceof MutationReceiptError) {
      return error.receipt as MutationReceipt<T>;
    }
    return failedPlanReceipt(input, error);
  }
}

function failedPlanReceipt<T>(input: ExecutePlanWriterLeaseInput<T>, error: unknown): MutationReceipt<T> {
  if (error instanceof MutationReceiptError) {
    return error.receipt as MutationReceipt<T>;
  }
  if (error instanceof MutationPlanError) {
    if (error.code === 'PLAN_CONFLICT') {
      return {
        status: 'conflict',
        code: 'PLAN_CONFLICT',
        message: error.message,
        kind: input.intent.kind,
        resourcePath: input.resourcePath,
        configurationId: input.configurationId,
        session: input.intent.session,
      };
    }
    if (error.code === 'RECOVERY_REQUIRED') {
      return {
        status: 'recoveryRequired',
        code: 'RECOVERY_REQUIRED',
        message: error.message,
        kind: input.intent.kind,
        resourcePath: input.resourcePath,
        configurationId: input.configurationId,
        session: input.intent.session,
      };
    }
  }
  return {
    status: 'rolledBack',
    code: 'PLAN_FAILED',
    message: error instanceof Error ? error.message : String(error),
    kind: input.intent.kind,
    resourcePath: input.resourcePath,
    configurationId: input.configurationId,
    session: input.intent.session,
  };
}

function isUncertainMutationReceipt(receipt: MutationReceipt<unknown> | undefined): boolean {
  return receipt?.status === 'inDoubt' || receipt?.status === 'recoveryRequired';
}

function isRecoveryRequiredError(error: unknown): error is MutationPlanError {
  return error instanceof MutationPlanError && error.code === 'RECOVERY_REQUIRED';
}
