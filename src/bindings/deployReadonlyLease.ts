import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeConfigRelativePath } from './bindingPathUtils';
import type { DeployMode } from './deployContracts';

/** Режим из настроек `1cMetadataTree.deploy.mode` (по умолчанию copy, дизайн §16.5). */
export function readDeployMode(): DeployMode {
  const v = vscode.workspace.getConfiguration('1cMetadataTree').get<string>('deploy.mode', 'copy');
  return v === 'block' ? 'block' : 'copy';
}

/** Optional XML precheck gate before deploy import (default off). */
export function readDeployPrecheckXmlBeforeImportSetting(): boolean {
  return vscode.workspace.getConfiguration('1cMetadataTree').get<boolean>('deploy.precheckXmlBeforeImport') === true;
}

/**
 * VS Code 1.88+: `files.readonlyInclude` для временной блокировки редактирования (дизайн §16.5).
 */
export function vscodeSupportsDeployReadonlyLock(): boolean {
  const m = /^(\d+)\.(\d+)/.exec(vscode.version);
  if (!m) {
    return false;
  }
  const major = Number.parseInt(m[1]!, 10);
  const minor = Number.parseInt(m[2]!, 10);
  return major > 1 || (major === 1 && minor >= 88);
}

/**
 * Glob относительно корня workspace folder: дерево выгрузки (папка с Configuration.xml).
 * Если Configuration.xml в корне папки — `**` (вся папка workspace).
 */
export function configurationTreeReadonlyGlob(configRelativePath: string): string {
  const norm = normalizeConfigRelativePath(configRelativePath);
  const dir = path.posix.dirname(norm);
  if (!dir || dir === '.') {
    return '**';
  }
  return `${dir}/**`;
}

interface FolderLockState {
  readonly baselinePatterns: Set<string>;
  readonly hadWorkspaceFolderValue: boolean;
  readonly activePatterns: Map<string, number>;
  pendingOps: number;
  mutationQueue: Promise<void>;
}

const activeFolderLocks = new Map<string, FolderLockState>();

function cleanupFolderLockIfIdle(normRoot: string, state: FolderLockState): void {
  if (state.pendingOps === 0 && state.activePatterns.size === 0 && activeFolderLocks.get(normRoot) === state) {
    activeFolderLocks.delete(normRoot);
  }
}

export function resetReadonlyIncludeDeployLocksForTests(): void {
  activeFolderLocks.clear();
}

export async function applyReadonlyIncludeForDeploy(
  workspaceFolderRoot: string,
  globPattern: string,
): Promise<{ dispose: () => Promise<void> } | undefined> {
  if (!vscodeSupportsDeployReadonlyLock()) {
    return undefined;
  }
  const scope = vscode.Uri.file(workspaceFolderRoot);
  const cfg = vscode.workspace.getConfiguration('files', scope);
  const normRoot = path.normalize(workspaceFolderRoot);

  let lockState = activeFolderLocks.get(normRoot);
  if (!lockState) {
    const baseline = cfg.get<Record<string, boolean> | undefined>('readonlyInclude');
    const baselinePatterns = new Set<string>();
    if (baseline) {
      for (const [k, v] of Object.entries(baseline)) {
        if (v) {
          baselinePatterns.add(k);
        }
      }
    }
    lockState = {
      baselinePatterns,
      hadWorkspaceFolderValue: baseline !== undefined && Object.keys(baseline).length > 0,
      activePatterns: new Map<string, number>(),
      pendingOps: 0,
      mutationQueue: Promise.resolve(),
    };
    activeFolderLocks.set(normRoot, lockState);
  }


  const targetState = lockState!;
  targetState.pendingOps++;

  const updateOp = async () => {
    try {
      const currentCount = targetState.activePatterns.get(globPattern) ?? 0;
      targetState.activePatterns.set(globPattern, currentCount + 1);

    const liveConfig = cfg.get<Record<string, boolean> | undefined>('readonlyInclude');
    const merged: Record<string, boolean> = { ...(liveConfig ?? {}) };
    for (const pat of targetState.activePatterns.keys()) {
      merged[pat] = true;
    }
    await cfg.update('readonlyInclude', merged, vscode.ConfigurationTarget.WorkspaceFolder);
    } finally {
      targetState.pendingOps--;
      cleanupFolderLockIfIdle(normRoot, targetState);
    }
  };
  const currentOp = targetState.mutationQueue.then(updateOp, updateOp);
  targetState.mutationQueue = currentOp.then(() => undefined, () => undefined);

  try {
    await currentOp;
  } catch {
    targetState.pendingOps++;
    const rollbackOp = async () => {
      try {
        const count = targetState.activePatterns.get(globPattern) ?? 1;
        if (count <= 1) {
          targetState.activePatterns.delete(globPattern);
        } else {
          targetState.activePatterns.set(globPattern, count - 1);
        }
      } finally {
        targetState.pendingOps--;
        cleanupFolderLockIfIdle(normRoot, targetState);
      }
    };
    const nextRollback = targetState.mutationQueue.then(rollbackOp, rollbackOp);
    targetState.mutationQueue = nextRollback.then(() => undefined, () => undefined);
    await nextRollback;
    return undefined;
  }
  let disposed = false;
  return {
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        targetState.pendingOps++;
        const disposeOp = async () => {
          try {
            const count = targetState.activePatterns.get(globPattern) ?? 1;
          if (count <= 1) {
            targetState.activePatterns.delete(globPattern);
          } else {
            targetState.activePatterns.set(globPattern, count - 1);
          }
          const currentLive = cfg.get<Record<string, boolean> | undefined>('readonlyInclude');
          const nextConfig: Record<string, boolean> = { ...(currentLive ?? {}) };

          if (!targetState.activePatterns.has(globPattern) && !targetState.baselinePatterns.has(globPattern)) {
            delete nextConfig[globPattern];
          }

          for (const pat of targetState.activePatterns.keys()) {
            nextConfig[pat] = true;
          }

          if (targetState.activePatterns.size === 0) {
            if (Object.keys(nextConfig).length === 0 && !targetState.hadWorkspaceFolderValue) {
              await cfg.update('readonlyInclude', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
            } else {
              await cfg.update('readonlyInclude', nextConfig, vscode.ConfigurationTarget.WorkspaceFolder);
            }
          } else {
            await cfg.update('readonlyInclude', nextConfig, vscode.ConfigurationTarget.WorkspaceFolder);
          }
        } finally {
          targetState.pendingOps--;
          cleanupFolderLockIfIdle(normRoot, targetState);
        }
        };

        const op = targetState.mutationQueue.then(disposeOp, disposeOp);
        targetState.mutationQueue = op.then(() => undefined, () => undefined);
        await op;
      } catch {
        /* не мешаем завершению раскатки */
      }
    },
  };
}
