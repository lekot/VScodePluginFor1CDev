import * as vscode from 'vscode';
import type { ExtensionState } from '../state/extensionState';
import type { InfobaseEntry } from './models/infobaseEntry';
import type { InfobaseTreeEntry, InfobaseTreeNode } from './infobaseTreeProvider';
import { runAddExistingInfobase, runEditInfobase, runRemoveInfobase } from './infobaseCommands';

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

async function resolveCatalogEntry(
  state: ExtensionState,
  treeEntry: InfobaseTreeEntry,
): Promise<InfobaseEntry | undefined> {
  const storage = state.infobaseStorage;
  if (!storage) {
    return undefined;
  }
  const fresh = await storage.getById(treeEntry.entry.id);
  return fresh ?? treeEntry.entry;
}

/**
 * Registers Infobase Manager tree commands (WOW design §7). Catalog CRUD: plan §1D; остальное — заглушки до 1E–1F.
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
      await runAddExistingInfobase(state.infobaseStorage);
    }),
    vscode.commands.registerCommand('1c-metadata-tree.infobases.importV8i', async () => {
      void vscode.window.showInformationMessage(`Импорт из .v8i: ${STUB}`);
    }),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.openEnterprise', stub('Открыть в Предприятии')),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.openDesigner', stub('Открыть Конфигуратор')),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.configImport', stub('Загрузить конфигурацию')),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.configExport', stub('Выгрузить конфигурацию')),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.configCheck', stub('Проверить конфигурацию')),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.edit', async (arg?: unknown) => {
      const node = requireEntry(arg, 'Редактировать базу');
      if (!node) {
        return;
      }
      const entry = await resolveCatalogEntry(state, node);
      await runEditInfobase(state.infobaseStorage, entry);
    }),
    vscode.commands.registerCommand('1c-metadata-tree.infobase.remove', async (arg?: unknown) => {
      const node = requireEntry(arg, 'Удалить из списка');
      if (!node) {
        return;
      }
      const entry = await resolveCatalogEntry(state, node);
      await runRemoveInfobase(state.infobaseStorage, entry);
    }),
  ];
}
