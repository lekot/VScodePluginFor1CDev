/** Small self-authored command icons. Inline SVG keeps the webview independent of image resources. */
function getCommandIconSvg(name: string): string {
  const paths: Record<string, string> = {
    add: 'M8 2.5v11M2.5 8h11',
    delete: 'M3 4.5h10M6 4.5V3h4v1.5m1 0-.5 9h-5l-.5-9m2 2.5v4m2-4v4',
    save: 'M3 2.5h8l2 2v9H3zM5 2.5v4h6v-4M5 13.5v-4h6v4',
    search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM10.3 10.3l3.2 3.2',
  };
  const path = paths[name];
  if (!path) {return '';}
  return `<svg class="fe-command-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
}
export function getFormWebviewLayout(): string {
  return `  <div class="fe-toolbar" role="toolbar" aria-label="Панель инструментов формы">
    <button type="button" class="fe-toolbar-btn" id="tb-add" title="Добавить элемент" aria-label="Добавить">${getCommandIconSvg('add')}</button>
    <button type="button" class="fe-toolbar-btn" id="tb-add-wizard" title="Мастер добавления" aria-label="Мастер добавления">Мастер</button>
    <button type="button" class="fe-toolbar-btn" id="tb-delete" title="Удалить" aria-label="Удалить">${getCommandIconSvg('delete')}</button>
    <button type="button" class="fe-toolbar-btn" id="tb-up" title="Вверх" aria-label="Вверх">&#x2191;</button>
    <button type="button" class="fe-toolbar-btn" id="tb-down" title="Вниз" aria-label="Вниз">&#x2193;</button>
    <button type="button" class="fe-toolbar-btn" id="tb-copy" title="Копировать" aria-label="Копировать">&#x2398;</button>
    <button type="button" class="fe-toolbar-btn" id="tb-paste" title="Вставить" aria-label="Вставить">&#x2399;</button>
    <span class="fe-toolbar-spacer" aria-hidden="true"></span>
    <div class="fe-theme-wrap">
      <label class="fe-theme-label" for="tb-theme-mode">Тема:</label>
      <select id="tb-theme-mode" class="fe-theme-select" title="Режим темы">
        <option value="auto">Auto</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
    <button type="button" class="fe-toolbar-btn" id="tb-module" title="Открыть модуль формы" aria-label="Модуль формы">Модуль</button>
    <button type="button" class="fe-toolbar-btn" id="tb-cancel" title="Отмена" aria-label="Отмена">Отмена</button>
    <button type="button" class="fe-toolbar-btn" id="tb-save" title="Сохранить" aria-label="Сохранить">${getCommandIconSvg('save')}<span>Сохранить</span></button>
  </div>
  <div id="add-wizard-overlay" class="add-wizard-overlay" role="dialog" aria-modal="true" aria-labelledby="add-wizard-title">
    <div class="add-wizard-panel">
      <h3 id="add-wizard-title" class="add-wizard-title">Мастер добавления элемента</h3>
      <p class="add-wizard-step">Шаг 1. Выберите тип элемента</p>
      <label class="add-wizard-label" for="add-wizard-type">Тип</label>
      <select id="add-wizard-type" class="add-wizard-select"></select>
      <p id="add-wizard-hint" class="add-wizard-hint"></p>
      <p class="add-wizard-step">Шаг 2. Задайте имя элемента</p>
      <label class="add-wizard-label" for="add-wizard-name">Имя</label>
      <input id="add-wizard-name" class="add-wizard-input" type="text" maxlength="128" />
      <p id="add-wizard-target" class="add-wizard-target"></p>
      <div class="add-wizard-actions">
        <button type="button" id="add-wizard-cancel">Отмена</button>
        <button type="button" id="add-wizard-submit">Добавить</button>
      </div>
    </div>
  </div>
  <div class="top-row">
    <div class="zone-tree">
      <h3>Элементы формы</h3>
      <div class="left-zone-tabs" role="tablist">
        <button type="button" role="tab" data-left-tab="elements" aria-selected="true">Элементы</button>
        <button type="button" role="tab" data-left-tab="command-interface" aria-selected="false">Командный интерфейс</button>
      </div>
      <div id="left-tab-elements" role="tabpanel">
        <div id="tree-selection-count" class="props-selection-header is-hidden"></div>
        <div id="tree-root" role="tree" aria-label="Элементы формы"></div>
        <div id="tree-empty" class="empty-state is-hidden">
          <h4 id="tree-empty-title"></h4>
          <p id="tree-empty-hint"></p>
        </div>
        <div id="tree-error" class="error is-hidden"></div>
      </div>
      <div id="left-command-interface" class="is-hidden" role="tabpanel">
        <div id="command-interface-content"></div>
      </div>
    </div>
    <div class="splitter-v" id="splitter-v" title="Изменить ширину панели"></div>
    <div class="zone-right-upper">
        <div class="right-panel-tabs" role="tablist">
          <button type="button" role="tab" data-right-tab="attributes" aria-selected="true">Реквизиты</button>
          <button type="button" role="tab" data-right-tab="commands" aria-selected="false">Команды</button>
          <button type="button" role="tab" data-right-tab="parameters" aria-selected="false">Параметры</button>
        </div>
        <div id="right-tab-attributes" class="right-tab-panel" role="tabpanel">
          <div id="attributes-table-wrap" class="fe-table-wrap">
            <table class="fe-table" id="attributes-table">
              <thead><tr><th class="attributes-col-name">Реквизит</th><th class="attributes-col-usage">Использование</th><th class="attributes-col-type">Тип</th></tr></thead>
              <tbody id="attributes-tbody"></tbody>
            </table>
          </div>
          <div id="attributes-tree-wrap" class="fe-requisite-tree-wrap is-hidden">
            <div id="attributes-tree-root" role="tree"></div>
          </div>
          <div class="fe-toolbar-buttons">
            <button type="button" id="btn-add-attribute" title="Добавить реквизит">${getCommandIconSvg('add')}Добавить</button>
            <button type="button" id="btn-edit-attribute" title="Изменить выбранный" disabled>Изменить</button>
            <button type="button" id="btn-delete-attribute" title="Удалить выбранный" disabled>${getCommandIconSvg('delete')}Удалить</button>
          </div>
        </div>
        <div id="right-tab-commands" class="right-tab-panel is-hidden" role="tabpanel">
          <div class="fe-table-wrap">
            <table class="fe-table" id="commands-table">
              <thead><tr><th>Команда</th><th>Подпись</th></tr></thead>
              <tbody id="commands-tbody"></tbody>
            </table>
          </div>
          <div class="fe-toolbar-buttons">
            <button type="button" id="btn-add-command" title="Добавить команду">${getCommandIconSvg('add')}Добавить</button>
            <button type="button" id="btn-delete-command" title="Удалить выбранную" disabled>${getCommandIconSvg('delete')}Удалить</button>
          </div>
        </div>
        <div id="right-tab-parameters" class="right-tab-panel is-hidden" role="tabpanel">
          <p class="placeholder">Параметры формы будут доступны после поддержки секции в Form.xml</p>
        </div>
      </div>
    <div class="zone-props" role="region" aria-label="Свойства элемента">
      <h3>Свойства</h3>
      <div class="zone-props-scroll">
        <div id="props-header" class="props-selection-header"></div>
        <div id="props-content" class="is-hidden"></div>
        <div id="props-placeholder" class="placeholder">Выберите элемент</div>
      </div>
      <div id="props-actions" class="props-actions-sticky is-hidden">
        <button type="button" id="btn-cancel" title="Отмена">Отмена</button>
        <button type="button" id="btn-save" title="Сохранить">${getCommandIconSvg('save')}Сохранить</button>
        <span id="save-status"></span>
      </div>
    </div>
  </div>
  <div class="splitter-h" id="splitter-h" title="Изменить высоту превью"></div>
  <div class="zone-preview">
    <div class="zone-preview-head">
      <h3>Превью</h3>
      <button type="button" class="fe-toolbar-btn" id="tb-preview-fit" title="Подогнать превью по ширине" aria-pressed="false">По ширине</button>
    </div>
    <div id="preview-form" class="preview-placeholder" role="tabpanel">
      <div class="preview-form-body">
        <div class="preview-empty-state">
          <p class="preview-empty-title">Превью формы</p>
          <p class="preview-empty-hint">Добавляйте элементы слева, чтобы сразу увидеть структуру и компоновку.</p>
        </div>
      </div>
    </div>
  </div>`;
}
