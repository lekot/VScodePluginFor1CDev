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
    `Workspace folders: ${workspaceFolders.length}`,
  ];

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
