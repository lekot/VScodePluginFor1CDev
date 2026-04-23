import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { TreeNode } from '../models/treeNode';
import { parseCommandInterface, serializeCommandInterface } from '../parsers/commandInterfaceParser';
import type { CommandInterfaceModel, CommandVisibilityEntry } from '../types/commandInterface';
import { MESSAGES } from '../constants/messages';
import { Logger } from '../utils/logger';
import { escapeJsonForScript } from '../utils/escapeJsonForScript';

type CiWebviewMessage =
  | { type: 'save'; visibility: CommandVisibilityEntry[] };

export class SubsystemCommandInterfaceProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private saveInProgress = false;
  private currentFilePath: string | undefined;
  private currentModel: CommandInterfaceModel | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private resolveWebviewHtmlPath(): string {
    const primary = path.join(__dirname, 'subsystemCommandInterfaceWebview.html');
    if (fs.existsSync(primary)) { return primary; }
    const fallback = path.join(
      this.context.extensionPath,
      'dist',
      'subsystemCommandInterfaceEditor',
      'subsystemCommandInterfaceWebview.html'
    );
    return fs.existsSync(fallback) ? fallback : primary;
  }

  private isValidMessage(msg: unknown): msg is CiWebviewMessage {
    if (!msg || typeof msg !== 'object') { return false; }
    const m = msg as Record<string, unknown>;
    if (m['type'] === 'save' && Array.isArray(m['visibility'])) { return true; }
    return false;
  }

  async show(node: TreeNode, ciFilePath: string): Promise<void> {
    let xmlText: string;
    try {
      xmlText = fs.readFileSync(ciFilePath, 'utf8');
    } catch (err) {
      Logger.error('Failed to read CommandInterface.xml', err);
      void vscode.window.showErrorMessage(MESSAGES.SUBSYSTEM_COMMAND_INTERFACE_READ_FAILED);
      return;
    }

    let model: CommandInterfaceModel;
    try {
      model = parseCommandInterface(xmlText);
    } catch (err) {
      Logger.error('Failed to parse CommandInterface.xml', err);
      void vscode.window.showErrorMessage(MESSAGES.SUBSYSTEM_COMMAND_INTERFACE_READ_FAILED);
      return;
    }

    this.currentFilePath = ciFilePath;
    this.currentModel = model;

    const title = `${MESSAGES.SUBSYSTEM_COMMAND_INTERFACE_TITLE}: ${node.name}`;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.panel.title = title;
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'subsystemCommandInterface',
        title,
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
          this.currentFilePath = undefined;
          this.currentModel = undefined;
          this.saveInProgress = false;
        },
        null,
        this.disposables
      );

      this.panel.webview.onDidReceiveMessage(
        (message: unknown) => {
          if (!this.isValidMessage(message)) { return; }
          void this.handleMessage(message);
        },
        null,
        this.disposables
      );
    }

    const payload = {
      model,
      subsystemName: node.name,
      strings: {
        title: MESSAGES.SUBSYSTEM_COMMAND_INTERFACE_TITLE,
        saved: MESSAGES.SUBSYSTEM_COMMAND_INTERFACE_SAVED,
      },
    };

    const htmlPath = this.resolveWebviewHtmlPath();
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(
      '// __CI_DATA_PLACEHOLDER__',
      `window.__ciData = ${escapeJsonForScript(JSON.stringify(payload))};`
    );
    this.panel.webview.html = html;
  }

  private async handleMessage(msg: CiWebviewMessage): Promise<void> {
    if (msg.type === 'save') {
      await this.handleSave(msg.visibility);
    }
  }

  private async handleSave(newVisibility: CommandVisibilityEntry[]): Promise<void> {
    if (this.saveInProgress || !this.currentFilePath || !this.currentModel) { return; }
    this.saveInProgress = true;
    try {
      const updatedModel: CommandInterfaceModel = {
        ...this.currentModel,
        visibility: newVisibility,
      };
      const xml = serializeCommandInterface(updatedModel);
      fs.writeFileSync(this.currentFilePath, xml, 'utf8');
      this.currentModel = updatedModel;
      this.postMessage({ type: 'saveSuccess' });
    } catch (err) {
      Logger.error('Failed to save CommandInterface.xml', err);
      this.postMessage({
        type: 'saveError',
        message: MESSAGES.SUBSYSTEM_COMMAND_INTERFACE_WRITE_FAILED,
      });
    } finally {
      this.saveInProgress = false;
    }
  }

  private postMessage(msg: Record<string, unknown>): void {
    void this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }
}
