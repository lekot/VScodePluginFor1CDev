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

  handleCreateEventHandler as handleCreateEventHandlerMsg,
} from './formMessageHandler';
import type { PendingFormModuleTransaction } from './pendingFormModuleTransaction';
import { FormCommandEngine } from './formCommandEngine';
import { findElementById } from './formTreeOperations';
import { getWebviewHtml } from './formWebviewHtml';
import { getFormEditorTitle, loadFormModel, openModuleInEditor, saveFormModel } from './formFileIo';
import { buildFormXmlDocument } from './formXmlWriter';
import { createFormXmlSourceSnapshot, type FormXmlSourceSnapshot } from './formXmlTextEditor';
import { Logger } from '../utils/logger';
import { runConfigurationMutation, runConfigurationPlan } from '../services/configurationSession/configurationMutationGateway';
import { readMutationExpectation } from '../services/filesystemReadSemantics';
import { hashContent } from '../services/configurationSession/atomicFileStorage';
import { type MutationExpectation, type MutationPlan, type MutationStep } from '../services/configurationSession/mutationPlan';
import { canonicalizePathWithMissingSuffix, isSamePath } from '../services/configurationSession/pathBoundary';
import { assertGenericFormMutationAllowed } from './cfeAdoptedFormGuard';
import { getFormPaths } from './formPaths';
import { parseBslProceduresFromContent } from './bslModuleParser';
import { findModuleTextDocument, restoreModuleDocumentAssociation } from './formModuleDocuments';
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
  sourceSnapshot?: {
    sourceBase64: string;
    sha256: string;
    baseline: FormModel;
  };
  pendingModuleTransaction?: PendingFormModuleTransaction;
}



export class FormEditorProvider implements vscode.CustomEditorProvider<FormEditorDocument> {
  private readonly changeEmitter = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<FormEditorDocument>
  >();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;
  private documentModel = new Map<string, FormModel>();
  private sourceSnapshots = new Map<string, FormXmlSourceSnapshot>();
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
  private readonly isSavingDocument = new Set<string>();
  private readonly saveOperations = new Map<string, Promise<void>>();
  private readonly editGenerations = new Map<string, number>();
  private readonly lifecycleEpochs = new Map<string, number>();
  private readonly moduleDocumentsByPath = new Map<string, vscode.TextDocument>();
  private readonly onDidSaveTextDocSubscription: vscode.Disposable;

  constructor(
    private readonly onFormSelectionChanged?: (payload: FormSelectionPayload | undefined) => void
  ) {
    this.onDidSaveTextDocSubscription = vscode.workspace.onDidSaveTextDocument(async (textDoc) => {
      for (const dirtyKey of Array.from(this.dirtyDocuments)) {
        const ctx = this.contextByDocument.get(dirtyKey);
        if (!ctx) {
          continue;
        }
        const { modulePath } = getFormPaths(ctx.document.uri.fsPath);
        if (this.isSavingDocument.has(dirtyKey)) {
          continue;
        }
        let pairedDocument: vscode.TextDocument | undefined;
        try {
          pairedDocument = await findModuleTextDocument(modulePath, this.moduleDocumentsByPath);
        } catch (error) {
          Logger.warn('Skipping paired Form auto-save because Module.bsl buffers are ambiguous', error);
          continue;
        }
        if (pairedDocument !== textDoc) {
          continue;
        }
        if (!(await this.hasPersistedPendingModuleLinks(dirtyKey, modulePath, textDoc))) {
          continue;
        }
        try {
          await this.saveCustomDocument(ctx.document as FormEditorDocument, new vscode.CancellationTokenSource().token);
        } catch (err) {
          Logger.error('Failed to auto-save paired Form.xml', err);
        }
      }
    });
  }

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
      if (payload.sourceSnapshot) {
        const source = Buffer.from(payload.sourceSnapshot.sourceBase64, 'base64');
        const snapshot = createFormXmlSourceSnapshot(source, payload.sourceSnapshot.baseline);
        if (snapshot.sha256 !== payload.sourceSnapshot.sha256) {
          throw new Error(`Unsupported Form Editor backup source snapshot: ${openContext.backupId}`);
        }
        this.sourceSnapshots.set(key, snapshot);
      } else {
        const loaded = await loadFormModel(uri.fsPath);
        if (!('error' in loaded) && loaded.sourceSnapshot) {
          this.sourceSnapshots.set(key, loaded.sourceSnapshot);
        }
      }
      this.dirtyDocuments.add(key);
      if (payload.pendingModuleTransaction) {
        this.pendingModuleTransactions.set(key, payload.pendingModuleTransaction);
        try {
          await restoreModuleDocumentAssociation(
            payload.pendingModuleTransaction.modulePath,
            this.moduleDocumentsByPath,
          );
        } catch (error) {
          Logger.warn('Could not restore an unambiguous live Module.bsl association', error);
        }
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
      sourceSnapshots: this.sourceSnapshots,
      commandEngines: this.commandEngines,
      dirtyDocuments: this.dirtyDocuments,
      onDidChangeDocument: () => {
        this.editGenerations.set(docKey, (this.editGenerations.get(docKey) ?? 0) + 1);
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
      moduleDocumentsByPath: this.moduleDocumentsByPath,
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
    const activeTabInput = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
    const isActiveTab =
      Boolean(activeTabInput) &&
      typeof activeTabInput === 'object' &&
      'uri' in activeTabInput! &&
      (activeTabInput as { uri?: vscode.Uri }).uri?.toString() === docKey;
    if (webviewPanel.active || isActiveTab) {
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
    this.sourceSnapshots.delete(key);
    this.commandEngines.delete(key);
    this.dirtyDocuments.delete(key);
    this.pendingModuleTransactions.delete(key);
    this.lifecycleEpochs.delete(key);
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
    const lifecycleEpoch = this.lifecycleEpochs.get(key) ?? 0;
    return this.runSaveOperation(key, () => this.saveCustomDocumentSerialized(document, cancellation, lifecycleEpoch));
  }

  private async saveCustomDocumentSerialized(
    document: FormEditorDocument,
    cancellation: vscode.CancellationToken,
    lifecycleEpoch: number,
  ): Promise<void> {
    const key = document.uri.toString();
    const assertLifecycleCurrent = (): void => this.assertLifecycleCurrent(key, lifecycleEpoch, cancellation);
    assertLifecycleCurrent();
    this.isSavingDocument.add(key);
    try {
      const currentModel = this.documentModel.get(key);
      if (!currentModel) {
        throw new Error('Нет данных формы для сохранения.');
      }
      const model = cloneFormModel(currentModel);
      const generation = this.editGenerations.get(key) ?? 0;
      const transaction = clonePendingModuleTransaction(this.pendingModuleTransactions.get(key));
      await assertGenericFormMutationAllowed(document.uri.fsPath);
      assertLifecycleCurrent();

      const { modulePath } = getFormPaths(document.uri.fsPath);
      const pendingHandlers = getActivePendingModuleHandlerNames(model, transaction, modulePath);
      await this.saveAndValidatePendingModule(modulePath, pendingHandlers, assertLifecycleCurrent);
      assertLifecycleCurrent();

      let savedSnapshot: FormXmlSourceSnapshot | undefined;
      await runConfigurationMutation(document.uri.fsPath, 'ui.form.save', async () => {
        assertLifecycleCurrent();
        savedSnapshot = await saveFormModel(document.uri.fsPath, model, this.sourceSnapshots.get(key));
      });
      if (savedSnapshot) {
        this.sourceSnapshots.set(key, savedSnapshot);
      }

      const ctx = this.contextByDocument.get(key);
      const latestModel = this.documentModel.get(key);
      const generationIsCurrent = generation === (this.editGenerations.get(key) ?? 0);
      const modelIsCurrent = latestModel !== undefined && modelsEqual(latestModel, model);
      if (generationIsCurrent && modelIsCurrent) {
        this.commandEngines.get(key)?.markSaved();
        this.dirtyDocuments.delete(key);
        this.pendingModuleTransactions.delete(key);
      }
      if (ctx && generationIsCurrent && modelIsCurrent) {
        ctx.webviewPanel.title = getFormEditorTitle(document.uri.fsPath);
        await ctx.webviewPanel.webview.postMessage({ type: 'saved' });
      } else if (ctx) {
        ctx.webviewPanel.title = `${getFormEditorTitle(document.uri.fsPath)} *`;
      }
    } catch (error) {
      const ctx = this.contextByDocument.get(key);
      if (!isCancellationError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx) {
          await ctx.webviewPanel.webview.postMessage({ type: 'error', message });
        }
        Logger.error('Form editor save failed', error);
      }
      throw error;
    } finally {
      this.isSavingDocument.delete(key);
    }
  }

  private runSaveOperation(documentKey: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.saveOperations.get(documentKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation).finally(() => {
      if (this.saveOperations.get(documentKey) === current) {
        this.saveOperations.delete(documentKey);
      }
    });
    this.saveOperations.set(documentKey, current);
    return current;
  }

  private assertLifecycleCurrent(
    documentKey: string,
    lifecycleEpoch: number,
    cancellation: vscode.CancellationToken,
  ): void {
    if (
      cancellation.isCancellationRequested ||
      (this.lifecycleEpochs.get(documentKey) ?? 0) !== lifecycleEpoch
    ) {
      throw new vscode.CancellationError();
    }
  }

  private async saveAndValidatePendingModule(
    modulePath: string,
    handlerNames: string[],
    assertLifecycleCurrent: () => void,
  ): Promise<void> {
    const pairedModuleDoc = await findModuleTextDocument(modulePath, this.moduleDocumentsByPath);
    if (pairedModuleDoc?.isDirty) {
      assertLifecycleCurrent();
      const saved = await pairedModuleDoc.save();
      assertLifecycleCurrent();
      if (!saved) {
        throw new Error('Сохранение Module.bsl отменено; Form.xml не сохранён.');
      }
    }

    if (handlerNames.length === 0) {
      return;
    }

    const bufferContent = pairedModuleDoc?.getText();
    const persistedContent = await fs.promises.readFile(modulePath, 'utf8').catch(() => undefined);
    const containsAllHandlers = (content: string | undefined): boolean => {
      if (content === undefined) {
        return false;
      }
      const procedures = new Set(parseBslProceduresFromContent(content).map((procedure) => procedure.name.toLowerCase()));
      return handlerNames.every((handlerName) => procedures.has(handlerName.toLowerCase()));
    };
    if (!containsAllHandlers(persistedContent) || (bufferContent !== undefined && !containsAllHandlers(bufferContent))) {
      throw new Error('Module.bsl не содержит все связанные обработчики; привязка Form.xml не записана.');
    }
  }

  private async hasPersistedPendingModuleLinks(
    documentKey: string,
    modulePath: string,
    moduleDocument: vscode.TextDocument,
  ): Promise<boolean> {
    const transaction = this.pendingModuleTransactions.get(documentKey);
    const model = this.documentModel.get(documentKey);
    const handlerNames = model
      ? getActivePendingModuleHandlerNames(model, transaction, modulePath)
      : [];
    if (handlerNames.length === 0) {
      return false;
    }
    const persistedContent = await fs.promises.readFile(modulePath, 'utf8').catch(() => undefined);
    const persistedNames = new Set(
      persistedContent === undefined
        ? []
        : parseBslProceduresFromContent(persistedContent).map((procedure) => procedure.name.toLowerCase())
    );
    const bufferedNames = new Set(parseBslProceduresFromContent(moduleDocument.getText()).map((procedure) => procedure.name.toLowerCase()));
    return handlerNames.every((name) => persistedNames.has(name.toLowerCase()) && bufferedNames.has(name.toLowerCase()));
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
    const lifecycleEpoch = this.lifecycleEpochs.get(key) ?? 0;
    return this.runSaveOperation(key, () => this.saveCustomDocumentAsSerialized(document, destination, cancellation, lifecycleEpoch));
  }

  private async saveCustomDocumentAsSerialized(
    document: FormEditorDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken,
    lifecycleEpoch: number,
  ): Promise<void> {
    const key = document.uri.toString();
    const assertLifecycleCurrent = (): void => this.assertLifecycleCurrent(key, lifecycleEpoch, cancellation);
    assertLifecycleCurrent();
    if (destination.scheme !== 'file') {
      throw new Error('Save As доступен только для файлового пути.');
    }
    const currentModel = this.documentModel.get(key);
    if (!currentModel) {
      throw new Error('Нет данных формы для сохранения.');
    }
    const model = cloneFormModel(currentModel);
    const generation = this.editGenerations.get(key) ?? 0;
    const { modulePath: srcModulePath } = getFormPaths(document.uri.fsPath);
    const sourceModuleDoc = await findModuleTextDocument(srcModulePath, this.moduleDocumentsByPath);
    const sourceModuleVersion = sourceModuleDoc?.version;
    const sourceModuleText = sourceModuleDoc?.getText();
    let sourceModuleBytes: Buffer | undefined;
    let sourceModuleDiskExpectation: Exclude<MutationExpectation, { state: 'directory' }> | undefined;
    let sourceModuleEncoding: 'utf8' | 'base64' = 'utf8';

    if (sourceModuleDoc) {
      if (sourceModuleText === undefined) {
        throw new Error('Не удалось прочитать открытый Module.bsl для Save As.');
      }
    } else {
      const expectation = await readMutationExpectation(srcModulePath);
      if (expectation.state === 'directory') {
        throw new Error(`Module.bsl имеет неверный тип: ${srcModulePath}`);
      }
      sourceModuleDiskExpectation = expectation;
      if (expectation.state === 'file') {
        sourceModuleBytes = await fs.promises.readFile(srcModulePath);
        if (hashContent(sourceModuleBytes) !== expectation.hash) {
          throw new Error(`Module.bsl изменился во время подготовки Save As: ${srcModulePath}`);
        }
        sourceModuleEncoding = 'base64';
      }
    }

    const assertCapturedSourceIsCurrent = (): void => {
      assertLifecycleCurrent();
      const latestModel = this.documentModel.get(key);
      if (
        (this.editGenerations.get(key) ?? 0) !== generation ||
        !latestModel ||
        !modelsEqual(latestModel, model)
      ) {
        throw new Error('Форма изменилась во время подготовки Save As; сохранение отменено.');
      }
      if (sourceModuleDoc && (
        (sourceModuleVersion !== undefined && sourceModuleDoc.version !== sourceModuleVersion) ||
        sourceModuleDoc.getText() !== sourceModuleText
      )) {
        throw new Error('Module.bsl изменился во время подготовки Save As; сохранение отменено.');
      }
    };

    await assertGenericFormMutationAllowed(document.uri.fsPath);
    const ctx = this.contextByDocument.get(key);
    try {
      await runConfigurationMutation(destination.fsPath, 'ui.form.saveAs', async () => {
        if (cancellation.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        assertCapturedSourceIsCurrent();

        const sourceFormPath = await canonicalizePathWithMissingSuffix(document.uri.fsPath);
        const destinationFormPath = await canonicalizePathWithMissingSuffix(destination.fsPath);
        if (isSamePath(sourceFormPath, destinationFormPath)) {
          throw new Error('Источник и назначение Save As совпадают.');
        }

        const { modulePath: destinationModulePathRaw } = getFormPaths(destinationFormPath);
        const destinationModulePath = await canonicalizePathWithMissingSuffix(destinationModulePathRaw);
        const sourceModulePath = await canonicalizePathWithMissingSuffix(srcModulePath);
        if (
          isSamePath(destinationFormPath, destinationModulePath) ||
          isSamePath(sourceFormPath, destinationModulePath) ||
          (sourceModuleDoc || sourceModuleBytes) && isSamePath(sourceModulePath, destinationModulePath)
        ) {
          throw new Error('Путь назначения Save As пересекается с исходным файлом формы или модуля.');
        }

        const destinationFormDoc = await findOpenTextDocumentCanonical(destinationFormPath);
        if (destinationFormDoc?.isDirty) {
          throw new Error('Целевой Form.xml открыт с несохранёнными изменениями; Save As отменён.');
        }
        const destinationModuleDoc = sourceModuleDoc || sourceModuleBytes
          ? await findModuleTextDocument(destinationModulePath, this.moduleDocumentsByPath)
          : undefined;
        if (destinationModuleDoc?.isDirty) {
          throw new Error('Целевой Module.bsl открыт с несохранёнными изменениями; Save As отменён.');
        }

        const formExpectation = await readMutationExpectation(destinationFormPath);
        if (formExpectation.state === 'directory') {
          throw new Error(`Путь Form.xml занят каталогом: ${destinationFormPath}`);
        }
        const existingFormBytes = formExpectation.state === 'file'
          ? await fs.promises.readFile(destinationFormPath)
          : undefined;
        if (formExpectation.state === 'file' && existingFormBytes && hashContent(existingFormBytes) !== formExpectation.hash) {
          throw new Error(`Целевой Form.xml изменился во время подготовки Save As: ${destinationFormPath}`);
        }
        const existingFormContent = existingFormBytes?.toString('utf8');
        const formContent = buildFormXmlDocument(model, existingFormContent, destinationFormPath);

        const steps: MutationStep[] = [
          { type: 'ensureDirectory', targetPath: path.dirname(destinationFormPath) },
          {
            type: 'writeFile',
            targetPath: destinationFormPath,
            content: formContent,
            encoding: 'utf8',
            expected: formExpectation,
          },
        ];

        let moduleExpectation: MutationExpectation | undefined;
        if (sourceModuleDoc || sourceModuleBytes) {
          moduleExpectation = await readMutationExpectation(destinationModulePath);
          if (moduleExpectation.state === 'directory') {
            throw new Error(`Путь Module.bsl занят каталогом: ${destinationModulePath}`);
          }
          steps.push(
            { type: 'ensureDirectory', targetPath: path.dirname(destinationModulePath) },
            {
              type: 'writeFile',
              targetPath: destinationModulePath,
              content: sourceModuleDoc ? sourceModuleText! : sourceModuleBytes!.toString('base64'),
              encoding: sourceModuleDoc ? 'utf8' : sourceModuleEncoding,
              expected: moduleExpectation,
            },
          );
        }
        assertCapturedSourceIsCurrent();
        if (sourceModuleDiskExpectation) {
          const currentSourceExpectation = await readMutationExpectation(srcModulePath);
          if (!mutationExpectationsEqual(sourceModuleDiskExpectation, currentSourceExpectation)) {
            throw new Error(`Исходный Module.bsl изменился во время подготовки Save As: ${srcModulePath}`);
          }
        }
        assertCapturedSourceIsCurrent();
        const plan: MutationPlan<void> = {
          kind: 'ui.form.saveAs',
          steps,
          result: undefined,
        };
        await runConfigurationPlan(destinationFormPath, plan);
      });

      const latestModel = this.documentModel.get(key);
      const isCurrent =
        (this.editGenerations.get(key) ?? 0) === generation &&
        latestModel !== undefined &&
        modelsEqual(latestModel, model);
      if (isCurrent) {
        this.commandEngines.get(key)?.markSaved();
        this.dirtyDocuments.delete(key);
        this.pendingModuleTransactions.delete(key);
      }
      if (ctx && isCurrent) {
        ctx.webviewPanel.title = getFormEditorTitle(document.uri.fsPath);
        await ctx.webviewPanel.webview.postMessage({ type: 'saved' });
      } else if (ctx) {
        ctx.webviewPanel.title = `${getFormEditorTitle(document.uri.fsPath)} *`;
      }
    } catch (error) {
      if (!isCancellationError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx) {
          await ctx.webviewPanel.webview.postMessage({ type: 'error', message });
        }
        Logger.error('Form editor Save As failed', error);
      }
      throw error;
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
    this.lifecycleEpochs.set(key, (this.lifecycleEpochs.get(key) ?? 0) + 1);
    await this.runSaveOperation(key, async () => {
      if (cancellation.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      await runConfigurationMutation(document.uri.fsPath, 'ui.form.revert', async () => {
        if (cancellation.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        const ctx = this.contextByDocument.get(key);
        if (ctx) {
          await reloadFormAndSend(ctx);
          return;
        }
        const result = await loadFormModel(document.uri.fsPath);
        if ('error' in result) {
          throw new Error(result.error);
        }
        this.documentModel.set(key, result.model);

        if (result.sourceSnapshot) {
          this.sourceSnapshots.set(key, result.sourceSnapshot);
        } else {
          this.sourceSnapshots.delete(key);
        }
        this.commandEngines.delete(key);
        this.dirtyDocuments.delete(key);
      });
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
      sourceSnapshot: (() => {
        const snapshot = this.sourceSnapshots.get(document.uri.toString());
        return snapshot ? {
          sourceBase64: snapshot.source.toString('base64'),
          sha256: snapshot.sha256,
          baseline: snapshot.baseline,
        } : undefined;
      })(),
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
    this.onDidSaveTextDocSubscription.dispose();
    this.changeEmitter.dispose();
    this.contextByDocument.clear();
    this.documentModel.clear();
    this.sourceSnapshots.clear();
    this.commandEngines.clear();
    this.dirtyDocuments.clear();
    this.pendingModuleTransactions.clear();
    this.lifecycleEpochs.clear();
    this.messageExecutors.clear();
    this.latestSelectionByDocument.clear();
    this.activeSelectionDocumentUri = null;
    this.activeDocumentUri = null;
  }

  public getActiveDocumentUri(): vscode.Uri | null {
    const activeTabInput = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
    if (
      activeTabInput &&
      typeof activeTabInput === 'object' &&
      'uri' in activeTabInput &&
      'viewType' in activeTabInput &&
      (activeTabInput as { viewType?: string }).viewType === '1c-form-editor'
    ) {
      return (activeTabInput as { uri: vscode.Uri }).uri;
    }
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

function cloneFormModel(model: FormModel): FormModel {
  return JSON.parse(JSON.stringify(model)) as FormModel;
}

function isCancellationError(error: unknown): boolean {
  return error instanceof vscode.CancellationError || (
    error instanceof Error &&
    (error.name === 'CancellationError' || error.name === 'Canceled' || error.message === 'Canceled')
  );
}

async function findOpenTextDocumentCanonical(targetPath: string): Promise<vscode.TextDocument | undefined> {
  const canonicalTargetPath = await canonicalizePathWithMissingSuffix(targetPath);
  for (const candidate of vscode.workspace.textDocuments) {
    const candidatePath = candidate.uri.fsPath;
    if (!candidatePath) {
      continue;
    }
    if (isSamePath(candidatePath, targetPath)) {
      return candidate;
    }
    try {
      const canonicalCandidatePath = await canonicalizePathWithMissingSuffix(candidatePath);
      if (isSamePath(canonicalCandidatePath, canonicalTargetPath)) {
        return candidate;
      }
    } catch {
      // Ignore unrelated untitled or unavailable documents while looking for the target.
    }
  }
  return undefined;
}

function mutationExpectationsEqual(
  left: Exclude<MutationExpectation, { state: 'directory' }>,
  right: MutationExpectation,
): boolean {
  if (left.state !== right.state) {
    return false;
  }
  return left.state !== 'file' || (right.state === 'file' && left.hash === right.hash);
}

function clonePendingModuleTransaction(
  transaction: PendingFormModuleTransaction | undefined,
): PendingFormModuleTransaction | undefined {
  return transaction ? JSON.parse(JSON.stringify(transaction)) as PendingFormModuleTransaction : undefined;
}

function modelsEqual(left: FormModel, right: FormModel): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getActivePendingModuleHandlerNames(
  model: FormModel,
  transaction: PendingFormModuleTransaction | undefined,
  modulePath: string,
): string[] {
  const transactionPath = path.resolve(transaction?.modulePath ?? '');
  const currentPath = path.resolve(modulePath);
  const samePath = process.platform === 'win32'
    ? transactionPath.toLowerCase() === currentPath.toLowerCase()
    : transactionPath === currentPath;
  if (!transaction || !samePath) {
    return [];
  }

  const activeNames = new Set<string>();
  for (const binding of transaction.bindings) {
    if (!binding.methodName) {
      continue;
    }
    if (binding.kind === 'form') {
      if (model.formEvents?.some((event) => event.name === binding.eventName && event.method === binding.methodName)) {
        activeNames.add(binding.methodName);
      }
      continue;
    }

    const element = findElementById(model.childItemsRoot, binding.elementId);
    if (element?.events?.[binding.eventName] === binding.methodName) {
      activeNames.add(binding.methodName);
    }
  }
  return [...activeNames];
}
