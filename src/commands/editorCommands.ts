import * as vscode from 'vscode';
import * as fs from 'fs';
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
import { startDebugging } from '../debug/debugLauncher';
import { listPredefinedCharacteristics } from '../agent/predefinedCharacteristicOperations';
import { MESSAGES } from '../constants/messages';
import { addRootObjectToConfiguration } from '../services/configurationXmlUpdater';
import { XMLWriter } from '../utils/XMLWriter';
import { normalizeMetaDataObjectRoot } from '../utils/xml/metaDataObjectRootNormalizer';
import { metadataConverter, rulesRegistry } from '../rules';
import { parseXdtoPackage } from '../parsers/xdtoPackageParser';
import { convert1cPackageToXsd, convertXsdTo1cPackage } from '../xdtoPackageEditor/xdtoXsdConverter';
import { resolveXdtoPackageSchemaPath } from '../xdtoPackageEditor/xdtoPackagePaths';
import { showXdtoPackageCompare } from '../xdtoPackageCompare/xdtoPackageCompareProvider';

type RegisterEditorCommandsDeps = {
  state: ExtensionState;
};

function ensureSelectedXdtoPackage(state: ExtensionState, node: TreeNode | undefined): TreeNode | undefined {
  const target = getSelectedNode(state, node);
  if (!target || target.type !== MetadataType.XDTOPackage || !target.filePath) {
    vscode.window.showWarningMessage('Выберите узел XDTO-пакета в дереве метаданных.');
    return undefined;
  }
  return target;
}

async function pickXsdFile(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { XSD: ['xsd', 'xml'], 'Все файлы': ['*'] },
    title: 'Выберите XSD-схему',
  });
  return picked?.[0];
}

function getXsdNamespace(source: string): string {
  return parseXdtoPackage(source).targetNamespace ?? '';
}

function getXdtoPackagesDir(state: ExtensionState, node: TreeNode | undefined): string | undefined {
  const target = getSelectedNode(state, node);
  if (target?.type === MetadataType.XDTOPackage && target.filePath) {
    return path.dirname(target.filePath);
  }
  const configPath = (target ? state.treeDataProvider?.getConfigPathForNode(target) : undefined)
    ?? state.treeDataProvider?.getConfigPath();
  return configPath ? path.join(configPath, 'XDTOPackages') : undefined;
}

function buildXdtoPackageMetadataXml(packageName: string, namespace: string): string {
  const rules = rulesRegistry.get('XDTOPackage');
  if (!rules) {
    throw new Error('XDTOPackage rules are not registered.');
  }
  const uuid = XMLWriter.generateSimpleUuid();
  const ir = metadataConverter.createDefaultIR(rules, { name: packageName, uuid });
  const content = metadataConverter.irToXml(
    metadataConverter.mergeProperties(ir, { namespace }),
    rules
  );
  return normalizeMetaDataObjectRoot(content);
}

function sanitizePackageName(raw: string): string {
  return raw.trim().replace(/[\\/:*?"<>|]/g, '_');
}

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
        await vscode.window.showTextDocument(uri, { preview: false });
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
        // Create module file on disk if it doesn't exist yet
        const fileExists = await fs.promises.access(fp).then(() => true, () => false);
        if (!fileExists) {
          await fs.promises.mkdir(path.dirname(fp), { recursive: true });
          await fs.promises.writeFile(fp, '', 'utf-8');
          Logger.info(`Created module file: ${fp}`);
          if (target.properties.isVirtual) {
            target.properties.isVirtual = false;
          }
        }
        Logger.info(`Opening BSL module: ${fp}`);
        await vscode.window.showTextDocument(vscode.Uri.file(fp), { preview: false });
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
        await vscode.commands.executeCommand('vscode.openWith', uri, '1c-form-editor', { preview: false });
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

  const editExchangePlanContentCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.editExchangePlanContent',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type !== MetadataType.ExchangePlan) {
        vscode.window.showWarningMessage('Выберите узел плана обмена в дереве метаданных.');
        return;
      }
      if (!target.filePath || !state.treeDataProvider || !state.exchangePlanCompositionEditorProvider) {
        vscode.window.showErrorMessage('CDT 41: не удалось открыть редактор состава плана обмена.');
        return;
      }
      const configPath = state.treeDataProvider.getConfigPathForNode(target) ?? state.treeDataProvider.getConfigPath();
      if (!configPath) {
        vscode.window.showErrorMessage('CDT 41: не удалось определить путь к конфигурации.');
        return;
      }
      try {
        await state.exchangePlanCompositionEditorProvider.show(target, state.treeDataProvider, configPath);
      } catch (err) {
        Logger.error('Failed to open exchange plan content editor', err);
        vscode.window.showErrorMessage(
          `CDT 41: ошибка открытия редактора состава: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const editCommonAttributeContentCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.editCommonAttributeContent',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type !== MetadataType.CommonAttribute) {
        vscode.window.showWarningMessage('Выберите узел общего реквизита в дереве метаданных.');
        return;
      }
      if (!target.filePath || !state.treeDataProvider || !state.commonAttributeCompositionEditorProvider) {
        vscode.window.showErrorMessage('CDT 41: не удалось открыть редактор состава общего реквизита.');
        return;
      }
      const configPath = state.treeDataProvider.getConfigPathForNode(target) ?? state.treeDataProvider.getConfigPath();
      if (!configPath) {
        vscode.window.showErrorMessage('CDT 41: не удалось определить путь к конфигурации.');
        return;
      }
      try {
        await state.commonAttributeCompositionEditorProvider.show(target, state.treeDataProvider, configPath);
      } catch (err) {
        Logger.error('Failed to open common attribute content editor', err);
        vscode.window.showErrorMessage(
          `CDT 41: ошибка открытия редактора состава: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const editFunctionalOptionContentCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.editFunctionalOptionContent',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type !== MetadataType.FunctionalOption) {
        vscode.window.showWarningMessage('Выберите узел функциональной опции в дереве метаданных.');
        return;
      }
      if (!target.filePath || !state.treeDataProvider || !state.functionalOptionCompositionEditorProvider) {
        vscode.window.showErrorMessage('CDT 41: не удалось открыть редактор состава функциональной опции.');
        return;
      }
      const configPath = state.treeDataProvider.getConfigPathForNode(target) ?? state.treeDataProvider.getConfigPath();
      if (!configPath) {
        vscode.window.showErrorMessage('CDT 41: не удалось определить путь к конфигурации.');
        return;
      }
      try {
        await state.functionalOptionCompositionEditorProvider.show(target, state.treeDataProvider, configPath);
      } catch (err) {
        Logger.error('Failed to open functional option content editor', err);
        vscode.window.showErrorMessage(
          `CDT 41: ошибка открытия редактора состава: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const editFilterCriterionContentCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.editFilterCriterionContent',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type !== MetadataType.FilterCriterion) {
        vscode.window.showWarningMessage('Выберите узел критерия отбора в дереве метаданных.');
        return;
      }
      if (!target.filePath || !state.treeDataProvider || !state.filterCriterionCompositionEditorProvider) {
        vscode.window.showErrorMessage('CDT 41: не удалось открыть редактор состава критерия отбора.');
        return;
      }
      const configPath = state.treeDataProvider.getConfigPathForNode(target) ?? state.treeDataProvider.getConfigPath();
      if (!configPath) {
        vscode.window.showErrorMessage('CDT 41: не удалось определить путь к конфигурации.');
        return;
      }
      try {
        await state.filterCriterionCompositionEditorProvider.show(target, state.treeDataProvider, configPath);
      } catch (err) {
        Logger.error('Failed to open filter criterion content editor', err);
        vscode.window.showErrorMessage(
          `CDT 41: ошибка открытия редактора состава: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const editSubsystemCommandInterfaceCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.editSubsystemCommandInterface',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type !== MetadataType.Subsystem) {
        vscode.window.showWarningMessage('Выберите узел подсистемы в дереве метаданных.');
        return;
      }
      if (!target.filePath || !state.subsystemCommandInterfaceProvider) {
        vscode.window.showErrorMessage('CDT 41: не удалось открыть командный интерфейс подсистемы.');
        return;
      }
      const ciPath = path.join(path.dirname(target.filePath), 'Ext', 'CommandInterface.xml');
      if (!fs.existsSync(ciPath)) {
        vscode.window.showWarningMessage('У подсистемы нет файла CommandInterface.xml.');
        return;
      }
      try {
        await state.subsystemCommandInterfaceProvider.show(target, ciPath);
      } catch (err) {
        Logger.error('Failed to open command interface editor', err);
        vscode.window.showErrorMessage(
          `CDT 41: ошибка открытия командного интерфейса: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const editXdtoPackageSchemaCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.editXdtoPackageSchema',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type !== MetadataType.XDTOPackage) {
        vscode.window.showWarningMessage('Выберите узел XDTO-пакета в дереве метаданных.');
        return;
      }
      if (!target.filePath || !state.xdtoPackageEditorProvider) {
        vscode.window.showErrorMessage('CDT 41: не удалось открыть редактор XDTO-пакета.');
        return;
      }
      try {
        await state.xdtoPackageEditorProvider.show(target);
      } catch (err) {
        Logger.error('Failed to open XDTO package editor', err);
        vscode.window.showErrorMessage(
          `CDT 41: ошибка открытия редактора XDTO-пакета: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const exportXdtoPackageToXsdCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.exportXdtoPackageToXsd',
    async (node?: TreeNode) => {
      const target = ensureSelectedXdtoPackage(state, node);
      if (!target?.filePath) {
        return;
      }
      try {
        const schemaPath = resolveXdtoPackageSchemaPath(target.filePath, target.name);
        if (!fs.existsSync(schemaPath)) {
          vscode.window.showErrorMessage(`CDT 41: файл схемы XDTO не найден: ${schemaPath}`);
          return;
        }
        const defaultUri = vscode.Uri.file(path.join(path.dirname(target.filePath), `${target.name}.xsd`));
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { XSD: ['xsd'], 'Все файлы': ['*'] },
          title: 'Экспорт XDTO-пакета в XSD',
        });
        if (!saveUri) {
          return;
        }
        const source = fs.readFileSync(schemaPath, 'utf8');
        fs.writeFileSync(saveUri.fsPath, convert1cPackageToXsd(source), 'utf8');
        vscode.window.showInformationMessage(`XDTO-пакет экспортирован в XSD: ${saveUri.fsPath}`);
      } catch (err) {
        Logger.error('Failed to export XDTO package to XSD', err);
        vscode.window.showErrorMessage(
          `CDT 41: ошибка экспорта XDTO в XSD: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const importXsdIntoXdtoPackageCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.importXsdIntoXdtoPackage',
    async (node?: TreeNode) => {
      const target = ensureSelectedXdtoPackage(state, node);
      if (!target?.filePath) {
        return;
      }
      try {
        const picked = await pickXsdFile();
        if (!picked) {
          return;
        }
        const xsdSource = fs.readFileSync(picked.fsPath, 'utf8');
        const props = (target.properties ?? {}) as Record<string, unknown>;
        const namespace = String(props.Namespace ?? props.namespace ?? getXsdNamespace(xsdSource));
        const packageSource = convertXsdTo1cPackage(xsdSource, namespace);
        const schemaPath = resolveXdtoPackageSchemaPath(target.filePath, target.name);
        fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
        fs.writeFileSync(schemaPath, packageSource, 'utf8');
        vscode.window.showInformationMessage(`XSD импортирована в XDTO-пакет: ${target.name}`);
      } catch (err) {
        Logger.error('Failed to import XSD into XDTO package', err);
        vscode.window.showErrorMessage(
          `CDT 41: ошибка импорта XSD в XDTO-пакет: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const importXsdAsNewXdtoPackageCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.importXsdAsNewXdtoPackage',
    async (node?: TreeNode) => {
      try {
        const picked = await pickXsdFile();
        if (!picked) {
          return;
        }
        const xsdSource = fs.readFileSync(picked.fsPath, 'utf8');
        const namespace = getXsdNamespace(xsdSource);
        const suggestedName = sanitizePackageName(path.basename(picked.fsPath, path.extname(picked.fsPath)));
        const packageName = sanitizePackageName(await vscode.window.showInputBox({
          prompt: 'Имя нового XDTO-пакета',
          value: suggestedName,
          validateInput: (value) => sanitizePackageName(value) ? undefined : 'Введите имя XDTO-пакета.',
        }) ?? '');
        if (!packageName) {
          return;
        }

        const packagesDir = getXdtoPackagesDir(state, node);
        if (!packagesDir) {
          vscode.window.showErrorMessage('CDT 41: не удалось определить папку XDTOPackages.');
          return;
        }
        const configRootPath = path.dirname(packagesDir);
        const metadataPath = path.join(packagesDir, `${packageName}.xml`);
        const schemaPath = resolveXdtoPackageSchemaPath(metadataPath, packageName);
        if (fs.existsSync(metadataPath) || fs.existsSync(schemaPath)) {
          vscode.window.showErrorMessage(`CDT 41: XDTO-пакет уже существует: ${packageName}`);
          return;
        }

        fs.mkdirSync(packagesDir, { recursive: true });
        fs.writeFileSync(metadataPath, buildXdtoPackageMetadataXml(packageName, namespace), 'utf8');
        fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
        fs.writeFileSync(schemaPath, convertXsdTo1cPackage(xsdSource, namespace), 'utf8');
        await addRootObjectToConfiguration(configRootPath, 'XDTOPackage', packageName);
        vscode.window.showInformationMessage(`Создан XDTO-пакет из XSD: ${packageName}`);
      } catch (err) {
        Logger.error('Failed to import XSD as new XDTO package', err);
        vscode.window.showErrorMessage(
          `CDT 41: ошибка создания XDTO-пакета из XSD: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const compareMergeXdtoPackageCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.compareMergeXdtoPackage',
    async (node?: TreeNode) => {
      const target = ensureSelectedXdtoPackage(state, node);
      if (!target?.filePath || !state.extensionContext) {
        return;
      }
      await showXdtoPackageCompare(state.extensionContext, target);
    }
  );

  const viewCotPredefinedCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.viewChartOfCharacteristicTypesPredefined',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type !== MetadataType.ChartOfCharacteristicTypes) {
        vscode.window.showWarningMessage('Выберите узел ПВХ в дереве метаданных.');
        return;
      }
      if (!target.filePath || !state.treeDataProvider) {
        vscode.window.showErrorMessage('CDT 41: не удалось определить путь к ПВХ.');
        return;
      }

      const configPath = state.treeDataProvider.getConfigPathForNode(target) ?? state.treeDataProvider.getConfigPath();
      if (!configPath) {
        vscode.window.showErrorMessage('CDT 41: не удалось определить путь к конфигурации.');
        return;
      }

      let entries;
      try {
        entries = await listPredefinedCharacteristics(configPath, target.name);
      } catch (err) {
        Logger.error('viewCotPredefined: failed to read', err);
        vscode.window.showErrorMessage(
          `CDT 41: ${MESSAGES.COT_PREDEFINED_READ_FAILED}: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      if (entries.length === 0) {
        vscode.window.showInformationMessage(MESSAGES.COT_PREDEFINED_EMPTY);
        return;
      }

      const items = entries.map((e) => ({
        label: e.name,
        description: e.type.length > 0 ? e.type.join(', ') : MESSAGES.COT_PREDEFINED_NO_TYPE,
        detail: e.description ? `${e.description}${e.code ? ` (код ${e.code})` : ''}` : (e.code ? `код ${e.code}` : undefined),
        entry: e,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        title: MESSAGES.COT_PREDEFINED_VIEW_TITLE,
        placeHolder: target.name,
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (picked) {
        const ref = `ChartOfCharacteristicTypes.${target.name}.PredefinedData.${picked.entry.name}`;
        await vscode.env.clipboard.writeText(ref);
        vscode.window.showInformationMessage(MESSAGES.COT_PREDEFINED_COPIED);
      }
    }
  );

  const startDebuggingCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.startDebugging',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите узел конфигурации в дереве метаданных.');
        return;
      }
      if (!state.bindingManager || !state.infobaseStorage || !state.treeDataProvider) {
        vscode.window.showErrorMessage('Отладка недоступна: не инициализированы зависимости.');
        return;
      }
      await startDebugging({
        node: target,
        bindingManager: state.bindingManager,
        infobaseStorage: state.infobaseStorage,
        treeDataProvider: state.treeDataProvider,
      });
    }
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
    editExchangePlanContentCommand,
    editCommonAttributeContentCommand,
    editFunctionalOptionContentCommand,
    editFilterCriterionContentCommand,
    editSubsystemCommandInterfaceCommand,
    editXdtoPackageSchemaCommand,
    exportXdtoPackageToXsdCommand,
    importXsdIntoXdtoPackageCommand,
    importXsdAsNewXdtoPackageCommand,
    compareMergeXdtoPackageCommand,
    viewCotPredefinedCommand,
    startDebuggingCommand,
  ];
}
