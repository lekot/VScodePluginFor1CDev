import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { MetadataTreeDataProvider } from './treeDataProvider';
import { TypeEditorProvider } from './typeEditorProvider';
import { ObjectTypeEditorProvider } from './objectTypeEditorProvider';
import { MESSAGES } from '../constants/messages';
import { getConfigurationXmlPathForNode } from '../utils/configHelpers';
import * as path from 'path';
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

  /**
   * Show properties for a tree node (or empty state when node is undefined)
   * Creates new panel or reuses existing one (singleton pattern)
   */
  public async showProperties(node: TreeNode | undefined): Promise<void> {
    this.currentFormSelection = null;
    this.currentFormSelectionRevision += 1;
    this.currentNode = node;

    if (!node) {
      if (!this.panel) {
        this.panel = this.createPanel();
      } else {
        this.panel.reveal(vscode.ViewColumn.Beside);
      }
      this.updateWebviewContent();
      return;
    }

    // Check if this is a .bsl module file - open it as text instead of properties
    if (node.filePath && node.filePath.endsWith('.bsl')) {
      try {
        const uri = vscode.Uri.file(node.filePath);
        await vscode.window.showTextDocument(uri, { preview: false });
        Logger.info(`Opened .bsl module file: ${node.filePath}`);
        return;
      } catch (error) {
        Logger.error(`Failed to open .bsl file: ${node.filePath}`, error);
        vscode.window.showErrorMessage(`Failed to open module file: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    // Create panel if it doesn't exist (singleton pattern)
    if (!this.panel) {
      this.panel = this.createPanel();
    } else {
      // Reuse existing panel and reveal it
      this.panel.reveal(vscode.ViewColumn.Beside);
    }

    // Update content with new node
    // For nested elements (Attributes), properties are already loaded from XML during parsing
    // Only reload from file for root elements that have a path to read (Configuration → Configuration.xml in configDir; Form → formXmlPath; else filePath).

    // For Form nodes, parse Form.xml and show form-level properties with events
    if (node.type === 'Form' && node.filePath) {
      try {
        const { getFormPaths } = await import('../formEditor/formPaths');
        const { parseFormXml } = await import('../formEditor/formXmlParser');
        const formXmlPath = getFormPaths(node.filePath).formXmlPath;
        const { isFormParseError } = await import('../formEditor/formModel');
        const parseResult = await parseFormXml(formXmlPath);
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
          await this.showFormSelectionProperties({
            source: 'form-editor',
            docUri: formXmlPath,
            entityType: 'element',
            id: '__form_root__',
            name: node.name,
            tag: 'Form',
            properties: formProps,
            events: formEventsMap,
            selectedIds: ['__form_root__'],
          });
          return;
        }
      } catch (error) {
        Logger.error(`Failed to parse Form.xml for tree node ${node.name}`, error);
      }
    }

    const pathToRead =
      getConfigurationXmlPathForNode(node, this.treeDataProvider.getConfigPathForNode.bind(this.treeDataProvider)) ??
      node.filePath;

    if (pathToRead && !node.parentFilePath) {
      let isReadableFile = false;
      try {
        const stat = await fs.promises.stat(pathToRead);
        isReadableFile = stat.isFile();
      } catch {
        // path doesn't exist — skip reading
      }

      if (isReadableFile) {
        try {
          const { XMLWriter: xmlWriter } = await import('../utils/XMLWriter');
          const xmlProperties = await xmlWriter.readProperties(pathToRead);

          // Update node properties with fresh data from XML
          node.properties = { ...xmlProperties };

          Logger.debug(`Successfully loaded properties from ${pathToRead}`);
        } catch (error) {
          // Log detailed error
          Logger.error(`Failed to read properties from ${pathToRead}`, error);

          // Display error in properties panel
          this.showErrorInPanel(
            node,
            `Failed to read properties from file`,
            error instanceof Error ? error.message : String(error)
          );
          return;
        }
      }
    }
    // For nested elements with parentFilePath, use already loaded properties from node.properties

    this.updateWebviewContent();
  }

  public async showFormSelectionProperties(
    selection: FormSelectionPayload | undefined
  ): Promise<void> {
    this.currentFormSelection = selection ?? null;
    this.currentFormSelectionRevision += 1;
    this.currentNode = undefined;
    if (!this.panel) {
      this.panel = this.createPanel();
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
    this.updateWebviewContent();
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
    await this.showProperties(node);
    vscode.window.showInformationMessage(MESSAGES.FILE_CHANGED_PANEL_REFRESHED);
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
    if (!this.currentNode || this.getCurrentFilePath() !== normalized) {
      return;
    }
    vscode.window.showInformationMessage(
      MESSAGES.FILE_CHANGED_EXTERNALLY,
      MESSAGES.FILE_CHANGED_UPDATE,
      MESSAGES.FILE_CHANGED_LATER
    ).then((selection) => {
      if (selection === MESSAGES.FILE_CHANGED_UPDATE) {
        void this.refreshIfCurrentNode(filePath);
      }
    });
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
        this.dispose();
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
  private updateWebviewContent(): void {
    if (!this.panel) {
      return;
    }
    if (this.currentFormSelection !== null) {
      this.panel.webview.html = getFormSelectionWebviewContent(
        this.currentFormSelection,
        this.currentFormSelectionRevision
      );
      return;
    }
    if (!this.currentNode) {
      this.panel.webview.html = getEmptyStateContent();
      return;
    }

    const html = getWebviewContent(this.currentNode);
    this.panel.webview.html = html;
    Logger.debug(`Properties panel updated for node: ${this.currentNode.name}`);
  }

  /**
   * Show error message in properties panel
   */
  private showErrorInPanel(node: TreeNode, title: string, details: string): void {
    if (!this.panel) {
      return;
    }
    this.panel.webview.html = getErrorPanelContent(node, title, details);
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
    return {
      currentNode: this.currentNode,
      currentFormSelection: this.currentFormSelection,
      currentFormSelectionRevision: this.currentFormSelectionRevision,
      isSaving: this._isSaving,
      treeDataProvider: this.treeDataProvider,
      typeEditorProvider: this.typeEditorProvider,
      objectTypeEditorProvider: this.objectTypeEditorProvider,
      onFormPropertyChanged: this.onFormPropertyChanged,
      onGotoEventHandler: this.onGotoEventHandler,
      onCreateEventHandler: this.onCreateEventHandler,
      postMessage: (msg) => this.postMessage(msg),
      updateWebviewContent: () => this.updateWebviewContent(),
      setIsSaving: (value) => { this._isSaving = value; },
    };
  }

  /**
   * Dispose of resources and cleanup
   */
  public dispose(): void {
    Logger.info('Disposing PropertiesProvider');

    // Dispose of panel
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }

    // Dispose of all disposables
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }

    // Clear references
    this.currentNode = undefined;
  }
}
