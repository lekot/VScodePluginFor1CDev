import * as path from 'path';

export type IbcmdReportMode = 'check' | 'import';
export const IBCMD_REPORT_FILE_NAMES: Readonly<Record<IbcmdReportMode, string>> = {
  check: 'check-last.log',
  import: 'import-last.log',
};

export function getDefaultIbcmdReportDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.ibcmd-reports');
}

export function getIbcmdLastReportPath(workspaceRoot: string, mode: IbcmdReportMode): string {
  const dir = getDefaultIbcmdReportDir(workspaceRoot);
  const name = IBCMD_REPORT_FILE_NAMES[mode];
  return path.join(dir, name);
}

export function getIbcmdTaskLabel(mode: IbcmdReportMode): string {
  return mode === 'check'
    ? 'CDT: ibcmd - check infobase configuration'
    : 'CDT: ibcmd - import configuration from XML';
}

export function buildMissingIbcmdReportMessage(mode: IbcmdReportMode, reportPath: string): string {
  const taskLabel = getIbcmdTaskLabel(mode);
  return `ibcmd ${mode} report not found: ${reportPath}. Run VS Code task "${taskLabel}" first.`;
}

