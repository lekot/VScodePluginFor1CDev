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
  findCompositionTypeFolder,
  resolveVisibleRoots,
} from './compositionObjectCollector';
import { Logger } from '../utils/logger';
import { escapeJsonForScript } from '../utils/escapeJsonForScript';
import { renderSecureWebviewHtml } from '../utils/webviewSecurity';
import { runConfigurationMutation } from '../services/configurationSession/configurationMutationGateway';
import { EditorSessionCoordinator } from '../services/editorSession/editorSessionCoordinator';

interface CompositionSessionModel {
  readonly targetPath: string;
  readonly configPath: string | null;
  readonly panel: vscode.WebviewPanel;
  readonly panelTitle: string;
  readonly saveOwnership: symbol;
  readonly strategy: CompositionStrategy;
  readonly treeProvider: MetadataTreeDataProvider;
  readonly node: TreeNode;
  readonly containers: readonly CompositionTypeContainer[];
  readonly excludedNodeIds: ReadonlySet<string>;
  readonly initialChecked: ReadonlySet<string>;
  readonly currentChecked: ReadonlySet<string>;
  readonly initialItemSettings: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly currentItemSettings: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly loadedObjects: ReadonlyMap<string, readonly CompositionObjectEntry[]>;
}

interface CompositionSessionSnapshot extends CompositionSessionModel {
  readonly generation: number;
}

function cloneSettingsMap(
  settings: ReadonlyMap<string, Readonly<Record<string, string>>>,
): Map<string, Record<string, string>> {
  return new Map([...settings].map(([ref, values]) => [ref, { ...values }]));
}

function withOwnSetting(
  settings: Readonly<Record<string, string>> | undefined,
  key: string,
  value: string,
): Record<string, string> {
  return Object.fromEntries([
    ...Object.entries(settings ?? {}),
    [key, value],
  ]);
}

function cloneContentDiff(diff: ContentUpdateDiff): ContentUpdateDiff {
  return {
    add: [...diff.add],
    remove: [...diff.remove],
    settingsChanged: cloneSettingsMap(diff.settingsChanged),
  };
}

export class CompositionEditorProvider implements vscode.Disposable {
  private static readonly VALID_COMMANDS = new Set(['toggle', 'save', 'cancel', 'selectAll', 'deselectAll', 'expand', 'expandAll', 'settingChange']);

  private panel: vscode.WebviewPanel | undefined;
  private contentFilePath: string | undefined;
  private configPath: string | null = null;
  private readonly sessions = new EditorSessionCoordinator<{ contentFilePath: string; configPath: string | null; node: TreeNode }>();

  get sessionGeneration(): number {
    return this.sessions.generation;
  }
  private activeSessionGeneration: number | undefined;
  private activeSaveOwnership: symbol | undefined;
  private recoveryModel: CompositionSessionModel | undefined;
  private initialChecked = new Set<string>();
  private currentChecked = new Set<string>();
  private savingSessions = new Set<symbol>();
  private loadedObjects = new Map<string, CompositionObjectEntry[]>();
  private containers: CompositionTypeContainer[] = [];
  private treeProvider: MetadataTreeDataProvider | undefined;
  private node: TreeNode | undefined;
  private loadingTypes = new Map<string, symbol>();
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
    const publishedModel = this.capturePublishedModel();
    if (publishedModel) {
      this.recoveryModel = publishedModel;
    }
    const session = this.sessions.begin({
      panel: this.panel,
      target: {
        contentFilePath: this.strategy.getContentFilePath(node) ?? '',
        configPath,
        node,
      },
    });
    const generation = session.generation;
    this.activeSessionGeneration = undefined;

    try {
      const contentFilePath = this.strategy.getContentFilePath(node);
      if (!contentFilePath) {
        if (this.isLatestShow(generation)) {
          this.restoreLastPublishedModel(generation);
          void vscode.window.showErrorMessage('Не удалось открыть редактор: путь к файлу не найден.');
        }
        return;
      }

      const { refs: currentRefs, itemSettings } = await this.strategy.readContent(contentFilePath);
      if (!this.isLatestShow(generation)) { return; }

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

      const payload: CompositionInitPayload = {
        titlePrefix: this.strategy.titlePrefix,
        entityName: node.name,
        containers,
        checkedRefs: currentRefs,
        itemSettingsSchema: this.strategy.itemSettingsSchema,
        itemSettings: Object.fromEntries(itemSettings),
      };

      const htmlPath = this.resolveWebviewHtmlPath();
      const template = fs.readFileSync(htmlPath, 'utf8');
      const payloadJson = escapeJsonForScript(JSON.stringify(payload));
      const html = renderSecureWebviewHtml(template, {
        csp: { allowUnsafeInlineStyles: true },
        substitutions: {
          '// __COMPOSITION_DATA_PLACEHOLDER__':
            `window.__compositionData = JSON.parse(${JSON.stringify(payloadJson)});`,
        },
      });

      if (!this.isLatestShow(generation)) { return; }

      let panel = this.panel;
      if (!panel) {
        const createdPanel = vscode.window.createWebviewPanel(
          this.strategy.panelTypeId,
          `${this.strategy.titlePrefix}: ${node.name}`,
          vscode.ViewColumn.Beside,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [this.context.extensionUri],
          }
        );
        panel = createdPanel;
        this.panel = createdPanel;

        createdPanel.onDidDispose(
          () => this.handlePanelDisposed(createdPanel),
          null,
          this.disposables
        );

        createdPanel.webview.onDidReceiveMessage(
          async (message: unknown) => {
            if (this.panel !== createdPanel || !this.isValidMessage(message)) { return; }
            await this.handleMessage(message, createdPanel);
          },
          null,
          this.disposables
        );
      } else {
        panel.title = `${this.strategy.titlePrefix}: ${node.name}`;
        panel.reveal(vscode.ViewColumn.Beside);
      }
      panel.webview.html = html;
      session.panel = panel;

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
      this.initialItemSettings = cloneSettingsMap(itemSettings);
      this.currentItemSettings = cloneSettingsMap(itemSettings);
      this.activeSaveOwnership = Symbol(`composition-save-${generation}`);
      this.recoveryModel = undefined;
      this.activeSessionGeneration = generation;
    } catch (err) {
      if (!this.isLatestShow(generation)) { return; }
      Logger.error('Failed to open composition editor', err);
      this.restoreLastPublishedModel(generation);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Ошибка открытия редактора состава: ${message}`);
    }
  }

  /**
   * Handle messages from the webview.
   */
  public async handleMessage(
    msg: CompositionWebviewMessage,
    sourcePanel?: vscode.WebviewPanel,
  ): Promise<void> {
    const session = this.captureSessionSnapshot();
    if (!session) {
      this.handlePendingRecoveryMessage(msg, sourcePanel);
      return;
    }
    if ((sourcePanel && session.panel !== sourcePanel) || !this.isCurrentSession(session)) { return; }

    switch (msg.command) {
      case 'toggle':
        this.handleToggle(msg.data.ref, msg.data.checked);
        break;
      case 'save':
        await this.handleSave(session);
        break;
      case 'cancel':
        session.panel.dispose();
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
        await this.handleExpand(msg.data.typeFolderId, session);
        break;
      case 'expandAll':
        await this.handleExpandAll(session);
        break;
      case 'settingChange':
        this.handleSettingChange(msg.data.ref, msg.data.key, msg.data.value);
        break;
    }
  }

  private handlePendingRecoveryMessage(msg: CompositionWebviewMessage, sourcePanel?: vscode.WebviewPanel): void {
    const model = this.recoveryModel;
    if (
      !model ||
      this.activeSessionGeneration !== undefined ||
      this.panel !== model.panel ||
      (sourcePanel && sourcePanel !== model.panel)
    ) {
      return;
    }

    if (msg.command === 'cancel') {
      model.panel.dispose();
      return;
    }

    const currentChecked = new Set(model.currentChecked);
    switch (msg.command) {
      case 'toggle':
        if (msg.data.checked) { currentChecked.add(msg.data.ref); }
        else { currentChecked.delete(msg.data.ref); }
        break;
      case 'selectAll':
        for (const ref of msg.data.refs) { currentChecked.add(ref); }
        break;
      case 'deselectAll':
        for (const ref of msg.data.refs) { currentChecked.delete(ref); }
        break;
      case 'settingChange': {
        const currentItemSettings = cloneSettingsMap(model.currentItemSettings);
        const settings = withOwnSetting(currentItemSettings.get(msg.data.ref), msg.data.key, msg.data.value);
        currentItemSettings.set(msg.data.ref, settings);
        this.currentItemSettings = cloneSettingsMap(currentItemSettings);
        this.recoveryModel = { ...model, currentItemSettings };
        return;
      }
      default:
        return;
    }

    this.currentChecked = currentChecked;
    this.recoveryModel = { ...model, currentChecked: new Set(currentChecked) };
  }

  private handleToggle(ref: string, checked: boolean): void {
    if (checked) {
      this.currentChecked.add(ref);
    } else {
      this.currentChecked.delete(ref);
    }
  }

  private handleSettingChange(ref: string, key: string, value: string): void {
    this.currentItemSettings.set(ref, withOwnSetting(this.currentItemSettings.get(ref), key, value));
  }

  private async handleExpand(typeFolderId: string, session: CompositionSessionSnapshot): Promise<void> {
    if (!this.isCurrentSession(session)) { return; }

    // Return from cache if already loaded
    if (this.loadedObjects.has(typeFolderId)) {
      const payload: ObjectsLoadedPayload = {
        typeFolderId,
        objects: this.loadedObjects.get(typeFolderId)!,
      };
      this.postMessageForSession(session, { command: 'objectsLoaded', data: payload });
      return;
    }
    // Guard: already loading
    if (this.loadingTypes.has(typeFolderId)) { return; }
    const loadingToken = Symbol(typeFolderId);
    this.loadingTypes.set(typeFolderId, loadingToken);

    try {
      // Same visible roots as collectObjectsForType (multi-root order must not pick another config's folder)
      const roots = session.treeProvider.getRootNodes();
      const typeFolder = findCompositionTypeFolder(roots, session.configPath, typeFolderId);

      if (typeFolder && (!typeFolder.children || typeFolder.children.length === 0)) {
        // Standard lazy load via getChildren
        await session.treeProvider.getChildren(typeFolder);
        if (!this.isCurrentSession(session)) { return; }
      }

      const objects = collectObjectsForType(
        roots,
        session.configPath,
        typeFolderId,
        session.excludedNodeIds,
        session.strategy.eligibleTypes,
        session.strategy.showNestedSubsystems,
      );

      const container = session.containers.find(c => c.typeFolderId === typeFolderId);
      const orphans = container
        ? buildOrphanEntries(session.initialChecked, container.metadataType, objects)
        : [];
      const combined = [...objects, ...orphans];

      if (!this.isCurrentSession(session)) { return; }
      this.loadedObjects.set(typeFolderId, combined);
      const payload: ObjectsLoadedPayload = { typeFolderId, objects: combined };
      this.postMessageForSession(session, { command: 'objectsLoaded', data: payload });
    } finally {
      if (this.loadingTypes.get(typeFolderId) === loadingToken) {
        this.loadingTypes.delete(typeFolderId);
      }
    }
  }

  private async handleExpandAll(session: CompositionSessionSnapshot): Promise<void> {
    if (!this.isCurrentSession(session)) { return; }

    const roots = session.treeProvider.getRootNodes();
    const visibleRoots = resolveVisibleRoots(roots, session.configPath);
    const result: Record<string, CompositionObjectEntry[]> = {};

    // Add already loaded from cache
    for (const [id, objects] of this.loadedObjects) {
      result[id] = objects;
    }

    // For each visible root — sequentially (prevent race conditions on tree mutation)
    for (const root of visibleRoots) {
      if (!this.isCurrentSession(session)) { return; }
      if (!root.children) { continue; }
      for (const typeFolder of root.children) {
        if (!this.isCurrentSession(session)) { return; }
        if (this.loadedObjects.has(typeFolder.id)) { continue; }
        if (this.loadingTypes.has(typeFolder.id)) { continue; }

        const loadingToken = Symbol(typeFolder.id);
        this.loadingTypes.set(typeFolder.id, loadingToken);
        try {
          if (!typeFolder.children || typeFolder.children.length === 0) {
            await session.treeProvider.getChildren(typeFolder);
            if (!this.isCurrentSession(session)) { return; }
          }
          const objects = collectObjectsForType(
            roots,
            session.configPath,
            typeFolder.id,
            session.excludedNodeIds,
            session.strategy.eligibleTypes,
            session.strategy.showNestedSubsystems,
          );
          const container = session.containers.find(c => c.typeFolderId === typeFolder.id);
          const orphans = container
            ? buildOrphanEntries(session.initialChecked, container.metadataType, objects)
            : [];
          const combined = [...objects, ...orphans];
          if (!this.isCurrentSession(session)) { return; }
          this.loadedObjects.set(typeFolder.id, combined);
          result[typeFolder.id] = combined;
        } finally {
          if (this.loadingTypes.get(typeFolder.id) === loadingToken) {
            this.loadingTypes.delete(typeFolder.id);
          }
        }
      }
    }

    if (!this.isCurrentSession(session)) { return; }
    const payload: AllObjectsLoadedPayload = { containers: result };
    this.postMessageForSession(session, { command: 'allObjectsLoaded', data: payload });
  }

  public async handleSave(currentSession?: CompositionSessionSnapshot): Promise<void> {
    const session = currentSession ?? this.captureSessionSnapshot();
    if (!session || !this.isCurrentSession(session) || this.savingSessions.has(session.saveOwnership)) { return; }
    this.savingSessions.add(session.saveOwnership);

    try {
      const toAdd = [...session.currentChecked].filter(r => !session.initialChecked.has(r));
      const toRemove = [...session.initialChecked].filter(r => !session.currentChecked.has(r));

      const settingsChanged = new Map<string, Record<string, string>>();
      for (const [ref, current] of session.currentItemSettings) {
        const initial = session.initialItemSettings.get(ref) ?? {};
        const changed = Object.fromEntries(Object.entries(current).filter(([key, value]) =>
          !Object.prototype.hasOwnProperty.call(initial, key) || initial[key] !== value,
        )) as Record<string, string>;
        if (Object.keys(changed).length > 0) { settingsChanged.set(ref, changed); }
      }

      if (toAdd.length === 0 && toRemove.length === 0 && settingsChanged.size === 0) {
        if (this.isCurrentSession(session)) {
          session.panel.dispose();
        }
        return;
      }

      const diff = cloneContentDiff({
        add: toAdd,
        remove: toRemove,
        settingsChanged,
      });

      const result = await runConfigurationMutation(
        session.targetPath,
        'ui.composition.save',
        () => session.strategy.applyUpdate(session.targetPath, cloneContentDiff(diff)),
      );

      // A resolved writer has committed its mutation, even when it reports rejected refs.
      await this.reconcileCommittedWrite(session);

      if (result.rejected.length > 0) {
        const msg = result.rejected.map(r => `${r.ref} (${r.reason})`).join('; ');
        this.postMessageForSession(session, { command: 'saveError', data: { message: `Отклонённые ссылки: ${msg}` } });
        return;
      }

      this.postMessageForSession(session, { command: 'saveSuccess' });
      if (this.isCurrentSession(session)) {
        session.panel.dispose();
      }
    } catch (err) {
      Logger.error('Failed to save composition', err);
      this.postMessageForSession(session, {
        command: 'saveError',
        data: { message: `Ошибка сохранения: ${err instanceof Error ? err.message : String(err)}` },
      });
    } finally {
      this.savingSessions.delete(session.saveOwnership);
      const currentSession = this.captureSessionSnapshot();
      if (
        currentSession &&
        currentSession.saveOwnership === session.saveOwnership &&
        currentSession.targetPath === session.targetPath &&
        currentSession.configPath === session.configPath &&
        currentSession.panel === session.panel
      ) {
        this.postMessageForSession(currentSession, {
          command: 'sessionState',
          data: { saving: this.savingSessions.has(currentSession.saveOwnership), resetLoading: false },
        });
      }
    }
  }

  private async reconcileCommittedWrite(session: CompositionSessionSnapshot): Promise<void> {
    if (!session.configPath) { return; }
    try {
      await this.deps.invalidateTreeCacheOnly(session.configPath);
      await this.deps.loadMetadataTree();
    } catch (err) {
      Logger.error('Composition was saved but metadata tree refresh failed', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showWarningMessage(`Состав сохранён, но не удалось обновить дерево метаданных: ${message}`);
    }
  }

  private postMessageForSession(session: CompositionSessionSnapshot, msg: CompositionHostMessage): void {
    if (!this.isCurrentSession(session)) { return; }
    void session.panel.webview.postMessage(msg);
  }

  private isLatestShow(generation: number): boolean {
    return this.sessionGeneration === generation;
  }

  private isCurrentSession(session: CompositionSessionSnapshot): boolean {
    return this.sessionGeneration === session.generation &&
      this.activeSessionGeneration === session.generation &&
      this.panel === session.panel &&
      this.contentFilePath === session.targetPath &&
      this.configPath === session.configPath;
  }

  private captureSessionSnapshot(): CompositionSessionSnapshot | undefined {
    const model = this.capturePublishedModel();
    if (!model || this.activeSessionGeneration === undefined) { return undefined; }
    return {
      ...model,
      generation: this.activeSessionGeneration,
    };
  }

  private capturePublishedModel(): CompositionSessionModel | undefined {
    if (
      !this.panel ||
      !this.contentFilePath ||
      !this.treeProvider ||
      !this.node ||
      this.activeSaveOwnership === undefined ||
      this.activeSessionGeneration === undefined ||
      this.activeSessionGeneration !== this.sessionGeneration
    ) {
      return undefined;
    }

    return {
      targetPath: this.contentFilePath,
      configPath: this.configPath,
      panel: this.panel,
      panelTitle: this.panel.title,
      saveOwnership: this.activeSaveOwnership,
      strategy: this.strategy,
      treeProvider: this.treeProvider,
      node: this.node,
      containers: this.containers.map((container) => ({ ...container })),
      excludedNodeIds: new Set(this.excludedNodeIds),
      initialChecked: new Set(this.initialChecked),
      currentChecked: new Set(this.currentChecked),
      initialItemSettings: cloneSettingsMap(this.initialItemSettings),
      currentItemSettings: cloneSettingsMap(this.currentItemSettings),
      loadedObjects: new Map([...this.loadedObjects].map(([id, objects]) => [id, objects.map(object => ({ ...object }))])),
    };
  }

  private restoreLastPublishedModel(generation: number): void {
    const model = this.recoveryModel;
    if (!model || !this.isLatestShow(generation) || this.panel !== model.panel) { return; }

    this.contentFilePath = model.targetPath;
    this.configPath = model.configPath;
    this.treeProvider = model.treeProvider;
    this.node = model.node;
    this.containers = model.containers.map(container => ({ ...container }));
    this.excludedNodeIds = new Set(model.excludedNodeIds);
    this.initialChecked = new Set(model.initialChecked);
    this.currentChecked = new Set(model.currentChecked);
    this.initialItemSettings = cloneSettingsMap(model.initialItemSettings);
    this.currentItemSettings = cloneSettingsMap(model.currentItemSettings);
    this.loadedObjects = new Map([...model.loadedObjects].map(([id, objects]) => [id, objects.map(object => ({ ...object }))]));
    this.loadingTypes.clear();
    this.activeSaveOwnership = model.saveOwnership;
    if (model.panel.title !== model.panelTitle) {
      model.panel.title = model.panelTitle;
    }
    this.activeSessionGeneration = generation;
    this.recoveryModel = undefined;
    const restoredSession = this.captureSessionSnapshot();
    if (restoredSession) {
      this.postMessageForSession(restoredSession, {
        command: 'sessionState',
        data: { saving: this.savingSessions.has(model.saveOwnership), resetLoading: true },
      });
    }
  }

  private handlePanelDisposed(panel: vscode.WebviewPanel): void {
    if (this.panel !== panel) { return; }
    this.sessions.bumpGeneration();
    this.activeSessionGeneration = undefined;
    this.activeSaveOwnership = undefined;
    this.recoveryModel = undefined;
    this.panel = undefined;
    this.clearActiveSession();
  }

  private clearActiveSession(): void {
    this.contentFilePath = undefined;
    this.configPath = null;
    this.activeSaveOwnership = undefined;
    this.recoveryModel = undefined;
    this.initialChecked.clear();
    this.currentChecked.clear();
    this.loadedObjects.clear();
    this.loadingTypes.clear();
    this.containers = [];
    this.treeProvider = undefined;
    this.node = undefined;
    this.excludedNodeIds.clear();
    this.initialItemSettings.clear();
    this.currentItemSettings.clear();
  }

  /**
   * Returns the number of unsaved changes (added + removed refs + changed settings).
   */
  getDirtyCount(): number {
    const added = [...this.currentChecked].filter(r => !this.initialChecked.has(r)).length;
    const removed = [...this.initialChecked].filter(r => !this.currentChecked.has(r)).length;

    let settingsChangedCount = 0;
    for (const [ref, current] of this.currentItemSettings) {
      const initial = this.initialItemSettings.get(ref) ?? {};
      for (const [k, v] of Object.entries(current)) {
        if (initial[k] !== v) { settingsChangedCount++; break; }
      }
    }

    return added + removed + settingsChangedCount;
  }

  dispose(): void {
    this.sessions.dispose();
    this.activeSessionGeneration = undefined;
    this.activeSaveOwnership = undefined;
    this.recoveryModel = undefined;
    const panel = this.panel;
    this.panel = undefined;
    panel?.dispose();
    this.clearActiveSession();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
