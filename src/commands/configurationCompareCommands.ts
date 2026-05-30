import * as path from 'path';
import * as vscode from 'vscode';

import type { TreeNode } from '../models/treeNode';
import type { ExtensionState } from '../state/extensionState';
import { showConfigurationCompare } from '../compareMerge/configCompareProvider';
import { buildConfigurationCompare } from '../compareMerge/configurationCompareService';
import { getSelectedNode } from '../helpers/commandHelpers';
import { Logger } from '../utils/logger';

export interface RegisterConfigurationCompareCommandsDeps {
  context: vscode.ExtensionContext;
  state: ExtensionState;
}

export function registerConfigurationCompareCommands(
  deps: RegisterConfigurationCompareCommandsDeps
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      '1c-metadata-tree.compareMergeConfiguration',
      async (node?: TreeNode) => {
        await executeConfigurationCompareCommand(deps, node);
      }
    ),
  ];
}

export function resolveConfigurationCompareLeftRoot(
  state: Pick<ExtensionState, 'treeDataProvider' | 'treeView'>,
  node?: TreeNode
): string | null {
  const target = getSelectedNode(state as ExtensionState, node);
  return (
    (target ? state.treeDataProvider?.getConfigPathForNode(target) : undefined) ??
    state.treeDataProvider?.getConfigPath() ??
    null
  );
}

export async function executeConfigurationCompareCommand(
  deps: RegisterConfigurationCompareCommandsDeps,
  node?: TreeNode
): Promise<void> {
  const leftRootPath = resolveConfigurationCompareLeftRoot(deps.state, node);
  if (!leftRootPath) {
    void vscode.window.showWarningMessage(
      'Не удалось определить левую конфигурацию. Откройте или выберите узел конфигурации в дереве.'
    );
    return;
  }

  const pickedRight = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: 'Выберите папку правой конфигурации для сравнения',
    openLabel: 'Сравнить',
  });
  const rightRootPath = pickedRight?.[0]?.fsPath;
  if (!rightRootPath) {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Сравнение конфигураций',
        cancellable: false,
      },
      async () => {
        const result = await buildConfigurationCompare({
          leftRootPath,
          rightRootPath,
        });
        showConfigurationCompare(
          deps.context,
          result.projection,
          `Сравнение конфигураций: ${path.basename(leftRootPath)} - ${path.basename(rightRootPath)}`
        );
      }
    );
  } catch (error) {
    Logger.error('Failed to compare configuration folders', error);
    void vscode.window.showErrorMessage(
      `Не удалось сравнить конфигурации: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
