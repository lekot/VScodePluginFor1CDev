import type { FormBrowserState, FormInboundMessage, FormOutboundMessage } from '../contracts';
import { buildRequisiteTree, collectCommandsFromTree, findElement, getDisplayItems, isFormModel, normalizeWizardConfig } from '../modelQueries';
import { createFormBrowserState } from '../state';
import { createPreviewView } from './previewView';
import { createPropertyInspector } from './propertyInspector';
import { createRequisiteView } from './requisiteView';
import { createShell } from './shell';
import { createTreeView } from './treeView';

interface VsCodeWebviewApi {
  postMessage(message: FormOutboundMessage): void;
}

declare function acquireVsCodeApi(): VsCodeWebviewApi;

function parseInboundMessage(value: unknown): FormInboundMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) { return null; }
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'hostColorTheme':
      return { type: 'hostColorTheme', kind: message.kind };
    case 'formData':
      return {
        type: 'formData',
        formModel: message.formModel,
        formXmlPath: message.formXmlPath,
        modulePath: message.modulePath,
        addElementWizardConfig: message.addElementWizardConfig,
        fileMissing: message.fileMissing,
        fileMissingTitle: message.fileMissingTitle,
        fileMissingHint: message.fileMissingHint,
      };
    case 'error':
      return { type: 'error', message: message.message };
    case 'saved':
      return { type: 'saved' };
    case 'procedures':
      return { type: 'procedures', procedures: message.procedures };
    default:
      return null;
  }
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function initializeFormBrowser(): void {
  const state: FormBrowserState = createFormBrowserState();
  const api = acquireVsCodeApi();
  const postMessage = (message: FormOutboundMessage): void => { api.postMessage(message); };

  let updateToolbarState = (): void => undefined;
  let updatePropsPanel = (): void => undefined;
  const tree = createTreeView(state, {
    postMessage,
    updateToolbarState: () => updateToolbarState(),
    updatePropsPanel: () => updatePropsPanel(),
  });
  const propertyInspector = createPropertyInspector(state, { postMessage });
  const requisite = createRequisiteView(state, {
    postMessage,
    applyTreeSelection: () => tree.applyTreeSelection(),
    updateToolbarState: () => updateToolbarState(),
    updatePropsPanel: () => updatePropsPanel(),
  });
  const preview = createPreviewView(state, {
    postMessage,
    applyTreeSelection: () => tree.applyTreeSelection(),
    updateToolbarState: () => updateToolbarState(),
    updatePropsPanel: () => updatePropsPanel(),
  });
  const shell = createShell(state, {
    postMessage,
    applyTreeSelection: () => tree.applyTreeSelection(),
    updatePropsPanel: () => updatePropsPanel(),
    preview,
    requisite,
  });
  updateToolbarState = shell.updateToolbarState;
  updatePropsPanel = propertyInspector.updatePropsPanel;

  shell.initialize();

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.origin !== window.location.origin) { return; }
    const message = parseInboundMessage(event.data);
    if (!message) { return; }
    if (message.type === 'hostColorTheme') {
      if (typeof message.kind === 'number') {
        const isLight = message.kind === 1 || message.kind === 4;
        document.documentElement.setAttribute('data-vscode-theme', isLight ? 'light' : 'dark');
      }
      return;
    }
    if (message.type === 'formData') {
      state.formModel = isFormModel(message.formModel) ? message.formModel : null;
      if (message.addElementWizardConfig && typeof message.addElementWizardConfig === 'object') {
        state.addElementWizardConfig = normalizeWizardConfig(message.addElementWizardConfig);
        fillWizardOptions();
      }
      closeWizard();
      state.formXmlPath = stringValue(message.formXmlPath);
      state.modulePath = stringValue(message.modulePath);
      const model = state.formModel;
      if (model) {
        state.selectedIds = state.selectedIds.filter((id) => Boolean(findElement(model, id)));
        if (state.anchorId && !findElement(model, state.anchorId)) {
          state.anchorId = state.selectedIds.length ? state.selectedIds[state.selectedIds.length - 1] : null;
        }
      }
      shell.updateToolbarState();
      const treeRoot = getElement('tree-root');
      const treeError = getElement('tree-error');
      treeRoot.innerHTML = '';
      treeError.style.display = 'none';
      const treeEmpty = getElement('tree-empty');
      if (message.fileMissing) {
        treeEmpty.style.display = 'block';
        getElement('tree-empty-title').textContent = stringValue(message.fileMissingTitle);
        getElement('tree-empty-hint').textContent = stringValue(message.fileMissingHint);
      } else {
        treeEmpty.style.display = 'none';
        state.expandedIds = new Set<string>();
        if (model && model.childItemsRoot) { shell.collectContainerIds(getDisplayItems(state), state.expandedIds); }
        if (model && model.childItemsRoot.length) {
          tree.renderTreeWithRoot();
          tree.applyTreeSelection();
          preview.renderPreview(getDisplayItems(state), getElement('preview-form'));
        } else {
          treeRoot.textContent = 'Нет элементов';
          const previewForm = getElement('preview-form');
          previewForm.innerHTML = shell.getPreviewEmptyStateHtml();
          previewForm.classList.remove('preview-placeholder');
        }
      }
      if (message.fileMissing) {
        const previewForm = getElement('preview-form');
        previewForm.innerHTML = '<div class="preview-empty-state"><p class="preview-empty-title">Превью недоступно</p><p class="preview-empty-hint">Файл формы не найден.</p></div>';
        previewForm.classList.remove('preview-placeholder');
      }
      getElement('props-actions').style.display = model && !message.fileMissing ? 'block' : 'none';
      if (model && !message.fileMissing) {
        shell.renderCommandInterface(model);
        const tableWrap = getElement('attributes-table-wrap');
        const treeWrap = getElement('attributes-tree-wrap');
        const requisiteTreeRoot = getElement('attributes-tree-root');
        if (model.attributes.length > 0) {
          state.selectedRequisiteFullPath = null;
          tableWrap.style.display = '';
          treeWrap.style.display = 'none';
          requisite.renderAttributesTable(model.attributes, false);
        } else {
          tableWrap.style.display = 'none';
          treeWrap.style.display = 'block';
          state.selectedRequisiteFullPath = null;
          state.requisiteExpandedPaths = new Set<string>();
          requisite.renderRequisiteTree(buildRequisiteTree(model), requisiteTreeRoot);
        }
        const commands = model.commands.length ? model.commands : collectCommandsFromTree(model);
        const firstCommand = commands[0];
        requisite.renderCommandsTable(commands, Boolean(firstCommand && 'fromTree' in firstCommand && firstCommand.fromTree));
        setDisabled('btn-edit-attribute', true);
        setDisabled('btn-delete-attribute', true);
        setDisabled('btn-delete-command', true);
        state.selectedAttributeId = null;
        state.selectedCommandId = null;
      }
      tree.applyTreeSelection();
      propertyInspector.updatePropsPanel();
    } else if (message.type === 'error') {
      const errorMessage = stringValue(message.message, 'Ошибка загрузки');
      getElement('tree-error').textContent = errorMessage;
      getElement('tree-error').style.display = 'block';
      getElement('save-status').textContent = `Ошибка: ${stringValue(message.message)}`;
    } else if (message.type === 'saved') {
      getElement('save-status').textContent = 'Сохранено';
    } else if (message.type === 'procedures') {
      const procedures = Array.isArray(message.procedures) ? message.procedures : [];
      Object.assign(window, { formProcedures: procedures });
    }
  });

  postMessage({ type: 'load' });

  function getElement<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) { throw new Error(`Missing form editor element: ${id}`); }
    return element as T;
  }

  function fillWizardOptions(): void {
    shell.fillAddWizardTypeOptions();
  }

  function closeWizard(): void {
    getElement('add-wizard-overlay').style.display = 'none';
  }
}

function setDisabled(id: string, disabled: boolean): void {
  const element = document.getElementById(id);
  if (element instanceof HTMLButtonElement) { element.disabled = disabled; }
}

initializeFormBrowser();
