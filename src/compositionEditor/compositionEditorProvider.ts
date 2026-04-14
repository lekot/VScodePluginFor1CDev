import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { TreeNode } from '../models/treeNode';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import type {
  CompositionWebviewMessage,
  CompositionHostMessage,
  CompositionInitPayload,
  CompositionObjectEntry,
  CompositionTypeContainer,
  ObjectsLoadedPayload,
  AllObjectsLoadedPayload,
  CompositionStrategy,
  ContentUpdateDiff,
} from './compositionContracts';
import {
  collectTypeFolders,
  collectObjectsForType,
  buildOrphanEntries,
} from './compositionObjectCollector';
import { Logger } from '../utils/logger';
import { escapeJsonForScript } from '../utils/escapeJsonForScript';

export class CompositionEditorProvider implements vscode.Disposable {
  private static readonly VALID_COMMANDS = new Set(['toggle', 'save', 'cancel', 'selectAll', 'deselectAll', 'expand', 'expandAll', 'settingChange']);

  private panel: vscode.WebviewPanel | undefined;
  private contentFilePath: string | undefined;
  private configPath: string | null = null;
  private initialChecked = new Set<string>();
  private currentChecked = new Set<string>();
  private saveInProgress = false;
  private loadedObjects = new Map<string, CompositionObjectEntry[]>();
  private containers: CompositionTypeContainer[] = [];
  private treeProvider: MetadataTreeDataProvider | undefined;
  private node: TreeNode | undefined;
  private loadingTypes = new Set<string>();
  private excludedNodeIds = new Set<string>();
  private initialItemSettings = new Map<string, Record<string, string>>();
  private currentItemSettings = new Map<string, Record<string, string>>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: {
      loadMetadataTree: () => Promise<void>;
      invalidateTreeCacheOnly: (configPath: string) => Promise<void>;
    },
    private readonly strategy: CompositionStrategy
  ) {}

  /**
   * Resolve path to compositionWebview.html.
   * Primary: next to the compiled JS (__dirname).
   * Fallback: extensionPath-based path for VSIX production layout.
   */
  private resolveWebviewHtmlPath(): string {
    const primary = path.join(__dirname, 'compositionWebview.html');
    if (fs.existsSync(primary)) {
      return primary;
    }
    const fallback = path.join(
      this.context.extensionPath,
      'dist',
      'compositionEditor',
      'compositionWebview.html'
    );
    if (fs.existsSync(fallback)) {
      return fallback;
    }
    Logger.warn(`compositionWebview.html not found; falling back to ${primary}`);
    return primary;
  }

  private isValidMessage(msg: unknown): msg is CompositionWebviewMessage {
    if (!msg || typeof msg !== 'object') { return false; }
    const m = msg as Record<string, unknown>;
    if (typeof m.command !== 'string' || !CompositionEditorProvider.VALID_COMMANDS.has(m.command)) { return false; }
    if (m.command === 'toggle') {
      const data = m.data as Record<string, unknown> | undefined;
      return !!data && typeof data.ref === 'string' && typeof data.checked === 'boolean';
    }
    if (m.command === 'selectAll' || m.command === 'deselectAll') {
      const data = m.data as Record<string, unknown> | undefined;
      return !!data && Array.isArray(data.refs);
    }
    if (m.command === 'expand') {
      const data = m.data as Record<string, unknown> | undefined;
      return !!data && typeof data.typeFolderId === 'string';
    }
    if (m.command === 'settingChange') {
      const data = m.data as Record<string, unknown> | undefined;
      return !!data && typeof data.ref === 'string' && typeof data.key === 'string' && typeof data.value === 'string';
    }
    return true; // save, cancel, expandAll have no data
  }

  /**
   * Open the composition editor for a given node.
   */
  public async show(
    node: TreeNode,
    treeProvider: MetadataTreeDataProvider,
    configPath: string | null
  ): Promise<void> {
    const contentFilePath = this.strategy.getContentFilePath(node);
    if (!contentFilePath) {
      void vscode.window.showErrorMessage('Не удалось открыть редактор: путь к файлу не найден.');
      return;
    }

    try {
      const { refs: currentRefs, itemSettings } = await this.strategy.readContent(contentFilePath);
      const checkedSet = new Set(currentRefs);

      const excludedNodeIds = this.strategy.getExcludedNodeIds?.(node, treeProvider.getRootNodes()) ?? new Set<string>();

      // Lazy: collect type-folder containers without loading their children
      const containers: CompositionTypeContainer[] = collectTypeFolders(
        treeProvider.getRootNodes(),
        node,
        configPath,
        checkedSet,
        this.strategy.eligibleTypes,
        this.strategy.showNestedSubsystems,
      );

      this.contentFilePath = contentFilePath;
      this.configPath = configPath;
      this.treeProvider = treeProvider;
      this.node = node;
      this.containers = containers;
      this.loadedObjects.clear();
      this.loadingTypes.clear();
      this.excludedNodeIds = excludedNodeIds;
      this.initialChecked = new Set(currentRefs);
      this.currentChecked = new Set(currentRefs);
      this.initialItemSettings = new Map(itemSettings);
      this.currentItemSettings = new Map(
        [...itemSettings.entries()].map(([k, v]) => [k, { ...v }])
      );

      if (this.panel) {
        this.panel.reveal(vscode.ViewColumn.Beside);
        this.panel.title = `${this.strategy.titlePrefix}: ${node.name}`;
      } else {
        this.panel = vscode.window.createWebviewPanel(
          this.strategy.panelTypeId,
          `${this.strategy.titlePrefix}: ${node.name}`,
          vscode.ViewColumn.Beside,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [this.context.extensionUri],
          }
        );

        this.panel.onDidDispose(
          () => {
            this.panel = undefined;
            this.contentFilePath = undefined;
            this.configPath = null;
            this.initialChecked.clear();
            this.currentChecked.clear();
            this.saveInProgress = false;
            this.loadedObjects.clear();
            this.loadingTypes.clear();
            this.containers = [];
            this.treeProvider = undefined;
            this.node = undefined;
            this.excludedNodeIds.clear();
            this.initialItemSettings.clear();
            this.currentItemSettings.clear();
          },
          null,
          this.disposables
        );

        this.panel.webview.onDidReceiveMessage(
          (message: unknown) => {
            if (!this.isValidMessage(message)) { return; }
            this.handleMessage(message);
          },
          null,
          this.disposables
        );
      }

      const payload: CompositionInitPayload = {
        titlePrefix: this.strategy.titlePrefix,
        entityName: node.name,
        containers,
        checkedRefs: currentRefs,
        itemSettingsSchema: this.strategy.itemSettingsSchema,
        itemSettings: Object.fromEntries(itemSettings),
      };

      const htmlPath = this.resolveWebviewHtmlPath();
      let html = fs.readFileSync(htmlPath, 'utf8');

      html = html.replace(
        '// __COMPOSITION_DATA_PLACEHOLDER__',
        `window.__compositionData = ${escapeJsonForScript(JSON.stringify(payload))};`
      );

      this.panel.webview.html = html;
    } catch (err) {
      Logger.error('Failed to open composition editor', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Ошибка открытия редактора состава: ${message}`);
    }
  }

  /**
   * Handle messages from the webview.
   */
  private handleMessage(msg: CompositionWebviewMessage): void {
    switch (msg.command) {
      case 'toggle':
        this.handleToggle(msg.data.ref, msg.data.checked);
        break;
      case 'save':
        void this.handleSave();
        break;
      case 'cancel':
        this.panel?.dispose();
        break;
      case 'selectAll':
        for (const ref of msg.data.refs) {
          this.currentChecked.add(ref);
        }
        break;
      case 'deselectAll':
        for (const ref of msg.data.refs) {
          this.currentChecked.delete(ref);
        }
        break;
      case 'expand':
        void this.handleExpand(msg.data.typeFolderId);
        break;
      case 'expandAll':
        void this.handleExpandAll();
        break;
      case 'settingChange':
        this.handleSettingChange(msg.data.ref, msg.data.key, msg.data.value);
        break;
    }
  }

  private handleToggle(ref: string, checked: boolean): void {
    if (checked) {
      this.currentChecked.add(ref);
    } else {
      this.currentChecked.delete(ref);
    }
  }

  private handleSettingChange(ref: string, key: string, value: string): void {
    let settings = this.currentItemSettings.get(ref);
    if (!settings) {
      settings = {};
      this.currentItemSettings.set(ref, settings);
    }
    settings[key] = value;
  }

  private async handleExpand(typeFolderId: string): Promise<void> {
    // Return from cache if already loaded
    if (this.loadedObjects.has(typeFolderId)) {
      const payload: ObjectsLoadedPayload = {
        typeFolderId,
        objects: this.loadedObjects.get(typeFolderId)!,
      };
      this.postMessage({ command: 'objectsLoaded', data: payload });
      return;
    }
    // Guard: already loading
    if (this.loadingTypes.has(typeFolderId)) { return; }
    this.loadingTypes.add(typeFolderId);

    try {
      if (!this.treeProvider || !this.node) { return; }

      // Find typeFolder in the tree and lazy-load children if needed
      const roots = this.treeProvider.getRootNodes();
      let typeFolder: TreeNode | undefined;
      for (const root of roots) {
        typeFolder = root.children?.find(c => c.id === typeFolderId);
        if (typeFolder) { break; }
      }

      if (typeFolder && (!typeFolder.children || typeFolder.children.length === 0)) {
        // Standard lazy load via getChildren
        await this.treeProvider.getChildren(typeFolder);
      }

      const objects = collectObjectsForType(
        roots,
        this.configPath,
        typeFolderId,
        this.excludedNodeIds,
        this.strategy.eligibleTypes,
        this.strategy.showNestedSubsystems,
      );

      const container = this.containers.find(c => c.typeFolderId === typeFolderId);
      const orphans = container
        ? buildOrphanEntries(this.initialChecked, container.metadataType, objects)
        : [];
      const combined = [...objects, ...orphans];

      this.loadedObjects.set(typeFolderId, combined);
      if (!this.panel) { return; } // panel disposed during loading
      const payload: ObjectsLoadedPayload = { typeFolderId, objects: combined };
      this.postMessage({ command: 'objectsLoaded', data: payload });
    } finally {
      this.loadingTypes.delete(typeFolderId);
    }
  }

  private async handleExpandAll(): Promise<void> {
    if (!this.treeProvider || !this.node) { return; }

    const roots = this.treeProvider.getRootNodes();
    const result: Record<string, CompositionObjectEntry[]> = {};

    // Add already loaded from cache
    for (const [id, objects] of this.loadedObjects) {
      result[id] = objects;
    }

    // For each root — sequentially (prevent race conditions on tree mutation)
    for (const root of roots) {
      if (!root.children) { continue; }
      for (const typeFolder of root.children) {
        if (this.loadedObjects.has(typeFolder.id)) { continue; }
        if (this.loadingTypes.has(typeFolder.id)) { continue; }

        this.loadingTypes.add(typeFolder.id);
        try {
          if (!typeFolder.children || typeFolder.children.length === 0) {
            await this.treeProvider.getChildren(typeFolder);
          }
          const objects = collectObjectsForType(
            roots,
            this.configPath,
            typeFolder.id,
            this.excludedNodeIds,
            this.strategy.eligibleTypes,
            this.strategy.showNestedSubsystems,
          );
          const container = this.containers.find(c => c.typeFolderId === typeFolder.id);
          const orphans = container
            ? buildOrphanEntries(this.initialChecked, container.metadataType, objects)
            : [];
          const combined = [...objects, ...orphans];
          this.loadedObjects.set(typeFolder.id, combined);
          result[typeFolder.id] = combined;
        } finally {
          this.loadingTypes.delete(typeFolder.id);
        }
      }
    }

    if (!this.panel) { return; }
    const payload: AllObjectsLoadedPayload = { containers: result };
    this.postMessage({ command: 'allObjectsLoaded', data: payload });
  }

  private async handleSave(): Promise<void> {
    if (this.saveInProgress || !this.contentFilePath) {
      return;
    }
    this.saveInProgress = true;
    try {
      const toAdd = [...this.currentChecked].filter(r => !this.initialChecked.has(r));
      const toRemove = [...this.initialChecked].filter(r => !this.currentChecked.has(r));

      const settingsChanged = new Map<string, Record<string, string>>();
      for (const [ref, current] of this.currentItemSettings) {
        const initial = this.initialItemSettings.get(ref);
        if (!initial) { continue; }
        const changed: Record<string, string> = {};
        let hasChange = false;
        for (const [k, v] of Object.entries(current)) {
          if (initial[k] !== v) { changed[k] = v; hasChange = true; }
        }
        if (hasChange) { settingsChanged.set(ref, changed); }
      }

      if (toAdd.length === 0 && toRemove.length === 0 && settingsChanged.size === 0) {
        this.panel?.dispose();
        return;
      }

      const diff: ContentUpdateDiff = {
        add: toAdd,
        remove: toRemove,
        settingsChanged,
      };

      const result = await this.strategy.applyUpdate(this.contentFilePath, diff);

      if (result.rejected.length > 0) {
        const msg = result.rejected.map(r => `${r.ref} (${r.reason})`).join('; ');
        this.postMessage({ command: 'saveError', data: { message: `Отклонённые ссылки: ${msg}` } });
        return;
      }

      if (this.configPath) {
        await this.deps.invalidateTreeCacheOnly(this.configPath);
        await this.deps.loadMetadataTree();
      }

      this.postMessage({ command: 'saveSuccess' });
      this.panel?.dispose();
    } catch (err) {
      Logger.error('Failed to save composition', err);
      this.postMessage({
        command: 'saveError',
        data: { message: `Ошибка сохранения: ${err instanceof Error ? err.message : String(err)}` },
      });
    } finally {
      this.saveInProgress = false;
    }
  }

  private postMessage(msg: CompositionHostMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  /**
   * Returns the number of unsaved changes (added + removed refs + changed settings).
   */
  getDirtyCount(): number {
    const added = [...this.currentChecked].filter(r => !this.initialChecked.has(r)).length;
    const removed = [...this.initialChecked].filter(r => !this.currentChecked.has(r)).length;

    let settingsChangedCount = 0;
    for (const [ref, current] of this.currentItemSettings) {
      const initial = this.initialItemSettings.get(ref);
      if (!initial) { continue; }
      for (const [k, v] of Object.entries(current)) {
        if (initial[k] !== v) { settingsChangedCount++; break; }
      }
    }

    return added + removed + settingsChangedCount;
  }

  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
    this.loadedObjects.clear();
    this.loadingTypes.clear();
    this.containers = [];
    this.treeProvider = undefined;
    this.node = undefined;
    this.excludedNodeIds.clear();
    this.initialItemSettings.clear();
    this.currentItemSettings.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
