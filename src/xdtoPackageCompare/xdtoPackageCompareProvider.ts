import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { TreeNode } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { escapeJsonForScript } from '../utils/escapeJsonForScript';
import { getNodeNamespace, ensureXdtoPackageSourceFile } from '../xdtoPackageEditor/xdtoPackageFiles';
import { resolveXdtoPackageSchemaPath } from '../xdtoPackageEditor/xdtoPackagePaths';
import { serializeAndValidateXdtoModelForSave } from '../xdtoPackageEditor/xdtoPackageEditorProvider';
import type { XdtoPackageModel } from '../types/xdtoPackage';
import {
  applyXdtoPackageMerge,
  buildXdtoPackageCompareTree,
  parseXdtoComparableSource,
} from './xdtoPackageCompareModel';

type XdtoPackageCompareMessage = {
  type: 'merge';
  selectedIds: string[];
};

interface XdtoPackageComparePayload {
  title: string;
  leftTitle: string;
  rightTitle: string;
  schemaPath: string;
  sourcePath: string;
  tree: ReturnType<typeof buildXdtoPackageCompareTree>['root'];
  stats: ReturnType<typeof buildXdtoPackageCompareTree>['stats'];
}

interface XdtoPackageCompareSession {
  panel: vscode.WebviewPanel;
  schemaPath: string;
  sourcePath: string;
  packageName: string;
  leftModel: XdtoPackageModel;
  rightModel: XdtoPackageModel;
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

function isValidMessage(message: unknown): message is XdtoPackageCompareMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const record = message as Record<string, unknown>;
  return record['type'] === 'merge'
    && Array.isArray(record['selectedIds'])
    && record['selectedIds'].every((item) => typeof item === 'string');
}

function resolveWebviewHtmlPath(context: vscode.ExtensionContext): string {
  const primary = path.join(__dirname, 'xdtoPackageCompareWebview.html');
  if (fs.existsSync(primary)) {
    return primary;
  }
  const fallback = path.join(context.extensionPath, 'dist', 'xdtoPackageCompare', 'xdtoPackageCompareWebview.html');
  return fs.existsSync(fallback) ? fallback : primary;
}

async function pickComparableFile(): Promise<vscode.Uri | undefined> {
  const vscodeApi = await getVscode();
  const picked = await vscodeApi.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      'XDTO/XSD/XML/BIN': ['xsd', 'xdto', 'xml', 'bin'],
      'Все файлы': ['*'],
    },
    title: 'Выберите файл для сравнения с XDTO-пакетом',
  });
  return picked?.[0];
}

function buildPayload(session: XdtoPackageCompareSession): XdtoPackageComparePayload {
  const compare = buildXdtoPackageCompareTree(session.leftModel, session.rightModel);
  return {
    title: `Сравнение XDTO-пакета: ${session.packageName}`,
    leftTitle: 'В конфигурации',
    rightTitle: path.basename(session.sourcePath),
    schemaPath: session.schemaPath,
    sourcePath: session.sourcePath,
    tree: compare.root,
    stats: compare.stats,
  };
}

function render(context: vscode.ExtensionContext, session: XdtoPackageCompareSession): void {
  const htmlPath = resolveWebviewHtmlPath(context);
  const nonce = createNonce();
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(
    '// __XDTO_COMPARE_DATA_PLACEHOLDER__',
    `window.__xdtoCompareData = ${escapeJsonForScript(JSON.stringify(buildPayload(session)))};`
  );
  html = html.replace(/\$\{nonce\}/g, nonce);
  session.panel.webview.html = html;
}

async function handleMerge(session: XdtoPackageCompareSession, message: XdtoPackageCompareMessage): Promise<void> {
  try {
    const nextModel = applyXdtoPackageMerge(session.leftModel, session.rightModel, message.selectedIds);
    const result = serializeAndValidateXdtoModelForSave(nextModel);
    if (!result.ok) {
      void session.panel.webview.postMessage({ type: 'mergeError', message: result.message });
      return;
    }
    fs.writeFileSync(session.schemaPath, result.source, 'utf8');
    session.leftModel = result.model;
    void session.panel.webview.postMessage({ type: 'mergeSuccess', payload: buildPayload(session) });
  } catch (err) {
    Logger.error('Failed to merge XDTO package comparison', err);
    void session.panel.webview.postMessage({
      type: 'mergeError',
      message: `Ошибка объединения XDTO-пакета: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export async function showXdtoPackageCompare(context: vscode.ExtensionContext, node: TreeNode): Promise<void> {
  const vscodeApi = await getVscode();
  if (!node.filePath) {
    void vscodeApi.window.showErrorMessage('CDT 41: у XDTO-пакета нет файла метаданных.');
    return;
  }

  const picked = await pickComparableFile();
  if (!picked) {
    return;
  }

  try {
    const schemaPath = resolveXdtoPackageSchemaPath(node.filePath, node.name);
    const leftSource = ensureXdtoPackageSourceFile(node, schemaPath);
    const leftModel = parseXdtoComparableSource(schemaPath, leftSource, getNodeNamespace(node));
    const rightSource = fs.readFileSync(picked.fsPath, 'utf8');
    const rightModel = parseXdtoComparableSource(
      picked.fsPath,
      rightSource,
      leftModel.targetNamespace ?? getNodeNamespace(node)
    );
    const panel = vscodeApi.window.createWebviewPanel(
      'xdtoPackageCompare',
      `Сравнение XDTO: ${node.name}`,
      vscodeApi.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      }
    );
    const session: XdtoPackageCompareSession = {
      panel,
      schemaPath,
      sourcePath: picked.fsPath,
      packageName: node.name,
      leftModel,
      rightModel,
    };
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isValidMessage(message)) {
        return;
      }
      void handleMerge(session, message);
    });
    render(context, session);
  } catch (err) {
    Logger.error('Failed to open XDTO package compare view', err);
    void vscodeApi.window.showErrorMessage(
      `CDT 41: ошибка сравнения XDTO-пакета: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
