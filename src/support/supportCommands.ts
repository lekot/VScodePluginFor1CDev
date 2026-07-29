import * as vscode from 'vscode';
import type { ConfigurationId } from '../services/configurationSession/types';
import type { SupportApplicationFacade } from './supportApplicationServiceRegistry';
import type {
  MasterSupportSnapshot,
  MetadataUniverseSnapshot,
  ObjectSupportMode,
  SupportModeMutationOutcome,
  SupportRunSummary,
  SupportStatusResult,
  SupportSyncOperationOutcome,
  SupportVerifyOperationOutcome,
  TargetSelection,
  TargetSupportSyncResult,
  TargetSupportVerifyResult,
} from './supportTypes';

type ReadySupportStatusResult = SupportStatusResult & {
  readonly master: {
    readonly kind: 'ready';
    readonly snapshot: MasterSupportSnapshot;
  };
  readonly metadataUniverse: MetadataUniverseSnapshot;
};

export const SUPPORT_COMMAND_IDS = Object.freeze({
  setObjectMode: '1c-metadata-tree.support.setObjectMode',
  allowObjectEditing: '1c-metadata-tree.support.allowObjectEditing',
  enableObjectRules: '1c-metadata-tree.support.enableObjectRules',
  sync: '1c-metadata-tree.support.sync',
  verify: '1c-metadata-tree.support.verify',
  showLastRun: '1c-metadata-tree.support.showLastRun',
});

export type SupportCommandContext =
  | {
      readonly kind: 'configuration';
      readonly configurationId: ConfigurationId;
    }
  | {
      readonly kind: 'object';
      readonly configurationId: ConfigurationId;
      readonly objectId: string;
    };

export interface SupportCommandTarget {
  readonly canonicalTargetId: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

export interface RegisterSupportCommandsDeps {
  readonly facade: SupportApplicationFacade;
  /**
   * The composition root owns tree-node interpretation. It must return an object context only
   * for a concrete metadata object covered by the support metadata universe.
   */
  readonly resolveContext: (argument: unknown) => SupportCommandContext | undefined;
  /** Lists current binding targets for the explicit "selected infobases" preset. */
  readonly listTargets: (configurationId: ConfigurationId) => Promise<readonly SupportCommandTarget[]>;
  readonly onStatusChanged?: (configurationId: ConfigurationId) => void;
}

interface ModePick extends vscode.QuickPickItem {
  readonly mode: ObjectSupportMode;
}

interface SelectionPick extends vscode.QuickPickItem {
  readonly selectionKind: 'all' | 'retryable' | 'ids';
}

interface TargetPick extends vscode.QuickPickItem {
  readonly targetId: string;
}

const MODE_PICKS: readonly ModePick[] = [
  {
    label: 'Не редактируется',
    description: 'Объект остаётся на поддержке и заблокирован',
    mode: 'notEditable',
  },
  {
    label: 'Редактируется с сохранением поддержки',
    description: 'Изменения разрешены, объект остаётся на поддержке',
    mode: 'editableWithSupport',
  },
  {
    label: 'Снят с поддержки',
    description: 'Поставщик больше не управляет объектом',
    mode: 'removedFromSupport',
  },
];

const TARGET_SELECTION_PICKS: readonly SelectionPick[] = [
  {
    label: 'Все информационные базы',
    description: 'Обработать все доступные цели',
    selectionKind: 'all',
  },
  {
    label: 'Только требующие повтора',
    description: 'Retryable failures, неопределённый результат и расхождение цели',
    selectionKind: 'retryable',
  },
  {
    label: 'Выбранные информационные базы…',
    description: 'Выбрать цели вручную',
    selectionKind: 'ids',
  },
];

export function registerSupportCommands(deps: RegisterSupportCommandsDeps): vscode.Disposable[] {
  const command = (
    id: string,
    handler: (argument: unknown) => Promise<void>,
  ): vscode.Disposable => vscode.commands.registerCommand(id, (argument: unknown) => safelyRun(handler, argument));

  return [
    command(SUPPORT_COMMAND_IDS.setObjectMode, (argument) => setObjectMode(deps, argument)),
    command(SUPPORT_COMMAND_IDS.allowObjectEditing, (argument) => allowObjectEditing(deps, argument)),
    command(SUPPORT_COMMAND_IDS.enableObjectRules, (argument) => enableObjectRules(deps, argument)),
    command(SUPPORT_COMMAND_IDS.sync, (argument) => synchronizeSupport(deps, argument)),
    command(SUPPORT_COMMAND_IDS.verify, (argument) => verifySupport(deps, argument)),
    command(SUPPORT_COMMAND_IDS.showLastRun, (argument) => showLastRun(deps, argument)),
  ];
}

async function setObjectMode(deps: RegisterSupportCommandsDeps, argument: unknown): Promise<void> {
  const context = requireObjectContext(deps, argument);
  if (!context) {
    return;
  }

  const current = await getFreshObjectStatus(deps, context);
  if (!current) {
    return;
  }
  const picked = await vscode.window.showQuickPick([...MODE_PICKS], {
    title: 'Режим поддержки объекта',
    placeHolder: `Текущий режим: ${modeLabel(current.objectMode)}`,
  });
  if (!picked || picked.mode === current.objectMode) {
    return;
  }

  const outcome = await deps.facade.setObjectMode({
    configurationId: context.configurationId,
    objectId: context.objectId,
    targetMode: picked.mode,
    expectedGenerationId: current.snapshot.generationId,
  });
  await reportMutationOutcome(outcome, context.configurationId, deps);
}

async function allowObjectEditing(deps: RegisterSupportCommandsDeps, argument: unknown): Promise<void> {
  const context = requireObjectContext(deps, argument);
  if (!context) {
    return;
  }

  const current = await getFreshObjectStatus(deps, context);
  if (!current || current.objectMode === 'editableWithSupport') {
    if (current?.objectMode === 'editableWithSupport') {
      await vscode.window.showInformationMessage('Объект уже редактируется с сохранением поддержки.');
    }
    return;
  }

  const outcome = await deps.facade.setObjectMode({
    configurationId: context.configurationId,
    objectId: context.objectId,
    targetMode: 'editableWithSupport',
    expectedGenerationId: current.snapshot.generationId,
  });
  await reportMutationOutcome(outcome, context.configurationId, deps);
}

async function enableObjectRules(deps: RegisterSupportCommandsDeps, argument: unknown): Promise<void> {
  const context = requireObjectContext(deps, argument);
  if (!context) {
    return;
  }

  const current = await getFreshObjectStatus(deps, context);
  if (!current) {
    return;
  }
  if (current.snapshot.globalEditability === 'enabled') {
    await vscode.window.showInformationMessage(
      'Изменение отдельных объектов уже разрешено. Используйте команду изменения режима поддержки.',
    );
    return;
  }

  const confirmation = 'Включить и разрешить выбранный объект';
  const answer = await vscode.window.showWarningMessage(
    'Включить возможность изменения конфигурации?',
    {
      modal: true,
      detail:
        'Будут включены объектные правила поддержки. Выбранный объект станет редактируемым '
        + 'с сохранением поддержки; остальные объекты останутся заблокированы.',
    },
    confirmation,
  );
  if (answer !== confirmation) {
    return;
  }

  const outcome = await deps.facade.enableObjectRules({
    configurationId: context.configurationId,
    targetObjectId: context.objectId,
    targetMode: 'editableWithSupport',
    expectedGenerationId: current.snapshot.generationId,
    expectedMetadataUniverseGenerationId:
      current.status.metadataUniverse.metadataUniverseGenerationId,
  });
  await reportMutationOutcome(outcome, context.configurationId, deps);
}

async function synchronizeSupport(
  deps: RegisterSupportCommandsDeps,
  argument: unknown,
): Promise<void> {
  const context = requireConfigurationContext(deps, argument);
  if (!context) {
    return;
  }
  if (!await requireFreshReadyStatus(deps, context.configurationId)) {
    return;
  }

  const targets = await pickTargetSelection(deps, context.configurationId, 'Синхронизация поддержки');
  if (!targets) {
    return;
  }
  const outcome = await deps.facade.sync({
    configurationId: context.configurationId,
    targets,
    verification: 'fast',
  });
  deps.onStatusChanged?.(context.configurationId);
  await reportSyncOutcome(outcome);
}

async function verifySupport(deps: RegisterSupportCommandsDeps, argument: unknown): Promise<void> {
  const context = requireConfigurationContext(deps, argument);
  if (!context) {
    return;
  }
  if (!await requireFreshReadyStatus(deps, context.configurationId)) {
    return;
  }

  const targets = await pickTargetSelection(
    deps,
    context.configurationId,
    'Строгая проверка синхронизации поддержки',
  );
  if (!targets) {
    return;
  }
  const outcome = await deps.facade.verify({
    configurationId: context.configurationId,
    targets,
  });
  deps.onStatusChanged?.(context.configurationId);
  await reportVerifyOutcome(outcome);
}

async function showLastRun(deps: RegisterSupportCommandsDeps, argument: unknown): Promise<void> {
  const context = requireConfigurationContext(deps, argument);
  if (!context) {
    return;
  }
  const outcome = await deps.facade.getLastRun({ configurationId: context.configurationId });
  if (outcome.status === 'operationRejected') {
    await showErrorCode(outcome.errorCode);
    return;
  }
  if (!outcome.run) {
    await vscode.window.showInformationMessage('Для этой конфигурации ещё нет запусков синхронизации поддержки.');
    return;
  }
  await showRunSummary(outcome.run);
}

async function safelyRun(
  handler: (argument: unknown) => Promise<void>,
  argument: unknown,
): Promise<void> {
  try {
    await handler(argument);
  } catch {
    await vscode.window.showErrorMessage(
      'Операция поддержки завершилась внутренней ошибкой. Состояние не считается подтверждённым.',
    );
  }
}

function requireObjectContext(
  deps: RegisterSupportCommandsDeps,
  argument: unknown,
): Extract<SupportCommandContext, { readonly kind: 'object' }> | undefined {
  const context = deps.resolveContext(argument);
  if (context?.kind === 'object' && context.objectId.trim()) {
    return context;
  }
  void vscode.window.showWarningMessage(
    'Команда доступна только для конкретного объекта конфигурации, присутствующего в правилах поддержки.',
  );
  return undefined;
}

function requireConfigurationContext(
  deps: RegisterSupportCommandsDeps,
  argument: unknown,
): Extract<SupportCommandContext, { readonly kind: 'configuration' }> | undefined {
  const context = deps.resolveContext(argument);
  if (context?.kind === 'configuration') {
    return context;
  }
  void vscode.window.showWarningMessage('Выберите корневой узел конфигурации.');
  return undefined;
}

async function requireFreshReadyStatus(
  deps: RegisterSupportCommandsDeps,
  configurationId: ConfigurationId,
): Promise<ReadySupportStatusResult | undefined> {
  const status = await deps.facade.getStatus({ configurationId });
  if (status.status === 'operationRejected') {
    await showErrorCode(status.errorCode);
    return undefined;
  }
  if (status.master.kind !== 'ready') {
    await showErrorCode(masterErrorCode(status.master));
    return undefined;
  }
  if (status.metadataUniverse === undefined) {
    await showErrorCode('SUPPORT_OPERATION_FAILED');
    return undefined;
  }
  return status as ReadySupportStatusResult;
}

async function getFreshObjectStatus(
  deps: RegisterSupportCommandsDeps,
  context: Extract<SupportCommandContext, { readonly kind: 'object' }>,
): Promise<{
  readonly status: ReadySupportStatusResult;
  readonly snapshot: MasterSupportSnapshot;
  readonly objectMode: ObjectSupportMode;
} | undefined> {
  const status = await deps.facade.getStatus({
    configurationId: context.configurationId,
    objectIds: [context.objectId],
  });
  if (status.status === 'operationRejected') {
    await showErrorCode(status.errorCode);
    return undefined;
  }
  if (status.master.kind !== 'ready') {
    await showErrorCode(masterErrorCode(status.master));
    return undefined;
  }
  if (status.metadataUniverse === undefined) {
    await showErrorCode('SUPPORT_OPERATION_FAILED');
    return undefined;
  }
  const object = status.master.snapshot.objectModes.get(context.objectId);
  if (!object) {
    await showErrorCode('SUPPORT_OBJECT_NOT_FOUND');
    return undefined;
  }
  return {
    status: status as ReadySupportStatusResult,
    snapshot: status.master.snapshot,
    objectMode: object.effectiveMode,
  };
}

async function pickTargetSelection(
  deps: RegisterSupportCommandsDeps,
  configurationId: ConfigurationId,
  title: string,
): Promise<TargetSelection | undefined> {
  const scope = await vscode.window.showQuickPick([...TARGET_SELECTION_PICKS], {
    title,
    placeHolder: 'Выберите информационные базы',
  });
  if (!scope) {
    return undefined;
  }
  if (scope.selectionKind === 'all') {
    return { kind: 'all' };
  }
  if (scope.selectionKind === 'retryable') {
    return { kind: 'retryable', include: ['failed', 'inDoubt', 'targetDrift'] };
  }

  const available = await deps.listTargets(configurationId);
  if (available.length === 0) {
    await vscode.window.showWarningMessage('Для конфигурации нет доступных целей синхронизации.');
    return undefined;
  }
  const picks = await vscode.window.showQuickPick<TargetPick>(
    available.map((target) => ({
      label: target.label,
      description: target.description,
      detail: target.detail,
      targetId: target.canonicalTargetId,
    })),
    {
      title: `${title}: выбранные информационные базы`,
      placeHolder: 'Отметьте одну или несколько целей',
      canPickMany: true,
    },
  );
  if (!picks || picks.length === 0) {
    return undefined;
  }
  return {
    kind: 'ids',
    targetIds: [...new Set(picks.map((pick) => pick.targetId))],
  };
}

async function reportMutationOutcome(
  outcome: SupportModeMutationOutcome,
  configurationId: ConfigurationId,
  deps: RegisterSupportCommandsDeps,
): Promise<void> {
  deps.onStatusChanged?.(configurationId);
  switch (outcome.status) {
    case 'synchronized':
      await vscode.window.showInformationMessage(
        outcome.preflight.scope === 'masterOnly'
          ? 'Режим поддержки объекта изменён.'
          : `Режим поддержки объекта изменён и синхронизирован: ${targetCounts(outcome.run)}.`,
      );
      return;
    case 'committedWithReplicationIssue':
      await vscode.window.showWarningMessage(
        `Режим в ParentConfigurations.bin изменён, но синхронизация с ИБ не завершена`
        + runSuffix(outcome.run)
        + '. Запустите повторную синхронизацию.',
      );
      return;
    case 'mutationRejected':
      await showErrorCode(outcome.errorCode);
      return;
    case 'masterRejected':
      await showErrorCode(outcome.errorCode);
      return;
    case 'preflightRejected':
      await showPreflightError(outcome.preflight);
      return;
    case 'operationRejected':
      await showErrorCode(outcome.errorCode);
      return;
  }
}

async function reportSyncOutcome(outcome: SupportSyncOperationOutcome): Promise<void> {
  switch (outcome.status) {
    case 'synchronized':
      await vscode.window.showInformationMessage(
        outcome.run.scope === 'masterOnly'
          ? 'Синхронизация не требуется: у конфигурации нет привязанных ИБ.'
          : `Поддержка синхронизирована: ${targetCounts(outcome.run)}.`,
      );
      return;
    case 'incomplete':
      await vscode.window.showWarningMessage(
        `Синхронизация поддержки не завершена${runSuffix(outcome.run)}. `
        + 'Результат не считается успешным; доступен повтор для проблемных целей.',
      );
      return;
    case 'masterRejected':
      await showErrorCode(outcome.errorCode);
      return;
    case 'preflightRejected':
      await showPreflightError(outcome.preflight);
      return;
    case 'targetSelectionRejected':
      await showErrorCode(outcome.errorCode);
      return;
    case 'operationRejected':
      await showErrorCode(outcome.errorCode);
      return;
  }
}

async function reportVerifyOutcome(outcome: SupportVerifyOperationOutcome): Promise<void> {
  switch (outcome.status) {
    case 'synchronized':
      await vscode.window.showInformationMessage(
        outcome.run.scope === 'masterOnly'
          ? 'Проверка завершена: у конфигурации нет привязанных ИБ.'
          : `Строгая проверка завершена: ${targetCounts(outcome.run)}.`,
      );
      return;
    case 'incomplete':
      await vscode.window.showWarningMessage(
        `Строгая проверка не подтверждает синхронизацию${runSuffix(outcome.run)}. `
        + 'Результат не считается успешным.',
      );
      return;
    case 'masterRejected':
      await showErrorCode(outcome.errorCode);
      return;
    case 'preflightRejected':
      await showPreflightError(outcome.preflight);
      return;
    case 'targetSelectionRejected':
      await showErrorCode(outcome.errorCode);
      return;
    case 'operationRejected':
      await showErrorCode(outcome.errorCode);
      return;
  }
}

async function showRunSummary(run: SupportRunSummary): Promise<void> {
  const heading =
    `${run.operation === 'sync' ? 'Синхронизация' : 'Проверка'}: ${runStateLabel(run.state)}; `
    + `generation ${run.desiredGenerationId}`;
  if (run.targets.length === 0) {
    await vscode.window.showInformationMessage(`${heading}. Целевые ИБ отсутствуют.`);
    return;
  }

  const items: vscode.QuickPickItem[] = run.targets.map((target) => ({
    label: `${targetStateIcon(target.state)} ${target.canonicalTargetId}`,
    description: targetStateLabel(target),
    detail: target.infobaseIds.length > 0
      ? `ИБ: ${target.infobaseIds.join(', ')}`
      : 'Связанные ИБ не указаны',
  }));
  await vscode.window.showQuickPick(items, {
    title: heading,
    placeHolder: 'Результаты по целям (выбор ничего не изменяет)',
  });
}

async function showPreflightError(
  preflight: Extract<
    SupportModeMutationOutcome,
    { readonly status: 'preflightRejected' }
  >['preflight'],
): Promise<void> {
  if (preflight.reason === 'bindingInvalid') {
    await vscode.window.showErrorMessage(
      'Синхронизация поддержки отклонена: настройки привязок ИБ некорректны.',
    );
    return;
  }
  await vscode.window.showErrorMessage(
    `Синхронизация поддержки отклонена: неподдерживаемых целей — ${preflight.unsupportedTargets.length}.`,
  );
}

async function showErrorCode(errorCode: string): Promise<void> {
  const messages: Readonly<Record<string, string>> = {
    SUPPORT_NOT_MANAGED: 'Конфигурация не находится на поддержке.',
    SUPPORT_FILE_MISSING: 'Файл ParentConfigurations.bin не найден.',
    SUPPORT_FILE_INVALID: 'Файл ParentConfigurations.bin повреждён или имеет неверный формат.',
    SUPPORT_FORMAT_UNSUPPORTED: 'Формат ParentConfigurations.bin не поддерживается.',
    SUPPORT_MASTER_RECOVERY_REQUIRED:
      'ParentConfigurations.bin требует восстановления. Изменения заблокированы.',
    SUPPORT_OBJECT_NOT_FOUND: 'Объект не найден в актуальных правилах поддержки.',
    SUPPORT_STALE_GENERATION:
      'Правила поддержки уже изменились. Состояние обновлено; повторите выбор режима.',
    SUPPORT_METADATA_UNIVERSE_STALE:
      'Состав объектов конфигурации уже изменился. Состояние обновлено; повторите выбор режима.',
    SUPPORT_GLOBAL_EDITING_DISABLED:
      'Изменение отдельных объектов отключено. Используйте отдельную команду включения этой возможности.',
    SUPPORT_OBJECT_UNIVERSE_INCOMPLETE:
      'Нельзя безопасно изменить глобальные правила: состав объектов конфигурации определён не полностью.',
    SUPPORT_EFFECTIVE_DIFF_VIOLATION:
      'Изменение отклонено: оно затронуло бы правила других объектов.',
    SUPPORT_OPERATION_FAILED:
      'Операция поддержки не выполнена. Состояние не считается подтверждённым.',
  };
  await vscode.window.showErrorMessage(
    messages[errorCode] ?? `Операция поддержки отклонена (${errorCode}).`,
  );
}

function masterErrorCode(master: Exclude<SupportStatusResult['master'], { readonly kind: 'ready' }>): string {
  if (master.kind === 'unknown') {
    return master.errorCode;
  }
  return master.reason === 'missing' ? 'SUPPORT_FILE_MISSING' : 'SUPPORT_NOT_MANAGED';
}

function modeLabel(mode: ObjectSupportMode): string {
  return MODE_PICKS.find((item) => item.mode === mode)?.label ?? mode;
}

function runSuffix(run: SupportRunSummary | undefined): string {
  return run ? ` (прогон: ${runStateLabel(run.state)}, ${targetCounts(run)})` : '';
}

function targetCounts(run: SupportRunSummary): string {
  if (run.targets.length === 0) {
    return 'целевых ИБ нет';
  }
  const counts = new Map<string, number>();
  for (const target of run.targets) {
    counts.set(target.state, (counts.get(target.state) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([state, count]) => `${targetStateLabelByName(state)} — ${count}`)
    .join(', ');
}

function runStateLabel(state: SupportRunSummary['state']): string {
  const labels: Record<SupportRunSummary['state'], string> = {
    complete: 'завершено',
    partial: 'частично',
    failed: 'ошибка',
    cancelled: 'отменено',
    obsolete: 'устарело',
  };
  return labels[state];
}

function targetStateLabel(target: TargetSupportSyncResult | TargetSupportVerifyResult): string {
  if (target.state === 'failed') {
    return `${targetStateLabelByName(target.state)} (${target.errorCode}; `
      + `${target.retryable ? 'можно повторить' : 'повтор не поможет'})`;
  }
  if (target.state === 'stale') {
    return `${targetStateLabelByName(target.state)} (${target.reason})`;
  }
  if (target.state === 'inDoubt') {
    return `${targetStateLabelByName(target.state)} (${target.errorCode})`;
  }
  if (target.state === 'skipped') {
    return `${targetStateLabelByName(target.state)} (${target.reason})`;
  }
  return targetStateLabelByName(target.state);
}

function targetStateLabelByName(state: string): string {
  const labels: Readonly<Record<string, string>> = {
    applied: 'применено',
    verified: 'проверено',
    stale: 'расхождение',
    failed: 'ошибка',
    inDoubt: 'результат не определён',
    skipped: 'пропущено',
  };
  return labels[state] ?? state;
}

function targetStateIcon(state: string): string {
  switch (state) {
    case 'applied':
    case 'verified':
      return '$(pass)';
    case 'failed':
      return '$(error)';
    case 'stale':
    case 'inDoubt':
      return '$(warning)';
    default:
      return '$(circle-slash)';
  }
}
