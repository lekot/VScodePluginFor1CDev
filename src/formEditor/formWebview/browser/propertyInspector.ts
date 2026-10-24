import type { FormChildItem } from '../../formModel';
import type { FormAttributeView, FormBrowserState, FormCommandView, FormOutboundMessage } from '../contracts';
import { escapeWebviewAttribute, escapeWebviewText } from '../escaping';
import { extractDisplayValue, findElement } from '../modelQueries';

const FORM_ROOT_ID = '__form_root__';

export interface PropertyInspectorPorts {
  postMessage(message: FormOutboundMessage): void;
}

export interface PropertyInspectorController {
  updatePropsPanel(): void;
}

export function createPropertyInspector(state: FormBrowserState, ports: PropertyInspectorPorts): PropertyInspectorController {
  function renderAttributeProps(attribute: FormAttributeView): void {
    const placeholder = document.getElementById('props-placeholder');
    const content = document.getElementById('props-content');
    const actions = document.getElementById('props-actions');
    const propsHeader = document.getElementById('props-header');
    if (!placeholder || !content || !actions) { return; }
    if (propsHeader) { propsHeader.textContent = `Реквизит: ${attribute.name || ''}`; }
    placeholder.style.display = 'none';
    content.style.display = 'block';
    actions.style.display = 'block';
    let html = '<div class="props-block"><p class="props-block-title">Основные</p>';
    html += `<div class="prop-row"><label>Имя</label> <div class="prop-input-wrap"><input id="attr-prop-name" value="${escapeWebviewAttribute(attribute.name)}"></div></div>`;
    html += `<div class="prop-row"><label>ID</label> <div class="prop-input-wrap"><input id="attr-prop-id" value="${escapeWebviewAttribute(attribute.id)}"></div></div></div>`;
    if (Object.keys(attribute.properties).some((key) => key !== ':@' && !key.startsWith('@'))) {
      html += '<div class="props-block"><p class="props-block-title">Свойства</p>';
      for (const key in attribute.properties) {
        if (key === ':@' || key.startsWith('@')) { continue; }
        const rawValue = attribute.properties[key];
        const value = typeof rawValue === 'object' && rawValue !== null
          ? extractDisplayValue(rawValue)
          : typeof rawValue === 'string' ? rawValue : String(rawValue);
        html += `<div class="prop-row"><label>${escapeWebviewText(key)}</label> <div class="prop-input-wrap"><input data-key="${escapeWebviewAttribute(key)}" data-attr-id="${escapeWebviewAttribute(attribute.name || attribute.id)}" value="${escapeWebviewAttribute(value || '')}"></div></div>`;
      }
      html += '</div>';
    }
    content.innerHTML = html;
    content.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.addEventListener('change', () => {
        const elementId = attribute.name || attribute.id;
        if (input.id === 'attr-prop-name') {
          ports.postMessage({ type: 'propertyChange', elementId, section: 'attributes', key: 'name', value: input.value });
        } else if (input.id === 'attr-prop-id') {
          ports.postMessage({ type: 'propertyChange', elementId, section: 'attributes', key: 'id', value: input.value });
        } else if (input.dataset.key) {
          ports.postMessage({ type: 'propertyChange', elementId, section: 'attributes', key: input.dataset.key, value: input.value });
        }
      });
    });
  }

  function renderCommandProps(command: FormCommandView): void {
    const placeholder = document.getElementById('props-placeholder');
    const content = document.getElementById('props-content');
    const actions = document.getElementById('props-actions');
    const propsHeader = document.getElementById('props-header');
    if (!placeholder || !content || !actions) { return; }
    if (propsHeader) { propsHeader.textContent = `Команда: ${command.name || ''}`; }
    placeholder.style.display = 'none';
    content.style.display = 'block';
    actions.style.display = 'block';
    let html = '<div class="props-block"><p class="props-block-title">Основные</p>';
    html += `<div class="prop-row"><label>Имя</label> <div class="prop-input-wrap"><input id="cmd-prop-name" value="${escapeWebviewAttribute(command.name)}"></div></div>`;
    html += `<div class="prop-row"><label>ID</label> <div class="prop-input-wrap"><input id="cmd-prop-id" value="${escapeWebviewAttribute(command.id)}"></div></div></div>`;
    if (Object.keys(command.properties).some((key) => key !== ':@' && !key.startsWith('@'))) {
      html += '<div class="props-block"><p class="props-block-title">Свойства</p>';
      for (const key in command.properties) {
        if (key === ':@' || key.startsWith('@')) { continue; }
        const rawValue = command.properties[key];
        const value = typeof rawValue === 'object' && rawValue !== null
          ? extractDisplayValue(rawValue)
          : typeof rawValue === 'string' ? rawValue : String(rawValue);
        html += `<div class="prop-row"><label>${escapeWebviewText(key)}</label> <div class="prop-input-wrap"><input data-key="${escapeWebviewAttribute(key)}" value="${escapeWebviewAttribute(value || '')}"></div></div>`;
      }
      html += '</div>';
    }
    content.innerHTML = html;
    content.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.addEventListener('change', () => {
        const elementId = command.name || command.id;
        if (input.id === 'cmd-prop-name') {
          ports.postMessage({ type: 'propertyChange', elementId, section: 'commands', key: 'name', value: input.value });
        } else if (input.id === 'cmd-prop-id') {
          ports.postMessage({ type: 'propertyChange', elementId, section: 'commands', key: 'id', value: input.value });
        } else if (input.dataset.key) {
          ports.postMessage({ type: 'propertyChange', elementId, section: 'commands', key: input.dataset.key, value: input.value });
        }
      });
    });
  }

  function renderProps(item: FormChildItem | null): void {
    const placeholder = document.getElementById('props-placeholder');
    const content = document.getElementById('props-content');
    const actions = document.getElementById('props-actions');
    const propsHeader = document.getElementById('props-header');
    if (!placeholder || !content || !actions) { return; }
    if (!item) {
      if (propsHeader) { propsHeader.textContent = ''; }
      placeholder.style.display = 'block';
      content.style.display = 'none';
      content.innerHTML = '';
      actions.style.display = 'none';
      return;
    }
    if (propsHeader) { propsHeader.textContent = `${item.name || ''} (${item.tag || ''})`; }
    placeholder.style.display = 'none';
    content.classList.remove('is-hidden');
    actions.classList.remove('is-hidden');
    actions.style.display = 'block';
    let html = '<div class="props-block"><p class="props-block-title">Основные</p>';
    html += `<div class="prop-row"><label>Тип</label> <span class="fe-badge">${escapeWebviewText(item.tag || '')}</span></div>`;
    html += `<div class="prop-row"><label>Имя</label> <div class="prop-input-wrap"><input id="prop-name" value="${escapeWebviewAttribute(item.name)}"></div></div>`;
    html += `<div class="prop-row"><label>ID</label> <div class="prop-input-wrap"><input id="prop-id" value="${escapeWebviewAttribute(item.id)}"></div></div></div>`;
    if (Object.keys(item.properties).some((key) => key !== ':@' && !key.startsWith('@'))) {
      html += '<div class="props-block"><p class="props-block-title">Свойства</p>';
      for (const key in item.properties) {
        if (key === ':@' || key.startsWith('@')) { continue; }
        const rawValue = item.properties[key];
        const value = typeof rawValue === 'object' && rawValue !== null
          ? extractDisplayValue(rawValue)
          : typeof rawValue === 'string' ? rawValue : String(rawValue);
        html += `<div class="prop-row"><label>${escapeWebviewText(key)}</label> <div class="prop-input-wrap"><input data-key="${escapeWebviewAttribute(key)}" value="${escapeWebviewAttribute(value || '')}"></div></div>`;
      }
      html += '</div>';
    }
    content.innerHTML = html;
    content.style.display = 'block';
    const eventNames = item.events && typeof item.events === 'object' ? Object.keys(item.events) : [];
    if (eventNames.length) {
      const eventBlock = document.createElement('div');
      eventBlock.className = 'props-block';
      const eventTitle = document.createElement('p');
      eventTitle.className = 'props-block-title';
      eventTitle.textContent = 'События';
      eventBlock.appendChild(eventTitle);
      const elementId = item.id || item.name;
      eventNames.forEach((eventName) => {
        const row = document.createElement('div');
        row.className = 'prop-row';
        const label = document.createElement('label');
        label.textContent = eventName;
        const inputWrap = document.createElement('div');
        inputWrap.className = 'prop-input-wrap';
        const input = document.createElement('input');
        input.className = 'event-method-input';
        input.dataset.event = eventName;
        input.value = item.events && item.events[eventName] != null ? String(item.events[eventName]) : '';
        input.placeholder = 'Имя процедуры';
        input.addEventListener('change', () => {
          ports.postMessage({ type: 'propertyChange', elementId, section: 'events', key: eventName, value: input.value });
        });
        inputWrap.appendChild(input);
        const gotoButton = document.createElement('button');
        gotoButton.type = 'button';
        gotoButton.className = 'btn-goto-proc';
        gotoButton.textContent = 'Перейти';
        gotoButton.addEventListener('click', () => {
          const procedure = input.value.trim();
          if (procedure) { ports.postMessage({ type: 'openModule', procedureName: procedure }); }
        });
        row.appendChild(label);
        row.appendChild(inputWrap);
        row.appendChild(gotoButton);
        eventBlock.appendChild(row);
      });
      content.appendChild(eventBlock);
    }
    content.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      if (input.classList.contains('event-method-input')) { return; }
      input.addEventListener('change', () => {
        const elementId = item.id || item.name;
        const key = input.dataset.key ? input.dataset.key : input.id ? input.id.replace('prop-', '') : null;
        if (key) { ports.postMessage({ type: 'propertyChange', elementId, key, value: input.value }); }
      });
    });
  }

  function renderPropsMultiple(items: FormChildItem[]): void {
    const placeholder = document.getElementById('props-placeholder');
    const content = document.getElementById('props-content');
    const actions = document.getElementById('props-actions');
    const propsHeader = document.getElementById('props-header');
    if (!placeholder || !content || !actions) { return; }
    if (!items.length) {
      if (propsHeader) { propsHeader.textContent = ''; }
      placeholder.style.display = 'block';
      content.style.display = 'none';
      content.innerHTML = '';
      actions.style.display = 'block';
      return;
    }
    const itemCount = items.length;
    if (propsHeader) { propsHeader.textContent = `Выбрано элементов: ${itemCount}`; }
    placeholder.style.display = 'none';
    actions.style.display = 'block';
    const propertyCounts = new Map<string, number>();
    items.forEach((item) => {
      for (const key in item.properties) {
        if (key === ':@' || key.startsWith('@')) { continue; }
        propertyCounts.set(key, (propertyCounts.get(key) || 0) + 1);
      }
    });
    const commonPropertyKeys = [...propertyCounts.keys()].filter((key) => propertyCounts.get(key) === itemCount);
    const eventCounts = new Map<string, number>();
    items.forEach((item) => {
      if (!item.events) { return; }
      for (const eventName in item.events) { eventCounts.set(eventName, (eventCounts.get(eventName) || 0) + 1); }
    });
    const commonEventKeys = [...eventCounts.keys()].filter((eventName) => eventCounts.get(eventName) === itemCount);
    const tags = items.map((item) => item.tag || '');
    const sameTag = tags.every((tag) => tag === tags[0]);
    let html = '<div class="props-block"><p class="props-block-title">Основные</p>';
    html += `<div class="prop-row"><label>Тип</label> <span class="fe-badge">${sameTag ? escapeWebviewText(tags[0]) : 'Разные'}</span></div>`;
    html += '<div class="prop-row"><label>Имя</label> <div class="prop-input-wrap"><input id="prop-name" readonly placeholder="Разные" value=""></div></div>';
    html += '<div class="prop-row"><label>ID</label> <div class="prop-input-wrap"><input id="prop-id" readonly placeholder="Разные" value=""></div></div></div>';
    if (commonPropertyKeys.length) {
      html += '<div class="props-block"><p class="props-block-title">Свойства</p>';
      commonPropertyKeys.forEach((key) => {
        const values = items.map((item) => {
          const value = item.properties[key];
          return typeof value === 'object' && value !== null ? extractDisplayValue(value) : value == null ? '' : String(value);
        });
        const same = values.every((value) => value === values[0]);
        const value = same ? values[0] || '' : '';
        const placeholderAttribute = same ? '' : ' placeholder="Разные значения"';
        html += `<div class="prop-row"><label>${escapeWebviewText(key)}</label> <div class="prop-input-wrap"><input data-key="${escapeWebviewAttribute(key)}" value="${escapeWebviewAttribute(value)}"${placeholderAttribute}></div></div>`;
      });
      html += '</div>';
    }
    if (commonEventKeys.length) {
      html += '<div class="props-block"><p class="props-block-title">События</p>';
      commonEventKeys.forEach((eventName) => {
        const values = items.map((item) => item.events && item.events[eventName] ? String(item.events[eventName]).trim() : '');
        const same = values.every((value) => value === values[0]);
        const value = same ? values[0] || '' : '';
        const placeholderAttribute = same ? '' : ' placeholder="Разные значения"';
        html += `<div class="prop-row"><label>${escapeWebviewText(eventName)}</label> <div class="prop-input-wrap"><input class="event-method-input" data-event="${escapeWebviewAttribute(eventName)}" value="${escapeWebviewAttribute(value)}"${placeholderAttribute} placeholder="Имя процедуры"></div> <button type="button" class="btn-goto-proc" data-proc="">Перейти</button></div>`;
      });
      html += '</div>';
    }
    if (!commonPropertyKeys.length && !commonEventKeys.length) {
      html = '<div class="placeholder">Нет общих свойств для выбранных элементов</div>';
    }
    content.innerHTML = html;
    content.style.display = 'block';
    content.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      if (input.id === 'prop-name' || input.id === 'prop-id') { return; }
      input.addEventListener('change', () => {
        const key = input.dataset.key;
        const section = input.classList.contains('event-method-input') ? 'events' : undefined;
        const eventKey = input.dataset.event;
        const payloadKey = section === 'events' ? eventKey : key;
        ports.postMessage({ type: 'propertyChange', elementIds: state.selectedIds.slice(), section, key: payloadKey, value: input.value });
      });
    });
    content.querySelectorAll<HTMLButtonElement>('.btn-goto-proc').forEach((button) => {
      button.addEventListener('click', function() {
        const row = this.closest('.prop-row');
        const input = row?.querySelector<HTMLInputElement>('.event-method-input') || null;
        const procedure = input?.value?.trim() || '';
        if (procedure) { ports.postMessage({ type: 'openModule', procedureName: procedure }); }
      });
    });
  }

  function updatePropsPanel(): void {
    const model = state.formModel;
    if (state.selectedAttributeId && model) {
      const attribute = model.attributes.find((item) => item.name === state.selectedAttributeId || item.id === state.selectedAttributeId);
      if (attribute) { renderAttributeProps(attribute); return; }
    }
    if (state.selectedAttributeId && document.querySelector('#attributes-tbody tr.selected[data-from-tree="true"]')) {
      const placeholder = document.getElementById('props-placeholder');
      const content = document.getElementById('props-content');
      const actions = document.getElementById('props-actions');
      const header = document.getElementById('props-header');
      if (placeholder && content && header) {
        header.textContent = 'Реквизит по элементам';
        content.style.display = 'none';
        content.innerHTML = '';
        placeholder.style.display = 'block';
        placeholder.textContent = 'Секция Attributes в Form.xml пуста. Реквизиты показаны по привязкам элементов (DataPath).';
        if (actions) { actions.style.display = 'none'; }
      }
      return;
    }
    if (state.selectedCommandId && model) {
      const command = model.commands.find((item) => item.name === state.selectedCommandId || item.id === state.selectedCommandId);
      if (command) { renderCommandProps(command); return; }
    }
    if (state.selectedCommandId && document.querySelector('#commands-tbody tr.selected[data-from-tree="true"]')) {
      const placeholder = document.getElementById('props-placeholder');
      const content = document.getElementById('props-content');
      const actions = document.getElementById('props-actions');
      const header = document.getElementById('props-header');
      if (placeholder && content && header) {
        header.textContent = 'Команда по элементам';
        content.style.display = 'none';
        content.innerHTML = '';
        placeholder.style.display = 'block';
        placeholder.textContent = 'Секция Commands в Form.xml пуста. Команды показаны по кнопкам (CommandName).';
        if (actions) { actions.style.display = 'none'; }
      }
      return;
    }
    if (state.selectedRequisiteFullPath && state.selectedIds.length === 0) {
      const placeholder = document.getElementById('props-placeholder');
      const content = document.getElementById('props-content');
      const actions = document.getElementById('props-actions');
      const header = document.getElementById('props-header');
      if (placeholder && content && header) {
        header.textContent = `Реквизит: ${state.selectedRequisiteFullPath}`;
        content.style.display = 'none';
        placeholder.style.display = 'block';
        placeholder.textContent = '';
        if (actions) { actions.style.display = 'none'; }
      }
      return;
    }
    if (state.selectedIds.length === 0) {
      renderProps(null);
    } else if (state.selectedIds.length === 1) {
      const selectedId = state.selectedIds[0];
      if (selectedId === FORM_ROOT_ID) {
        const formEvents: Record<string, string> = {};
        model?.formEvents.forEach((event) => { formEvents[event.name] = event.method; });
        renderProps({ tag: 'Form', id: FORM_ROOT_ID, name: 'Form', properties: {}, childItems: [], events: formEvents });
      } else {
        const selected = findElement(model, selectedId);
        if (selected) { renderProps(selected); }
        else { renderProps(null); }
      }
    } else {
      const elements = state.selectedIds.map((id) => findElement(model, id)).filter((item): item is FormChildItem => Boolean(item));
      if (elements.length) { renderPropsMultiple(elements); }
      else { renderProps(null); }
    }
  }

  return { updatePropsPanel };
}
