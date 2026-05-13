import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TreeNode } from '../models/treeNode';
import { parseXdtoPackage } from '../parsers/xdtoPackageParser';
import type { XdtoPackageModel } from '../types/xdtoPackage';
import { MESSAGES } from '../constants/messages';
import { Logger } from '../utils/logger';
import { escapeJsonForScript } from '../utils/escapeJsonForScript';
import { resolveXdtoPackageSchemaPath } from './xdtoPackagePaths';
import { ensureXdtoPackageSourceFile } from './xdtoPackageFiles';

type XdtoWebviewMessage = { type: 'save'; source: string };

interface XdtoViewPayload {
  packageName: string;
  schemaPath: string;
  source: string;
  model: XdtoPackageModel;
  strings: {
    title: string;
    saved: string;
  };
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

export class XdtoPackageEditorProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private saveInProgress = false;
  private currentSchemaPath: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private resolveWebviewHtmlPath(): string {
    const primary = path.join(__dirname, 'xdtoPackageWebview.html');
    if (fs.existsSync(primary)) { return primary; }
    const fallback = path.join(
      this.context.extensionPath,
      'dist',
      'xdtoPackageEditor',
      'xdtoPackageWebview.html'
    );
    return fs.existsSync(fallback) ? fallback : primary;
  }

  private isValidMessage(msg: unknown): msg is XdtoWebviewMessage {
    if (!msg || typeof msg !== 'object') { return false; }
    const m = msg as Record<string, unknown>;
    return m['type'] === 'save' && typeof m['source'] === 'string';
  }

  async show(node: TreeNode): Promise<void> {
    if (!node.filePath) {
      void vscode.window.showErrorMessage(MESSAGES.XDTO_PACKAGE_NO_METADATA_FILE);
      return;
    }

    const schemaPath = resolveXdtoPackageSchemaPath(node.filePath, node.name);
    let source: string;
    try {
      source = ensureXdtoPackageSourceFile(node, schemaPath);
    } catch (err) {
      Logger.error('Failed to read or create Package.xdto', err);
      void vscode.window.showErrorMessage(MESSAGES.XDTO_PACKAGE_READ_FAILED);
      return;
    }

    const model = parseXdtoPackage(source);
    this.currentSchemaPath = schemaPath;

    const title = `${MESSAGES.XDTO_PACKAGE_TITLE}: ${node.name}`;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.panel.title = title;
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'xdtoPackageEditor',
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
          this.currentSchemaPath = undefined;
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

    this.render(node.name, schemaPath, source, model);
  }

  private render(packageName: string, schemaPath: string, source: string, model: XdtoPackageModel): void {
    const payload: XdtoViewPayload = {
      packageName,
      schemaPath,
      source,
      model,
      strings: {
        title: MESSAGES.XDTO_PACKAGE_TITLE,
        saved: MESSAGES.XDTO_PACKAGE_SAVED,
      },
    };

    const htmlPath = this.resolveWebviewHtmlPath();
    const nonce = createNonce();
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(
      '// __XDTO_DATA_PLACEHOLDER__',
      `window.__xdtoData = ${escapeJsonForScript(JSON.stringify(payload))};`
    );
    html = html.replace(/\$\{webview\.cspSource\}/g, this.panel?.webview.cspSource ?? '');
    html = html.replace(/\$\{nonce\}/g, nonce);
    if (this.panel) {
      this.panel.webview.html = html;
    }
  }

  private async handleMessage(msg: XdtoWebviewMessage): Promise<void> {
    if (msg.type === 'save') {
      await this.handleSave(msg.source);
    }
  }

  private async handleSave(source: string): Promise<void> {
    if (this.saveInProgress || !this.currentSchemaPath || !this.panel) { return; }
    this.saveInProgress = true;
    try {
      const model = parseXdtoPackage(source);
      const blocking = model.diagnostics.find((d) => d.severity === 'error');
      if (blocking) {
        this.postMessage({
          type: 'saveError',
          message: `${MESSAGES.XDTO_PACKAGE_VALIDATION_FAILED}: ${blocking.message}`,
        });
        return;
      }
      fs.writeFileSync(this.currentSchemaPath, source, 'utf8');
      this.postMessage({ type: 'saveSuccess', model });
    } catch (err) {
      Logger.error('Failed to save Package.xdto', err);
      this.postMessage({
        type: 'saveError',
        message: MESSAGES.XDTO_PACKAGE_WRITE_FAILED,
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
