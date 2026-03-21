import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { RoleModel } from './models/roleModel';
import type { MetadataObject } from './models/metadataObject';
import { FilterState } from './models/filterState';
import { WebviewMessage } from './models/webviewMessage';
import { RoleXmlParser } from './roleXmlParser';
import { RoleXmlSerializer } from './roleXmlSerializer';
import { RightsValidator } from './rightsValidator';
import {
  getRightsPath,
  loadRightsXml,
  mergeRightsIntoDom,
  serializeRightsDomToXml,
  insertRestrictionTemplatesBeforeClosingRights,
} from './rightsXmlEditWriter';
import { loadMetadataObjects } from './metadataLoader';
import { updateRight } from './rightsUpdateUtils';
import { Logger } from '../utils/logger';
import { MetadataType } from '../models/treeNode';

/**
 * Provider for the roles and rights editor webview
 */
export class RolesRightsEditorProvider {
  private panel: vscode.WebviewPanel | undefined;
  private currentRoleModel: RoleModel | undefined;
  private allObjects: MetadataObject[] = [];
  private filterState: FilterState = {
    showAll: false,
    searchQuery: '',
    typeFilter: [],
  };
  private disposables: vscode.Disposable[] = [];
  private saveInProgress = false;
  /** Incremented on each `show` so stale async metadata loads do not postMessage over a newer session. */
  private objectsLoadGeneration = 0;
  private tableRenderStatusDisposable: vscode.Disposable | undefined;

  constructor(private context: vscode.ExtensionContext) {
    Logger.info('RolesRightsEditorProvider initialized');
  }

  /**
   * HTML is not emitted by tsc; integration tests compile to `out/src/rolesEditor/*.js` without copying the template.
   * Production VSIX places it next to the JS under `dist/rolesEditor/`. Try common locations.
   */
  private resolveRolesEditorWebviewHtmlPath(): string {
    const nextToCompiled = path.join(__dirname, 'rolesEditorWebview.html');
    const candidates: string[] = [nextToCompiled];
    if (this.context.extensionPath) {
      candidates.push(
        path.join(this.context.extensionPath, 'dist', 'rolesEditor', 'rolesEditorWebview.html'),
        path.join(this.context.extensionPath, 'src', 'rolesEditor', 'rolesEditorWebview.html')
      );
    }
    candidates.push(
      path.join(__dirname, '..', '..', '..', 'src', 'rolesEditor', 'rolesEditorWebview.html'),
      path.join(__dirname, '..', '..', 'src', 'rolesEditor', 'rolesEditorWebview.html')
    );
    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        return p;
      }
    }
    return nextToCompiled;
  }

  /**
   * Open the rights editor for a specific role file
   * @param roleFilePath Path to the Role.xml file
   * @param configPath Optional configuration path - if provided, skips the search for configuration root
   */
  public async show(roleFilePath: string, configPath?: string | null): Promise<void> {
    const loadGeneration = ++this.objectsLoadGeneration;
    try {
      // Parse the role XML file
      this.currentRoleModel = await RoleXmlParser.parseRoleXml(roleFilePath);
      if (loadGeneration !== this.objectsLoadGeneration) {
        return;
      }
      Logger.info(`Loaded role: ${this.currentRoleModel.name}`);

      // Create or reveal webview panel immediately; load metadata in the background
      if (!this.panel) {
        this.panel = this.createPanel();
      } else {
        this.panel.reveal(vscode.ViewColumn.Beside);
      }
      this.panel.title = `Rights: ${this.currentRoleModel.name}`;

      this.allObjects = [];
      await this.updateWebviewContent({ initialTableLoading: true });

      if (!configPath) {
        Logger.warn('Configuration path not found, showing read-only mode');
        if (loadGeneration !== this.objectsLoadGeneration) {
          return;
        }
        this.sendMessageToWebview({
          command: 'objectsLoaded',
          data: {
            objects: [] as MetadataObject[],
            error: 'Configuration path not found; metadata table is empty.',
          },
        });
        return;
      }

      try {
        const objects = await loadMetadataObjects(
          roleFilePath,
          this.currentRoleModel.rights,
          configPath
        );
        if (loadGeneration !== this.objectsLoadGeneration) {
          return;
        }
        this.allObjects = objects;
        Logger.info(`Loaded ${this.allObjects.length} metadata objects`);
        this.sendMessageToWebview({
          command: 'objectsLoaded',
          data: { objects: this.allObjects },
        });
      } catch (loadErr) {
        if (loadGeneration !== this.objectsLoadGeneration) {
          return;
        }
        Logger.error('Failed to load metadata objects for rights editor', loadErr);
        this.allObjects = [];
        const message = loadErr instanceof Error ? loadErr.message : String(loadErr);
        this.sendMessageToWebview({
          command: 'objectsLoaded',
          data: { objects: [] as MetadataObject[], error: message },
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

    // Prepare data to inject
    const roleDataJson = this.escapeJsonForScript(
      JSON.stringify({
        name: this.currentRoleModel.name,
        rights: this.currentRoleModel.rights,
        restrictionTemplatesText: this.currentRoleModel.restrictionTemplatesText ?? '',
      })
    );

    const objectsJson = this.escapeJsonForScript(JSON.stringify(this.allObjects));
    const loadingFlag = initialTableLoading ? 'true' : 'false';

    // Inject data into the script (match line ending \n or \r\n)
    html = html.replace(
      /\s*\/\/ Request initial data\s*vscode\.postMessage\(\s*\{\s*command:\s*'ready'\s*\}\s*\)\s*;/,
      ` roleData = ${roleDataJson};
            allObjects = ${objectsJson};
            tableInitialLoading = ${loadingFlag};
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
        Logger.info('Received save command from webview');
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
   * Use when webview postMessage may not reach the provider.
   */
  public async triggerSave(): Promise<void> {
    await this.handleSave();
  }

  /**
   * Handle save message
   * Case B: filePath is Role.xml → serialize with RoleXmlSerializer, write to filePath.
   * Case A: otherwise → rights in Ext/Rights.xml; load, merge, serialize, write to rightsPath.
   */
  private async handleSave(message?: WebviewMessage): Promise<void> {
    if (this.saveInProgress) {
      Logger.warn('handleSave skipped: save already in progress');
      return;
    }
    Logger.info('handleSave called');
    if (!this.currentRoleModel) {
      const msg = 'Role not loaded. Close and reopen the rights editor.';
      vscode.window.showErrorMessage(msg);
      this.sendMessageToWebview({ command: 'saveError', data: { message: msg } });
      return;
    }

    const rls = message?.data?.restrictionTemplatesText;
    if (typeof rls === 'string') {
      this.currentRoleModel.restrictionTemplatesText = rls;
    }

    this.saveInProgress = true;
    const statusDone = vscode.window.setStatusBarMessage('Saving rights...');
    try {
      Logger.info('handleSave: validation starting');
      const validator = new RightsValidator();
      const validationResult = validator.validateRights(this.currentRoleModel);

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
        if (saveAnyway !== 'Save anyway') {
          statusDone.dispose();
          return;
        }
        Logger.info('handleSave: user chose Save anyway, skipping validation');
      } else {
        Logger.info('handleSave: validation passed, resolving target path');
      }
      const isCaseB = path.basename(this.currentRoleModel.filePath).toLowerCase() === 'role.xml';
      const targetPath = isCaseB
        ? this.currentRoleModel.filePath
        : getRightsPath(this.currentRoleModel.filePath);
      // Temp file for atomic write: <target>.tmp only (e.g. Rights.xml.tmp). "Rights copy.xml" is not used by the extension.
      const tempPath = targetPath + '.tmp';
      Logger.info(`Save target: ${targetPath}, temp: ${tempPath}`);

      let xmlContent: string;
      if (isCaseB) {
        xmlContent = RoleXmlSerializer.serializeToXml(this.currentRoleModel);
        Logger.info('Serialized (Case B)');
      } else {
        Logger.info('Loading Rights.xml...');
        const dom = await loadRightsXml(targetPath);
        Logger.info('Merging rights into DOM...');
        const compactWrite = vscode.workspace
          .getConfiguration('1cMetadataTree')
          .get<boolean>('rightsEditor.compactRightsWrite', true);
        mergeRightsIntoDom(dom, this.currentRoleModel.rights, { compactWrite });
        Logger.info('Serializing DOM to XML...');
        xmlContent = serializeRightsDomToXml(dom);
        xmlContent = insertRestrictionTemplatesBeforeClosingRights(
          xmlContent,
          this.currentRoleModel.restrictionTemplatesText ?? ''
        );
      }

      Logger.info('Writing to temp file...');
      await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
      await fs.promises.writeFile(tempPath, xmlContent, 'utf8');
      Logger.info('Renaming temp to target...');
      try {
        await fs.promises.rename(tempPath, targetPath);
      } catch (renameErr) {
        try {
          await fs.promises.unlink(tempPath);
        } catch {
          // ignore
        }
        throw renameErr;
      }

      statusDone.dispose();
      Logger.info('Rights saved successfully');
      vscode.window.showInformationMessage('Rights saved successfully');

      if (this.panel) {
        this.panel.dispose();
      }
    } catch (error) {
      statusDone.dispose();
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      Logger.error(`Failed to save rights: ${message}`, stack ? { stack } : error);
      vscode.window.showErrorMessage(`Failed to save rights: ${message}`);
      this.sendMessageToWebview({
        command: 'saveError',
        data: { message },
      });
    } finally {
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

  /**
   * Handle toggleFilter message
   */
  private async handleToggleFilter(message: WebviewMessage): Promise<void> {
    if (!message.data) {
      return;
    }

    if (message.data.showAll !== undefined) {
      this.filterState.showAll = message.data.showAll;
    }
  }

  /**
   * Handle search message
   */
  private async handleSearch(message: WebviewMessage): Promise<void> {
    if (!message.data || message.data.query === undefined) {
      return;
    }

    this.filterState.searchQuery = message.data.query;
  }

  /**
   * Handle filterByType message
   */
  private async handleFilterByType(message: WebviewMessage): Promise<void> {
    if (!message.data) {
      return;
    }
    if (message.data.types !== undefined) {
      this.filterState.typeFilter = message.data.types;
    } else if (message.data.type !== undefined) {
      const t = message.data.type.trim();
      this.filterState.typeFilter = t ? [t as MetadataType] : [];
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
  private sendMessageToWebview(message: unknown): void {
    if (this.panel) {
      this.panel.webview.postMessage(message);
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

    const validCommands = [
      'updateRight',
      'save',
      'cancel',
      'toggleFilter',
      'search',
      'filterByType',
      'tableRenderProgress',
    ];
    return validCommands.includes(m.command);
  }

  /**
   * Escape JSON for safe embedding in script tags
   */
  private escapeJsonForScript(json: string): string {
    return json.replace(/<\/script>/gi, '<\\/script>');
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
    this.tableRenderStatusDisposable?.dispose();
    this.tableRenderStatusDisposable = undefined;

    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }

    this.currentRoleModel = undefined;
    this.allObjects = [];
  }
}
