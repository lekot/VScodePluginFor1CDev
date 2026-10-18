/**
 * WOW plan §2C #36 — команды привязки баз из дерева CDT 41 (узел Configuration).
 * WOW Phase 4 #64 — отдельные привязки для выгрузки расширения (Configuration.xml в папке расширения).
 * Unified with DeployApplicationService (Architecture Roadmap #267, Issue #255).
 */

import * as vscode from 'vscode';
import type { TreeNode } from '../models/treeNode';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import type { ExtensionState } from '../state/extensionState';
import {
  readDeployPrecheckXmlBeforeImportSetting,
  readDeployMode,
  resolveConfigurationXmlDirectory,
  vscodeSupportsDeployReadonlyLock,
  type DeploySupportContext,
  type DeployRunSummary,
} from './deployService';
import { showIbcmdInfobaseOutputChannel } from '../infobases/infobaseConfigCommands';
import { getIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';
import { showIbcmdNotFoundDialog } from '../services/ibcmd/showIbcmdNotFoundDialog';
import { runConfigurationMutation } from '../services/configurationSession/configurationMutationGateway';
import { createRequestConfigurationReload } from '../reload/requestConfigurationReload';
import {
  DeployApplicationService,
  formatDeployRunSummary,
  resolveConfigRootFromAnyNode,
  resolveBindingTargetFromMetadataTreeNode,
  type DeployOutcome,
} from './deployApplicationService';

export {
  resolveConfigRootFromAnyNode,
  resolveBindingTargetFromMetadataTreeNode,
  formatDeployRunSummary,
};

/** Минимальный контракт панели диалога (избегаем циклического импорта с bindingDialog). */
export interface BindingDialogLike {
  show(
    workspaceFolderName: string,
    configRelativePath: string,
    ibcmdExtensionName?: string,
  ): Promise<void>;
}

export async function resolveDeploySupportContext(
  state: ExtensionState,
  workspaceFolderRoot: string,
  binding: { readonly configRelativePath: string },
): Promise<DeploySupportContext | undefined> {
  const composition = state.supportComposition;
  if (!composition) {
    return undefined;
  }
  const cache = state.supportStateCache;
  if (!cache) {
    throw new Error('Support state cache is not initialized.');
  }
  const resolved = resolveConfigurationXmlDirectory(
    workspaceFolderRoot,
    binding.configRelativePath,
  );
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }
  const status = cache.get(resolved.sourceDir) ?? await cache.load(resolved.sourceDir);
  return {
    configurationId: status.configurationId,
    facade: composition.facade,
  };
}

export function resolveBindingTargetForConfigurationTreeNode(
  node: TreeNode,
  tree: MetadataTreeDataProvider,
): { workspaceFolderName: string; configRelativePath: string } | undefined {
  const target = resolveBindingTargetFromMetadataTreeNode(node, tree);
  if (!target) {
    return undefined;
  }
  return {
    workspaceFolderName: target.workspaceFolderName,
    configRelativePath: target.configRelativePath,
  };
}

export async function openBindingDialogForConfigurationFromTree(
  arg: unknown,
  state: ExtensionState,
  panel: BindingDialogLike,
  treeDataProvider: MetadataTreeDataProvider,
): Promise<void> {
  if (!state.bindingManager || !state.infobaseStorage) {
    void vscode.window.showErrorMessage('Привязки недоступны: хранилище не инициализировано.');
    return;
  }
  const node = arg as TreeNode | undefined;
  if (!node) {
    void vscode.window.showErrorMessage('Выберите узел в дереве метаданных.');
    return;
  }
  const active = treeDataProvider.resolveNodeForUi(node);
  const target = resolveBindingTargetFromMetadataTreeNode(active, treeDataProvider);
  if (!target) {
    void vscode.window.showErrorMessage(
      'Не удалось сопоставить выгрузку с workspace. Выберите «Конфигурацию» или папку расширения, где есть Configuration.xml.',
    );
    return;
  }
  await panel.show(target.workspaceFolderName, target.configRelativePath, target.ibcmdExtensionName);
}

function getDeployAppService(state: ExtensionState): DeployApplicationService {
  return new DeployApplicationService({
    bindingManager: state.bindingManager!,
    infobaseStorage: state.infobaseStorage!,
    resolveSupportContext: async (_configRoot, workspaceFolderRoot, binding) => {
      return resolveDeploySupportContext(state, workspaceFolderRoot, binding);
    },
    runConfigurationMutation,
    requestConfigurationReload: state.reloadCoordinator
      ? createRequestConfigurationReload(state)
      : undefined,
  });
}

/**
 * Полная раскатка конфигурации в привязанные базы (WOW §2C).
 */
export async function runDeployForConfigurationFromTree(
  arg: unknown,
  state: ExtensionState,
  treeDataProvider: MetadataTreeDataProvider,
): Promise<void> {
  if (!state.bindingManager || !state.infobaseStorage) {
    void vscode.window.showErrorMessage('Раскатка недоступна: хранилище или привязки не инициализированы.');
    return;
  }
  const node = arg as TreeNode | undefined;
  if (!node) {
    void vscode.window.showErrorMessage('Выберите узел «Конфигурация» в дереве метаданных.');
    return;
  }
  const active = treeDataProvider.resolveNodeForUi(node);
  const appService = getDeployAppService(state);
  const plan = await appService.prepareDeploy({ kind: 'node', node: active, treeDataProvider });
  if (!plan.ok) {
    if (plan.code === 'NO_BINDING' || plan.code === 'NO_TARGET_INFOBASE') {
      void vscode.window.showWarningMessage(
        'Для этой конфигурации нет привязанных баз. Сначала выполните «Привязать базы…».',
      );
      return;
    }
    void vscode.window.showErrorMessage(plan.error);
    return;
  }

  const { context } = plan;
  const lines = context.previewLabels.length > 0 ? `\n\n${context.previewLabels.join('\n')}` : '';
  const deployMode = readDeployMode();
  const deployModeNotice =
    deployMode === 'block'
      ? vscodeSupportsDeployReadonlyLock()
        ? '\n\nРежим 1cMetadataTree.deploy.mode = block: редактирование дерева выгрузки конфигурации будет заблокировано (только просмотр) на время раскатки.'
        : '\n\nРежим block выбран в настройках, но блокировка через files.readonlyInclude недоступна (нужен VS Code 1.88+). Раскатка продолжится без readonly.'
      : '\n\nРежим 1cMetadataTree.deploy.mode = copy: раскатка выполняется из временной копии папки с Configuration.xml; редактирование в workspace не блокируется.';
  const precheckNotice = readDeployPrecheckXmlBeforeImportSetting()
    ? '\n\nПеред загрузкой будет выполнен preflight XML (ibcmd config import) для целевой базы; при ошибке раскатка остановится.'
    : '';

  const ok = await vscode.window.showWarningMessage(
    `Конфигурация в выбранных информационных базах будет перезаписана (ibcmd config import). Продолжить?${deployModeNotice}${precheckNotice}${lines}`,
    { modal: true },
    'Продолжить',
  );
  if (ok !== 'Продолжить') {
    return;
  }

  const progressTitle =
    context.deployTargets.length === 1
      ? 'Раскатка конфигурации в привязанную базу'
      : 'Раскатка конфигурации в привязанные базы';

  // Support preflight via resolveDeploySupportContext(...) and execution via deployService.deployBinding(...)
  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: true,
    },
    async (progress, token) =>
      appService.executeDeployBinding(context, { progress, token }),
  );

  showDeployOutcomeToast(outcome);
}

export const runDeployBindingForConfigurationFromTree = runDeployForConfigurationFromTree;

export type DeployRunSummaryPresentationInput = Pick<DeployRunSummary,
  'successCount' | 'errorCount' | 'inDoubtCount' | 'skippedCount' | 'hasPartial' | 'cancelledMidChain'
>;

export function showDeployRunSummaryToast(summary: DeployRunSummaryPresentationInput): void {
  const { message: msg, fullySuccessful } = formatDeployRunSummary(summary);
  const showOut = 'Показать вывод';
  if (summary.successCount > 0 && fullySuccessful) {
    void vscode.window.showInformationMessage(msg, showOut).then((r) => {
      if (r === showOut) {
        showIbcmdInfobaseOutputChannel();
      }
    });
  } else {
    void vscode.window.showWarningMessage(msg, showOut).then((r) => {
      if (r === showOut) {
        showIbcmdInfobaseOutputChannel();
      }
    });
  }
}

function showDeployOutcomeToast(outcome: DeployOutcome): void {
  const showOut = 'Показать вывод';
  if (outcome.success) {
    void vscode.window.showInformationMessage(outcome.message, showOut).then((r) => {
      if (r === showOut) {
        showIbcmdInfobaseOutputChannel();
      }
    });
  } else {
    void vscode.window.showWarningMessage(outcome.message, showOut).then((r) => {
      if (r === showOut) {
        showIbcmdInfobaseOutputChannel();
      }
    });
  }
}

/**
 * Раскатка выбранных объектов дерева в привязанные ИБ (incremental import files).
 */
export async function runDeploySelectedObjectsFromTree(
  arg: unknown,
  allSelected: readonly TreeNode[],
  state: ExtensionState,
  treeDataProvider: MetadataTreeDataProvider,
): Promise<void> {
  if (!state.bindingManager || !state.infobaseStorage) {
    void vscode.window.showErrorMessage('Раскатка недоступна: хранилище или привязки не инициализированы.');
    return;
  }
  const node = arg as TreeNode | undefined;
  if (!node) {
    void vscode.window.showErrorMessage('Выберите узел в дереве метаданных.');
    return;
  }
  const active = treeDataProvider.resolveNodeForUi(node);
  const appService = getDeployAppService(state);
  const plan = await appService.prepareDeploy({ kind: 'node', node: active, treeDataProvider });
  if (!plan.ok) {
    void vscode.window.showErrorMessage(plan.error);
    return;
  }

  const { context } = plan;
  const ibcmd = getIbcmdService();
  if ((await ibcmd.resolveExecutablePathAsync()).kind !== 'resolved') {
    await showIbcmdNotFoundDialog();
    return;
  }

  const lines = context.previewLabels.length > 0 ? `\n\n${context.previewLabels.join('\n')}` : '';
  const selectedNodes = allSelected.length > 0 ? allSelected : [active];
  const ok = await vscode.window.showWarningMessage(
    `Выбранные объекты будут загружены в привязанные базы. Продолжить?${lines}`,
    { modal: true },
    'Продолжить',
  );
  if (ok !== 'Продолжить') {
    return;
  }

  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Раскатка выбранных объектов в привязанные базы',
      cancellable: true,
    },
    async (progress, token) =>
      appService.executeDeploySelectedObjects(context, selectedNodes, { progress, token }),
  );

  showDeployOutcomeToast(outcome);
}

/**
 * Выгрузка выбранных объектов из ИБ в файлы конфигурации (pull из базы).
 */
export async function runPullSelectedObjectsFromTree(
  arg: unknown,
  allSelected: readonly TreeNode[],
  state: ExtensionState,
  treeDataProvider: MetadataTreeDataProvider,
): Promise<void> {
  if (!state.bindingManager || !state.infobaseStorage) {
    void vscode.window.showErrorMessage('Выгрузка недоступна: хранилище или привязки не инициализированы.');
    return;
  }
  const node = arg as TreeNode | undefined;
  if (!node) {
    void vscode.window.showErrorMessage('Выберите узел в дереве метаданных.');
    return;
  }
  const active = treeDataProvider.resolveNodeForUi(node);
  const appService = getDeployAppService(state);
  const plan = await appService.prepareDeploy({ kind: 'node', node: active, treeDataProvider });
  if (!plan.ok) {
    void vscode.window.showErrorMessage(plan.error);
    return;
  }

  const { context } = plan;
  const ibcmd = getIbcmdService();
  if ((await ibcmd.resolveExecutablePathAsync()).kind !== 'resolved') {
    await showIbcmdNotFoundDialog();
    return;
  }

  const targetEntry = context.deployTargets[0];
  if (!targetEntry) {
    void vscode.window.showErrorMessage('Нет доступных баз для выгрузки.');
    return;
  }

  const selectedNodes = allSelected.length > 0 ? allSelected : [active];
  const ok = await vscode.window.showWarningMessage(
    `Выгрузить выбранные объекты из базы «${targetEntry.name}» в файлы конфигурации? Локальные файлы этих объектов будут перезаписаны.`,
    { modal: true },
    'Выгрузить',
  );
  if (ok !== 'Выгрузить') {
    return;
  }

  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Выгрузка из базы «${targetEntry.name}»`,
      cancellable: true,
    },
    async (progress, token) =>
      appService.executePullSelectedObjects(context, selectedNodes, { progress, token, entry: targetEntry }),
  );

  showDeployOutcomeToast(outcome);
}

/**
 * Раскатка изменённых файлов (git status) в привязанные ИБ.
 */
export async function runDeployChangedFilesFromTree(
  arg: unknown,
  state: ExtensionState,
  treeDataProvider: MetadataTreeDataProvider,
): Promise<void> {
  if (!state.bindingManager || !state.infobaseStorage) {
    void vscode.window.showErrorMessage('Раскатка недоступна: хранилище или привязки не инициализированы.');
    return;
  }
  const node = arg as TreeNode | undefined;
  if (!node) {
    void vscode.window.showErrorMessage('Выберите узел в дереве метаданных.');
    return;
  }
  const active = treeDataProvider.resolveNodeForUi(node);
  const appService = getDeployAppService(state);
  const plan = await appService.prepareDeploy({ kind: 'node', node: active, treeDataProvider });
  if (!plan.ok) {
    void vscode.window.showErrorMessage(plan.error);
    return;
  }

  const { context } = plan;
  const changes = await appService.detectChangedFiles(context);
  if (!changes.ok) {
    void vscode.window.showWarningMessage(changes.error);
    return;
  }
  if (changes.relativePaths.length === 0) {
    void vscode.window.showInformationMessage('Нет изменённых файлов конфигурации (по данным git).');
    return;
  }

  try {
    await state.infobaseStorage.load();
  } catch {
    void vscode.window.showErrorMessage('Не удалось загрузить каталог информационных баз.');
    return;
  }

  const ibcmd = getIbcmdService();
  if ((await ibcmd.resolveExecutablePathAsync()).kind !== 'resolved') {
    await showIbcmdNotFoundDialog();
    return;
  }

  const lines = context.previewLabels.length > 0 ? `\n\n${context.previewLabels.join('\n')}` : '';
  const ok = await vscode.window.showWarningMessage(
    `Будут загружены ${changes.relativePaths.length} изменённых файлов конфигурации в привязанные базы. Продолжить?${lines}`,
    { modal: true },
    'Продолжить',
  );
  if (ok !== 'Продолжить') {
    return;
  }

  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Раскатка изменённых файлов в привязанные базы',
      cancellable: true,
    },
    async (progress, token) =>
      appService.executeDeployChangedFiles(context, changes.relativePaths, { progress, token }),
  );

  showDeployOutcomeToast(outcome);
}

/**
 * Статус конфигурации (ИБ vs файлы) через ibcmd config export status.
 */
export async function runConfigExportStatusFromTree(
  arg: unknown,
  state: ExtensionState,
  treeDataProvider: MetadataTreeDataProvider,
): Promise<void> {
  if (!state.bindingManager || !state.infobaseStorage) {
    void vscode.window.showErrorMessage('Статус конфигурации недоступен: хранилище или привязки не инициализированы.');
    return;
  }
  const node = arg as TreeNode | undefined;
  if (!node) {
    void vscode.window.showErrorMessage('Выберите узел «Конфигурация» в дереве метаданных.');
    return;
  }
  const active = treeDataProvider.resolveNodeForUi(node);
  const ibcmd = getIbcmdService();
  if ((await ibcmd.resolveExecutablePathAsync()).kind !== 'resolved') {
    await showIbcmdNotFoundDialog();
    return;
  }
  const appService = getDeployAppService(state);
  const res = await appService.exportStatus({ kind: 'node', node: active, treeDataProvider });

  if (res.status === 'cancelled') {
    void vscode.window.showWarningMessage(`Проверка статуса отменена: ${res.message}`);
    return;
  }
  if (!res.success) {
    void vscode.window.showErrorMessage(res.message);
    return;
  }

  showIbcmdInfobaseOutputChannel();
}
