import * as vscode from 'vscode';

/** Reads WOW design settings (`docs/WOW/infobase-manager-design.md` §5). */

export function getIbcmdPathSetting(): string {
  const cfg = vscode.workspace.getConfiguration();
  return (cfg.get<string>('1cMetadataTree.ibcmd.path') ?? '').trim();
}

export function getIbcmdTimeoutMsSetting(): number {
  const cfg = vscode.workspace.getConfiguration();
  const primary = cfg.get<number>('1cMetadataTree.ibcmd.timeout');
  if (typeof primary === 'number' && primary > 0 && Number.isFinite(primary)) {
    return primary;
  }
  return 0;
}

export function getIbcmdAutoDetectSetting(): boolean {
  const cfg = vscode.workspace.getConfiguration();
  const v = cfg.get<boolean>('1cMetadataTree.ibcmd.autoDetect');
  return v !== false;
}

export function getPlatformPathSetting(): string {
  const cfg = vscode.workspace.getConfiguration();
  return (cfg.get<string>('1cMetadataTree.platform.path') ?? '').trim();
}

/** Settings query for "open settings" UX (primary key). */
export const IBCMD_PATH_SETTINGS_QUERY = '1cMetadataTree.ibcmd.path';
