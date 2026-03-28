/**
 * WOW plan §2C #36 — команды привязки баз из дерева CDT 41 (узел Configuration).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataType, type TreeNode } from '../models/treeNode';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import type { ExtensionState } from '../state/extensionState';
import { normalizeConfigRelativePath } from './bindingPathUtils';
import {
  DeployService,
  listDeployTargetLabels,
  readDeployMode,
  vscodeSupportsDeployReadonlyLock,
} from './deployService';
import { showIbcmdInfobaseOutputChannel } from '../infobases/infobaseConfigCommands';
import { getIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';
import { showIbcmdNotFoundDialog } from '../services/ibcmd/showIbcmdNotFoundDialog';

/** Минимальный контракт панели диалога (избегаем циклического импорта с bindingDialog). */
export interface BindingDialogLike {
  show(workspaceFolderName: string, configRelativePath: string): Promise<void>;
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
  const configXmlFs = path.join(configDir, 'Configuration.xml');
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
  if (!node || node.type !== MetadataType.Configuration) {
    void vscode.window.showErrorMessage('Выберите узел «Конфигурация» в дереве метаданных.');
    return;
  }
  const active = treeDataProvider.resolveNodeForUi(node);
  const target = resolveBindingTargetForConfigurationTreeNode(active, treeDataProvider);
  if (!target) {
    void vscode.window.showErrorMessage(
      'Не удалось сопоставить конфигурацию с папкой workspace. Убедитесь, что выгрузка открыта из многокорневого workspace.',
    );
    return;
  }
  await panel.show(target.workspaceFolderName, target.configRelativePath);
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
  if (!node || node.type !== MetadataType.Configuration) {
    void vscode.window.showErrorMessage('Выберите узел «Конфигурация» в дереве метаданных.');
    return;
  }
  const active = treeDataProvider.resolveNodeForUi(node);
  const target = resolveBindingTargetForConfigurationTreeNode(active, treeDataProvider);
  if (!target) {
    void vscode.window.showErrorMessage(
      'Не удалось сопоставить конфигурацию с папкой workspace. Убедитесь, что выгрузка открыта из workspace.',
    );
    return;
  }

  const binding = await state.bindingManager.get(target.workspaceFolderName, target.configRelativePath);
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
  const ok = await vscode.window.showWarningMessage(
    `Конфигурация в выбранных информационных базах будет перезаписана (ibcmd config import). Продолжить?${deployModeNotice}${lines}`,
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
      title: 'Раскатка конфигурации в привязанные базы',
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
  const fullyClean =
    summary.errorCount === 0 && summary.skippedCount === 0 && !summary.cancelledMidChain;
  if (summary.successCount > 0 && fullyClean) {
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
