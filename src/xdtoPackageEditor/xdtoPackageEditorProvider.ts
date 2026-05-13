import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { TreeNode } from '../models/treeNode';
import { parseXdtoPackage } from '../parsers/xdtoPackageParser';
import type { XdtoPackageModel } from '../types/xdtoPackage';
import { MESSAGES } from '../constants/messages';
import { Logger } from '../utils/logger';
import { escapeJsonForScript } from '../utils/escapeJsonForScript';
import { resolveXdtoPackageSchemaPath } from './xdtoPackagePaths';
import { ensureXdtoPackageSourceFile } from './xdtoPackageFiles';
import { serializeXdtoPackageModel } from './xdtoPackageSerializer';

type XdtoWebviewMessage =
  | { type: 'save'; source: string }
  | { type: 'saveModel'; model: XdtoPackageModel };

type XdtoSaveValidationResult =
  | { ok: true; source: string; model: XdtoPackageModel }
  | { ok: false; message: string };

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

async function getVscode(): Promise<typeof vscode> {
  return await import('vscode');
}

export function parseAndValidateXdtoSourceForSave(source: string): XdtoSaveValidationResult {
  const model = parseXdtoPackage(source);
  const blocking = model.diagnostics.find((d) => d.severity === 'error');
  if (blocking) {
    return { ok: false, message: blocking.message };
  }
  return { ok: true, source, model };
}

export function serializeAndValidateXdtoModelForSave(model: XdtoPackageModel): XdtoSaveValidationResult {
  try {
    return parseAndValidateXdtoSourceForSave(serializeXdtoPackageModel(model));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
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
    if (m['type'] === 'save') {
      return typeof m['source'] === 'string';
    }
    return m['type'] === 'saveModel' && !!m['model'] && typeof m['model'] === 'object';
  }

  async show(node: TreeNode): Promise<void> {
    const vscodeApi = await getVscode();
    if (!node.filePath) {
      void vscodeApi.window.showErrorMessage(MESSAGES.XDTO_PACKAGE_NO_METADATA_FILE);
      return;
    }

    const schemaPath = resolveXdtoPackageSchemaPath(node.filePath, node.name);
    let source: string;
    try {
      source = ensureXdtoPackageSourceFile(node, schemaPath);
    } catch (err) {
      Logger.error('Failed to read or create XDTO package file', err);
      void vscodeApi.window.showErrorMessage(MESSAGES.XDTO_PACKAGE_READ_FAILED);
      return;
    }

    const model = parseXdtoPackage(source);
    this.currentSchemaPath = schemaPath;

    const title = `${MESSAGES.XDTO_PACKAGE_TITLE}: ${node.name}`;
    if (this.panel) {
      this.panel.reveal(vscodeApi.ViewColumn.Beside);
      this.panel.title = title;
    } else {
      this.panel = vscodeApi.window.createWebviewPanel(
        'xdtoPackageEditor',
        title,
        vscodeApi.ViewColumn.Beside,
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
      await this.handleSave(parseAndValidateXdtoSourceForSave(msg.source));
      return;
    }
    await this.handleSave(serializeAndValidateXdtoModelForSave(msg.model));
  }

  private async handleSave(result: XdtoSaveValidationResult): Promise<void> {
    if (this.saveInProgress || !this.currentSchemaPath || !this.panel) { return; }
    this.saveInProgress = true;
    try {
      if (!result.ok) {
        this.postMessage({
          type: 'saveError',
          message: `${MESSAGES.XDTO_PACKAGE_VALIDATION_FAILED}: ${result.message}`,
        });
        return;
      }
      fs.writeFileSync(this.currentSchemaPath, result.source, 'utf8');
      this.postMessage({ type: 'saveSuccess', model: result.model, source: result.source });
    } catch (err) {
      Logger.error('Failed to save XDTO package file', err);
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
