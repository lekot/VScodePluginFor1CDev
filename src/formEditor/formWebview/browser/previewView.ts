import type { FormChildItem } from '../../formModel';
import { getPreviewFieldCharacterWidth } from '../../formPreviewLayout';
import type { FormBrowserState, FormOutboundMessage } from '../contracts';
import { findElement, getDataPathValue, getDisplayItems, getFormItemKey, getRareTagFallbacks, isContainerTag, isItemWithinSubtree, isRealElement, resolvePreviewTitle } from '../modelQueries';
import { applyPreviewContainerLayout, getContainerLayoutMeta, getLayoutPropertyValueByAliases, getPagesRepresentationClass, getPreviewDropIndex, layoutContainerStyle, resolveTitleLocation } from '../previewLayout';

const REQUISITE_DROP_TYPE = 'application/x-1c-form-requisite';
const RARE_TAG_FALLBACKS = getRareTagFallbacks();

export interface PreviewViewPorts {
  postMessage(message: FormOutboundMessage): void;
  applyTreeSelection(): void;
  updateToolbarState(): void;
  updatePropsPanel(): void;
}

export interface PreviewViewController {
  renderPreview(items: FormChildItem[], parent: HTMLElement): void;
  updatePreviewFitScale(): void;
  fitPreviewToWidth(): void;
}

interface PreviewControlWrap extends HTMLDivElement {
  _mockupChildContainer?: HTMLElement;
}

interface PagesTabState {
  pages: FormChildItem[];
  pageOrderIds: string[];
  activePageId: string | null;
  pagesKey: string;
}

function safePreviewDomIdPart(value: string): string {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function createPreviewView(state: FormBrowserState, ports: PreviewViewPorts): PreviewViewController {
  function updatePreviewFitScale(): void {
    const root = document.getElementById('preview-form');
    if (!root) { return; }
    if (!root.classList.contains('preview-fit-width')) {
      root.style.zoom = '';
      root.removeAttribute('data-fit-scale');
      return;
    }
    root.style.zoom = '1';
    const availableWidth = root.clientWidth;
    const contentWidth = root.scrollWidth;
    const scale = contentWidth > availableWidth && contentWidth > 0
      ? Math.max(0.25, availableWidth / contentWidth)
      : 1;
    root.style.zoom = String(scale);
    root.setAttribute('data-fit-scale', scale.toFixed(3));
  }

  function fitPreviewToWidth(): void {
    const root = document.getElementById('preview-form');
    const button = document.getElementById('tb-preview-fit');
    if (!root || !button) { return; }
    const enabled = !root.classList.contains('preview-fit-width');
    root.classList.toggle('preview-fit-width', enabled);
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    updatePreviewFitScale();
  }

  function buildTabsState(pagesNode: FormChildItem): PagesTabState {
    const pagesKey = getFormItemKey(pagesNode);
    const pages = (pagesNode.childItems || []).filter((item) => item && item.tag === 'Page');
    const pageOrderIds = pages.map(getFormItemKey).filter((key) => key !== '');
    const stored = pagesKey ? state.activePageIdByPagesKey[pagesKey] : undefined;
    let activePageId = stored != null && stored !== '' ? String(stored) : null;
    if (activePageId && !pageOrderIds.includes(activePageId)) { activePageId = null; }
    if (!activePageId && pageOrderIds.length) { activePageId = pageOrderIds[0]; }
    if (!pageOrderIds.length) { delete state.activePageIdByPagesKey[pagesKey]; }
    else if (activePageId != null) { state.activePageIdByPagesKey[pagesKey] = activePageId; }
    return { pages, pageOrderIds, activePageId, pagesKey };
  }

  function findPageById(pages: FormChildItem[], pageId: string): FormChildItem | null {
    for (const page of pages) {
      if (getFormItemKey(page) === pageId) { return page; }
    }
    return null;
  }

  function renderPagesInPreview(
    pagesNode: FormChildItem,
    outerElement: HTMLElement,
    pagesLayout: ReturnType<typeof getContainerLayoutMeta>,
  ): void {
    outerElement.textContent = '';
    const representationClass = getPagesRepresentationClass(pagesNode);
    outerElement.className = `${layoutContainerStyle(pagesLayout, { skipPreviewChildren: true, previewChildrenAlias: 'preview-pages-outer' })} ${representationClass}`;
    applyPreviewContainerLayout(outerElement, pagesLayout);
    const tabsState = buildTabsState(pagesNode);
    const tabList = document.createElement('div');
    tabList.className = 'preview-pages-tablist';
    tabList.setAttribute('role', 'tablist');
    const panelWrap = document.createElement('div');
    panelWrap.className = 'preview-pages-panel-wrap';
    const pagesKey = tabsState.pagesKey;
    const activeId = tabsState.activePageId;
    tabsState.pages.forEach((pageItem, index) => {
      const pageId = getFormItemKey(pageItem);
      if (!pageId) { return; }
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'preview-pages-tab';
      tab.setAttribute('role', 'tab');
      const safeId = `${safePreviewDomIdPart(pagesKey)}-${safePreviewDomIdPart(pageId)}`;
      tab.id = `preview-tab-${safeId}`;
      tab.setAttribute('aria-controls', `preview-panel-${safeId}`);
      tab.setAttribute('data-pages-key', pagesKey);
      tab.setAttribute('data-page-id', pageId);
      tab.setAttribute('aria-selected', pageId === activeId ? 'true' : 'false');
      tab.setAttribute('tabindex', pageId === activeId ? '0' : '-1');
      tab.textContent = resolvePreviewTitle(pageItem) || pageItem.name || `Страница ${index + 1}`;
      tab.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (String(state.activePageIdByPagesKey[pagesKey]) === String(pageId)) { return; }
        state.activePageIdByPagesKey[pagesKey] = pageId;
        const root = document.getElementById('preview-form');
        if (state.formModel && state.formModel.childItemsRoot && root) { renderPreview(getDisplayItems(state), root); }
      });
      tabList.appendChild(tab);
    });
    const panel = document.createElement('div');
    panel.className = 'preview-pages-active-panel';
    panel.setAttribute('role', 'tabpanel');
    const activePage = activeId ? findPageById(tabsState.pages, activeId) : null;
    if (activePage && activeId && activePage.childItems.length) {
      const pageLayout = getContainerLayoutMeta(activePage);
      panel.className += ` ${layoutContainerStyle(pageLayout)}`;
      applyPreviewContainerLayout(panel, pageLayout);
      const safeId = `${safePreviewDomIdPart(pagesKey)}-${safePreviewDomIdPart(activeId)}`;
      panel.id = `preview-panel-${safeId}`;
      panel.setAttribute('aria-labelledby', `preview-tab-${safeId}`);
      renderPreview(activePage.childItems, panel);
    } else {
      const panelId = activeId
        ? `${safePreviewDomIdPart(pagesKey)}-${safePreviewDomIdPart(activeId)}`
        : `${safePreviewDomIdPart(pagesKey)}-empty`;
      panel.id = `preview-panel-${panelId}`;
      if (activeId) {
        panel.setAttribute('aria-labelledby', `preview-tab-${safePreviewDomIdPart(pagesKey)}-${safePreviewDomIdPart(activeId)}`);
      }
      if (!tabsState.pages.length) {
        panel.textContent = 'Нет страниц';
        panel.className += ' preview-empty-state';
      } else if (activePage && !activePage.childItems.length) {
        panel.textContent = '';
      }
    }
    panelWrap.appendChild(panel);
    const otherKids = (pagesNode.childItems || []).filter((item) => item && item.tag !== 'Page');
    outerElement.appendChild(tabList);
    outerElement.appendChild(panelWrap);
    if (otherKids.length) {
      const extra = document.createElement('div');
      extra.className = 'preview-pages-nonpage-children';
      const extraLayout = getContainerLayoutMeta(pagesNode);
      extra.className += ` ${layoutContainerStyle(extraLayout)}`;
      applyPreviewContainerLayout(extra, extraLayout);
      renderPreview(otherKids, extra);
      outerElement.appendChild(extra);
    }
  }

  function createPreviewControl(item: FormChildItem, tag: string): PreviewControlWrap {
    const label = resolvePreviewTitle(item) || `${item.name || tag}`;
    const wrap = document.createElement('div') as PreviewControlWrap;
    wrap.className = 'preview-control-wrap';
    if (tag === 'InputField' || tag === 'SearchStringAddition' || tag === 'ValueList') {
      const titleLocation = resolveTitleLocation(item);
      wrap.className = `preview-control-wrap preview-field-row preview-title-${titleLocation}`;
      const fieldLabel = document.createElement('span');
      fieldLabel.className = 'preview-field-label';
      fieldLabel.textContent = label || '—';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '';
      input.readOnly = true;
      input.className = 'preview-input';
      const dataPath = getDataPathValue(item);
      const attributes = state.formModel && Array.isArray(state.formModel.attributes) ? state.formModel.attributes : [];
      const characterWidth = getPreviewFieldCharacterWidth(dataPath, attributes);
      input.style.width = `${characterWidth}ch`;
      input.dataset.dataPath = dataPath;
      input.dataset.characterWidth = String(characterWidth);
      const inputFrame = document.createElement('span');
      inputFrame.className = 'preview-input-frame';
      inputFrame.appendChild(input);
      wrap.appendChild(fieldLabel);
      wrap.appendChild(inputFrame);
    } else if (tag === 'CheckBoxField') {
      wrap.className = 'preview-control-wrap preview-field-row preview-check-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.disabled = true;
      checkbox.className = 'preview-check';
      const checkboxLabel = document.createElement('span');
      checkboxLabel.className = 'preview-field-label';
      checkboxLabel.textContent = label || '—';
      wrap.appendChild(checkbox);
      wrap.appendChild(checkboxLabel);
    } else if (tag === 'RadioButton' || tag === 'RadioButtonField') {
      wrap.className = 'preview-control-wrap preview-field-row';
      const radioLabel = document.createElement('span');
      radioLabel.className = 'preview-field-label';
      radioLabel.textContent = label || '—';
      const radioStack = document.createElement('div');
      radioStack.className = 'preview-radio-stack';
      ['Да', 'Нет', 'Авто'].forEach((option, index) => {
        const optionWrap = document.createElement('label');
        optionWrap.className = 'preview-radio-option';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `${item.id || item.name || 'radio'}-preview`;
        radio.disabled = true;
        if (index === 1) { radio.checked = true; }
        const text = document.createElement('span');
        text.textContent = option;
        optionWrap.appendChild(radio);
        optionWrap.appendChild(text);
        radioStack.appendChild(optionWrap);
      });
      wrap.appendChild(radioLabel);
      wrap.appendChild(radioStack);
    } else if (tag === 'ListBox' || tag === 'ListField') {
      wrap.className = 'preview-control-wrap preview-field-row';
      const listLabel = document.createElement('span');
      listLabel.className = 'preview-field-label';
      listLabel.textContent = label || '—';
      const listMock = document.createElement('div');
      listMock.className = 'preview-list-mock';
      ['Первый элемент', 'Второй элемент', 'Третий элемент'].forEach((option, index) => {
        const row = document.createElement('div');
        row.className = `preview-list-row${index === 1 ? ' active' : ''}`;
        row.textContent = option;
        listMock.appendChild(row);
      });
      wrap.appendChild(listLabel);
      wrap.appendChild(listMock);
    } else if (tag === 'Button' || tag === 'Hyperlink') {
      const button = document.createElement(tag === 'Hyperlink' ? 'a' : 'button');
      button.textContent = label || item.name || tag;
      (button as HTMLButtonElement).disabled = true;
      button.className = 'preview-button';
      wrap.appendChild(button);
    } else if (tag === 'LabelField') {
      const labelField = document.createElement('span');
      labelField.textContent = label || '—';
      labelField.className = 'preview-label';
      wrap.appendChild(labelField);
    } else if (tag === 'Table') {
      const tableWrap = document.createElement('div');
      tableWrap.className = 'preview-table-mock';
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      const tableColumns = (item.childItems || []).filter(isRealElement);
      tableColumns.forEach((column) => {
        const header = document.createElement('th');
        header.textContent = resolvePreviewTitle(column) || column.name || column.tag || '—';
        header.dataset.id = column.id || column.name || '';
        header.setAttribute('data-id', header.dataset.id);
        headerRow.appendChild(header);
      });
      if (tableColumns.length === 0) {
        const header = document.createElement('th');
        header.textContent = label || item.name || 'Таблица';
        headerRow.appendChild(header);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      const dataRow = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = Math.max(1, tableColumns.length);
      cell.textContent = 'Нет данных';
      cell.style.color = 'var(--preview-muted-foreground)';
      dataRow.appendChild(cell);
      tbody.appendChild(dataRow);
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      wrap.appendChild(tableWrap);
    } else if (tag === 'Page' || tag === 'Pages') {
      const pageBlock = document.createElement('div');
      pageBlock.className = tag === 'Pages' ? 'preview-group-block' : 'preview-page-block';
      const pageTitle = document.createElement('div');
      pageTitle.className = tag === 'Page' ? 'preview-page-title' : 'preview-group-title';
      pageTitle.textContent = tag === 'Pages' ? '' : label || item.name || 'Страница';
      if (pageTitle.textContent) { pageBlock.appendChild(pageTitle); }
      wrap.appendChild(pageBlock);
      wrap._mockupChildContainer = pageBlock;
    } else if (tag === 'AutoCommandBar' || tag === 'CommandBar') {
      const commandBar = document.createElement('div');
      commandBar.className = 'preview-commandbar';
      wrap.appendChild(commandBar);
      wrap._mockupChildContainer = commandBar;
    } else if (isContainerTag(tag)) {
      const groupBlock = document.createElement('div');
      groupBlock.className = `preview-group-block preview-group-${String(tag).toLowerCase()}`;
      if (label) {
        const groupTitle = document.createElement('div');
        groupTitle.className = 'preview-group-title';
        groupTitle.textContent = label;
        groupBlock.appendChild(groupTitle);
      }
      wrap.appendChild(groupBlock);
      wrap._mockupChildContainer = groupBlock;
    } else if (tag === 'LabelDecoration') {
      const decoration = document.createElement('span');
      decoration.className = 'preview-label preview-label-decoration';
      decoration.textContent = label || '—';
      wrap.appendChild(decoration);
    } else if (tag === 'PictureDecoration') {
      const decoration = document.createElement('span');
      decoration.className = 'preview-picture-decoration';
      decoration.textContent = '\uD83D\uDDBC';
      wrap.appendChild(decoration);
    } else if (RARE_TAG_FALLBACKS.has(tag)) {
      wrap.appendChild(createRareTagFallbackWidget(label, tag));
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'preview-fallback';
      fallback.textContent = `${label}${tag ? ` (${tag})` : ''}`;
      wrap.appendChild(fallback);
    }
    return wrap;
  }

  function createRareTagFallbackWidget(label: string, tag: string): HTMLElement {
    const widget = document.createElement('div');
    widget.className = 'preview-fallback-widget';
    const text = document.createElement('span');
    text.className = 'fallback-label';
    text.textContent = label || '—';
    const pill = document.createElement('span');
    pill.className = 'fallback-tag';
    pill.textContent = tag || 'Control';
    widget.appendChild(text);
    widget.appendChild(pill);
    return widget;
  }

  function renderPreview(items: FormChildItem[], parentElement: HTMLElement): void {
    let renderTarget: HTMLElement = parentElement;
    if (parentElement.id === 'preview-form') {
      const existing = parentElement.querySelector<HTMLElement>('.preview-form-body');
      if (existing) { renderTarget = existing; }
      else {
        renderTarget = document.createElement('div');
        renderTarget.className = 'preview-form-body';
        parentElement.appendChild(renderTarget);
      }
      parentElement.classList.toggle('preview-has-commandbar', Boolean(items && items.some((item) => item.tag === 'AutoCommandBar')));
    }
    renderTarget.innerHTML = '';
    parentElement.classList.remove('preview-placeholder');
    if (items.length) { parentElement.classList.add('preview-mockup-form'); }
    else { parentElement.classList.remove('preview-mockup-form'); }
    if (!items.length) {
      renderTarget.textContent = 'Нет элементов';
      return;
    }
    items.forEach((item) => {
      const visibleRaw = getLayoutPropertyValueByAliases(item.properties, ['Visible', 'visible']);
      if (visibleRaw.toLowerCase() === 'false') { return; }
      const id = item.id != null ? String(item.id) : String(item.name || '');
      const tag = item.tag || '';
      const isContainer = isContainerTag(tag);
      const layoutMeta = isContainer ? getContainerLayoutMeta(item) : null;
      const itemElement = document.createElement('div');
      itemElement.className = `preview-item ${isContainer ? 'preview-container' : 'preview-control'}`;
      if (layoutMeta) { itemElement.classList.add(`preview-container-${layoutMeta.orientation}`); }
      itemElement.dataset.id = id;
      itemElement.dataset.tag = tag;
      const controlWrap = createPreviewControl(item, tag);
      itemElement.appendChild(controlWrap);
      itemElement.draggable = true;
      itemElement.ondragstart = (event) => {
        event.stopPropagation();
        event.dataTransfer!.setData('text/plain', id);
        event.dataTransfer!.effectAllowed = 'move';
      };
      itemElement.ondragover = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const transfer = event.dataTransfer!;
        if (Array.from(transfer.types).indexOf(REQUISITE_DROP_TYPE) >= 0) {
          if (isContainer) { transfer.dropEffect = 'copy'; itemElement.classList.add('drop-target'); }
          return;
        }
        const sourceId = transfer.getData('text/plain');
        if (!sourceId || sourceId === id || !isContainer) { return; }
        const model = state.formModel;
        if (!model || !findElement(model, sourceId)
          || isItemWithinSubtree(getDisplayItems(state), sourceId, id)) { return; }
        transfer.dropEffect = 'move';
        itemElement.classList.add('drop-target');
      };
      itemElement.ondragleave = (event) => {
        event.stopPropagation();
        itemElement.classList.remove('drop-target');
      };
      itemElement.ondrop = (event) => {
        event.preventDefault();
        event.stopPropagation();
        itemElement.classList.remove('drop-target');
        const transfer = event.dataTransfer!;
        const requisiteName = transfer.getData(REQUISITE_DROP_TYPE);
        if (requisiteName) {
          if (!isContainer) { return; }
          const children = itemElement.querySelector('.preview-children')?.children || [];
          const index = getPreviewDropIndex(children, event, layoutMeta ? layoutMeta.orientation : 'vertical');
          ports.postMessage({ type: 'addElementFromRequisite', requisiteName, dataPath: requisiteName, targetId: id, index, source: 'preview' });
          return;
        }
        const sourceId = transfer.getData('text/plain');
        if (!sourceId || sourceId === id || !isContainer) { return; }
        const model = state.formModel;
        if (!model || !findElement(model, sourceId)
          || isItemWithinSubtree(getDisplayItems(state), sourceId, id)) { return; }
        const children = itemElement.querySelector('.preview-children')?.children || [];
        const index = getPreviewDropIndex(children, event, layoutMeta ? layoutMeta.orientation : 'vertical');
        ports.postMessage({ type: 'dragDrop', sourceId, targetId: id, index, source: 'preview' });
      };
      itemElement.addEventListener('click', (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest('th[data-id]')) { return; }
        event.stopPropagation();
        document.querySelectorAll<HTMLElement>('.preview-item.selected').forEach((node) => node.classList.remove('selected'));
        state.selectedIds = [id];
        state.anchorId = id;
        ports.applyTreeSelection();
        itemElement.classList.add('selected');
        ports.updateToolbarState();
        state.selectedAttributeId = null;
        state.selectedCommandId = null;
        ports.updatePropsPanel();
        ports.postMessage({ type: 'selectElement', elementId: id, selectedIds: state.selectedIds.slice() });
      });
      renderTarget.appendChild(itemElement);
      if (tag === 'Table') {
        const headers = controlWrap.querySelectorAll<HTMLElement>('th[data-id]');
        for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
          const header = headers[headerIndex];
          const columnId = header.getAttribute('data-id');
          if (!columnId) { continue; }
          header.addEventListener('click', (event) => {
            event.stopPropagation();
            document.querySelectorAll<HTMLElement>('.preview-item.selected').forEach((node) => node.classList.remove('selected'));
            controlWrap.querySelectorAll<HTMLElement>('th.selected').forEach((node) => node.classList.remove('selected'));
            state.selectedIds = [columnId];
            state.anchorId = columnId;
            header.classList.add('selected');
            ports.applyTreeSelection();
            ports.updateToolbarState();
            state.selectedAttributeId = null;
            state.selectedCommandId = null;
            ports.updatePropsPanel();
            ports.postMessage({ type: 'selectElement', elementId: columnId, selectedIds: state.selectedIds.slice() });
          });
        }
      } else if (isContainer && controlWrap._mockupChildContainer && (item.childItems.length || tag === 'Pages')) {
        const childWrap = controlWrap._mockupChildContainer;
        if (tag === 'Pages') {
          renderPagesInPreview(item, childWrap, layoutMeta!);
        } else {
          childWrap.className += ` ${layoutContainerStyle(layoutMeta!)}`;
          applyPreviewContainerLayout(childWrap, layoutMeta!);
          renderPreview(item.childItems, childWrap);
        }
      }
    });
    if (parentElement.id === 'preview-form') { updatePreviewFitScale(); }
  }

  return { renderPreview, updatePreviewFitScale, fitPreviewToWidth };
}
