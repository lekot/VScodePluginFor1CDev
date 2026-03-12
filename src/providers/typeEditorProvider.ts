import * as vscode from 'vscode';
import { TypeDefinition } from '../types/typeDefinitions';
import { TypeParser } from '../parsers/typeParser';
import { Logger } from '../utils/logger';

interface WebviewMessage {
  type: 'save' | 'cancel' | 'validate';
  typeDefinition?: TypeDefinition;
  validationErrors?: string[];
}

export class TypeEditorProvider {
  private panel: vscode.WebviewPanel | undefined;
  private resolvePromise: ((value: TypeDefinition | null) => void) | undefined;
  private rejectPromise: ((reason: Error) => void) | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private context: vscode.ExtensionContext) {
    Logger.info('TypeEditorProvider initialized');
  }

  public async show(typeXML: string): Promise<TypeDefinition | null> {
    if (!this.panel) {
      this.panel = this.createPanel();
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }

    let typeDefinition: TypeDefinition;
    try {
      typeDefinition = TypeParser.parse(typeXML);
    } catch (error) {
      Logger.error('Failed to parse type XML', error);
      throw new Error(`Failed to parse current type: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.updateWebviewContent(typeDefinition);

    return new Promise<TypeDefinition | null>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  private createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      '1c-metadata-type-editor',
      'Type Editor',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      }
    );

    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(async (message) => await this.handleMessage(message), null, this.disposables);

    Logger.info('Type editor panel created');
    return panel;
  }

  private updateWebviewContent(typeDefinition: TypeDefinition): void {
    if (!this.panel) return;
    this.panel.webview.html = this.getWebviewContent(typeDefinition);
    Logger.debug('Type editor panel updated');
  }

  private getWebviewContent(typeDefinition: TypeDefinition): string {
    const currentTypeDisplay = this.formatTypeDisplay(typeDefinition);
    const typesJson = JSON.stringify(typeDefinition.types);
    
    // Determine which primitive type is currently selected (if any).
    // When category is primitive but types are empty, default to 'string' so qualifier fields are visible.
    let currentPrimitiveType: string | null = null;
    if (typeDefinition.category === 'primitive') {
      currentPrimitiveType = typeDefinition.types.length > 0
        ? typeDefinition.types[0].kind
        : 'string';
    }
    
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Type Editor</title>
        <style>
          :root {
            --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "Ubuntu", "Droid Sans", sans-serif;
            --vscode-font-size: 13px;
            --vscode-editor-background: #1e1e1e;
            --vscode-editor-foreground: #d4d4d4;
            --vscode-button-background: #0e639c;
            --vscode-button-foreground: #ffffff;
            --vscode-button-hoverBackground: #1177bb;
            --vscode-button-secondaryBackground: #3e3e3e;
            --vscode-button-secondaryForeground: #ffffff;
            --vscode-button-secondaryHoverBackground: #4e4e4e;
            --vscode-input-background: #3c3c3c;
            --vscode-input-foreground: #cccccc;
            --vscode-input-border: #cccccc;
            --vscode-dropdown-background: #3c3c3c;
            --vscode-dropdown-foreground: #cccccc;
            --vscode-dropdown-border: #cccccc;
            --vscode-list-hoverBackground: #2a2d2e;
            --vscode-focusBorder: #007fd4;
            --vscode-textLink-foreground: #3794ff;
            --vscode-errorForeground: #f48771;
            --vscode-descriptionForeground: #cccccc;
          }
          
          * {
            box-sizing: border-box;
          }
          
          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 16px;
            line-height: 1.5;
          }
          
          .container {
            max-width: 600px;
            margin: 0 auto;
          }
          
          .header {
            margin-bottom: 20px;
            border-bottom: 1px solid var(--vscode-dropdown-border);
            padding-bottom: 12px;
          }
          
          .header h2 {
            margin: 0;
            font-size: 18px;
            font-weight: 600;
          }
          
          .section {
            margin-bottom: 20px;
          }
          
          .section-title {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
            display: block;
          }
          
          .category-selector {
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
          }
          
          .category-option {
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
          }
          
          .category-option input[type="radio"] {
            accent-color: var(--vscode-button-background);
            width: 14px;
            height: 14px;
          }
          
          .category-option label {
            cursor: pointer;
            margin: 0;
          }
          
          .type-config-area {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 16px;
            min-height: 150px;
          }
          
          .config-section {
            display: none;
          }
          
          .config-section.active {
            display: block;
          }
          
          .form-group {
            margin-bottom: 12px;
          }
          
          .form-group label {
            display: block;
            font-size: 13px;
            margin-bottom: 4px;
            color: var(--vscode-descriptionForeground);
          }
          
          .form-group input[type="text"],
          .form-group input[type="number"],
          .form-group select {
            width: 100%;
            padding: 6px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-size: 13px;
            font-family: var(--vscode-font-family);
          }
          
          .form-group input:focus,
          .form-group select:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
          }
          
          .qualifier-group {
            display: none;
            margin-top: 12px;
          }
          
          .qualifier-group.active {
            display: block;
          }
          
          .form-row {
            display: flex;
            gap: 12px;
          }
          
          .form-row .form-group {
            flex: 1;
          }
          
          .type-list {
            list-style: none;
            padding: 0;
            margin: 0;
          }
          
          .type-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background-color: var(--vscode-list-hoverBackground);
            border-radius: 3px;
            margin-bottom: 8px;
          }
          
          .type-item-info {
            flex: 1;
          }
          
          .type-item-actions {
            display: flex;
            gap: 8px;
          }
          
          .btn-icon {
            background: none;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            padding: 4px;
            font-size: 16px;
          }
          
          .btn-icon:hover {
            text-decoration: underline;
          }
          
          .btn-add {
            width: 100%;
            padding: 8px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            margin-bottom: 12px;
          }
          
          .btn-add:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
          }
          
          .preview-section {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 12px;
            min-height: 60px;
          }
          
          .preview-value {
            font-family: "Consolas", "Courier New", monospace;
            font-size: 14px;
            word-break: break-all;
          }
          
          .button-row {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
            margin-top: 20px;
          }
          
          button {
            padding: 6px 14px;
            cursor: pointer;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            border-radius: 3px;
            border: none;
          }
          
          #save-btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
          }
          
          #save-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
          }
          
          #save-btn:disabled {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: not-allowed;
          }
          
          #cancel-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
          }
          
          #cancel-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
          }
          
          .error-message {
            color: var(--vscode-errorForeground);
            font-size: 12px;
            margin-top: 4px;
            display: none;
          }
          
          .error-message.visible {
            display: block;
          }
          
          .empty-state {
            text-align: center;
            color: var(--vscode-descriptionForeground);
            padding: 20px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>Type Editor</h2>
          </div>
          
          <div class="section">
            <span class="section-title">Category</span>
            <div class="category-selector">
              <label class="category-option">
                <input type="radio" name="category" value="primitive" ${typeDefinition.category === 'primitive' ? 'checked' : ''}>
                Primitive
              </label>
              <label class="category-option">
                <input type="radio" name="category" value="reference" ${typeDefinition.category === 'reference' ? 'checked' : ''}>
                Reference
              </label>
              <label class="category-option">
                <input type="radio" name="category" value="composite" ${typeDefinition.category === 'composite' ? 'checked' : ''}>
                Composite
              </label>
            </div>
          </div>
          
          <div class="section">
            <span class="section-title">Type Configuration</span>
            <div class="type-config-area">
              <!-- Primitive Type Config -->
              <div id="config-primitive" class="config-section ${typeDefinition.category === 'primitive' ? 'active' : ''}">
                <div class="form-group">
                  <label for="primitive-type">Type</label>
                  <select id="primitive-type">
                    <option value="string" ${currentPrimitiveType === 'string' ? 'selected' : ''}>String</option>
                    <option value="number" ${currentPrimitiveType === 'number' ? 'selected' : ''}>Number</option>
                    <option value="boolean" ${currentPrimitiveType === 'boolean' ? 'selected' : ''}>Boolean</option>
                    <option value="date" ${currentPrimitiveType === 'date' ? 'selected' : ''}>Date</option>
                  </select>
                </div>
                
                <div id="string-qualifiers" class="qualifier-group ${currentPrimitiveType === 'string' ? 'active' : ''}">
                  <div class="form-row">
                    <div class="form-group">
                      <label for="string-length">Length</label>
                      <input type="number" id="string-length" min="1" max="1024" value="${this.getQualifierValue(typeDefinition, 'string', 'length') || ''}">
                    </div>
                    <div class="form-group">
                      <label for="string-allowed-length">Allowed Length</label>
                      <select id="string-allowed-length">
                        <option value="Fixed" ${this.getQualifierValue(typeDefinition, 'string', 'allowedLength') === 'Fixed' ? 'selected' : ''}>Fixed</option>
                        <option value="Variable" ${this.getQualifierValue(typeDefinition, 'string', 'allowedLength') === 'Variable' ? 'selected' : ''}>Variable</option>
                      </select>
                    </div>
                  </div>
                </div>
                
                <div id="number-qualifiers" class="qualifier-group ${currentPrimitiveType === 'number' ? 'active' : ''}">
                  <div class="form-row">
                    <div class="form-group">
                      <label for="number-digits">Digits</label>
                      <input type="number" id="number-digits" min="1" max="38" value="${this.getQualifierValue(typeDefinition, 'number', 'digits') || ''}">
                    </div>
                    <div class="form-group">
                      <label for="number-fraction-digits">Fraction Digits</label>
                      <input type="number" id="number-fraction-digits" min="0" max="38" value="${this.getQualifierValue(typeDefinition, 'number', 'fractionDigits') || ''}">
                    </div>
                  </div>
                  <div class="form-group">
                    <label for="number-allowed-sign">Allowed Sign</label>
                    <select id="number-allowed-sign">
                      <option value="Any" ${this.getQualifierValue(typeDefinition, 'number', 'allowedSign') === 'Any' ? 'selected' : ''}>Any</option>
                      <option value="Nonnegative" ${this.getQualifierValue(typeDefinition, 'number', 'allowedSign') === 'Nonnegative' ? 'selected' : ''}>Nonnegative</option>
                    </select>
                  </div>
                </div>
                
                <div id="date-qualifiers" class="qualifier-group ${currentPrimitiveType === 'date' ? 'active' : ''}">
                  <div class="form-group">
                    <label for="date-fractions">Date Fractions</label>
                    <select id="date-fractions">
                      <option value="Date" ${this.getQualifierValue(typeDefinition, 'date', 'dateFractions') === 'Date' ? 'selected' : ''}>Date</option>
                      <option value="DateTime" ${this.getQualifierValue(typeDefinition, 'date', 'dateFractions') === 'DateTime' ? 'selected' : ''}>DateTime</option>
                      <option value="Time" ${this.getQualifierValue(typeDefinition, 'date', 'dateFractions') === 'Time' ? 'selected' : ''}>Time</option>
                    </select>
                  </div>
                </div>
              </div>
              
              <!-- Reference Type Config -->
              <div id="config-reference" class="config-section ${typeDefinition.category === 'reference' ? 'active' : ''}">
                <div class="form-group">
                  <label for="reference-kind">Reference Kind</label>
                  <select id="reference-kind">
                    <option value="CatalogRef">CatalogRef</option>
                    <option value="DocumentRef">DocumentRef</option>
                    <option value="EnumRef">EnumRef</option>
                    <option value="ChartOfCharacteristicTypesRef">ChartOfCharacteristicTypesRef</option>
                    <option value="ChartOfAccountsRef">ChartOfAccountsRef</option>
                    <option value="ChartOfCalculationTypesRef">ChartOfCalculationTypesRef</option>
                  </select>
                </div>
                <div class="form-group">
                  <label for="reference-object">Object Name</label>
                  <input type="text" id="reference-object" value="${this.getReferenceValue(typeDefinition) || ''}" placeholder="Enter object name">
                </div>
              </div>
              
              <!-- Composite Type Config -->
              <div id="config-composite" class="config-section ${typeDefinition.category === 'composite' ? 'active' : ''}">
                <div id="composite-list">
                  ${this.renderCompositeList(typeDefinition)}
                </div>
                <button type="button" class="btn-add" id="add-type-btn">+ Add Type</button>
              </div>
            </div>
          </div>
          
          <div class="section">
            <span class="section-title">Type Preview</span>
            <div class="preview-section">
              <div id="preview-value" class="preview-value">${this.escapeHtml(currentTypeDisplay)}</div>
            </div>
          </div>
          
          <div class="button-row">
            <button type="button" id="cancel-btn">Cancel</button>
            <button type="button" id="save-btn" ${typeDefinition.types.length === 0 ? 'disabled' : ''}>Save</button>
          </div>
        </div>
        
        <script>
          const vscode = acquireVsCodeApi();
          
          // State
          let currentState = ${typesJson};
          let currentCategory = '${typeDefinition.category}';
          let hasChanges = false;
          
          // DOM Elements
          const categoryRadios = document.querySelectorAll('input[name="category"]');
          const configSections = {
            primitive: document.getElementById('config-primitive'),
            reference: document.getElementById('config-reference'),
            composite: document.getElementById('config-composite')
          };
          const primitiveTypeSelect = document.getElementById('primitive-type');
          const qualifierGroups = {
            string: document.getElementById('string-qualifiers'),
            number: document.getElementById('number-qualifiers'),
            date: document.getElementById('date-qualifiers')
          };
          const saveBtn = document.getElementById('save-btn');
          const previewValue = document.getElementById('preview-value');
          
          // Change detection function
          function markAsChanged() {
            hasChanges = true;
            saveBtn.disabled = false;
          }
          
          // Category selection handler
          categoryRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
              currentCategory = e.target.value;
              // Hide all config sections
              for (const section of Object.values(configSections)) {
                if (section) section.classList.remove('active');
              }
              // Show selected config section
              const activeSection = configSections[currentCategory];
              if (activeSection) activeSection.classList.add('active');
              syncStateFromQualifierInputs();
              markAsChanged();
              updatePreview();
            });
          });
          
          // Primitive type selection handler
          primitiveTypeSelect.addEventListener('change', () => {
            const selectedType = primitiveTypeSelect.value;
            
            // Hide all qualifier groups first
            for (const group of Object.values(qualifierGroups)) {
              if (group) group.classList.remove('active');
            }
            
            // Show qualifier group for selected type
            if (selectedType === 'string' && qualifierGroups.string) {
              qualifierGroups.string.classList.add('active');
            } else if (selectedType === 'number' && qualifierGroups.number) {
              qualifierGroups.number.classList.add('active');
            } else if (selectedType === 'date' && qualifierGroups.date) {
              qualifierGroups.date.classList.add('active');
            }
            // Boolean has no qualifiers, so no group is shown
            
            syncStateFromQualifierInputs();
            markAsChanged();
            updatePreview();
          });
          
          // Sync currentState from qualifier/reference form inputs (for primitive or reference single-type).
          function syncStateFromQualifierInputs() {
            if (currentCategory === 'primitive') {
              const kind = primitiveTypeSelect.value;
              let qualifiers = undefined;
              if (kind === 'string') {
                const lenEl = document.getElementById('string-length');
                const allowedEl = document.getElementById('string-allowed-length');
                const len = lenEl && lenEl.value !== '' ? parseInt(lenEl.value, 10) : undefined;
                if (len !== undefined) qualifiers = { length: len, allowedLength: (allowedEl && allowedEl.value) || 'Variable' };
              } else if (kind === 'number') {
                const d = document.getElementById('number-digits');
                const f = document.getElementById('number-fraction-digits');
                const s = document.getElementById('number-allowed-sign');
                const digits = d && d.value !== '' ? parseInt(d.value, 10) : undefined;
                const fractionDigits = f && f.value !== '' ? parseInt(f.value, 10) : undefined;
                if (digits !== undefined && fractionDigits !== undefined) qualifiers = { digits, fractionDigits, allowedSign: (s && s.value) || 'Any' };
              } else if (kind === 'date') {
                const df = document.getElementById('date-fractions');
                if (df && df.value) qualifiers = { dateFractions: df.value };
              }
              currentState = [{ kind, qualifiers }];
            } else if (currentCategory === 'reference') {
              const kindEl = document.getElementById('reference-kind');
              const objEl = document.getElementById('reference-object');
              const referenceKind = (kindEl && kindEl.value) || 'CatalogRef';
              const objectName = (objEl && objEl.value) || '';
              currentState = [{ kind: 'reference', referenceType: { referenceKind, objectName } }];
            }
          }
          
          // Add change detection to all qualifier input fields
          const stringLengthInput = document.getElementById('string-length');
          const stringAllowedLengthSelect = document.getElementById('string-allowed-length');
          const numberDigitsInput = document.getElementById('number-digits');
          const numberFractionDigitsInput = document.getElementById('number-fraction-digits');
          const numberAllowedSignSelect = document.getElementById('number-allowed-sign');
          const dateFractionsSelect = document.getElementById('date-fractions');
          
          if (stringLengthInput) {
            stringLengthInput.addEventListener('input', () => { syncStateFromQualifierInputs(); markAsChanged(); updatePreview(); });
          }
          if (stringAllowedLengthSelect) {
            stringAllowedLengthSelect.addEventListener('change', () => { syncStateFromQualifierInputs(); markAsChanged(); updatePreview(); });
          }
          if (numberDigitsInput) {
            numberDigitsInput.addEventListener('input', () => { syncStateFromQualifierInputs(); markAsChanged(); updatePreview(); });
          }
          if (numberFractionDigitsInput) {
            numberFractionDigitsInput.addEventListener('input', () => { syncStateFromQualifierInputs(); markAsChanged(); updatePreview(); });
          }
          if (numberAllowedSignSelect) {
            numberAllowedSignSelect.addEventListener('change', () => { syncStateFromQualifierInputs(); markAsChanged(); updatePreview(); });
          }
          if (dateFractionsSelect) {
            dateFractionsSelect.addEventListener('change', () => { syncStateFromQualifierInputs(); markAsChanged(); updatePreview(); });
          }
          
          // Add change detection to reference fields
          const referenceKindSelect = document.getElementById('reference-kind');
          const referenceObjectInput = document.getElementById('reference-object');
          
          if (referenceKindSelect) {
            referenceKindSelect.addEventListener('change', () => { syncStateFromQualifierInputs(); markAsChanged(); updatePreview(); });
          }
          if (referenceObjectInput) {
            referenceObjectInput.addEventListener('input', () => { syncStateFromQualifierInputs(); markAsChanged(); updatePreview(); });
          }
          
          // Update preview function
          function updatePreview() {
            const display = currentState.length === 0 ? 'Not set' : currentState.map(entry => {
              switch (entry.kind) {
                case 'string': {
                  const q = entry.qualifiers;
                  return q ? 'String(' + q.length + ')' : 'String';
                }
                case 'number': {
                  const q = entry.qualifiers;
                  return q ? 'Number(' + q.digits + ',' + q.fractionDigits + ')' : 'Number';
                }
                case 'boolean': return 'Boolean';
                case 'date': {
                  const q = entry.qualifiers;
                  return q ? q.dateFractions : 'Date';
                }
                case 'reference': {
                  return entry.referenceType ? entry.referenceType.referenceKind + '.' + entry.referenceType.objectName : 'Reference';
                }
                default: return 'Unknown';
              }
            }).join(' | ');
            
            previewValue.textContent = display;
            // Enable Save when there are types or user has made changes
            saveBtn.disabled = !hasChanges && currentState.length === 0;
          }
          
          // Button handlers
          document.getElementById('cancel-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'cancel' });
          });
          
          document.getElementById('save-btn').addEventListener('click', () => {
            syncStateFromQualifierInputs();
            vscode.postMessage({ type: 'save', typeDefinition: { category: currentCategory, types: currentState } });
          });
          
          // Initialize: sync state from form when primitive so Save is enabled and qualifiers apply
          if (currentCategory === 'primitive') syncStateFromQualifierInputs();
          updatePreview();
        </script>
      </body>
      </html>
    `;
  }

  private formatTypeDisplay(typeDefinition: TypeDefinition): string {
    if (typeDefinition.types.length === 0) return 'Not set';
    return typeDefinition.types.map(entry => {
      switch (entry.kind) {
        case 'string': return entry.qualifiers ? `String(${(entry.qualifiers as any).length})` : 'String';
        case 'number': return entry.qualifiers ? `Number(${(entry.qualifiers as any).digits},${(entry.qualifiers as any).fractionDigits})` : 'Number';
        case 'boolean': return 'Boolean';
        case 'date': return entry.qualifiers ? (entry.qualifiers as any).dateFractions : 'Date';
        case 'reference': return entry.referenceType ? `${entry.referenceType.referenceKind}.${entry.referenceType.objectName}` : 'Reference';
        default: return 'Unknown';
      }
    }).join(' | ');
  }

  private getQualifierValue(typeDefinition: TypeDefinition, kind: string, qualifier: string): any {
    const entry = typeDefinition.types.find(t => t.kind === kind);
    if (entry && entry.qualifiers) {
      return (entry.qualifiers as any)[qualifier];
    }
    return undefined;
  }

  private getReferenceValue(typeDefinition: TypeDefinition): string | undefined {
    const entry = typeDefinition.types.find(t => t.kind === 'reference');
    return entry?.referenceType?.objectName;
  }

  private renderCompositeList(typeDefinition: TypeDefinition): string {
    if (typeDefinition.types.length === 0) {
      return '<div class="empty-state">No types added yet. Click "+ Add Type" to add a type.</div>';
    }
    
    return typeDefinition.types.map((entry, index) => {
      const display = this.formatTypeDisplay({ category: typeDefinition.category, types: [entry] });
      return `
        <li class="type-item">
          <span class="type-item-info">${this.escapeHtml(display)}</span>
          <div class="type-item-actions">
            <button type="button" class="btn-icon" data-action="remove" data-index="${index}">&times;</button>
          </div>
        </li>
      `;
    }).join('');
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    Logger.debug(`Received: ${message.type}`);
    if (message.type === 'save' || message.type === 'cancel') {
      Logger.info(`Type editor: ${message.type} received from webview`);
    }
    try {
      switch (message.type) {
        case 'save': await this.handleSaveMessage(message); break;
        case 'cancel': await this.handleCancelMessage(); break;
        case 'validate': await this.handleValidateMessage(message); break;
      }
    } catch (error) {
      Logger.error('Error handling message', error);
    }
  }

  private async handleValidateMessage(message: WebviewMessage): Promise<void> {
    if (!this.panel) return;
    
    const errors = this.validateTypeDefinition(message.typeDefinition);
    this.panel.webview.postMessage({ type: 'validationResult', errors });
  }

  private validateTypeDefinition(typeDefinition?: TypeDefinition): string[] {
    const errors: string[] = [];
    
    if (!typeDefinition || typeDefinition.types.length === 0) {
      errors.push('Type definition is required');
      return errors;
    }
    
    for (const entry of typeDefinition.types) {
      switch (entry.kind) {
        case 'string':
          if (entry.qualifiers) {
            const q = entry.qualifiers as any;
            if (q.length !== undefined && (q.length < 1 || q.length > 1024)) {
              errors.push(`String length must be between 1 and 1024, got ${q.length}`);
            }
          }
          break;
          
        case 'number':
          if (entry.qualifiers) {
            const q = entry.qualifiers as any;
            if (q.digits !== undefined && (q.digits < 1 || q.digits > 38)) {
              errors.push(`Number digits must be between 1 and 38, got ${q.digits}`);
            }
            if (q.fractionDigits !== undefined && (q.fractionDigits < 0 || q.fractionDigits > (q.digits || 38))) {
              errors.push(`Number fraction digits must be between 0 and ${q.digits || 38}, got ${q.fractionDigits}`);
            }
          }
          break;
          
        case 'reference':
          if (!entry.referenceType || !entry.referenceType.objectName) {
            errors.push('Reference type must have an object name');
          }
          break;
      }
    }
    
    return errors;
  }

  private async handleSaveMessage(message: WebviewMessage): Promise<void> {
    if (!message.typeDefinition || !this.resolvePromise) {
      Logger.warn('Type editor save ignored: missing typeDefinition or resolvePromise');
      return;
    }
    const def = message.typeDefinition;
    if (!Array.isArray(def.types) || def.types.length === 0) {
      Logger.warn('Type editor save ignored: types empty or not array');
      return;
    }
    const typeDefinition: TypeDefinition = {
      category: def.category === 'reference' || def.category === 'composite' ? def.category : 'primitive',
      types: def.types,
    };
    this.resolvePromise(typeDefinition);
    this.resolvePromise = undefined;
    Logger.info('Type editor: save applied, closing panel');
    if (this.panel) {
      const p = this.panel;
      this.panel = undefined;
      p.dispose();
    }
  }

  private async handleCancelMessage(): Promise<void> {
    Logger.info('Type editor: cancel applied, closing panel');
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = undefined;
    }
    if (this.panel) {
      const p = this.panel;
      this.panel = undefined;
      p.dispose();
    }
  }

  private escapeHtml(text: string): string {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  public dispose(): void {
    Logger.info('Disposing TypeEditorProvider');
    if (this.rejectPromise) { this.rejectPromise(new Error('Type editor closed')); this.rejectPromise = undefined; }
    if (this.resolvePromise) { this.resolvePromise(null); this.resolvePromise = undefined; }
    if (this.panel) { this.panel.dispose(); this.panel = undefined; }
    while (this.disposables.length) { const d = this.disposables.pop(); if (d) d.dispose(); }
  }
}
