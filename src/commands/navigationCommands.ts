import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { MetadataType, TreeNode } from '../models/treeNode';
import { getActiveFileUriForReveal } from '../extensionSupport/activeFileUri';

type RegisterNavigationCommandsDeps = {
  state: ExtensionState;
};

async function findFirstFormNode(
  state: ExtensionState,
  element: TreeNode
): Promise<TreeNode | null> {
  if (element.type === MetadataType.Form) {
    return element;
  }
  const children = await state.treeDataProvider!.getChildren(element);
  for (const child of children) {
    const found = await findFirstFormNode(state, child);
    if (found) {
      return found;
    }
  }
  return null;
}

export function registerNavigationCommands(
  deps: RegisterNavigationCommandsDeps
): vscode.Disposable[] {
  const { state } = deps;

  const focusTreeCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.focus',
    async () => {
      if (!state.treeView || !state.treeDataProvider) {
        return;
      }
      let root = state.treeDataProvider.getRootNode();
      if (!root) {
        await new Promise((r) => setTimeout(r, 200));
        root = state.treeDataProvider.getRootNode();
      }
      if (!root) {
        await new Promise((r) => setTimeout(r, 400));
        root = state.treeDataProvider.getRootNode();
      }
      if (!root) {
        return;
      }
      const formNode = await findFirstFormNode(state, root);
      const nodeToReveal = formNode ?? root;
      await state.treeView.reveal(nodeToReveal, { focus: true });
    }
  );

  const focusSearchCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.focusSearch',
    async () => {
      if (!state.treeDataProvider) {
        return;
      }
      const history = state.treeDataProvider.getSearchHistory();
      const current = state.treeDataProvider.getSearchQuery();
      let query = current;
      if (history.length > 0) {
        const pick = await vscode.window.showQuickPick(
          [{ label: '$(add) Новый поиск…', value: '' }, ...history.map((h) => ({ label: h, value: h }))],
          { placeHolder: 'Поиск по названиям (и синониму)', matchOnDescription: false }
        );
        if (pick === undefined) {
          return;
        }
        query = pick.value;
        if (query === '') {
          const input = await vscode.window.showInputBox({
            value: current,
            prompt: 'Поиск по названиям (и синониму)',
            placeHolder: 'Введите строку или выберите из истории',
          });
          if (input === undefined) {
            return;
          }
          query = input;
        }
      } else {
        const input = await vscode.window.showInputBox({
          value: current,
          prompt: 'Поиск по названиям (и синониму)',
          placeHolder: 'Введите строку',
        });
        if (input === undefined) {
          return;
        }
        query = input;
      }
      state.treeDataProvider.setSearchQuery(query);
      if (query.trim()) {
        state.treeDataProvider.addSearchToHistory(query);
      }
    }
  );

  const clearSearchCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.clearSearch',
    () => {
      state.treeDataProvider?.clearSearch();
      vscode.commands.executeCommand('setContext', 'subsystemFilterActive', false);
    }
  );

  const revealActiveFileInTreeCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.revealActiveFileInTree',
    async () => {
      const { treeDataProvider, treeView } = state;
      if (!treeDataProvider || !treeView) {
        return;
      }
      const root = treeDataProvider.getRootNode();
      if (!root) {
        void vscode.window.showInformationMessage('Дерево метаданных ещё не загружено. Откройте рабочую папку и дождитесь загрузки.');
        return;
      }
      const uri = getActiveFileUriForReveal();
      if (!uri) {
        void vscode.window.showInformationMessage('Активный редактор не указывает на файл (file URI).');
        return;
      }
      const activePath = uri.fsPath;
      if (!activePath) {
        return;
      }
      if (!vscode.workspace.getWorkspaceFolder(uri)) {
        void vscode.window.showWarningMessage('Активный файл не сопоставлен папке workspace (не из открытой папки).');
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'CDT 41: Поиск в дереве…' },
        async () => {
          const found = await treeDataProvider.findDeepestNodeForFilePath(activePath);
          if (!found) {
            void vscode.window.showInformationMessage('Не найдено соответствия для активного файла в дереве метаданных.');
            return;
          }
          const target = treeDataProvider.resolveNodeForUi(found);
          if (treeDataProvider.hasActiveTreeFilter() && !treeDataProvider.isNodeVisibleInFilteredView(target)) {
            treeDataProvider.clearSearch();
            void vscode.commands.executeCommand('setContext', 'subsystemFilterActive', false);
            void vscode.window.showInformationMessage('Фильтры и поиск в дереве сброшены, чтобы показать элемент.');
            await new Promise((r) => {
              setTimeout(r, 0);
            });
          }
          const finalNode = treeDataProvider.resolveNodeForUi(target);
          try {
            await vscode.commands.executeCommand('workbench.view.explorer');
            await treeView.reveal(finalNode, { select: true, focus: true, expand: true });
          } catch (err) {
            void vscode.window.showErrorMessage(
              `Не удалось выделить элемент: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      );
    }
  );

  const nextMatchCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.nextMatch',
    () => {
      if (!state.treeDataProvider || !state.treeView) {
        return;
      }
      const ids = state.treeDataProvider.getVisibleOrderedNodeIds();
      if (ids.length === 0) {
        return;
      }
      const sel = state.treeView.selection[0];
      const currentId = sel?.id;
      const idx = currentId ? ids.indexOf(currentId) : -1;
      const nextIdx = idx < ids.length - 1 ? idx + 1 : 0;
      const nextId = ids[nextIdx];
      const node = state.treeDataProvider.findNodeById(nextId);
      if (node) {
        state.treeView.reveal(node, { select: true, focus: true });
      }
    }
  );

  const previousMatchCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.previousMatch',
    () => {
      if (!state.treeDataProvider || !state.treeView) {
        return;
      }
      const ids = state.treeDataProvider.getVisibleOrderedNodeIds();
      if (ids.length === 0) {
        return;
      }
      const sel = state.treeView.selection[0];
      const currentId = sel?.id;
      const idx = currentId ? ids.indexOf(currentId) : -1;
      const prevIdx = idx > 0 ? idx - 1 : ids.length - 1;
      const prevId = ids[prevIdx];
      const node = state.treeDataProvider.findNodeById(prevId);
      if (node) {
        state.treeView.reveal(node, { select: true, focus: true });
      }
    }
  );

  return [
    focusTreeCommand,
    focusSearchCommand,
    clearSearchCommand,
    revealActiveFileInTreeCommand,
    nextMatchCommand,
    previousMatchCommand,
  ];
}
