import { appendIbcmdOutputLine } from '../infobases/infobaseConfigCommands';
import type { InfobaseEntry } from '../infobases/models/infobaseEntry';
import { resolveInfobaseCanonicalIdentity } from '../infobases/infobaseCanonicalIdentity';
import { DeployLockedObjectsPlanner, type DeploySupportPlannerRequest, type DeploySupportPreflight } from './deployLockedObjectsFilter';
import type { DeploySupportContext, DeploySupportErrorCode } from './deployContracts';
import type { SupportApplicationFacade } from '../support/supportApplicationServiceRegistry';
import type { MasterSupportState, SupportStatusResult } from '../support/supportTypes';

export type TargetSupportGate =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly errorCode: DeploySupportErrorCode;
      readonly message: string;
    };

export async function planDeploySupport(
  support: DeploySupportContext | undefined,
  mode: DeploySupportPlannerRequest['mode'],
  relativeFiles: readonly string[],
): Promise<DeploySupportPreflight | undefined> {
  if (!support) {
    return undefined;
  }
  return new DeployLockedObjectsPlanner(support.facade).plan({
    configurationId: support.configurationId,
    mode,
    relativeFiles,
  });
}

export async function gateConfigurationXmlRetry(
  support: DeploySupportContext | undefined,
  entry: InfobaseEntry,
  plannedPreflight: DeploySupportPreflight | undefined,
  retryFiles: readonly string[],
): Promise<TargetSupportGate> {
  if (!support) {
    return { accepted: true };
  }
  const freshPreflight = await planDeploySupport(support, 'files', retryFiles);
  if (!freshPreflight) {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Не удалось сформировать свежий support-план для повтора с Configuration.xml.',
    );
  }
  if (isDeploySupportRejected(freshPreflight)) {
    return supportGateFailure(
      freshPreflight.errorCode,
      `Повтор с Configuration.xml запрещён: support replan отклонён. ${freshPreflight.diagnostics.join(' ')}`,
    );
  }
  if (
    plannedPreflight?.kind === 'ready'
    && (
      freshPreflight.kind !== 'ready'
      || freshPreflight.generationId !== plannedPreflight.generationId
    )
  ) {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Повтор с Configuration.xml запрещён: generation master поддержки изменилась; сформируйте план раскатки повторно.',
    );
  }
  if (freshPreflight.kind === 'ready' && freshPreflight.lockedSupportSubjectIds.length > 0) {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Повтор с Configuration.xml запрещён: свежий support-план содержит заблокированные объекты.',
    );
  }
  return synchronizePendingSupportForTarget(
    support,
    entry,
    false,
    freshPreflight,
  );
}

/**
 * Called only from an outer shared target queue lease. The facade sync uses an
 * `ids` selection containing that exact canonical key; the queue's
 * AsyncLocalStorage reentrancy therefore keeps support apply and ibcmd under
 * one lease without reacquisition or all-target expansion.
 */
export async function synchronizePendingSupportForTarget(
  support: DeploySupportContext | undefined,
  entry: InfobaseEntry,
  forceSync: boolean,
  expectedPreflight: DeploySupportPreflight | undefined,
): Promise<TargetSupportGate> {
  if (!support) {
    return { accepted: true };
  }
  if (!expectedPreflight || isDeploySupportRejected(expectedPreflight)) {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Раскатка запрещена: отсутствует согласованный immutable support-план.',
    );
  }

  let masterStatus;
  try {
    masterStatus = await support.facade.getMasterStatus({
      configurationId: support.configurationId,
    });
  } catch {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Не удалось получить master-состояние поддержки перед раскаткой.',
    );
  }
  if (masterStatus.status !== 'available') {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      `Master-состояние поддержки недоступно: ${masterStatus.errorCode}.`,
    );
  }
  if (!samePlannedMaster(expectedPreflight, masterStatus.master)) {
    return supportGateFailure(
      'SUPPORT_OPERATION_FAILED',
      'Состояние master поддержки изменилось после deploy preflight; сформируйте план раскатки повторно.',
    );
  }
  if (masterStatus.master.kind === 'unknown') {
    return supportGateFailure(
      masterStatus.master.errorCode,
      `Раскатка запрещена: состояние ParentConfigurations.bin неизвестно (${masterStatus.master.errorCode}).`,
    );
  }
  if (masterStatus.master.kind === 'unmanaged') {
    return { accepted: true };
  }
  const plannedGenerationId = masterStatus.master.snapshot.generationId;

  let identity;
  try {
    identity = await resolveInfobaseCanonicalIdentity(entry);
  } catch {
    return supportGateFailure(
      'SUPPORT_REPLICATION_FAILED',
      'Не удалось вычислить canonical identity целевой ИБ для support/deploy lease.',
    );
  }
  if (!forceSync && !isTargetSupportPending(expectedPreflight.status, identity.canonicalTargetId)) {
    return { accepted: true };
  }

  let syncOutcome;
  try {
    syncOutcome = await support.facade.sync({
      configurationId: support.configurationId,
      targets: { kind: 'ids', targetIds: [identity.canonicalTargetId] },
      verification: 'fast',
    });
  } catch {
    return supportGateFailure(
      'SUPPORT_REPLICATION_FAILED',
      'Синхронизация поддержки перед раскаткой завершилась с ошибкой.',
    );
  }
  if (syncOutcome.status !== 'synchronized') {
    const code = supportSyncErrorCode(syncOutcome);
    return supportGateFailure(
      code,
      `Поддержка не синхронизирована с целевой ИБ: ${code}.`,
    );
  }
  if (syncOutcome.preflight.scope !== 'replicated' || syncOutcome.run.scope !== 'replicated') {
    return supportGateFailure(
      'SUPPORT_DEPLOY_TARGET_NOT_REPLICATED',
      'Support sync неожиданно завершился в masterOnly scope; раскатка в целевую ИБ запрещена.',
    );
  }
  const target = syncOutcome.run.targets.find(
    (item) => item.canonicalTargetId === identity.canonicalTargetId,
  );
  if (
    syncOutcome.master.generationId !== plannedGenerationId
    || syncOutcome.run.desiredGenerationId !== plannedGenerationId
    || !target
    || target.desiredGenerationId !== plannedGenerationId
    || !(
      (target.state === 'applied' && target.acknowledgedGenerationId === plannedGenerationId)
      || (target.state === 'verified' && target.verifiedGenerationId === plannedGenerationId)
    )
  ) {
    return supportGateFailure(
      'SUPPORT_REPLICATION_INCOMPLETE',
      'Support sync не подтвердил planned generation на master/run/target; сформируйте план раскатки повторно.',
    );
  }
  return { accepted: true };
}

function supportSyncErrorCode(
  outcome: Exclude<
    Awaited<ReturnType<SupportApplicationFacade['sync']>>,
    { readonly status: 'synchronized' }
  >,
): DeploySupportErrorCode {
  if (outcome.status === 'incomplete' || outcome.status === 'operationRejected') {
    return outcome.errorCode;
  }
  if (outcome.status === 'preflightRejected') {
    return outcome.preflight.errorCode;
  }
  return outcome.errorCode;
}

function samePlannedMaster(
  expected: Exclude<DeploySupportPreflight, RejectedDeploySupportPreflight>,
  actual: MasterSupportState,
): boolean {
  if (expected.kind === 'unmanaged') {
    return actual.kind === 'unmanaged'
      && actual.reason === expected.reason
      && expected.status.master.kind === 'unmanaged'
      && expected.status.master.reason === expected.reason;
  }
  return actual.kind === 'ready'
    && actual.snapshot.generationId === expected.generationId
    && expected.status.master.kind === 'ready'
    && expected.status.master.snapshot.generationId === expected.generationId;
}

function isTargetSupportPending(
  status: SupportStatusResult,
  canonicalTargetId: string,
): boolean {
  if (status.master.kind !== 'ready') {
    return false;
  }
  const generationId = status.master.snapshot.generationId;
  const run = status.lastRun;
  if (
    !run
    || run.desiredGenerationId !== generationId
    || run.scope !== 'replicated'
  ) {
    return true;
  }
  const target = run.targets.find((item) => item.canonicalTargetId === canonicalTargetId);
  if (!target) {
    return true;
  }
  return !(
    target.desiredGenerationId === generationId
    && (
      (target.state === 'applied' && target.acknowledgedGenerationId === generationId)
      || (target.state === 'verified' && target.verifiedGenerationId === generationId)
    )
  );
}

function supportGateFailure(
  errorCode: DeploySupportErrorCode,
  message: string,
): TargetSupportGate {
  return { accepted: false, errorCode, message };
}

export function isSupportGateFailure(
  value: unknown,
): value is Extract<TargetSupportGate, { readonly accepted: false }> {
  return typeof value === 'object'
    && value !== null
    && 'accepted' in value
    && (value as { readonly accepted?: unknown }).accepted === false;
}

export type RejectedDeploySupportPreflight = Extract<
  DeploySupportPreflight,
  { readonly kind: 'unknown' | 'fullDeployUnsafe' }
>;

export function isDeploySupportRejected(
  preflight: DeploySupportPreflight | undefined,
): preflight is RejectedDeploySupportPreflight {
  return preflight?.kind === 'unknown' || preflight?.kind === 'fullDeployUnsafe';
}

export function appendSupportFilePlan(preflight: DeploySupportPreflight | undefined): void {
  if (!preflight || isDeploySupportRejected(preflight)) {
    return;
  }
  if (preflight.supportFileRouted) {
    appendIbcmdOutputLine(
      '[support-preflight] Ext/ParentConfigurations.bin исключён из ibcmd import files и маршрутизирован через support facade.',
    );
  }
  if (preflight.skippedLockedFiles.length > 0) {
    appendIbcmdOutputLine(
      `[support-preflight] Заблокированные master-файлы пропущены: ${preflight.skippedLockedFiles.length}.`,
    );
  }
}

export function supportSkipMessage(preflight: DeploySupportPreflight | undefined): string {
  if (!preflight || isDeploySupportRejected(preflight)) {
    return 'Файлы для раскатки отсутствуют.';
  }
  const parts: string[] = [];
  if (preflight.skippedLockedFiles.length > 0) {
    parts.push(`заблокировано поддержкой: ${preflight.skippedLockedFiles.length}`);
  }
  if (preflight.supportFileRouted) {
    parts.push('ParentConfigurations.bin обработан support facade');
  }
  return `ibcmd не запускался (${parts.join('; ') || 'после preflight файлов не осталось'}).`;
}
