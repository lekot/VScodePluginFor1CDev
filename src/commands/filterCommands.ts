import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import { MetadataType, TreeNode } from '../models/treeNode';
import { MESSAGES } from '../constants/messages';
import { getSelectedNode } from '../helpers/commandHelpers';
import { validateSubsystemCompositionRef } from '../parsers/xmlChildObjects';
import {
  applySubsystemCompositionFileUpdate,
  readSubsystemCompositionRefsFromFile,
} from '../services/subsystemCompositionFileUpdater';
import { runIbcmdConfigCheckGate } from '../services/ibcmdConfigCheckGate';

type RegisterFilterCommandsDeps = {
  state: ExtensionState;
  loadMetadataTree: () => Promise<void>;
  invalidateTreeCacheOnly: (configPath: string) => Promise<void>;
};

export function registerFilterCommands(deps: RegisterFilterCommandsDeps): vscode.Disposable[] {
  const { state, loadMetadataTree, invalidateTreeCacheOnly } = deps;

  const filterByTypeCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.filterByType',
    async () => {
      if (!state.treeDataProvider) {
        return;
      }
      const items = MetadataTreeDataProvider.getFilterableTypeLabels().map(({ type, label }) => ({
        label,
        type,
        picked: (() => {
          const current = state.treeDataProvider!.getTypeFilter();
          return current != null && current.includes(type);
        })(),
      }));
      const picks = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Выберите типы метаданных для отображения',
      });
      if (picks === undefined) {
        return;
      }
      state.treeDataProvider.setTypeFilter(picks.length > 0 ? picks.map((p) => p.type) : null);
    }
  );

  const filterBySubsystemCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.filterBySubsystem',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type !== MetadataType.Subsystem) {
        vscode.window.showWarningMessage('Выберите узел подсистемы в дереве метаданных.');
        return;
      }
      if (!state.treeDataProvider) {
        return;
      }
      await state.treeDataProvider.setSubsystemFilter(target.id, target.name);
      vscode.commands.executeCommand('setContext', 'subsystemFilterActive', true);
    }
  );

  const clearSubsystemFilterCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.clearSubsystemFilter',
    async () => {
      if (!state.treeDataProvider) {
        return;
      }
      await state.treeDataProvider.setSubsystemFilter(null, null);
      vscode.commands.executeCommand('setContext', 'subsystemFilterActive', false);
    }
  );

  const addToSubsystemCompositionCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.addToSubsystemComposition',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type !== MetadataType.Subsystem) {
        vscode.window.showWarningMessage(MESSAGES.SUBSYSTEM_COMPOSITION_SELECT_SUBSYSTEM);
        return;
      }
      if (!target.filePath || !state.treeDataProvider) {
        vscode.window.showErrorMessage(MESSAGES.SUBSYSTEM_COMPOSITION_NO_FILE);
        return;
      }
      const ref = await vscode.window.showInputBox({
        title: MESSAGES.SUBSYSTEM_COMPOSITION_ADD_TITLE,
        placeHolder: 'Catalog.Items',
        validateInput: (value) => {
          const v = (value || '').trim();
          if (!v) {
            return undefined;
          }
          const err = validateSubsystemCompositionRef(v);
          return err !== null ? err : undefined;
        },
      });
      if (ref === undefined) {
        return;
      }
      const trimmed = ref.trim();
      if (!trimmed) {
        return;
      }
      const resolved = state.treeDataProvider.findRootObjectForCompositionRef(trimmed, target);
      if (!resolved) {
        const inOtherConfig = state.treeDataProvider.hasCompositionRefInOtherConfiguration(trimmed, target);
        vscode.window.showErrorMessage(
          inOtherConfig
            ? MESSAGES.SUBSYSTEM_COMPOSITION_OBJECT_IN_OTHER_CONFIG
            : MESSAGES.SUBSYSTEM_COMPOSITION_OBJECT_NOT_FOUND
        );
        return;
      }
      try {
        const gate = await runIbcmdConfigCheckGate();
        if (!gate.ok) {
          vscode.window.showErrorMessage(
            `Проверка валидности конфигурации (ibcmd) обязательна перед изменением состава подсистем: ${gate.message}`
          );
          return;
        }
        const { rejected } = await applySubsystemCompositionFileUpdate(target.filePath, {
          add: [trimmed],
          remove: [],
        });
        if (rejected.length > 0) {
          vscode.window.showWarningMessage(
            `${MESSAGES.SUBSYSTEM_COMPOSITION_REJECTED_PREFIX} ${rejected.map((r) => `${r.ref} (${r.reason})`).join('; ')}`
          );
        }
        const cp = state.treeDataProvider.getConfigPathForNode(target);
        if (cp) {
          await invalidateTreeCacheOnly(cp);
          await loadMetadataTree();
        }
        vscode.window.showInformationMessage(`${MESSAGES.SUBSYSTEM_COMPOSITION_ADD_OK} (${trimmed})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`${MESSAGES.SUBSYSTEM_COMPOSITION_WRITE_FAILED} ${msg}`);
      }
    }
  );

  const removeFromSubsystemCompositionCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.removeFromSubsystemComposition',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target || target.type !== MetadataType.Subsystem) {
        vscode.window.showWarningMessage(MESSAGES.SUBSYSTEM_COMPOSITION_SELECT_SUBSYSTEM);
        return;
      }
      if (!target.filePath || !state.treeDataProvider) {
        vscode.window.showErrorMessage(MESSAGES.SUBSYSTEM_COMPOSITION_NO_FILE);
        return;
      }
      let refs: string[];
      try {
        refs = await readSubsystemCompositionRefsFromFile(target.filePath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`${MESSAGES.SUBSYSTEM_COMPOSITION_READ_FAILED} ${msg}`);
        return;
      }
      if (refs.length === 0) {
        vscode.window.showInformationMessage(MESSAGES.SUBSYSTEM_COMPOSITION_EMPTY);
        return;
      }
      const picked = await vscode.window.showQuickPick(refs, {
        placeHolder: MESSAGES.SUBSYSTEM_COMPOSITION_REMOVE_PLACEHOLDER,
      });
      if (picked === undefined) {
        return;
      }
      try {
        const gate = await runIbcmdConfigCheckGate();
        if (!gate.ok) {
          vscode.window.showErrorMessage(
            `Проверка валидности конфигурации (ibcmd) обязательна перед изменением состава подсистем: ${gate.message}`
          );
          return;
        }
        await applySubsystemCompositionFileUpdate(target.filePath, {
          add: [],
          remove: [picked],
        });
        const cp = state.treeDataProvider.getConfigPathForNode(target);
        if (cp) {
          await invalidateTreeCacheOnly(cp);
          await loadMetadataTree();
        }
        vscode.window.showInformationMessage(`${MESSAGES.SUBSYSTEM_COMPOSITION_REMOVE_OK} (${picked})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`${MESSAGES.SUBSYSTEM_COMPOSITION_WRITE_FAILED} ${msg}`);
      }
    }
  );

  return [
    filterByTypeCommand,
    filterBySubsystemCommand,
    clearSubsystemFilterCommand,
    addToSubsystemCompositionCommand,
    removeFromSubsystemCompositionCommand,
  ];
}
