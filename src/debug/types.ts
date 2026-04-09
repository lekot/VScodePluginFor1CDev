import * as vscode from 'vscode';

export interface BslAttachConfiguration extends vscode.DebugConfiguration {
  type: 'bsl';
  request: 'attach';
  host: string;
  port: number;
  infobaseAlias?: string;
  autoAttachTargets?: boolean;
  pingIntervalMs?: number;
  connectTimeoutMs?: number;
  /**
   * Additional configuration roots to search when resolving module IDs.
   * Used for multi-root workspaces or when extension configurations live
   * outside the main workspace folder. Each entry is an absolute path.
   */
  extensions?: string[];
}
