import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfigurationMutationEngine } from '../services/configurationSession/ConfigurationMutationEngine';
import { hashContent } from '../services/configurationSession/atomicFileStorage';
import { projectMutationFailure, unwrapMutationReceipt } from '../services/configurationSession/mutationReceiptError';
import { randomUUID } from 'crypto';
import { XMLValidator } from 'fast-xml-parser';
import { RoleModel, type RightsMap } from './models/roleModel';
import type { MetadataObject } from './models/metadataObject';
import {
  WebviewMessage,
  isValidWebviewMessage,
  type ExtensionToWebviewMessage,
  type UiRoleRightProjection,
} from './models/webviewMessage';
import { RoleXmlParser } from './roleXmlParser';
import { RoleXmlSerializer } from './roleXmlSerializer';
import { RightsValidator } from './rightsValidator';
import {
  getRightsPath,
  parseRightsXmlContent,
  mergeRightsIntoDom,
  serializeRightsDomToXml,
  insertRestrictionTemplatesBeforeClosingRights,
} from './rightsXmlEditWriter';
import {
  // loadMetadataObjects,
  loadInitialRoleObjects,
  loadTypeIndexObjects,
  sortMetadataObjects,
  OBJECT_TYPES_FOR_ATTRIBUTE_RIGHTS,
} from './metadataLoader';
import { RolesMetadataLoadSession } from './rolesMetadataLoadSession';
import { FormatDetector } from '../parsers/formatDetector';
import { updateRight } from './rightsUpdateUtils';
import { Logger } from '../utils/logger';
import { escapeJsonForScript } from '../utils/escapeJsonForScript';
import { createNonce } from '../utils/webviewSecurity';
import { FilterState, createDefaultFilterState } from './models/filterState';
import { EditorSessionCoordinator } from '../services/editorSession/editorSessionCoordinator';
import { MetadataType } from '../models/treeNode';
import {
  requireDocumentWriteFormatProfile,
  requireProjectWriteFormatProfile,
} from '../utils/format/formatRank';
import { CONFIGURATION_XML } from '../constants/fileNames';
import { UI_ROLE_RIGHTS } from './roleRightsRegistry';

function getUiRoleRightProjection(): UiRoleRightProjection[] {
  return UI_ROLE_RIGHTS.map((right) => ({
    key: right.key,
    xmlName: right.xmlName,
    label: right.ui!.label,
    applicableTo: right.applicableTo,
    dependencies: right.dependencies,
    clearedBy: right.clearedBy,
    interactiveBase: right.interactiveBase,
  }));
}

/**
 * Walk up directory tree from target path to locate folder containing Configuration.xml.
 */
export function findConfigurationRootForPath(targetPath: string): string | undefined {
  if (!targetPath) {
    return undefined;
  }
  let currentDir = path.dirname(path.resolve(targetPath));
  let previousDir = '';
  while (currentDir !== previousDir) {
    const candidateConfigXml = path.join(currentDir, CONFIGURATION_XML);
    try {
      if (fs.existsSync(candidateConfigXml)) {
        return currentDir;
      }
    } catch {
      // ignore
    }
    previousDir = currentDir;
    currentDir = path.dirname(currentDir);
  }
  return undefined;
}

/**
 * Creates an immutable clone of a RoleModel including its rights map.
 */
export function cloneRoleModel(model: RoleModel): RoleModel {
  const clonedRights: Record<string, import('./models/roleModel').ObjectRights> = {};
  for (const [key, val] of Object.entries(model.rights)) {
    clonedRights[key] = { ...val };
  }
  return {
    name: model.name,
    filePath: model.filePath,
    rights: clonedRights,
    metadata: {
      ...model.metadata,
      lastModified: new Date(model.metadata.lastModified.getTime()),
    },
    restrictionTemplatesText: model.restrictionTemplatesText,
    sourceXml: model.sourceXml,
    changedRights: Object.fromEntries(Object.entries(model.changedRights ?? {})
      .map(([objectName, rights]) => [objectName, { ...rights }])),
  };
}

/**
 * Provider for the roles and rights editor webview
 */
export class RolesRightsEditorProvider {
  private panel: vscode.WebviewPanel | undefined;
  private currentRoleModel: RoleModel | undefined;
  private allObjects: MetadataObject[] = [];
  /** When true, opening had no `configPath` — Save must not write (metadata-only limitation). */
  private saveDisabledNoConfig = false;
  private disposables: vscode.Disposable[] = [];
  private saveInProgress = false;
  private configurationRootPath: string | undefined;
  private sessionExpectedHash: string | undefined;
  private sessionExpectedState: 'missing' | 'file' | undefined;
  /** Incremented on each `show` so stale async metadata loads do not postMessage over a newer session. */
  private readonly sessions = new EditorSessionCoordinator<{ roleFilePath: string; roleModel?: RoleModel }>();

  get sessionGeneration(): number {
    return this.sessions.generation;
  }
  private objectsLoadGeneration = 0;
  private tableRenderStatusDisposable: vscode.Disposable | undefined;
  private activeSessionId: string | undefined;
  private currentLoadSession: RolesMetadataLoadSession | undefined;
  private currentDataRevision = 0;
  private activeSearchQueryId = 0;
  private isTypeIndexComplete = false;
  private typeIndexError: string | undefined;

  private typeIndexWaiters: Array<() => void> = [];
  /** Server-side mirror of the webview filter state — survives webview reloads. */
  private filterState: FilterState = createDefaultFilterState();
  /** Pending `requestSavePayload` → webview `savePayload` round-trips (external save / Ctrl+S). */
  private pendingSavePayloadRequests = new Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private context: vscode.ExtensionContext) {
    Logger.info('RolesRightsEditorProvider initialized');
  }

  /**
   * Resolve path to rolesEditorWebview.html.
   * Primary: next to the compiled JS (works in both VSIX production and `out/` dev builds when the file is copied).
   * Fallback: extensionUri-based path for cases where __dirname differs from the extension root layout.
   */
  private resolveRolesEditorWebviewHtmlPath(): string {
    const primary = path.join(__dirname, 'rolesEditorWebview.html');
    if (fs.existsSync(primary)) {
      return primary;
    }
    const fallback = path.join(
      this.context.extensionUri.fsPath,
      'dist',
      'rolesEditor',
      'rolesEditorWebview.html'
    );
    if (fs.existsSync(fallback)) {
      return fallback;
    }
    Logger.warn(`rolesEditorWebview.html not found; falling back to ${primary}`);
    return primary;
  }

  /** Returns true if the rights editor panel is currently open (created and not disposed). */
  public isOpen(): boolean {
    return this.panel !== undefined;
  }

  /**
   * Update panel content for a new role node IF the panel is already open.
   * No-op if the panel has not been created or was closed by the user.
   * Does NOT reveal or focus the panel.
   */
  public async updateIfOpen(node: import('../models/treeNode').TreeNode): Promise<void> {
    if (!this.panel || !node.filePath) {
      return;
    }
    const configPath = findConfigurationRootForPath(node.filePath);
    await this.show(node.filePath, configPath, { suppressReveal: true });
  }

  /**
   * Open the rights editor for a specific role file
   * @param roleFilePath Path to the Role.xml file
   * @param configPath Optional configuration path - if provided, skips the search for configuration root
   * @param options Internal options (suppressReveal: skip panel.reveal when panel already exists)
   */
  public async show(roleFilePath: string, configPath?: string | null, options?: { suppressReveal?: boolean }): Promise<void> {
    const loadGeneration = ++this.objectsLoadGeneration;
    try {
      // Parse the role XML file
      const roleModel = await RoleXmlParser.parseRoleXml(roleFilePath);
      if (loadGeneration !== this.objectsLoadGeneration) {
        return;
      }
      const session = this.sessions.begin({ panel: this.panel, target: { roleFilePath, roleModel } });
      this.currentRoleModel = roleModel;
      const isCaseB = path.basename(roleFilePath).toLowerCase() === 'role.xml';
      const initialTargetPath = isCaseB ? roleFilePath : getRightsPath(roleFilePath);
      try {
        const initialRaw = await fs.promises.readFile(initialTargetPath, 'utf8');
        this.sessionExpectedState = 'file';
        this.sessionExpectedHash = hashContent(initialRaw);
      } catch {
        this.sessionExpectedState = 'missing';
        this.sessionExpectedHash = undefined;
      }
      Logger.info(`Loaded role: ${this.currentRoleModel.name}`);

      // Create or reveal webview panel immediately; load metadata in the background
      if (!this.panel) {
        this.panel = this.createPanel();
      } else if (!options?.suppressReveal) {
        this.panel.reveal(vscode.ViewColumn.Beside);
      }
      this.panel.title = `Rights: ${this.currentRoleModel.name}`;
      session.panel = this.panel;

      this.allObjects = [];
      await this.updateWebviewContent({ initialTableLoading: true });

      const resolvedConfigPath = (configPath && configPath.trim().length > 0)
        ? configPath
        : findConfigurationRootForPath(roleFilePath);

      if (!resolvedConfigPath) {
        this.saveDisabledNoConfig = true;
        this.configurationRootPath = undefined;
        Logger.warn('Configuration path not found, showing read-only mode');
        if (loadGeneration !== this.objectsLoadGeneration) {
          return;
        }
        this.sendMessageToWebview({
          command: 'objectsLoaded',
          data: {
            objects: [] as MetadataObject[],
            uiRights: getUiRoleRightProjection(),
            error:
              'No configuration path is available. The metadata table is empty and saving rights to disk is disabled.',
            saveDisabled: true,
          },
        });
        return;
      }

      this.saveDisabledNoConfig = false;
      this.configurationRootPath = resolvedConfigPath;

      try {
        /* const objects = await loadMetadataObjects(
          roleFilePath,
          this.currentRoleModel.rights,
          resolvedConfigPath
        );
        if (loadGeneration !== this.objectsLoadGeneration) {
          return;
        }
        this.allObjects = objects;
        Logger.info(`Loaded ${this.allObjects.length} metadata objects`);
        this.sendMessageToWebview({
          command: 'objectsLoaded',
          data: { objects: this.allObjects, uiRights: getUiRoleRightProjection() },
        }); */
        const format = await FormatDetector.detect(resolvedConfigPath);
        if (loadGeneration !== this.objectsLoadGeneration) {
          return;
        }
        this.currentLoadSession?.dispose();
        const sessionId = session.id;
        this.activeSessionId = sessionId;
        this.isTypeIndexComplete = false;
        this.typeIndexError = undefined;
        this.notifyTypeIndexComplete();
        const loadSession = new RolesMetadataLoadSession(
          sessionId,
          this.sessionGeneration,
          resolvedConfigPath,
          format
        );
        this.currentLoadSession = loadSession;

        const initialObjects = await loadInitialRoleObjects(
          this.currentRoleModel,
          resolvedConfigPath
        );
        if (loadGeneration !== this.objectsLoadGeneration || this.activeSessionId !== sessionId) {
          return;
        }
        this.allObjects = initialObjects;
        this.currentDataRevision = 1;
        Logger.info(`Loaded ${this.allObjects.length} initial role objects for session ${sessionId}`);
        this.sendMessageToWebview({
          command: 'objectsLoaded',
          data: {
            sessionId,
            dataRevision: this.currentDataRevision,
            phase: 'initial',
            isIndexComplete: false,
            objects: this.allObjects,
            uiRights: getUiRoleRightProjection(),
          },
        });

        const targetRights = this.currentRoleModel.rights;
        void (async () => {
          try {
            const indexed = await loadTypeIndexObjects(resolvedConfigPath, targetRights);
            if (loadSession.isCancelled() || this.activeSessionId !== sessionId) {
              return;
            }
            const existingMap = new Map<string, MetadataObject>(this.allObjects.map((o) => [o.fullName, o]));
            for (const obj of indexed) {
              if (!existingMap.has(obj.fullName)) {
                existingMap.set(obj.fullName, obj);
              }
            }
            const merged = Array.from(existingMap.values());
            sortMetadataObjects(merged);
            if (loadSession.isCancelled() || this.activeSessionId !== sessionId) {
              return;
            }
            this.allObjects = merged;
            this.currentDataRevision++;
            this.isTypeIndexComplete = true;
            this.typeIndexError = undefined;
            this.sendMessageToWebview({
              command: 'objectsLoaded',
              data: {
                sessionId,
                dataRevision: this.currentDataRevision,
                phase: 'index',
                isIndexComplete: true,
                objects: this.allObjects,
                uiRights: getUiRoleRightProjection(),
              },
            });
            this.notifyTypeIndexComplete();
          } catch (indexErr) {
            if (loadSession.isCancelled() || this.activeSessionId !== sessionId) {
              return;
            }
            Logger.error('Failed to index metadata objects for rights editor', indexErr);
            this.isTypeIndexComplete = true;
            this.typeIndexError = indexErr instanceof Error ? indexErr.message : String(indexErr);
            this.notifyTypeIndexComplete();
          }
        })();
      } catch (loadErr) {
        if (loadGeneration !== this.objectsLoadGeneration) {
          return;
        }
        Logger.error('Failed to load metadata objects for rights editor', loadErr);
        this.allObjects = [];
        const message = loadErr instanceof Error ? loadErr.message : String(loadErr);
        this.sendMessageToWebview({
          command: 'objectsLoaded',
          data: {
            sessionId: this.activeSessionId,
            dataRevision: ++this.currentDataRevision,
            phase: 'initial',
            isIndexComplete: false,
            objects: [] as MetadataObject[],
            uiRights: getUiRoleRightProjection(),
            error: message,
          },
        });
      }
    } catch (error) {
      Logger.error('Failed to open rights editor', error);
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to open rights editor: ${message}`);
      throw error;
    }
  }

  /**
   * Create the webview panel
   */
  private createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      '1c-rights-editor',
      `Rights: ${this.currentRoleModel?.name || 'Role'}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      }
    );

    // Set up event handlers
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(
      async (message: unknown) => {
        await this.handleMessage(message);
      },
      null,
      this.disposables
    );

    Logger.info('Rights editor panel created');
    return panel;
  }

  /**
   * Update the webview content
   */
  private async updateWebviewContent(options?: { initialTableLoading?: boolean }): Promise<void> {
    if (!this.panel || !this.currentRoleModel) {
      return;
    }

    this.panel.webview.html = await this.getWebviewContent(options?.initialTableLoading === true);
    Logger.debug('Rights editor panel updated');
  }

  /**
   * Generate the webview HTML content
   */
  private async getWebviewContent(initialTableLoading = false): Promise<string> {
    if (!this.currentRoleModel) {
      return this.getErrorHtml('No role model loaded');
    }

    const htmlPath = this.resolveRolesEditorWebviewHtmlPath();
    let html = await fs.promises.readFile(htmlPath, 'utf8');
    const nonce = createNonce();
    html = html.replace(/\$\{nonce\}/g, nonce);

    // Prepare data to inject
    const roleDataJson = escapeJsonForScript(
      JSON.stringify({
        name: this.currentRoleModel.name,
        rights: this.currentRoleModel.rights,
        restrictionTemplatesText: this.currentRoleModel.restrictionTemplatesText ?? '',
        uiRights: getUiRoleRightProjection(),
      })
    );

    const objectsJson = escapeJsonForScript(JSON.stringify(this.allObjects));
    const loadingFlag = initialTableLoading ? 'true' : 'false';
    const filterStateJson = escapeJsonForScript(JSON.stringify({
      showAll: this.filterState.showAll,
      searchQuery: this.filterState.searchQuery,
      // typeFilter in the webview is a plain string (single type or ''); convert back
      typeFilter: this.filterState.typeFilter.length > 0 ? this.filterState.typeFilter[0] : '',
    }));

    // Inject data into the script (match line ending \n or \r\n)
    html = html.replace(
      /\s*\/\/ Request initial data\s*vscode\.postMessage\(\s*\{\s*command:\s*'ready'\s*\}\s*\)\s*;/,
      ` roleData = ${roleDataJson};
            allObjects = ${objectsJson};
            tableInitialLoading = ${loadingFlag};
            filterState = ${filterStateJson};
            currentSessionId = ${JSON.stringify(this.activeSessionId ?? '')};
            currentDataRevision = ${this.currentDataRevision};
            beginRightsEditorSession();`
    );

    return html;
  }

  /**
   * Handle messages from the webview
   */
  private async handleMessage(message: unknown): Promise<void> {
    if (!this.isValidWebviewMessage(message)) {
      Logger.warn('Received invalid message from webview', message);
      return;
    }

    try {
      if (message.command === 'save') {
        Logger.debug('Received save command from webview');
      }
      switch (message.command) {
        case 'updateRight':
          await this.handleUpdateRight(message);
          break;
        case 'save':
          await this.handleSave(message);
          break;
        case 'cancel':
          await this.handleCancel();
          break;
        case 'toggleFilter':
          await this.handleToggleFilter(message);
          break;
        case 'search':
          await this.handleSearch(message);
          break;
        case 'filterByType':
          await this.handleFilterByType(message);
          break;
        case 'tableRenderProgress':
          this.handleTableRenderProgress(message);
          break;
        case 'savePayload':
          this.handleSavePayloadResponse(message);
          break;
        case 'loadObjectAttributes':
          await this.handleLoadObjectAttributes(message);
          break;
        case 'cancelSearch':
          this.handleCancelSearch(message);
          break;
        default:
          Logger.warn(`Unknown command: ${message.command}`);
      }
    } catch (error) {
      Logger.error('Error handling message', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendMessageToWebview({
        command: 'error',
        data: { message: errorMessage },
      });
    }
  }

  /**
   * Handle on-demand loading of object attribute rights rows.
   */
  private async handleLoadObjectAttributes(message: WebviewMessage): Promise<void> {
    const sessionId = message.data?.sessionId;
    const requestId = message.data?.requestId;
    const objectFullName = message.data?.objectFullName;

    if (!sessionId || !requestId || !objectFullName) {
      Logger.warn('Invalid loadObjectAttributes message: missing sessionId, requestId, or objectFullName');
      return;
    }

    if (sessionId !== this.activeSessionId || !this.currentLoadSession || !this.currentRoleModel) {
      Logger.debug(`Ignoring loadObjectAttributes for non-active session: ${sessionId}`);
      return;
    }

    try {
      const attributes = await this.currentLoadSession.loadObjectAttributes(
        objectFullName,
        this.currentRoleModel.rights
      );

      if (this.activeSessionId !== sessionId) {
        return;
      }

      const target = this.allObjects.find((o) => o.fullName === objectFullName);
      if (target) {
        target.attributesState = 'loaded';
        target.attributes = attributes;
      }

      this.sendMessageToWebview({
        command: 'loadObjectAttributesResult',
        data: {
          sessionId,
          requestId,
          objectFullName,
          state: 'loaded',
          attributes,
        },
      });
    } catch (err) {
      if (this.activeSessionId !== sessionId) {
        return;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      const target = this.allObjects.find((o) => o.fullName === objectFullName);
      if (target) {
        target.attributesState = 'failed';
        target.attributesError = errorMessage;
      }

      this.sendMessageToWebview({
        command: 'loadObjectAttributesResult',
        data: {
          sessionId,
          requestId,
          objectFullName,
          state: 'failed',
          attributes: [],
          error: errorMessage,
        },
      });
    }
  }

  /**
   * Handle updateRight message
   */
  private async handleUpdateRight(message: WebviewMessage): Promise<void> {
    if (!this.currentRoleModel || !message.data) {
      return;
    }

    const { objectName, rightType, value } = message.data;
    if (!objectName || !rightType || value === undefined) {
      Logger.warn('Invalid updateRight message data');
      return;
    }

    // Update the right
    const result = updateRight(
      this.currentRoleModel,
      objectName,
      rightType,
      value
    );

    if (result.success) {
      // Webview already re-rendered; avoid full HTML rebuild (freezes UI on large configs).
      this.sendMessageToWebview({
        command: 'updateSuccess',
        data: {},
      });
    } else {
      this.sendMessageToWebview({
        command: 'updateError',
        data: { errors: result.errors },
      });
    }
  }

  /**
   * Trigger save from extension (e.g. command palette or keybinding).
   * `handleSave` flushes RLS from the webview when the payload has no `restrictionTemplatesText`.
   */
  public async triggerSave(): Promise<void> {
    await this.handleSave();
  }

  /**
   * Ask the webview for a single read of `#rlsTemplates` (correlation via `requestId`).
   */
  private flushRestrictionTemplatesFromWebview(): Promise<string> {
    if (!this.panel) {
      return Promise.reject(new Error('Rights editor panel is not available'));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingSavePayloadRequests.get(requestId);
        if (pending) {
          this.pendingSavePayloadRequests.delete(requestId);
          pending.reject(new Error('Timed out waiting for RLS from webview'));
        }
      }, 10000);
      this.pendingSavePayloadRequests.set(requestId, { resolve, reject, timeout });
      this.sendMessageToWebview({
        command: 'requestSavePayload',
        data: { requestId },
      });
    });
  }

  private handleSavePayloadResponse(message: WebviewMessage): void {
    const requestId = message.data?.requestId;
    const text = message.data?.restrictionTemplatesText;
    if (typeof requestId !== 'string' || !requestId) {
      return;
    }
    const pending = this.pendingSavePayloadRequests.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingSavePayloadRequests.delete(requestId);
    pending.resolve(typeof text === 'string' ? text : '');
  }

  /**
   * Handle save message
   * Case B: filePath is Role.xml → serialize with RoleXmlSerializer, write to filePath.
   * Case A: otherwise → rights in Ext/Rights.xml; load, merge, serialize, write to rightsPath.
   */
  private async handleSave(message?: WebviewMessage): Promise<void> {
    if (this.saveInProgress) {
      Logger.warn('handleSave skipped: save already in progress');
      void vscode.window.showInformationMessage('Save already in progress.');
      return;
    }
    if (this.saveDisabledNoConfig) {
      const msg =
        'Save is disabled: no configuration path was set when this editor was opened.';
      vscode.window.showWarningMessage(msg);
      this.sendMessageToWebview({ command: 'saveError', data: { message: msg } });
      return;
    }
    Logger.debug('handleSave called');
    if (!this.currentRoleModel) {
      const msg = 'Role not loaded. Close and reopen the rights editor.';
      vscode.window.showErrorMessage(msg);
      this.sendMessageToWebview({ command: 'saveError', data: { message: msg } });
      return;
    }

    this.saveInProgress = true;
    const targetGeneration = this.sessionGeneration;
    const targetRoleModel = this.currentRoleModel;
    let statusDone: vscode.Disposable | undefined;
    try {
      let effectiveMessage: WebviewMessage | undefined = message;
      if (this.panel && typeof message?.data?.restrictionTemplatesText !== 'string') {
        try {
          const rls = await this.flushRestrictionTemplatesFromWebview();
          effectiveMessage = { command: 'save', data: { ...message?.data, restrictionTemplatesText: rls } };
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          Logger.error('Failed to read RLS from webview', e);
          const full = `Could not read RLS from editor: ${errMsg}`;
          vscode.window.showErrorMessage(full);
          this.sendMessageToWebview({ command: 'saveError', data: { message: full } });
          return;
        }
      }
      if (this.sessionGeneration !== targetGeneration || this.currentRoleModel !== targetRoleModel) {
        Logger.warn(
          `Discarding stale rights save request: active generation ${this.sessionGeneration} does not match target generation ${targetGeneration}`
        );
        return;
      }

      const rls = effectiveMessage?.data?.restrictionTemplatesText;
      if (typeof rls === 'string') {
        targetRoleModel.restrictionTemplatesText = rls;
      }

      statusDone = vscode.window.setStatusBarMessage('Saving rights...');
      Logger.debug('handleSave: validation starting');
      const validator = new RightsValidator();
      const validationResult = validator.validateRights(targetRoleModel);

      if (!validationResult.isValid) {
        Logger.warn(`handleSave: validation failed: ${validationResult.errors.join('; ')}`);
        this.sendMessageToWebview({
          command: 'validationError',
          data: { errors: validationResult.errors },
        });
        const saveAnyway = await vscode.window.showWarningMessage(
          `Validation failed (${validationResult.errors.length} issue(s)). Save anyway?`,
          { modal: true },
          'Save anyway',
          'Cancel'
        );
        if (this.sessionGeneration !== targetGeneration || this.currentRoleModel !== targetRoleModel) {
          Logger.warn(
            `Discarding stale rights save request: active generation ${this.sessionGeneration} does not match target generation ${targetGeneration}`
          );
          return;
        }
        if (saveAnyway !== 'Save anyway') {
          this.sendMessageToWebview({
            command: 'validationCancelled',
            data: { message: 'Save cancelled after validation.' },
          });
          return;
        }
        Logger.debug('handleSave: user chose Save anyway, skipping validation');
      } else {
        Logger.debug('handleSave: validation passed, resolving target path');
      }
      if (this.sessionGeneration !== targetGeneration || this.currentRoleModel !== targetRoleModel) {
        Logger.warn(
          `Discarding stale rights save request: active generation ${this.sessionGeneration} does not match target generation ${targetGeneration}`
        );
        return;
      }
      const isCaseB = path.basename(targetRoleModel.filePath).toLowerCase() === 'role.xml';
      const targetPath = isCaseB
        ? targetRoleModel.filePath
        : getRightsPath(targetRoleModel.filePath);



      const snapshotRoleModel = cloneRoleModel(targetRoleModel);
      const snapshotExpectedHash = this.sessionExpectedHash;
      const snapshotExpectedState = this.sessionExpectedState;
      const snapshotRootPath = this.configurationRootPath ?? path.dirname(targetPath);

      Logger.debug(`Save target: ${targetPath}`);





















      const receipt = await getConfigurationMutationEngine().transformFile(
        targetPath,
        {
          kind: 'rolesRights.save',
          resourcePath: targetPath,
          expectedRevision: snapshotExpectedState === 'file'
            ? snapshotExpectedHash
            : snapshotExpectedState === 'missing'
              ? null
              : undefined,
          session: { id: targetPath, generation: targetGeneration },
        },
        async (state) => {
          if (isCaseB && !state.exists) {
            throw new Error(`Конфликт сохранения: файл роли "${targetPath}" был удален другим процессом.`);
          }
          if (!isCaseB && snapshotExpectedState === 'missing' && state.exists) {
            throw new Error(`Конфликт сохранения: файл прав роли "${targetPath}" был создан другим процессом.`);
          }
          if (!isCaseB && snapshotExpectedState === 'file' && !state.exists) {
            throw new Error(`Конфликт сохранения: файл прав роли "${targetPath}" был удален другим процессом.`);
          }
          if (snapshotExpectedState === undefined) {
            throw new Error(`Конфликт сохранения: ревизия файла "${targetPath}" не зафиксирована для текущего сеанса.`);
          }

          const targetVersion = await this.resolveRoleWriteVersion(
            state.exists ? state.content : undefined,
            snapshotRootPath,
          );
          let xmlContent: string;
          if (isCaseB) {
            const currentRoleModel = { ...snapshotRoleModel, sourceXml: state.content };
            xmlContent = RoleXmlSerializer.mergeExistingDesignerRoleXml(currentRoleModel, targetVersion);
            Logger.debug('Serialized (Case B)');
          } else {
            Logger.debug('Parsing engine Rights.xml snapshot...');
            const dom = parseRightsXmlContent(state.content, targetVersion);
            Logger.debug('Merging rights into DOM...');
            const compactWrite = vscode.workspace
              .getConfiguration('1cMetadataTree')
              .get<boolean>('rightsEditor.compactRightsWrite', true);
            mergeRightsIntoDom(dom, snapshotRoleModel.changedRights ?? {}, { compactWrite });
            Logger.debug('Serializing DOM to XML...');
            xmlContent = serializeRightsDomToXml(dom, targetVersion);
            xmlContent = insertRestrictionTemplatesBeforeClosingRights(
              xmlContent,
              snapshotRoleModel.restrictionTemplatesText ?? ''
            );
          }

          const validation = XMLValidator.validate(xmlContent);
          if (validation !== true) {
            const detail = typeof validation === 'object' && validation?.err?.msg
              ? `: ${validation.err.msg}`
              : '';
            throw new Error(`Не удалось сохранить права роли: невалидный XML${detail}`);
          }

          return { content: xmlContent, result: xmlContent };
        },
      );

      let failureMessage: string | undefined;
      if (receipt.status === 'conflict') {
        if (receipt.code === 'STALE_TARGET_REVISION') {
          const kind = isCaseB ? 'файл роли' : 'файл прав роли';
          const reason = snapshotExpectedState === 'missing'
            ? 'был создан другим процессом'
            : receipt.oldRevision === undefined
              ? 'был удален другим процессом'
              : 'был изменен другим процессом';
          failureMessage = `Конфликт сохранения: ${kind} "${targetPath}" ${reason}.`;
        } else {
          failureMessage = `Конфликт сохранения прав роли: ${receipt.message ?? receipt.code ?? 'неизвестная причина'}`;
        }
      } else if (receipt.status !== 'committed') {
        failureMessage = `Ошибка записи файла прав роли: ${receipt.message ?? receipt.code ?? receipt.status}`;
      }
      unwrapMutationReceipt(receipt, failureMessage);

      if (this.sessionGeneration === targetGeneration) {
        this.sessionExpectedHash = receipt.newRevision;
        this.sessionExpectedState = 'file';
      }

















      Logger.debug('Rights saved successfully');
      vscode.window.showInformationMessage('Rights saved successfully');

      if (this.panel && this.sessionGeneration === targetGeneration) {
        this.panel.dispose();
      }
    } catch (error) {
      const failureProjection = projectMutationFailure(error);
      const message = failureProjection?.message ?? (error instanceof Error ? error.message : String(error));
      const stack = error instanceof Error ? error.stack : undefined;
      Logger.error(`Failed to save rights: ${message}`, stack ? { stack } : error);
      vscode.window.showErrorMessage(`Failed to save rights: ${message}`);
      if (this.sessionGeneration === targetGeneration) {
        this.sendMessageToWebview({
        command: 'saveError',
        data: failureProjection ?? { message },
      });
      }
      throw error;
    } finally {
      statusDone?.dispose();
      this.saveInProgress = false;
    }
  }

  /**
   * Handle cancel message
   */
  private async handleCancel(): Promise<void> {
    Logger.info('Rights editor cancelled');
    if (this.panel) {
      this.panel.dispose();
    }
  }

  /** Resolve from the engine snapshot, or the owning project profile for a missing Rights.xml. */
  private async resolveRoleWriteVersion(currentContent: string | undefined, rootPath?: string): Promise<string> {
    if (currentContent !== undefined) {
      return requireDocumentWriteFormatProfile(currentContent).version;
    }
    const resolvedRoot = rootPath ?? this.configurationRootPath;
    if (!resolvedRoot) {
      throw new Error('Не удалось определить Configuration.xml для создания файла прав.');
    }
    const configuration = await fs.promises.readFile(
      path.join(resolvedRoot, CONFIGURATION_XML),
      'utf8'
    );
    return requireProjectWriteFormatProfile(configuration).version;
  }

  /**
   * Handle toggleFilter message — mirrors showAll into server-side filterState.
   */
  private async handleToggleFilter(message: WebviewMessage): Promise<void> {
    if (typeof message.data?.showAll === 'boolean') {
      this.filterState.showAll = message.data.showAll;
      Logger.debug(`handleToggleFilter: showAll=${this.filterState.showAll}`);
    }
  }

  /**
   * Handle search message — mirrors searchQuery and coordinates background attribute search.
   */
  private notifyTypeIndexComplete(): void {
    const waiters = this.typeIndexWaiters;
    this.typeIndexWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private waitForTypeIndexOrCancel(sessionId: string, queryId: number): Promise<void> {
    if (this.isTypeIndexComplete || this.activeSessionId !== sessionId || this.activeSearchQueryId !== queryId) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.typeIndexWaiters.push(resolve);
    });
  }

  private async handleSearch(message: WebviewMessage): Promise<void> {
    if (typeof message.data?.query === 'string') {
      this.filterState.searchQuery = message.data.query;
      Logger.debug(`handleSearch: searchQuery="${this.filterState.searchQuery}"`);
    }

    const sessionId = message.data?.sessionId;
    const queryId = message.data?.queryId ?? 0;
    const query = (message.data?.query ?? '').trim().toLowerCase();

    if (!sessionId || sessionId !== this.activeSessionId || !this.currentLoadSession || !this.currentRoleModel) {
      return;
    }

    this.activeSearchQueryId = queryId;


    if (!query || query.length < 2) {
      return;
    }

    const session = this.currentLoadSession;
    const currentRights = this.currentRoleModel.rights;

    void this.executeSearch(sessionId, queryId, query, session, currentRights);
  }

  private async executeSearch(
    sessionId: string,
    queryId: number,
    query: string,
    session: RolesMetadataLoadSession,
    currentRights: RightsMap
  ): Promise<void> {
    const matchingObjectNames: string[] = [];
    const matchedSet = new Set<string>();

    for (const obj of this.allObjects) {
      if (
        OBJECT_TYPES_FOR_ATTRIBUTE_RIGHTS.includes(obj.type as MetadataType) &&
        obj.rowKind !== 'attribute' &&
        obj.rowKind !== 'configurationRoot' &&
        obj.attributesState === 'loaded' &&
        Array.isArray(obj.attributes)
      ) {
        const hasMatchingAttr = obj.attributes.some(
          (a) =>
            a.name.toLowerCase().includes(query) ||
            (a.displayName && a.displayName.toLowerCase().includes(query))
        );
        if (hasMatchingAttr && !matchedSet.has(obj.fullName)) {
          matchedSet.add(obj.fullName);
          matchingObjectNames.push(obj.fullName);
          this.sendMessageToWebview({
            command: 'loadObjectAttributesResult',
            data: {
              sessionId,
              requestId: `cached-search-${queryId}-${obj.fullName}`,
              objectFullName: obj.fullName,
              state: 'loaded',
              attributes: obj.attributes,
            },
          });
        }
      }
    }

    if (matchingObjectNames.length > 0) {
      this.sendMessageToWebview({
        command: 'searchProgress',
        data: {
          sessionId,
          queryId,
          state: 'running',
          processed: 0,
          total: this.allObjects.length,
          matchingObjectNames: [...matchingObjectNames],
        },
      });
    }

    let processed = 0;
    let hasSearchErrors = false;
    const attemptedInQuery = new Set<string>();

    while (!session.isCancelled() && this.activeSessionId === sessionId && this.activeSearchQueryId === queryId) {
      if (session.isCancelled() || this.activeSessionId !== sessionId || this.activeSearchQueryId !== queryId) {
        this.sendMessageToWebview({
          command: 'searchProgress',
          data: {
            sessionId,
            queryId,
            state: 'cancelled',
          },
        });
        return;
      }

      const nextObj = this.allObjects.find(
        (o) =>
          OBJECT_TYPES_FOR_ATTRIBUTE_RIGHTS.includes(o.type as MetadataType) &&
          o.rowKind !== 'attribute' &&
          o.rowKind !== 'configurationRoot' &&
          o.attributesState !== 'loaded' &&
          !attemptedInQuery.has(o.fullName)
      );

      if (nextObj) {
        attemptedInQuery.add(nextObj.fullName);
        nextObj.attributesState = 'loading';
        try {
          const attrs = await session.loadObjectAttributes(nextObj.fullName, currentRights);
          processed++;
          nextObj.attributesState = 'loaded';
          nextObj.attributes = attrs;

          const hasMatchingAttr = attrs.some(
            (a) =>
              a.name.toLowerCase().includes(query) ||
              (a.displayName && a.displayName.toLowerCase().includes(query))
          );

          if (hasMatchingAttr) {
            if (!matchedSet.has(nextObj.fullName)) {
              matchedSet.add(nextObj.fullName);
              matchingObjectNames.push(nextObj.fullName);
            }
            this.sendMessageToWebview({
              command: 'loadObjectAttributesResult',
              data: {
                sessionId,
                requestId: `search-${queryId}-${nextObj.fullName}`,
                objectFullName: nextObj.fullName,
                state: 'loaded',
                attributes: attrs,
              },
            });
            this.sendMessageToWebview({
              command: 'searchProgress',
              data: {
                sessionId,
                queryId,
                state: 'running',
                processed,
                total: processed,
                matchingObjectNames: [nextObj.fullName],
              },
            });
          }
        } catch (err) {
          hasSearchErrors = true;
          nextObj.attributesState = 'failed';
          nextObj.attributesError = err instanceof Error ? err.message : String(err);
          Logger.debug(`Search failed to load attributes for ${nextObj.fullName}`, err);
        }
        continue;
      }

      if (!this.isTypeIndexComplete) {
        await this.waitForTypeIndexOrCancel(sessionId, queryId);
        continue;
      }

      break;
    }

    if (!session.isCancelled() && this.activeSessionId === sessionId && this.activeSearchQueryId === queryId) {
      const hasFailedInScope = this.allObjects.some(
        (o) =>
          OBJECT_TYPES_FOR_ATTRIBUTE_RIGHTS.includes(o.type as MetadataType) &&
          o.rowKind !== 'attribute' &&
          o.rowKind !== 'configurationRoot' &&
          o.attributesState === 'failed'
      );
      const finalState = hasSearchErrors || this.typeIndexError || hasFailedInScope ? 'incomplete' : 'complete';
      this.sendMessageToWebview({
        command: 'searchProgress',
        data: {
          sessionId,
          queryId,
          state: finalState,
          processed,
          total: processed,
          matchingObjectNames,
        },
      });
    }
  }

  /*
      (o) =>
        OBJECT_TYPES_FOR_ATTRIBUTE_RIGHTS.includes(o.type as MetadataType) &&
        o.rowKind !== 'attribute' &&
        o.rowKind !== 'configurationRoot' &&
        o.attributesState !== 'loaded'
    );

    if (candidateObjects.length === 0) {
      return;
    }

    void (async () => {
      const matchingObjectNames: string[] = [];
      let processed = 0;

      for (const obj of candidateObjects) {
        if (session.isCancelled() || this.activeSessionId !== sessionId || this.activeSearchQueryId !== queryId) {
          this.sendMessageToWebview({
            command: 'searchProgress',
            data: {
              sessionId,
              queryId,
              state: 'cancelled',
            },
          });
          return;
        }

        try {
          const attrs = await session.loadObjectAttributes(obj.fullName, currentRights);
          processed++;
          obj.attributesState = 'loaded';
          obj.attributes = attrs;

          const hasMatchingAttr = attrs.some(
            (a) =>
              a.name.toLowerCase().includes(query) ||
              (a.displayName && a.displayName.toLowerCase().includes(query))
          );

          if (hasMatchingAttr) {
            matchingObjectNames.push(obj.fullName);
            this.sendMessageToWebview({
              command: 'loadObjectAttributesResult',
              data: {
                sessionId,
                requestId: `search-${queryId}-${obj.fullName}`,
                objectFullName: obj.fullName,
                state: 'loaded',
                attributes: attrs,
              },
            });
            this.sendMessageToWebview({
              command: 'searchProgress',
              data: {
                sessionId,
                queryId,
                state: 'running',
                processed,
                total: candidateObjects.length,
                matchingObjectNames: [obj.fullName],
              },
            });
          }
        } catch (err) {
          Logger.debug(`Search failed to load attributes for ${obj.fullName}`, err);
        }
      }

      if (!session.isCancelled() && this.activeSessionId === sessionId && this.activeSearchQueryId === queryId) {
        this.sendMessageToWebview({
          command: 'searchProgress',
          data: {
            sessionId,
            queryId,
            state: 'complete',
            processed,
            total: candidateObjects.length,
            matchingObjectNames,
          },
        });
      }
    })();
  } */

  /**
   * Handle cancelSearch message — increments activeSearchQueryId to discard in-flight results.
   */
  private handleCancelSearch(message: WebviewMessage): void {
    const sessionId = message.data?.sessionId;
    const queryId = message.data?.queryId;
    if (sessionId === this.activeSessionId) {
      this.activeSearchQueryId++;

      this.notifyTypeIndexComplete();
      Logger.debug(`Cancelled search query ${queryId} for session ${sessionId}`);
    }

  }

  /**
   * Handle filterByType message — mirrors typeFilter into server-side filterState.
   */
  private async handleFilterByType(message: WebviewMessage): Promise<void> {
    if (typeof message.data?.type === 'string') {
      this.filterState.typeFilter = message.data.type
        ? [message.data.type as MetadataType]
        : [];
      Logger.debug(`handleFilterByType: typeFilter=${JSON.stringify(this.filterState.typeFilter)}`);
    }
  }

  /**
   * Large table renders run in the webview; reflect activity in the status bar so the window does not look hung.
   */
  private handleTableRenderProgress(message: WebviewMessage): void {
    if (!message.data) {
      return;
    }
    if (message.data.busy) {
      this.tableRenderStatusDisposable?.dispose();
      const n = message.data.rowCount;
      const suffix = typeof n === 'number' ? ` (${n} rows)` : '';
      this.tableRenderStatusDisposable = vscode.window.setStatusBarMessage(
        `Rights editor: rendering table${suffix}…`
      );
    } else {
      this.tableRenderStatusDisposable?.dispose();
      this.tableRenderStatusDisposable = undefined;
    }
  }

  /**
   * Send a message to the webview
   */
  private sendMessageToWebview(message: ExtensionToWebviewMessage): void {
    if (this.panel && (!this.sessions.currentSession || this.sessions.currentSession.isCurrent())) {
      void this.panel.webview.postMessage(message);
    }
  }

  /**
   * Type guard for webview messages
   */
  private isValidWebviewMessage(msg: unknown): msg is WebviewMessage {
    if (!msg || typeof msg !== 'object') {
      return false;
    }

    const m = msg as { command?: unknown };
    if (typeof m.command !== 'string') {
      return false;
    }

    /* const validCommands = [
      'updateRight',
      'save',
      'savePayload',
      'cancel',
      'toggleFilter',
      'search',
      'filterByType',
      'tableRenderProgress',
    ]; */
    return isValidWebviewMessage(msg);
  }

  /**
   * Escape HTML entities
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  /**
   * Generate error HTML
   */
  private getErrorHtml(message: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
        <title>Error</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
          }
          .error {
            color: var(--vscode-errorForeground);
            padding: 16px;
            border: 1px solid var(--vscode-errorBorder);
            border-radius: 4px;
          }
        </style>
      </head>
      <body>
        <div class="error">
          <h2>Error</h2>
          <p>${this.escapeHtml(message)}</p>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Dispose of the provider and clean up resources
   */
  public dispose(): void {
    Logger.info('Disposing RolesRightsEditorProvider');
    for (const [, pending] of this.pendingSavePayloadRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Rights editor closed'));
    }
    this.pendingSavePayloadRequests.clear();

    this.tableRenderStatusDisposable?.dispose();
    this.tableRenderStatusDisposable = undefined;

    if (this.panel) {
      const panelToDispose = this.panel;
      this.panel = undefined;
      panelToDispose.dispose();
    }

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }

    this.currentLoadSession?.dispose();
    this.currentLoadSession = undefined;
    this.activeSessionId = undefined;
    this.currentRoleModel = undefined;
    this.allObjects = [];
    this.saveDisabledNoConfig = false;
    this.configurationRootPath = undefined;
    this.sessionExpectedHash = undefined;
    this.sessionExpectedState = undefined;
    this.sessions.bumpGeneration();
    this.isTypeIndexComplete = true;
    this.typeIndexError = undefined;

    this.notifyTypeIndexComplete();
    this.filterState = createDefaultFilterState();
  }
}
