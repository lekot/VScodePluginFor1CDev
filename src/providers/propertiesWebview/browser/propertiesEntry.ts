import type {
  PropertiesBootstrapData,
  PropertiesInboundMessage,
  PropertiesOutboundMessage,
  WebviewBrowserApi,
} from '../browserContracts';

declare function acquireVsCodeApi(): WebviewBrowserApi<PropertiesOutboundMessage>;

interface PropertyState {
  originalProperties: Record<string, unknown>;
  currentProperties: Record<string, unknown>;
  changedProperties: Set<string>;
  validationErrors: Record<string, string>;
  nodeId: string;
  sessionToken: string;
}

type PropertyInput = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const api = acquireVsCodeApi();
const bootstrapElement = document.getElementById('properties-bootstrap');
const bootstrap = JSON.parse(bootstrapElement?.textContent || '{}') as PropertiesBootstrapData;
const state: PropertyState = {
  originalProperties: {},
  currentProperties: {},
  changedProperties: new Set<string>(),
  validationErrors: {},
  nodeId: bootstrap.nodeId,
  sessionToken: bootstrap.sessionToken,
};

let previousIsDirty = false;

function propertyInputs(): PropertyInput[] {
  return Array.from(document.querySelectorAll<PropertyInput>('.property-input'));
}

function inputValue(input: PropertyInput): unknown {
  if (input instanceof HTMLInputElement && input.type === 'checkbox') {
    return input.checked;
  }
  if (input instanceof HTMLInputElement && input.type === 'number') {
    return Number.parseFloat(input.value) || 0;
  }
  return input.value;
}

function initializeState(): void {
  for (const input of propertyInputs()) {
    if (input.disabled) {
      continue;
    }
    const name = input.dataset.property;
    if (!name) {
      continue;
    }
    const value = inputValue(input);
    state.originalProperties[name] = value;
    state.currentProperties[name] = value;
  }
}

function updateUI(): void {
  const isDirty = state.changedProperties.size > 0;
  const hasErrors = Object.keys(state.validationErrors).length > 0;
  const canSave = isDirty && !hasErrors;
  const saveButton = document.getElementById('save-btn');
  if (saveButton instanceof HTMLButtonElement) {
    saveButton.disabled = !canSave;
  }
  const bottomSaveButton = document.getElementById('bottom-save-btn');
  if (bottomSaveButton instanceof HTMLButtonElement) {
    bottomSaveButton.disabled = !canSave;
  }
  const dirtyIndicator = document.getElementById('dirty-indicator');
  if (dirtyIndicator) {
    dirtyIndicator.textContent = isDirty ? '*' : '';
    dirtyIndicator.style.display = isDirty ? 'inline' : 'none';
  }
  const dirtyStateChanged = isDirty !== previousIsDirty;
  if (dirtyStateChanged || isDirty) {
    previousIsDirty = isDirty;
    api.postMessage({
      type: 'dirtyChange',
      isDirty,
      properties: state.currentProperties,
      nodeId: state.nodeId,
      sessionToken: state.sessionToken,
    });
  }
}

function handlePropertyChange(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) {
    return;
  }
  if (input.disabled) {
    return;
  }
  const name = input.dataset.property;
  if (!name) {
    return;
  }
  const value = inputValue(input);
  state.currentProperties[name] = value;
  if (JSON.stringify(value) !== JSON.stringify(state.originalProperties[name])) {
    state.changedProperties.add(name);
    input.classList.add('changed');
  } else {
    state.changedProperties.delete(name);
    input.classList.remove('changed');
  }
  updateUI();
}

function handleSave(): void {
  api.postMessage({
    type: 'save',
    properties: state.currentProperties,
    nodeId: state.nodeId,
    sessionToken: state.sessionToken,
  });
}

function handleCancel(): void {
  api.postMessage({ type: 'cancel', nodeId: state.nodeId, sessionToken: state.sessionToken });
}

function handleEditType(event: Event): void {
  const button = event.currentTarget;
  if (!(button instanceof HTMLElement) || !button.dataset.property) {
    return;
  }
  api.postMessage({
    type: 'editType',
    propertyName: button.dataset.property,
    nodeId: state.nodeId,
    sessionToken: state.sessionToken,
  });
}

function handleExtensionMessage(message: PropertiesInboundMessage): void {
  switch (message.type) {
    case 'update':
      location.reload();
      break;
    case 'saved':
      state.originalProperties = { ...state.currentProperties };
      state.changedProperties.clear();
      state.validationErrors = {};
      for (const input of propertyInputs()) {
        input.classList.remove('changed', 'error');
      }
      updateUI();
      break;
    case 'error':
      alert('Error: ' + message.message);
      break;
    case 'validationError':
      state.validationErrors = message.errors || {};
      for (const input of propertyInputs()) {
        const name = input.dataset.property;
        if (!name) {
          continue;
        }
        const error = state.validationErrors[name];
        if (error) {
          input.classList.add('error');
          const next = input.parentElement?.nextElementSibling;
          if (!next || !next.classList.contains('error-message')) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error-message';
            errorDiv.textContent = error;
            input.parentElement?.insertAdjacentElement('afterend', errorDiv);
          }
        } else {
          input.classList.remove('error');
          const next = input.parentElement?.nextElementSibling;
          if (next?.classList.contains('error-message')) {
            next.remove();
          }
        }
      }
      updateUI();
      break;
    case 'typeUpdated':
      if (message.sessionToken && state.sessionToken && message.sessionToken !== state.sessionToken) {
        console.log('Ignored stale typeUpdated for session', message.sessionToken);
        break;
      }
      if (message.nodeId && state.nodeId && message.nodeId !== state.nodeId) {
        console.log('Ignored stale typeUpdated for node', message.nodeId);
        break;
      }
      updatePropertyFromMessage(message.property, message.value, false);
      break;
    case 'sourceUpdated':
      if (message.sessionToken && state.sessionToken && message.sessionToken !== state.sessionToken) {
        console.log('Ignored stale sourceUpdated for session', message.sessionToken);
        break;
      }
      if (message.nodeId && state.nodeId && message.nodeId !== state.nodeId) {
        console.log('Ignored stale sourceUpdated for node', message.nodeId);
        break;
      }
      updatePropertyFromMessage(message.property, message.value, true);
      break;
  }
}

function updatePropertyFromMessage(property: string, value: string, source: boolean): void {
  const escaped = property.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const input = document.querySelector<PropertyInput>(`.property-input[data-property="${escaped}"]`);

  if (source) {
    state.currentProperties[property] = value;
    state.changedProperties.add(property);
    if (input) {
      const matches = (value.match(/<v8:Type>/g) || []).length;
      input.value = matches > 0 ? '[' + matches + ' типов]' : '[пусто]';
      input.classList.add('changed');
    }
    updateUI();
    return;
  }

  if (!input) {
    return;
  }

  input.value = value;
  state.currentProperties[property] = value;
  if (JSON.stringify(value) !== JSON.stringify(state.originalProperties[property])) {
    state.changedProperties.add(property);
    input.classList.add('changed');
  }
  updateUI();
}

for (const input of propertyInputs()) {
  input.addEventListener('change', handlePropertyChange);
  input.addEventListener('input', handlePropertyChange);
}
for (const button of document.querySelectorAll<HTMLElement>('.edit-type-btn')) {
  button.addEventListener('click', handleEditType);
}
for (const button of document.querySelectorAll<HTMLElement>('.edit-source-btn')) {
  button.addEventListener('click', () => {
    api.postMessage({
      type: 'editSource',
      propertyName: button.dataset.property || 'Source',
      nodeId: state.nodeId,
      sessionToken: state.sessionToken,
    });
  });
}
for (const button of document.querySelectorAll<HTMLElement>('.edit-content-btn')) {
  button.addEventListener('click', () => api.postMessage({ type: 'editContent', nodeType: button.dataset.nodeType }));
}
for (const button of document.querySelectorAll<HTMLElement>('.rename-element-btn')) {
  button.addEventListener('click', () => {
    api.postMessage({ type: 'renameElement', nodeId: state.nodeId, sessionToken: state.sessionToken });
  });
}
for (const button of document.querySelectorAll<HTMLElement>('.goto-handler-btn')) {
  button.addEventListener('click', () => {
    const handler = button.dataset.handler || '';
    if (handler) {
      api.postMessage({ type: 'gotoHandler', handler });
    }
  });
}
for (const button of document.querySelectorAll<HTMLElement>('.open-pic-btn')) {
  button.addEventListener('click', () => {
    const filePath = button.dataset.filePath || button.getAttribute('data-file-path');
    if (filePath) {
      api.postMessage({ type: 'openPictureFile', filePath });
    }
  });
}
for (const id of ['save-btn', 'bottom-save-btn']) {
  document.getElementById(id)?.addEventListener('click', handleSave);
}
for (const id of ['cancel-btn', 'bottom-cancel-btn']) {
  document.getElementById(id)?.addEventListener('click', handleCancel);
}
window.addEventListener('keydown', (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
    event.preventDefault();
    if (state.changedProperties.size > 0 && Object.keys(state.validationErrors).length === 0) {
      handleSave();
    }
  }
});
window.addEventListener('message', (event: MessageEvent<PropertiesInboundMessage>) => {
  handleExtensionMessage(event.data);
});

initializeState();
