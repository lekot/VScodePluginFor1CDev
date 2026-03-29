/**
 * Синхронизация кэша декораций привязок для дерева метаданных (plan §2C #37–38).
 */

import * as vscode from 'vscode';
import type { ExtensionState } from '../state/extensionState';
import type { ConfigurationBindingDecoration } from './bindingDecorationTypes';
import { bindingKey } from './bindingPathUtils';

function isInfobaseBindingsFile(fsPath: string): boolean {
  return fsPath.replace(/\\/g, '/').endsWith('.vscode/infobase-bindings.json');
}

/**
 * Пересчитывает карту привязок и обновляет дерево метаданных.
 */
export async function rebuildBindingDecorationsForTree(state: ExtensionState): Promise<void> {
  const provider = state.treeDataProvider;
  const manager = state.bindingManager;
  const storage = state.infobaseStorage;
  if (!provider || !manager || !storage) {
    return;
  }
  try {
    const bindings = await manager.listAll();
    const entries = await storage.load();
    const idToName = new Map(entries.map((e) => [e.id, e.name] as const));
    const map = new Map<string, ConfigurationBindingDecoration>();
    for (const b of bindings) {
      const key = bindingKey(b.workspaceFolder, b.configRelativePath, b.ibcmdExtensionName);
      const names = b.infobaseIds.map((id) => idToName.get(id) ?? id);
      const maxNames = 6;
      const shown = names.slice(0, maxNames);
      const more = names.length > maxNames ? ` … ещё ${names.length - maxNames}` : '';
      map.set(key, {
        boundCount: b.infobaseIds.length,
        namesPreview: shown.join(', ') + more,
        massDeployment: b.massDeployment === true,
      });
    }
    provider.setConfigurationBindingDecorations(map);
    provider.refresh();
  } catch (e) {
    void vscode.window.showWarningMessage(
      `Не удалось обновить индикацию привязок ИБ: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Подписки: сохранение файла привязок, смена каталога баз, смена workspace.
 */
export function registerBindingDecorationSync(state: ExtensionState): vscode.Disposable {
  const run = (): void => {
    void rebuildBindingDecorationsForTree(state);
  };
  const catalogListener =
    state.infobaseStorage?.onDidChangeCatalog(() => {
      run();
    }) ?? { dispose: () => undefined };
  return vscode.Disposable.from(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isInfobaseBindingsFile(doc.uri.fsPath)) {
        run();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      run();
    }),
    catalogListener,
  );
}
