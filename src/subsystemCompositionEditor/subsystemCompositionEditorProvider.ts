import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { TreeNode } from '../models/treeNode';
import type { MetadataTreeDataProvider } from '../providers/treeDataProvider';
import type {
  CompositionWebviewMessage,
  CompositionHostMessage,
  CompositionInitPayload,
} from './compositionTypes';
import { collectCompositionEligibleObjects } from './compositionObjectCollector';
import {
  readSubsystemCompositionRefsFromFile,
  applySubsystemCompositionFileUpdate,
} from '../services/subsystemCompositionFileUpdater';
import { Logger } from '../utils/logger';
import { escapeJsonForScript } from '../utils/escapeJsonForScript';

export class SubsystemCompositionEditorProvider implements vscode.Disposable {
  private static readonly VALID_COMMANDS = new Set(['toggle', 'save', 'cancel', 'selectAll', 'deselectAll']);

  private panel: vscode.WebviewPanel | undefined;
  private subsystemFilePath: string | undefined;
  private configPath: string | null = null;
  private initialChecked = new Set<string>();
  private currentChecked = new Set<string>();
  private saveInProgress = false;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: {
      loadMetadataTree: () => Promise<void>;
      invalidateTreeCacheOnly: (configPath: string) => Promise<void>;
    }
  ) {}

  /**
   * Resolve path to subsystemCompositionWebview.html.
   * Primary: next to the compiled JS (__dirname).
   * Fallback: extensionPath-based path for VSIX production layout.
   */
  private resolveWebviewHtmlPath(): string {
    const primary = path.join(__dirname, 'subsystemCompositionWebview.html');
    if (fs.existsSync(primary)) {
      return primary;
    }
    const fallback = path.join(
      this.context.extensionPath,
      'dist',
      'subsystemCompositionEditor',
      'subsystemCompositionWebview.html'
    );
    if (fs.existsSync(fallback)) {
      return fallback;
    }
    Logger.warn(`subsystemCompositionWebview.html not found; falling back to ${primary}`);
    return primary;
  }

  private isValidMessage(msg: unknown): msg is CompositionWebviewMessage {
    if (!msg || typeof msg !== 'object') { return false; }
    const m = msg as Record<string, unknown>;
    if (typeof m.command !== 'string' || !SubsystemCompositionEditorProvider.VALID_COMMANDS.has(m.command)) { return false; }
    if (m.command === 'toggle') {
      const data = m.data as Record<string, unknown> | undefined;
      return !!data && typeof data.ref === 'string' && typeof data.checked === 'boolean';
    }
    if (m.command === 'selectAll' || m.command === 'deselectAll') {
      const data = m.data as Record<string, unknown> | undefined;
      return !!data && Array.isArray(data.refs);
    }
    return true; // save, cancel have no data
  }

  /**
   * Open the subsystem composition editor for a given subsystem node.
   */
  public async show(
    subsystemNode: TreeNode,
    treeProvider: MetadataTreeDataProvider,
    configPath: string | null
  ): Promise<void> {
    if (!subsystemNode.filePath) {
      void vscode.window.showErrorMessage('Не удалось открыть редактор: путь к файлу подсистемы не найден.');
      return;
    }

    try {
      const currentRefs = await readSubsystemCompositionRefsFromFile(subsystemNode.filePath);

      // Eager load all type folders so collector sees actual objects, not empty lazy containers
      for (const root of treeProvider.getRootNodes()) {
        await treeProvider.eagerLoadAllTypeFolders(root);
      }

      const allObjects = collectCompositionEligibleObjects(
        treeProvider.getRootNodes(),
        subsystemNode,
        configPath
      );

      this.subsystemFilePath = subsystemNode.filePath;
      this.configPath = configPath;
      this.initialChecked = new Set(currentRefs);
      this.currentChecked = new Set(currentRefs);

      if (this.panel) {
        this.panel.reveal(vscode.ViewColumn.Beside);
        this.panel.title = `Состав: ${subsystemNode.name}`;
      } else {
        this.panel = vscode.window.createWebviewPanel(
          '1c-subsystem-composition',
          `Состав: ${subsystemNode.name}`,
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
            this.subsystemFilePath = undefined;
            this.configPath = null;
            this.initialChecked.clear();
            this.currentChecked.clear();
            this.saveInProgress = false;
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
        subsystemName: subsystemNode.name,
        objects: allObjects,
        checkedRefs: currentRefs,
        totalCount: allObjects.length,
      };

      const htmlPath = this.resolveWebviewHtmlPath();
      let html = fs.readFileSync(htmlPath, 'utf8');

      html = html.replace(
        '// __COMPOSITION_DATA_PLACEHOLDER__',
        `window.__compositionData = ${escapeJsonForScript(JSON.stringify(payload))};`
      );

      this.panel.webview.html = html;
    } catch (err) {
      Logger.error('Failed to open subsystem composition editor', err);
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
    }
  }

  private handleToggle(ref: string, checked: boolean): void {
    if (checked) {
      this.currentChecked.add(ref);
    } else {
      this.currentChecked.delete(ref);
    }
  }

  private async handleSave(): Promise<void> {
    if (this.saveInProgress || !this.subsystemFilePath) {
      return;
    }
    this.saveInProgress = true;
    try {
      const toAdd = [...this.currentChecked].filter(r => !this.initialChecked.has(r));
      const toRemove = [...this.initialChecked].filter(r => !this.currentChecked.has(r));

      if (toAdd.length === 0 && toRemove.length === 0) {
        this.panel?.dispose();
        return;
      }

      const result = await applySubsystemCompositionFileUpdate(this.subsystemFilePath, {
        add: toAdd,
        remove: toRemove,
      });

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
      Logger.error('Failed to save subsystem composition', err);
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
   * Returns the number of unsaved changes (added + removed refs).
   */
  getDirtyCount(): number {
    const added = [...this.currentChecked].filter(r => !this.initialChecked.has(r)).length;
    const removed = [...this.initialChecked].filter(r => !this.currentChecked.has(r)).length;
    return added + removed;
  }

  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
