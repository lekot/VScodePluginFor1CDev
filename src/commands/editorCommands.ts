import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionState } from '../state/extensionState';
import { MetadataType, TreeNode } from '../models/treeNode';
import { getSelectedNode } from '../helpers/commandHelpers';
import { Logger } from '../utils/logger';
import { getFormPaths } from '../formEditor/formPaths';
import { getConfigurationXmlPathForNode } from '../utils/configHelpers';
import { resolveTemplatePreviewTargetPath } from './resolveTemplatePreviewTargetPath';
import { resolveDeployTargetsForBinding, resolveConfigurationXmlDirectory } from '../bindings/deployService';
import { showIbcmdNotFoundDialog } from '../services/ibcmd/showIbcmdNotFoundDialog';
import { getIbcmdService } from '../services/ibcmd/ibcmdServiceSingleton';
import { runIbcmdXmlImportPreflight } from '../services/ibcmdXmlPreflightService';
import { appendIbcmdOutputLine, showIbcmdInfobaseOutputChannel } from '../infobases/infobaseConfigCommands';

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

  const openTemplatePreviewCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openTemplatePreview',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите узел шаблона в дереве метаданных.');
        return;
      }

      const isTemplateNode =
        target.type === MetadataType.Template || target.type === MetadataType.CommonTemplate;
      if (!isTemplateNode) {
        vscode.window.showWarningMessage(
          'Preview макета доступен только для узлов Template/CommonTemplate.'
        );
        return;
      }

      if (!target.filePath) {
        vscode.window.showWarningMessage('Для выбранного макета не задан путь к файлу.');
        return;
      }

      try {
        const previewPath = await resolveTemplatePreviewTargetPath(
          target.filePath,
          target.type as MetadataType.Template | MetadataType.CommonTemplate
        );
        Logger.info(`Opening MXL preview: ${previewPath}`);
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(previewPath),
          '1c-mxl-preview'
        );
      } catch (err) {
        Logger.error('Failed to open MXL preview', err);
        vscode.window.showErrorMessage(
          `Не удалось открыть preview макета: ${err instanceof Error ? err.message : String(err)}`
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

  const editSubsystemCompositionCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.editSubsystemComposition',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type !== MetadataType.Subsystem) {
        vscode.window.showWarningMessage('Выберите узел подсистемы в дереве метаданных.');
        return;
      }
      if (!target.filePath || !state.treeDataProvider || !state.subsystemCompositionEditorProvider) {
        vscode.window.showErrorMessage('CDT 41: не удалось открыть редактор состава подсистемы.');
        return;
      }
      const configPath = state.treeDataProvider.getConfigPathForNode(target) ?? state.treeDataProvider.getConfigPath();
      if (!configPath) {
        vscode.window.showErrorMessage('CDT 41: не удалось определить путь к конфигурации.');
        return;
      }
      try {
        await state.subsystemCompositionEditorProvider.show(target, state.treeDataProvider, configPath);
      } catch (err) {
        Logger.error('Failed to open subsystem composition editor', err);
        vscode.window.showErrorMessage(
          `CDT 41: ошибка открытия редактора состава: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const validateCurrentXmlCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.validateCurrentXml',
    async () => {
      if (!state.bindingManager || !state.infobaseStorage) {
        void vscode.window.showErrorMessage('Проверка XML недоступна: привязки или хранилище ИБ не инициализированы.');
        return;
      }
      const editor = vscode.window.activeTextEditor;
      const activePath = editor?.document.uri.fsPath;
      if (!activePath) {
        void vscode.window.showWarningMessage('Откройте XML-файл выгрузки конфигурации и повторите проверку.');
        return;
      }
      if (!activePath.toLowerCase().endsWith('.xml')) {
        void vscode.window.showWarningMessage('Команда работает только для активного XML-файла.');
        return;
      }
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (!workspaceFolder) {
        void vscode.window.showErrorMessage('Не удалось определить папку workspace для активного XML.');
        return;
      }

      const ibcmd = getIbcmdService();
      if (ibcmd.resolveExecutablePath().kind !== 'resolved') {
        await showIbcmdNotFoundDialog();
        return;
      }

      const bindings = await state.bindingManager.listAll();
      const localBindings = bindings.filter((b) => b.workspaceFolder === workspaceFolder.name);
      const activeNorm = path.resolve(activePath).toLowerCase();
      let bestMatch:
        | { binding: (typeof localBindings)[number]; sourceDir: string; score: number }
        | undefined;
      for (const b of localBindings) {
        const resolved = resolveConfigurationXmlDirectory(workspaceFolder.uri.fsPath, b.configRelativePath);
        if (!resolved.ok) {
          continue;
        }
        const src = path.resolve(resolved.sourceDir);
        const srcNorm = src.toLowerCase();
        if (activeNorm === srcNorm || activeNorm.startsWith(srcNorm + path.sep.toLowerCase())) {
          const score = srcNorm.length;
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { binding: b, sourceDir: src, score };
          }
        }
      }
      if (!bestMatch) {
        void vscode.window.showWarningMessage(
          'Для активного XML не найдена привязка базы. Выполните «Привязать базы…» для этой конфигурации.',
        );
        return;
      }
      if (bestMatch.binding.infobaseIds.length === 0) {
        void vscode.window.showWarningMessage(
          'Для конфигурации активного XML нет привязанных баз. Добавьте базы в диалоге привязки.',
        );
        return;
      }

      const catalog = await state.infobaseStorage.load();
      const catalogById = new Map(catalog.map((e) => [e.id, e] as const));
      const { entries } = resolveDeployTargetsForBinding(bestMatch.binding, catalogById);
      if (entries.length === 0) {
        void vscode.window.showWarningMessage(
          'Среди привязанных целей нет доступных file/server баз для ibcmd preflight.',
        );
        return;
      }

      let okCount = 0;
      let failCount = 0;
      for (const entry of entries) {
        const r = await runIbcmdXmlImportPreflight({
          entry,
          storage: state.infobaseStorage,
          absoluteSourceDir: bestMatch.sourceDir,
          ibcmdExtensionName: bestMatch.binding.ibcmdExtensionName,
        });
        if (r.ok) {
          okCount += 1;
          appendIbcmdOutputLine(`[preflight] ${entry.name}: ok (${r.durationMs} мс).`);
        } else {
          failCount += 1;
          appendIbcmdOutputLine(`[preflight] ${entry.name}: error (${r.durationMs} мс) — ${r.message}`);
        }
      }

      if (failCount === 0) {
        void vscode.window.showInformationMessage(`Preflight XML завершён: ${okCount} успешно.`);
      } else {
        const showOut = 'Показать вывод';
        const pick = await vscode.window.showWarningMessage(
          `Preflight XML завершён: ${okCount} успешно, ${failCount} с ошибками.`,
          showOut,
        );
        if (pick === showOut) {
          showIbcmdInfobaseOutputChannel();
        }
      }
    },
  );

  return [
    showPropertiesCommand,
    openXMLCommand,
    openBslModuleCommand,
    openFormEditorCommand,
    openRightsEditorCommand,
    openTemplatePreviewCommand,
    saveRightsEditorCommand,
    validateCurrentXmlCommand,
    editSubsystemCompositionCommand,
  ];
}
