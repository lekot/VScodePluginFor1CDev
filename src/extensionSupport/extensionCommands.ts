import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { ExtensionState } from '../state/extensionState';
import { getSelectedNode } from '../helpers/commandHelpers';
import { borrowObjectToExtension } from './borrowObjectCommand';
import { navigateToMainObject, showRelatedObjects } from './extensionNavigator';
import { showInterceptors } from './codeInterceptNavigator';
import { Logger } from '../utils/logger';

/**
 * Register all extension-support commands (borrow, navigate, intercept).
 */
export function registerExtensionCommands(
  context: vscode.ExtensionContext,
  state: ExtensionState
): void {
  const borrowCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.borrowToExtension',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите объект метаданных основной конфигурации.');
        return;
      }
      try {
        await borrowObjectToExtension(target, state);
      } catch (err) {
        Logger.error('borrowToExtension failed', err);
        vscode.window.showErrorMessage(
          `Ошибка добавления в расширение: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const navigateToMainCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.navigateToMainObject',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите заимствованный объект расширения.');
        return;
      }
      try {
        await navigateToMainObject(target, state);
      } catch (err) {
        Logger.error('navigateToMainObject failed', err);
        vscode.window.showErrorMessage(
          `Ошибка навигации к объекту конфигурации: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const showRelatedCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.showRelatedObjects',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите объект в дереве метаданных.');
        return;
      }
      try {
        await showRelatedObjects(target, state);
      } catch (err) {
        Logger.error('showRelatedObjects failed', err);
        vscode.window.showErrorMessage(
          `Ошибка отображения связанных объектов: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const showInterceptorsCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.showInterceptors',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите узел BSL-модуля в дереве метаданных.');
        return;
      }
      const bslPath = target.filePath;
      if (!bslPath || !bslPath.toLowerCase().endsWith('.bsl')) {
        vscode.window.showWarningMessage('Команда доступна только для узлов BSL-модулей.');
        return;
      }
      try {
        await showInterceptors(bslPath, state);
      } catch (err) {
        Logger.error('showInterceptors failed', err);
        vscode.window.showErrorMessage(
          `Ошибка поиска перехватчиков: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  context.subscriptions.push(
    borrowCommand,
    navigateToMainCommand,
    showRelatedCommand,
    showInterceptorsCommand
  );
}
