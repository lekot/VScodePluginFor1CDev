import * as vscode from 'vscode';
import type { ExtensionState } from '../state/extensionState';
import type { InfobaseTreeEntry, InfobaseTreeNode } from './infobaseTreeProvider';

const STUB =
  'Команда будет реализована в задачах управления базами (загрузка конфигурации, запуск платформы и т.д.).';

function isEntryNode(node: unknown): node is InfobaseTreeEntry {
  return (
    !!node &&
    typeof node === 'object' &&
    'kind' in node &&
    (node as InfobaseTreeNode).kind === 'entry'
  );
}

function requireEntry(arg: unknown, title: string): InfobaseTreeEntry | undefined {
  if (isEntryNode(arg)) {
    return arg;
  }
  void vscode.window.showWarningMessage(`${title}: выберите базу в дереве Infobase Manager.`);
  return undefined;
}

/**
 * Registers Infobase Manager tree commands (WOW design §7). Handlers are stubs until 1D–1F.
 */
export function registerInfobaseTreeCommands(state: ExtensionState): vscode.Disposable[] {
  const refresh = () => {
    state.infobaseTreeProvider?.refresh();
  };

  const stub = (title: string) => async (arg?: unknown) => {
    const e = requireEntry(arg, title);
    if (!e) {
      return;
    }
    void vscode.window.showInformationMessage(`${title}: ${STUB}`);
  };

  return [
    vscode.commands.registerCommand('1c-metadata-tree.infobases.refresh', () => {
      refresh();
    }),
    vscode.commands.registerCommand('1c-metadata-tree.infobases.create', async () => {
      void vscode.window.showInformationMessage(`Создать базу: ${STUB}`);
    }),
    vscode.commands.registerCommand('1c-metadata-tree.infobases.add', async () => {
      void vscode.window.showInformationMessage(`Добавить существующую базу: ${STUB}`);
    }),
    vscode.commands.registerCommand('1c-metadata-tree.infobases.importV8i', async () => {
      void vscode.window.showInformationMessage(`Импорт из .v8i: ${STUB}`);
    }),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.openEnterprise', stub('Открыть в Предприятии')),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.openDesigner', stub('Открыть Конфигуратор')),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.configImport', stub('Загрузить конфигурацию')),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.configExport', stub('Выгрузить конфигурацию')),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.configCheck', stub('Проверить конфигурацию')),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.edit', stub('Редактировать базу')),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.remove', stub('Удалить из списка')),
  ];
}
