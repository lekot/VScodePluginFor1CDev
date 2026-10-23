import * as vscode from 'vscode';
import { TreeNode, MetadataType } from '../models/treeNode';
import { resolveCommonPicture } from '../services/picture/commonPictureResolver';
import { Logger } from '../utils/logger';
import { MetadataTreeDataProvider } from './treeDataProvider';
import { TypeEditorProvider } from './typeEditorProvider';
import { ObjectTypeEditorProvider } from './objectTypeEditorProvider';
import { MESSAGES } from '../constants/messages';
import { getConfigurationXmlPathForNode } from '../utils/configHelpers';
import * as path from 'path';
import { isContainerNode } from '../utils/treeNormalization';
import * as fs from 'fs';
import type { FormSelectionPayload } from '../formEditor/formMessageHandler';
import { isValidWebviewMessage } from './propertiesWebviewTypes';
import type { ExtensionMessage } from './propertiesWebviewTypes';
import {
  getWebviewContent,
  getEmptyStateContent,
  getFormSelectionWebviewContent,
  getErrorPanelContent,
} from './propertiesWebviewContent';
import { handleMessage } from './propertiesMessageHandler';
import type { MessageHandlerContext } from './propertiesMessageHandler';

interface DirtySessionSnapshot {
  node: TreeNode;
  sessionToken: string;
  dirtyRevision: number;
  panel: vscode.WebviewPanel | undefined;
  properties: Record<string, unknown> | undefined;
}

interface PresentationSnapshot {
  navigationRevision: number;
  panel: vscode.WebviewPanel | undefined;
  node: TreeNode | undefined;
  sessionToken: string;
  formSelection: FormSelectionPayload | null;
  formSelectionRevision: number;
}

/**
 * Properties View Provider for displaying and editing element properties
 */
export class PropertiesProvider {
  private panel: vscode.WebviewPanel | undefined;
  private currentNode: TreeNode | undefined;
  private currentFormSelection: FormSelectionPayload | null = null;
  private currentFormSelectionRevision = 0;
  private disposables: vscode.Disposable[] = [];
  private _isSaving = false;
  private _saveGeneration = 0;
  private _isDirty = false;
  private presentedNodeSessionToken: string | undefined;
  private dirtyRevision = 0;
  private navigationRevision = 0;
  private pendingProperties: Record<string, unknown> | undefined;
  private objectTypeEditorProvider: ObjectTypeEditorProvider;

  constructor(
    private context: vscode.ExtensionContext,
    private treeDataProvider: MetadataTreeDataProvider,
    private typeEditorProvider: TypeEditorProvider,
    private readonly onFormPropertyChanged?: (payload: {
      docUri: string;
      entityType: FormSelectionPayload['entityType'];
      entityId?: string;
      entityName?: string;
      scope: 'property' | 'event';
      key: string;
      value: unknown;
    }) => void,
    private readonly onGotoEventHandler?: (payload: { docUri: string; handlerName: string }) => void,
    private readonly onCreateEventHandler?: (payload: {
      docUri: string;
      elementId: string;
      elementName: string;
      elementTag: string;
      eventName: string;
    }) => void
  ) {
    Logger.info('PropertiesProvider initialized');
    this.objectTypeEditorProvider = new ObjectTypeEditorProvider(context);
    // Store reference for future use (tree refresh will be implemented in later tasks)
    void this.treeDataProvider;
  }

  private _sessionCounter: number = 0;
  private currentSessionToken: string = '';

  private beginNavigation(): number {
    return ++this.navigationRevision;
  }

  private isCurrentNavigation(revision: number): boolean {
    return this.navigationRevision === revision;
  }

  private isSameNodeSession(node: TreeNode, sessionToken: string): boolean {
    return this.currentNode === node && this.currentSessionToken === sessionToken;
  }

  private isCurrentNodeSession(revision: number, node: TreeNode, sessionToken: string): boolean {
    return this.isCurrentNavigation(revision) && this.isSameNodeSession(node, sessionToken);
  }

  private isCurrentDirtySnapshot(snapshot: DirtySessionSnapshot): boolean {
    return this.isSameNodeSession(snapshot.node, snapshot.sessionToken) &&
      this.panel === snapshot.panel &&
      this._isDirty &&
      this.dirtyRevision === snapshot.dirtyRevision;
  }

  private clearDirtyState(): void {
    this._isDirty = false;
    this.pendingProperties = undefined;
    this.dirtyRevision += 1;
  }

  private capturePresentation(): PresentationSnapshot {
    return {
      navigationRevision: this.navigationRevision,
      panel: this.panel,
      node: this.currentNode,
      sessionToken: this.currentSessionToken,
      formSelection: this.currentFormSelection,
      formSelectionRevision: this.currentFormSelectionRevision,
    };
  }

  private isCurrentPresentation(snapshot: PresentationSnapshot): boolean {
    return this.navigationRevision === snapshot.navigationRevision &&
      this.panel === snapshot.panel &&
      this.currentNode === snapshot.node &&
      this.currentSessionToken === snapshot.sessionToken &&
      this.currentFormSelection === snapshot.formSelection &&
      this.currentFormSelectionRevision === snapshot.formSelectionRevision;
  }

  /** Returns true if the properties panel is currently open (created and not disposed). */
  public isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Returns true if there are unsaved property changes in the panel. */
  public isDirty(): boolean {
    return this._isDirty;
  }

  /** Update dirty state and optional unsaved property snapshot. */
  public setIsDirty(
    isDirty: boolean,
    properties?: Record<string, unknown>,
    token?: { nodeId?: string; sessionToken?: string }
  ): void {
    if (!this.currentNode || !this.currentSessionToken) {
      Logger.warn('Ignoring setIsDirty when no active node or session exists');
      return;
    }
    if (token?.nodeId !== undefined && token.nodeId !== this.currentNode.id) {
      Logger.warn(`Ignoring setIsDirty from outdated node ${token.nodeId} (current: ${this.currentNode.id})`);
      return;
    }
    if (token?.sessionToken !== undefined && token.sessionToken !== this.currentSessionToken) {
      Logger.warn(`Ignoring setIsDirty from outdated session ${token.sessionToken} (current: ${this.currentSessionToken})`);
      return;
    }
    this._isDirty = isDirty;
    this.dirtyRevision += 1;
    if (properties) {
      this.pendingProperties = properties;
    } else if (!isDirty) {
      this.pendingProperties = undefined;
    }
  }

  private async promptUnsavedChangesGuard(navigationRevision: number): Promise<boolean> {
    if (!this._isDirty || !this.currentNode) {
      return true;
    }
    const snapshot: DirtySessionSnapshot = {
      node: this.currentNode,
      sessionToken: this.currentSessionToken,
      dirtyRevision: this.dirtyRevision,
      panel: this.panel,
      properties: this.pendingProperties || (this.currentNode.properties as Record<string, unknown>),
    };
    const nodeName = snapshot.node.name || 'Элемент';
    const choice = await vscode.window.showWarningMessage(
      MESSAGES.UNSAVED_CHANGES_PROMPT(nodeName),
      { modal: true },
      MESSAGES.SAVE,
      MESSAGES.DONT_SAVE,
      MESSAGES.CANCEL
    );

    if (!this.isCurrentNavigation(navigationRevision) || !this.isCurrentDirtySnapshot(snapshot)) {
      return false;
    }

    if (choice === MESSAGES.SAVE) {
      if (snapshot.properties) {
        await handleMessage(
          { type: 'save', properties: snapshot.properties },
          this.buildHandlerContext()
        );
      }
      return this.isCurrentNavigation(navigationRevision) &&
        this.isSameNodeSession(snapshot.node, snapshot.sessionToken) &&
        !this._isDirty;
    } else if (choice === MESSAGES.DONT_SAVE) {
      this._isDirty = false;
      this.pendingProperties = undefined;
      this.dirtyRevision += 1;
      return true;
    } else {
      return false;
    }
  }

  /**
   * Update panel content for a new node IF the panel is already open.
   * No-op if the panel has not been created or was closed by the user.
   * Does NOT reveal or focus the panel.
   */
  public async updateIfOpen(node: TreeNode | undefined): Promise<void> {
    const navigationRevision = this.beginNavigation();
    const panel = this.panel;
    if (!this.panel) {
      return;
    }
    if (node === this.currentNode) {
      if (node && this.presentedNodeSessionToken !== this.currentSessionToken) {
        await this.showPropertiesForNavigation(node, navigationRevision, undefined, false);
      }
      return;
    }
    if (this._isDirty && this.currentNode) {
      const canProceed = await this.promptUnsavedChangesGuard(navigationRevision);
      if (!this.isCurrentNavigation(navigationRevision) || this.panel !== panel || !canProceed) {
        return;
      }
    }
    if (!this.isCurrentNavigation(navigationRevision) || this.panel !== panel) {
      return;
    }
    this.currentFormSelection = null;
    this.currentFormSelectionRevision += 1;
    this.currentNode = node;
    this.currentSessionToken = node ? `${node.id || node.name}:${++this._sessionCounter}` : '';
    this.clearDirtyState();
    await this.updateWebviewContent(navigationRevision);
  }

  /**
   * Show properties for a tree node (or empty state when node is undefined)
   * Creates new panel or reuses existing one (singleton pattern)
   */
  public showProperties(node: TreeNode | undefined, options?: { force?: boolean }): Promise<boolean> {
    return this.showPropertiesForNavigation(node, this.beginNavigation(), options);
  }

  private async showPropertiesForNavigation(
    node: TreeNode | undefined,
    navigationRevision: number,
    options?: { force?: boolean },
    revealPanel = true
  ): Promise<boolean> {
    const reuseCurrentSession = Boolean(node && this.currentNode === node && !options?.force);
    if (reuseCurrentSession && this.presentedNodeSessionToken === this.currentSessionToken) {
      if (revealPanel && this.isCurrentNavigation(navigationRevision) && this.panel) {
        this.panel.reveal(vscode.ViewColumn.Beside);
      }
      return true;
    }
    if (this._isDirty && this.currentNode && (this.currentNode !== node || options?.force)) {
      const canProceed = await this.promptUnsavedChangesGuard(navigationRevision);
      if (!this.isCurrentNavigation(navigationRevision) || !canProceed) {
        return false;
      }
    }
    if (!this.isCurrentNavigation(navigationRevision)) {
      return false;
    }
    if (!reuseCurrentSession) {
      this.currentFormSelection = null;
      this.currentFormSelectionRevision += 1;
      this.currentNode = node;
      this.currentSessionToken = node ? `${node.id || node.name}:${++this._sessionCounter}` : '';
      this.clearDirtyState();
    }
    const sessionToken = this.currentSessionToken;

    if (!node) {
      if (!this.panel) {
        this.panel = this.createPanel();
      } else if (revealPanel) {
        this.panel.reveal(vscode.ViewColumn.Beside);
      }
      const panel = this.panel;
      await this.updateWebviewContent(navigationRevision);
      return this.isCurrentNavigation(navigationRevision) && this.panel === panel;
    }

    // Check if this is a .bsl module file - open it as text instead of properties
    if (node.filePath && node.filePath.endsWith('.bsl')) {
      try {
        const uri = vscode.Uri.file(node.filePath);
        await vscode.window.showTextDocument(uri, { preview: false });
        if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
          return false;
        }
        this.presentedNodeSessionToken = sessionToken;
        Logger.info(`Opened .bsl module file: ${node.filePath}`);
        return true;
      } catch (error) {
        if (!this.isCurrentNavigation(navigationRevision) || this.currentNode !== node) {
          return false;
        }
        Logger.error(`Failed to open .bsl file: ${node.filePath}`, error);
        vscode.window.showErrorMessage(`Failed to open module file: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }

    // Create panel if it doesn't exist (singleton pattern)
    if (!this.panel) {
      this.panel = this.createPanel();
    } else if (revealPanel) {
      // Reuse existing panel and reveal it
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
    if (!this.isCurrentNavigation(navigationRevision) || this.currentNode !== node) {
      return false;
    }
    // Update content with new node
    // For nested elements (Attributes), properties are already loaded from XML during parsing
    // Only reload from file for root elements that have a path to read (Configuration → Configuration.xml in configDir; Form → formXmlPath; else filePath).

    // For Form nodes, parse Form.xml and show form-level properties with events
    if (node.type === 'Form' && node.filePath) {
      let formSelection: FormSelectionPayload | undefined;
      try {
        const { getFormPaths } = await import('../formEditor/formPaths');
        if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
          return false;
        }
        const { parseFormXml } = await import('../formEditor/formXmlParser');
        if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
          return false;
        }
        const formXmlPath = getFormPaths(node.filePath).formXmlPath;
        const { isFormParseError } = await import('../formEditor/formModel');
        if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
          return false;
        }
        const parseResult = await parseFormXml(formXmlPath);
        if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
          return false;
        }
        if (!isFormParseError(parseResult)) {
          const model = parseResult.model;
          const formEventsMap: Record<string, string> = {};
          if (model.formEvents) {
            for (const fe of model.formEvents) { formEventsMap[fe.name] = fe.method; }
          }
          // Extract top-level form properties for display
          const formProps: Record<string, unknown> = {};
          for (const field of model.topLevelFields ?? []) {
            if (field && typeof field === 'object') {
              const key = Object.keys(field as object).find(k => k !== ':@' && !k.startsWith('@'));
              if (key) { formProps[key] = (field as Record<string, unknown>)[key]; }
            }
          }
          formSelection = {
            source: 'form-editor',
            docUri: formXmlPath,
            entityType: 'element',
            id: '__form_root__',
            name: node.name,
            tag: 'Form',
            properties: formProps,
            events: formEventsMap,
            selectedIds: ['__form_root__'],
          };
        }
      } catch (error) {
        if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
          return false;
        }
        Logger.error(`Failed to parse Form.xml for tree node ${node.name}`, error);
      }
      if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
        return false;
      }
      if (formSelection) {
        return this.showFormSelectionForNavigation(
          formSelection,
          navigationRevision,
          { node, sessionToken },
          revealPanel
        );
      }
    }

    const pathToRead =
      getConfigurationXmlPathForNode(node, this.treeDataProvider.getConfigPathForNode.bind(this.treeDataProvider)) ??
      node.filePath;

    const targetId = node.id;
    if (pathToRead && !node.parentFilePath) {
      let isReadableFile = false;
      try {
        const stat = await fs.promises.stat(pathToRead);
        if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
          return false;
        }
        isReadableFile = stat.isFile();
      } catch {
        if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
          return false;
        }
        // path doesn't exist — skip reading
      }

      if (isReadableFile) {
        try {
          const { XMLWriter: xmlWriter } = await import('../utils/XMLWriter');
          if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
            return false;
          }
          const xmlProperties = await xmlWriter.readProperties(pathToRead);

          if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken) || this.currentNode?.id !== targetId) {
            return false;
          }

          // Update node properties with fresh data from XML
          node.properties = { ...xmlProperties };

          Logger.debug(`Successfully loaded properties from ${pathToRead}`);
        } catch (error) {
          if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken) || this.currentNode?.id !== targetId) {
            return false;
          }
          // Log detailed error
          Logger.error(`Failed to read properties from ${pathToRead}`, error);

          // Display error in properties panel
          this.showErrorInPanel(
            node,
            `Failed to read properties from file`,
            error instanceof Error ? error.message : String(error)
          );
          return false;
        }
      }
    } else if (
      node.parentFilePath &&
      node.name &&
      node.type &&
      !isContainerNode(node) &&
      node.type !== MetadataType.PredefinedItem
    ) {
      let isReadableFile = false;
      try {
        const stat = await fs.promises.stat(node.parentFilePath);
        if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
          return false;
        }
        isReadableFile = stat.isFile();
      } catch {
        if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
          return false;
        }
        // path doesn't exist
      }

      if (!isReadableFile) {
        if (options?.force) {
          Logger.warn(`Parent file for nested element ${node.name} not readable: ${node.parentFilePath}`);
          this.showErrorInPanel(
            node,
            `Failed to read properties from file`,
            `Parent file not readable: ${node.parentFilePath}`
          );
          return false;
        }
      } else {
        try {
          const { XMLWriter: xmlWriter } = await import('../utils/XMLWriter');
          if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
            return false;
          }
          const { findTabularSectionInstanceForAttributeParent } = await import('../services/elementOperations');
          if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken)) {
            return false;
          }
          const scopedTabularSectionName =
            node.type === MetadataType.Attribute && node.parent
              ? findTabularSectionInstanceForAttributeParent(node.parent)?.name
              : undefined;
          const nestedOptions = node.nestedPath || scopedTabularSectionName
            ? {
                ...(node.nestedPath ? { nestedPath: node.nestedPath } : {}),
                ...(scopedTabularSectionName ? { scopedTabularSectionName } : {}),
              }
            : undefined;

          const xmlProperties = await xmlWriter.readNestedElementProperties(
            node.parentFilePath,
            node.type,
            node.name,
            nestedOptions
          );
          if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken) || this.currentNode?.id !== targetId) {
            return false;
          }
          node.properties = { ...xmlProperties };
          Logger.debug(`Successfully loaded nested properties for ${node.name} from ${node.parentFilePath}`);
        } catch (error) {
          if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken) || this.currentNode?.id !== targetId) {
            return false;
          }
          Logger.error(`Failed to re-read nested properties for ${node.name} from ${node.parentFilePath}`, error);
          this.showErrorInPanel(
            node,
            `Failed to read properties from file`,
            error instanceof Error ? error.message : String(error)
          );
          return false;
        }
      }
    }

    if (!this.isCurrentNodeSession(navigationRevision, node, sessionToken) || this.currentNode?.id !== targetId) {
      return false;
    }
    const panel = this.panel;
    await this.updateWebviewContent(navigationRevision);
    return this.isCurrentNodeSession(navigationRevision, node, sessionToken) && this.panel === panel;
  }

  public async showFormSelectionProperties(
    selection: FormSelectionPayload | undefined
  ): Promise<void> {
    const navigationRevision = this.beginNavigation();
    await this.showFormSelectionForNavigation(selection, navigationRevision);
  }

  private async showFormSelectionForNavigation(
    selection: FormSelectionPayload | undefined,
    navigationRevision: number,
    expectedSource?: { node: TreeNode; sessionToken: string },
    revealPanel = true
  ): Promise<boolean> {
    if (!this.isCurrentNavigation(navigationRevision) ||
        (expectedSource && !this.isSameNodeSession(expectedSource.node, expectedSource.sessionToken))) {
      return false;
    }
    if (this._isDirty && this.currentNode) {
      const canProceed = await this.promptUnsavedChangesGuard(navigationRevision);
      if (!this.isCurrentNavigation(navigationRevision) ||
          (expectedSource && !this.isSameNodeSession(expectedSource.node, expectedSource.sessionToken)) ||
          !canProceed) {
        return false;
      }
    }
    if (!this.isCurrentNavigation(navigationRevision) ||
        (expectedSource && !this.isSameNodeSession(expectedSource.node, expectedSource.sessionToken))) {
      return false;
    }
    this.currentFormSelection = selection ?? null;
    this.currentFormSelectionRevision += 1;
    this.currentNode = undefined;
    this.currentSessionToken = '';
    this.clearDirtyState();
    if (!this.panel) {
      this.panel = this.createPanel();
    } else if (revealPanel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
    const panel = this.panel;
    await this.updateWebviewContent(navigationRevision);
    return this.isCurrentNavigation(navigationRevision) &&
      this.panel === panel &&
      this.currentFormSelection === (selection ?? null);
  }

  /**
   * Returns the file path of the currently shown node (for comparison with watcher events).
   */
  public getCurrentFilePath(): string | undefined {
    if (!this.currentNode) {
      return undefined;
    }
    const p = this.currentNode.parentFilePath || this.currentNode.filePath;
    return p ? path.normalize(p) : undefined;
  }

  /**
   * If the changed file is the current node's file (or parent file), re-read from disk and update the panel.
   * Shows a brief notification that the file was changed externally.
   */
  public async refreshIfCurrentNode(changedFilePath: string): Promise<void> {
    const node = this.currentNode;
    if (!node) {
      return;
    }
    const normalized = path.normalize(changedFilePath);
    const nodePath = node.parentFilePath || node.filePath;
    if (!nodePath || path.normalize(nodePath) !== normalized) {
      return;
    }
    const refreshPromise = this.showProperties(node, { force: true });
    const navigationRevision = this.navigationRevision;
    const refreshed = await refreshPromise;
    if (refreshed && this.isCurrentNavigation(navigationRevision) && this.currentNode === node) {
      vscode.window.showInformationMessage(MESSAGES.FILE_CHANGED_PANEL_REFRESHED);
    }
  }

  /**
   * Notify that a file was changed externally. If it's the current node's file, show prompt to reload.
   */
  public notifyFileChangedExternally(filePath: string): void {
    // Ignore notifications triggered by our own save
    if (this._isSaving) {
      return;
    }
    const normalized = path.normalize(filePath);
    const targetNode = this.currentNode;
    const navigationRevision = this.navigationRevision;
    if (!targetNode || this.getCurrentFilePath() !== normalized) {
      return;
    }
    vscode.window.showInformationMessage(
      MESSAGES.FILE_CHANGED_EXTERNALLY,
      MESSAGES.FILE_CHANGED_UPDATE,
      MESSAGES.FILE_CHANGED_LATER
    ).then((selection) => {
      if (selection === MESSAGES.FILE_CHANGED_UPDATE &&
          this.isCurrentNavigation(navigationRevision) &&
          this.currentNode === targetNode) {
        void this.refreshIfCurrentNode(filePath);
      }
    });
  }

  public beginSave(): number {
    this._isSaving = true;
    return ++this._saveGeneration;
  }

  public endSave(generation: number, delayMs = 600): void {
    if (delayMs <= 0) {
      if (this._saveGeneration === generation) {
        this._isSaving = false;
      }
      return;
    }
    setTimeout(() => {
      if (this._saveGeneration === generation) {
        this._isSaving = false;
      }
    }, delayMs);
  }

  /**
   * Create webview panel with proper configuration
   */
  private createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      '1c-metadata-properties',
      'CDT 41: Properties',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      }
    );

    // Handle panel disposal
    panel.onDidDispose(
      () => {
        if (this.panel === panel) {
          this.dispose();
        }
      },
      null,
      this.disposables
    );

    // Handle messages from webview with runtime validation
    panel.webview.onDidReceiveMessage(
      async (message: unknown) => {
        // Runtime validation of incoming messages
        if (!isValidWebviewMessage(message)) {
          Logger.warn('Received invalid message from webview', message);
          return;
        }
        if (message.sessionToken && message.sessionToken !== this.currentSessionToken) {
          Logger.warn(`Ignoring stale webview message for outdated session ${message.sessionToken} (current: ${this.currentSessionToken})`);
          return;
        }
        if (message.nodeId && message.nodeId !== this.currentNode?.id) {
          Logger.warn(`Ignoring stale webview message for outdated node ${message.nodeId} (current: ${this.currentNode?.id})`);
          return;
        }
        await handleMessage(message, this.buildHandlerContext());
      },
      null,
      this.disposables
    );

    Logger.info('Properties panel created');
    return panel;
  }

  /**
   * Update webview content with current node
   */
  private async updateWebviewContent(navigationRevision = this.navigationRevision): Promise<void> {
    const presentation = this.capturePresentation();
    if (!presentation.panel || !this.isCurrentNavigation(navigationRevision)) {
      return;
    }
    if (presentation.formSelection !== null) {
      if (this.isCurrentNavigation(navigationRevision) && this.isCurrentPresentation(presentation)) {
        presentation.panel.webview.html = getFormSelectionWebviewContent(
          presentation.formSelection,
          presentation.formSelectionRevision
        );
        this.presentedNodeSessionToken = undefined;
      }
      return;
    }
    if (!presentation.node) {
      if (this.isCurrentNavigation(navigationRevision) && this.isCurrentPresentation(presentation)) {
        presentation.panel.webview.html = getEmptyStateContent();
        this.presentedNodeSessionToken = undefined;
      }
      return;
    }

    const targetNode = presentation.node;
    let picture: import('../services/picture/commonPictureResolver').ResolvedPicture | undefined;
    if (targetNode.type === MetadataType.CommonPicture) {
      picture = await resolveCommonPicture(targetNode);
      if (!this.isCurrentNavigation(navigationRevision) || !this.isCurrentPresentation(presentation)) {
        // Discard results that no longer belong to the active navigation and panel.
        return;
      }
    }

    if (!this.isCurrentNavigation(navigationRevision) || !this.isCurrentPresentation(presentation)) {
      return;
    }

    const html = getWebviewContent(targetNode, { picture, sessionToken: presentation.sessionToken });
    presentation.panel.webview.html = html;
    this.presentedNodeSessionToken = presentation.sessionToken;
    Logger.debug(`Properties panel updated for node: ${targetNode.name}`);
  }

  /**
   * Show error message in properties panel
   */
  private showErrorInPanel(node: TreeNode, title: string, details: string): void {
    if (!this.panel) {
      return;
    }
    this.panel.webview.html = getErrorPanelContent(node, title, details);
    if (node === this.currentNode) {
      this.presentedNodeSessionToken = this.currentSessionToken;
    }
    Logger.debug(`Error displayed in properties panel for node: ${node.name}`);
  }

  /**
   * Send message to webview
   */
  private postMessage(message: ExtensionMessage): void {
    if (!this.panel) {
      Logger.warn('Attempted to post message with no active panel');
      return;
    }

    this.panel.webview.postMessage(message).then(
      (success) => {
        if (success) {
          Logger.debug(`Message sent to webview: ${message.type}`);
        } else {
          Logger.warn(`Failed to send message to webview: ${message.type}`);
        }
      },
      (error) => {
        Logger.error(`Error sending message to webview: ${error}`);
      }
    );
  }

  /**
   * Build handler context for message processing
   */
  private buildHandlerContext(): MessageHandlerContext {
    const presentation = this.capturePresentation();
    let expectedDirtyRevision = this.dirtyRevision;
    const isCurrent = (): boolean =>
      this.isCurrentPresentation(presentation) && this.dirtyRevision === expectedDirtyRevision;
    return {
      currentNode: presentation.node,
      currentFormSelection: presentation.formSelection,
      currentFormSelectionRevision: presentation.formSelectionRevision,
      currentSessionToken: presentation.sessionToken,
      isCurrentSession: isCurrent,
      isSaving: this._isSaving,
      treeDataProvider: this.treeDataProvider,
      typeEditorProvider: this.typeEditorProvider,
      objectTypeEditorProvider: this.objectTypeEditorProvider,
      onFormPropertyChanged: this.onFormPropertyChanged
        ? (payload) => { if (isCurrent()) { this.onFormPropertyChanged?.(payload); } }
        : undefined,
      onGotoEventHandler: this.onGotoEventHandler
        ? (payload) => { if (isCurrent()) { this.onGotoEventHandler?.(payload); } }
        : undefined,
      onCreateEventHandler: this.onCreateEventHandler
        ? (payload) => { if (isCurrent()) { this.onCreateEventHandler?.(payload); } }
        : undefined,
      postMessage: (msg) => { if (isCurrent()) { this.postMessage(msg); } },
      updateWebviewContent: () => {
        if (isCurrent()) { void this.updateWebviewContent(this.navigationRevision); }
      },
      setIsSaving: (value) => { if (isCurrent()) { this._isSaving = value; } },
      beginSave: () => isCurrent() ? this.beginSave() : undefined,
      endSave: (generation, delayMs) => this.endSave(generation, delayMs),
      setIsDirty: (isDirty, properties, token) => {
        if (isCurrent()) {
          this.setIsDirty(isDirty, properties, token);
          expectedDirtyRevision = this.dirtyRevision;
        }
      },
    };
  }

  /**
   * Dispose of resources and cleanup
   */
  public dispose(): void {
    Logger.info('Disposing PropertiesProvider');
    this.beginNavigation();

    // Dispose of panel
    const panel = this.panel;
    this.panel = undefined;

    // Dispose of all disposables
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }

    // Clear references
    this.currentNode = undefined;
    this.currentFormSelection = null;
    this.presentedNodeSessionToken = undefined;
    this.currentFormSelectionRevision += 1;
    this.currentSessionToken = '';
    this.clearDirtyState();
    panel?.dispose();
  }
}
