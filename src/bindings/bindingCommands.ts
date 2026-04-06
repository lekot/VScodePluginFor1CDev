/**
 * WOW plan §2C #36 — команды привязки баз из дерева CDT 41 (узел Configuration).
 * WOW Phase 4 #64 — отдельные привязки для выгрузки расширения (Configuration.xml в папке расширения).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataType, type TreeNode } from '../models/treeNode';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import type { ExtensionState } from '../state/extensionState';
import { detectIbcmdExtensionNameFromConfigRelativePath, normalizeConfigRelativePath } from './bindingPathUtils';
import { CONFIGURATION_XML } from '../constants/fileNames';
import {
  DeployService,
  readDeployPrecheckXmlBeforeImportSetting,
  listDeployTargetLabels,
  readDeployMode,
  resolveDeployTargetsForBinding,
  vscodeSupportsDeployReadonlyLock,
} from './deployService';
import { showIbcmdInfobaseOutputChannel, runInfobaseConfigExportStatus } from '../infobases/infobaseConfigCommands';
import { getIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';
import { showIbcmdNotFoundDialog } from '../services/ibcmd/showIbcmdNotFoundDialog';
import { detectChangedConfigFiles } from '../services/ibcmd/incrementalChangeDetector';
import type { GitRepository } from '../services/ibcmd/incrementalChangeDetector';

/** Минимальный контракт панели диалога (избегаем циклического импорта с bindingDialog). */
export interface BindingDialogLike {
  show(
    workspaceFolderName: string,
    configRelativePath: string,
    ibcmdExtensionName?: string,
  ): Promise<void>;
}

export function resolveBindingTargetForConfigurationTreeNode(
  node: TreeNode,
  tree: MetadataTreeDataProvider,
): { workspaceFolderName: string; configRelativePath: string } | undefined {
  if (node.type !== MetadataType.Configuration) {
    return undefined;
  }
  const configDir = tree.getConfigPathForNode(node);
  if (!configDir) {
    return undefined;
  }
  const configXmlFs = path.join(configDir, CONFIGURATION_XML);
  const uri = vscode.Uri.file(configXmlFs);
  const wf = vscode.workspace.getWorkspaceFolder(uri);
  if (!wf) {
    return undefined;
  }
  const rel = path.relative(wf.uri.fsPath, configXmlFs).replace(/\\/g, '/');
  return {
    workspaceFolderName: wf.name,
    configRelativePath: normalizeConfigRelativePath(rel),
  };
}

function resolveBindingTargetForExtensionRootTreeNode(
  node: TreeNode,
): { workspaceFolderName: string; configRelativePath: string; ibcmdExtensionName?: string } | undefined {
  if (node.type !== MetadataType.Extension) {
    return undefined;
  }
  const props = node.properties as Record<string, unknown> | undefined;
  if (props?.isExtension !== true) {
    return undefined;
  }
  const dir = node.filePath?.trim();
  if (!dir) {
    return undefined;
  }
  const configXmlFs = path.join(dir, CONFIGURATION_XML);
  if (!fs.existsSync(configXmlFs)) {
    return undefined;
  }
  const uri = vscode.Uri.file(configXmlFs);
  const wf = vscode.workspace.getWorkspaceFolder(uri);
  if (!wf) {
    return undefined;
  }
  const rel = path.relative(wf.uri.fsPath, configXmlFs).replace(/\\/g, '/');
  const configRelativePath = normalizeConfigRelativePath(rel);
  const ibcmdExtensionName = detectIbcmdExtensionNameFromConfigRelativePath(configRelativePath);
  return { workspaceFolderName: wf.name, configRelativePath, ibcmdExtensionName };
}

/** Узел «Конфигурация» или корень выгрузки расширения с Configuration.xml. */
export function resolveBindingTargetFromMetadataTreeNode(
  node: TreeNode,
  tree: MetadataTreeDataProvider,
): { workspaceFolderName: string; configRelativePath: string; ibcmdExtensionName?: string } | undefined {
  if (node.type === MetadataType.Configuration) {
    const t = resolveBindingTargetForConfigurationTreeNode(node, tree);
    if (!t) {
      return undefined;
    }
    const ibcmdExtensionName = detectIbcmdExtensionNameFromConfigRelativePath(t.configRelativePath);
    return { ...t, ibcmdExtensionName };
  }
  return resolveBindingTargetForExtensionRootTreeNode(node);
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

/**
 * WOW §2D #43 — раскатка выгрузки в привязанные ИБ из контекста узла Configuration.
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
    void vscode.window.showErrorMessage('Выберите узел в дереве метаданных.');
    return;
  }
  const active = treeDataProvider.resolveNodeForUi(node);
  const target = resolveBindingTargetFromMetadataTreeNode(active, treeDataProvider);
  if (!target) {
    void vscode.window.showErrorMessage(
      'Не удалось сопоставить выгрузку с workspace. Выберите «Конфигурацию» или папку расширения с Configuration.xml.',
    );
    return;
  }

  const binding = await state.bindingManager.get(
    target.workspaceFolderName,
    target.configRelativePath,
    target.ibcmdExtensionName,
  );
  if (!binding || binding.infobaseIds.length === 0) {
    void vscode.window.showWarningMessage(
      'Для этой конфигурации нет привязанных баз. Сначала выполните «Привязать базы…».',
    );
    return;
  }

  let catalog;
  try {
    catalog = await state.infobaseStorage.load();
  } catch {
    void vscode.window.showErrorMessage('Не удалось загрузить каталог информационных баз.');
    return;
  }

  const preview = listDeployTargetLabels(binding, catalog);
  const ibcmd = getIbcmdService();
  if (ibcmd.resolveExecutablePath().kind !== 'resolved') {
    await showIbcmdNotFoundDialog();
    return;
  }

  const lines = preview.length > 0 ? `\n\n${preview.join('\n')}` : '';
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

  const wf = vscode.workspace.workspaceFolders?.find((f) => f.name === target.workspaceFolderName);
  if (!wf) {
    void vscode.window.showErrorMessage(`Папка workspace не найдена: «${target.workspaceFolderName}».`);
    return;
  }

  const catalogById = new Map(catalog.map((e) => [e.id, e] as const));
  const { entries: deployEntries } = resolveDeployTargetsForBinding(binding, catalogById);
  const progressTitle =
    deployEntries.length === 1
      ? 'Раскатка конфигурации в привязанную базу'
      : 'Раскатка конфигурации в привязанные базы';

  const deployService = new DeployService();
  const summary = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: true,
    },
    async (progress, token) =>
      deployService.deployBinding({
        binding,
        workspaceFolderRoot: wf.uri.fsPath,
        storage: state.infobaseStorage!,
        catalog,
        progress,
        token,
      }),
  );

  const tail = summary.cancelledMidChain ? ' Часть баз пропущена (отмена).' : '';
  const parts: string[] = [`${summary.successCount} успешно`];
  if (summary.errorCount > 0) {
    parts.push(`${summary.errorCount} с ошибками`);
  }
  if (summary.skippedCount > 0) {
    parts.push(`${summary.skippedCount} пропущено`);
  }
  const msg = `Раскатка завершена: ${parts.join(', ')}.${tail}`;
  const showOut = 'Показать вывод';
  /** Ошибок и отмены нет; ожидаемые пропуски (веб, нет в каталоге) не понижают уровень до warning. */
  const noErrorsOrCancel = summary.errorCount === 0 && !summary.cancelledMidChain;
  if (summary.successCount > 0 && noErrorsOrCancel) {
    const r = await vscode.window.showInformationMessage(msg, showOut);
    if (r === showOut) {
      showIbcmdInfobaseOutputChannel();
    }
  } else {
    const r = await vscode.window.showWarningMessage(msg, showOut);
    if (r === showOut) {
      showIbcmdInfobaseOutputChannel();
    }
  }
}

/**
 * Resolves the binding target by walking up the tree from any node to the nearest
 * Configuration or Extension ancestor, then resolving via resolveBindingTargetFromMetadataTreeNode.
 */
function resolveConfigRootFromAnyNode(
  node: TreeNode,
  treeDataProvider: MetadataTreeDataProvider,
): { workspaceFolderName: string; configRelativePath: string; ibcmdExtensionName?: string } | undefined {
  let current: TreeNode | undefined = node;
  while (current) {
    if (current.type === MetadataType.Configuration || current.type === MetadataType.Extension) {
      const target = resolveBindingTargetFromMetadataTreeNode(current, treeDataProvider);
      if (target) {
        return target;
      }
    }
    current = current.parent as TreeNode | undefined;
  }
  return undefined;
}

function showDeployRunSummaryToast(summary: { successCount: number; errorCount: number; skippedCount: number; cancelledMidChain: boolean }): void {
  const tail = summary.cancelledMidChain ? ' Часть баз пропущена (отмена).' : '';
  const parts: string[] = [`${summary.successCount} успешно`];
  if (summary.errorCount > 0) {
    parts.push(`${summary.errorCount} с ошибками`);
  }
  if (summary.skippedCount > 0) {
    parts.push(`${summary.skippedCount} пропущено`);
  }
  const msg = `Раскатка завершена: ${parts.join(', ')}.${tail}`;
  const showOut = 'Показать вывод';
  const noErrorsOrCancel = summary.errorCount === 0 && !summary.cancelledMidChain;
  if (summary.successCount > 0 && noErrorsOrCancel) {
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
  const target = resolveConfigRootFromAnyNode(active, treeDataProvider);
  if (!target) {
    void vscode.window.showErrorMessage(
      'Не удалось сопоставить выгрузку с workspace. Выберите узел внутри конфигурации с привязанной базой.',
    );
    return;
  }

  const binding = await state.bindingManager.get(
    target.workspaceFolderName,
    target.configRelativePath,
    target.ibcmdExtensionName,
  );
  if (!binding || binding.infobaseIds.length === 0) {
    void vscode.window.showWarningMessage(
      'Для этой конфигурации нет привязанных баз. Сначала выполните «Привязать базы…».',
    );
    return;
  }

  let catalog;
  try {
    catalog = await state.infobaseStorage.load();
  } catch {
    void vscode.window.showErrorMessage('Не удалось загрузить каталог информационных баз.');
    return;
  }

  const ibcmd = getIbcmdService();
  if (ibcmd.resolveExecutablePath().kind !== 'resolved') {
    await showIbcmdNotFoundDialog();
    return;
  }

  const preview = listDeployTargetLabels(binding, catalog);
  const lines = preview.length > 0 ? `\n\n${preview.join('\n')}` : '';
  const selectedNodes = allSelected.length > 0 ? allSelected : [active];
  const ok = await vscode.window.showWarningMessage(
    `Выбранные объекты будут загружены в привязанные базы. Продолжить?${lines}`,
    { modal: true },
    'Продолжить',
  );
  if (ok !== 'Продолжить') {
    return;
  }

  const wf = vscode.workspace.workspaceFolders?.find((f) => f.name === target.workspaceFolderName);
  if (!wf) {
    void vscode.window.showErrorMessage(`Папка workspace не найдена: «${target.workspaceFolderName}».`);
    return;
  }

  const deployService = new DeployService();
  const summary = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Раскатка выбранных объектов в привязанные базы',
      cancellable: true,
    },
    async (progress, token) =>
      deployService.deploySelectedObjects({
        binding,
        workspaceFolderRoot: wf.uri.fsPath,
        storage: state.infobaseStorage!,
        catalog,
        selectedNodes,
        progress,
        token,
      }),
  );

  showDeployRunSummaryToast(summary);
}

/**
 * Раскатка изменённых файлов конфигурации (по данным git) в привязанные ИБ.
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
  const target = resolveConfigRootFromAnyNode(active, treeDataProvider);
  if (!target) {
    void vscode.window.showErrorMessage(
      'Не удалось сопоставить выгрузку с workspace. Выберите узел внутри конфигурации с привязанной базой.',
    );
    return;
  }

  const binding = await state.bindingManager.get(
    target.workspaceFolderName,
    target.configRelativePath,
    target.ibcmdExtensionName,
  );
  if (!binding || binding.infobaseIds.length === 0) {
    void vscode.window.showWarningMessage(
      'Для этой конфигурации нет привязанных баз. Сначала выполните «Привязать базы…».',
    );
    return;
  }

  const wf = vscode.workspace.workspaceFolders?.find((f) => f.name === target.workspaceFolderName);
  if (!wf) {
    void vscode.window.showErrorMessage(`Папка workspace не найдена: «${target.workspaceFolderName}».`);
    return;
  }

  const configRoot = path.join(wf.uri.fsPath, path.dirname(target.configRelativePath));

  const deps = {
    getGitRepository(): GitRepository | undefined {
      const gitExt = vscode.extensions.getExtension<{ getAPI(version: number): { repositories: GitRepository[] } }>('vscode.git');
      const api = gitExt?.exports?.getAPI(1);
      if (!api) {
        return undefined;
      }
      return api.repositories.find(
        (r) => configRoot.toLowerCase().startsWith(r.rootUri.fsPath.toLowerCase()),
      );
    },
  };

  const changesResult = await detectChangedConfigFiles(configRoot, deps);
  if ('error' in changesResult) {
    void vscode.window.showWarningMessage(changesResult.error);
    return;
  }
  if (changesResult.relativePaths.length === 0) {
    void vscode.window.showInformationMessage('Нет изменённых файлов конфигурации (по данным git).');
    return;
  }

  let catalog;
  try {
    catalog = await state.infobaseStorage.load();
  } catch {
    void vscode.window.showErrorMessage('Не удалось загрузить каталог информационных баз.');
    return;
  }

  const ibcmd = getIbcmdService();
  if (ibcmd.resolveExecutablePath().kind !== 'resolved') {
    await showIbcmdNotFoundDialog();
    return;
  }

  const preview = listDeployTargetLabels(binding, catalog);
  const lines = preview.length > 0 ? `\n\n${preview.join('\n')}` : '';
  const ok = await vscode.window.showWarningMessage(
    `Будут загружены ${changesResult.relativePaths.length} изменённых файлов конфигурации в привязанные базы. Продолжить?${lines}`,
    { modal: true },
    'Продолжить',
  );
  if (ok !== 'Продолжить') {
    return;
  }

  const deployService = new DeployService();
  const summary = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Раскатка изменённых файлов в привязанные базы',
      cancellable: true,
    },
    async (progress, token) =>
      deployService.deployChangedFiles({
        binding,
        workspaceFolderRoot: wf.uri.fsPath,
        storage: state.infobaseStorage!,
        catalog,
        relativeFiles: changesResult.relativePaths,
        progress,
        token,
      }),
  );

  showDeployRunSummaryToast(summary);
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
  const target = resolveBindingTargetFromMetadataTreeNode(active, treeDataProvider);
  if (!target) {
    void vscode.window.showErrorMessage(
      'Не удалось сопоставить выгрузку с workspace. Выберите узел «Конфигурация» с привязанной базой.',
    );
    return;
  }

  const binding = await state.bindingManager.get(
    target.workspaceFolderName,
    target.configRelativePath,
    target.ibcmdExtensionName,
  );
  if (!binding || binding.infobaseIds.length === 0) {
    void vscode.window.showWarningMessage(
      'Для этой конфигурации нет привязанных баз. Сначала выполните «Привязать базы…».',
    );
    return;
  }

  let catalog;
  try {
    catalog = await state.infobaseStorage.load();
  } catch {
    void vscode.window.showErrorMessage('Не удалось загрузить каталог информационных баз.');
    return;
  }

  const ibcmd = getIbcmdService();
  if (ibcmd.resolveExecutablePath().kind !== 'resolved') {
    await showIbcmdNotFoundDialog();
    return;
  }

  const wf = vscode.workspace.workspaceFolders?.find((f) => f.name === target.workspaceFolderName);
  if (!wf) {
    void vscode.window.showErrorMessage(`Папка workspace не найдена: «${target.workspaceFolderName}».`);
    return;
  }

  const configRoot = path.join(wf.uri.fsPath, path.dirname(target.configRelativePath));
  const configDumpInfoPath = path.join(configRoot, 'ConfigDumpInfo.xml');
  if (!fs.existsSync(configDumpInfoPath)) {
    void vscode.window.showWarningMessage(
      'Файл ConfigDumpInfo.xml не найден в каталоге конфигурации. Выполните полную выгрузку (ibcmd config export), чтобы создать его.',
    );
    return;
  }

  const catalogById = new Map(catalog.map((e) => [e.id, e] as const));
  const { entries } = resolveDeployTargetsForBinding(binding, catalogById);
  if (entries.length === 0) {
    void vscode.window.showWarningMessage('Нет доступных баз для проверки статуса.');
    return;
  }

  const entry = entries[0]!;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Проверка статуса конфигурации',
      cancellable: true,
    },
    async (_progress, token) => {
      await runInfobaseConfigExportStatus({
        storage: state.infobaseStorage!,
        entry,
        configDumpInfoPath,
        token,
        ibcmdExtensionName: target.ibcmdExtensionName,
      });
    },
  );

  showIbcmdInfobaseOutputChannel();
}
