import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ExtensionState } from '../state/extensionState';
import { QueryPackage } from './sdbl/sdblAst';
import { parseSdbl } from './sdbl/sdblParser';
import { extractBslQuery, offsetToPosition } from './editor/bslQueryExtractor';
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
  private messageSubscription?: vscode.Disposable;

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

    const doc = targetEditor.document;
    const documentText = doc.getText();
    const cursorOffset = doc.offsetAt(targetEditor.selection.active);
    const selectionRange = targetEditor.selection.isEmpty
      ? undefined
      : {
          start: doc.offsetAt(targetEditor.selection.start),
          end: doc.offsetAt(targetEditor.selection.end),
        };

    const fileName = doc.fileName || doc.uri?.fsPath || doc.uri?.path || '';
    const isSdblDocument =
      doc.languageId === 'sdbl' || /\.(sdbl|query)$/i.test(fileName);

    let extracted: {
      rawBslText: string;
      sdblText: string;
      replaceRange: {
        startOffset: number;
        endOffset: number;
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
      };
      statementRange?: {
        startOffset: number;
        endOffset: number;
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
      };
      isNewQuery: boolean;
      variableName?: string;
    };

    if (isSdblDocument) {
      if (selectionRange && selectionRange.start !== selectionRange.end) {
        const selStart = Math.min(selectionRange.start, selectionRange.end);
        const selEnd = Math.max(selectionRange.start, selectionRange.end);
        const selectedText = documentText.slice(selStart, selEnd);
        const sPos = offsetToPosition(documentText, selStart);
        const ePos = offsetToPosition(documentText, selEnd);
        extracted = {
          rawBslText: selectedText,
          sdblText: selectedText,
          replaceRange: {
            startOffset: selStart,
            endOffset: selEnd,
            startLine: sPos.line,
            startColumn: sPos.column,
            endLine: ePos.line,
            endColumn: ePos.column,
          },
          isNewQuery: selectedText.trim().length === 0,
        };
      } else {
        const trimmed = documentText.trim();
        if (trimmed.length > 0) {
          const sPos = offsetToPosition(documentText, 0);
          const ePos = offsetToPosition(documentText, documentText.length);
          extracted = {
            rawBslText: documentText,
            sdblText: documentText,
            replaceRange: {
              startOffset: 0,
              endOffset: documentText.length,
              startLine: sPos.line,
              startColumn: sPos.column,
              endLine: ePos.line,
              endColumn: ePos.column,
            },
            isNewQuery: false,
          };
        } else {
          const cPos = offsetToPosition(documentText, cursorOffset);
          extracted = {
            rawBslText: '',
            sdblText: '',
            replaceRange: {
              startOffset: cursorOffset,
              endOffset: cursorOffset,
              startLine: cPos.line,
              startColumn: cPos.column,
              endLine: cPos.line,
              endColumn: cPos.column,
            },
            isNewQuery: true,
          };
        }
      }
    } else {
      extracted = extractBslQuery(documentText, cursorOffset, selectionRange);
    }

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
        const errorMsg = (err as Error)?.message ?? String(err);
        Logger.warn('Failed to parse extracted SDBL query', err);
        void vscode.window.showErrorMessage(
          'Ошибка синтаксиса запроса: ' + errorMsg + '. Открытие конструктора отменено.'
        );
        return undefined;
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
        this.messageSubscription?.dispose();
        this.panel = undefined;
        this.messageHandler = undefined;
        this.messageSubscription = undefined;
      });
    }

    const replaceRangeVscode = new vscode.Range(
      new vscode.Position(
        Math.max(0, extracted.replaceRange.startLine - 1),
        Math.max(0, extracted.replaceRange.startColumn - 1)
      ),
      new vscode.Position(
        Math.max(0, extracted.replaceRange.endLine - 1),
        Math.max(0, extracted.replaceRange.endColumn - 1)
      )
    );
    const expectedText = targetEditor.document.getText(replaceRangeVscode);

    let expectedStatementText: string | undefined;
    if (extracted.statementRange) {
      const stmtRangeVscode = new vscode.Range(
        new vscode.Position(
          Math.max(0, extracted.statementRange.startLine - 1),
          Math.max(0, extracted.statementRange.startColumn - 1)
        ),
        new vscode.Position(
          Math.max(0, extracted.statementRange.endLine - 1),
          Math.max(0, extracted.statementRange.endColumn - 1)
        )
      );
      expectedStatementText = targetEditor.document.getText(stmtRangeVscode);
    }

    const messageContext: QueryBuilderMessageContext = {
      panel: this.panel,
      editor: targetEditor,
      ast,
      metadata,
      mode,
      replaceRange: extracted.replaceRange,
      statementRange: extracted.statementRange,
      variableName: extracted.variableName,
      metadataProvider,
      treeProvider: this.state?.treeDataProvider ?? null,
      isSdblDocument,
      initialDocumentVersion: targetEditor.document.version,
      expectedText,
      expectedStatementText,
    };

    this.messageHandler = new QueryBuilderMessageHandler(messageContext);

    this.messageSubscription?.dispose();
    this.messageSubscription = this.panel.webview.onDidReceiveMessage((message: unknown) => {
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