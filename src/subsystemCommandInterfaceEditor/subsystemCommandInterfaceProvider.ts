import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { TreeNode } from '../models/treeNode';
import { parseCommandInterface, serializeCommandInterface } from '../parsers/commandInterfaceParser';
import { getConfigurationMutationEngine } from '../services/configurationSession/ConfigurationMutationEngine';
import { hashContent } from '../services/configurationSession/atomicFileStorage';
import { projectMutationFailure, unwrapMutationReceipt } from '../services/configurationSession/mutationReceiptError';
import type { CommandInterfaceModel, CommandVisibilityEntry } from '../types/commandInterface';
import { MESSAGES } from '../constants/messages';
import { Logger } from '../utils/logger';
import { escapeJsonForScript } from '../utils/escapeJsonForScript';
import { createNonce } from '../utils/webviewSecurity';
import { EditorSessionCoordinator } from '../services/editorSession/editorSessionCoordinator';

type CiWebviewMessage =
  | { type: 'save'; visibility: CommandVisibilityEntry[]; filePath?: string; generation?: number };

export class SubsystemCommandInterfaceProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private readonly sessions = new EditorSessionCoordinator<{ filePath: string; nodeName: string }>();
  private currentFilePath: string | undefined;
  private currentModel: CommandInterfaceModel | undefined;
  private sessionExpectedHash: string | undefined;

  get sessionGeneration(): number {
    return this.sessions.generation;
  }

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

    const session = this.sessions.begin({
      panel: this.panel,
      target: { filePath: ciFilePath, nodeName: node.name },
    });
    const generation = session.generation;
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
    session.panel = this.panel;

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
    const session = this.sessions.currentSession;
    if (!session || !session.isCurrent() || !this.currentFilePath || !this.currentModel) { return; }
    if (requestFilePath !== undefined && requestFilePath !== this.currentFilePath) {
      Logger.warn(
        `Discarding stale command interface save request: target path '${requestFilePath}' does not match active path '${this.currentFilePath}'`
      );
      return;
    }
    if (requestGeneration !== undefined && requestGeneration !== session.generation) {
      Logger.warn(
        `Discarding stale command interface save request: target generation ${requestGeneration} does not match active generation ${session.generation}`
      );
      return;
    }

    const snapshot = session.snapshot();
    const targetFilePath = this.currentFilePath;
    const targetGeneration = snapshot.generation;
    const snapshotExpectedHash = this.sessionExpectedHash;
    const snapshotModel: CommandInterfaceModel = {
      ...this.currentModel,
      visibility: [...this.currentModel.visibility],
      placement: [...this.currentModel.placement],
      commandsOrder: [...this.currentModel.commandsOrder],
      subsystemsOrder: [...this.currentModel.subsystemsOrder],
      groupsOrder: [...this.currentModel.groupsOrder],
    };

    await session.runGuardedSave(snapshot, async () => {
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

        let failureMessage: string | undefined;
        if (receipt.status === 'conflict') {
          if (receipt.code === 'STALE_TARGET_REVISION') {
            failureMessage = 'Конфликт сохранения: файл интерфейса подсистемы был изменен другим процессом.';
          } else {
            failureMessage = `Конфликт сохранения интерфейса подсистемы: ${receipt.message}`;
          }
        } else if (receipt.status !== 'committed') {
          failureMessage = `Ошибка записи CommandInterface.xml: ${receipt.message}`;
        }
        const savedModel = unwrapMutationReceipt(receipt, failureMessage);

        if (session.isCurrent(snapshot)) {
          this.sessionExpectedHash = receipt.newRevision;
          this.currentModel = savedModel;
          session.postMessage({
            type: 'saveSuccess',
            filePath: targetFilePath,
            generation: targetGeneration,
          });
        }
      } catch (err) {
        Logger.error('Failed to save CommandInterface.xml', err);
        if (session.isCurrent(snapshot)) {
          const failureProjection = projectMutationFailure(err);
          session.postMessage({
            type: 'saveError',
            filePath: targetFilePath,
            generation: targetGeneration,
            ...(failureProjection ?? { message: MESSAGES.SUBSYSTEM_COMMAND_INTERFACE_WRITE_FAILED }),
          });
        }
        throw err;
      }
    });
  }

  dispose(): void {
    this.sessions.dispose();
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }
}
