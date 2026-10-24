import type { FormChildItem } from '../../formModel';
import type { FormBrowserState, FormOutboundMessage } from '../contracts';
import { findElement, getDataPathValue, getDisplayItems, getFlatVisibleIds, getTreeIcon, hasDataPath, isContainerTag, isItemWithinSubtree, isRealElement } from '../modelQueries';

const FORM_ROOT_ID = '__form_root__';
const REQUISITE_DROP_TYPE = 'application/x-1c-form-requisite';

export interface TreeViewPorts {
  postMessage(message: FormOutboundMessage): void;
  updateToolbarState(): void;
  updatePropsPanel(): void;
}

export interface TreeViewController {
  renderTreeWithRoot(): void;
  applyTreeSelection(): void;
}

interface TreeNodeElement extends HTMLDivElement {
  _formItem?: FormChildItem;
}

function commandSearchIcon(): string {
  return '<svg class="fe-command-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM10.3 10.3l3.2 3.2"/></svg>';
}

export function createTreeView(state: FormBrowserState, ports: TreeViewPorts): TreeViewController {
  function applyTreeSelection(): void {
    document.querySelectorAll<HTMLElement>('.tree-node').forEach((node) => {
      const id = node.dataset.id;
      const selected = state.selectedIds.indexOf(id || '') >= 0;
      node.classList.toggle('selected', Boolean(selected));
      node.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    const count = document.getElementById('tree-selection-count');
    if (count) {
      if (state.selectedIds.length > 1) {
        count.textContent = `Выбрано элементов: ${state.selectedIds.length}`;
        count.style.display = 'block';
      } else {
        count.textContent = '';
        count.style.display = 'none';
      }
    }
  }

  function renderTree(items: FormChildItem[], parentElement: HTMLElement, parentItem: FormChildItem | null): void {
    if (!items.length) { return; }
    const list = parentItem?.tag === 'Table' ? items.filter(isRealElement) : items;
    if (!list.length) { return; }
    const children = document.createElement('div');
    children.className = `tree-children${parentItem?.tag === 'Table' ? ' tree-table-columns' : ''}`;
    list.forEach((item) => {
      const itemId = item.id != null ? String(item.id) : String(item.name || '');
      const tag = item.tag || '';
      const isContainer = isContainerTag(tag);
      const expanded = isContainer && state.expandedIds.has(itemId);
      const hasChildren = isContainer && item.childItems.length > 0;
      const row = document.createElement('div') as TreeNodeElement;
      row.className = `tree-node${isContainer ? ' tree-node-container' : ''}`;
      row.setAttribute('role', 'treeitem');
      if (hasChildren) { row.setAttribute('aria-expanded', String(expanded)); }
      row.setAttribute('aria-selected', 'false');
      row.draggable = true;
      row.dataset.id = itemId;
      row.dataset.tag = tag;
      const labelText = `${item.name || item.tag} (${tag})`;

      const chevron = document.createElement('span');
      if (hasChildren) {
        chevron.className = `tree-chevron${expanded ? '' : ' collapsed'}`;
        chevron.textContent = '▼';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.addEventListener('click', (event) => {
          event.stopPropagation();
          if (state.expandedIds.has(itemId)) { state.expandedIds.delete(itemId); }
          else { state.expandedIds.add(itemId); }
          const treeRoot = document.getElementById('tree-root');
          if (!treeRoot) { return; }
          treeRoot.innerHTML = '';
          renderTreeWithRootInto(treeRoot);
          applyTreeSelection();
        });
      } else {
        chevron.className = 'tree-chevron-placeholder';
      }

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      if (tag === 'SearchStringAddition') {
        icon.classList.add('tree-icon-svg');
        icon.innerHTML = commandSearchIcon();
      } else {
        icon.textContent = getTreeIcon(tag);
      }
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'tree-node-label';
      label.textContent = labelText;
      label.title = labelText;
      row.appendChild(chevron);
      row.appendChild(icon);
      if (hasDataPath(item)) {
        const dataBound = document.createElement('span');
        dataBound.className = 'tree-node-data-bound';
        dataBound.textContent = '■';
        dataBound.setAttribute('aria-hidden', 'true');
        dataBound.title = getDataPathValue(item);
        row.appendChild(dataBound);
      }
      row.appendChild(label);

      row.ondragstart = (event) => {
        event.stopPropagation();
        if (state.selectedIds.length > 1) { event.preventDefault(); return; }
        event.dataTransfer!.setData('text/plain', row.dataset.id || '');
        event.dataTransfer!.effectAllowed = 'move';
      };
      row.ondragover = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const transfer = event.dataTransfer!;
        if (Array.from(transfer.types).indexOf(REQUISITE_DROP_TYPE) >= 0) {
          if (isContainerTag(row.dataset.tag)) { transfer.dropEffect = 'copy'; row.classList.add('drop-target'); }
          return;
        }
        const sourceId = transfer.getData('text/plain');
        const targetId = row.dataset.id || '';
        if (!sourceId || sourceId === targetId || !isContainerTag(row.dataset.tag)) { return; }
        const model = state.formModel;
        if (!model || !findElement(model, sourceId)
          || isItemWithinSubtree(getDisplayItems(state), sourceId, targetId)) { return; }
        transfer.dropEffect = 'move';
        row.classList.add('drop-target');
      };
      row.ondragleave = (event) => {
        event.stopPropagation();
        row.classList.remove('drop-target');
      };
      row.ondrop = (event) => {
        event.preventDefault();
        event.stopPropagation();
        row.classList.remove('drop-target');
        const transfer = event.dataTransfer!;
        const requisiteName = transfer.getData(REQUISITE_DROP_TYPE);
        const targetId = row.dataset.id || '';
        if (requisiteName) {
          if (!isContainerTag(row.dataset.tag)) { return; }
          ports.postMessage({ type: 'addElementFromRequisite', requisiteName, dataPath: requisiteName, targetId, index: 0 });
          return;
        }
        const sourceId = transfer.getData('text/plain');
        if (!sourceId || sourceId === targetId || !isContainerTag(row.dataset.tag)) { return; }
        const model = state.formModel;
        if (!model || !findElement(model, sourceId)
          || isItemWithinSubtree(getDisplayItems(state), sourceId, targetId)) { return; }
        ports.postMessage({ type: 'dragDrop', sourceId, targetId, index: 0 });
      };
      row._formItem = item;
      row.addEventListener('click', (event) => {
        const target = event.target;
        if (target instanceof Element && target.classList.contains('tree-chevron')) { return; }
        event.stopPropagation();
        const id = row.dataset.id || '';
        const ctrl = event.ctrlKey || event.metaKey;
        const shift = event.shiftKey;
        if (shift && state.anchorId != null) {
          const flat = getFlatVisibleIds(getDisplayItems(state), state.expandedIds, null);
          const anchorIndex = flat.indexOf(state.anchorId);
          const clickIndex = flat.indexOf(id);
          if (anchorIndex >= 0 && clickIndex >= 0) {
            state.selectedIds = flat.slice(Math.min(anchorIndex, clickIndex), Math.max(anchorIndex, clickIndex) + 1);
          } else {
            state.selectedIds = [id];
            state.anchorId = id;
          }
        } else if (ctrl) {
          const index = state.selectedIds.indexOf(id);
          if (index >= 0) {
            state.selectedIds = state.selectedIds.slice(0, index).concat(state.selectedIds.slice(index + 1));
            state.anchorId = state.selectedIds.length ? state.selectedIds[state.selectedIds.length - 1] : id;
          } else {
            state.selectedIds = state.selectedIds.concat([id]);
            state.anchorId = id;
          }
        } else {
          state.selectedIds = [id];
          state.anchorId = id;
        }
        applyTreeSelection();
        ports.updateToolbarState();
        state.selectedAttributeId = null;
        state.selectedCommandId = null;
        ports.updatePropsPanel();
        ports.postMessage({
          type: 'selectElement',
          elementId: state.selectedIds.length ? state.selectedIds[0] : undefined,
          selectedIds: state.selectedIds.slice(),
          ctrlKey: ctrl,
          shiftKey: shift,
        });
      });
      children.appendChild(row);
      if (hasChildren && expanded) { renderTree(item.childItems, row, item); }
    });
    parentElement.appendChild(children);
  }

  function renderTreeWithRootInto(treeRoot: HTMLElement): void {
    if (!state.formModel || !state.formModel.childItemsRoot) { return; }
    const root = document.createElement('div');
    root.className = 'tree-node tree-node-container';
    root.setAttribute('role', 'treeitem');
    root.setAttribute('aria-expanded', 'true');
    root.setAttribute('aria-selected', 'false');
    root.dataset.id = FORM_ROOT_ID;
    root.dataset.tag = 'Form';
    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron-placeholder';
    root.appendChild(chevron);
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '⌂';
    icon.setAttribute('aria-hidden', 'true');
    root.appendChild(icon);
    const label = document.createElement('span');
    label.className = 'tree-node-label';
    label.textContent = 'Форма';
    label.title = 'Форма';
    root.appendChild(label);
    root.ondragover = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const transfer = event.dataTransfer!;
      if (Array.from(transfer.types).indexOf(REQUISITE_DROP_TYPE) >= 0) { return; }
      const sourceId = transfer.getData('text/plain');
      if (!sourceId || sourceId === FORM_ROOT_ID || !state.formModel || !findElement(state.formModel, sourceId)) { return; }
      transfer.dropEffect = 'move';
      root.classList.add('drop-target');
    };
    root.ondragleave = (event) => {
      event.stopPropagation();
      root.classList.remove('drop-target');
    };
    root.ondrop = (event) => {
      event.preventDefault();
      event.stopPropagation();
      root.classList.remove('drop-target');
      const transfer = event.dataTransfer!;
      if (transfer.getData(REQUISITE_DROP_TYPE)) { return; }
      const sourceId = transfer.getData('text/plain');
      if (!sourceId || sourceId === FORM_ROOT_ID || !state.formModel || !findElement(state.formModel, sourceId)) { return; }
      ports.postMessage({ type: 'dragDrop', sourceId, targetId: FORM_ROOT_ID, index: 0 });
    };
    root.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof Element && target.classList.contains('tree-chevron')) { return; }
      event.stopPropagation();
      state.selectedIds = [FORM_ROOT_ID];
      state.anchorId = FORM_ROOT_ID;
      applyTreeSelection();
      ports.updateToolbarState();
      state.selectedAttributeId = null;
      state.selectedCommandId = null;
      ports.updatePropsPanel();
      ports.postMessage({ type: 'selectElement', elementId: FORM_ROOT_ID, selectedIds: [FORM_ROOT_ID] });
    });
    treeRoot.appendChild(root);
    const displayItems = getDisplayItems(state);
    const syntheticForm: FormChildItem = {
      tag: 'Form', id: FORM_ROOT_ID, name: 'Form', properties: {}, childItems: displayItems,
    };
    renderTree(displayItems, root, syntheticForm);
  }

  return {
    renderTreeWithRoot() {
      const root = document.getElementById('tree-root');
      if (root) { renderTreeWithRootInto(root); }
    },
    applyTreeSelection,
  };
}
