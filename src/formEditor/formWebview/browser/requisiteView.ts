import type { FormBrowserState, FormOutboundMessage, FormAttributeView, FormCommandView, RequisiteTreeNode } from '../contracts';
import { buildRequisiteTree, collectRequisitesFromTree, extractDisplayValue, getAttributeTypeDisplay, getAttributeUsage } from '../modelQueries';

const REQUISITE_DROP_TYPE = 'application/x-1c-form-requisite';

export interface RequisiteViewPorts {
  postMessage(message: FormOutboundMessage): void;
  applyTreeSelection(): void;
  updateToolbarState(): void;
  updatePropsPanel(): void;
}

export interface RequisiteViewController {
  renderAttributesTable(attributes: FormAttributeView[], fromTree: boolean): void;
  renderRequisiteTree(nodes: RequisiteTreeNode[], container: HTMLElement | null): void;
  applyRequisiteTreeSelection(): void;
  renderCommandsTable(commands: FormCommandView[], fromTree: boolean): void;
}

export function createRequisiteView(state: FormBrowserState, ports: RequisiteViewPorts): RequisiteViewController {
  function renderAttributesTable(attributes: FormAttributeView[], _fromTree: boolean): void {
    const tbody = document.getElementById('attributes-tbody');
    if (!tbody) { return; }
    tbody.innerHTML = '';
    if (!attributes.length) { return; }
    attributes.forEach((attribute) => {
      const row = document.createElement('tr');
      row.dataset.id = String(attribute.id || attribute.name);
      row.dataset.name = attribute.name;
      if (attribute.fromTree) { row.dataset.fromTree = 'true'; }
      row.draggable = !attribute.fromTree;
      if (!attribute.fromTree) {
        row.ondragstart = (event) => {
          event.dataTransfer!.setData(REQUISITE_DROP_TYPE, attribute.name || '');
          event.dataTransfer!.effectAllowed = 'copy';
        };
      }
      const nameCell = document.createElement('td');
      const namePrimary = document.createElement('span');
      namePrimary.className = 'attr-name-primary';
      namePrimary.textContent = attribute.name || '';
      nameCell.appendChild(namePrimary);
      const attributeId = attribute.id && attribute.id !== attribute.name ? String(attribute.id) : '';
      if (attributeId) {
        const nameSecondary = document.createElement('span');
        nameSecondary.className = 'attr-name-secondary';
        nameSecondary.textContent = attributeId;
        nameCell.appendChild(nameSecondary);
      }
      const usageCell = document.createElement('td');
      const usageText = document.createElement('span');
      usageText.className = 'attr-usage';
      usageText.textContent = getAttributeUsage(attribute);
      usageCell.appendChild(usageText);
      const typeCell = document.createElement('td');
      const typeText = document.createElement('span');
      typeText.className = 'attr-type-muted';
      typeText.textContent = attribute.fromTree ? '—' : getAttributeTypeDisplay(attribute) || '—';
      typeCell.appendChild(typeText);
      row.appendChild(nameCell);
      row.appendChild(usageCell);
      row.appendChild(typeCell);
      row.addEventListener('click', () => {
        state.selectedAttributeId = attribute.id || attribute.name;
        state.selectedCommandId = null;
        document.querySelectorAll('#attributes-tbody tr.selected').forEach((selected) => selected.classList.remove('selected'));
        row.classList.add('selected');
        document.querySelectorAll('#commands-tbody tr.selected').forEach((selected) => selected.classList.remove('selected'));
        if (!attribute.fromTree) {
          const editButton = document.getElementById('btn-edit-attribute');
          const deleteButton = document.getElementById('btn-delete-attribute');
          if (editButton instanceof HTMLButtonElement) { editButton.disabled = false; }
          if (deleteButton instanceof HTMLButtonElement) { deleteButton.disabled = false; }
        }
        ports.updatePropsPanel();
      });
      tbody.appendChild(row);
    });
  }

  function renderRequisiteTree(nodes: RequisiteTreeNode[], container: HTMLElement | null): void {
    if (!container) { return; }
    container.innerHTML = '';
    if (!nodes.length) { return; }
    container.className = 'tree-children';
    const renderNode = (node: RequisiteTreeNode, parent: HTMLElement, depth: number): void => {
      const depthPixels = depth * 16;
      const row = document.createElement('div');
      row.className = `tree-node requisite-tree-node${node.children.length ? ' tree-node-container' : ''}`;
      row.setAttribute('role', 'treeitem');
      row.dataset.fullPath = node.fullPath || '';
      row.style.paddingLeft = `${depthPixels}px`;
      const hasChildren = node.children.length > 0;
      const expanded = hasChildren && state.requisiteExpandedPaths.has(node.fullPath);
      if (hasChildren) { row.setAttribute('aria-expanded', String(expanded)); }
      const chevron = document.createElement('span');
      chevron.className = `tree-chevron${hasChildren ? (expanded ? '' : ' collapsed') : ' tree-chevron-placeholder'}`;
      if (hasChildren) { chevron.textContent = '▼'; }
      chevron.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'tree-node-label';
      label.textContent = node.pathSegment || node.fullPath || '';
      if (node.formElementIds.length > 0) {
        const badge = document.createElement('span');
        badge.className = 'fe-badge requisite-count';
        badge.textContent = String(node.formElementIds.length);
        badge.title = `Элементов формы: ${node.formElementIds.length}`;
        label.appendChild(badge);
      }
      row.appendChild(chevron);
      row.appendChild(label);
      if (hasChildren) {
        chevron.addEventListener('click', (event) => {
          event.stopPropagation();
          if (state.requisiteExpandedPaths.has(node.fullPath)) { state.requisiteExpandedPaths.delete(node.fullPath); }
          else { state.requisiteExpandedPaths.add(node.fullPath); }
          renderRequisiteTree(buildRequisiteTree(state.formModel), document.getElementById('attributes-tree-root'));
          applyRequisiteTreeSelection();
        });
      }
      if (node.formElementIds.length && state.selectedIds.length === 1 && node.formElementIds.includes(state.selectedIds[0])) {
        row.classList.add('selected');
      }
      if (state.selectedRequisiteFullPath === node.fullPath) { row.classList.add('selected'); }
      row.addEventListener('click', (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest('.tree-chevron')) { return; }
        document.querySelectorAll('#attributes-tree-root .requisite-tree-node.selected').forEach((selected) => selected.classList.remove('selected'));
        document.querySelectorAll('#attributes-tbody tr.selected').forEach((selected) => selected.classList.remove('selected'));
        row.classList.add('selected');
        state.selectedRequisiteFullPath = node.fullPath;
        state.selectedAttributeId = null;
        state.selectedCommandId = null;
        if (node.formElementIds.length > 0) {
          state.selectedIds = [node.formElementIds[0]];
          state.anchorId = state.selectedIds[0];
          ports.applyTreeSelection();
          ports.updateToolbarState();
          ports.updatePropsPanel();
          ports.postMessage({ type: 'selectElement', elementId: state.selectedIds[0], selectedIds: state.selectedIds.slice() });
        } else {
          state.selectedIds = [];
          state.anchorId = null;
          ports.applyTreeSelection();
          ports.updateToolbarState();
          ports.updatePropsPanel();
        }
      });
      parent.appendChild(row);
      if (hasChildren && expanded) {
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        row.appendChild(childContainer);
        node.children.forEach((child) => renderNode(child, childContainer, depth + 1));
      }
    };
    nodes.forEach((node) => renderNode(node, container, 0));
  }

  function applyRequisiteTreeSelection(): void {
    document.querySelectorAll<HTMLElement>('#attributes-tree-root .requisite-tree-node').forEach((node) => {
      const path = node.dataset.fullPath;
      node.classList.toggle('selected', Boolean(path && state.selectedRequisiteFullPath === path));
    });
  }

  function renderCommandsTable(commands: FormCommandView[], _fromTree: boolean): void {
    const tbody = document.getElementById('commands-tbody');
    if (!tbody) { return; }
    tbody.innerHTML = '';
    if (!commands.length) { return; }
    commands.forEach((command) => {
      const row = document.createElement('tr');
      row.dataset.id = String(command.id || command.name);
      row.dataset.name = command.name;
      if (command.fromTree) { row.dataset.fromTree = 'true'; }
      const nameCell = document.createElement('td');
      nameCell.textContent = command.name || '';
      const titleCell = document.createElement('td');
      titleCell.textContent = command.properties['Title'] != null ? extractDisplayValue(command.properties['Title']) : '';
      row.appendChild(nameCell);
      row.appendChild(titleCell);
      row.addEventListener('click', () => {
        state.selectedCommandId = command.id || command.name;
        state.selectedAttributeId = null;
        document.querySelectorAll('#commands-tbody tr.selected').forEach((selected) => selected.classList.remove('selected'));
        row.classList.add('selected');
        document.querySelectorAll('#attributes-tbody tr.selected').forEach((selected) => selected.classList.remove('selected'));
        const deleteButton = document.getElementById('btn-delete-command');
        if (deleteButton instanceof HTMLButtonElement) { deleteButton.disabled = Boolean(command.fromTree); }
        ports.updatePropsPanel();
      });
      tbody.appendChild(row);
    });
  }

  return { renderAttributesTable, renderRequisiteTree, applyRequisiteTreeSelection, renderCommandsTable };
}

export function getRequisiteTableFallback(state: FormBrowserState): FormAttributeView[] {
  return collectRequisitesFromTree(state.formModel);
}
