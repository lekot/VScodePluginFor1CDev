/**
 * WOW plan §2C #36 — команды привязки баз из дерева CDT 41 (узел Configuration).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataType, type TreeNode } from '../models/treeNode';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import type { ExtensionState } from '../state/extensionState';
import { normalizeConfigRelativePath } from './bindingPathUtils';

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
