import type { FormChildItem, FormModel } from '../../formModel';
import type { FormBrowserState, FormOutboundMessage } from '../contracts';
import { escapeWebviewText } from '../escaping';
import { extractDisplayValue, findElement, findParentAndIndex, getPasteTargetId, isContainerTag } from '../modelQueries';
import type { PreviewViewController } from './previewView';
import type { RequisiteViewController } from './requisiteView';

const THEME_MODE_KEY = 'form-editor-theme-mode';

export interface ShellPorts {
  postMessage(message: FormOutboundMessage): void;
  applyTreeSelection(): void;
  updatePropsPanel(): void;
  preview: PreviewViewController;
  requisite: RequisiteViewController;
}

export interface ShellController {
  initialize(): void;
  updateToolbarState(): void;
  fillAddWizardTypeOptions(): void;
  renderCommandInterface(model: FormModel): void;
  getPreviewEmptyStateHtml(): string;
  collectContainerIds(items: FormChildItem[], expandedIds: Set<string>): void;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) { throw new Error(`Missing form editor element: ${id}`); }
  return element as T;
}

export function createShell(state: FormBrowserState, ports: ShellPorts): ShellController {
  function applyThemeMode(mode: string | null): void {
    const value = mode || 'auto';
    document.body.setAttribute('data-theme-mode', value);
    const select = document.getElementById('tb-theme-mode') as HTMLSelectElement | null;
    if (select && select.value !== value) { select.value = value; }
  }

  function initializeThemeMode(): void {
    const saved = localStorage.getItem(THEME_MODE_KEY) || 'auto';
    applyThemeMode(saved);
    const select = document.getElementById('tb-theme-mode') as HTMLSelectElement | null;
    if (select) {
      select.addEventListener('change', () => {
        const mode = select.value || 'auto';
        localStorage.setItem(THEME_MODE_KEY, mode);
        applyThemeMode(mode);
      });
    }
  }

  function setupSplitters(): void {
    const root = document.body;
    const vertical = document.getElementById('splitter-v');
    const horizontal = document.getElementById('splitter-h');
    const px = (value: number): string => `${value}px`;
    const parsePx = (value: string): number => value ? Number.parseInt(value, 10) || 0 : 0;
    if (vertical) {
      vertical.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = parsePx(getComputedStyle(root).getPropertyValue('--tree-width')) || 280;
        const move = (moveEvent: MouseEvent): void => {
          const deltaX = moveEvent.clientX - startX;
          const minCenterWidth = window.innerWidth <= 1000 ? 260 : 360;
          const minInspectorWidth = window.innerWidth <= 1000 ? 220 : 240;
          const maxWidth = Math.max(120, window.innerWidth - 6 - minCenterWidth - minInspectorWidth);
          const newWidth = Math.max(120, Math.min(maxWidth, startWidth + deltaX));
          root.style.setProperty('--tree-width', px(newWidth));
        };
        const up = (): void => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }
    if (horizontal) {
      horizontal.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = parsePx(getComputedStyle(root).getPropertyValue('--preview-height')) || 300;
        const move = (moveEvent: MouseEvent): void => {
          const deltaY = startY - moveEvent.clientY;
          const newHeight = Math.max(60, Math.min(window.innerHeight - 100, startHeight + deltaY));
          root.style.setProperty('--preview-height', px(newHeight));
        };
        const up = (): void => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }
  }

  function updateToolbarState(): void {
    const addButton = document.getElementById('tb-add') as HTMLButtonElement | null;
    const addWizardButton = document.getElementById('tb-add-wizard') as HTMLButtonElement | null;
    const deleteButton = document.getElementById('tb-delete') as HTMLButtonElement | null;
    const upButton = document.getElementById('tb-up') as HTMLButtonElement | null;
    const downButton = document.getElementById('tb-down') as HTMLButtonElement | null;
    const copyButton = document.getElementById('tb-copy') as HTMLButtonElement | null;
    const pasteButton = document.getElementById('tb-paste') as HTMLButtonElement | null;
    const saveButton = document.getElementById('tb-save') as HTMLButtonElement | null;
    const cancelButton = document.getElementById('tb-cancel') as HTMLButtonElement | null;
    if (!addButton) { return; }
    const model = state.formModel;
    const hasModel = Boolean(model && model.childItemsRoot);
    const singleId = state.selectedIds.length === 1 ? state.selectedIds[0] : null;
    const selectedItem = hasModel && singleId ? findElement(model, singleId) : null;
    const selectedIsContainer = selectedItem && isContainerTag(selectedItem.tag);
    const location = hasModel && singleId && model ? findParentAndIndex(model.childItemsRoot, singleId) : null;
    const isFirst = location ? location.index <= 0 : true;
    const isLast = location ? location.index >= location.parent.length - 1 : true;
    const hasSelection = state.selectedIds.length > 0;
    const pasteTarget = getPasteTargetId(state, findElement);
    addButton.disabled = !hasModel || Boolean(singleId && !selectedIsContainer);
    if (addWizardButton) { addWizardButton.disabled = addButton.disabled; }
    if (deleteButton) { deleteButton.disabled = !hasModel || !hasSelection; }
    if (upButton) { upButton.disabled = !hasModel || !singleId || isFirst || state.selectedIds.length > 1; }
    if (downButton) { downButton.disabled = !hasModel || !singleId || isLast || state.selectedIds.length > 1; }
    if (copyButton) { copyButton.disabled = !hasModel || !hasSelection; }
    if (pasteButton) { pasteButton.disabled = !hasModel || !state.clipboardBuffer || !pasteTarget; }
    if (saveButton) { saveButton.disabled = !hasModel; }
    if (cancelButton) { cancelButton.disabled = false; }
  }

  function getAddElementWizardOptions(): Array<{ tag: string; defaultName: string; hint: string }> {
    const options = state.addElementWizardConfig && Array.isArray(state.addElementWizardConfig.options)
      ? state.addElementWizardConfig.options
      : [];
    return options
      .filter((option) => option && typeof option.tag === 'string' && option.tag.trim() !== '')
      .map((option) => ({
        tag: String(option.tag).trim(),
        defaultName: typeof option.defaultName === 'string' ? option.defaultName : 'NewItem',
        hint: typeof option.hint === 'string' ? option.hint : '',
      }));
  }

  function refreshAddWizardHint(): void {
    const select = document.getElementById('add-wizard-type') as HTMLSelectElement | null;
    const hint = document.getElementById('add-wizard-hint');
    const nameInput = document.getElementById('add-wizard-name') as HTMLInputElement | null;
    if (!select || !hint || !nameInput) { return; }
    const options = getAddElementWizardOptions();
    const selectedTag = select.value || '';
    const selectedOption = options.find((option) => option.tag === selectedTag) || null;
    hint.textContent = selectedOption && selectedOption.hint
      ? selectedOption.hint
      : 'Для выбранного типа нет дополнительной подсказки.';
    if (!nameInput.value.trim()) { nameInput.value = selectedOption ? selectedOption.defaultName : 'NewItem'; }
  }

  function fillAddWizardTypeOptions(): void {
    const select = document.getElementById('add-wizard-type') as HTMLSelectElement | null;
    if (!select) { return; }
    const options = getAddElementWizardOptions();
    const previousTag = select.value;
    select.innerHTML = '';
    options.forEach((option) => {
      const element = document.createElement('option');
      element.value = option.tag;
      element.textContent = option.tag;
      select.appendChild(element);
    });
    if (previousTag && options.some((option) => option.tag === previousTag)) { select.value = previousTag; }
    else if (options.length) { select.value = options[0].tag; }
    refreshAddWizardHint();
  }

  function getAddWizardTargetId(): string | null {
    let parentId = getPasteTargetId(state, findElement);
    if (!parentId && state.selectedIds.length === 1) {
      const selected = findElement(state.formModel, state.selectedIds[0]);
      if (selected && isContainerTag(selected.tag)) { parentId = state.selectedIds[0]; }
    }
    return parentId;
  }

  function openAddWizard(): void {
    if (!state.formModel) { return; }
    const overlay = document.getElementById('add-wizard-overlay');
    const nameInput = document.getElementById('add-wizard-name') as HTMLInputElement | null;
    const targetInfo = document.getElementById('add-wizard-target');
    const typeSelect = document.getElementById('add-wizard-type') as HTMLSelectElement | null;
    if (!overlay || !nameInput || !targetInfo || !typeSelect) { return; }
    fillAddWizardTypeOptions();
    const options = getAddElementWizardOptions();
    const selectedOption = options.find((option) => option.tag === typeSelect.value) || options[0] || null;
    nameInput.value = selectedOption ? selectedOption.defaultName : 'NewItem';
    const targetId = getAddWizardTargetId();
    targetInfo.textContent = targetId ? `Родитель: ${targetId}` : 'Родитель: корень формы';
    overlay.style.display = 'flex';
    nameInput.focus();
    nameInput.select();
  }

  function closeAddWizard(): void {
    const overlay = document.getElementById('add-wizard-overlay');
    if (overlay) { overlay.style.display = 'none'; }
  }

  function submitAddWizard(): void {
    if (!state.formModel) { return; }
    const select = document.getElementById('add-wizard-type') as HTMLSelectElement | null;
    const nameInput = document.getElementById('add-wizard-name') as HTMLInputElement | null;
    if (!select || !nameInput) { return; }
    const options = getAddElementWizardOptions();
    const selectedTag = select.value;
    if (!options.some((option) => option.tag === selectedTag)) { return; }
    const parentId = getAddWizardTargetId();
    const rawName = nameInput.value ? nameInput.value.trim() : '';
    ports.postMessage({ type: 'addElementWizard', parentId: parentId || undefined, tag: selectedTag, name: rawName });
    closeAddWizard();
  }

  function renderCommandInterface(model: FormModel): void {
    const container = document.getElementById('command-interface-content');
    if (!container) { return; }
    let html = '';
    html += '<div class="command-interface-section"><p class="command-interface-section-title">Команды формы</p>';
    if (model.commands && model.commands.length) {
      html += '<ul class="command-interface-list">';
      model.commands.forEach((command) => {
        const title = extractDisplayValue(command.properties['Title']);
        const label = (command.name || '') + (title ? ` — ${title}` : '');
        html += `<li>${escapeWebviewText(label || command.name || '')}</li>`;
      });
      html += '</ul>';
    } else {
      html += '<p class="command-interface-empty">Нет команд формы</p>';
    }
    html += '</div>';
    html += '<div class="command-interface-section"><p class="command-interface-section-title">Командная панель</p>';
    const barName = model.autoCommandBarName || model.autoCommandBarId;
    if (!barName) {
      html += '<p class="command-interface-empty">Командная панель не задана</p>';
    } else {
      html += `<p class="command-interface-summary">Командная панель: ${escapeWebviewText(barName)}</p>`;
      const barNode = findElement(model, barName);
      if (!barNode) {
        html += '<p class="command-interface-empty">Узел командной панели не найден</p>';
      } else if (barNode.childItems.length) {
        html += '<ul class="command-interface-list">';
        barNode.childItems.forEach((child) => {
          const commandName = child.properties['CommandName'] != null
            ? extractDisplayValue(child.properties['CommandName'])
            : '';
          const label = commandName && commandName.trim() ? commandName : child.name || child.tag || '';
          html += `<li>${escapeWebviewText(label)}</li>`;
        });
        html += '</ul>';
      } else {
        html += '<p class="command-interface-empty">Панель пуста</p>';
      }
    }
    html += '</div>';
    container.innerHTML = html;
  }

  function collectContainerIds(items: FormChildItem[], expandedIds: Set<string>): void {
    for (const item of items) {
      const id = item.id || item.name;
      if (id && isContainerTag(item.tag) && item.childItems.length) {
        expandedIds.add(id);
        collectContainerIds(item.childItems, expandedIds);
      }
    }
  }

  function bindToolbarAndTabs(): void {
    requiredElement<HTMLButtonElement>('btn-cancel').addEventListener('click', () => ports.postMessage({ type: 'cancel' }));
    requiredElement<HTMLButtonElement>('btn-save').addEventListener('click', () => {
      requiredElement('save-status').textContent = 'Сохранение...';
      ports.postMessage({ type: 'save', formModel: state.formModel });
    });
    requiredElement<HTMLButtonElement>('tb-cancel').addEventListener('click', () => ports.postMessage({ type: 'cancel' }));
    requiredElement<HTMLButtonElement>('tb-save').addEventListener('click', () => {
      requiredElement('save-status').textContent = 'Сохранение...';
      ports.postMessage({ type: 'save', formModel: state.formModel });
    });
    requiredElement<HTMLButtonElement>('tb-add').addEventListener('click', () => {
      if (!state.formModel) { return; }
      let parentId = getPasteTargetId(state, findElement);
      if (!parentId && state.selectedIds.length === 1) {
        const selected = findElement(state.formModel, state.selectedIds[0]);
        if (selected && isContainerTag(selected.tag)) { parentId = state.selectedIds[0]; }
      }
      ports.postMessage({ type: 'addElement', parentId: parentId || undefined, tag: 'InputField', name: 'NewItem' });
    });
    requiredElement<HTMLButtonElement>('tb-add-wizard').addEventListener('click', openAddWizard);
    requiredElement<HTMLButtonElement>('add-wizard-cancel').addEventListener('click', closeAddWizard);
    requiredElement<HTMLButtonElement>('add-wizard-submit').addEventListener('click', submitAddWizard);
    requiredElement<HTMLSelectElement>('add-wizard-type').addEventListener('change', refreshAddWizardHint);
    requiredElement<HTMLInputElement>('add-wizard-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); submitAddWizard(); }
      else if (event.key === 'Escape') { event.preventDefault(); closeAddWizard(); }
    });
    requiredElement('add-wizard-overlay').addEventListener('click', function(event) {
      if (event.target === this) { closeAddWizard(); }
    });
    requiredElement<HTMLButtonElement>('tb-delete').addEventListener('click', () => {
      if (!state.selectedIds.length) { return; }
      if (state.selectedIds.length === 1) { ports.postMessage({ type: 'deleteElement', elementId: state.selectedIds[0] }); }
      else { ports.postMessage({ type: 'deleteElement', elementIds: state.selectedIds.slice() }); }
    });
    requiredElement<HTMLButtonElement>('tb-up').addEventListener('click', () => {
      if (state.selectedIds.length === 1) { ports.postMessage({ type: 'moveElementSibling', elementId: state.selectedIds[0], direction: 'up' }); }
    });
    requiredElement<HTMLButtonElement>('tb-down').addEventListener('click', () => {
      if (state.selectedIds.length === 1) { ports.postMessage({ type: 'moveElementSibling', elementId: state.selectedIds[0], direction: 'down' }); }
    });
    requiredElement<HTMLButtonElement>('tb-copy').addEventListener('click', () => {
      if (!state.selectedIds.length || !state.formModel) { return; }
      const items = state.selectedIds.map((id) => findElement(state.formModel, id)).filter((item): item is FormChildItem => Boolean(item));
      if (items.length === 1) { state.clipboardBuffer = cloneItem(items[0]); }
      else if (items.length > 1) { state.clipboardBuffer = items.map(cloneItem); }
      if (items.length) { updateToolbarState(); }
    });
    requiredElement<HTMLButtonElement>('tb-paste').addEventListener('click', () => {
      const targetId = getPasteTargetId(state, findElement);
      if (!state.clipboardBuffer || !targetId) { return; }
      ports.postMessage({ type: 'pasteElement', targetId, index: 0, clipboard: state.clipboardBuffer });
    });
    updateToolbarState();

    document.querySelectorAll<HTMLElement>('[data-left-tab]').forEach((button) => {
      button.addEventListener('click', function() {
        const tab = (this as HTMLElement).dataset.leftTab;
        document.querySelectorAll<HTMLElement>('[data-left-tab]').forEach((item) => {
          item.classList.toggle('active', item.dataset.leftTab === tab);
          item.setAttribute('aria-selected', item.dataset.leftTab === tab ? 'true' : 'false');
        });
        requiredElement('left-tab-elements').style.display = tab === 'elements' ? 'block' : 'none';
        requiredElement('left-command-interface').style.display = tab === 'command-interface' ? 'block' : 'none';
      });
    });
    document.querySelector('[data-left-tab="elements"]')?.classList.add('active');
    document.querySelectorAll<HTMLElement>('[data-right-tab]').forEach((button) => {
      button.addEventListener('click', function() {
        const tab = (this as HTMLElement).dataset.rightTab;
        document.querySelectorAll<HTMLElement>('[data-right-tab]').forEach((item) => {
          item.classList.toggle('active', item.dataset.rightTab === tab);
          item.setAttribute('aria-selected', item.dataset.rightTab === tab ? 'true' : 'false');
        });
        requiredElement('right-tab-attributes').style.display = tab === 'attributes' ? 'flex' : 'none';
        requiredElement('right-tab-commands').style.display = tab === 'commands' ? 'flex' : 'none';
        requiredElement('right-tab-parameters').style.display = tab === 'parameters' ? 'flex' : 'none';
      });
    });
    document.querySelector('[data-right-tab="attributes"]')?.classList.add('active');

    requiredElement<HTMLButtonElement>('btn-add-attribute').addEventListener('click', () => ports.postMessage({ type: 'addAttribute' }));
    requiredElement<HTMLButtonElement>('btn-delete-attribute').addEventListener('click', () => {
      if (!state.selectedAttributeId) { return; }
      ports.postMessage({ type: 'deleteAttribute', attributeId: state.selectedAttributeId, attributeName: state.selectedAttributeId });
    });
    requiredElement<HTMLButtonElement>('btn-add-command').addEventListener('click', () => ports.postMessage({ type: 'addCommand' }));
    requiredElement<HTMLButtonElement>('btn-delete-command').addEventListener('click', () => {
      if (!state.selectedCommandId) { return; }
      ports.postMessage({ type: 'deleteCommand', commandId: state.selectedCommandId, commandName: state.selectedCommandId });
    });
    requiredElement<HTMLButtonElement>('tb-module').addEventListener('click', () => ports.postMessage({ type: 'openModule' }));
  }

  function initialize(): void {
    initializeThemeMode();
    const fitButton = document.getElementById('tb-preview-fit');
    if (fitButton) { fitButton.addEventListener('click', ports.preview.fitPreviewToWidth); }
    window.addEventListener('resize', ports.preview.updatePreviewFitScale);
    setupSplitters();
    bindToolbarAndTabs();
  }

  return {
    initialize,
    updateToolbarState,
    fillAddWizardTypeOptions,
    renderCommandInterface,
    getPreviewEmptyStateHtml: () => '<div class="preview-empty-state"><p class="preview-empty-title">Форма не содержит элементов</p><p class="preview-empty-hint">Добавьте элементы в дереве или перетащите реквизиты в превью.</p></div>',
    collectContainerIds,
  };
}

function cloneItem(item: FormChildItem): FormChildItem {
  return JSON.parse(JSON.stringify(item)) as FormChildItem;
}
