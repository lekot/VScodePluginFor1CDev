import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

import type { TreeNode } from '../models/treeNode';
import type { ExtensionState } from '../state/extensionState';
import { showConfigurationCompare } from '../compareMerge/configCompareProvider';
import {
  buildConfigurationCompare,
  type ConfigurationCompareInput,
  type ConfigurationCompareResult,
} from '../compareMerge/configurationCompareService';
import { getSelectedNode } from '../helpers/commandHelpers';
import { Logger } from '../utils/logger';

export interface RegisterConfigurationCompareCommandsDeps {
  context: vscode.ExtensionContext;
  state: ExtensionState;
  pickRightRoot?: () => Promise<string | undefined>;
  withCompareProgress?: (title: string, task: () => Promise<void>) => Promise<void>;
  buildCompare?: (input: ConfigurationCompareInput) => Promise<ConfigurationCompareResult>;
  showCompare?: (
    context: vscode.ExtensionContext,
    workspace: ConfigurationCompareResult['workspace'],
    title?: string
  ) => vscode.WebviewPanel;
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

  const rightRootPath = await pickConfigurationCompareRightRoot(deps);
  if (!rightRootPath) {
    return;
  }

  try {
    const progressTitle = 'Сравнение конфигураций';
    await withConfigurationCompareProgress(deps, progressTitle, async () => {
      const result = await (deps.buildCompare ?? buildConfigurationCompare)({
        leftRootPath,
        rightRootPath,
        backupRootPath: createConfigurationCompareBackupRootPath(
          deps.context,
          leftRootPath,
          rightRootPath
        ),
      });
      (deps.showCompare ?? showConfigurationCompare)(
        deps.context,
        result.workspace,
        `Сравнение конфигураций: ${path.basename(leftRootPath)} - ${path.basename(rightRootPath)}`
      );
    });
  } catch (error) {
    Logger.error('Failed to compare configuration folders', error);
    void vscode.window.showErrorMessage(
      `Не удалось сравнить конфигурации: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function createConfigurationCompareBackupRootPath(
  context: Pick<vscode.ExtensionContext, 'globalStorageUri'>,
  _leftRootPath: string,
  _rightRootPath: string
): string {
  return path.join(
    context.globalStorageUri.fsPath,
    'merge-backups',
    `${Date.now()}-${randomBytes(8).toString('hex')}`
  );
}

async function pickConfigurationCompareRightRoot(
  deps: RegisterConfigurationCompareCommandsDeps
): Promise<string | undefined> {
  if (deps.pickRightRoot) {
    return deps.pickRightRoot();
  }

  const pickedRight = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: 'Выберите папку правой конфигурации для сравнения',
    openLabel: 'Сравнить',
  });
  return pickedRight?.[0]?.fsPath;
}

async function withConfigurationCompareProgress(
  deps: RegisterConfigurationCompareCommandsDeps,
  title: string,
  task: () => Promise<void>
): Promise<void> {
  if (deps.withCompareProgress) {
    await deps.withCompareProgress(title, task);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    },
    task
  );
}
