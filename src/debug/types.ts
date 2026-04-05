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
}
