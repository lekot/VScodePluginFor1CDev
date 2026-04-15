import { TreeNode } from '../models/treeNode';
import { Logger } from '../utils/logger';
import { TypeParser } from '../parsers/typeParser';
import { TypeFormatter } from '../utils/typeFormatter';
import { getPropertyLabel } from '../constants/propertyLabels';
import {
  getPropertySectionsForType,
  getKnownPropertyNamesForType,
  OTHER_SECTION_TITLE,
  DEFAULT_SECTION_TITLE,
} from '../constants/propertySections';
import { getPropertyEnumValues } from '../constants/propertyEnumValues';
import { MESSAGES } from '../constants/messages';
import type { FormSelectionPayload } from '../formEditor/formMessageHandler';
import { FORM_EVENT_CATALOG, FORM_LEVEL_EVENTS } from '../formEditor/formEventCatalog';

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(text: string): string {
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
 * Inline SVG for pencil (edit) icon — used in webview; no external font required.
 * Matches VSCode codicon-edit style; aria-hidden on parent span.
 */
export function getEditTypePencilSvg(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.23 1h-1.46L3.52 9.85l-.16.22L1 13.11 2.41 14.5l3.04-2.35.22-.16L15 4.23V2.77L13.23 1zM2.41 11.59l.59-.59.59.59-.59.59-.59-.59zm1.83-1.83l.59-.59 3.54 3.54-.59.59-3.54-3.54zM11.77 2L14 4.23l-1.17 1.17L10.6 3.17 11.77 2z"/></svg>`;
}

/**
 * Check if node is a root metadata element (Catalog, Document, etc.)
 * Note: Attribute is NOT in this list because it's a nested element
 * and should have an editable type property
 */
export function isRootElement(node: TreeNode | undefined): boolean {
  if (!node) {
    return false;
  }

  // Nested elements (Attributes, TabularSections, etc.) have parentFilePath
  // They are NOT root elements even if they don't have parent reference
  if (node.parentFilePath) {
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
    'Interface', 'SessionParameter',
  ];

  return rootTypes.includes(node.type);
}

/**
 * Detect property type from value
 */
export function detectPropertyType(value: unknown): 'string' | 'boolean' | 'number' | 'unknown' {
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
 * Render a single property input field.
 * @param currentNode — needed to determine if Type field should be read-only
 */
export function renderPropertyInput(
  name: string,
  value: unknown,
  globalReadOnly: boolean,
  currentNode: TreeNode | undefined
): string {
  // Format Type property if it's an object (defensive fallback)
  let displayValue = value;
  const isTypeProperty = name.toLowerCase() === 'type';

  if (isTypeProperty && (value === null || value === undefined)) {
    displayValue = 'Not set';
  } else if (isTypeProperty && typeof value === 'object' && value !== null) {
    try {
      const typeDef = TypeParser.parseFromObject(value as Record<string, unknown>);
      displayValue = TypeFormatter.formatTypeDisplay(typeDef);
    } catch (error) {
      Logger.error('Failed to format Type in renderPropertyInput', error);
      displayValue = '[Invalid Type]';
    }
  } else if (isTypeProperty && typeof value === 'string' && value.includes('<')) {
    try {
      const typeDef = TypeParser.parse(value);
      displayValue = TypeFormatter.formatTypeDisplay(typeDef);
    } catch (error) {
      Logger.error('Failed to parse Type XML in renderPropertyInput', error);
      displayValue = '[Invalid Type]';
    }
  }

  // Complex objects/arrays (except Type which is handled above) — render as read-only summary
  if (!isTypeProperty && (Array.isArray(displayValue) || (typeof displayValue === 'object' && displayValue !== null))) {
    const displayName = getPropertyLabel(name);
    const summary = Array.isArray(displayValue)
      ? `[${displayValue.length} элем.]`
      : '{...}';
    return `
      <div class="property-row">
        <label class="property-label">${escapeHtml(displayName)}</label>
        <input type="text" class="property-input" data-property="${escapeHtml(name)}" value="${escapeHtml(summary)}" disabled />
      </div>
    `;
  }

  const propertyType = detectPropertyType(displayValue);

  // Determine if this specific property should be read-only
  const nodeIsRoot = isRootElement(currentNode);
  const typeEditableRootTypes = ['DefinedType', 'ChartOfCharacteristicTypes', 'SessionParameter', 'FilterCriterion', 'CommonAttribute'];
  const propertyReadOnly = globalReadOnly || (nodeIsRoot && isTypeProperty && !typeEditableRootTypes.includes(currentNode?.type ?? ''));
  const disabled = propertyReadOnly ? 'disabled' : '';

  // Get Russian label for property name
  const displayName = getPropertyLabel(name);

  const editTypeButton = isTypeProperty && !propertyReadOnly ? `
    <button type="button" class="edit-type-btn" data-property="${escapeHtml(name)}" aria-label="Редактировать тип" title="Редактировать тип">
      <span class="edit-type-icon" aria-hidden="true">${getEditTypePencilSvg()}</span>
    </button>
  ` : '';

  // Render <select> for enum properties
  const enumValues = getPropertyEnumValues(name);
  if (enumValues && !isTypeProperty && !propertyReadOnly) {
    const currentValue = String(displayValue ?? '');
    const options = enumValues.map(v =>
      `<option value="${escapeHtml(v)}"${v === currentValue ? ' selected' : ''}>${escapeHtml(v)}</option>`
    ).join('');
    // Add current value as option if not in the list (unknown/legacy value)
    const unknownOption = currentValue && !enumValues.includes(currentValue)
      ? `<option value="${escapeHtml(currentValue)}" selected>${escapeHtml(currentValue)}</option>`
      : '';
    return `
      <div class="property-row">
        <label class="property-label">${escapeHtml(displayName)}</label>
        <select class="property-input" data-property="${escapeHtml(name)}" ${disabled}>
          ${unknownOption}${options}
        </select>
      </div>
    `;
  }

  const inputType = propertyType === 'boolean' ? 'checkbox' : propertyType === 'number' ? 'number' : 'text';
  const checked = propertyType === 'boolean' && displayValue ? 'checked' : '';
  const inputValue = propertyType === 'boolean' ? '' : escapeHtml(String(displayValue ?? ''));

  return `
    <div class="property-row">
      <label class="property-label">${escapeHtml(displayName)}</label>
      <input
        type="${inputType}"
        class="property-input"
        data-property="${escapeHtml(name)}"
        value="${inputValue}"
        ${checked}
        ${disabled}
      />
      ${editTypeButton}
    </div>
  `;
}

/**
 * Render properties grouped by type-specific sections.
 * Uses getPropertySectionsForType(node.type); properties not in any section go to "Прочее".
 */
export function renderPropertiesBySections(node: TreeNode, readOnly: boolean): string {
  const properties = (node.properties || {}) as Record<string, unknown>;
  const sections = getPropertySectionsForType(node.type);
  const knownNames = getKnownPropertyNamesForType(node.type);
  const allKeys = Object.keys(properties);
  const otherKeys = allKeys.filter((k) => !knownNames.has(k));

  let html = '';

  // Type-specific sections with defined propertyNames
  for (const section of sections) {
    const namesInSection =
      section.propertyNames.length > 0
        ? section.propertyNames.filter((name) => name in properties)
        : allKeys;
    if (namesInSection.length === 0 && section.title !== DEFAULT_SECTION_TITLE) {
      continue;
    }
    if (section.propertyNames.length === 0 && section.title === DEFAULT_SECTION_TITLE) {
      // Default: single block with all properties
      html += `<div class="property-section"><div class="property-section-title">${escapeHtml(section.title)}</div>`;
      for (const key of allKeys) {
        html += renderPropertyInput(key, properties[key], readOnly, node);
      }
      html += '</div>';
      break;
    }
    html += `<div class="property-section"><div class="property-section-title">${escapeHtml(section.title)}</div>`;
    for (const name of namesInSection) {
      if (name in properties) {
        html += renderPropertyInput(name, properties[name], readOnly, node);
      }
    }
    html += '</div>';
  }

  // "Прочее" only when we have type-specific sections (knownNames non-empty)
  if (knownNames.size > 0 && otherKeys.length > 0) {
    html += `<div class="property-section"><div class="property-section-title">${escapeHtml(OTHER_SECTION_TITLE)}</div>`;
    for (const key of otherKeys) {
      html += renderPropertyInput(key, properties[key], readOnly, node);
    }
    html += '</div>';
  }

  return html;
}

/**
 * Generate webview JavaScript for client-side interaction
 */
export function getWebviewScript(readOnly: boolean): string {
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
        // Skip disabled inputs (complex objects/arrays rendered as {...} or [N элем.])
        if (input.disabled) {
          return;
        }

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

      // Skip disabled inputs (complex objects/arrays)
      if (input.disabled) {
        return;
      }

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

    // Handle edit type button click (listener is on the button, so currentTarget is the button)
    function handleEditType(event) {
      const btn = event.currentTarget || (event.target && event.target.closest && event.target.closest('.edit-type-btn'));
      if (btn && btn.dataset && btn.dataset.property) {
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
          const propertyName = message.property;
          const newValue = message.value;
          const esc = (s) => (s || '').replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
          const input = document.querySelector(\`.property-input[data-property="\${esc(propertyName)}"]\`);
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
 * Generate HTML content for webview
 */
export function getWebviewContent(node: TreeNode): string {
  // Handle empty state when no node is selected
  if (!node) {
    return getEmptyStateContent();
  }

  const properties = node.properties || {};
  const hasProperties = Object.keys(properties).length > 0;

  // Switch to read-only mode when file path is missing
  // For nested elements (Attributes), check parentFilePath; for root elements, check filePath
  const readOnly = !(node.parentFilePath || node.filePath);

  Logger.debug(`getWebviewContent: node.name="${node.name}", node.type="${node.type}", readOnly=${readOnly}`);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
          border: none;
          cursor: pointer;
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
          border-radius: 2px;
        }
        #save-btn {
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
        }
        #save-btn:hover:not(:disabled) {
          background: var(--vscode-button-hoverBackground);
        }
        #cancel-btn {
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
        }
        #cancel-btn:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .edit-type-btn {
          padding: 4px 8px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 28px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
        }
        .edit-type-btn:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        .edit-type-icon {
          display: inline-flex;
          line-height: 0;
        }
        .edit-type-icon svg {
          vertical-align: middle;
        }
        .empty-state {
          text-align: center;
          padding: 40px;
          color: var(--vscode-descriptionForeground);
        }
        .empty-state h3 { margin: 0 0 12px 0; }
        .empty-state p { margin: 0; }
        .property-section {
          margin-bottom: 20px;
        }
        .property-section-title {
          font-size: 0.95em;
          font-weight: 600;
          color: var(--vscode-descriptionForeground);
          margin-bottom: 8px;
          padding-bottom: 4px;
          border-bottom: 1px solid var(--vscode-panel-border);
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>Свойства: ${escapeHtml(node.name)} (${escapeHtml(node.type)})</h2>
      </div>
      ${readOnly ? `
        <div class="read-only-notice">
          <strong>Read-Only Mode:</strong> This element has no associated file path. Properties cannot be saved.
        </div>
      ` : ''}
      ${hasProperties ? `
        <div id="properties">
          ${renderPropertiesBySections(node, readOnly)}
        </div>
        ${!readOnly ? `
          <div class="button-row">
            <button id="cancel-btn" title="Отмена" aria-label="Отмена">Отмена</button>
            <button id="save-btn" disabled title="Сохранить" aria-label="Сохранить">Сохранить</button>
          </div>
        ` : ''}
      ` : `
        <div class="empty-state">
          <h3>${escapeHtml(MESSAGES.EMPTY_STATE_NO_PROPERTIES_TITLE)}</h3>
          <p>${escapeHtml(MESSAGES.EMPTY_STATE_NO_PROPERTIES_HINT)}</p>
        </div>
      `}
      <script>
        ${getWebviewScript(readOnly)}
      </script>
    </body>
    </html>
  `;
}

/**
 * Generate empty state HTML when no element is selected
 */
export function getEmptyStateContent(): string {
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
        <h3>${escapeHtml(MESSAGES.EMPTY_STATE_NO_SELECTION_TITLE)}</h3>
        <p>${escapeHtml(MESSAGES.EMPTY_STATE_NO_SELECTION_HINT)}</p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Show error message in properties panel — returns HTML string.
 */
export function getErrorPanelContent(node: TreeNode, title: string, details: string): string {
  return `
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
        <h2>Свойства: ${escapeHtml(node.name)} (${escapeHtml(node.type)})</h2>
      </div>
      <div class="error-box">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(details)}</p>
        ${node.filePath ? `
          <div class="file-path">
            <strong>File:</strong> ${escapeHtml(node.filePath)}
          </div>
        ` : ''}
      </div>
    </body>
    </html>
  `;
}

/**
 * Generate webview HTML for form selection properties.
 * @param selection — form element selection payload
 * @param currentFormSelectionRevision — revision counter to detect stale updates
 */
export function getFormSelectionWebviewContent(
  selection: FormSelectionPayload,
  currentFormSelectionRevision: number
): string {
  const props = selection.properties || {};
  const selectedIds = Array.isArray(selection.selectedIds) ? selection.selectedIds : [];
  const isMultiSelection = selectedIds.length > 1;
  const entries = Object.entries(props)
    .filter(([k]) => k !== ':@' && !k.startsWith('@'))
    .slice(0, 24);
  const lines = isMultiSelection
    ? `
      <div class="empty-state">
        <p>Выбрано элементов: ${selectedIds.length}</p>
        <p>Mixed-state режим: редактирование свойств для multi-select пока отключено.</p>
      </div>
    `
    : entries.length
    ? entries.map(([k, v]) => {
        const raw = Array.isArray(v) || (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v ?? '');
        const isComplex = Array.isArray(v) || (typeof v === 'object' && v !== null);
        const isTypeProperty = k.toLowerCase() === 'type';
        const editorControl = isComplex
          ? `
            <textarea
              class="property-input property-input-textarea"
              data-form-scope="property"
              data-form-key="${escapeHtml(k)}"
              data-form-value-kind="json"
              data-form-doc-uri="${escapeHtml(selection.docUri)}"
              data-form-entity-type="${escapeHtml(selection.entityType)}"
              data-form-entity-id="${escapeHtml(selection.id || '')}"
              data-form-entity-name="${escapeHtml(selection.name || '')}"
              data-form-selection-revision="${String(currentFormSelectionRevision)}"
            >${escapeHtml(raw)}</textarea>
          `
          : `
            <input
              type="text"
              class="property-input"
              data-form-scope="property"
              data-form-key="${escapeHtml(k)}"
              data-form-value-kind="primitive"
              data-form-doc-uri="${escapeHtml(selection.docUri)}"
              data-form-entity-type="${escapeHtml(selection.entityType)}"
              data-form-entity-id="${escapeHtml(selection.id || '')}"
              data-form-entity-name="${escapeHtml(selection.name || '')}"
              data-form-selection-revision="${String(currentFormSelectionRevision)}"
              value="${escapeHtml(raw)}"
            />
          `;
        const editTypeButton = isTypeProperty
          ? `
            <button
              type="button"
              class="edit-form-type-btn"
              data-form-type-key="${escapeHtml(k)}"
              data-form-doc-uri="${escapeHtml(selection.docUri)}"
              data-form-entity-type="${escapeHtml(selection.entityType)}"
              data-form-entity-id="${escapeHtml(selection.id || '')}"
              data-form-entity-name="${escapeHtml(selection.name || '')}"
              data-form-selection-revision="${String(currentFormSelectionRevision)}"
              aria-label="Редактировать тип"
              title="Редактировать тип"
            >
              ${getEditTypePencilSvg()}
            </button>
          `
          : '';
        return `
          <div class="property-row">
            <label class="property-label">${escapeHtml(k)}</label>
            ${editorControl}
            ${editTypeButton}
          </div>
        `;
      }).join('')
    : '<div class="empty-state"><p>Нет доступных свойств для отображения.</p></div>';
  const tag = selection.tag || '';
  const catalogEvents: readonly string[] = tag === 'Form'
    ? FORM_LEVEL_EVENTS
    : (FORM_EVENT_CATALOG[tag] || []);
  const assignedEvents: Record<string, string> = selection.events || {};
  const extraEvents = Object.keys(assignedEvents).filter(k => !catalogEvents.includes(k));
  const allEventNames = [...catalogEvents, ...extraEvents];
  const elementId = selection.id || '';
  const elementName = selection.name || '';
  const elementTag = tag;
  const eventLines = !isMultiSelection && allEventNames.length
    ? `
      <div class="property-section">
        <div class="property-section-title">События</div>
        ${allEventNames.map(evName => {
          const v = assignedEvents[evName] || '';
          const actionButton = v
            ? `
              <button
                type="button"
                class="event-action-btn goto-event-handler-btn"
                data-proc="${escapeHtml(v)}"
                data-doc-uri="${escapeHtml(selection.docUri)}"
                title="Перейти к обработчику"
                aria-label="Перейти к обработчику"
              >&#x1F50D;</button>
            `
            : `
              <button
                type="button"
                class="event-action-btn create-event-handler-btn"
                data-event="${escapeHtml(evName)}"
                data-element-id="${escapeHtml(elementId)}"
                data-element-name="${escapeHtml(elementName)}"
                data-element-tag="${escapeHtml(elementTag)}"
                data-doc-uri="${escapeHtml(selection.docUri)}"
                title="Создать обработчик"
                aria-label="Создать обработчик"
              >&#x2795;</button>
            `;
          return `
          <div class="property-row">
            <label class="property-label">${escapeHtml(evName)}</label>
            <input
              type="text"
              class="property-input"
              data-form-scope="event"
              data-form-key="${escapeHtml(evName)}"
              data-form-value-kind="primitive"
              data-form-doc-uri="${escapeHtml(selection.docUri)}"
              data-form-entity-type="${escapeHtml(selection.entityType)}"
              data-form-entity-id="${escapeHtml(elementId)}"
              data-form-entity-name="${escapeHtml(elementName)}"
              data-form-selection-revision="${String(currentFormSelectionRevision)}"
              value="${escapeHtml(v)}"
            />
            ${actionButton}
          </div>
        `;
        }).join('')}
      </div>
    `
    : '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
      <title>Properties</title>
      <style>
        body {
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
          padding: 16px;
        }
        .header { margin-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; }
        .header h2 { margin: 0 0 6px 0; }
        .header p { margin: 0; color: var(--vscode-descriptionForeground); }
        .hint { margin: 12px 0; color: var(--vscode-descriptionForeground); }
        .property-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .property-label { min-width: 180px; font-weight: 600; }
        .property-input {
          flex: 1;
          padding: 4px 8px;
          background: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border);
        }
        .property-input-textarea {
          min-height: 72px;
          resize: vertical;
          font-family: var(--vscode-editor-font-family);
        }
        .property-input.error {
          border-color: var(--vscode-inputValidation-errorBorder);
        }
        .edit-form-type-btn {
          border: none;
          padding: 4px 8px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          cursor: pointer;
        }
        .edit-form-type-btn:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        .event-action-btn {
          border: none;
          padding: 2px 6px;
          background: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
          border-radius: 2px;
          flex-shrink: 0;
        }
        .event-action-btn:hover {
          background: var(--vscode-button-secondaryHoverBackground);
        }
        .property-section-title {
          margin: 16px 0 8px 0;
          color: var(--vscode-descriptionForeground);
          border-bottom: 1px solid var(--vscode-panel-border);
          padding-bottom: 4px;
        }
        .empty-state p {
          margin: 6px 0;
          color: var(--vscode-descriptionForeground);
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>Свойства формы: ${escapeHtml(isMultiSelection ? 'множественный выбор' : (selection.name || selection.id || 'элемент'))}</h2>
        <p>Тип: ${escapeHtml(selection.entityType)}${selection.tag ? ` (${escapeHtml(selection.tag)})` : ''}</p>
      </div>
      <p class="hint">${
        isMultiSelection
          ? 'Панель показывает mixed-state для множественного выбора. Редактирование будет доступно после полной поддержки multi-select.'
          : 'Свойства и события можно менять прямо здесь для выделенного объекта формы.'
      }</p>
      <div class="property-section">
        <div class="property-section-title">Свойства</div>
        ${lines}
      </div>
      ${eventLines}
      <script>
        const vscode = acquireVsCodeApi();
        document.querySelectorAll('.property-input[data-form-key]').forEach((input) => {
          input.addEventListener('change', () => {
            const isJson = input.dataset.formValueKind === 'json';
            let value = input.value;
            if (isJson) {
              try {
                value = JSON.parse(input.value);
                input.value = JSON.stringify(value, null, 2);
                input.classList.remove('error');
                input.title = '';
              } catch (err) {
                input.classList.add('error');
                input.title = 'Некорректный JSON: изменение не отправлено';
                return;
              }
            }
            vscode.postMessage({
              type: 'propertyChanged',
              propertyName: input.dataset.formKey,
              value,
              scope: input.dataset.formScope || 'property',
              selectionRevision: input.dataset.formSelectionRevision || '',
              docUri: input.dataset.formDocUri || '',
              entityType: input.dataset.formEntityType,
              entityId: input.dataset.formEntityId || undefined,
              entityName: input.dataset.formEntityName || undefined
            });
          });
        });
        document.querySelectorAll('.edit-form-type-btn[data-form-type-key]').forEach((btn) => {
          btn.addEventListener('click', () => {
            vscode.postMessage({
              type: 'editFormSelectionType',
              propertyName: btn.dataset.formTypeKey,
              selectionRevision: btn.dataset.formSelectionRevision || '',
              docUri: btn.dataset.formDocUri || '',
              entityType: btn.dataset.formEntityType,
              entityId: btn.dataset.formEntityId || undefined,
              entityName: btn.dataset.formEntityName || undefined
            });
          });
        });
        document.querySelectorAll('.goto-event-handler-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            vscode.postMessage({
              type: 'gotoEventHandler',
              handlerName: btn.dataset.proc || '',
              docUri: btn.dataset.docUri || ''
            });
          });
        });
        document.querySelectorAll('.create-event-handler-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            vscode.postMessage({
              type: 'createEventHandler',
              eventName: btn.dataset.event || '',
              elementId: btn.dataset.elementId || '',
              elementName: btn.dataset.elementName || '',
              elementTag: btn.dataset.elementTag || '',
              docUri: btn.dataset.docUri || ''
            });
          });
        });
      </script>
    </body>
    </html>
  `;
}
