import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { MetadataTreeDataProvider } from './providers/treeDataProvider';
import { PropertiesProvider } from './providers/propertiesProvider';
import { TypeEditorProvider } from './providers/typeEditorProvider';
import { RolesRightsEditorProvider } from './rolesEditor/rolesRightsEditorProvider';
import { MetadataParser } from './parsers/metadataParser';
import { FormatDetector, ConfigFormat } from './parsers/formatDetector';
import { MetadataWatcherService } from './services/metadataWatcherService';
import { loadTreeFromCache, saveTreeToCache, clearTreeCache, invalidateTreeCache } from './utils/diskCache';
import { TreeNode, MetadataType } from './models/treeNode';
import { MESSAGES } from './constants/messages';
import { FormEditorProvider } from './formEditor/formEditorProvider';
import { getFormPaths } from './formEditor/formPaths';
import { getConfigurationXmlPathForNode } from './utils/configHelpers';
import { initDesignerTemplateRepository } from './services/designerTemplateRepository';
import { normalizeEmptyPlaceholderTree } from './utils/treeNormalization';
import { ReloadCoordinatorService } from './services/reloadCoordinatorService';
import { ExtensionState } from './state/extensionState';
import { getSelectedNode } from './helpers/commandHelpers';
import { registerElementCommands } from './commands/elementCommands';
import { registerNavigationCommands } from './commands/navigationCommands';
import {
  DELETE_RECONCILE_ATTEMPTS,
  DELETE_RECONCILE_POLL_MS,
  DELETE_RECONCILE_TIMEOUT_MS,
  recoverDeleteUiStateAfterReconcileIssue,
} from './services/deleteReconcileRecovery';
import { ReloadReason } from './types/reloadContracts';
import { buildDiagnosticsSummaryText } from './utils/diagnosticsSummary';
import { validateSubsystemCompositionRef } from './parsers/xmlChildObjects';
import {
  applySubsystemCompositionFileUpdate,
  readSubsystemCompositionRefsFromFile,
} from './services/subsystemCompositionFileUpdater';
import { runIbcmdConfigCheckGate } from './services/ibcmdConfigCheckGate';
import {
  buildMissingIbcmdReportMessage,
  getIbcmdLastReportPath,
  getIbcmdTaskLabel,
} from './services/ibcmdReportPaths';

const extensionState = new ExtensionState();

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

/**
 * Activate the extension
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    extensionState.init(context);
    initDesignerTemplateRepository(context);
    Logger.initialize();
    Logger.info(MESSAGES.EXTENSION_ACTIVATED);

  // Create tree data provider
  extensionState.treeDataProvider = new MetadataTreeDataProvider(context);

  // Register tree view
  extensionState.treeView = vscode.window.createTreeView('1c-metadata-tree', {
    treeDataProvider: extensionState.treeDataProvider,
    showCollapseAll: true,
  });
  extensionState.treeDataProvider.setMessageUpdater((msg) => {
    if (extensionState.treeView) {extensionState.treeView.message = msg ?? '';}
  });
  context.subscriptions.push(extensionState.treeView);

  // Create type editor provider
  extensionState.typeEditorProvider = new TypeEditorProvider(context);

  // Create roles rights editor provider
  extensionState.rolesRightsEditorProvider = new RolesRightsEditorProvider(context);
  context.subscriptions.push(extensionState.rolesRightsEditorProvider);

  // Create properties provider
  extensionState.propertiesProvider = new PropertiesProvider(
    context,
    extensionState.treeDataProvider,
    extensionState.typeEditorProvider,
    (payload) => {
      extensionState.formEditorProvider?.applySelectionPropertyChange(payload);
    }
  );
  context.subscriptions.push(extensionState.propertiesProvider);
  extensionState.reloadCoordinator = new ReloadCoordinatorService(async ({ configPath, reason, operationId }) => {
    Logger.info('reload.run.started', { configPath, reason, operationId });
    await invalidateTreeCacheOnly(configPath);
    await loadMetadataTree();
    Logger.info('reload.run.completed', { configPath, reason, operationId, success: true });
  });
  context.subscriptions.push({
    dispose: () => {
      extensionState.reloadCoordinator?.dispose();
      extensionState.reloadCoordinator = null;
    },
  });

  // Form editor (custom editor for Ext/Form.xml)
  extensionState.formEditorProvider = new FormEditorProvider((payload) => {
    if (extensionState.propertiesProvider) {
      void extensionState.propertiesProvider.showFormSelectionProperties(payload);
    }
  });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('1c-form-editor', extensionState.formEditorProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Register commands
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
    (): boolean => !!(extensionState.treeDataProvider?.getRootNode() ?? null)
  );

  const refreshCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.refresh',
    async () => {
      Logger.info(MESSAGES.REFRESHING);
      await loadMetadataTree();
    }
  );

  // Register properties command (shows empty state when no node/selection)
  const showPropertiesCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.showProperties',
    async (node?: TreeNode) => {
      const target = getSelectedNode(extensionState, node);
      if (extensionState.propertiesProvider) {
        if (target) {
          Logger.info(`Showing properties for: ${target.name}`);
        } else {
          Logger.debug('Showing properties panel (no node selected)');
        }
        await extensionState.propertiesProvider.showProperties(target);
      }
    }
  );

  // Register open XML command for context menu
  const openXMLCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openXML',
    async (node?: TreeNode) => {
      const target = getSelectedNode(extensionState, node);
      if (!target) {return;}
      const pathToOpen =
        (extensionState.treeDataProvider && getConfigurationXmlPathForNode(target, extensionState.treeDataProvider.getConfigPathForNode.bind(extensionState.treeDataProvider))) ??
        (target.type === MetadataType.Form && target.filePath
          ? getFormPaths(target.filePath).formXmlPath
          : target.filePath);
      if (!pathToOpen) {
        vscode.window.showWarningMessage('No XML file associated with this element');
        return;
      }
      try {
        Logger.info(`Opening XML file: ${pathToOpen}`);
        const uri = vscode.Uri.file(pathToOpen);
        await vscode.window.showTextDocument(uri);
      } catch (err) {
        Logger.error('Failed to open XML', err);
        vscode.window.showErrorMessage(
          `Не удалось открыть файл: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  const openBslModuleCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openBslModule',
    async (node?: TreeNode) => {
      const target = getSelectedNode(extensionState, node);
      if (!target) {return;}
      const fp = target.filePath;
      if (!fp || !fp.toLowerCase().endsWith('.bsl')) {
        vscode.window.showWarningMessage('Для этого узла нет файла модуля BSL или путь не задан.');
        return;
      }
      try {
        Logger.info(`Opening BSL module: ${fp}`);
        await vscode.window.showTextDocument(vscode.Uri.file(fp));
      } catch (err) {
        Logger.error('Failed to open BSL module', err);
        vscode.window.showErrorMessage(
          `Не удалось открыть модуль: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  // Open form in visual form editor (for Form nodes)
  const openFormEditorCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openFormEditor',
    async (node?: TreeNode) => {
      const target = getSelectedNode(extensionState, node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите узел формы в дереве метаданных.');
        return;
      }
      if (target.type !== MetadataType.Form || !target.filePath) {
        vscode.window.showWarningMessage('Редактор форм доступен только для узла формы.');
        return;
      }
      const { formXmlPath } = getFormPaths(target.filePath);
      const uri = vscode.Uri.file(formXmlPath);
      try {
        await vscode.commands.executeCommand('vscode.openWith', uri, '1c-form-editor');
      } catch (err) {
        Logger.error('Failed to open form editor', err);
        vscode.window.showErrorMessage(`Не удалось открыть редактор формы: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // Open rights editor for Role nodes
  const openRightsEditorCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openRightsEditor',
    async (node?: TreeNode) => {
      const target = getSelectedNode(extensionState, node);
      if (!target) {
        vscode.window.showWarningMessage('Select a role node in the metadata tree.');
        return;
      }
      if (target.type !== MetadataType.Role || !target.filePath) {
        vscode.window.showWarningMessage('Rights editor is only available for role nodes.');
        return;
      }
      try {
        if (extensionState.rolesRightsEditorProvider) {
          // Get config path from tree data provider - this avoids searching outside workspace
          const configPath = extensionState.treeDataProvider?.getConfigPathForNode(target) ?? extensionState.treeDataProvider?.getConfigPath();
          await extensionState.rolesRightsEditorProvider.show(target.filePath, configPath);
        }
      } catch (err) {
        Logger.error('Failed to open rights editor', err);
        vscode.window.showErrorMessage(`Failed to open rights editor: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // Save rights editor (e.g. when webview postMessage does not fire)
  const saveRightsEditorCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.saveRightsEditor',
    async () => {
      if (extensionState.rolesRightsEditorProvider) {
        await extensionState.rolesRightsEditorProvider.triggerSave();
      } else {
        vscode.window.showWarningMessage('Rights editor is not open.');
      }
    }
  );

  const elementCommandDisposables = registerElementCommands({
    state: extensionState,
    loadMetadataTree,
    invalidateCacheAndReload,
    scheduleDeleteReconcile,
  });
  const navigationCommandDisposables = registerNavigationCommands({
    state: extensionState,
  });

  const copyPathOrNameCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.copyPathOrName',
    async (node?: TreeNode) => {
      const target = getSelectedNode(extensionState, node);
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
      if (extensionState.extensionContext?.globalStoragePath) {
        await clearTreeCache(extensionState.extensionContext.globalStoragePath);
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
      if (!uri) {return;}
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
          folderPaths.length > 0
            ? await FormatDetector.findAllConfigurationRoots(folderPaths)
            : [];
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
          extensionVersion: String(context.extension.packageJSON.version ?? 'unknown'),
          vscodeVersion: vscode.version,
          appName: vscode.env.appName,
          hostPlatform: process.platform,
          hostArchitecture: process.arch,
          uiLocale: vscode.env.language,
          remoteName: vscode.env.remoteName,
          extensionRunMode: extensionRunModeLabel(context.extensionMode),
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

  const filterByTypeCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.filterByType',
    async () => {
      if (!extensionState.treeDataProvider) {return;}
      const items = MetadataTreeDataProvider.getFilterableTypeLabels().map(({ type, label }) => ({
        label,
        type,
        picked: (() => {
          const current = extensionState.treeDataProvider!.getTypeFilter();
          return current != null && current.includes(type);
        })(),
      }));
      const picks = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Выберите типы метаданных для отображения',
      });
      if (picks === undefined) {return;}
      extensionState.treeDataProvider.setTypeFilter(picks.length > 0 ? picks.map((p) => p.type) : null);
    }
  );

  const filterBySubsystemCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.filterBySubsystem',
    async (node?: TreeNode) => {
      const target = getSelectedNode(extensionState, node);
      if (!target || target.type !== MetadataType.Subsystem) {
        vscode.window.showWarningMessage('Выберите узел подсистемы в дереве метаданных.');
        return;
      }
      if (!extensionState.treeDataProvider) {return;}
      await extensionState.treeDataProvider.setSubsystemFilter(target.id, target.name);
      vscode.commands.executeCommand('setContext', 'subsystemFilterActive', true);
    }
  );

  const clearSubsystemFilterCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.clearSubsystemFilter',
    async () => {
      if (!extensionState.treeDataProvider) {return;}
      await extensionState.treeDataProvider.setSubsystemFilter(null, null);
      vscode.commands.executeCommand('setContext', 'subsystemFilterActive', false);
    }
  );

  const addToSubsystemCompositionCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.addToSubsystemComposition',
    async (node?: TreeNode) => {
      const target = getSelectedNode(extensionState, node);
      if (!target || target.type !== MetadataType.Subsystem) {
        vscode.window.showWarningMessage(MESSAGES.SUBSYSTEM_COMPOSITION_SELECT_SUBSYSTEM);
        return;
      }
      if (!target.filePath || !extensionState.treeDataProvider) {
        vscode.window.showErrorMessage(MESSAGES.SUBSYSTEM_COMPOSITION_NO_FILE);
        return;
      }
      const ref = await vscode.window.showInputBox({
        title: MESSAGES.SUBSYSTEM_COMPOSITION_ADD_TITLE,
        placeHolder: 'Catalog.Items',
        validateInput: (value) => {
          const v = (value || '').trim();
          if (!v) {
            return undefined;
          }
          const err = validateSubsystemCompositionRef(v);
          return err !== null ? err : undefined;
        },
      });
      if (ref === undefined) {
        return;
      }
      const trimmed = ref.trim();
      if (!trimmed) {
        return;
      }
      const resolved = extensionState.treeDataProvider.findRootObjectForCompositionRef(trimmed, target);
      if (!resolved) {
        const inOtherConfig = extensionState.treeDataProvider.hasCompositionRefInOtherConfiguration(trimmed, target);
        vscode.window.showErrorMessage(
          inOtherConfig
            ? MESSAGES.SUBSYSTEM_COMPOSITION_OBJECT_IN_OTHER_CONFIG
            : MESSAGES.SUBSYSTEM_COMPOSITION_OBJECT_NOT_FOUND
        );
        return;
      }
      try {
        const gate = await runIbcmdConfigCheckGate();
        if (!gate.ok) {
          vscode.window.showErrorMessage(
            `Проверка валидности конфигурации (ibcmd) обязательна перед изменением состава подсистем: ${gate.message}`
          );
          return;
        }
        const { rejected } = await applySubsystemCompositionFileUpdate(target.filePath, {
          add: [trimmed],
          remove: [],
        });
        if (rejected.length > 0) {
          vscode.window.showWarningMessage(
            `${MESSAGES.SUBSYSTEM_COMPOSITION_REJECTED_PREFIX} ${rejected.map((r) => `${r.ref} (${r.reason})`).join('; ')}`
          );
        }
        const cp = extensionState.treeDataProvider.getConfigPathForNode(target);
        if (cp) {
          await invalidateTreeCacheOnly(cp);
          await loadMetadataTree();
        }
        vscode.window.showInformationMessage(`${MESSAGES.SUBSYSTEM_COMPOSITION_ADD_OK} (${trimmed})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`${MESSAGES.SUBSYSTEM_COMPOSITION_WRITE_FAILED} ${msg}`);
      }
    }
  );

  const removeFromSubsystemCompositionCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.removeFromSubsystemComposition',
    async (node?: TreeNode) => {
      const target = getSelectedNode(extensionState, node);
      if (!target || target.type !== MetadataType.Subsystem) {
        vscode.window.showWarningMessage(MESSAGES.SUBSYSTEM_COMPOSITION_SELECT_SUBSYSTEM);
        return;
      }
      if (!target.filePath || !extensionState.treeDataProvider) {
        vscode.window.showErrorMessage(MESSAGES.SUBSYSTEM_COMPOSITION_NO_FILE);
        return;
      }
      let refs: string[];
      try {
        refs = await readSubsystemCompositionRefsFromFile(target.filePath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`${MESSAGES.SUBSYSTEM_COMPOSITION_READ_FAILED} ${msg}`);
        return;
      }
      if (refs.length === 0) {
        vscode.window.showInformationMessage(MESSAGES.SUBSYSTEM_COMPOSITION_EMPTY);
        return;
      }
      const picked = await vscode.window.showQuickPick(refs, {
        placeHolder: MESSAGES.SUBSYSTEM_COMPOSITION_REMOVE_PLACEHOLDER,
      });
      if (picked === undefined) {
        return;
      }
      try {
        const gate = await runIbcmdConfigCheckGate();
        if (!gate.ok) {
          vscode.window.showErrorMessage(
            `Проверка валидности конфигурации (ibcmd) обязательна перед изменением состава подсистем: ${gate.message}`
          );
          return;
        }
        await applySubsystemCompositionFileUpdate(target.filePath, {
          add: [],
          remove: [picked],
        });
        const cp = extensionState.treeDataProvider.getConfigPathForNode(target);
        if (cp) {
          await invalidateTreeCacheOnly(cp);
          await loadMetadataTree();
        }
        vscode.window.showInformationMessage(`${MESSAGES.SUBSYSTEM_COMPOSITION_REMOVE_OK} (${picked})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`${MESSAGES.SUBSYSTEM_COMPOSITION_WRITE_FAILED} ${msg}`);
      }
    }
  );

  context.subscriptions.push(
    openPanelCommand,
    openIbcmdCheckReportCommand,
    openIbcmdImportReportCommand,
    getTreeReadyForTestCommand,
    refreshCommand,
    showPropertiesCommand,
    openXMLCommand,
    openBslModuleCommand,
    openFormEditorCommand,
    openRightsEditorCommand,
    saveRightsEditorCommand,
    ...elementCommandDisposables,
    ...navigationCommandDisposables,
    copyPathOrNameCommand,
    clearCacheCommand,
    exportLogsCommand,
    copyDiagnosticsSummaryCommand,
    filterByTypeCommand,
    filterBySubsystemCommand,
    clearSubsystemFilterCommand,
    addToSubsystemCompositionCommand,
    removeFromSubsystemCompositionCommand
  );

  // Handle tree view selection to show properties or rights editor
  const treeSelectionDisposable = extensionState.treeView.onDidChangeSelection(async (e) => {
    if (e.selection.length > 0) {
      const selectedNode = e.selection[0];
      Logger.debug(`Tree selection changed: ${selectedNode.name}`);
      
      // For Role nodes, open rights editor instead of properties panel
      if (selectedNode.type === MetadataType.Role && selectedNode.filePath) {
        await vscode.commands.executeCommand('1c-metadata-tree.openRightsEditor', selectedNode);
      } else if (extensionState.propertiesProvider) {
        // For all other nodes, show properties panel
        await vscode.commands.executeCommand('1c-metadata-tree.showProperties', selectedNode);
      }
    }
  });
  context.subscriptions.push(treeSelectionDisposable);

  // Set context for conditional activation
  vscode.commands.executeCommand('setContext', '1c-metadata-tree:enabled', true);

  // Auto-load metadata tree if workspace is open (non-blocking, catch errors)
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    loadMetadataTree().catch((error) => {
      Logger.error('Error during auto-load', error);
      // Don't throw - extension should still activate
    });
  }

  Logger.info('Extension activation completed');
  } catch (error) {
    // Centralized error handling for activation failures
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('Critical error during extension activation', error);
    
    // Show user-friendly error message
    vscode.window.showErrorMessage(
      `CDT 41: Failed to activate extension. ${errorMessage}`,
      'Show Logs'
    ).then(selection => {
      if (selection === 'Show Logs') {
        Logger.show();
      }
    });
    
    // Extension should still be registered but in degraded state
    // Don't re-throw - allow VS Code to continue
  }
}

/**
 * Path relative to workspace folder for display (e.g. "structure_backup" or ".").
 */
function getWorkspaceRelativePath(workspaceFolderPath: string, configRootPath: string): string {
  const rel = path.relative(workspaceFolderPath, configRootPath);
  const normalized = rel ? path.normalize(rel).replace(/\\/g, '/') : '.';
  return normalized;
}

/**
 * Invalidate tree cache for a specific config and reload the metadata tree.
 * Used after create/delete/rename/duplicate operations to ensure fresh state.
 */
async function invalidateCacheAndReload(configPath: string): Promise<void> {
  await invalidateTreeCacheOnly(configPath);
  await loadMetadataTree();
}

async function invalidateTreeCacheOnly(configPath: string): Promise<void> {
  if (extensionState.extensionContext?.globalStoragePath) {
    await invalidateTreeCache(extensionState.extensionContext.globalStoragePath, configPath);
  }
}

async function recoverDeleteUiState(
  configPath: string,
  elementName: string,
  deletedNodeId: string,
  reason: 'timeout' | 'failed'
): Promise<void> {
  const recovery = await recoverDeleteUiStateAfterReconcileIssue({
    elementName,
    reason,
    forceRefresh: async () => {
      await invalidateCacheAndReload(configPath);
    },
    verifyDeletionConverged: async () => verifyNodeDeletedInTree(configPath, deletedNodeId),
  });

  const logPayload = {
    configPath,
    elementName,
    deletedNodeId,
    reason,
    rollbackApplied: recovery.rollbackApplied,
    refreshAttempted: recovery.refreshAttempted,
    refreshSucceeded: recovery.refreshSucceeded,
    converged: recovery.converged,
    shouldNotifyUser: recovery.shouldNotifyUser,
  };
  if (recovery.shouldNotifyUser) {
    Logger.warn('delete.reconcile.recovery', logPayload);
    if (recovery.message) {
      vscode.window.showWarningMessage(recovery.message);
    }
  } else {
    Logger.info('delete.reconcile.recovery.silent', logPayload);
  }
}

function scheduleCoordinatedReload(
  configPath: string,
  reason: ReloadReason,
  options?: { debounceMs?: number; operationId?: string }
): void {
  if (!extensionState.reloadCoordinator) {
    void invalidateCacheAndReload(configPath).catch((error) => Logger.error('Fallback reload failed', error));
    return;
  }
  extensionState.reloadCoordinator.scheduleReload(configPath, reason, options);
  Logger.info('reload.schedule', {
    configPath,
    reason,
    operationId: options?.operationId,
    state: extensionState.reloadCoordinator.getState(configPath),
  });
}

function scheduleDeleteReconcile(
  configPath: string,
  operationId: string,
  deletedNodeId: string,
  elementName: string
): void {
  const coordinator = extensionState.reloadCoordinator;
  if (!coordinator) {
    void invalidateCacheAndReload(configPath).catch((error) => Logger.error('Fallback delete reconcile failed', error));
    return;
  }

  coordinator.markMutationWindow(configPath, operationId);
  const initialState = coordinator.getState(configPath);
  const baselineExecuted = initialState.executedCount;
  scheduleCoordinatedReload(configPath, 'delete-command', { operationId, debounceMs: 0 });

  const finalize = async (): Promise<void> => {
    for (let i = 0; i < DELETE_RECONCILE_ATTEMPTS; i++) {
      await new Promise((resolve) => setTimeout(resolve, DELETE_RECONCILE_POLL_MS));
      const result = coordinator.getOperationResult(configPath, operationId);
      if (result) {
        if (!result.succeeded) {
          Logger.warn('delete.reconcile.failed', {
            operationId,
            elementName,
            reason: result.reason,
            error: result.error,
          });
          await recoverDeleteUiState(configPath, elementName, deletedNodeId, 'failed');
          return;
        }

        const state = coordinator.getState(configPath);
        Logger.info('delete.reconcile.completed', {
          operationId,
          success: true,
          baselineExecuted,
          scheduled: state.scheduledCount,
          executed: state.executedCount,
          coalesced: state.coalescedCount,
          suppressedWatcher: state.suppressedWatcherCount,
        });
        vscode.window.showInformationMessage(`Удалён элемент: ${elementName}`);
        return;
      }
    }

    Logger.warn('delete.reconcile.timeout', { operationId, elementName, timeoutMs: DELETE_RECONCILE_TIMEOUT_MS });
    await recoverDeleteUiState(configPath, elementName, deletedNodeId, 'timeout');
  };

  void finalize().catch((error) => {
    Logger.error('delete.reconcile.monitor.failed', error);
  });
}

async function verifyNodeDeletedInTree(configPath: string, deletedNodeId: string): Promise<boolean | null> {
  const provider = extensionState.treeDataProvider;
  if (!provider) {
    return null;
  }
  const existing = provider.findNodeById(deletedNodeId);
  if (!existing) {
    return true;
  }
  const existingConfigPath = provider.getConfigPathForNode(existing);
  if (!existingConfigPath) {
    return null;
  }
  return path.normalize(existingConfigPath) !== path.normalize(configPath);
}

/**
 * Load metadata tree from workspace (all configurations in all workspace folders).
 */
async function loadMetadataTree(): Promise<void> {
  if (!extensionState.treeDataProvider) {
    Logger.error(MESSAGES.ERROR_PROVIDER_NOT_INITIALIZED);
    return;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage(MESSAGES.NO_WORKSPACE);
    extensionState.treeDataProvider.setRootNodes([], undefined);
    return;
  }

  const workspacePaths = folders.map((f) => f.uri.fsPath);
  const configs = await FormatDetector.findAllConfigurationRoots(workspacePaths);
  if (configs.length === 0) {
    vscode.window.showWarningMessage(MESSAGES.NO_CONFIGURATION);
    extensionState.treeDataProvider.setRootNodes([], undefined);
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: MESSAGES.LOADING,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 0 });

        const storagePath = extensionState.extensionContext?.globalStoragePath ?? '';
        const roots: TreeNode[] = [];
        const loadContextMap = new Map<string, { configPath: string; format: ConfigFormat }>();

        for (let i = 0; i < configs.length; i++) {
          const { configPath: configRoot, workspaceFolderPath } = configs[i];
          let rootNode: TreeNode | null = storagePath
            ? await loadTreeFromCache(storagePath, configRoot)
            : null;
          if (!rootNode) {
            rootNode = await MetadataParser.parseStructureOnly(configRoot);
            if (storagePath) {
              await saveTreeToCache(storagePath, configRoot, rootNode);
            }
          }
          const format = await FormatDetector.detect(configRoot);

          // Normalize in-memory tree so that lazy loading never breaks
          // when filesystem folders for Catalogs/Documents are absent.
          rootNode = normalizeEmptyPlaceholderTree(rootNode, { configPath: configRoot, format });
          const relativePath = getWorkspaceRelativePath(workspaceFolderPath, configRoot);
          const uniqueId = `config:${path.normalize(configRoot).replace(/\\/g, '_')}`;
          rootNode.id = uniqueId;
          rootNode.name =
            relativePath && relativePath !== '.' ? `Configuration (~/${relativePath})` : 'Configuration';
          roots.push(rootNode);
          loadContextMap.set(uniqueId, { configPath: configRoot, format });
          progress.report({ increment: (100 * (i + 1)) / configs.length });
        }

        const provider = extensionState.treeDataProvider!;
        if (roots.length === 1) {
          provider.setRootNode(roots[0], loadContextMap.get(roots[0].id));
        } else {
          provider.setRootNodes(roots, loadContextMap);
        }

        for (const w of extensionState.metadataWatchers) {
          w.dispose();
        }
        extensionState.metadataWatchers = [];
        const onReload = () => {
          // Backward-compatible callback path: watcher still invokes this shape.
        };
        const onFileChanged = (changedPath: string) => {
          extensionState.propertiesProvider?.notifyFileChangedExternally(changedPath);
        };
        for (const { configPath: configRoot } of configs) {
          const watcher = new MetadataWatcherService();
          watcher.start(configRoot, {
            onTreeReload: onReload,
            onFsMutationBatch: (meta) => {
              scheduleCoordinatedReload(meta.configPath, 'watcher');
            },
            onFileChanged,
          });
          extensionState.metadataWatchers.push(watcher);
          extensionState.extensionContext?.subscriptions.push(watcher);
        }

        vscode.window.showInformationMessage(MESSAGES.SUCCESS);
        Logger.info(MESSAGES.TREE_LOADED);
      }
    );
  } catch (error) {
    handleLoadError(error);
  }
}

/**
 * Handle metadata loading error
 */
function handleLoadError(error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  Logger.error('Error loading metadata tree', error);
  vscode.window.showErrorMessage(`${MESSAGES.ERROR_LOADING}: ${errorMessage}`);
}

/**
 * Deactivate the extension
 */
export function deactivate(): void {
  extensionState.dispose();
  Logger.info(MESSAGES.EXTENSION_DEACTIVATED);
}
