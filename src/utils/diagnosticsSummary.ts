/**
 * Plain-text diagnostics bundle for support / bug reports (clipboard-friendly).
 */

export type DiagnosticsWorkspaceFolder = {
  name: string;
  path: string;
};

export type DiagnosticsConfigRoot = {
  configPath: string;
  workspaceFolderPath: string;
  format: string;
};

export type BuildDiagnosticsSummaryOptions = {
  productLabel: string;
  extensionVersion: string;
  vscodeVersion: string;
  /** Node `process.platform` (e.g. win32, darwin, linux). */
  hostPlatform?: string;
  /** VS Code UI locale (`vscode.env.language`), e.g. `en`, `ru`. */
  uiLocale?: string;
  /** Host editor display name (`vscode.env.appName`), e.g. Visual Studio Code, Cursor. */
  appName?: string;
  /** Remote extension host (`vscode.env.remoteName`), e.g. wsl, ssh-remote — omitted when local. */
  remoteName?: string;
  workspaceFolders: DiagnosticsWorkspaceFolder[];
  configRoots: DiagnosticsConfigRoot[];
  /** Override timestamp line (tests). */
  nowIso?: string;
};

export function buildDiagnosticsSummaryText(options: BuildDiagnosticsSummaryOptions): string {
  const { productLabel, extensionVersion, vscodeVersion, workspaceFolders, configRoots } = options;
  const stamp = options.nowIso ?? new Date().toISOString();

  const lines: string[] = [
    `${productLabel} diagnostics`,
    `Extension version: ${extensionVersion}`,
    `VS Code version: ${vscodeVersion}`,
  ];
  if (options.appName) {
    lines.push(`Host app: ${options.appName}`);
  }
  if (options.hostPlatform) {
    lines.push(`Host platform: ${options.hostPlatform}`);
  }
  if (options.uiLocale) {
    lines.push(`VS Code UI locale: ${options.uiLocale}`);
  }
  if (options.remoteName) {
    lines.push(`Remote: ${options.remoteName}`);
  }
  lines.push(`Workspace folders: ${workspaceFolders.length}`);

  for (const folder of workspaceFolders) {
    lines.push(`  - ${folder.name}: ${folder.path}`);
  }

  if (configRoots.length === 0) {
    lines.push('Configuration roots: (none found under workspace folders, max search depth 5)');
  } else {
    lines.push(`Configuration roots: ${configRoots.length}`);
    for (const root of configRoots) {
      lines.push(`  - ${root.configPath}`);
      lines.push(`    format: ${root.format} (workspace folder: ${root.workspaceFolderPath})`);
    }
  }

  lines.push(`Generated (UTC): ${stamp}`);
  return lines.join('\n');
}
