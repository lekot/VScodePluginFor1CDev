import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ExtensionState } from '../state/extensionState';
import { QueryPackage } from './sdbl/sdblAst';
import { parseSdbl } from './sdbl/sdblParser';
import { extractBslQuery } from './editor/bslQueryExtractor';
import { QueryMetadataProvider } from './metadata/queryMetadataProvider';
import { QueryMetadataNode } from './metadata/queryMetadataTypes';
import {
  QueryBuilderMessageHandler,
  QueryBuilderMessageContext,
} from './queryBuilderMessageHandler';
import { Logger } from '../utils/logger';

export class QueryBuilderProvider {
  private panel: vscode.WebviewPanel | undefined;
  private messageHandler: QueryBuilderMessageHandler | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: ExtensionState
  ) {}

  public async open(
    editor?: vscode.TextEditor,
    mode: 'simple' | 'withProcessing' = 'simple'
  ): Promise<vscode.WebviewPanel | undefined> {
    const targetEditor = editor ?? vscode.window.activeTextEditor;

    if (!targetEditor) {
      void vscode.window.showWarningMessage(
        'Откройте модуль 1С или файл запроса для запуска конструктора.'
      );
      return undefined;
    }

    const documentText = targetEditor.document.getText();
    const cursorOffset = targetEditor.document.offsetAt(targetEditor.selection.active);
    const selectionRange = targetEditor.selection.isEmpty
      ? undefined
      : {
          start: targetEditor.document.offsetAt(targetEditor.selection.start),
          end: targetEditor.document.offsetAt(targetEditor.selection.end),
        };

    const extracted = extractBslQuery(documentText, cursorOffset, selectionRange);

    let ast: QueryPackage;
    if (extracted.isNewQuery || !extracted.sdblText || extracted.sdblText.trim().length === 0) {
      ast = {
        queries: [
          {
            type: 'Select',
            fields: [],
            from: [],
          },
        ],
      };
    } else {
      try {
        ast = parseSdbl(extracted.sdblText);
      } catch (err) {
        Logger.warn('Failed to parse extracted SDBL query, starting with empty query', err);
        ast = {
          queries: [
            {
              type: 'Select',
              fields: [],
              from: [],
            },
          ],
        };
      }
    }

    const metadataProvider = new QueryMetadataProvider();
    let metadata: QueryMetadataNode[] = [];
    try {
      metadata = await metadataProvider.buildTreeFromProvider(
        this.state?.treeDataProvider ?? null
      );
    } catch (err) {
      Logger.warn('Failed to build metadata tree for query builder', err);
      metadata = metadataProvider.getMetadataCategories();
    }

    const title = 'Конструктор запроса' + (extracted.isNewQuery ? ' (новый)' : '');

    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      const localResourceRoots: vscode.Uri[] = [];
      if (this.context.extensionUri) {
        localResourceRoots.push(this.context.extensionUri);
      }

      this.panel = vscode.window.createWebviewPanel(
        '1c-query-builder',
        title,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots,
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.messageHandler = undefined;
      });
    }

    const messageContext: QueryBuilderMessageContext = {
      panel: this.panel,
      editor: targetEditor,
      ast,
      metadata,
      mode,
      replaceRange: extracted.replaceRange,
      variableName: extracted.variableName,
      metadataProvider,
      treeProvider: this.state?.treeDataProvider ?? null,
    };

    this.messageHandler = new QueryBuilderMessageHandler(messageContext);

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.messageHandler?.handleMessage(message);
    });

    this.panel.webview.html = this.getHtmlContent();

    return this.panel;
  }

  private resolveWebviewHtmlPath(): string {
    const primary = path.join(__dirname, 'ui', 'queryBuilderWebview.html');
    if (fs.existsSync(primary)) {
      return primary;
    }

    const direct = path.join(__dirname, 'queryBuilderWebview.html');
    if (fs.existsSync(direct)) {
      return direct;
    }

    const extPath = this.context.extensionPath || this.context.extensionUri?.fsPath;
    if (extPath) {
      const dist = path.join(extPath, 'dist', 'queryBuilder', 'ui', 'queryBuilderWebview.html');
      if (fs.existsSync(dist)) {
        return dist;
      }
      const src = path.join(extPath, 'src', 'queryBuilder', 'ui', 'queryBuilderWebview.html');
      if (fs.existsSync(src)) {
        return src;
      }
    }

    const repoSrc = path.resolve(__dirname, '../../src/queryBuilder/ui/queryBuilderWebview.html');
    if (fs.existsSync(repoSrc)) {
      return repoSrc;
    }

    return primary;
  }

  private getHtmlContent(): string {
    const htmlPath = this.resolveWebviewHtmlPath();
    if (fs.existsSync(htmlPath)) {
      return fs.readFileSync(htmlPath, 'utf8');
    }
    return '<!DOCTYPE html><html><body><h3>Не удалось загрузить queryBuilderWebview.html</h3></body></html>';
  }
}