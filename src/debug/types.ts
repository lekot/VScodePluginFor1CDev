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

export interface BslLaunchConfiguration extends vscode.DebugConfiguration {
  type: 'bsl';
  request: 'launch';
  /** Absolute path to main configuration dump root (Designer export). */
  rootProject: string;
  /** Infobase name or connection string (e.g. "MyBase" or "Srvr=localhost;Ref=mydb;"). */
  infobase: string;
  /** Directory of 1C platform installation. If omitted — auto-discovered. */
  platformPath?: string;
  /** Platform version string (e.g. "8.3.27"). Used when multiple versions are installed. */
  platformVersion?: string;
  /** Debug server host. Default: 'localhost'. */
  debugServerHost?: string;
  /** Debug server port. Default: 1550. */
  debugServerPort?: number;
  /** Absolute paths to extension configuration dump roots. */
  extensions?: string[];
  /** Debuggee type: thin client (default) or ibsrv web server for Playwright-based agent debugging. */
  debuggeeType?: 'thinClient' | 'webServer';
  /** Absolute path to file infobase directory. Required when debuggeeType='webServer'. */
  databasePath?: string;
  /** HTTP port for ibsrv web client. When debuggeeType='webServer', agent picks a free port. */
  webServerHttpPort?: number;
  /** Target types for auto-attach: 'Client' | 'Server' | 'WebClient' | ... */
  autoAttachTypes?: string[];
  /** Infobase alias filter (passed to RDBG attach). */
  infobaseAlias?: string;
  /** Event polling interval in ms. Default: 1000. */
  pingIntervalMs?: number;
  /** HTTP request timeout in ms. Default: 0 (no timeout). */
  connectTimeoutMs?: number;
}
