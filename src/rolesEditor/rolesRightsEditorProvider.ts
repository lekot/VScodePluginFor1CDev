import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { RoleModel } from './models/roleModel';
import { MetadataObject } from './models/metadataObject';
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
} from './rightsXmlEditWriter';
import { loadMetadataObjects } from './metadataLoader';
import { updateRight } from './rightsUpdateUtils';
import { Logger } from '../utils/logger';

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

  constructor(private context: vscode.ExtensionContext) {
    Logger.info('RolesRightsEditorProvider initialized');
  }

  /**
   * Open the rights editor for a specific role file
   * @param roleFilePath Path to the Role.xml file
   * @param configPath Optional configuration path - if provided, skips the search for configuration root
   */
  public async show(roleFilePath: string, configPath?: string | null): Promise<void> {
    try {
      // Parse the role XML file
      this.currentRoleModel = await RoleXmlParser.parseRoleXml(roleFilePath);
      Logger.info(`Loaded role: ${this.currentRoleModel.name}`);

      // Load metadata objects from configuration
      // ConfigPath should be provided from tree data provider
      if (configPath) {
        this.allObjects = await loadMetadataObjects(roleFilePath, this.currentRoleModel.rights, configPath);
        Logger.info(`Loaded ${this.allObjects.length} metadata objects`);
      } else {
        Logger.warn('Configuration path not found, showing read-only mode');
        this.allObjects = [];
      }

      // Create or reveal webview panel
      if (!this.panel) {
        this.panel = this.createPanel();
      } else {
        this.panel.reveal(vscode.ViewColumn.Beside);
      }

      // Update webview content
      this.updateWebviewContent();
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
  private async updateWebviewContent(): Promise<void> {
    if (!this.panel || !this.currentRoleModel) {
      return;
    }

    this.panel.webview.html = await this.getWebviewContent();
    Logger.debug('Rights editor panel updated');
  }

  /**
   * Generate the webview HTML content
   */
  private async getWebviewContent(): Promise<string> {
    if (!this.currentRoleModel) {
      return this.getErrorHtml('No role model loaded');
    }

    // Read the HTML template - use __dirname to get path to compiled output
    const htmlPath = path.join(__dirname, 'rolesEditorWebview.html');

    let html = await fs.promises.readFile(htmlPath, 'utf8');

    // Prepare data to inject
    const roleDataJson = this.escapeJsonForScript(
      JSON.stringify({
        name: this.currentRoleModel.name,
        rights: this.currentRoleModel.rights,
      })
    );

    const objectsJson = this.escapeJsonForScript(
      JSON.stringify(this.allObjects)
    );

    // Inject data into the script
    // Replace the "Request initial data" line with actual initialization
    html = html.replace(
      "            // Request initial data\r\n            vscode.postMessage({ command: 'ready' });",
      `// Initialize with data
            roleData = ${roleDataJson};
            allObjects = ${objectsJson};
            initializeUI();
            renderTable();`
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
      switch (message.command) {
        case 'updateRight':
          await this.handleUpdateRight(message);
          break;
        case 'save':
          await this.handleSave();
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
      // Refresh the table
      this.updateWebviewContent();
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
   * Handle save message
   * Case B: filePath is Role.xml → serialize with RoleXmlSerializer, write to filePath.
   * Case A: otherwise → rights in Ext/Rights.xml; load, merge, serialize, write to rightsPath.
   */
  private async handleSave(): Promise<void> {
    if (!this.currentRoleModel) {
      return;
    }

    try {
      const validator = new RightsValidator();
      const validationResult = validator.validateRights(this.currentRoleModel);

      if (!validationResult.isValid) {
        this.sendMessageToWebview({
          command: 'validationError',
          data: { errors: validationResult.errors },
        });
        return;
      }

      const isCaseB = path.basename(this.currentRoleModel.filePath).toLowerCase() === 'role.xml';
      const targetPath = isCaseB
        ? this.currentRoleModel.filePath
        : getRightsPath(this.currentRoleModel.filePath);
      const tempPath = targetPath + '.tmp';

      let xmlContent: string;
      if (isCaseB) {
        xmlContent = RoleXmlSerializer.serializeToXml(this.currentRoleModel);
      } else {
        const dom = await loadRightsXml(targetPath);
        mergeRightsIntoDom(dom, this.currentRoleModel.rights);
        xmlContent = serializeRightsDomToXml(dom);
      }

      try {
        await fs.promises.writeFile(tempPath, xmlContent, 'utf8');
        await fs.promises.rename(tempPath, targetPath);

        Logger.info('Rights saved successfully');
        vscode.window.showInformationMessage('Rights saved successfully');

        if (this.panel) {
          this.panel.dispose();
        }
      } catch (error) {
        try {
          await fs.promises.unlink(tempPath);
        } catch {
          // Ignore if temp file doesn't exist
        }
        throw error;
      }
    } catch (error) {
      Logger.error('Failed to save rights', error);
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to save rights: ${message}`);
      this.sendMessageToWebview({
        command: 'saveError',
        data: { message },
      });
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

    this.updateWebviewContent();
  }

  /**
   * Handle search message
   */
  private async handleSearch(message: WebviewMessage): Promise<void> {
    if (!message.data || message.data.query === undefined) {
      return;
    }

    this.filterState.searchQuery = message.data.query;
    this.updateWebviewContent();
  }

  /**
   * Handle filterByType message
   */
  private async handleFilterByType(message: WebviewMessage): Promise<void> {
    if (!message.data || !message.data.types) {
      return;
    }

    this.filterState.typeFilter = message.data.types;
    this.updateWebviewContent();
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
