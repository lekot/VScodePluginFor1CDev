import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { MetadataType, TreeNode } from '../models/treeNode';
import { getSelectedNode } from '../helpers/commandHelpers';
import { Logger } from '../utils/logger';
import { getFormPaths } from '../formEditor/formPaths';
import { getConfigurationXmlPathForNode } from '../utils/configHelpers';

type RegisterEditorCommandsDeps = {
  state: ExtensionState;
};

export function registerEditorCommands(deps: RegisterEditorCommandsDeps): vscode.Disposable[] {
  const { state } = deps;

  const showPropertiesCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.showProperties',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (state.propertiesProvider) {
        if (target) {
          Logger.info(`Showing properties for: ${target.name}`);
        } else {
          Logger.debug('Showing properties panel (no node selected)');
        }
        await state.propertiesProvider.showProperties(target);
      }
    }
  );

  const openXMLCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openXML',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        return;
      }
      const pathToOpen =
        (state.treeDataProvider &&
          getConfigurationXmlPathForNode(target, state.treeDataProvider.getConfigPathForNode.bind(state.treeDataProvider))) ??
        (target.type === MetadataType.Form && target.filePath
          ? getFormPaths(target.filePath).formXmlPath
          : target.filePath);
      if (!pathToOpen) {
        vscode.window.showWarningMessage('No XML file associated with this element');
        return;
      }
      try {
        Logger.info(`Opening XML file: ${pathToOpen}`);
        const uri = vscode.Uri.file(pathToOpen);
        await vscode.window.showTextDocument(uri);
      } catch (err) {
        Logger.error('Failed to open XML', err);
        vscode.window.showErrorMessage(
          `Не удалось открыть файл: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const openBslModuleCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openBslModule',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        return;
      }
      const fp = target.filePath;
      if (!fp || !fp.toLowerCase().endsWith('.bsl')) {
        vscode.window.showWarningMessage('Для этого узла нет файла модуля BSL или путь не задан.');
        return;
      }
      try {
        Logger.info(`Opening BSL module: ${fp}`);
        await vscode.window.showTextDocument(vscode.Uri.file(fp));
      } catch (err) {
        Logger.error('Failed to open BSL module', err);
        vscode.window.showErrorMessage(
          `Не удалось открыть модуль: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const openFormEditorCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openFormEditor',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите узел формы в дереве метаданных.');
        return;
      }
      if (target.type !== MetadataType.Form || !target.filePath) {
        vscode.window.showWarningMessage('Редактор форм доступен только для узла формы.');
        return;
      }
      const { formXmlPath } = getFormPaths(target.filePath);
      const uri = vscode.Uri.file(formXmlPath);
      try {
        await vscode.commands.executeCommand('vscode.openWith', uri, '1c-form-editor');
      } catch (err) {
        Logger.error('Failed to open form editor', err);
        vscode.window.showErrorMessage(
          `Не удалось открыть редактор формы: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const openRightsEditorCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openRightsEditor',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showWarningMessage('Select a role node in the metadata tree.');
        return;
      }
      if (target.type !== MetadataType.Role || !target.filePath) {
        vscode.window.showWarningMessage('Rights editor is only available for role nodes.');
        return;
      }
      try {
        if (state.rolesRightsEditorProvider) {
          const configPath =
            state.treeDataProvider?.getConfigPathForNode(target) ?? state.treeDataProvider?.getConfigPath();
          await state.rolesRightsEditorProvider.show(target.filePath, configPath);
        }
      } catch (err) {
        Logger.error('Failed to open rights editor', err);
        vscode.window.showErrorMessage(
          `Failed to open rights editor: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const saveRightsEditorCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.saveRightsEditor',
    async () => {
      if (state.rolesRightsEditorProvider) {
        await state.rolesRightsEditorProvider.triggerSave();
      } else {
        vscode.window.showWarningMessage('Rights editor is not open.');
      }
    }
  );

  return [
    showPropertiesCommand,
    openXMLCommand,
    openBslModuleCommand,
    openFormEditorCommand,
    openRightsEditorCommand,
    saveRightsEditorCommand,
  ];
}
