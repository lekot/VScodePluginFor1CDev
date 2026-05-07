/**
 * Custom editor provider for 1C form structure (Ext/Form.xml).
 * Slim entry point — delegates to formMessageHandler and formWebviewHtml.
 * Requirements: 1.6, 2.1, 2.2, 2.3, 2.4
 */

import * as vscode from 'vscode';
import type { FormModel } from './formModel';
import {
  createSerializedMessageHandler,
  isFormDocumentDirty,
  type FormSelectionPayload,
  type MessageHandlerContext,
  type FormSelectionEntityType,
  applyExternalPropertyChange,
  handleCreateEventHandler as handleCreateEventHandlerMsg,
} from './formMessageHandler';
import { FormCommandEngine } from './formCommandEngine';
import { findElementById } from './formTreeOperations';
import { getWebviewHtml } from './formWebviewHtml';
import { openModuleInEditor } from './formFileIo';
import { Logger } from '../utils/logger';
export { moveNodeInModel } from './formTreeOperations'; // backward compat

/** Minimal custom document for form editor. */
class FormEditorDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class FormEditorProvider implements vscode.CustomReadonlyEditorProvider<FormEditorDocument> {
  private documentModel = new Map<string, FormModel>();
  private commandEngines = new Map<string, FormCommandEngine>();
  private dirtyDocuments = new Set<string>();
  private contextByDocument = new Map<string, MessageHandlerContext>();
  private activeSelectionDocumentUri: string | null = null;
  private activeDocumentUri: vscode.Uri | null = null;
  private latestSelectionByDocument = new Map<
    string,
    {
      entityType: FormSelectionEntityType;
      entityId?: string;
      entityName?: string;
    }
  >();

  constructor(
    private readonly onFormSelectionChanged?: (payload: FormSelectionPayload | undefined) => void
  ) {}

  openCustomDocument(uri: vscode.Uri): FormEditorDocument {
    return new FormEditorDocument(uri);
  }

  async resolveCustomEditor(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = getWebviewHtml(
      webviewPanel.webview,
      vscode.window.activeColorTheme.kind
    );
    const themeSubscription = vscode.window.onDidChangeActiveColorTheme((e) => {
      webviewPanel.webview.postMessage({ type: 'hostColorTheme', kind: e.kind });
    });
    const ctx: MessageHandlerContext = {
      document,
      webviewPanel,
      documentModel: this.documentModel,
      commandEngines: this.commandEngines,
      dirtyDocuments: this.dirtyDocuments,
      onFormSelectionChanged: (payload) => {
        if (payload) {
          this.activeSelectionDocumentUri = payload.docUri;
          this.latestSelectionByDocument.set(payload.docUri, {
            entityType: payload.entityType,
            entityId: payload.id,
            entityName: payload.name,
          });
        } else {
          this.activeSelectionDocumentUri = null;
        }
        this.onFormSelectionChanged?.(payload);
      },
    };
    const docKey = document.uri.toString();
    this.contextByDocument.set(docKey, ctx);
    if (webviewPanel.active) {
      this.activeDocumentUri = document.uri;
    }
    webviewPanel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        this.activeDocumentUri = document.uri;
      } else if (this.activeDocumentUri?.toString() === docKey) {
        this.activeDocumentUri = null;
      }
    });
    const onMessage = createSerializedMessageHandler(ctx);
    webviewPanel.webview.onDidReceiveMessage(onMessage);
    webviewPanel.onDidDispose(() => {
      themeSubscription.dispose();
      void this.handlePanelDispose(document.uri);
    });
  }

  private async handlePanelDispose(documentUri: vscode.Uri): Promise<void> {
    const key = documentUri.toString();
    const ctx = this.contextByDocument.get(key);
    const dirty = ctx ? isFormDocumentDirty(ctx) : this.dirtyDocuments.has(key);
    this.contextByDocument.delete(key);
    this.commandEngines.delete(key);
    this.dirtyDocuments.delete(key);
    this.latestSelectionByDocument.delete(key);
    if (this.activeSelectionDocumentUri === key) {
      this.activeSelectionDocumentUri = null;
    }
    if (this.activeDocumentUri?.toString() === key) {
      this.activeDocumentUri = null;
    }
    if (!dirty) {
      return;
    }
    const closeLabel = 'Закрыть без сохранения';
    const returnLabel = 'Вернуться к форме';
    const choice = await vscode.window.showWarningMessage(
      'Чувак, ты не сохранился. Закрыть форму без сохранения?',
      { modal: true },
      closeLabel,
      returnLabel
    );
    if (choice === returnLabel) {
      await vscode.commands.executeCommand('vscode.openWith', documentUri, '1c-form-editor', { preview: false });
    }
  }

  public getActiveDocumentUri(): vscode.Uri | null {
    return this.activeDocumentUri;
  }

  public gotoEventHandler(payload: { docUri: string; handlerName: string }): void {
    const ctx = this.contextByDocument.get(payload.docUri);
    if (!ctx) {
      return;
    }
    openModuleInEditor(ctx.document.uri.fsPath, payload.handlerName).catch((err) => {
      Logger.error('gotoEventHandler: openModuleInEditor failed', err);
    });
  }

  public createEventHandler(payload: {
    docUri: string;
    elementId: string;
    elementName: string;
    elementTag: string;
    eventName: string;
  }): void {
    const ctx = this.contextByDocument.get(payload.docUri);
    if (!ctx) {
      return;
    }
    const msg = {
      elementId: payload.elementId,
      elementName: payload.elementName,
      tag: payload.elementTag,
      eventName: payload.eventName,
    };
    handleCreateEventHandlerMsg(ctx, msg).then(() => {
      // Re-emit selection so Properties panel refreshes with updated events
      const model = this.documentModel.get(payload.docUri);
      if (!model) { return; }
      const el = findElementById(model.childItemsRoot, payload.elementId);
      if (el && this.onFormSelectionChanged) {
        this.onFormSelectionChanged({
          source: 'form-editor',
          docUri: payload.docUri,
          entityType: 'element',
          id: el.id,
          name: el.name,
          tag: el.tag,
          properties: el.properties ?? {},
          events: el.events ?? {},
          selectedIds: [payload.elementId],
        });
      }
    }).catch((err) => {
      Logger.error('createEventHandler: handleCreateEventHandler failed', err);
    });
  }

  public applySelectionPropertyChange(payload: {
    docUri: string;
    entityType: FormSelectionEntityType;
    entityId?: string;
    entityName?: string;
    scope: 'property' | 'event';
    key: string;
    value: unknown;
  }): void {
    if (!payload.docUri || payload.docUri !== this.activeSelectionDocumentUri) {
      return;
    }
    const ctx = this.contextByDocument.get(payload.docUri);
    if (!ctx) {
      return;
    }
    const selection = this.latestSelectionByDocument.get(payload.docUri);
    if (!selection || selection.entityType !== payload.entityType) {
      return;
    }
    const hasPayloadEntity = Boolean(payload.entityId || payload.entityName);
    const hasSelectionEntity = Boolean(selection.entityId || selection.entityName);
    if (hasPayloadEntity && hasSelectionEntity) {
      const payloadEntityKey = payload.entityId ?? payload.entityName ?? '';
      const selectionEntityKey = selection.entityId ?? selection.entityName ?? '';
      if (payloadEntityKey !== selectionEntityKey) {
        return;
      }
    }
    applyExternalPropertyChange(ctx, payload);
  }
}
