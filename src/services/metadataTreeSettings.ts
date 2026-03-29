import * as vscode from 'vscode';
import type { IbcmdConsoleOutputEncoding } from './ibcmd/ibcmdConsoleEncodingTypes';

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

export function getIbcmdConsoleOutputEncodingSetting(): IbcmdConsoleOutputEncoding {
  const cfg = vscode.workspace.getConfiguration();
  const v = cfg.get<string>('1cMetadataTree.ibcmd.consoleOutputEncoding', 'auto');
  if (v === 'utf8' || v === 'utf16le' || v === 'oem866' || v === 'windows1251' || v === 'auto') {
    return v;
  }
  return 'auto';
}

/** When true, log ibcmd import diagnostics (YAML path, redacted YAML body, source tree path) to Infobase output channel. */
export function getIbcmdImportDiagnosticsSetting(): boolean {
  const cfg = vscode.workspace.getConfiguration();
  return cfg.get<boolean>('1cMetadataTree.ibcmd.importDiagnostics') === true;
}

export function getPlatformPathSetting(): string {
  const cfg = vscode.workspace.getConfiguration();
  return (cfg.get<string>('1cMetadataTree.platform.path') ?? '').trim();
}

/** Settings query for "open settings" UX (primary key). */
export const IBCMD_PATH_SETTINGS_QUERY = '1cMetadataTree.ibcmd.path';

/** Platform / 1cv8 path (WOW Infobase Manager §1F). */
export const PLATFORM_PATH_SETTINGS_QUERY = '1cMetadataTree.platform.path';
