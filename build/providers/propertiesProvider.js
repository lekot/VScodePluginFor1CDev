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
 * Properties View Provider for displaying element properties
 */
class PropertiesProvider {
    constructor(context) {
        this.context = context;
        this.webviewPanel = null;
        this.selectedNode = null;
        logger_1.Logger.info('PropertiesProvider initialized');
    }
    /**
     * Show properties for a node
     */
    showProperties(node) {
        this.selectedNode = node;
        if (!this.webviewPanel) {
            this.createWebviewPanel();
        }
        this.updateWebviewContent();
    }
    /**
     * Create webview panel for properties
     */
    createWebviewPanel() {
        this.webviewPanel = vscode.window.createWebviewPanel('1c-metadata-properties', '1C Metadata Properties', vscode.ViewColumn.Beside, {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        });
        this.webviewPanel.onDidDispose(() => {
            this.webviewPanel = null;
        });
    }
    /**
     * Update webview content
     */
    updateWebviewContent() {
        if (!this.webviewPanel || !this.selectedNode) {
            return;
        }
        const html = this.getWebviewContent(this.selectedNode);
        this.webviewPanel.webview.html = html;
    }
    /**
     * Generate HTML content for webview
     */
    getWebviewContent(node) {
        const properties = node.properties || {};
        return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Properties</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 10px;
          }
          .property {
            margin-bottom: 10px;
          }
          .property-label {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
          }
          .property-value {
            margin-left: 10px;
            color: var(--vscode-foreground);
          }
        </style>
      </head>
      <body>
        <h2>${node.name}</h2>
        <p><strong>Type:</strong> ${node.type}</p>
        <div id="properties">
          ${Object.entries(properties)
            .map(([key, value]) => `
            <div class="property">
              <span class="property-label">${key}:</span>
              <span class="property-value">${String(value)}</span>
            </div>
          `)
            .join('')}
        </div>
      </body>
      </html>
    `;
    }
}
exports.PropertiesProvider = PropertiesProvider;
//# sourceMappingURL=propertiesProvider.js.map