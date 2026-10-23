import type { FormSelectionOutboundMessage, WebviewBrowserApi } from '../browserContracts';

declare function acquireVsCodeApi(): WebviewBrowserApi<FormSelectionOutboundMessage>;

const api = acquireVsCodeApi();

for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.property-input[data-form-key]')) {
  input.addEventListener('change', () => {
    const isJson = input.dataset.formValueKind === 'json';
    let value: unknown = input.value;
    if (isJson) {
      try {
        value = JSON.parse(input.value) as unknown;
        input.value = JSON.stringify(value, null, 2);
        input.classList.remove('error');
        input.title = '';
      } catch (_error: unknown) {
        input.classList.add('error');
        input.title = 'Некорректный JSON: изменение не отправлено';
        return;
      }
    }
    api.postMessage({
      type: 'propertyChanged',
      propertyName: input.dataset.formKey,
      value,
      scope: input.dataset.formScope || 'property',
      selectionRevision: input.dataset.formSelectionRevision || '',
      docUri: input.dataset.formDocUri || '',
      entityType: input.dataset.formEntityType,
      entityId: input.dataset.formEntityId || undefined,
      entityName: input.dataset.formEntityName || undefined,
    });
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('.edit-form-type-btn[data-form-type-key]')) {
  button.addEventListener('click', () => {
    api.postMessage({
      type: 'editFormSelectionType',
      propertyName: button.dataset.formTypeKey,
      selectionRevision: button.dataset.formSelectionRevision || '',
      docUri: button.dataset.formDocUri || '',
      entityType: button.dataset.formEntityType,
      entityId: button.dataset.formEntityId || undefined,
      entityName: button.dataset.formEntityName || undefined,
    });
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('.goto-event-handler-btn')) {
  button.addEventListener('click', () => {
    api.postMessage({
      type: 'gotoEventHandler',
      handlerName: button.dataset.proc || '',
      docUri: button.dataset.docUri || '',
    });
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('.create-event-handler-btn')) {
  button.addEventListener('click', () => {
    api.postMessage({
      type: 'createEventHandler',
      eventName: button.dataset.event || '',
      elementId: button.dataset.elementId || '',
      elementName: button.dataset.elementName || '',
      elementTag: button.dataset.elementTag || '',
      docUri: button.dataset.docUri || '',
    });
  });
}
