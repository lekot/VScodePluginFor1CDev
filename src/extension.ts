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
import { loadTreeFromCache, saveTreeToCache, clearTreeCache } from './utils/diskCache';
import {
  createElement as doCreateElement,
  createForm as doCreateForm,
  duplicateElement as doDuplicateElement,
  deleteElement as doDeleteElement,
  renameElement as doRenameElement,
  findReferencesToElement,
} from './services/elementOperations';
import { validateElementName } from './utils/elementNameValidator';
import { TreeNode, MetadataType } from './models/treeNode';
import { MESSAGES } from './constants/messages';
import { FormEditorProvider } from './formEditor/formEditorProvider';
import { getFormPaths } from './formEditor/formPaths';

/** Resolve node from command argument or current tree selection. */
function getSelectedNode(node?: TreeNode): TreeNode | undefined {
  if (node) {
    return node;
  }
  return treeView?.selection?.[0];
}

let treeDataProvider: MetadataTreeDataProvider | null = null;
let treeView: vscode.TreeView<TreeNode> | null = null;
let propertiesProvider: PropertiesProvider | null = null;
let typeEditorProvider: TypeEditorProvider | null = null;
let rolesRightsEditorProvider: RolesRightsEditorProvider | null = null;
let extensionContext: vscode.ExtensionContext | undefined;
let metadataWatchers: MetadataWatcherService[] = [];

/**
 * Activate the extension
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    extensionContext = context;
    Logger.initialize();
    Logger.info(MESSAGES.EXTENSION_ACTIVATED);

  // Create tree data provider
  treeDataProvider = new MetadataTreeDataProvider(context);

  // Register tree view
  treeView = vscode.window.createTreeView('1c-metadata-tree', {
    treeDataProvider: treeDataProvider,
    showCollapseAll: true,
  });
  treeDataProvider.setMessageUpdater((msg) => {
    if (treeView) treeView.message = msg ?? '';
  });
  context.subscriptions.push(treeView);

  // Create type editor provider
  typeEditorProvider = new TypeEditorProvider(context);

  // Create roles rights editor provider
  rolesRightsEditorProvider = new RolesRightsEditorProvider(context);
  context.subscriptions.push(rolesRightsEditorProvider);

  // Create properties provider
  propertiesProvider = new PropertiesProvider(context, treeDataProvider, typeEditorProvider);
  context.subscriptions.push(propertiesProvider);

  // Form editor (custom editor for Ext/Form.xml)
  const formEditorProvider = new FormEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('1c-form-editor', formEditorProvider, {
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

  /** Find first Form node by traversing tree (expands path when revealing). */
  async function findFirstFormNode(element: TreeNode): Promise<TreeNode | null> {
    if (element.type === MetadataType.Form) return element;
    const children = await treeDataProvider!.getChildren(element);
    for (const child of children) {
      const found = await findFirstFormNode(child);
      if (found) return found;
    }
    return null;
  }

  const focusTreeCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.focus',
    async () => {
      if (!treeView || !treeDataProvider) return;
      let root = treeDataProvider.getRootNode();
      if (!root) {
        await new Promise((r) => setTimeout(r, 200));
        root = treeDataProvider.getRootNode();
      }
      if (!root) {
        await new Promise((r) => setTimeout(r, 400));
        root = treeDataProvider.getRootNode();
      }
      if (!root) return;
      const formNode = await findFirstFormNode(root);
      const nodeToReveal = formNode ?? root;
      await treeView.reveal(nodeToReveal, { focus: true });
    }
  );

  const getTreeReadyForTestCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.getTreeReadyForTest',
    (): boolean => !!(treeDataProvider?.getRootNode() ?? null)
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
      const target = getSelectedNode(node);
      if (propertiesProvider) {
        if (target) {
          Logger.info(`Showing properties for: ${target.name}`);
        } else {
          Logger.debug('Showing properties panel (no node selected)');
        }
        await propertiesProvider.showProperties(target);
      }
    }
  );

  // Register open XML command for context menu
  const openXMLCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openXML',
    async (node?: TreeNode) => {
      const target = getSelectedNode(node);
      if (!target) return;
      if (!target.filePath) {
        vscode.window.showWarningMessage('No XML file associated with this element');
        return;
      }
      const pathToOpen =
        target.type === MetadataType.Form
          ? getFormPaths(target.filePath).formXmlPath
          : target.filePath;
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

  // Open form in visual form editor (for Form nodes)
  const openFormEditorCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.openFormEditor',
    async (node?: TreeNode) => {
      const target = getSelectedNode(node);
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
      const target = getSelectedNode(node);
      if (!target) {
        vscode.window.showWarningMessage('Select a role node in the metadata tree.');
        return;
      }
      if (target.type !== MetadataType.Role || !target.filePath) {
        vscode.window.showWarningMessage('Rights editor is only available for role nodes.');
        return;
      }
      try {
        if (rolesRightsEditorProvider) {
          await rolesRightsEditorProvider.show(target.filePath);
        }
      } catch (err) {
        Logger.error('Failed to open rights editor', err);
        vscode.window.showErrorMessage(`Failed to open rights editor: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // Create / Duplicate / Delete / Rename — Stage 7 implementation
  const createElementCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.createElement',
    async (node?: TreeNode) => {
      const target = getSelectedNode(node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите узел типа (Справочники, Документы и т.д.) или объект метаданных.');
        return;
      }
      const configPath = treeDataProvider?.getConfigPathForNode(target) ?? treeDataProvider?.getConfigPath();
      if (!configPath) {
        vscode.window.showWarningMessage('Дерево метаданных не загружено. Откройте конфигурацию.');
        return;
      }
      const format = await FormatDetector.detect(configPath);
      if (format !== ConfigFormat.Designer) {
        vscode.window.showInformationMessage('Операции с элементами поддерживаются только для формата Designer.');
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Имя нового элемента',
        placeHolder: 'Введите имя (латиница, кириллица, цифры, _)',
        validateInput: (value) => {
          const siblingNames = (target.children || []).map((c) => c.name);
          return validateElementName(value.trim(), siblingNames) ?? undefined;
        },
      });
      if (name === undefined || name.trim() === '') return;
      try {
        await doCreateElement(target, name);
        vscode.window.showInformationMessage(`Создан элемент: ${name.trim()}`);
        await loadMetadataTree();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  const createFormCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.createForm',
    async (node?: TreeNode) => {
      const target = getSelectedNode(node);
      if (!target) {
        vscode.window.showWarningMessage('Выберите узел «Forms» в дереве метаданных.');
        return;
      }
      if (target.id !== 'Forms') {
        vscode.window.showWarningMessage('Создание формы: выберите узел «Forms» (папку форм объекта).');
        return;
      }
      const configPath = treeDataProvider?.getConfigPathForNode(target) ?? treeDataProvider?.getConfigPath();
      if (!configPath) {
        vscode.window.showWarningMessage('Дерево метаданных не загружено. Откройте конфигурацию.');
        return;
      }
      const format = await FormatDetector.detect(configPath);
      if (format !== ConfigFormat.Designer) {
        vscode.window.showInformationMessage('Создание форм поддерживается только для формата Designer.');
        return;
      }
      const siblingNames = (target.children || []).map((c) => c.name);
      const name = await vscode.window.showInputBox({
        prompt: 'Имя новой формы',
        placeHolder: 'Введите имя формы (латиница, кириллица, цифры, _)',
        validateInput: (value) => validateElementName(value.trim(), siblingNames) ?? undefined,
      });
      if (name === undefined || name.trim() === '') return;
      try {
        await doCreateForm(target, name.trim());
        vscode.window.showInformationMessage(`Создана форма: ${name.trim()}`);
        await loadMetadataTree();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  const duplicateElementCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.duplicateElement',
    async (node?: TreeNode) => {
      const target = getSelectedNode(node);
      if (!target || target.type === MetadataType.Configuration) {
        return;
      }
      const configPath = treeDataProvider?.getConfigPathForNode(target) ?? treeDataProvider?.getConfigPath();
      if (!configPath) {
        vscode.window.showWarningMessage('Дерево метаданных не загружено.');
        return;
      }
      const format = await FormatDetector.detect(configPath);
      if (format !== ConfigFormat.Designer) {
        vscode.window.showInformationMessage('Операции с элементами поддерживаются только для формата Designer.');
        return;
      }
      const parent = target.parent;
      const siblingNames = parent ? (parent.children || []).map((c) => c.name) : [];
      const newName = await vscode.window.showInputBox({
        value: `${target.name}Copy`,
        prompt: 'Имя дубликата',
        validateInput: (value) => validateElementName(value.trim(), siblingNames) ?? undefined,
      });
      if (newName === undefined || newName.trim() === '') return;
      try {
        await doDuplicateElement(target, newName.trim());
        vscode.window.showInformationMessage(`Дублирован элемент: ${newName.trim()}`);
        await loadMetadataTree();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  const deleteElementCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.deleteElement',
    async (node?: TreeNode) => {
      const target = getSelectedNode(node);
      if (!target || target.type === MetadataType.Configuration) {
        return;
      }
      const configPath = treeDataProvider?.getConfigPathForNode(target) ?? treeDataProvider?.getConfigPath();
      if (!configPath) {
        vscode.window.showWarningMessage('Дерево метаданных не загружено.');
        return;
      }
      const format = await FormatDetector.detect(configPath);
      if (format !== ConfigFormat.Designer) {
        vscode.window.showInformationMessage('Операции с элементами поддерживаются только для формата Designer.');
        return;
      }
      // For Ext node or child of Ext, count references to the parent metadata object
      const effectiveNode =
        target.type === MetadataType.Extension
          ? target.parent
          : target.parent?.type === MetadataType.Extension
            ? target.parent.parent
            : target;
      const refs =
        effectiveNode && effectiveNode.type !== MetadataType.Configuration
          ? await findReferencesToElement(configPath, effectiveNode.name, effectiveNode.type)
          : [];
      const refMsg =
        refs.length > 0
          ? ` Найдено ссылок: ${refs.length} (файлов: ${new Set(refs.map((r) => r.filePath)).size}). Удаление может нарушить конфигурацию.`
          : '';
      const choice = await vscode.window.showWarningMessage(
        `Удалить элемент «${target.name}»?${refMsg}`,
        { modal: true },
        'Удалить',
        'Отмена'
      );
      if (choice !== 'Удалить') return;
      try {
        await doDeleteElement(target);
        vscode.window.showInformationMessage(`Удалён элемент: ${target.name}`);
        await loadMetadataTree();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  const renameElementCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.renameElement',
    async (node?: TreeNode) => {
      const target = getSelectedNode(node);
      if (!target || target.type === MetadataType.Configuration) {
        return;
      }
      const configPath = treeDataProvider?.getConfigPathForNode(target) ?? treeDataProvider?.getConfigPath();
      if (!configPath) {
        vscode.window.showWarningMessage('Дерево метаданных не загружено.');
        return;
      }
      const format = await FormatDetector.detect(configPath);
      if (format !== ConfigFormat.Designer) {
        vscode.window.showInformationMessage('Операции с элементами поддерживаются только для формата Designer.');
        return;
      }
      const parent = target.parent;
      const siblingNames = parent ? (parent.children || []).map((c) => c.name).filter((n) => n !== target.name) : [];
      const newName = await vscode.window.showInputBox({
        value: target.name,
        prompt: 'Новое имя',
        validateInput: (value) => validateElementName(value.trim(), siblingNames) ?? undefined,
      });
      if (newName === undefined || newName.trim() === '' || newName.trim() === target.name) return;
      try {
        await doRenameElement(target, newName.trim(), configPath);
        vscode.window.showInformationMessage(`Переименован в: ${newName.trim()}`);
        await loadMetadataTree();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(msg);
      }
    }
  );

  const copyPathOrNameCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.copyPathOrName',
    async (node?: TreeNode) => {
      const target = getSelectedNode(node);
      if (!target) {
        vscode.window.showWarningMessage('Select an element in the metadata tree first.');
        return;
      }
      const text = target.filePath || target.name;
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(`Copied: ${text}`, 2000);
    }
  );

  const focusSearchCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.focusSearch',
    async () => {
      if (!treeDataProvider) return;
      const history = treeDataProvider.getSearchHistory();
      const current = treeDataProvider.getSearchQuery();
      let query = current;
      if (history.length > 0) {
        const pick = await vscode.window.showQuickPick(
          [
            { label: '$(add) Новый поиск…', value: '' },
            ...history.map((h) => ({ label: h, value: h })),
          ],
          { placeHolder: 'Поиск по названиям (и синониму)', matchOnDescription: false }
        );
        if (pick === undefined) return;
        query = pick.value;
        if (query === '') {
          const input = await vscode.window.showInputBox({
            value: current,
            prompt: 'Поиск по названиям (и синониму)',
            placeHolder: 'Введите строку или выберите из истории',
          });
          if (input === undefined) return;
          query = input;
        }
      } else {
        const input = await vscode.window.showInputBox({
          value: current,
          prompt: 'Поиск по названиям (и синониму)',
          placeHolder: 'Введите строку',
        });
        if (input === undefined) return;
        query = input;
      }
      treeDataProvider.setSearchQuery(query);
      if (query.trim()) treeDataProvider.addSearchToHistory(query);
    }
  );

  const clearSearchCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.clearSearch',
    () => {
      treeDataProvider?.clearSearch();
    }
  );

  const clearCacheCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.clearCache',
    async () => {
      if (extensionContext?.globalStoragePath) {
        await clearTreeCache(extensionContext.globalStoragePath);
        vscode.window.showInformationMessage('1C Metadata Tree: cache cleared.');
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
      if (!uri) return;
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

  const filterByTypeCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.filterByType',
    async () => {
      if (!treeDataProvider) return;
      const items = MetadataTreeDataProvider.getFilterableTypeLabels().map(({ type, label }) => ({
        label,
        type,
        picked: (() => {
          const current = treeDataProvider!.getTypeFilter();
          return current != null && current.includes(type);
        })(),
      }));
      const picks = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Выберите типы метаданных для отображения',
      });
      if (picks === undefined) return;
      treeDataProvider.setTypeFilter(picks.length > 0 ? picks.map((p) => p.type) : null);
    }
  );

  const nextMatchCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.nextMatch',
    () => {
      if (!treeDataProvider || !treeView) return;
      const ids = treeDataProvider.getVisibleOrderedNodeIds();
      if (ids.length === 0) return;
      const sel = treeView.selection[0];
      const currentId = sel?.id;
      const idx = currentId ? ids.indexOf(currentId) : -1;
      const nextIdx = idx < ids.length - 1 ? idx + 1 : 0;
      const nextId = ids[nextIdx];
      const node = treeDataProvider.findNodeById(nextId);
      if (node) {
        treeView.reveal(node, { select: true, focus: true });
      }
    }
  );

  const previousMatchCommand = vscode.commands.registerCommand(
    '1c-metadata-tree.previousMatch',
    () => {
      if (!treeDataProvider || !treeView) return;
      const ids = treeDataProvider.getVisibleOrderedNodeIds();
      if (ids.length === 0) return;
      const sel = treeView.selection[0];
      const currentId = sel?.id;
      const idx = currentId ? ids.indexOf(currentId) : -1;
      const prevIdx = idx > 0 ? idx - 1 : ids.length - 1;
      const prevId = ids[prevIdx];
      const node = treeDataProvider.findNodeById(prevId);
      if (node) {
        treeView.reveal(node, { select: true, focus: true });
      }
    }
  );

  context.subscriptions.push(
    openPanelCommand,
    focusTreeCommand,
    getTreeReadyForTestCommand,
    refreshCommand,
    showPropertiesCommand,
    openXMLCommand,
    openFormEditorCommand,
    openRightsEditorCommand,
    createElementCommand,
    createFormCommand,
    duplicateElementCommand,
    deleteElementCommand,
    renameElementCommand,
    copyPathOrNameCommand,
    focusSearchCommand,
    clearSearchCommand,
    clearCacheCommand,
    exportLogsCommand,
    filterByTypeCommand,
    nextMatchCommand,
    previousMatchCommand
  );

  // Handle tree view selection to show properties or rights editor
  treeView.onDidChangeSelection(async (e) => {
    if (e.selection.length > 0) {
      const selectedNode = e.selection[0];
      Logger.debug(`Tree selection changed: ${selectedNode.name}`);
      
      // For Role nodes, open rights editor instead of properties panel
      if (selectedNode.type === MetadataType.Role && selectedNode.filePath) {
        await vscode.commands.executeCommand('1c-metadata-tree.openRightsEditor', selectedNode);
      } else if (propertiesProvider) {
        // For all other nodes, show properties panel
        await vscode.commands.executeCommand('1c-metadata-tree.showProperties', selectedNode);
      }
    }
  });

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
      `1C Metadata Tree: Failed to activate extension. ${errorMessage}`,
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
 * Load metadata tree from workspace (all configurations in all workspace folders).
 */
async function loadMetadataTree(): Promise<void> {
  if (!treeDataProvider) {
    Logger.error(MESSAGES.ERROR_PROVIDER_NOT_INITIALIZED);
    return;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage(MESSAGES.NO_WORKSPACE);
    treeDataProvider.setRootNodes([], undefined);
    return;
  }

  const workspacePaths = folders.map((f) => f.uri.fsPath);
  const configs = await FormatDetector.findAllConfigurationRoots(workspacePaths);
  if (configs.length === 0) {
    vscode.window.showWarningMessage(MESSAGES.NO_CONFIGURATION);
    treeDataProvider.setRootNodes([], undefined);
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

        const storagePath = extensionContext?.globalStoragePath ?? '';
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
          const relativePath = getWorkspaceRelativePath(workspaceFolderPath, configRoot);
          const uniqueId = `config:${path.normalize(configRoot).replace(/\\/g, '_')}`;
          rootNode.id = uniqueId;
          rootNode.name =
            relativePath && relativePath !== '.' ? `Configuration (~/${relativePath})` : 'Configuration';
          roots.push(rootNode);
          const format = await FormatDetector.detect(configRoot);
          loadContextMap.set(uniqueId, { configPath: configRoot, format });
          progress.report({ increment: (100 * (i + 1)) / configs.length });
        }

        const provider = treeDataProvider!;
        if (roots.length === 1) {
          provider.setRootNode(roots[0], loadContextMap.get(roots[0].id));
        } else {
          provider.setRootNodes(roots, loadContextMap);
        }

        for (const w of metadataWatchers) {
          w.dispose();
        }
        metadataWatchers = [];
        const onReload = () => {
          loadMetadataTree().catch((err) => Logger.error('Error during watcher-triggered reload', err));
        };
        const onFileChanged = (changedPath: string) => {
          propertiesProvider?.notifyFileChangedExternally(changedPath);
        };
        for (const { configPath: configRoot } of configs) {
          const watcher = new MetadataWatcherService();
          watcher.start(configRoot, { onTreeReload: onReload, onFileChanged });
          metadataWatchers.push(watcher);
          extensionContext?.subscriptions.push(watcher);
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
  for (const w of metadataWatchers) {
    w.dispose();
  }
  metadataWatchers = [];
  Logger.info(MESSAGES.EXTENSION_DEACTIVATED);
}
