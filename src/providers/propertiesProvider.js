"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PropertiesProvider = void 0;
const vscode = __importStar(require("vscode"));
const logger_1 = require("../utils/logger");
/**
 * Properties View Provider for displaying and editing element properties
 */
class PropertiesProvider {
    constructor(context, treeDataProvider) {
        this.context = context;
        this.treeDataProvider = treeDataProvider;
        this.disposables = [];
        logger_1.Logger.info('PropertiesProvider initialized');
        // Store reference for future use (tree refresh will be implemented in later tasks)
        void this.treeDataProvider;
    }
    /**
     * Show properties for a tree node
     * Creates new panel or reuses existing one (singleton pattern)
     */
    async showProperties(node) {
        this.currentNode = node;
        // Create panel if it doesn't exist (singleton pattern)
        if (!this.panel) {
            this.panel = this.createPanel();
        }
        else {
            // Reuse existing panel and reveal it
            this.panel.reveal(vscode.ViewColumn.Beside);
        }
        // Update content with new node
        this.updateWebviewContent();
    }
    /**
     * Create webview panel with proper configuration
     */
    createPanel() {
        const panel = vscode.window.createWebviewPanel('1c-metadata-properties', '1C Metadata Properties', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [this.context.extensionUri],
        });
        // Handle panel disposal
        panel.onDidDispose(() => {
            this.dispose();
        }, null, this.disposables);
        // Handle messages from webview
        panel.webview.onDidReceiveMessage(async (message) => {
            await this.handleMessage(message);
        }, null, this.disposables);
        logger_1.Logger.info('Properties panel created');
        return panel;
    }
    /**
     * Update webview content with current node
     */
    updateWebviewContent() {
        if (!this.panel || !this.currentNode) {
            return;
        }
        const html = this.getWebviewContent(this.currentNode);
        this.panel.webview.html = html;
        logger_1.Logger.debug(`Properties panel updated for node: ${this.currentNode.name}`);
    }
    /**
     * Generate HTML content for webview
     */
    getWebviewContent(node) {
        // Handle empty state when no node is selected
        if (!node) {
            return this.getEmptyStateContent();
        }
        const properties = node.properties || {};
        const hasProperties = Object.keys(properties).length > 0;
        const readOnly = !node.filePath;
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
          .property-row {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
            gap: 12px;
          }
          .property-label {
            font-weight: bold;
            min-width: 150px;
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
    getEmptyStateContent() {
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
    /**
     * Render properties as input fields
     */
    renderProperties(properties, readOnly) {
        return Object.entries(properties)
            .map(([key, value]) => this.renderPropertyInput(key, value, readOnly))
            .join('');
    }
    /**
     * Render a single property input field
     */
    renderPropertyInput(name, value, readOnly) {
        const propertyType = this.detectPropertyType(value);
        const inputType = propertyType === 'boolean' ? 'checkbox' : propertyType === 'number' ? 'number' : 'text';
        const checked = propertyType === 'boolean' && value ? 'checked' : '';
        const inputValue = propertyType === 'boolean' ? '' : this.escapeHtml(String(value ?? ''));
        const disabled = readOnly ? 'disabled' : '';
        return `
      <div class="property-row">
        <label class="property-label">${this.escapeHtml(name)}</label>
        <input
          type="${inputType}"
          class="property-input"
          data-property="${this.escapeHtml(name)}"
          value="${inputValue}"
          ${checked}
          ${disabled}
        />
      </div>
    `;
    }
    /**
     * Detect property type from value
     */
    detectPropertyType(value) {
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
    getWebviewScript(readOnly) {
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

      // Attach event listeners
      function attachEventListeners() {
        document.querySelectorAll('.property-input').forEach(input => {
          input.addEventListener('change', handlePropertyChange);
          input.addEventListener('input', handlePropertyChange);
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
    async handleMessage(message) {
        logger_1.Logger.debug(`Received message from webview: ${message.type}`);
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
                default:
                    logger_1.Logger.warn(`Unknown message type: ${message.type}`);
            }
        }
        catch (error) {
            logger_1.Logger.error(`Error handling message: ${error}`);
            this.postMessage({
                type: 'error',
                message: error instanceof Error ? error.message : 'Unknown error occurred'
            });
        }
    }
    /**
     * Handle save message from webview
     */
    async handleSaveMessage(message) {
        if (!this.currentNode) {
            logger_1.Logger.warn('Save attempted with no current node');
            this.postMessage({
                type: 'error',
                message: 'No element selected'
            });
            return;
        }
        if (!message.properties) {
            logger_1.Logger.warn('Save attempted with no properties');
            this.postMessage({
                type: 'error',
                message: 'No properties to save'
            });
            return;
        }
        // Validate properties
        const validationResult = this.validateProperties(message.properties);
        if (!validationResult.valid) {
            logger_1.Logger.info('Validation failed', validationResult.errors);
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
            logger_1.Logger.info(`Properties saved successfully for node: ${this.currentNode.name}`);
        }
        catch (error) {
            logger_1.Logger.error(`Failed to save properties: ${error}`);
            this.postMessage({
                type: 'error',
                message: `Failed to save properties: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
        }
    }
    /**
     * Handle cancel message from webview
     */
    async handleCancelMessage() {
        if (!this.currentNode) {
            logger_1.Logger.warn('Cancel attempted with no current node');
            return;
        }
        // Reload original properties by sending update message
        this.postMessage({
            type: 'update',
            node: this.currentNode
        });
        logger_1.Logger.info(`Properties reset to original for node: ${this.currentNode.name}`);
    }
    /**
     * Handle validate message from webview
     */
    handleValidateMessage(message) {
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
     * Save property changes to XML file
     */
    async saveProperties(node, properties) {
        if (!node.filePath) {
            throw new Error('Cannot save properties: no file path associated with this element');
        }
        // For now, we'll update the in-memory properties
        // XML file writing will be implemented in a later task
        node.properties = { ...properties };
        // Refresh tree view to reflect changes
        this.treeDataProvider.refresh();
        logger_1.Logger.info(`Properties updated in memory for: ${node.filePath}`);
    }
    /**
     * Validate property values
     */
    validateProperties(properties) {
        const errors = {};
        if (!this.currentNode) {
            return { valid: false, errors: { _general: 'No element selected' } };
        }
        for (const [name, value] of Object.entries(properties)) {
            // Get expected type from original properties
            const originalValue = this.currentNode.properties[name];
            const expectedType = typeof originalValue;
            // Type validation
            const actualType = typeof value;
            if (expectedType === 'number' && actualType !== 'number') {
                if (actualType === 'string' && value !== '') {
                    // Try to parse as number
                    const parsed = parseFloat(value);
                    if (isNaN(parsed)) {
                        errors[name] = 'Must be a number';
                        continue;
                    }
                }
                else if (value !== null && value !== undefined && value !== '') {
                    errors[name] = 'Must be a number';
                    continue;
                }
            }
            if (expectedType === 'boolean' && actualType !== 'boolean') {
                errors[name] = 'Must be a boolean';
                continue;
            }
            // Required field validation (common required properties in 1C metadata)
            const requiredProperties = ['name', 'Name', 'Имя'];
            if (requiredProperties.includes(name)) {
                if (value === '' || value === null || value === undefined) {
                    errors[name] = 'This field is required';
                    continue;
                }
            }
            // String length validation
            if (actualType === 'string' && value.length > 1000) {
                errors[name] = 'Value is too long (max 1000 characters)';
            }
        }
        return {
            valid: Object.keys(errors).length === 0,
            errors
        };
    }
    /**
     * Send message to webview
     */
    postMessage(message) {
        if (!this.panel) {
            logger_1.Logger.warn('Attempted to post message with no active panel');
            return;
        }
        this.panel.webview.postMessage(message).then((success) => {
            if (success) {
                logger_1.Logger.debug(`Message sent to webview: ${message.type}`);
            }
            else {
                logger_1.Logger.warn(`Failed to send message to webview: ${message.type}`);
            }
        }, (error) => {
            logger_1.Logger.error(`Error sending message to webview: ${error}`);
        });
    }
    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const map = {
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
    dispose() {
        logger_1.Logger.info('Disposing PropertiesProvider');
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
exports.PropertiesProvider = PropertiesProvider;
//# sourceMappingURL=propertiesProvider.js.map