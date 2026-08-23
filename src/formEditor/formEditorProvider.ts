/**
 * Custom editor provider for 1C form structure (Ext/Form.xml).
 * Slim entry point — delegates to formMessageHandler and formWebviewHtml.
 * Requirements: 1.6, 2.1, 2.2, 2.3, 2.4
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { FormModel } from './formModel';
import {
  createSerializedMessageHandler,
  type FormSelectionPayload,
  type MessageHandlerContext,
  type FormMessage,
  type FormSelectionEntityType,
  applyExternalPropertyChange,
  reloadFormAndSend,
  commitPendingModuleTransaction,
  rollbackPendingModuleTransaction,
  rollbackPendingModuleFileTransaction,
  readValidatedPendingModuleContent,
  type PendingFormModuleTransaction,
  handleCreateEventHandler as handleCreateEventHandlerMsg,
} from './formMessageHandler';
import { FormCommandEngine } from './formCommandEngine';
import { findElementById } from './formTreeOperations';
import { getWebviewHtml } from './formWebviewHtml';
import { getFormEditorTitle, loadFormModel, openModuleInEditor, saveFormModel } from './formFileIo';
import { Logger } from '../utils/logger';
import { runConfigurationMutation } from '../services/configurationSession/configurationMutationGateway';
import { assertGenericFormMutationAllowed } from './cfeAdoptedFormGuard';
export { moveNodeInModel } from './formTreeOperations'; // backward compat

/** Custom document whose lifetime is owned by VS Code, not by a webview panel. */
export class FormEditorDocument implements vscode.CustomDocument {
  private disposed = false;

  constructor(
    public readonly uri: vscode.Uri,
    private readonly onDispose: (document: FormEditorDocument) => void
  ) {}

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.onDispose(this);
  }
}

interface FormEditorBackupPayload {
  version: 1;
  model: FormModel;
  pendingModuleTransaction?: PendingFormModuleTransaction;
}

async function restorePendingModuleTransaction(
  transaction: PendingFormModuleTransaction
): Promise<void> {
  await rollbackPendingModuleFileTransaction(transaction);
}

interface FileSnapshot {
  existed: boolean;
  content?: Buffer;
}

async function captureFileSnapshot(filePath: string): Promise<FileSnapshot> {
  const content = await fs.promises.readFile(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  return { existed: content !== undefined, content };
}

async function restoreFileSnapshot(filePath: string, snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await fs.promises.rm(filePath, { force: true });
    return;
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, snapshot.content!);
}

function getDestinationModulePath(
  sourceFormPath: string,
  destinationFormPath: string,
  sourceModulePath: string
): string {
  const moduleRelativeToForm = path.relative(path.dirname(sourceFormPath), sourceModulePath);
  return path.join(path.dirname(destinationFormPath), moduleRelativeToForm);
}

export class FormEditorProvider implements vscode.CustomEditorProvider<FormEditorDocument> {
  private readonly changeEmitter = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<FormEditorDocument>
  >();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;
  private documentModel = new Map<string, FormModel>();
  private commandEngines = new Map<string, FormCommandEngine>();
  private dirtyDocuments = new Set<string>();
  private pendingModuleTransactions = new Map<string, PendingFormModuleTransaction>();
  private messageExecutors = new Map<string, (message: FormMessage) => Promise<void>>();
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

  async openCustomDocument(
    uri: vscode.Uri,
    openContext?: vscode.CustomDocumentOpenContext
  ): Promise<FormEditorDocument> {
    const document = new FormEditorDocument(uri, (disposedDocument) => {
      this.releaseDocument(disposedDocument.uri);
    });
    if (openContext?.backupId) {
      const payload = JSON.parse(
        await fs.promises.readFile(openContext.backupId, 'utf8')
      ) as FormEditorBackupPayload;
      if (payload.version !== 1 || !payload.model) {
        throw new Error(`Unsupported Form Editor backup: ${openContext.backupId}`);
      }
      const key = uri.toString();
      this.documentModel.set(key, payload.model);
      this.dirtyDocuments.add(key);
      if (payload.pendingModuleTransaction) {
        this.pendingModuleTransactions.set(key, payload.pendingModuleTransaction);
      }
    }
    return document;
  }

  async resolveCustomEditor(
    document: FormEditorDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewPanel.webview.html = getWebviewHtml(
      webviewPanel.webview,
      vscode.window.activeColorTheme.kind
    );
    const themeSubscription = vscode.window.onDidChangeActiveColorTheme((e) => {
      webviewPanel.webview.postMessage({ type: 'hostColorTheme', kind: e.kind });
    });
    const docKey = document.uri.toString();
    const ctx: MessageHandlerContext = {
      document,
      webviewPanel,
      documentModel: this.documentModel,
      commandEngines: this.commandEngines,
      dirtyDocuments: this.dirtyDocuments,
      onDidChangeDocument: () => {
        this.changeEmitter.fire({ document });
      },
      requestSave: async (model) => {
        if (model) {
          this.documentModel.set(docKey, model);
        }
        await vscode.commands.executeCommand('workbench.action.files.save');
      },
      requestRevert: async () => {
        await vscode.commands.executeCommand('workbench.action.files.revert');
      },
      pendingModuleTransactions: this.pendingModuleTransactions,
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
    this.messageExecutors.set(docKey, onMessage);
    webviewPanel.webview.onDidReceiveMessage(onMessage);
    webviewPanel.onDidDispose(() => {
      themeSubscription.dispose();
      this.handlePanelDispose(document.uri, ctx);
    });
  }

  private handlePanelDispose(documentUri: vscode.Uri, ctx: MessageHandlerContext): void {
    const key = documentUri.toString();
    if (this.contextByDocument.get(key) === ctx) {
      this.contextByDocument.delete(key);
      this.messageExecutors.delete(key);
    }
    this.latestSelectionByDocument.delete(key);
    if (this.activeSelectionDocumentUri === key) {
      this.activeSelectionDocumentUri = null;
    }
    if (this.activeDocumentUri?.toString() === key) {
      this.activeDocumentUri = null;
    }
  }

  private releaseDocument(documentUri: vscode.Uri): void {
    const key = documentUri.toString();
    this.contextByDocument.delete(key);
    this.documentModel.delete(key);
    this.commandEngines.delete(key);
    this.dirtyDocuments.delete(key);
    this.pendingModuleTransactions.delete(key);
    this.messageExecutors.delete(key);
    this.latestSelectionByDocument.delete(key);
    if (this.activeSelectionDocumentUri === key) {
      this.activeSelectionDocumentUri = null;
    }
    if (this.activeDocumentUri?.toString() === key) {
      this.activeDocumentUri = null;
    }
  }

  async saveCustomDocument(
    document: FormEditorDocument,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    if (cancellation.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const key = document.uri.toString();
    const model = this.documentModel.get(key);
    if (!model) {
      throw new Error('Нет данных формы для сохранения.');
    }
    await assertGenericFormMutationAllowed(document.uri.fsPath);
    await runConfigurationMutation(document.uri.fsPath, 'ui.form.save', async () => {
      try {
        await saveFormModel(document.uri.fsPath, model);
      } catch (error) {
        const ctx = this.contextByDocument.get(key);
        if (ctx) {
          try {
            await rollbackPendingModuleTransaction(ctx);
          } catch (rollbackError) {
            throw combinedError(error, rollbackError, 'Form save and BSL handler rollback both failed.');
          }
        }
        throw error;
      }
    });
    const ctx = this.contextByDocument.get(key);
    if (ctx) {
      commitPendingModuleTransaction(ctx);
    } else {
      this.pendingModuleTransactions.delete(key);
    }
    this.commandEngines.get(key)?.markSaved();
    this.dirtyDocuments.delete(key);
    if (ctx) {
      ctx.webviewPanel.title = getFormEditorTitle(document.uri.fsPath);
      await ctx.webviewPanel.webview.postMessage({ type: 'saved' });
    }
  }

  async saveCustomDocumentAs(
    document: FormEditorDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    if (cancellation.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const key = document.uri.toString();
    const model = this.documentModel.get(key);
    if (!model) {
      throw new Error('Нет данных формы для сохранения.');
    }
    await assertGenericFormMutationAllowed(document.uri.fsPath);
    const transaction = this.pendingModuleTransactions.get(key);
    const destinationModulePath = transaction
      ? getDestinationModulePath(document.uri.fsPath, destination.fsPath, transaction.modulePath)
      : undefined;
    const pendingModuleContent = transaction
      ? await readValidatedPendingModuleContent(transaction)
      : undefined;
    const formSnapshot = await captureFileSnapshot(destination.fsPath);
    const moduleSnapshot = destinationModulePath
      && path.normalize(destinationModulePath) !== path.normalize(transaction!.modulePath)
      ? await captureFileSnapshot(destinationModulePath)
      : undefined;
    await runConfigurationMutation(document.uri.fsPath, 'ui.form.saveAs', async () => {
      try {
        await fs.promises.mkdir(path.dirname(destination.fsPath), { recursive: true });
        await saveFormModel(destination.fsPath, model);
        if (transaction && destinationModulePath && pendingModuleContent !== undefined) {
          if (path.normalize(destinationModulePath) === path.normalize(transaction.modulePath)) {
            this.pendingModuleTransactions.delete(key);
          } else {
            await fs.promises.mkdir(path.dirname(destinationModulePath), { recursive: true });
            await fs.promises.writeFile(destinationModulePath, pendingModuleContent, 'utf8');
            await rollbackPendingModuleFileTransaction(transaction);
            this.pendingModuleTransactions.delete(key);
          }
        }
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        await restoreFileSnapshot(destination.fsPath, formSnapshot).catch((rollbackError) => {
          rollbackErrors.push(rollbackError);
        });
        if (destinationModulePath && moduleSnapshot) {
          await restoreFileSnapshot(destinationModulePath, moduleSnapshot).catch((rollbackError) => {
            rollbackErrors.push(rollbackError);
          });
        }
        if (rollbackErrors.length > 0) {
          throw combinedError(error, rollbackErrors.map(String).join('; '), 'Save As and rollback both failed.');
        }
        throw error;
      }
    });
    this.commandEngines.get(key)?.markSaved();
    this.dirtyDocuments.delete(key);
    const ctx = this.contextByDocument.get(key);
    if (ctx) {
      await ctx.webviewPanel.webview.postMessage({ type: 'saved' });
    }
  }

  async revertCustomDocument(
    document: FormEditorDocument,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    if (cancellation.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const key = document.uri.toString();
    await runConfigurationMutation(document.uri.fsPath, 'ui.form.revert', async () => {
      const ctx = this.contextByDocument.get(key);
      if (ctx) {
        await rollbackPendingModuleTransaction(ctx);
        await reloadFormAndSend(ctx);
        return;
      }
      const transaction = this.pendingModuleTransactions.get(key);
      if (transaction) {
        await restorePendingModuleTransaction(transaction);
        this.pendingModuleTransactions.delete(key);
      }
      const result = await loadFormModel(document.uri.fsPath);
      if ('error' in result) {
        throw new Error(result.error);
      }
      this.documentModel.set(key, result.model);
      this.commandEngines.delete(key);
      this.dirtyDocuments.delete(key);
    });
  }

  async backupCustomDocument(
    document: FormEditorDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    if (cancellation.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const model = this.documentModel.get(document.uri.toString());
    if (!model) {
      throw new Error('Нет данных формы для резервного копирования.');
    }
    const backupPath = context.destination.fsPath;
    await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
    const payload: FormEditorBackupPayload = {
      version: 1,
      model,
      pendingModuleTransaction: this.pendingModuleTransactions.get(document.uri.toString()),
    };
    await fs.promises.writeFile(backupPath, JSON.stringify(payload), 'utf8');
    return {
      id: backupPath,
      delete: () => {
        void fs.promises.rm(backupPath, { force: true });
      },
    };
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.contextByDocument.clear();
    this.documentModel.clear();
    this.commandEngines.clear();
    this.dirtyDocuments.clear();
    this.pendingModuleTransactions.clear();
    this.messageExecutors.clear();
    this.latestSelectionByDocument.clear();
    this.activeSelectionDocumentUri = null;
    this.activeDocumentUri = null;
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
    const executor = this.messageExecutors.get(payload.docUri);
    const operation = assertGenericFormMutationAllowed(ctx.document.uri.fsPath).then(() => (
      executor
        ? executor({ type: 'createEventHandler', ...msg })
        : handleCreateEventHandlerMsg(ctx, msg)
    ));
    operation.then(() => {
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

function combinedError(primary: unknown, rollback: unknown, message: string): Error {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const rollbackMessage = rollback instanceof Error ? rollback.message : String(rollback);
  return new Error(`${message} Save: ${primaryMessage}. Rollback: ${rollbackMessage}`);
}
