import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

import type { TreeNode } from '../models/treeNode';
import type { ConfigurationCompareContext } from '../extension/extensionFeatureContexts';
import { showConfigurationCompareLoading, type ConfigCompareLoadingSession } from '../compareMerge/configCompareLoadingController';
import {
  buildConfigurationCompare,
  type ConfigurationCompareInput,
  type ConfigurationCompareResult,
} from '../compareMerge/configurationCompareService';
import { getSelectedNode } from '../helpers/commandHelpers';
import { Logger } from '../utils/logger';
import { isConfigurationCompareCancelled, throwIfCompareCancelled } from '../compareMerge/compareCancellation';
import { CfeProjectManifestStorage } from '../extensionSupport/cfeProject/manifest';
import type { CompareSide } from '../compareMerge/domain/compareContracts';

export interface RegisterConfigurationCompareCommandsDeps {
  context: vscode.ExtensionContext;
  state: ConfigurationCompareContext;
  pickRightRoot?: () => Promise<string | undefined>;
  buildCompare?: (input: ConfigurationCompareInput) => Promise<ConfigurationCompareResult>;
  showCompareLoading?: (
    context: vscode.ExtensionContext,
    title: string,
    labels: { target: string; source: string }
  ) => ConfigCompareLoadingSession;
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
  state: ConfigurationCompareContext,
  node?: TreeNode
): string | null {
  const target = getSelectedNode(state, node);
  return (
    (target ? state.treeDataProvider.getConfigPathForNode(target) : undefined) ??
    state.treeDataProvider.getConfigPath() ??
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
      'Не удалось определить конфигурацию-приёмник (слева). Откройте или выберите узел конфигурации в дереве.'
    );
    return;
  }

  const rightRootPath = await pickConfigurationCompareRightRoot(deps);
  if (!rightRootPath) {
    return;
  }

  const progressTitle = `Сравнение конфигураций: ${path.basename(leftRootPath)} — ${path.basename(rightRootPath)}`;
  const loading = (deps.showCompareLoading ?? showConfigurationCompareLoading)(
    deps.context,
    progressTitle,
    { target: path.basename(leftRootPath), source: path.basename(rightRootPath) }
  );

  const runComparison = async (): Promise<void> => {
    const generation = loading.beginGeneration();
    try {
      const extensionBaseRoots = await resolveConfigurationCompareExtensionBaseRoots(
        leftRootPath,
        rightRootPath
      );
      throwIfCompareCancelled(generation.token);
      let configurationId;
      try {
        configurationId = await deps.state.configurationContextResolver
          .resolveFromResource(leftRootPath)
          .then((context) => context.configurationId);
      } catch {
        // Keep comparison available in view-only contexts without a registered write identity.
      }
      throwIfCompareCancelled(generation.token);
      const result = await (deps.buildCompare ?? buildConfigurationCompare)({
        leftRootPath,
        rightRootPath,
        extensionBaseRoots,
        configurationId,
        mutationEngine: deps.state.configurationMutationEngine,
        backupRootPath: createConfigurationCompareBackupRootPath(
          deps.context,
          leftRootPath,
          rightRootPath
        ),
        cancellation: generation.token,
        onProgress: (progress) => generation.report(progress),
      });
      if (!generation.isCurrent()) {
        result.workspace.dispose();
        return;
      }
      generation.complete(result.workspace);
    } catch (error) {
      if (isConfigurationCompareCancelled(error) || generation.token.isCancellationRequested) {
        return;
      }
      Logger.error('Failed to compare configuration folders', error);
      generation.fail(error);
    }
  };

  loading.setRetryHandler(() => {
    void runComparison();
  });
  await runComparison();
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
    title: 'Выберите папку источника (справа) для сравнения',
    openLabel: 'Сравнить',
  });
  return pickedRight?.[0]?.fsPath;
}

/** Resolves only explicit CFE relations from manifests in the active VS Code workspace. */
export async function resolveConfigurationCompareExtensionBaseRoots(
  leftRootPath: string,
  rightRootPath: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? []
): Promise<Readonly<Partial<Record<CompareSide, string>>>> {
  if (workspaceFolders.length === 0) {
    return {};
  }

  const selectedRoots: Record<CompareSide, string> = {
    left: await fs.realpath(leftRootPath),
    right: await fs.realpath(rightRootPath),
  };
  const baseRoots: Partial<Record<CompareSide, string>> = {};
  for (const folder of workspaceFolders) {
    const workspaceRoot = await fs.realpath(folder.uri.fsPath);
    const manifest = await new CfeProjectManifestStorage(workspaceRoot).read();
    for (const project of manifest.projects) {
      const extensionRoot = await resolveManifestProjectRoot(
        workspaceRoot,
        project.extensionConfiguration
      );
      if (!extensionRoot) {
        continue;
      }
      const matchingSides = (['left', 'right'] as const).filter((side) =>
        sameCanonicalRoot(selectedRoots[side], extensionRoot)
      );
      if (matchingSides.length === 0) {
        continue;
      }

      const baseRoot = await resolveManifestProjectRoot(workspaceRoot, project.baseConfiguration);
      if (!baseRoot) {
        throw new Error(
          `В manifest CFE не найдена базовая конфигурация для ${project.extensionConfiguration}.`
        );
      }
      for (const side of matchingSides) {
        const previous = baseRoots[side];
        if (previous && !sameCanonicalRoot(previous, baseRoot)) {
          throw new Error(
            `Manifest CFE содержит противоречащие связи для конфигурации ${side === 'left' ? 'слева' : 'справа'}.`
          );
        }
        baseRoots[side] = baseRoot;
      }
    }
  }
  return baseRoots;
}

async function resolveManifestProjectRoot(
  workspaceRoot: string,
  relativeRoot: string
): Promise<string | undefined> {
  try {
    return await fs.realpath(path.join(workspaceRoot, relativeRoot));
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  }
}

function sameCanonicalRoot(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
