import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseSdbl } from '../../../src/queryBuilder/sdbl/sdblParser';
import { formatSdbl } from '../../../src/queryBuilder/sdbl/sdblFormatter';

suite('Query Builder Webview UI & Logic Refinements (Task 2)', () => {
  const rootDir = path.resolve(__dirname, '../../../..');
  const sourceHtmlPath = path.join(rootDir, 'src/queryBuilder/ui/queryBuilderWebview.html');
  const htmlSource = fs.readFileSync(sourceHtmlPath, 'utf-8');
  const scriptMatch = htmlSource.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Script tag must exist in HTML');
  const scriptCode = scriptMatch[1];

  class MockElement {
    public tagName: string;
    public children: MockElement[] = [];
    public parentElement: MockElement | null = null;
    public _listeners: { [event: string]: ((e: any) => void)[] } = {};
    public style: { [key: string]: string } = {};
    public _classes: Set<string> = new Set();
    public checked: boolean = false;
    public disabled: boolean = false;
    public type: string = 'text';
    public placeholder: string = '';
    public title: string = '';
    public draggable: boolean = false;
    public selected: boolean = false;
    private _value: string = '';
    private _innerHTML: string = '';
    private _textContent: string = '';
    private _attrs: { [k: string]: string } = {};

    constructor(tag: string = 'div') {
      this.tagName = tag.toUpperCase();
    }

    get value(): string {
      if (this.tagName === 'SELECT') {
        const selected = this.children.find((c) => (c as any).selected);
        if (selected) return selected.value || selected.getAttribute('value') || '';
        if (this._value) return this._value;
        return this.children.length > 0 ? (this.children[0].value || this.children[0].getAttribute('value') || '') : '';
      }
      return this._value || '';
    }
    set value(v: string) {
      this._value = v;
      if (this.tagName === 'SELECT') {
        for (const c of this.children) {
          (c as any).selected = (c.value === v || c.getAttribute('value') === v);
        }
      }
    }

    get innerHTML(): string {
      return this._innerHTML;
    }
    set innerHTML(val: string) {
      this._innerHTML = val;
      this.children = [];
    }

    get textContent(): string {
      return this._textContent;
    }
    set textContent(val: string) {
      this._textContent = val;
    }

    get classList() {
      return {
        add: (c: string) => this._classes.add(c),
        remove: (c: string) => this._classes.delete(c),
        contains: (c: string) => this._classes.has(c),
      };
    }

    get className(): string {
      return Array.from(this._classes).join(' ');
    }
    set className(val: string) {
      this._classes = new Set(val.split(/\s+/).filter(Boolean));
    }

    addEventListener(event: string, fn: (e: any) => void) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
    }

    dispatchEvent(event: { type: string; [key: string]: any }) {
      const handlers = this._listeners[event.type] || [];
      for (const h of handlers) {
        h(event);
      }
    }

    click() {
      this.dispatchEvent({ type: 'click', target: this });
      this.dispatchEvent({ type: 'change', target: this });
    }

    appendChild(child: MockElement): MockElement {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    removeChild(child: MockElement): MockElement {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentElement = null;
      }
      return child;
    }

    setAttribute(k: string, v: string) {
      this._attrs[k] = v;
    }
    getAttribute(k: string): string | null {
      return this._attrs[k] !== undefined ? this._attrs[k] : null;
    }

    querySelectorAll(sel: string): MockElement[] {
      const res: MockElement[] = [];
      const search = (node: MockElement) => {
        for (const c of node.children) {
          let matched = false;
          if (sel === '*') {
            matched = true;
          } else if (sel.startsWith('.')) {
            matched = c.classList.contains(sel.substring(1));
          } else if (sel.includes('[') && sel.includes(']')) {
            const m = sel.match(/^([A-Za-z0-9_-]*)\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/);
            if (m) {
              const [, tag, attr, val] = m;
              const tagOk = !tag || c.tagName === tag.toUpperCase();
              let attrVal: string | null = null;
              if (attr === 'type') {
                attrVal = c.type || c.getAttribute('type');
              } else {
                attrVal = c.getAttribute(attr);
              }
              const valOk = val !== undefined ? attrVal === val : attrVal !== null;
              matched = tagOk && valOk;
            }
          } else if (sel.includes('.')) {
            const parts = sel.split('.');
            const tag = parts[0].toUpperCase();
            const cls = parts[1];
            matched = (!parts[0] || c.tagName === tag) && c.classList.contains(cls);
          } else if (c.tagName === sel.toUpperCase()) {
            matched = true;
          }

          if (matched) res.push(c);
          search(c);
        }
      };
      search(this);
      return res;
    }

    querySelector(sel: string): MockElement | null {
      const arr = this.querySelectorAll(sel);
      return arr.length > 0 ? arr[0] : null;
    }
  }

  interface WebviewSandbox {
    window: any;
    document: any;
    state: any;
    elements: any;
    tabButtons: MockElement[];
    sentMessages: any[];
    postMessageToWebview: (msg: any) => void;
  }

  function createWebviewEnvironment(): WebviewSandbox {
    const vm = require('vm');
    const elementsById: { [id: string]: MockElement } = {};
    const getOrCreateElement = (id: string) => {
      if (!elementsById[id]) {
        let tag = 'div';
        let type = 'text';
        if (id.startsWith('btn-')) tag = 'button';
        else if (id.startsWith('input-')) tag = 'input';
        else if (id.startsWith('check-')) { tag = 'input'; type = 'checkbox'; }
        else if (id.startsWith('radio-')) { tag = 'input'; type = 'radio'; }
        else if (id.startsWith('tbody-')) tag = 'tbody';
        else if (id.startsWith('thead-')) tag = 'thead';
        else if (id.startsWith('table-')) tag = 'table';
        else if (id.startsWith('select-')) tag = 'select';

        const el = new MockElement(tag);
        el.type = type;
        el.setAttribute('id', id);
        elementsById[id] = el;
      }
      return elementsById[id];
    };

    const tabIds = [
      'tab-tables-fields',
      'tab-joins',
      'tab-grouping',
      'tab-conditions',
      'tab-extra',
      'tab-unions',
      'tab-order',
      'tab-indexes',
      'tab-totals',
      'tab-package',
      'tab-query-text',
    ];

    const tabButtons: MockElement[] = tabIds.map((id) => {
      const btn = new MockElement('button');
      btn.className = 'tab-btn';
      btn.setAttribute('data-tab', id);
      return btn;
    });
    tabButtons[0].className = 'tab-btn active';

    const tabPanes: MockElement[] = tabIds.map((id) => {
      const pane = getOrCreateElement(id);
      pane.className = 'tab-pane';
      return pane;
    });
    tabPanes[0].className = 'tab-pane active';

    const mockDocument = {
      getElementById: (id: string) => getOrCreateElement(id),
      createElement: (tag: string) => new MockElement(tag),
      querySelector: (sel: string) => {
        if (sel === '.tab-btn.active') {
          return tabButtons.find((b) => b.classList.contains('active')) || tabButtons[0];
        }
        for (const btn of tabButtons) {
          if (btn.getAttribute('data-tab') && sel.includes(`data-tab="${btn.getAttribute('data-tab')}"`)) {
            return btn;
          }
        }
        for (const id in elementsById) {
          const found = elementsById[id].querySelector(sel);
          if (found) return found;
        }
        return null;
      },
      querySelectorAll: (sel: string) => {
        if (sel === '.tab-btn') return tabButtons;
        if (sel === '.tab-pane') return tabPanes;
        return [];
      },
    };

    const sentMessages: any[] = [];
    const windowListeners: { [evt: string]: ((e: any) => void)[] } = {};

    const mockWindow = {
      document: mockDocument,
      addEventListener: (event: string, fn: (e: any) => void) => {
        if (!windowListeners[event]) windowListeners[event] = [];
        windowListeners[event].push(fn);
      },
    };

    const sandbox: any = {
      window: mockWindow,
      document: mockDocument,
      acquireVsCodeApi: () => ({
        postMessage: (msg: any) => {
          sentMessages.push(msg);
        },
      }),
      console: console,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
      prompt: () => '',
      alert: () => {},
    };

    vm.createContext(sandbox);
    vm.runInContext(scriptCode, sandbox);

    const postMessageToWebview = (msg: any) => {
      const handlers = windowListeners['message'] || [];
      handlers.forEach((h) => h({ data: msg }));
    };

    return {
      window: sandbox.window,
      document: mockDocument,
      state: sandbox.window.state,
      elements: sandbox.window.elements,
      tabButtons,
      sentMessages,
      postMessageToWebview,
    };
  }

  suite('Point 1 & 9: Tables, Fields & SDBL Syntax', () => {
    test('getTableAliasWithoutPrefix strips metadata prefixes in Russian and English', () => {
      const env = createWebviewEnvironment();
      const strip = env.window.getTableAliasWithoutPrefix;

      assert.strictEqual(strip('Справочник.Номенклатура'), 'Номенклатура');
      assert.strictEqual(strip('Catalog.Products'), 'Products');
      assert.strictEqual(strip('Документ.ПриходнаяНакладная'), 'ПриходнаяНакладная');
      assert.strictEqual(strip('Document.Invoice'), 'Invoice');
      assert.strictEqual(strip('РегистрНакопления.ОстаткиТоваров'), 'ОстаткиТоваров');
      assert.strictEqual(strip('AccumulationRegister.Goods'), 'Goods');
      assert.strictEqual(strip('РегистрСведений.Цены'), 'Цены');
      assert.strictEqual(strip('InformationRegister.Prices'), 'Prices');
      assert.strictEqual(strip('РегистрБухгалтерии.Хозрасчетный'), 'Хозрасчетный');
      assert.strictEqual(strip('ПланВидовХарактеристик.Свойства'), 'Свойства');
      assert.strictEqual(strip('ПланСчетов.Основной'), 'Основной');
      assert.strictEqual(strip('БизнесПроцесс.Согласование'), 'Согласование');
      assert.strictEqual(strip('Задача.Исполнить'), 'Исполнить');
      assert.strictEqual(strip('ТаблицаБезПрефикса'), 'ТаблицаБезПрефикса');
    });

    test('addFieldToQuery auto-adds parent table to q.from with unprefixed alias', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      assert.strictEqual(q.from.length, 0);

      env.window.addFieldToQuery({
        name: 'Наименование',
        fieldName: 'Наименование',
        parentTableFullName: 'Справочник.Номенклатура',
        parentTableName: 'Номенклатура',
      });

      assert.strictEqual(q.from.length, 1);
      assert.strictEqual(q.from[0].source.name, 'Справочник.Номенклатура');
      assert.strictEqual(q.from[0].alias, 'Номенклатура');

      assert.strictEqual(q.fields.length, 1);
      assert.strictEqual(q.fields[0].expression, 'Номенклатура.Наименование');
      assert.strictEqual(q.fields[0].alias, 'Наименование');
    });

    test('addFieldToQuery with prefixed string auto-adds table without duplicate', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.window.addFieldToQuery('Справочник.Контрагенты.ИНН');

      assert.strictEqual(q.from.length, 1);
      assert.strictEqual(q.from[0].source.name, 'Справочник.Контрагенты');
      assert.strictEqual(q.from[0].alias, 'Контрагенты');
      assert.strictEqual(q.fields.length, 1);
      assert.strictEqual(q.fields[0].expression, 'Контрагенты.ИНН');
      assert.strictEqual(q.fields[0].alias, 'ИНН');

      // Adding second field from same table does not duplicate from clause
      env.window.addFieldToQuery('Справочник.Контрагенты.КПП');
      assert.strictEqual(q.from.length, 1);
      assert.strictEqual(q.fields.length, 2);
      assert.strictEqual(q.fields[1].expression, 'Контрагенты.КПП');
      assert.strictEqual(q.fields[1].alias, 'КПП');
    });

    test('formatSdblQuery formats prefix ONLY in FROM (ИЗ), NEVER in SELECT (ВЫБРАТЬ)', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.window.addFieldToQuery({
        name: 'Наименование',
        fieldName: 'Наименование',
        parentTableFullName: 'Справочник.Номенклатура',
        parentTableName: 'Номенклатура',
      });

      const formatted = env.window.formatSdblQuery(q);
      assert.ok(formatted.includes('ВЫБРАТЬ\n\tНоменклатура.Наименование КАК Наименование'));
      assert.ok(formatted.includes('ИЗ\n\tСправочник.Номенклатура КАК Номенклатура'));
      assert.strictEqual(formatted.includes('ВЫБРАТЬ\n\tСправочник.'), false);
    });

    test('drag-and-drop onto tbodySelectedFields invokes addFieldToQuery', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      assert.strictEqual(q.fields.length, 0);

      const dropEvent = {
        type: 'drop',
        preventDefault: () => {},
        dataTransfer: {
          getData: (format: string) => {
            if (format === 'application/json') {
              return JSON.stringify({
                name: 'Артикул',
                fieldName: 'Артикул',
                parentTableFullName: 'Справочник.Товары',
                parentTableName: 'Товары',
              });
            }
            return '';
          },
        },
      };

      env.elements.tbodySelectedFields.dispatchEvent(dropEvent);

      assert.strictEqual(q.fields.length, 1);
      assert.strictEqual(q.fields[0].expression, 'Товары.Артикул');
      assert.strictEqual(q.fields[0].alias, 'Артикул');
      assert.strictEqual(q.from.length, 1);
      assert.strictEqual(q.from[0].source.name, 'Справочник.Товары');
      assert.strictEqual(q.from[0].alias, 'Товары');
    });
  });

  suite('Point 2: Tab 2 Joins (Unlinked tables, chips, duplicate, ON format)', () => {
    test('getUnlinkedTables detects tables without joins', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      q.from = [
        { source: { type: 'Table', name: 'Справочник.Товары' }, alias: 'Товары' },
        { source: { type: 'Table', name: 'Справочник.Склады' }, alias: 'Склады' },
      ];

      const unlinked = env.window.getUnlinkedTables(q);
      assert.strictEqual(unlinked.length, 2);
      assert.strictEqual(unlinked[0], 'Товары');
      assert.strictEqual(unlinked[1], 'Склады');

      // Add join to first table
      q.from[0].joins = [
        {
          joinType: 'Left',
          source: { type: 'Table', name: 'Справочник.Склады' },
          alias: 'Склады',
          on: { type: 'RawExpression', raw: 'Товары.Склад = Склады.Ссылка' },
        },
      ];

      const unlinkedAfter = env.window.getUnlinkedTables(q);
      assert.strictEqual(unlinkedAfter.length, 0);
    });

    test('createFullJoinBetween creates Full Join on ИСТИНА', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      q.from = [
        { source: { type: 'Table', name: 'Таблица1' }, alias: 'Таблица1' },
        { source: { type: 'Table', name: 'Таблица2' }, alias: 'Таблица2' },
      ];

      env.window.createFullJoinBetween('Таблица2', 'Таблица1');

      assert.ok(q.from[0].joins && q.from[0].joins.length === 1);
      const jn = q.from[0].joins[0];
      assert.strictEqual(jn.joinType, 'Full');
      assert.strictEqual(jn.alias, 'Таблица2');
      assert.strictEqual(jn.on.raw, 'ИСТИНА');
    });

    test('copyJoin duplicates the selected join', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      q.from = [
        {
          source: { type: 'Table', name: 'Таблица1' },
          alias: 'Таблица1',
          joins: [
            {
              joinType: 'Left',
              source: { type: 'Table', name: 'Таблица2' },
              alias: 'Таблица2',
              on: { type: 'RawExpression', raw: 'Таблица1.ID = Таблица2.ID' },
            },
          ],
        },
      ];

      assert.strictEqual(q.from[0].joins.length, 1);
      env.window.copyJoin(0);
      assert.strictEqual(q.from[0].joins.length, 2);
      assert.strictEqual(q.from[0].joins[1].on.raw, 'Таблица1.ID = Таблица2.ID');
    });

    test('formatSdblQuery combines multiple ON conditions for same table pair with И', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      q.fields = [{ expression: 'T1.F1', alias: 'F1' }];
      q.from = [
        {
          source: { type: 'Table', name: 'Таблица1' },
          alias: 'T1',
          joins: [
            {
              joinType: 'Left',
              source: { type: 'Table', name: 'Таблица2' },
              alias: 'T2',
              on: { type: 'RawExpression', raw: 'T1.ID = T2.ID' },
            },
            {
              joinType: 'Left',
              source: { type: 'Table', name: 'Таблица2' },
              alias: 'T2',
              on: { type: 'RawExpression', raw: 'T1.Code = T2.Code' },
            },
          ],
        },
      ];

      const formatted = env.window.formatSdblQuery(q);
      assert.ok(formatted.includes('ЛЕВОЕ СОЕДИНЕНИЕ Таблица2 КАК T2'));
      assert.ok(formatted.includes('ПО T1.ID = T2.ID И T1.Code = T2.Code'));
    });
  });

  suite('Point 3: Tab 3 Grouping & Aggregates (3-panel, buttons, smart defaults)', () => {
    test('isNumericField recognizes numeric vs non-numeric names in Russian and English', () => {
      const env = createWebviewEnvironment();
      const isNum = env.window.isNumericField;

      assert.strictEqual(isNum('Сумма'), true);
      assert.strictEqual(isNum('СуммаДокумента'), true);
      assert.strictEqual(isNum('Количество'), true);
      assert.strictEqual(isNum('КоличествоОстаток'), true);
      assert.strictEqual(isNum('Цена'), true);
      assert.strictEqual(isNum('Остаток'), true);
      assert.strictEqual(isNum('Оборот'), true);
      assert.strictEqual(isNum('price'), true);
      assert.strictEqual(isNum('totalAmount'), true);
      assert.strictEqual(isNum('sum'), true);
      assert.strictEqual(isNum('qty'), true);

      assert.strictEqual(isNum('Наименование'), false);
      assert.strictEqual(isNum('Ссылка'), false);
      assert.strictEqual(isNum('Комментарий'), false);
      assert.strictEqual(isNum('Description'), false);
    });

    test('addFieldToAggregates sets Sum (distinct: false) for numeric, Count(Distinct: true) for non-numeric', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.window.addFieldToAggregates('Товары.Сумма');
      assert.strictEqual(q.fields.length, 1);
      const agg1 = q.fields[0];
      assert.strictEqual(agg1.expression.type, 'Aggregate');
      assert.strictEqual(agg1.expression.aggregateType, 'Sum');
      assert.strictEqual(agg1.expression.distinct, false);
      assert.strictEqual(agg1.alias, 'СуммаСумма');

      env.window.addFieldToAggregates('Товары.Номенклатура');
      assert.strictEqual(q.fields.length, 2);
      const agg2 = q.fields[1];
      assert.strictEqual(agg2.expression.type, 'Aggregate');
      assert.strictEqual(agg2.expression.aggregateType, 'Count');
      assert.strictEqual(agg2.expression.distinct, true);
      assert.strictEqual(agg2.alias, 'НоменклатураКоличество');
    });

    test('GroupBy and Aggregates transfer buttons work correctly', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      q.fields = [
        { expression: 'T.Col1', alias: 'Col1' },
        { expression: 'T.Col2', alias: 'Col2' },
      ];

      // Test Add All to GroupBy
      env.elements.btnGroupbyAddAll.click();
      assert.ok(q.groupBy && q.groupBy.length === 2);
      assert.strictEqual(q.groupBy[0].raw, 'T.Col1');
      assert.strictEqual(q.groupBy[1].raw, 'T.Col2');

      // Test Remove All from GroupBy
      env.elements.btnGroupbyRemoveAll.click();
      assert.strictEqual(q.groupBy.length, 0);

      // Test Add All to Aggregates
      env.elements.btnAggAddAll.click();
      // Added two aggregate fields
      assert.strictEqual(q.fields.length, 4);
      assert.strictEqual(q.fields[2].expression.type, 'Aggregate');
      assert.strictEqual(q.fields[3].expression.type, 'Aggregate');

      // Test Remove All Aggregates
      env.elements.btnAggRemoveAll.click();
      assert.strictEqual(q.fields.length, 2);
    });
  });

  suite('Point 4: Tab 4 Conditions (2-panel layout, transfer, routing)', () => {
    test('addConditionFromField creates field = &param and sets op correctly', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.window.addConditionFromField('Номенклатура.Артикул');
      assert.strictEqual(q.whereConditions.length, 1);
      assert.strictEqual(q.whereConditions[0].op, '');
      assert.strictEqual(q.whereConditions[0].field, 'Номенклатура.Артикул');
      assert.strictEqual(q.whereConditions[0].cmp, '=');
      assert.strictEqual(q.whereConditions[0].value, '&Артикул');

      // Second condition gets op: 'И'
      env.window.addConditionFromField('Номенклатура.ПометкаУдаления');
      assert.strictEqual(q.whereConditions.length, 2);
      assert.strictEqual(q.whereConditions[1].op, 'И');
      assert.strictEqual(q.whereConditions[1].field, 'Номенклатура.ПометкаУдаления');
      assert.strictEqual(q.whereConditions[1].value, '&ПометкаУдаления');
    });

    test('addConditionFromField routes aggregate expressions to havingConditions', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.window.addConditionFromField('СУММА(Товары.Сумма)');
      assert.strictEqual(q.whereConditions ? q.whereConditions.length : 0, 0);
      assert.ok(q.havingConditions && q.havingConditions.length === 1);
      assert.strictEqual(q.havingConditions[0].field, 'СУММА(Товары.Сумма)');
      assert.strictEqual(q.havingConditions[0].cmp, '=');
    });

    test('renderTab4 populates conditionsFieldsList and double-clicking row adds condition', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [{ expression: 'Ном.Наименование', alias: 'Наименование' }];
      env.window.renderTab4();

      const items = env.elements.conditionsFieldsList.querySelectorAll('.item-row');
      assert.ok(items.length > 0, 'Conditions fields list must have items');
      assert.strictEqual(items[0].textContent, 'Ном.Наименование');

      // Double click first item
      items[0].dispatchEvent({ type: 'dblclick' });
      assert.strictEqual(q.whereConditions.length, 1);
      assert.strictEqual(q.whereConditions[0].field, 'Ном.Наименование');
    });
  });

  suite('Point 5: Tab 5 Extra Options (Query types, forUpdate 2-panel, Tab 9 hiding)', () => {
    test('Query type radios update query type and into table name', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      // Switch to INTO
      env.elements.radioTypeInto.click();
      assert.strictEqual(q.type, 'Select');
      assert.ok(q.into, 'q.into must be set');
      assert.strictEqual(env.elements.inputInto.disabled, false);

      // Switch to DROP
      env.elements.radioTypeDrop.click();
      assert.strictEqual(q.type, 'DropTable');
      assert.strictEqual(q.tableName, q.into || 'ВТ_Данные');

      // Switch back to SELECT
      env.elements.radioTypeSelect.click();
      assert.strictEqual(q.type, 'Select');
      assert.strictEqual(q.into, undefined);
      assert.strictEqual(env.elements.inputInto.disabled, true);
    });

    test('checkTopEnabled controls inputTop disabled status and top value', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.elements.checkTopEnabled.checked = true;
      env.elements.checkTopEnabled.dispatchEvent({ type: 'change' });
      assert.strictEqual(env.elements.inputTop.disabled, false);
      assert.strictEqual(q.top, 100);

      env.elements.checkTopEnabled.checked = false;
      env.elements.checkTopEnabled.dispatchEvent({ type: 'change' });
      assert.strictEqual(env.elements.inputTop.disabled, true);
      assert.strictEqual(q.top, undefined);
    });

    test('checkForUpdate toggles forUpdate selector container and formats ДЛЯ ИЗМЕНЕНИЯ', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.from = [
        { source: { type: 'Table', name: 'Справочник.Номенклатура' }, alias: 'Номенклатура' },
        { source: { type: 'Table', name: 'Регистр.Остатки' }, alias: 'Остатки' },
      ];
      q.fields = [{ expression: 'Номенклатура.Ссылка', alias: 'Ссылка' }];

      env.elements.checkForUpdate.checked = true;
      env.elements.checkForUpdate.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.forUpdate, true);
      assert.strictEqual(env.elements.forUpdateSelectorContainer.style.display, 'flex');

      // Add table to forUpdateTables
      q.forUpdateTables = ['Номенклатура'];
      const formatted = env.window.formatSdblQuery(q);
      assert.ok(formatted.includes('ДЛЯ ИЗМЕНЕНИЯ Номенклатура'));
    });

    test('updateTotalsTabVisibility dynamically hides tab-totals button when query is into or drop', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      const totalsTabBtn = env.tabButtons.find((b) => b.getAttribute('data-tab') === 'tab-totals');
      assert.ok(totalsTabBtn);

      env.window.updateTotalsTabVisibility();
      assert.strictEqual(totalsTabBtn.style.display, '');

      // Into query hides totals tab
      q.into = 'ВТ_Данные';
      env.window.updateTotalsTabVisibility();
      assert.strictEqual(totalsTabBtn.style.display, 'none');

      // Regular select shows totals tab
      delete q.into;
      env.window.updateTotalsTabVisibility();
      assert.strictEqual(totalsTabBtn.style.display, '');

      // Drop table hides totals tab
      q.type = 'DropTable';
      env.window.updateTotalsTabVisibility();
      assert.strictEqual(totalsTabBtn.style.display, 'none');
    });
  });

  suite('Point 6: Tab 6 Unions (Unions list, distinct checkbox, NULL correspondence)', () => {
    test('addUnionQuery, copyUnionQuery, deleteUnionQuery manage union branches', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [{ expression: 'T.Field1', alias: 'Field1' }];

      env.window.addUnionQuery('UnionAll');
      assert.strictEqual(q.unions.length, 1);
      assert.strictEqual(q.unions[0].unionType, 'UnionAll');
      assert.strictEqual(q.unions[0].statement.fields.length, 1);

      env.window.copyUnionQuery(0);
      assert.strictEqual(q.unions.length, 2);

      env.window.deleteUnionQuery(1);
      assert.strictEqual(q.unions.length, 1);
    });

    test('Finding 1: Union correspondence preserves AST without mutating branches on render', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [
        { expression: 'T1.FieldA', alias: 'FieldA' },
        { expression: 'T1.FieldB', alias: 'FieldB' },
      ];
      // Union branch has only FieldA
      q.unions = [
        {
          name: 'Объединение 1',
          unionType: 'UnionAll',
          statement: {
            type: 'Select',
            from: [],
            fields: [{ expression: 'T2.FieldA', alias: 'FieldA' }],
          },
        },
      ];

      env.window.renderTab6();

      // Check that renderTab6 did NOT mutate union statement fields
      const uFields = q.unions[0].statement.fields;
      assert.strictEqual(uFields.length, 1, 'AST fields in union must NOT be mutated on render');

      // Check that UI rendered 2 positional column rows
      const rows = env.elements.tbodyUnionsFields.children;
      assert.strictEqual(rows.length, 2, 'UI must display 2 positional rows');
    });

    test('Union list checkbox toggles between Union and UnionAll', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      env.window.addUnionQuery('UnionAll');
      assert.strictEqual(q.unions[0].unionType, 'UnionAll');

      env.window.renderTab6();
      const rows = env.elements.tbodyUnionsList.querySelectorAll('tr');
      assert.strictEqual(rows.length, 2); // main + 1 union
      const chDistinct = rows[1].querySelector('input[type="checkbox"]');
      assert.ok(chDistinct);
      assert.strictEqual(chDistinct.checked, false);

      chDistinct.checked = true;
      chDistinct.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.unions[0].unionType, 'Union');
    });
  });

  suite('Point 7: Tab 7 Order (Order table, directions, move, autoOrder sync)', () => {
    test('addOrderField adds order item with Asc direction', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.window.addOrderField('Товары.Цена');
      assert.strictEqual(q.orderBy.length, 1);
      assert.strictEqual(q.orderBy[0].direction, 'Asc');

      env.window.renderTab7();
      const rows = env.elements.tbodyOrder.querySelectorAll('tr');
      assert.strictEqual(rows.length, 1);
      const sel = rows[0].querySelector('select');
      assert.ok(sel);
      assert.strictEqual(sel.value, 'Asc');

      // Change direction to Desc
      sel.value = 'Desc';
      sel.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.orderBy[0].direction, 'Desc');
    });

    test('reordering order fields via up and down buttons', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.window.addOrderField('Поле1');
      env.window.addOrderField('Поле2');
      assert.strictEqual(env.window.getExpressionString(q.orderBy[0].expression), 'Поле1');
      assert.strictEqual(env.window.getExpressionString(q.orderBy[1].expression), 'Поле2');

      env.window.renderTab7();
      const rows = env.elements.tbodyOrder.querySelectorAll('tr');
      const btnDown = rows[0].querySelectorAll('button')[1]; // second button is down
      btnDown.click();

      assert.strictEqual(env.window.getExpressionString(q.orderBy[0].expression), 'Поле2');
      assert.strictEqual(env.window.getExpressionString(q.orderBy[1].expression), 'Поле1');
    });

    test('checkAutoOrderTab7 synchronizes with q.autoOrder and checkAutoOrder', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.elements.checkAutoOrderTab7.checked = true;
      env.elements.checkAutoOrderTab7.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.autoOrder, true);
      assert.strictEqual(env.elements.checkAutoOrder.checked, true);

      env.elements.checkAutoOrderTab7.checked = false;
      env.elements.checkAutoOrderTab7.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.autoOrder, false);
      assert.strictEqual(env.elements.checkAutoOrder.checked, false);
    });
  });

  suite('Point 8: Tab 8 & 9 Totals (Totals groups, type dropdown, sync checkboxes, smart defaults)', () => {
    test('addTotalGroupField adds group to q.totals.by', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.window.addTotalGroupField('Номенклатура');
      assert.ok(q.totals && q.totals.by);
      assert.strictEqual(q.totals.by.length, 1);
      assert.strictEqual(q.totals.by[0].hierarchy, false);
      assert.strictEqual(q.totals.by[0].periods, false);
    });

    test('Totals type dropdown syncs bidirectionally with Hierarchy and Periods checkboxes', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      env.window.addTotalGroupField('Контрагент');
      env.window.renderTab9();

      const rows = env.elements.tbodyTotalsGroups.querySelectorAll('tr');
      assert.strictEqual(rows.length, 1);
      const selType = rows[0].querySelector('select');
      const checkboxes = rows[0].querySelectorAll('input[type="checkbox"]');
      const chHier = checkboxes[0];
      const chPer = checkboxes[1];

      // Switch to Hierarchy via dropdown
      selType.value = 'Hierarchy';
      selType.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.totals.by[0].hierarchy, true);
      assert.strictEqual(q.totals.by[0].hierarchyType, 'Hierarchy');
      assert.strictEqual(chHier.checked, true);
      assert.strictEqual(chPer.checked, false);

      // Switch to Periods via dropdown
      selType.value = 'Periods';
      selType.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.totals.by[0].periods, true);
      assert.strictEqual(q.totals.by[0].hierarchy, false);
      assert.strictEqual(chHier.checked, false);
      assert.strictEqual(chPer.checked, true);

      // Switch to Elements via dropdown
      selType.value = 'Elements';
      selType.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.totals.by[0].periods, false);
      assert.strictEqual(q.totals.by[0].hierarchy, false);
      assert.strictEqual(chHier.checked, false);
      assert.strictEqual(chPer.checked, false);

      // Checking chHier checkbox syncs back to dropdown
      chHier.checked = true;
      chHier.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.totals.by[0].hierarchy, true);
      assert.strictEqual(selType.value, 'Hierarchy');
    });

    test('addTotalValueField applies Sum for numeric and Count(Distinct) for non-numeric', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.window.addTotalValueField('Товары.Сумма');
      assert.ok(q.totals && q.totals.fields);
      assert.strictEqual(q.totals.fields.length, 1);
      assert.strictEqual(q.totals.fields[0].expression.type, 'Aggregate');
      assert.strictEqual(q.totals.fields[0].expression.aggregateType, 'Sum');
      assert.strictEqual(q.totals.fields[0].expression.distinct, false);

      env.window.addTotalValueField('Товары.Номенклатура');
      assert.strictEqual(q.totals.fields.length, 2);
      assert.strictEqual(q.totals.fields[1].expression.type, 'Aggregate');
      assert.strictEqual(q.totals.fields[1].expression.aggregateType, 'Count');
      assert.strictEqual(q.totals.fields[1].expression.distinct, true);
    });

    test('checkTotalsOverall updates q.totals.overall', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      env.elements.checkTotalsOverall.checked = true;
      env.elements.checkTotalsOverall.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.totals.overall, true);

      env.elements.checkTotalsOverall.checked = false;
      env.elements.checkTotalsOverall.dispatchEvent({ type: 'change' });
      assert.strictEqual(Boolean(q.totals && q.totals.overall), false);
    });
  });

  suite('Review 15050dc Findings Verification', () => {
    test('Finding 2: Т.Сумма is not classified as aggregate and condition routes to WHERE', () => {
      const env = createWebviewEnvironment();
      const isAgg = env.window.isAggregateExpression;
      assert.strictEqual(isAgg('Т.Сумма'), false);
      assert.strictEqual(isAgg('Т.Сумма > 0'), false);
      assert.strictEqual(isAgg('Т.Количество'), false);
      assert.strictEqual(isAgg('СУММА(Т.Сумма)'), true);
      assert.strictEqual(isAgg('КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Т.Номенклатура)'), true);
      assert.strictEqual(isAgg('МИНИМУМ(Цена)'), true);
      assert.strictEqual(isAgg('МАКСИМУМ(Цена)'), true);
      assert.strictEqual(isAgg('СРЕДНЕЕ(Цена)'), true);

      const q = env.window.getActiveQuery();
      q.fields = [{ expression: 'Т.Сумма', alias: 'Сумма' }];
      q.from = [{ source: { type: 'Table', name: 'Документ.Продажа' }, alias: 'Т' }];
      env.window.addConditionFromField('Т.Сумма');
      assert.strictEqual(q.whereConditions.length, 1, 'Condition on Т.Сумма must be in whereConditions');
      assert.strictEqual(q.havingConditions ? q.havingConditions.length : 0, 0, 'Must NOT be in havingConditions');
    });

    test('Finding 5: renderTab1 re-renders metadata tree unconditionally even if DOM already has children', () => {
      const env = createWebviewEnvironment();
      // Initially populate tree with dummy node
      env.state.metadataTree = [{ id: 'stub', name: 'Stub', nodeType: 'category', children: [] }];
      env.window.renderTab1();
      assert.ok(env.elements.metadataTree.children.length > 0);

      // Now set real metadata tree and call renderTab1
      env.state.metadataTree = [
        { id: 'cat1', name: 'Справочники', nodeType: 'category', children: [{ id: 'ref1', name: 'Товары', nodeType: 'table' }] }
      ];
      env.window.renderTab1();
      const labels = env.elements.metadataTree.querySelectorAll('.tree-label').map((c: any) => c.textContent).join(' ');
      assert.ok(labels.includes('Справочники'), 'Metadata tree must be re-rendered with new categories');
    });

    test('Finding 6: Tab 4 and Tab 7 use getTableFieldsFromMetadata without phantom attributes', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.from = [{ source: { type: 'Table', name: 'Справочник.Товары' }, alias: 'Товары' }];

      env.window.renderTab4();
      // For Catalog, conditions list should not have Проведен or Дата
      const condList = env.elements.conditionsFieldsList;
      assert.ok(condList);
      const condTexts = condList.children.map((c: any) => c.textContent || '');
      assert.ok(condTexts.some((t: string) => t.includes('Товары.Ссылка')));
      assert.ok(!condTexts.some((t: string) => t.includes('Товары.Проведен')), 'Catalog should NOT contain Проведен');

      env.window.renderTab7();
      const orderTree = env.elements.orderAllFieldsTree;
      assert.ok(orderTree);
      const orderRows = orderTree.querySelectorAll('.tree-row');
      const orderHtml = orderRows.map((c: any) => c.innerHTML || c.textContent || '').join(' ');
      assert.ok(orderHtml.includes('Товары.Ссылка') || orderHtml.includes('Ссылка'));
      assert.ok(!orderHtml.includes('Проведен'), 'Order tree for Catalog should NOT contain Проведен');
    });

    test('Finding 7: switching tabs re-renders destination tab with fresh state', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [{ expression: 'Товары.Ссылка', alias: 'Ссылка' }];

      // Render Tab 3 Grouping
      env.window.renderTab3();
      assert.strictEqual(env.elements.badgeGroupingFieldsCount.textContent, '1');

      // Add a field on Tab 1
      q.fields.push({ expression: 'Товары.Код', alias: 'Код' });

      // Click on Tab 3 button
      const tabBtnGrouping = env.tabButtons.find((b) => b.getAttribute('data-tab') === 'tab-grouping');
      assert.ok(tabBtnGrouping);
      tabBtnGrouping.click();

      // Badge and available fields should be updated to 2
      assert.strictEqual(env.elements.badgeGroupingFieldsCount.textContent, '2');
    });

    test('Finding 8: renaming table alias updates references in fields and joins', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [{ expression: 'Товары.Ссылка', alias: 'Ссылка' }];
      q.from = [{ source: { type: 'Table', name: 'Справочник.Товары' }, alias: 'Товары' }];
      q.whereConditions = [{ op: '', field: 'Товары.ПометкаУдаления', cmp: '=', value: 'ЛОЖЬ' }];

      env.window.renderFromTables();
      const inputAlias = env.elements.tbodyFromTables.querySelector('input[type="text"]');
      assert.ok(inputAlias);
      inputAlias.value = 'Т';
      inputAlias.dispatchEvent({ type: 'change' });

      assert.strictEqual(q.from[0].alias, 'Т');
      assert.strictEqual(env.window.getExpressionString(q.fields[0].expression), 'Т.Ссылка');
      assert.strictEqual(q.whereConditions[0].field, 'Т.ПометкаУдаления');
    });

    test('Finding 9: getTableAliasWithoutPrefix strips dots from virtual tables and tabular sections', () => {
      const env = createWebviewEnvironment();
      const strip = env.window.getTableAliasWithoutPrefix;

      assert.strictEqual(strip('РегистрНакопления.Продажи.Обороты'), 'ПродажиОбороты');
      assert.strictEqual(strip('Справочник.Номенклатура.Состав'), 'НоменклатураСостав');
      assert.strictEqual(strip('Документ.Заказ.Товары'), 'ЗаказТовары');
      assert.ok(!strip('РегистрНакопления.Продажи.Обороты').includes('.'), 'Alias must not contain dot');
    });

    test('Finding 10: formatSdblQuery combines multiple joins for same table with И', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [{ expression: 'A.Ссылка', alias: 'Ссылка' }];
      q.from = [
        {
          source: { type: 'Table', name: 'Справочник.A' },
          alias: 'A',
          joins: [
            {
              joinType: 'Left',
              source: { type: 'Table', name: 'Справочник.B' },
              alias: 'B',
              on: {
                type: 'BinaryOp',
                operator: '=',
                left: { type: 'CompoundIdentifier', parts: ['A', 'Ref'] },
                right: { type: 'CompoundIdentifier', parts: ['B', 'Ref'] },
              },
            },
            {
              joinType: 'Left',
              source: { type: 'Table', name: 'Справочник.B' },
              alias: 'B',
              on: {
                type: 'BinaryOp',
                operator: '=',
                left: { type: 'CompoundIdentifier', parts: ['A', 'Date'] },
                right: { type: 'CompoundIdentifier', parts: ['B', 'Date'] },
              },
            },
          ],
        },
      ];

      const formatted = env.window.formatSdblQuery(q);
      const joinOccurrences = (formatted.match(/ЛЕВОЕ СОЕДИНЕНИЕ/g) || []).length;
      assert.strictEqual(joinOccurrences, 1, 'Should produce only 1 JOIN clause');
      assert.ok(formatted.includes(' И '), 'Multiple join conditions must be grouped with И');
    });

    test('Finding 11: text tab parses ДЛЯ ИЗМЕНЕНИЯ and preserves forUpdate in AST and UI', () => {
      const env = createWebviewEnvironment();
      const parseSdbl = env.window.parseSdblClient;
      const query = 'ВЫБРАТЬ Т.Ссылка ИЗ Справочник.Товары КАК Т ДЛЯ ИЗМЕНЕНИЯ Т';
      const ast = parseSdbl(query);

      assert.strictEqual(ast.queries[0].forUpdate, true);
      assert.strictEqual(ast.queries[0].forUpdateTables?.[0], 'Т');
      assert.strictEqual(ast.queries[0].forUpdateTables?.length, 1);

      env.state.ast = ast;
      env.window.renderTab5();
      assert.strictEqual(env.elements.checkForUpdate.checked, true);
    });

    test('Finding 12 / Rereview 1: query type radios support canonical types (select, into, drop) without unsupported insert', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      // Switch to INTO (Create temp table)
      env.elements.radioTypeInto.checked = true;
      env.elements.radioTypeInto.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.type, 'Select');
      assert.strictEqual(q.into, 'ВТ_Данные');
      assert.strictEqual(env.elements.inputInto.disabled, false);

      // Switch to DROP (Drop temp table)
      env.elements.radioTypeDrop.checked = true;
      env.elements.radioTypeDrop.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.type, 'DropTable');
      assert.strictEqual(q.tableName, 'ВТ_Данные');
      assert.strictEqual(env.elements.inputInto.disabled, false);

      // Switch to SELECT (Standard query)
      env.elements.radioTypeSelect.checked = true;
      env.elements.radioTypeSelect.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.type, 'Select');
      assert.strictEqual(q.into, undefined);
      assert.strictEqual(q.tableName, undefined);
      assert.strictEqual(env.elements.inputInto.disabled, true);
    });

    test('Finding 13: switching to into or drop table deletes q.totals', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.totals = {
        fields: [{ expression: { type: 'Aggregate', aggregateType: 'Sum', expression: { type: 'Identifier', name: 'Сумма' } } }],
        by: [{ expression: { type: 'Identifier', name: 'Организация' } }],
      };

      env.elements.radioTypeInto.checked = true;
      env.elements.radioTypeInto.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.totals, undefined, 'Totals must be cleared when into is selected');

      q.totals = { by: [] };
      env.elements.radioTypeDrop.checked = true;
      env.elements.radioTypeDrop.dispatchEvent({ type: 'change' });
      assert.strictEqual(q.totals, undefined, 'Totals must be cleared when drop is selected');
    });

    test('Finding 16: addUnionQuery copies q.from and row click switches activeUnionIndex', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.from = [{ source: { type: 'Table', name: 'Справочник.Товары' }, alias: 'Товары' }];
      q.fields = [{ expression: 'Товары.Ссылка', alias: 'Ссылка' }];

      env.window.addUnionQuery('UnionAll');
      assert.strictEqual(q.unions.length, 1);
      assert.strictEqual(q.unions[0].statement.from.length, 1, 'Union branch must copy from sources');
      assert.strictEqual(q.unions[0].statement.from[0].source.name, 'Справочник.Товары');

      // Active query index is switched to union
      assert.strictEqual(env.state.activeUnionIndex, 1);
      const unionQ = env.window.getActiveQuery();
      assert.strictEqual(unionQ, q.unions[0].statement, 'getActiveQuery must return union statement');

      // Clicking main query row in unions list switches activeUnionIndex back to 0
      const mainRow = env.elements.tbodyUnionsList.children[0];
      assert.ok(mainRow);
      mainRow.dispatchEvent({ type: 'click' });
      assert.strictEqual(env.state.activeUnionIndex, 0);
      assert.strictEqual(env.window.getActiveQuery(), q);
    });

    test('Finding 1 (Review refinement): normalizeUnionColumns ensures positional alignment and equal column counts', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();

      // Case 1: Main has 1 col, Union has 2 cols
      q.fields = [{ expression: '1', alias: 'А' }];
      q.unions = [
        {
          unionType: 'UnionAll',
          name: 'Объединение 1',
          statement: {
            type: 'Select',
            fields: [
              { expression: '2', alias: 'Б' },
              { expression: '3', alias: 'В' },
            ],
            from: [],
          },
        },
      ];

      env.window.normalizeUnionColumns(q);

      // Main must be padded to 2 columns, Union retains 2 columns
      assert.strictEqual(q.fields.length, 2, 'Main query must have 2 columns');
      assert.strictEqual(q.unions[0].statement.fields.length, 2, 'Union query must have 2 columns');
      // Position 0: 1 КАК А and 2
      assert.strictEqual(env.window.getExpressionString(q.fields[0].expression), '1');
      assert.strictEqual(q.fields[0].alias, 'А');
      assert.strictEqual(env.window.getExpressionString(q.unions[0].statement.fields[0].expression), '2');
      // Position 1: NULL КАК В and 3
      assert.strictEqual(env.window.getExpressionString(q.fields[1].expression), 'NULL');
      assert.strictEqual(q.fields[1].alias, 'В');
      assert.strictEqual(env.window.getExpressionString(q.unions[0].statement.fields[1].expression), '3');

      // Case 2: Main has 2 cols, Union has 1 col
      const q2 = env.window.getActiveQuery();
      q2.fields = [
        { expression: '1', alias: 'А' },
        { expression: '2', alias: 'Б' },
      ];
      q2.unions = [
        {
          unionType: 'UnionAll',
          name: 'Объединение 1',
          statement: {
            type: 'Select',
            fields: [{ expression: '3', alias: 'В' }],
            from: [],
          },
        },
      ];

      env.window.normalizeUnionColumns(q2);
      assert.strictEqual(q2.fields.length, 2);
      assert.strictEqual(q2.unions[0].statement.fields.length, 2);
      assert.strictEqual(env.window.getExpressionString(q2.unions[0].statement.fields[0].expression), '3');
      assert.strictEqual(env.window.getExpressionString(q2.unions[0].statement.fields[1].expression), 'NULL');
    });

    test('Finding 1 (Review refinement): saving normalizes union columns and formats positional SDBL', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [{ expression: '1', alias: 'А' }];
      q.unions = [
        {
          unionType: 'UnionAll',
          name: 'Объединение 1',
          statement: {
            type: 'Select',
            fields: [
              { expression: '2', alias: 'Б' },
              { expression: '3', alias: 'В' },
            ],
            from: [],
          },
        },
      ];

      // Format query text directly
      const formatted = env.window.formatSdblQuery(q);
      assert.ok(formatted.includes('1 КАК А,\n\tNULL КАК В') || formatted.includes('1 КАК А,\r\n\tNULL КАК В'));
      assert.ok(formatted.includes('2 КАК Б,\n\t3 КАК В') || formatted.includes('2 КАК Б,\r\n\t3 КАК В'));

      // Click save button and verify sent message AST is normalized
      env.elements.btnSave.click();
      const saveMsg = env.sentMessages.find((m: any) => m.command === 'save');
      assert.ok(saveMsg, 'Save message must be sent');
      const savedAst = saveMsg.ast;
      assert.strictEqual(savedAst.queries[0].fields.length, 2);
      assert.strictEqual(savedAst.queries[0].unions[0].statement.fields.length, 2);
    });

    test('Rereview Finding 2: renaming table alias preserves string literals in conditions and expressions', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.from = [
        {
          source: { type: 'Table', name: 'Справочник.Т' },
          alias: 'Т',
        },
      ];
      q.fields = [
        {
          expression: 'Т.Ссылка',
          alias: 'Ссылка',
        },
      ];
      q.whereConditions = [
        {
          op: 'И',
          field: 'Т.Код',
          cmp: '=',
          value: '"Т.Код"',
        },
        {
          op: 'И',
          field: 'Т.Наименование',
          cmp: '=',
          value: '"Значение с ""Т.Код"" внутри"',
        },
      ];

      env.window.renameTableAliasInQuery(q, 'Т', 'Новое');

      assert.strictEqual(q.from[0].alias, 'Новое');
      assert.strictEqual(q.fields[0].expression, 'Новое.Ссылка');
      assert.strictEqual(q.whereConditions[0].field, 'Новое.Код');
      assert.strictEqual(q.whereConditions[0].value, '"Т.Код"', 'String literal must be preserved byte-for-byte');
      assert.strictEqual(q.whereConditions[1].field, 'Новое.Наименование');
      assert.strictEqual(q.whereConditions[1].value, '"Значение с ""Т.Код"" внутри"', 'Literal with escaped quotes must be preserved');
    });

    test('Rereview Finding 3: getTableFieldsFromMetadata prioritizes exact fullName/id over short name across different categories', () => {
      const env = createWebviewEnvironment();
      env.state.metadataTree = [
        {
          id: 'Catalog.Товары',
          name: 'Товары',
          fullName: 'Справочник.Товары',
          nodeType: 'table',
          children: [
            { id: 'Catalog.Товары.Ref', name: 'Ссылка', fullName: 'Ссылка', nodeType: 'field' },
            { id: 'Catalog.Товары.Code', name: 'Код', fullName: 'Код', nodeType: 'field' },
          ],
        },
        {
          id: 'Document.Товары',
          name: 'Товары',
          fullName: 'Документ.Товары',
          nodeType: 'table',
          children: [
            { id: 'Document.Товары.Date', name: 'Дата', fullName: 'Дата', nodeType: 'field' },
            { id: 'Document.Товары.Number', name: 'Номер', fullName: 'Номер', nodeType: 'field' },
          ],
        },
      ];

      // Query Document.Товары with alias Товары
      const docFields = env.window.getTableFieldsFromMetadata('Товары', 'Документ.Товары');
      assert.deepStrictEqual([...docFields], ['Дата', 'Номер'], 'Must return fields of Document.Товары, not Catalog.Товары');

      // Query Catalog.Товары with alias Товары
      const catFields = env.window.getTableFieldsFromMetadata('Товары', 'Справочник.Товары');
      assert.deepStrictEqual([...catFields], ['Ссылка', 'Код'], 'Must return fields of Catalog.Товары');
    });

    test('Rereview Finding 4: UI formatSdblQuery preserves parentheses around OR in combined JOIN conditions', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.from = [
        {
          source: { type: 'Table', name: 'Справочник.А' },
          alias: 'А',
          joins: [
            {
              joinType: 'Left',
              source: { type: 'Table', name: 'Справочник.Б' },
              alias: 'Б',
              on: 'А.Код = Б.Код ИЛИ А.Ссылка = Б.Ссылка',
            },
            {
              joinType: 'Left',
              source: { type: 'Table', name: 'Справочник.Б' },
              alias: 'Б',
              on: 'Б.Активен = ИСТИНА',
            },
          ],
        },
      ];
      q.fields = [{ expression: 'А.Код', alias: 'Код' }];

      const formatted = env.window.formatSdblQuery(q);
      assert.ok(
        formatted.includes('ПО (А.Код = Б.Код ИЛИ А.Ссылка = Б.Ссылка) И Б.Активен = ИСТИНА'),
        `Formatted text should wrap OR in parens: ${formatted}`
      );
    });

    test('Rereview 6dee115 P2: renaming table alias updates references inside CASE WHEN / ВЫБОР ... КОНЕЦ and composite nodes', () => {
      const initialSdbl = [
        'ВЫБРАТЬ',
        '\tВЫБОР КОГДА Т.Код = "1" ТОГДА Т.Ссылка ИНАЧЕ NULL КОНЕЦ КАК Значение',
        'ИЗ',
        '\tСправочник.Т КАК Т',
      ].join('\n');

      const parsedPkg = parseSdbl(initialSdbl);
      const env = createWebviewEnvironment();

      // 1. Simulate extension host init message
      env.postMessageToWebview({
        command: 'init',
        ast: parsedPkg,
        metadata: [],
        mode: 'simple',
      });

      // 2. Locate alias input on Tab 1 and change 'Т' -> 'Новое'
      const tbodyFrom = env.elements.tbodyFromTables;
      assert.ok(tbodyFrom, 'tbodyFromTables must exist');
      const inputAlias = tbodyFrom.querySelector('input[type="text"]');
      assert.ok(inputAlias, 'input for alias must exist');
      assert.strictEqual(inputAlias.value, 'Т');

      inputAlias.value = 'Новое';
      inputAlias.dispatchEvent({ type: 'change' });

      // 3. Save query
      env.elements.btnSave.click();

      // 4. Capture save message and format with backend formatSdbl
      const saveMsg = env.sentMessages.find((m: any) => m.command === 'save');
      assert.ok(saveMsg, 'save command must be sent');
      assert.ok(saveMsg.ast, 'save message must contain ast');

      const formatted = formatSdbl(saveMsg.ast);

      // 5. Verification:
      // References inside CASE WHEN must be updated to Новое
      assert.ok(formatted.includes('Новое.Код'), `Formatted SDBL should contain Новое.Код: ${formatted}`);
      assert.ok(formatted.includes('Новое.Ссылка'), `Formatted SDBL should contain Новое.Ссылка: ${formatted}`);
      assert.ok(!formatted.includes('Т.Код'), `Formatted SDBL should NOT contain old Т.Код: ${formatted}`);
      assert.ok(!formatted.includes('Т.Ссылка'), `Formatted SDBL should NOT contain old Т.Ссылка: ${formatted}`);
      // Literals "1" and NULL must remain untouched
      assert.ok(formatted.includes('"1"'), `Literal "1" must be preserved: ${formatted}`);
      assert.ok(formatted.includes('NULL'), `Literal NULL must be preserved: ${formatted}`);
      // FROM clause must have new alias
      assert.ok(formatted.includes('Справочник.Т КАК Новое'), `FROM must have new alias: ${formatted}`);
    });

    test('Rereview 6dee115: renaming table alias updates references inside In, Between, Like, and FunctionCall expressions', () => {
      const initialSdbl = [
        'ВЫБРАТЬ',
        '\tПОДСТРОКА(Т.Наименование, 1, 10) КАК Подстрока,',
        '\tВЫБОР КОГДА Т.Статус В (&Список) И Т.Сумма МЕЖДУ 100 И 500 ТОГДА Т.ПометкаУдаления ИНАЧЕ ЛОЖЬ КОНЕЦ КАК Флаг',
        'ИЗ',
        '\tСправочник.Т КАК Т',
      ].join('\n');

      const parsedPkg = parseSdbl(initialSdbl);
      const env = createWebviewEnvironment();

      env.postMessageToWebview({
        command: 'init',
        ast: parsedPkg,
        metadata: [],
        mode: 'simple',
      });

      const inputAlias = env.elements.tbodyFromTables.querySelector('input[type="text"]');
      assert.ok(inputAlias);
      inputAlias.value = 'Новое';
      inputAlias.dispatchEvent({ type: 'change' });

      env.elements.btnSave.click();
      const saveMsg = env.sentMessages.find((m: any) => m.command === 'save');
      assert.ok(saveMsg);

      const formatted = formatSdbl(saveMsg.ast);
      assert.ok(formatted.includes('ПОДСТРОКА(Новое.Наименование, 1, 10)'), `Expected function call updated: ${formatted}`);
      assert.ok(formatted.includes('Новое.Статус В (&Список)'), `Expected In expr updated: ${formatted}`);
      assert.ok(formatted.includes('Новое.Сумма МЕЖДУ 100 И 500'), `Expected Between expr updated: ${formatted}`);
      assert.ok(formatted.includes('ТОГДА Новое.ПометкаУдаления'), `Expected then expr updated: ${formatted}`);
      assert.ok(!formatted.includes('Т.Наименование'));
      assert.ok(!formatted.includes('Т.Статус'));
      assert.ok(!formatted.includes('Т.Сумма'));
      assert.ok(!formatted.includes('Т.ПометкаУдаления'));
    });
  });
});
