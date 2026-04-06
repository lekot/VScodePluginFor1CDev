import * as fs from 'fs';
import * as vscode from 'vscode';
import { ExtensionState } from '../state/extensionState';
import { TreeNode } from '../models/treeNode';
import { MESSAGES } from '../constants/messages';
import { Logger } from '../utils/logger';
import { clearTreeCache } from '../utils/diskCache';
import { FormatDetector } from '../parsers/formatDetector';
import { getSelectedNode } from '../helpers/commandHelpers';
import { buildDiagnosticsSummaryText } from '../utils/diagnosticsSummary';
import {
  buildMissingIbcmdReportMessage,
  getIbcmdLastReportPath,
  getIbcmdTaskLabel,
} from '../services/ibcmdReportPaths';
import { rulesRegistry, metadataConverter } from '../rules';

type RegisterUtilityCommandsDeps = {
  state: ExtensionState;
  loadMetadataTree: () => Promise<void>;
  extensionContext: vscode.ExtensionContext;
};

function extensionRunModeLabel(mode: vscode.ExtensionMode): string {
  switch (mode) {
    case vscode.ExtensionMode.Development:
      return 'development';
    case vscode.ExtensionMode.Test:
      return 'test';
    default:
      return 'production';
  }
}

/** openPanel … refresh — same segment as pre-refactor `extension.ts` before editor commands. */
export function registerUtilityCommandsLeading(deps: RegisterUtilityCommandsDeps): vscode.Disposable[] {
  const { state, loadMetadataTree } = deps;

  const openPanelCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openPanel',
    async () => {
      Logger.info(MESSAGES.OPENING_PANEL);
      await loadMetadataTree();
    }
  );

  const openIbcmdReport = async (mode: 'check' | 'import'): Promise<void> => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage('No workspace folder is open.');
      return;
    }
    const reportPath = getIbcmdLastReportPath(ws.uri.fsPath, mode);
    if (!fs.existsSync(reportPath)) {
      const taskLabel = getIbcmdTaskLabel(mode);
      const action = await vscode.window.showWarningMessage(
        buildMissingIbcmdReportMessage(mode, reportPath),
        'Run task'
      );
      if (action === 'Run task') {
        await vscode.commands.executeCommand('workbench.action.tasks.runTask', taskLabel);
      }
      return;
    }
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(reportPath), { preview: false });
    } catch (err) {
      Logger.error('Failed to open ibcmd report', err);
      vscode.window.showErrorMessage(
        `Не удалось открыть отчёт ibcmd: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const openIbcmdCheckReportCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openIbcmdCheckReport',
    async () => openIbcmdReport('check')
  );

  const openIbcmdImportReportCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openIbcmdImportReport',
    async () => openIbcmdReport('import')
  );

  const getTreeReadyForTestCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.getTreeReadyForTest',
    (): boolean => !!(state.treeDataProvider?.getRootNode() ?? null)
  );

  const refreshCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.refresh',
    async () => {
      Logger.info(MESSAGES.REFRESHING);
      await loadMetadataTree();
    }
  );

  return [
    openPanelCommand,
    openIbcmdCheckReportCommand,
    openIbcmdImportReportCommand,
    getTreeReadyForTestCommand,
    refreshCommand,
  ];
}

/** copyPath … copyDiagnostics — registered after element + navigation in historical order. */
export function registerUtilityCommandsTrailing(deps: RegisterUtilityCommandsDeps): vscode.Disposable[] {
  const { state, extensionContext } = deps;

  const copyPathOrNameCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.copyPathOrName',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showWarningMessage('Select an element in the metadata tree first.');
        return;
      }
      const text = target.filePath || target.name;
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(`Copied: ${text}`, 2000);
    }
  );

  const clearCacheCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.clearCache',
    async () => {
      if (state.extensionContext?.globalStoragePath) {
        await clearTreeCache(state.extensionContext.globalStoragePath);
        vscode.window.showInformationMessage('CDT 41: cache cleared.');
      }
    }
  );

  const exportLogsCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.exportLogs',
    async () => {
      const content = Logger.getBufferedContent();
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('1c-metadata-tree-logs.txt'),
        filters: { 'Log files': ['log'], 'Text': ['txt'] },
      });
      if (!uri) {
        return;
      }
      try {
        await fs.promises.writeFile(uri.fsPath, content, 'utf-8');
        vscode.window.showInformationMessage(`${MESSAGES.LOGS_EXPORTED}: ${uri.fsPath}`);
        Logger.show();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`${MESSAGES.LOGS_EXPORT_FAILED}: ${msg}`);
      }
    }
  );

  const copyDiagnosticsSummaryCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.copyDiagnosticsSummary',
    async () => {
      try {
        const workspaceFolders =
          vscode.workspace.workspaceFolders?.map((wf) => ({
            name: wf.name,
            path: wf.uri.fsPath,
          })) ?? [];
        const folderPaths = workspaceFolders.map((f) => f.path);
        const found =
          folderPaths.length > 0 ? await FormatDetector.findAllConfigurationRoots(folderPaths) : [];
        const configRoots: Array<{ configPath: string; workspaceFolderPath: string; format: string }> =
          [];
        for (const entry of found) {
          const format = await FormatDetector.detect(entry.configPath);
          configRoots.push({
            configPath: entry.configPath,
            workspaceFolderPath: entry.workspaceFolderPath,
            format,
          });
        }
        const text = buildDiagnosticsSummaryText({
          productLabel: 'CDT 41',
          extensionVersion: String(extensionContext.extension.packageJSON.version ?? 'unknown'),
          vscodeVersion: vscode.version,
          appName: vscode.env.appName,
          hostPlatform: process.platform,
          hostArchitecture: process.arch,
          uiLocale: vscode.env.language,
          remoteName: vscode.env.remoteName,
          extensionRunMode: extensionRunModeLabel(extensionContext.extensionMode),
          workspaceFolders,
          configRoots,
        });
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage(MESSAGES.DIAGNOSTICS_COPIED);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`${MESSAGES.DIAGNOSTICS_COPY_FAILED}: ${msg}`);
      }
    }
  );

  const getYamlCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.getYaml',
    async (node?: TreeNode) => {
      const target = getSelectedNode(state, node);
      if (!target) {
        vscode.window.showErrorMessage('Выберите элемент в дереве метаданных.');
        return;
      }
      const rootTag = String(target.type);
      const rules = rulesRegistry.get(rootTag);
      if (!rules) {
        vscode.window.showWarningMessage('YAML не поддерживается для типа: ' + rootTag);
        return;
      }
      if (!target.filePath) {
        vscode.window.showWarningMessage('Для данного элемента отсутствует XML-файл.');
        return;
      }
      try {
        const xmlContent = await fs.promises.readFile(target.filePath, 'utf-8');
        const ir = metadataConverter.xmlToIr(xmlContent, rules);
        const yamlContent = metadataConverter.irToYaml(ir, rules);
        const doc = await vscode.workspace.openTextDocument({ content: yamlContent, language: 'yaml' });
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Ошибка при генерации YAML: ${msg}`);
      }
    }
  );

  return [copyPathOrNameCommand, clearCacheCommand, exportLogsCommand, copyDiagnosticsSummaryCommand, getYamlCommand];
}
