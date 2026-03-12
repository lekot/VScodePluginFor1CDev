import * as vscode from 'vscode';
import { TreeNode } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { MetadataTreeDataProvider } from './treeDataProvider';
import { TypeEditorProvider } from './typeEditorProvider';

/**
 * Message types sent from webview to extension
 */
interface WebviewMessage {
  type: 'save' | 'cancel' | 'validate' | 'propertyChanged' | 'editType';
  properties?: Record<string, unknown>;
  propertyName?: string;
  value?: unknown;
}

/**
 * Message types sent from extension to webview
 */
interface ExtensionMessage {
  type: 'update' | 'saved' | 'error' | 'validationError' | 'typeUpdated';
  node?: TreeNode;
  message?: string;
  errors?: Record<string, string>;
  property?: string;
  value?: string;
}

/**
 * Validation result
 */
interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

/**
 * Properties View Provider for displaying and editing element properties
 */
export class PropertiesProvider {
  private panel: vscode.WebviewPanel | undefined;
  private currentNode: TreeNode | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
      private context: vscode.ExtensionContext,
      private treeDataProvider: MetadataTreeDataProvider,
      private typeEditorProvider: TypeEditorProvider
    ) {
      Logger.info('PropertiesProvider initialized');
      // Store reference for future use (tree refresh will be implemented in later tasks)
      void this.treeDataProvider;
    }


  /**
   * Show properties for a tree node
   * Creates new panel or reuses existing one (singleton pattern)
   */
  public async showProperties(node: TreeNode): Promise<void> {
    this.currentNode = node;

    // Check if this is a .bsl module file - open it as text instead of properties
    if (node.filePath && node.filePath.endsWith('.bsl')) {
      try {
        const uri = vscode.Uri.file(node.filePath);
        await vscode.window.showTextDocument(uri);
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
    // Only reload from file for root elements that have filePath
    if (node.filePath && !node.parentFilePath) {
      try {
        const { XMLWriter } = await import('../utils/XMLWriter');
        const xmlProperties = await XMLWriter.readProperties(node.filePath);
        
        // Update node properties with fresh data from XML
        node.properties = { ...xmlProperties };
        
        Logger.debug(`Successfully loaded properties from ${node.filePath}`);
      } catch (error) {
        // Log detailed error
        Logger.error(`Failed to read properties from ${node.filePath}`, error);
        
        // Display error in properties panel
        this.showErrorInPanel(
          node,
          `Failed to read properties from file`,
          error instanceof Error ? error.message : String(error)
        );
        return;
      }
    }
    // For nested elements with parentFilePath, use already loaded properties from node.properties

    this.updateWebviewContent();
  }

  /**
   * Create webview panel with proper configuration
   */
  private createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      '1c-metadata-properties',
      '1C Metadata Properties',
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

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        await this.handleMessage(message);
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
    if (!this.panel || !this.currentNode) {
      return;
    }

    const html = this.getWebviewContent(this.currentNode);
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

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" 
              content="default-src 'none'; 
                       style-src 'unsafe-inline';">
        <title>Properties - Error</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 16px;
          }
          .header {
            margin-bottom: 20px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
          }
          .header h2 {
            margin: 0 0 8px 0;
            color: var(--vscode-foreground);
          }
          .header p {
            margin: 0;
            color: var(--vscode-descriptionForeground);
          }
          .error-box {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            padding: 16px;
            margin: 16px 0;
            border-radius: 3px;
          }
          .error-box h3 {
            margin: 0 0 12px 0;
            color: var(--vscode-inputValidation-errorForeground);
          }
          .error-box p {
            margin: 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
            word-break: break-word;
          }
          .file-path {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            margin-top: 12px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>${this.escapeHtml(node.name)}</h2>
          <p>${this.escapeHtml(node.type)}</p>
        </div>
        <div class="error-box">
          <h3>${this.escapeHtml(title)}</h3>
          <p>${this.escapeHtml(details)}</p>
          ${node.filePath ? `
            <div class="file-path">
              <strong>File:</strong> ${this.escapeHtml(node.filePath)}
            </div>
          ` : ''}
        </div>
      </body>
      </html>
    `;

    this.panel.webview.html = html;
    Logger.debug(`Error displayed in properties panel for node: ${node.name}`);
  }

  /**
   * Generate HTML content for webview
   */
  private getWebviewContent(node: TreeNode): string {
    // Handle empty state when no node is selected
    if (!node) {
      return this.getEmptyStateContent();
    }

    const properties = node.properties || {};
    const hasProperties = Object.keys(properties).length > 0;
    
    // Switch to read-only mode when file path is missing
    // For nested elements (Attributes), check parentFilePath; for root elements, check filePath
    const readOnly = !(node.parentFilePath || node.filePath);

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" 
              content="default-src 'none'; 
                       style-src 'unsafe-inline'; 
                       script-src 'unsafe-inline';">
        <title>Properties</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 16px;
          }
          .header {
            margin-bottom: 20px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
          }
          .header h2 {
            margin: 0 0 8px 0;
            color: var(--vscode-foreground);
          }
          .header p {
            margin: 0;
            color: var(--vscode-descriptionForeground);
          }
          .read-only-notice {
            background: var(--vscode-inputValidation-warningBackground);
            color: var(--vscode-inputValidation-warningForeground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            padding: 8px 12px;
            margin-bottom: 16px;
            border-radius: 3px;
          }
          .property-row {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
            gap: 12px;
          }
          .property-label {
            font-weight: bold;
            min-width: 280px;
            flex-shrink: 0;
            color: var(--vscode-foreground);
          }
          .property-input {
            flex-grow: 1;
            padding: 4px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
          }
          .property-input[type="checkbox"] {
            flex-grow: 0;
            width: 18px;
            height: 18px;
            padding: 0;
            cursor: pointer;
          }
          .property-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
          }
          .property-input.changed {
            border-left: 3px solid var(--vscode-inputValidation-warningBorder);
          }
          .property-input.error {
            border-color: var(--vscode-inputValidation-errorBorder);
          }
          .property-input[type="checkbox"] {
            flex-grow: 0;
            width: 18px;
            height: 18px;
            cursor: pointer;
          }
          .error-message {
            color: var(--vscode-inputValidation-errorForeground);
            font-size: 0.9em;
            margin-top: 4px;
            margin-left: 162px;
          }
          .button-row {
            margin-top: 20px;
            padding-top: 12px;
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 8px;
          }
          button {
            padding: 6px 14px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
          }
          button:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
          }
          button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>${this.escapeHtml(node.name)}</h2>
          <p>${this.escapeHtml(node.type)}</p>
        </div>
        ${readOnly ? `
          <div class="read-only-notice">
            <strong>Read-Only Mode:</strong> This element has no associated file path. Properties cannot be saved.
          </div>
        ` : ''}
        ${hasProperties ? `
          <div id="properties">
            ${this.renderProperties(properties, readOnly)}
          </div>
          ${!readOnly ? `
            <div class="button-row">
              <button id="save-btn" disabled>Save</button>
              <button id="cancel-btn">Cancel</button>
            </div>
          ` : ''}
        ` : `
          <div class="empty-state">
            <p>No properties available for this element</p>
          </div>
        `}
        <script>
          ${this.getWebviewScript(readOnly)}
        </script>
      </body>
      </html>
    `;
  }

  /**
   * Generate empty state HTML when no element is selected
   */
  private getEmptyStateContent(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" 
              content="default-src 'none'; 
                       style-src 'unsafe-inline';">
        <title>Properties</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 16px;
          }
          .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
          }
          .empty-state h3 {
            margin: 0 0 12px 0;
          }
          .empty-state p {
            margin: 0;
          }
        </style>
      </head>
      <body>
        <div class="empty-state">
          <h3>No element selected</h3>
          <p>Click on a tree element to view its properties</p>
        </div>
      </body>
      </html>
    `;
  }

  private renderProperties(properties: Record<string, any>, readOnly: boolean): string {
    return Object.entries(properties)
      .map(([key, value]) => this.renderPropertyInput(key, value, readOnly))
      .join('');
  }

  /**
   * Render a single property input field
   */
  private renderPropertyInput(name: string, value: any, globalReadOnly: boolean): string {
    // Format Type property if it's an object (defensive fallback)
    let displayValue = value;
    const isTypeProperty = name.toLowerCase() === 'type';
    
    if (isTypeProperty && typeof value === 'object' && value !== null) {
      try {
        const { TypeParser } = require('../parsers/typeParser');
        const { TypeFormatter } = require('../utils/typeFormatter');
        const typeDef = TypeParser.parseFromObject(value);
        displayValue = TypeFormatter.formatTypeDisplay(typeDef);
      } catch (error) {
        Logger.error('Failed to format Type in renderPropertyInput', error);
        displayValue = '[Invalid Type]';
      }
    }
    
    const propertyType = this.detectPropertyType(displayValue);
    const inputType = propertyType === 'boolean' ? 'checkbox' : propertyType === 'number' ? 'number' : 'text';
    const checked = propertyType === 'boolean' && displayValue ? 'checked' : '';
    const inputValue = propertyType === 'boolean' ? '' : this.escapeHtml(String(displayValue ?? ''));
    
    // Determine if this specific property should be read-only
    // For root elements (Catalog, Document, etc.), type property is read-only
    // For nested elements (Attribute, etc.), type property is editable
    const isRootElement = this.isRootElement(this.currentNode);
    const propertyReadOnly = globalReadOnly || (isRootElement && isTypeProperty);
    
    const disabled = propertyReadOnly ? 'disabled' : '';
    
    // Get Russian label for property name
    const { getPropertyLabel } = require('../constants/propertyLabels');
    const displayName = getPropertyLabel(name);

    // Add Edit Type button for type property (only for non-root elements)
    const editTypeButton = isTypeProperty && !propertyReadOnly ? `
      <button class="edit-type-btn" data-property="${this.escapeHtml(name)}">
        <span class="octicon octicon-pencil"></span> Редактировать тип
      </button>
    ` : '';

    return `
      <div class="property-row">
        <label class="property-label">${this.escapeHtml(displayName)}</label>
        <input
          type="${inputType}"
          class="property-input"
          data-property="${this.escapeHtml(name)}"
          value="${inputValue}"
          ${checked}
          ${disabled}
        />
        ${editTypeButton}
      </div>
    `;
  }

  /**
   * Check if node is a root metadata element (Catalog, Document, etc.)
   * Note: Attribute is NOT in this list because it's a nested element
   * and should have an editable type property
   */
  private isRootElement(node: TreeNode | undefined): boolean {
    if (!node) {
      return false;
    }
    
    // Root elements are direct children of Configuration or have no parent
    // or their parent type is 'Configuration'
    if (!node.parent) {
      return true;
    }
    
    // Check if parent is Configuration
    if (node.parent.type === 'Configuration') {
      return true;
    }
    
    // Root metadata types (elements that have their own XML file)
    const rootTypes = [
      'Catalog', 'Document', 'Register', 'InformationRegister', 
      'AccumulationRegister', 'ChartOfCharacteristicTypes', 
      'ChartOfAccounts', 'ChartOfCalculationTypes', 'BusinessProcess',
      'Task', 'ExchangePlan', 'Enum', 'Report', 'DataProcessor',
      'CommonModule', 'Role', 'CommonAttribute', 'CommonCommand',
      'CommandGroup', 'FunctionalOption', 'FunctionalOptionsParameter',
      'DefinedType', 'SettingsStorage', 'CommonForm', 'CommonTemplate',
      'CommonPicture', 'XDTOPackage', 'WebService', 'HTTPService',
      'WSReference', 'Style', 'Language', 'Subsystem', 'StyleItem',
      'Interface', 'SessionParameter'
    ];
    
    return rootTypes.includes(node.type);
  }

  /**
   * Detect property type from value
   */
  private detectPropertyType(value: any): 'string' | 'boolean' | 'number' | 'unknown' {
    if (typeof value === 'boolean') {
      return 'boolean';
    }
    if (typeof value === 'number') {
      return 'number';
    }
    if (typeof value === 'string') {
      return 'string';
    }
    return 'unknown';
  }

  /**
   * Generate webview JavaScript for client-side interaction
   */
  private getWebviewScript(readOnly: boolean): string {
    if (readOnly) {
      return '// Read-only mode - no interaction needed';
    }

    return `
      const vscode = acquireVsCodeApi();
      let state = {
        originalProperties: {},
        currentProperties: {},
        changedProperties: new Set(),
        validationErrors: {}
      };

      // Initialize state from current inputs
      function initializeState() {
        document.querySelectorAll('.property-input').forEach(input => {
          const name = input.dataset.property;
          const value = getInputValue(input);
          state.originalProperties[name] = value;
          state.currentProperties[name] = value;
        });
      }

      // Get value from input based on type
      function getInputValue(input) {
        if (input.type === 'checkbox') {
          return input.checked;
        } else if (input.type === 'number') {
          return parseFloat(input.value) || 0;
        } else {
          return input.value;
        }
      }

      // Handle property change
      function handlePropertyChange(event) {
        const input = event.target;
        const name = input.dataset.property;
        const value = getInputValue(input);

        state.currentProperties[name] = value;

        // Track if changed from original
        if (JSON.stringify(value) !== JSON.stringify(state.originalProperties[name])) {
          state.changedProperties.add(name);
          input.classList.add('changed');
        } else {
          state.changedProperties.delete(name);
          input.classList.remove('changed');
        }

        updateUI();
      }

      // Handle save button click
      function handleSave() {
        vscode.postMessage({
          type: 'save',
          properties: state.currentProperties
        });
      }

      // Handle cancel button click
      function handleCancel() {
        vscode.postMessage({
          type: 'cancel'
        });
      }

      // Update UI state (enable/disable save button)
      function updateUI() {
        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) {
          saveBtn.disabled = state.changedProperties.size === 0 ||
                             Object.keys(state.validationErrors).length > 0;
        }
      }

      // Handle edit type button click
      function handleEditType(event) {
        const btn = event.target.closest('.edit-type-btn');
        if (btn) {
          vscode.postMessage({
            type: 'editType',
            property: btn.dataset.property
          });
        }
      }

      // Attach event listeners
      function attachEventListeners() {
        document.querySelectorAll('.property-input').forEach(input => {
          input.addEventListener('change', handlePropertyChange);
          input.addEventListener('input', handlePropertyChange);
        });

        document.querySelectorAll('.edit-type-btn').forEach(btn => {
          btn.addEventListener('click', handleEditType);
        });

        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) {
          saveBtn.addEventListener('click', handleSave);
        }

        const cancelBtn = document.getElementById('cancel-btn');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', handleCancel);
        }
      }

      // Handle messages from extension
      window.addEventListener('message', event => {
        const message = event.data;

        switch (message.type) {
          case 'update':
            // Reload page content when cancel is triggered
            // The extension will regenerate the HTML with original properties
            location.reload();
            break;

          case 'saved':
            // Update original properties to current values
            state.originalProperties = { ...state.currentProperties };
            state.changedProperties.clear();
            state.validationErrors = {};
            
            // Remove changed indicators
            document.querySelectorAll('.property-input').forEach(input => {
              input.classList.remove('changed');
              input.classList.remove('error');
            });
            
            updateUI();
            break;

          case 'error':
            alert('Error: ' + message.message);
            break;

          case 'validationError':
            state.validationErrors = message.errors || {};
            
            // Display validation errors
            document.querySelectorAll('.property-input').forEach(input => {
              const name = input.dataset.property;
              if (state.validationErrors[name]) {
                input.classList.add('error');
                
                // Add error message if not already present
                const existingError = input.parentElement.nextElementSibling;
                if (!existingError || !existingError.classList.contains('error-message')) {
                  const errorDiv = document.createElement('div');
                  errorDiv.className = 'error-message';
                  errorDiv.textContent = state.validationErrors[name];
                  input.parentElement.insertAdjacentElement('afterend', errorDiv);
                }
              } else {
                input.classList.remove('error');
                
                // Remove error message if present
                const errorDiv = input.parentElement.nextElementSibling;
                if (errorDiv && errorDiv.classList.contains('error-message')) {
                  errorDiv.remove();
                }
              }
            });
            
            updateUI();
            break;

          case 'typeUpdated':
            // Update Type value in properties panel after save
            const propertyName = message.property;
            const newValue = message.value;
            
            // Find the input element for this property
            const input = document.querySelector(\`.property-input[data-property="\${propertyName}"]\`);
            if (input) {
              // Update the input value
              input.value = newValue;
              
              // Update state
              state.currentProperties[propertyName] = newValue;
              
              // Mark field as changed
              if (JSON.stringify(newValue) !== JSON.stringify(state.originalProperties[propertyName])) {
                state.changedProperties.add(propertyName);
                input.classList.add('changed');
              }
              
              // Activate Save button
              updateUI();
            }
            break;
        }
      });

      // Initialize on load
      initializeState();
      attachEventListeners();
    `;
  }

  /**
   * Handle messages from webview
   */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    Logger.debug(`Received message from webview: ${message.type}`);
    
    try {
      switch (message.type) {
        case 'save':
          await this.handleSaveMessage(message);
          break;
        
        case 'cancel':
          await this.handleCancelMessage();
          break;
        
        case 'validate':
          this.handleValidateMessage(message);
          break;
        
        case 'editType':
          await this.handleEditTypeMessage(message);
          break;
        
        default:
          Logger.warn(`Unknown message type: ${(message as any).type}`);
      }
    } catch (error) {
      Logger.error(`Error handling message: ${error}`);
      this.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error occurred'
      });
    }
  }

  /**
   * Handle save message from webview
   */
  private async handleSaveMessage(message: WebviewMessage): Promise<void> {
    if (!this.currentNode) {
      Logger.warn('Save attempted with no current node');
      this.postMessage({
        type: 'error',
        message: 'No element selected'
      });
      return;
    }

    if (!message.properties) {
      Logger.warn('Save attempted with no properties');
      this.postMessage({
        type: 'error',
        message: 'No properties to save'
      });
      return;
    }

    // Validate properties
    const validationResult = this.validateProperties(message.properties);
    if (!validationResult.valid) {
      Logger.info('Validation failed', validationResult.errors);
      this.postMessage({
        type: 'validationError',
        errors: validationResult.errors
      });
      return;
    }

    // Save properties
    try {
      await this.saveProperties(this.currentNode, message.properties);
      
      // Send success confirmation
      this.postMessage({
        type: 'saved'
      });
      
      Logger.info(`Properties saved successfully for node: ${this.currentNode.name}`);
    } catch (error) {
      Logger.error(`Failed to save properties: ${error}`);
      this.postMessage({
        type: 'error',
        message: `Failed to save properties: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
  }

  /**
   * Handle cancel message from webview
   */
  private async handleCancelMessage(): Promise<void> {
    if (!this.currentNode) {
      Logger.warn('Cancel attempted with no current node');
      return;
    }

    // Reload original properties by sending update message
    this.postMessage({
      type: 'update',
      node: this.currentNode
    });
    
    Logger.info(`Properties reset to original for node: ${this.currentNode.name}`);
  }

  /**
   * Handle validate message from webview
   */
  private handleValidateMessage(message: WebviewMessage): void {
    if (!message.properties) {
      return;
    }

    const validationResult = this.validateProperties(message.properties);
    if (!validationResult.valid) {
      this.postMessage({
        type: 'validationError',
        errors: validationResult.errors
      });
    }
  }

  /**
   * Handle editType message from webview
   */
  private async handleEditTypeMessage(_message: WebviewMessage): Promise<void> {
    if (!this.currentNode) {
      Logger.warn('Edit type attempted with no current node');
      this.postMessage({
        type: 'error',
        message: 'No element selected'
      });
      return;
    }

    // Get current Type value from currentNode.properties
    const currentTypeXML = this.currentNode.properties['Type'] as string;

    if (!currentTypeXML) {
      Logger.warn('Edit type attempted but Type property is empty');
      this.postMessage({
        type: 'error',
        message: 'Type property is empty'
      });
      return;
    }

    try {
      // Call TypeEditorProvider.show(typeXML) and await result
      const result = await this.typeEditorProvider.show(currentTypeXML);

      // If result not null, serialize TypeDefinition back to XML string
      if (result !== null) {
        const { TypeSerializer } = await import('../serializers/typeSerializer');
        const updatedTypeXML = TypeSerializer.serialize(result);

        // Update value in webview via postMessage with type 'typeUpdated'
        this.postMessage({
          type: 'typeUpdated',
          property: 'Type',
          value: updatedTypeXML
        });

        Logger.info('Type updated successfully');
      } else {
        Logger.info('Type editing cancelled by user');
      }
    } catch (error) {
      Logger.error(`Failed to edit type: ${error}`);
      this.postMessage({
        type: 'error',
        message: `Failed to edit type: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
  }

  /**
   * Save property changes to XML file
   */
  private async saveProperties(
    node: TreeNode,
    properties: Record<string, unknown>
  ): Promise<void> {
    // Use parentFilePath for nested elements (Attributes), filePath for regular elements
    const targetFilePath = node.parentFilePath || node.filePath;
    
    if (!targetFilePath) {
      throw new Error('Cannot save properties: no file path associated with this element');
    }

    try {
      // Import XMLWriter dynamically to avoid circular dependencies
      const { XMLWriter } = await import('../utils/XMLWriter');
      
      // Write properties to XML file with error handling
      try {
        // For nested elements (Attributes, TabularSections, etc.), use specialized method
        if (node.parentFilePath) {
          await XMLWriter.writeNestedElementProperties(
            targetFilePath,
            node.type,
            node.name,
            properties
          );
        } else {
          // For root elements, use standard write method
          await XMLWriter.writeProperties(targetFilePath, properties);
        }
      } catch (writeError) {
        // Log detailed error to extension output channel
        Logger.error(`Failed to write properties to ${targetFilePath}`, writeError);
        
        // Show VS Code error notification with file path and reason
        const errorMessage = writeError instanceof Error ? writeError.message : String(writeError);
        vscode.window.showErrorMessage(
          `Failed to save properties: ${errorMessage}`,
          'Show Output'
        ).then(selection => {
          if (selection === 'Show Output') {
            Logger.show();
          }
        });
        
        // Re-throw to be handled by caller (which will retain edited values in webview)
        throw new Error(`Failed to write properties to file: ${targetFilePath}. ${errorMessage}`);
      }
      
      // Update TreeNode.properties with new values after successful save
      node.properties = { ...properties };
      
      // Refresh tree view to reflect changes
      this.treeDataProvider.refresh();
      
      Logger.info(`Properties saved successfully to: ${targetFilePath}`);
    } catch (error) {
      // Log detailed error to extension output channel
      Logger.error(`Failed to save properties to ${targetFilePath}`, error);
      throw error; // Re-throw to be handled by caller
    }
  }

  /**
   * Validate property values
   */
  private validateProperties(
    properties: Record<string, unknown>
  ): ValidationResult {
    const errors: Record<string, string> = {};

    if (!this.currentNode) {
      return { valid: false, errors: { _general: 'No element selected' } };
    }

    for (const [name, value] of Object.entries(properties)) {
      // Get expected type from original properties
      const expectedType = this.getExpectedType(name);

      // Type validation
      const actualType = typeof value;

      if (expectedType === 'number' && actualType !== 'number') {
        if (actualType === 'string' && value !== '') {
          // Try to parse as number
          const parsed = parseFloat(value as string);
          if (isNaN(parsed)) {
            errors[name] = 'Must be a number';
            continue;
          }
        } else if (value !== null && value !== undefined && value !== '') {
          errors[name] = 'Must be a number';
          continue;
        }
      }

      if (expectedType === 'boolean' && actualType !== 'boolean') {
        errors[name] = 'Must be a boolean';
        continue;
      }

      // Required field validation
      if (this.isRequiredProperty(name)) {
        if (value === '' || value === null || value === undefined) {
          errors[name] = 'This field is required';
          continue;
        }
      }
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors
    };
  }

  /**
   * Get expected type for a property based on original value
   */
  private getExpectedType(propertyName: string): string {
    if (!this.currentNode) {
      return 'unknown';
    }
    const originalValue = this.currentNode.properties[propertyName];
    return typeof originalValue;
  }

  /**
   * Check if a property is required
   */
  private isRequiredProperty(propertyName: string): boolean {
    // Common required properties in 1C metadata
    const requiredProperties = ['name', 'Name', 'Имя'];
    return requiredProperties.includes(propertyName);
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
   * Escape HTML to prevent XSS
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
