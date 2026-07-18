import * as vscode from 'vscode';
import {
  createElement,
  createForm,
  deleteElement,
  duplicateElement,
  findReferencesToElement,
  isRootObjectCreateInTypeFolder,
  planDuplicateRootElement,
  planRenameRootElement,
  renameElement,
  TOP_LEVEL_TYPES,
} from '../services/elementOperations';
import { validateElementName } from '../utils/elementNameValidator';
import { TreeNode, MetadataType } from '../models/treeNode';
import { ExtensionState } from '../state/extensionState';
import { getSelectedNode, requireDesignerFormat } from '../helpers/commandHelpers';
import { optimisticAppendCreatedNode } from '../helpers/optimisticNodeBuilder';
import { Logger } from '../utils/logger';
import { AgentOperations } from '../agent/agentOperations';
import type { MutationPlan } from '../services/configurationSession/mutationPlan';

type RegisterElementCommandsDeps = {
  state: ExtensionState;
  loadMetadataTree: () => Promise<void>;
  invalidateCacheAndReload: (configPath: string) => Promise<void>;
  scheduleDeleteReconcile: (
    configPath: string,
    operationId: string,
    deletedNodeId: string,
    elementName: string
  ) => void;
  runConfigurationMutation?: <T>(
    configPath: string,
    kind: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  runConfigurationPlan?: <T>(configPath: string, plan: MutationPlan<T>) => Promise<T>;
};

export function registerElementCommands(deps: RegisterElementCommandsDeps): vscode.Disposable[] {
  const {
    state,
    loadMetadataTree,
    invalidateCacheAndReload,
    scheduleDeleteReconcile,
    runConfigurationMutation = async (_configPath, _kind, operation) => operation(),
    runConfigurationPlan = async (_configPath, plan) => plan.result,
  } = deps;

  const createElementCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.createElement',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите узел типа (Справочники, Документы и т.д.) или объект метаданных.');
        return;
      }
      const designerCtx = await requireDesignerFormat(state, target, {
        notLoadedMessage: 'Дерево метаданных не загружено. Откройте конфигурацию.',
        nonDesignerMessage: 'Операции с элементами поддерживаются только для формата Designer.',
      });
      if (!designerCtx) {return;}
      const { configPath, format } = designerCtx;
      const name = await vscode.window.showInputBox({
        prompt: 'Имя нового элемента',
        placeHolder: 'Введите имя (латиница, кириллица, цифры, _)',
        validateInput: (value) => {
          const siblingNames = (target.children || []).map((c) => c.name);
          return validateElementName(value.trim(), siblingNames) ?? undefined;
        },
      });
      if (name === undefined || name.trim() === '') {return;}
      try {
        const trimmedName = name.trim();
        if (isRootObjectCreateInTypeFolder(target)) {
          const plan = await new AgentOperations(configPath).planCreateObject({
            type: String(target.type),
            name: trimmedName,
          });
          await runConfigurationPlan(configPath, plan);
        } else {
          await runConfigurationMutation(configPath, 'ui.createElement', () => createElement(target, trimmedName));
        }
        if (target.id === 'Forms') {
          vscode.window.showInformationMessage(`Создана форма: ${trimmedName}`);
        } else {
          await optimisticAppendCreatedNode(state, target, trimmedName, { configPath, format });
          vscode.window.showInformationMessage(`Создан элемент: ${trimmedName}`);
        }
        void invalidateCacheAndReload(configPath).catch((err) => {
          Logger.error('Background reload after create failed', err);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  const createFormCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.createForm',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите узел «Forms» в дереве метаданных.');
        return;
      }
      if (target.id !== 'Forms') {
        vscode.window.showWarningMessage('Создание формы: выберите узел «Forms» (папку форм объекта).');
        return;
      }
      const designerCtx = await requireDesignerFormat(state, target, {
        notLoadedMessage: 'Дерево метаданных не загружено. Откройте конфигурацию.',
        nonDesignerMessage: 'Создание форм поддерживается только для формата Designer.',
      });
      if (!designerCtx) {return;}
      const siblingNames = (target.children || []).map((c) => c.name);
      const name = await vscode.window.showInputBox({
        prompt: 'Имя новой формы',
        placeHolder: 'Введите имя формы (латиница, кириллица, цифры, _)',
        validateInput: (value) => validateElementName(value.trim(), siblingNames) ?? undefined,
      });
      if (name === undefined || name.trim() === '') {return;}
      try {
        await runConfigurationMutation(
          designerCtx.configPath,
          'ui.createForm',
          () => createForm(target, name.trim()),
        );
        vscode.window.showInformationMessage(`Создана форма: ${name.trim()}`);
        await loadMetadataTree();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  const duplicateElementCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.duplicateElement',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type === MetadataType.Configuration) {
        return;
      }
      const designerCtx = await requireDesignerFormat(state, target, {
        notLoadedMessage: 'Дерево метаданных не загружено.',
        nonDesignerMessage: 'Операции с элементами поддерживаются только для формата Designer.',
      });
      if (!designerCtx) {return;}
      const { configPath } = designerCtx;
      const parent = target.parent;
      const siblingNames = parent ? (parent.children || []).map((c) => c.name) : [];
      const newName = await vscode.window.showInputBox({
        value: `${target.name}Copy`,
        prompt: 'Имя дубликата',
        validateInput: (value) => validateElementName(value.trim(), siblingNames) ?? undefined,
      });
      if (newName === undefined || newName.trim() === '') {return;}
      try {
        if (TOP_LEVEL_TYPES.has(target.type)) {
          await runConfigurationPlan(configPath, await planDuplicateRootElement(target, newName.trim()));
        } else {
          await runConfigurationMutation(
            configPath,
            'ui.duplicateElement',
            () => duplicateElement(target, newName.trim()),
          );
        }
        vscode.window.showInformationMessage(`Дублирован элемент: ${newName.trim()}`);
        await invalidateCacheAndReload(configPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  const deleteElementCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.deleteElement',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type === MetadataType.Configuration) {
        return;
      }
      const designerCtx = await requireDesignerFormat(state, target, {
        notLoadedMessage: 'Дерево метаданных не загружено.',
        nonDesignerMessage: 'Операции с элементами поддерживаются только для формата Designer.',
      });
      if (!designerCtx) {return;}
      const { configPath } = designerCtx;
      const effectiveNode =
        target.type === MetadataType.Extension
          ? target.parent
          : target.parent?.type === MetadataType.Extension
            ? target.parent.parent
            : target;
      const refs =
        effectiveNode && effectiveNode.type !== MetadataType.Configuration
          ? await findReferencesToElement(configPath, effectiveNode.name, effectiveNode.type)
          : [];
      const refMsg =
        refs.length > 0
          ? ` Найдено ссылок: ${refs.length} (файлов: ${new Set(refs.map((r) => r.filePath)).size}). Удаление может нарушить конфигурацию.`
          : '';
      const choice = await vscode.window.showWarningMessage(
        `Удалить элемент «${target.name}»?${refMsg}`,
        { modal: true },
        'Удалить',
        'Отмена'
      );
      if (choice !== 'Удалить') {return;}
      try {
        const operationId = `delete-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        if (TOP_LEVEL_TYPES.has(target.type)) {
          const plan = await new AgentOperations(configPath).planDeleteObject({
            path: `${String(target.type)}.${target.name}`,
          });
          await runConfigurationPlan(configPath, plan);
        } else {
          await runConfigurationMutation(configPath, 'ui.deleteElement', () => deleteElement(target));
        }
        try {
          state.treeDataProvider?.applyOptimisticDelete(target, operationId);
        } catch (optimisticError) {
          Logger.error('delete.optimistic.apply.failed', optimisticError);
          await invalidateCacheAndReload(configPath);
          vscode.window.showWarningMessage(
            `Удалён элемент: ${target.name}. Быстрое обновление дерева не удалось; выполнена полная перезагрузка.`
          );
          return;
        }

        scheduleDeleteReconcile(configPath, operationId, target.id, target.name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  const renameElementCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.renameElement',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type === MetadataType.Configuration) {
        return;
      }
      const designerCtx = await requireDesignerFormat(state, target, {
        notLoadedMessage: 'Дерево метаданных не загружено.',
        nonDesignerMessage: 'Операции с элементами поддерживаются только для формата Designer.',
      });
      if (!designerCtx) {return;}
      const { configPath } = designerCtx;
      const parent = target.parent;
      const siblingNames = parent ? (parent.children || []).map((c) => c.name).filter((n) => n !== target.name) : [];
      const newName = await vscode.window.showInputBox({
        value: target.name,
        prompt: 'Новое имя',
        validateInput: (value) => validateElementName(value.trim(), siblingNames) ?? undefined,
      });
      if (newName === undefined || newName.trim() === '' || newName.trim() === target.name) {return;}
      try {
        if (TOP_LEVEL_TYPES.has(target.type)) {
          await runConfigurationPlan(
            configPath,
            await planRenameRootElement(target, newName.trim(), configPath),
          );
        } else {
          await runConfigurationMutation(
            configPath,
            'ui.renameElement',
            () => renameElement(target, newName.trim(), configPath),
          );
        }
        vscode.window.showInformationMessage(`Переименован в: ${newName.trim()}`);
        await invalidateCacheAndReload(configPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  return [
    createElementCommand,
    createFormCommand,
    duplicateElementCommand,
    deleteElementCommand,
    renameElementCommand,
  ];
}
