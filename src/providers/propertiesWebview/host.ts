import { MetadataType, TreeNode } from '../../models/treeNode';
import type { FormSelectionPayload } from '../../formEditor/formMessageHandler';
import { FORM_EVENT_CATALOG, FORM_LEVEL_EVENTS } from '../../formEditor/formEventCatalog';
import { MESSAGES } from '../../constants/messages';
import { isContainerNode } from '../../utils/treeNormalization';
import { Logger } from '../../utils/logger';
import { buildWebviewCsp, createNonce } from '../../utils/webviewSecurity';
import {
  PROPERTIES_CSS,
  EMPTY_STATE_CSS,
  ERROR_PANEL_CSS,
  FORM_SELECTION_CSS,
  PROPERTIES_BROWSER_SCRIPT,
  FORM_SELECTION_BROWSER_SCRIPT,
} from './generatedAssets';
import { renderPicturePreviewCard, renderPropertiesBySections, renderStyleItemPreview, escapeHtml, getEditTypePencilSvg } from './renderers';
import type { WebviewContentOptions } from './contracts';

function serializeBootstrapData(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function getWebviewScript(readOnly: boolean, node?: TreeNode, sessionToken?: string): string {
  void node;
  void sessionToken;
  return readOnly ? '// Read-only mode - no interaction needed' : PROPERTIES_BROWSER_SCRIPT;
}

export function getWebviewContent(
  node: TreeNode,
  sessionTokenOrOptions?: string | WebviewContentOptions,
  optionsArg?: WebviewContentOptions
): string {
  const sessionToken = typeof sessionTokenOrOptions === 'string'
    ? sessionTokenOrOptions
    : sessionTokenOrOptions?.sessionToken;
  const options = typeof sessionTokenOrOptions === 'object' && sessionTokenOrOptions !== null
    ? sessionTokenOrOptions
    : optionsArg;
  // Handle empty state when no node is selected
  if (!node) {
    return getEmptyStateContent();
  }

  const isContainer = isContainerNode(node);
  const properties = isContainer ? {} : (node.properties || {});
  const hasProperties = Object.keys(properties).length > 0;

  // Switch to read-only mode when file path is missing or for container nodes
  // For nested elements (Attributes), check parentFilePath; for root elements, check filePath
  const readOnly = isContainer || !(node.parentFilePath || node.filePath);

  Logger.debug(`getWebviewContent: node.name="${node.name}", node.type="${node.type}", readOnly=${readOnly}`);

  const nonce = createNonce();
  const csp = buildWebviewCsp({
    nonce,
    allowUnsafeInlineStyles: true,
    imgSources: ['data:'],
  });

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <title>Properties</title>
      <style>${PROPERTIES_CSS}</style>
    </head>
    <body>
      <div class="header">
        <h2>Свойства: ${escapeHtml(node.name)} (${escapeHtml(node.type)})<span id="dirty-indicator" class="dirty-indicator" style="display: none;">*</span></h2>
        ${!readOnly && hasProperties ? `
          <span class="header-actions">
            <button id="cancel-btn" title="Отмена" aria-label="Отмена">Отмена</button>
            <button id="save-btn" disabled title="Сохранить" aria-label="Сохранить">Сохранить</button>
          </span>
        ` : ''}
      </div>
      ${options?.picture ? renderPicturePreviewCard(options.picture) : ''}
      ${node.type === MetadataType.StyleItem ? renderStyleItemPreview(node) : ''}
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
            <button id="bottom-cancel-btn" title="Отмена" aria-label="Отмена">Отмена</button>
            <button id="bottom-save-btn" disabled title="Сохранить" aria-label="Сохранить">Сохранить</button>
          </div>
        ` : ''}
      ` : `
        <div class="empty-state">
          <h3>${escapeHtml(MESSAGES.EMPTY_STATE_NO_PROPERTIES_TITLE)}</h3>
          <p>${escapeHtml(MESSAGES.EMPTY_STATE_NO_PROPERTIES_HINT)}</p>
        </div>
      `}
      <script type="application/json" id="properties-bootstrap" nonce="${nonce}">${serializeBootstrapData({ nodeId: node.id, sessionToken: sessionToken || node.id })}</script>
      <script nonce="${nonce}">${getWebviewScript(readOnly, node, sessionToken)}</script>
    </body>
    </html>
  `;
}

/**
 * Generate empty state HTML when no element is selected
 */

export function getEmptyStateContent(): string {
  const csp = buildWebviewCsp({ allowUnsafeInlineStyles: true });
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <title>Properties</title>
      <style>${EMPTY_STATE_CSS}</style>
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
  const csp = buildWebviewCsp({ allowUnsafeInlineStyles: true });
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <title>Properties - Error</title>
      <style>${ERROR_PANEL_CSS}</style>
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

  const nonce = createNonce();
  const csp = buildWebviewCsp({
    nonce,
    allowUnsafeInlineStyles: true,
  });

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <title>Properties</title>
      <style>${FORM_SELECTION_CSS}</style>
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
      <script nonce="${nonce}">${FORM_SELECTION_BROWSER_SCRIPT}</script>
    </body>
    </html>
  `;
}
