import * as vscode from 'vscode';

/**
 * Reads WOW design settings with fallback to deprecated `1cInfobaseManager.*` keys (shipped pre-alignment).
 */

export function getIbcmdPathSetting(): string {
  const cfg = vscode.workspace.getConfiguration();
  const primary = (cfg.get<string>('1cMetadataTree.ibcmd.path') ?? '').trim();
  if (primary) {
    return primary;
  }
  return (cfg.get<string>('1cInfobaseManager.ibcmdPath') ?? '').trim();
}

export function getIbcmdTimeoutMsSetting(): number {
  const cfg = vscode.workspace.getConfiguration();
  const primary = cfg.get<number>('1cMetadataTree.ibcmd.timeout');
  if (typeof primary === 'number' && primary > 0 && Number.isFinite(primary)) {
    return primary;
  }
  const legacy = cfg.get<number>('1cInfobaseManager.ibcmdTimeoutMs', 0);
  if (typeof legacy === 'number' && legacy > 0 && Number.isFinite(legacy)) {
    return legacy;
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
  const primary = (cfg.get<string>('1cMetadataTree.platform.path') ?? '').trim();
  if (primary) {
    return primary;
  }
  return (cfg.get<string>('1cInfobaseManager.platformBinPath') ?? '').trim();
}

/** Settings query for "open settings" UX (primary key). */
export const IBCMD_PATH_SETTINGS_QUERY = '1cMetadataTree.ibcmd.path';
