import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { TreeNode } from '../models/treeNode';
import { parseCommandInterface, serializeCommandInterface } from '../parsers/commandInterfaceParser';
import { getConfigurationMutationEngine } from '../services/configurationSession/ConfigurationMutationEngine';
import { hashContent } from '../services/configurationSession/atomicFileStorage';
import type { CommandInterfaceModel, CommandVisibilityEntry } from '../types/commandInterface';
import { MESSAGES } from '../constants/messages';
import { Logger } from '../utils/logger';
import { escapeJsonForScript } from '../utils/escapeJsonForScript';
import { createNonce } from '../utils/webviewSecurity';

type CiWebviewMessage =
  | { type: 'save'; visibility: CommandVisibilityEntry[]; filePath?: string; generation?: number };

export class SubsystemCommandInterfaceProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private saveInProgress = false;
  private currentFilePath: string | undefined;
  private currentModel: CommandInterfaceModel | undefined;
  private sessionGeneration = 0;
  private sessionExpectedHash: string | undefined;

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

    const generation = ++this.sessionGeneration;
    this.currentFilePath = ciFilePath;
    this.currentModel = model;
    this.sessionExpectedHash = hashContent(xmlText);

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
          this.sessionExpectedHash = undefined;
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
      filePath: ciFilePath,
      generation,
      strings: {
        title: MESSAGES.SUBSYSTEM_COMMAND_INTERFACE_TITLE,
        saved: MESSAGES.SUBSYSTEM_COMMAND_INTERFACE_SAVED,
      },
    };

    const htmlPath = this.resolveWebviewHtmlPath();
    let html = fs.readFileSync(htmlPath, 'utf8');
    const nonce = createNonce();
    html = html.replace(/\$\{nonce\}/g, nonce);
    html = html.replace(
      '// __CI_DATA_PLACEHOLDER__',
      `window.__ciData = ${escapeJsonForScript(JSON.stringify(payload))};`
    );
    this.panel.webview.html = html;
  }

  private async handleMessage(msg: CiWebviewMessage): Promise<void> {
    if (msg.type === 'save') {
      await this.handleSave(msg.visibility, msg.filePath, msg.generation);
    }
  }

  private async handleSave(
    newVisibility: CommandVisibilityEntry[],
    requestFilePath?: string,
    requestGeneration?: number
  ): Promise<void> {
    if (this.saveInProgress || !this.currentFilePath || !this.currentModel) { return; }
    if (requestFilePath !== undefined && requestFilePath !== this.currentFilePath) {
      Logger.warn(
        `Discarding stale command interface save request: target path '${requestFilePath}' does not match active path '${this.currentFilePath}'`
      );
      return;
    }
    if (requestGeneration !== undefined && requestGeneration !== this.sessionGeneration) {
      Logger.warn(
        `Discarding stale command interface save request: target generation ${requestGeneration} does not match active generation ${this.sessionGeneration}`
      );
      return;
    }

    this.saveInProgress = true;
    const targetFilePath = this.currentFilePath;
    const targetGeneration = this.sessionGeneration;
    const snapshotExpectedHash = this.sessionExpectedHash;
    const snapshotModel: CommandInterfaceModel = {
      ...this.currentModel,
      visibility: [...this.currentModel.visibility],
      placement: [...this.currentModel.placement],
      commandsOrder: [...this.currentModel.commandsOrder],
      subsystemsOrder: [...this.currentModel.subsystemsOrder],
      groupsOrder: [...this.currentModel.groupsOrder],
    };
    try {
      const mutationEngine = getConfigurationMutationEngine();
      const receipt = await mutationEngine.transformFile(
        targetFilePath,
        {
          kind: 'subsystemCommandInterface.save',
          resourcePath: targetFilePath,
          expectedRevision: snapshotExpectedHash,
          session: { id: targetFilePath, generation: targetGeneration },
        },
        async () => {
          const updatedModel: CommandInterfaceModel = {
            ...snapshotModel,
            visibility: newVisibility,
          };
          const xml = serializeCommandInterface(updatedModel);
          return { content: xml, result: updatedModel };
        },
      );

      if (receipt.status === 'conflict') {
        if (receipt.code === 'STALE_TARGET_REVISION') {
          throw new Error('Конфликт сохранения: файл интерфейса подсистемы был изменен другим процессом.');
        }
        throw new Error(`Конфликт сохранения интерфейса подсистемы: ${receipt.message}`);
      }
      if (receipt.status !== 'committed') {
        throw new Error(`Ошибка записи CommandInterface.xml: ${receipt.message}`);
      }

      if (this.currentFilePath === targetFilePath && this.sessionGeneration === targetGeneration) {
        this.sessionExpectedHash = receipt.newRevision;
        this.currentModel = receipt.result;
      }

      if (this.currentFilePath === targetFilePath && this.sessionGeneration === targetGeneration) {
        this.postMessage({
          type: 'saveSuccess',
          filePath: targetFilePath,
          generation: targetGeneration,
        });
      }
    } catch (err) {
      Logger.error('Failed to save CommandInterface.xml', err);
      if (this.currentFilePath === targetFilePath && this.sessionGeneration === targetGeneration) {
        this.postMessage({
          type: 'saveError',
          filePath: targetFilePath,
          generation: targetGeneration,
          message: MESSAGES.SUBSYSTEM_COMMAND_INTERFACE_WRITE_FAILED,
        });
      }
      throw err;
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
