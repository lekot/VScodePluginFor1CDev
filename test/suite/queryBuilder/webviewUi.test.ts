import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseSdbl } from '../../../src/queryBuilder/sdbl/sdblParser';
import { formatSdbl } from '../../../src/queryBuilder/sdbl/sdblFormatter';

suite('Query Builder Webview UI & Two-Panel Index Selector', () => {
  const rootDir = path.resolve(__dirname, '../../../..');
  const sourceHtmlPath = path.join(rootDir, 'src/queryBuilder/ui/queryBuilderWebview.html');
  const distHtmlPath = path.join(rootDir, 'dist/queryBuilder/ui/queryBuilderWebview.html');
  const outHtmlPath = path.join(rootDir, 'out/src/queryBuilder/ui/queryBuilderWebview.html');
  const copyScriptPath = path.join(rootDir, 'scripts/copy-webviews.js');

  test('1. File existence and copy verification', () => {
    assert.strictEqual(fs.existsSync(sourceHtmlPath), true, 'Source queryBuilderWebview.html must exist');
    assert.strictEqual(fs.existsSync(distHtmlPath), true, 'dist queryBuilderWebview.html must exist');
    assert.strictEqual(fs.existsSync(outHtmlPath), true, 'out/src queryBuilderWebview.html must exist');

    const copyScriptContent = fs.readFileSync(copyScriptPath, 'utf-8');
    assert.strictEqual(
      copyScriptContent.includes('src/queryBuilder/ui/queryBuilderWebview.html'),
      true,
      'copy-webviews.js must include src/queryBuilder/ui/queryBuilderWebview.html'
    );
  });

  test('2. HTML layout and theme variables', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    // CSP and Vanilla JS/CSS
    assert.strictEqual(html.includes("Content-Security-Policy"), true, 'Must include CSP header');
    assert.strictEqual(html.includes("var(--vscode-editor-background"), true, 'Must use VS Code editor background');
    assert.strictEqual(html.includes("var(--vscode-button-background"), true, 'Must use VS Code button background');
    assert.strictEqual(html.includes("var(--vscode-input-background"), true, 'Must use VS Code input background');
    assert.strictEqual(html.includes("var(--vscode-panel-border"), true, 'Must use VS Code panel border');
  });

  test('3. Header, Toolbar, and Package query controls', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('id="mode-badge"'), true, 'Must have mode badge');
    assert.strictEqual(html.includes('id="package-query-select"'), true, 'Must have package query select dropdown');
    assert.strictEqual(html.includes('id="btn-add-query"'), true, 'Must have + Запрос button');
    assert.strictEqual(html.includes('id="btn-remove-query"'), true, 'Must have - Удалить button');
    assert.strictEqual(html.includes('id="btn-move-query-up"'), true, 'Must have move query up button');
    assert.strictEqual(html.includes('id="btn-move-query-down"'), true, 'Must have move query down button');
    assert.strictEqual(html.includes('id="btn-format-text"'), true, 'Must have format text button');
    assert.strictEqual(html.includes('id="btn-save"'), true, 'Must have save (OK) button');
    assert.strictEqual(html.includes('id="btn-cancel"'), true, 'Must have cancel button');
  });

  test('4. All 11 tabs present', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    const expectedTabs = [
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
      'tab-query-text'
    ];

    expectedTabs.forEach((tabId) => {
      assert.strictEqual(
        html.includes(`data-tab="${tabId}"`),
        true,
        `Tab button for ${tabId} must be present`
      );
      assert.strictEqual(
        html.includes(`id="${tabId}"`),
        true,
        `Tab pane for ${tabId} must be present`
      );
    });
  });

  test('5. Tab 1: Tables and fields (3-column layout, metadata tree, FROM tables, SELECT fields)', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('id="metadata-search"'), true, 'Must have metadata search input');
    assert.strictEqual(html.includes('id="metadata-tree"'), true, 'Must have metadata tree container');
    assert.strictEqual(html.includes('id="table-from-tables"'), true, 'Must have FROM tables table');
    assert.strictEqual(html.includes('id="table-selected-fields"'), true, 'Must have SELECT fields table');
    assert.strictEqual(html.includes('id="btn-add-custom-table"'), true, 'Must have add table button');
    assert.strictEqual(html.includes('id="btn-add-field"'), true, 'Must have add field button');
  });

  test('6. Tab 2: Joins (Inner, Left, Right, Full and ON condition)', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('id="table-joins"'), true, 'Must have joins table');
    assert.strictEqual(html.includes('id="btn-add-join"'), true, 'Must have add join button');
    assert.strictEqual(html.includes('Внутреннее (INNER)'), true, 'Must support Inner join');
    assert.strictEqual(html.includes('Левое (LEFT)'), true, 'Must support Left join');
    assert.strictEqual(html.includes('Правое (RIGHT)'), true, 'Must support Right join');
    assert.strictEqual(html.includes('Полное (FULL)'), true, 'Must support Full join');
  });

  test('7. Tab 3: Grouping and Aggregates', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('id="table-groupby"'), true, 'Must have GROUP BY table');
    assert.strictEqual(html.includes('id="table-aggregates"'), true, 'Must have aggregates table');
    assert.strictEqual(html.includes('id="btn-populate-groupby"'), true, 'Must have populate groupby button');
    assert.strictEqual(html.includes('id="btn-add-groupby"'), true, 'Must have add groupby button');
    assert.strictEqual(html.includes('id="btn-add-aggregate"'), true, 'Must have add aggregate button');
  });

  test('8. Tab 4: Conditions with routing (WHERE / HAVING)', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('id="table-conditions"'), true, 'Must have conditions table');
    assert.strictEqual(html.includes('id="btn-add-condition"'), true, 'Must have add condition button');
    assert.strictEqual(html.includes('badge-route'), true, 'Must have route badge style');
    assert.strictEqual(html.includes('В ИЕРАРХИИ'), true, 'Must include hierarchy operator');
    assert.strictEqual(html.includes('ЕСТЬ NULL'), true, 'Must include IS NULL operator');
  });

  test('9. Tab 5: Extra options (TOP, ALLOWED, DISTINCT, FOR UPDATE, AUTOORDER, INTO)', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('id="input-top"'), true, 'Must have TOP number input');
    assert.strictEqual(html.includes('id="check-allowed"'), true, 'Must have ALLOWED checkbox');
    assert.strictEqual(html.includes('id="check-distinct"'), true, 'Must have DISTINCT checkbox');
    assert.strictEqual(html.includes('id="check-for-update"'), true, 'Must have FOR UPDATE checkbox');
    assert.strictEqual(html.includes('id="check-auto-order"'), true, 'Must have AUTOORDER checkbox');
    assert.strictEqual(html.includes('id="input-into"'), true, 'Must have INTO temp table name input');
  });

  test('10. Tab 8: Two-Panel Index Selector (Left/Right panels, buttons, dblclick, drag-and-drop)', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('id="index-available-list"'), true, 'Must have available fields list');
    assert.strictEqual(html.includes('id="index-selected-list"'), true, 'Must have selected/indexed fields list');
    assert.strictEqual(html.includes('id="btn-index-add"'), true, 'Must have > button');
    assert.strictEqual(html.includes('id="btn-index-add-all"'), true, 'Must have >> button');
    assert.strictEqual(html.includes('id="btn-index-remove"'), true, 'Must have < button');
    assert.strictEqual(html.includes('id="btn-index-remove-all"'), true, 'Must have << button');

    // Drag-and-drop and dblclick logic in script
    assert.strictEqual(html.includes('dragstart'), true, 'Must support dragstart');
    assert.strictEqual(html.includes('dragover'), true, 'Must support dragover');
    assert.strictEqual(html.includes('drop'), true, 'Must support drop event');
    assert.strictEqual(html.includes('dblclick'), true, 'Must support dblclick event');
  });

  test('11. Tab 9: Totals (OVERALL, aggregates, hierarchy, periods)', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('id="check-totals-overall"'), true, 'Must have overall totals checkbox');
    assert.strictEqual(html.includes('id="table-totals-fields"'), true, 'Must have totals fields table');
    assert.strictEqual(html.includes('id="table-totals-groups"'), true, 'Must have totals groups table');
  });

  test('12. Tab 10: Package Queries Table', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('id="table-package-queries"'), true, 'Must have package queries table');
    assert.strictEqual(html.includes('id="btn-pkg-add-select"'), true, 'Must have add SELECT button');
    assert.strictEqual(html.includes('id="btn-pkg-add-drop"'), true, 'Must have add DROP button');
  });

  test('13. Tab 11: Text Editor and Two-way Synchronization', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('id="sdbl-text-editor"'), true, 'Must have SDBL text editor');
    assert.strictEqual(html.includes('id="btn-apply-text"'), true, 'Must have apply text button');
    assert.strictEqual(html.includes('parseSdblClient'), true, 'Must have client-side parser');
    assert.strictEqual(html.includes('formatPackageSdbl'), true, 'Must have client-side formatter');
  });

  test('14. Virtual Table Parameters Modal Dialog', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('id="modal-vt-params"'), true, 'Must have virtual table params modal');
    assert.strictEqual(html.includes('id="modal-vt-title"'), true, 'Must have modal title');
    assert.strictEqual(html.includes('id="tbody-vt-params"'), true, 'Must have modal params tbody');
    assert.strictEqual(html.includes('id="btn-modal-save"'), true, 'Must have modal save button');
    assert.strictEqual(html.includes('id="btn-modal-cancel"'), true, 'Must have modal cancel button');
  });

  test('15. Webview Messaging Protocol', () => {
    const html = fs.readFileSync(sourceHtmlPath, 'utf-8');

    assert.strictEqual(html.includes('acquireVsCodeApi'), true, 'Must acquire VS Code API');
    assert.strictEqual(html.includes("command: 'ready'"), true, 'Must send ready message');
    assert.strictEqual(html.includes("command: 'save'"), true, 'Must send save message');
    assert.strictEqual(html.includes("command: 'cancel'"), true, 'Must send cancel message');
    assert.strictEqual(html.includes("command: 'updateAst'"), true, 'Must send updateAst message');
    assert.strictEqual(html.includes("case 'init':"), true, 'Must handle init message');
    assert.strictEqual(html.includes("case 'updateMetadata':"), true, 'Must handle updateMetadata message');
  });

  suite('Webview UI Runtime VM Tests (P1.1, P1.2, P2.12-P2.17)', () => {
    const htmlSource = fs.readFileSync(sourceHtmlPath, 'utf-8');
    const scriptMatch = htmlSource.match(/<script\b[^>]*>([\s\S]*?)<\/script[^>]*>/i);
    assert.ok(scriptMatch, 'Script tag must exist in HTML');
    const scriptCode = scriptMatch[1];

    class MockElement {
      public tagName: string;
      public children: MockElement[] = [];
      public parentElement: MockElement | null = null;
      public _listeners: { [event: string]: ((e: any) => void)[] } = {};
      public style: { [key: string]: string } = {};
      public _classes: Set<string> = new Set();
      public value: string = '';
      public checked: boolean = false;
      public disabled: boolean = false;
      public type: string = 'text';
      public placeholder: string = '';
      public title: string = '';
      public draggable: boolean = false;
      private _innerHTML: string = '';
      private _textContent: string = '';
      private _attrs: { [k: string]: string } = {};

      constructor(tag: string = 'div') {
        this.tagName = tag.toUpperCase();
      }

      get innerHTML(): string {
        return this._innerHTML;
      }
      set innerHTML(val: string) {
        this._innerHTML = val;
        this.children = [];
      }

      get textContent(): string {
        if (this._textContent) return this._textContent;
        if (this.children.length > 0) {
          return this.children.map((c) => c.textContent).join('');
        }
        return '';
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
        return this._attrs[k] || null;
      }

      public selectionStart: number = 0;
      public selectionEnd: number = 0;
      setSelectionRange(start: number, end: number) {
        this.selectionStart = start;
        this.selectionEnd = end;
      }

      querySelectorAll(sel: string): MockElement[] {
        const res: MockElement[] = [];
        const search = (node: MockElement) => {
          for (const c of node.children) {
            let matched = false;
            if (sel === 'input[type="checkbox"]') {
              if (c.tagName === 'INPUT' && (c as any).type === 'checkbox') matched = true;
            } else if (sel === 'button.danger') {
              if (c.tagName === 'BUTTON' && c.className.includes('danger')) matched = true;
            } else if (sel === 'input' && c.tagName === 'INPUT') {
              matched = true;
            } else if (sel === 'select' && c.tagName === 'SELECT') {
              matched = true;
            } else if (sel === 'button' && c.tagName === 'BUTTON') {
              matched = true;
            } else if (sel === 'tr' && c.tagName === 'TR') {
              matched = true;
            } else if (sel.startsWith('.')) {
              if (c.className.includes(sel.substring(1))) matched = true;
            } else {
              const attrMatch = sel.match(/^([a-zA-Z0-9_\-\.]*)\[([a-zA-Z0-9_\-]+)=(?:'|")?([^'"]+)(?:'|")?\]$/);
              if (attrMatch) {
                const baseSel = attrMatch[1];
                const attrName = attrMatch[2];
                const attrVal = attrMatch[3];
                let baseOk = true;
                if (baseSel.startsWith('.')) baseOk = c.className.includes(baseSel.substring(1));
                else if (baseSel) baseOk = c.tagName === baseSel.toUpperCase();
                const actualAttr = c.getAttribute(attrName) || (c as any)[attrName];
                if (baseOk && actualAttr === attrVal) matched = true;
              } else if (c.tagName === sel.toUpperCase()) {
                matched = true;
              }
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
      tabButtons: any[];
      sentMessages: any[];
      postMessageToWebview: (msg: any) => void;
    }

    function createWebviewEnvironment(): WebviewSandbox {
      const vm = require('vm');
      const elementsById: { [id: string]: MockElement } = {};
      const getOrCreateElement = (id: string) => {
        if (!elementsById[id]) {
          elementsById[id] = new MockElement();
          elementsById[id].setAttribute('id', id);
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
      // first tab is active
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
          for (const k of Object.keys(elementsById)) {
            const found = elementsById[k].querySelector(sel);
            if (found) return found;
          }
          return null;
        },
        querySelectorAll: (sel: string) => {
          if (sel === '.tab-btn') return tabButtons;
          if (sel === '.tab-pane') return tabPanes;
          const res: MockElement[] = [];
          for (const k of Object.keys(elementsById)) {
            res.push(...elementsById[k].querySelectorAll(sel));
          }
          return res;
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

    test('P1.1: parseSdblClient parses Russian SELECT, FROM, fields and aliases', () => {
      const env = createWebviewEnvironment();
      const parseSdbl = env.window.parseSdblClient;
      assert.strictEqual(typeof parseSdbl, 'function', 'parseSdblClient must be exposed on window');

      const query = 'ВЫБРАТЬ Поле1, Поле2 КАК Алиас ИЗ Справочник.Номенклатура КАК Ном';
      const ast = parseSdbl(query);

      assert.ok(ast, 'AST must be returned');
      assert.strictEqual(ast.queries.length, 1, 'Must have 1 query');
      const sel = ast.queries[0];
      assert.strictEqual(sel.type, 'Select');
      assert.strictEqual(sel.fields.length, 2, 'Must parse 2 fields');
      assert.strictEqual(sel.fields[0].expression, 'Поле1');
      assert.strictEqual(sel.fields[1].expression, 'Поле2');
      assert.strictEqual(sel.fields[1].alias, 'Алиас');

      assert.strictEqual(sel.from.length, 1, 'Must parse 1 from table');
      assert.strictEqual(sel.from[0].source.name, 'Справочник.Номенклатура');
      assert.strictEqual(sel.from[0].alias, 'Ном');
    });

    test('P1.1: parseSdblClient parses query with ОБЪЕДИНИТЬ ВСЕ', () => {
      const env = createWebviewEnvironment();
      const parseSdbl = env.window.parseSdblClient;

      const query = 'ВЫБРАТЬ Поле1 ИЗ Таблица1 ОБЪЕДИНИТЬ ВСЕ ВЫБРАТЬ Поле1 ИЗ Таблица2';
      const ast = parseSdbl(query);

      assert.ok(ast);
      assert.strictEqual(ast.queries.length, 1);
      const sel = ast.queries[0];
      assert.strictEqual(sel.fields[0].expression, 'Поле1');
      assert.ok(sel.unions && sel.unions.length === 1, 'Must have 1 union');
      assert.strictEqual(sel.unions[0].unionType, 'UnionAll');
      assert.strictEqual(sel.unions[0].statement.fields[0].expression, 'Поле1');
    });

    test('P1.1: invalid syntax throws error and does not wipe AST', () => {
      const env = createWebviewEnvironment();
      const parseSdbl = env.window.parseSdblClient;

      assert.throws(() => {
        parseSdbl('НЕВАЛИДНЫЙ ТЕКСТ БЕЗ ВЫБРАТЬ');
      }, /ВЫБРАТЬ|SELECT/);
    });

    test('P1.2: adding conditions in UI generates correct where / having in AST', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.from = [{ source: { type: 'Table', name: 'Справочник.Номенклатура' } }];
      q.fields = [{ expression: 'Наименование' }];

      q.whereConditions = [
        { op: 'И', field: 'Склад', cmp: '=', value: '&Склад' }
      ];
      q.havingConditions = [
        { op: 'И', field: 'СУММА(Количество)', cmp: '>', value: '10' }
      ];

      env.window.syncConditionsToAst(q);

      assert.ok(q.where, 'q.where must be generated in AST');
      assert.strictEqual(q.where.type, 'BinaryOp');
      assert.strictEqual(q.where.operator, '=');
      assert.strictEqual(env.window.getExpressionString(q.where.left), 'Склад');
      assert.strictEqual(env.window.getExpressionString(q.where.right), '&Склад');

      assert.ok(q.having, 'q.having must be generated in AST');
      assert.strictEqual(q.having.type, 'BinaryOp');
      assert.strictEqual(q.having.operator, '>');
    });

    test('P1.2: opening AST with where: BinaryOp unfolds conditions into UI rows', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.whereConditions = [];
      q.where = {
        type: 'BinaryOp',
        operator: '=',
        left: { type: 'Identifier', name: 'Склад' },
        right: { type: 'Parameter', name: 'Склад' },
      };

      env.window.renderTab4();

      const rows = env.elements.tbodyConditions.children;
      assert.strictEqual(rows.length, 1, 'Should unfold 1 condition row');
      const inputs = rows[0].querySelectorAll('input');
      assert.strictEqual(inputs[0].value, 'Склад', 'Field input should be Склад');
      assert.strictEqual(inputs[1].value, '&Склад', 'Value input should be &Склад');
    });

    test('P2.12: getExpressionString for FunctionCallNode, BinaryOpNode, CaseWhenNode, AggregateNode', () => {
      const env = createWebviewEnvironment();
      const getExpr = env.window.getExpressionString;

      // FunctionCall
      const fnExpress = {
        type: 'FunctionCall',
        name: 'ВЫРАЗИТЬ',
        args: [
          { type: 'Identifier', name: 'Поле' },
          { type: 'Identifier', name: 'Число' },
        ],
      };
      assert.strictEqual(getExpr(fnExpress), 'ВЫРАЗИТЬ(Поле КАК Число)');

      const fnNull = {
        type: 'FunctionCall',
        name: 'ЕСТЬNULL',
        args: [
          { type: 'Identifier', name: 'Поле' },
          { type: 'Literal', valueType: 'number', value: 0, raw: '0' },
        ],
      };
      assert.strictEqual(getExpr(fnNull), 'ЕСТЬNULL(Поле, 0)');

      // Aggregate
      const aggSum = {
        type: 'Aggregate',
        aggregateType: 'Sum',
        expression: { type: 'Identifier', name: 'Поле' },
      };
      assert.strictEqual(getExpr(aggSum), 'СУММА(Поле)');

      const aggCountDist = {
        type: 'Aggregate',
        aggregateType: 'Count',
        distinct: true,
        expression: { type: 'Identifier', name: 'Поле' },
      };
      assert.strictEqual(getExpr(aggCountDist), 'КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Поле)');

      // BinaryOp
      const binOp = {
        type: 'BinaryOp',
        operator: '=',
        left: { type: 'Identifier', name: 'Поле' },
        right: { type: 'Literal', valueType: 'number', value: 1, raw: '1' },
      };
      assert.strictEqual(getExpr(binOp), 'Поле = 1');

      // CaseWhen
      const caseWhen = {
        type: 'CaseWhen',
        cases: [
          {
            when: {
              type: 'BinaryOp',
              operator: '=',
              left: { type: 'Identifier', name: 'A' },
              right: { type: 'Literal', valueType: 'number', value: 1, raw: '1' },
            },
            then: { type: 'Literal', valueType: 'number', value: 10, raw: '10' },
          },
        ],
        else: { type: 'Literal', valueType: 'number', value: 0, raw: '0' },
      };
      assert.strictEqual(getExpr(caseWhen), 'ВЫБОР КОГДА A = 1 ТОГДА 10 ИНАЧЕ 0 КОНЕЦ');
    });

    test('P2.13: formatQueryText preserves unapplied textarea edits and handles errors', () => {
      const env = createWebviewEnvironment();
      env.elements.sdblTextEditor.value = 'ВЫБРАТЬ Поле1 ИЗ Таблица1';

      env.window.formatQueryText();
      assert.ok(env.elements.sdblTextEditor.value.includes('ВЫБРАТЬ'), 'Formatted text must be present');
      assert.strictEqual(env.elements.textParseError.style.display, 'none');

      // Now enter invalid text
      env.elements.sdblTextEditor.value = 'НЕВАЛИДНЫЙ ТЕКСТ ЗАПРОСА';
      env.window.formatQueryText();
      assert.strictEqual(
        env.elements.sdblTextEditor.value,
        'НЕВАЛИДНЫЙ ТЕКСТ ЗАПРОСА',
        'Must NOT erase or overwrite user text on error'
      );
      assert.strictEqual(env.elements.textParseError.style.display, 'flex');
    });

    test('P2.14: virtual table parameters preserve empty first argument (, &Условие)', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.from = [
        {
          source: {
            type: 'Table',
            name: 'РегистрНакопления.Остатки.Остатки',
            isVirtual: true,
          },
        },
      ];

      env.window.openVirtualTableParamsModal(0);
      const inputs = env.elements.tbodyVtParams.querySelectorAll('input');
      assert.ok(inputs.length >= 2, 'Should have inputs for parameters');

      // Empty first param, set second param
      inputs[0].value = '';
      inputs[1].value = '&Условие';

      env.window.saveVirtualTableParamsModal();

      const params = q.from[0].source.params;
      assert.ok(params && params.length >= 2, 'Must retain empty positional slots up to last param');
      assert.strictEqual(params[0].raw, '', 'First param slot must be empty string');
      assert.strictEqual(params[1].raw, '&Условие', 'Second param must be &Условие');

      const formatted = env.window.formatSdblQuery(q);
      assert.ok(formatted.includes('Остатки(, &Условие)'), `Expected Остатки(, &Условие), got ${formatted}`);
    });

    test('P2.16: field renaming and deletion synchronizes indexBy', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [
        { expression: 'Ссылка', alias: 'ДокСсылка' },
        { expression: 'Сумма', alias: 'СуммаДокумента' },
      ];
      q.indexBy = ['ДокСсылка', 'СуммаДокумента'];

      env.window.renderSelectedFields();
      env.window.renderTab8();

      // Rename alias of first field
      const fieldRows = env.elements.tbodySelectedFields.children;
      const aliasInput0 = fieldRows[0].querySelectorAll('input')[1];
      aliasInput0.value = 'НоваяСсылка';
      aliasInput0.dispatchEvent({ type: 'change', target: aliasInput0 });

      assert.deepStrictEqual(q.indexBy, ['НоваяСсылка', 'СуммаДокумента'], 'indexBy must reflect renamed alias');

      // Delete the second field
      const delBtn1 = fieldRows[1].querySelector('button.danger');
      assert.ok(delBtn1, 'Delete button must exist');
      delBtn1.click();

      assert.deepStrictEqual(q.indexBy, ['НоваяСсылка'], 'Deleted field must be removed from indexBy');
    });

    test('P2.15: aggregate function dropdown and distinct checkbox update AST', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [
        {
          expression: {
            type: 'Aggregate',
            aggregateType: 'Sum',
            distinct: false,
            expression: { type: 'Identifier', name: 'Количество' },
          },
          alias: 'Количество',
        },
      ];

      env.window.renderTab3();

      const aggRows = env.elements.tbodyAggregates.children;
      assert.strictEqual(aggRows.length, 1);

      const selFn = aggRows[0].querySelector('select');
      assert.ok(selFn, 'Function select must exist');
      selFn.value = 'КОЛИЧЕСТВО';
      selFn.dispatchEvent({ type: 'change', target: selFn });

      const expr = q.fields[0].expression;
      assert.strictEqual(expr.aggregateType, 'Count', 'Aggregate type should be updated to Count in AST');

      const chDist = aggRows[0].querySelector('input[type="checkbox"]');
      assert.ok(chDist, 'Distinct checkbox must exist');
      chDist.checked = true;
      chDist.dispatchEvent({ type: 'change', target: chDist });

      assert.strictEqual(expr.distinct, true, 'Distinct should be true in AST');
    });

    test('P2.17: join editor preserves source table name and removes join from any from clause', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.from = [
        {
          source: { type: 'Table', name: 'Справочник.Номенклатура' },
          alias: 'Ном',
          joins: [],
        },
        {
          source: { type: 'Table', name: 'РегистрНакопления.Остатки' },
          alias: 'Ост',
          joins: [
            {
              joinType: 'Left',
              source: { type: 'Table', name: 'Справочник.Склады' },
              alias: 'Скл',
              on: { type: 'RawExpression', raw: 'Ост.Склад = Скл.Ссылка' },
            },
          ],
        },
      ];

      env.window.renderTab2();

      const joinRows = env.elements.tbodyJoins.children;
      assert.strictEqual(joinRows.length, 1, 'Should display 1 join');

      // Delete this join which is in q.from[1]
      const delBtn = joinRows[0].querySelector('button.danger');
      assert.ok(delBtn);
      delBtn.click();

      assert.strictEqual(q.from[1].joins.length, 0, 'Join must be removed from q.from[1]');
    });

    test('R1: query without totals does not create phantom empty totals upon render or save', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [{ expression: { type: 'Identifier', name: 'Поле1' }, alias: 'Поле1' }];
      q.from = [{ source: { type: 'Table', name: 'Справочник.Номенклатура' } }];
      delete q.totals;

      env.window.renderTab9();
      assert.strictEqual(q.totals, undefined, 'renderTab9 must not initialize empty q.totals');

      env.elements.btnSave.click();
      const saveMsg = env.sentMessages.find((m: any) => m.command === 'save');
      assert.ok(saveMsg, 'Save message must be sent');
      assert.strictEqual(saveMsg.ast.queries[0].totals, undefined, 'Saved query must not have phantom totals');
    });

    test('R2: opening query with aggregate totals executes without ReferenceError', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [{ expression: { type: 'Identifier', name: 'Количество' }, alias: 'Количество' }];
      q.from = [{ source: { type: 'Table', name: 'Таблица' } }];
      q.totals = {
        fields: [
          {
            expression: {
              type: 'Aggregate',
              aggregateType: 'Sum',
              expression: { type: 'Identifier', name: 'Количество' },
            },
          },
        ],
        by: [{ expression: { type: 'Identifier', name: 'Период' } }],
        overall: true,
      };

      assert.doesNotThrow(() => {
        env.window.renderTab9();
      });
    });

    test('R3: preserves parenthesis grouping across round-trip in conditions editor', () => {
      const env = createWebviewEnvironment();
      const tree = {
        type: 'BinaryOp',
        operator: 'И',
        left: {
          type: 'BinaryOp',
          operator: '=',
          left: { type: 'Identifier', name: 'A' },
          right: { type: 'Literal', value: 1, raw: '1' },
        },
        right: {
          type: 'BinaryOp',
          operator: 'ИЛИ',
          left: {
            type: 'BinaryOp',
            operator: '=',
            left: { type: 'Identifier', name: 'B' },
            right: { type: 'Literal', value: 2, raw: '2' },
          },
          right: {
            type: 'BinaryOp',
            operator: '=',
            left: { type: 'Identifier', name: 'C' },
            right: { type: 'Literal', value: 3, raw: '3' },
          },
        },
      };

      const condList = env.window.flattenConditionNode(tree);
      assert.strictEqual(condList.length, 3);
      assert.strictEqual(condList[1].openParen, '(');
      assert.strictEqual(condList[2].closeParen, ')');

      const reconstructed = env.window.conditionsToTree(condList);
      assert.ok(reconstructed, 'Reconstructed tree must exist');
      assert.strictEqual(reconstructed.operator, 'AND');
      assert.strictEqual(reconstructed.right.operator, 'OR');
    });

    test('R4: text tab parses and preserves SELECT *', () => {
      const env = createWebviewEnvironment();
      const text = 'ВЫБРАТЬ * ИЗ Справочник.Номенклатура КАК Ном';
      const pkg = env.window.parseSdblClient(text);
      const parsed = pkg.queries[0];
      assert.strictEqual(parsed.fields.length, 1);
      assert.strictEqual(parsed.fields[0].raw, '*');

      const formatted = env.window.formatSdblQuery(parsed);
      assert.ok(formatted.includes('ВЫБРАТЬ\n\t*'));
    });

    test('R5: text tab preserves field expression in ORDER BY', () => {
      const env = createWebviewEnvironment();
      const text = 'ВЫБРАТЬ Поле1 ИЗ Таблица УПОРЯДОЧИТЬ ПО Таблица.Поле1 УБЫВ';
      const pkg = env.window.parseSdblClient(text);
      const parsed = pkg.queries[0];
      assert.strictEqual(parsed.orderBy.length, 1);
      assert.strictEqual(parsed.orderBy[0].direction, 'Desc');

      const formatted = env.window.formatSdblQuery(parsed);
      assert.ok(formatted.includes('Таблица.Поле1 УБЫВ'));
    });

    test('R12: text tab parses and formats PERIODS arguments in TOTALS', () => {
      const env = createWebviewEnvironment();
      const text = 'ВЫБРАТЬ Поле1 ИЗ Таблица ИТОГИ СУММА(Поле1) ПО Период ПЕРИОДАМИ(ДЕНЬ, &Нач, &Кон)';
      const pkg = env.window.parseSdblClient(text);
      const parsed = pkg.queries[0];
      assert.ok(parsed.totals);
      assert.strictEqual(parsed.totals.by.length, 1);
      const periodDef = parsed.totals.by[0].periodDefinition;
      assert.ok(periodDef, 'periodDefinition must be parsed');
      assert.strictEqual(periodDef.periodType, 'ДЕНЬ');
      assert.strictEqual(env.window.getExpressionString(periodDef.from), '&Нач');
      assert.strictEqual(env.window.getExpressionString(periodDef.to), '&Кон');

      const formatted = env.window.formatSdblQuery(parsed);
      assert.ok(formatted.includes('ПЕРИОДАМИ(ДЕНЬ, &Нач, &Кон)'));
    });

    test('Finding 3: text tab with totals without aggregate fields puts by-item into totals.by (not totals.fields)', () => {
      const env = createWebviewEnvironment();
      const text = 'ВЫБРАТЬ A ИЗ T ИТОГИ ПО A ПЕРИОДАМИ(ДЕНЬ, &Нач, &Кон)';
      const pkg = env.window.parseSdblClient(text);
      const parsed = pkg.queries[0];

      assert.ok(parsed.totals, 'totals must exist');
      assert.strictEqual(parsed.totals.fields.length, 0, 'totals.fields must be empty when no aggregates');
      assert.strictEqual(parsed.totals.by.length, 1, 'totals.by must contain 1 group item');
      assert.strictEqual(env.window.getExpressionString(parsed.totals.by[0].expression), 'A');
      assert.strictEqual(parsed.totals.by[0].periods, true);
      assert.strictEqual(parsed.totals.by[0].periodDefinition?.periodType, 'ДЕНЬ');

      const formatted = env.window.formatSdblQuery(parsed);
      assert.ok(
        formatted.includes('ПО') && formatted.includes('A ПЕРИОДАМИ(ДЕНЬ, &Нач, &Кон)'),
        'Formatted text must have ПО with A'
      );
    });

    test('Finding 3: English TOTALS BY A without aggregates puts by-item into totals.by', () => {
      const env = createWebviewEnvironment();
      const text = 'SELECT A FROM T TOTALS BY A';
      const pkg = env.window.parseSdblClient(text);
      const parsed = pkg.queries[0];

      assert.ok(parsed.totals);
      assert.strictEqual(parsed.totals.fields.length, 0);
      assert.strictEqual(parsed.totals.by.length, 1);
      assert.strictEqual(env.window.getExpressionString(parsed.totals.by[0].expression), 'A');
    });

    test('Finding 5: client parser extracts balanced parenthesis arguments in ПЕРИОДАМИ with nested functions', () => {
      const env = createWebviewEnvironment();
      const text = 'ВЫБРАТЬ Период ИЗ T ИТОГИ СУММА(A) ПО Период ПЕРИОДАМИ(ДЕНЬ, НАЧАЛОПЕРИОДА(&Дата, ДЕНЬ), &Кон)';
      const pkg = env.window.parseSdblClient(text);
      const parsed = pkg.queries[0];

      assert.ok(parsed.totals);
      assert.strictEqual(parsed.totals.by.length, 1);
      const byItem = parsed.totals.by[0];
      assert.strictEqual(
        env.window.getExpressionString(byItem.expression),
        'Период',
        'Expression must be Период, not corrupted by trailing parenthesis'
      );
      assert.strictEqual(byItem.periods, true);
      assert.ok(byItem.periodDefinition);
      assert.strictEqual(byItem.periodDefinition.periodType, 'ДЕНЬ');
      assert.strictEqual(
        env.window.getExpressionString(byItem.periodDefinition.from),
        'НАЧАЛОПЕРИОДА(&Дата, ДЕНЬ)',
        'From expression must retain closing parenthesis'
      );
      assert.strictEqual(
        env.window.getExpressionString(byItem.periodDefinition.to),
        '&Кон',
        'To expression must be parsed'
      );

      const formatted = env.window.formatSdblQuery(parsed);
      assert.ok(
        formatted.includes('ПЕРИОДАМИ(ДЕНЬ, НАЧАЛОПЕРИОДА(&Дата, ДЕНЬ), &Кон)'),
        'Formatted query must retain balanced parameters'
      );
    });

    test('Finding 7: unchecking periods checkbox deletes periodDefinition and removes periods from formatted query', () => {
      const env = createWebviewEnvironment();
      const q = env.window.getActiveQuery();
      q.fields = [{ expression: { type: 'Identifier', name: 'A' }, alias: 'A' }];
      q.from = [{ source: { type: 'Table', name: 'T' } }];
      q.totals = {
        fields: [],
        by: [
          {
            expression: { type: 'Identifier', name: 'Период' },
            periods: true,
            periodDefinition: {
              periodType: 'ДЕНЬ',
              from: { type: 'Parameter', name: 'Нач' },
              to: { type: 'Parameter', name: 'Кон' },
            },
          },
        ],
      };

      env.window.renderTab9();

      // Find the checkbox for periods in tbodyTotalsGroups
      const rows = env.elements.tbodyTotalsGroups.children;
      assert.strictEqual(rows.length, 1);
      const checkboxes = rows[0].querySelectorAll('input[type="checkbox"]');
      assert.strictEqual(checkboxes.length, 2);
      const chPer = checkboxes[1];
      assert.strictEqual(chPer.checked, true, 'Periods checkbox must initially be checked');

      // Uncheck it
      chPer.checked = false;
      chPer.dispatchEvent({ type: 'change', target: chPer });

      assert.strictEqual(q.totals.by[0].periods, false, 'tb.periods must be false');
      assert.strictEqual(q.totals.by[0].periodDefinition, undefined, 'tb.periodDefinition must be deleted');

      const formatted = env.window.formatSdblQuery(q);
      assert.ok(!formatted.includes('ПЕРИОДАМИ'), 'Formatted query must NOT contain ПЕРИОДАМИ');
    });

    test('Finding 8: parse error on text tab blocks save button and posts 0 save messages', () => {
      const env = createWebviewEnvironment();

      // Switch active tab to tab-query-text
      env.tabButtons.forEach((b: any) => {
        b.className = 'tab-btn';
      });
      const textTabBtn = env.tabButtons.find((b: any) => b.getAttribute('data-tab') === 'tab-query-text');
      assert.ok(textTabBtn);
      textTabBtn.className = 'tab-btn active';

      // Set invalid text in editor
      env.elements.sdblTextEditor.value = 'НЕВАЛИДНЫЙ ТЕКСТ БЕЗ ВЫБРАТЬ';

      // Click save button
      env.elements.btnSave.click();

      // Verify no save message was sent
      const saveMessages = env.sentMessages.filter((m: any) => m.command === 'save');
      assert.strictEqual(saveMessages.length, 0, 'No save message must be posted on parse error');

      // Verify error message is shown
      assert.strictEqual(env.elements.textParseError.style.display, 'flex');
      assert.ok(env.elements.textParseError.textContent.includes('Ошибка парсинга SDBL'));
    });

    test('Finding 3 (Review 64ca628): unchecking periods on real parsed AST leaves NO ПЕРИОДАМИ in production formatter', () => {
      const realParsed = parseSdbl('ВЫБРАТЬ A ИЗ T ИТОГИ ПО A ПЕРИОДАМИ(ДЕНЬ, &Нач, &Кон)');
      const sel = realParsed.queries[0] as any;
      assert.strictEqual(sel.totals?.by[0].period, true, 'Real parser sets period: true');
      assert.strictEqual(sel.totals?.by[0].periods, true, 'Real parser sets periods: true');

      const env = createWebviewEnvironment();
      // Initialize with real parsed AST
      env.postMessageToWebview({ command: 'init', ast: realParsed, metadata: [] });
      env.window.renderTab9();

      const rows = env.elements.tbodyTotalsGroups.children;
      assert.strictEqual(rows.length, 1);
      const checkboxes = rows[0].querySelectorAll('input[type="checkbox"]');
      const chPer = checkboxes[1];
      assert.strictEqual(chPer.checked, true, 'Periods checkbox must be checked initially');

      // Uncheck it
      chPer.checked = false;
      chPer.dispatchEvent({ type: 'change', target: chPer });

      const q = env.window.getActiveQuery();
      assert.strictEqual(q.totals.by[0].periods, false, 'periods must be false');
      assert.strictEqual(q.totals.by[0].period, undefined, 'period must be deleted');
      assert.strictEqual(q.totals.by[0].periodDefinition, undefined, 'periodDefinition must be undefined');

      // Click save button and verify saved AST formatted with production backend formatSdbl
      env.elements.btnSave.click();
      const saveMessages = env.sentMessages.filter((m: any) => m.command === 'save');
      assert.strictEqual(saveMessages.length, 1, 'Save message must be sent');
      const savedPkg = saveMessages[0].ast;
      const backendFormatted = formatSdbl(savedPkg);
      assert.ok(!backendFormatted.includes('ПЕРИОДАМИ'), 'Backend production formatSdbl must NOT contain ПЕРИОДАМИ');

      // Now re-check periods checkbox
      chPer.checked = true;
      chPer.dispatchEvent({ type: 'change', target: chPer });
      assert.strictEqual(q.totals.by[0].periods, true, 'periods must be true after recheck');

      env.elements.btnSave.click();
      const saveMessages2 = env.sentMessages.filter((m: any) => m.command === 'save');
      assert.strictEqual(saveMessages2.length, 2);
      const recheckedFormatted = formatSdbl(saveMessages2[1].ast);
      assert.ok(recheckedFormatted.includes('ПЕРИОДАМИ'), 'Rechecking periods must restore ПЕРИОДАМИ in production formatter');
    });

    suite('Right Join Unfolding & Deduplication Broad Edge Cases', () => {
      test('Tab 2 selecting Right join unfolds into ЛЕВОЕ СОЕДИНЕНИЕ with swapped base table in formatSdblQuery and on save', () => {
        const env = createWebviewEnvironment();
        const q = env.window.getActiveQuery();
        q.fields = [
          { expression: 'ТабА.Код', alias: 'Код' },
          { expression: 'ТабБ.Наименование', alias: 'Наименование' },
        ];
        q.from = [
          {
            source: { type: 'Table', name: 'Справочник.ТаблицаА' },
            alias: 'ТабА',
            joins: [
              {
                joinType: 'Right',
                source: { type: 'Table', name: 'Справочник.ТаблицаБ' },
                alias: 'ТабБ',
                on: { type: 'RawExpression', raw: 'ТабА.ID = ТабБ.ID' },
              },
            ],
          },
        ];

        // Format in UI
        const uiFormatted = env.window.formatSdblQuery(q);
        assert.ok(!uiFormatted.includes('ПРАВОЕ СОЕДИНЕНИЕ'), 'UI formatted query must NEVER include ПРАВОЕ СОЕДИНЕНИЕ');
        assert.ok(uiFormatted.includes('ЛЕВОЕ СОЕДИНЕНИЕ'), 'UI formatted query must include ЛЕВОЕ СОЕДИНЕНИЕ');
        assert.ok(uiFormatted.includes('ИЗ\n\tСправочник.ТаблицаБ КАК ТабБ'), 'Right table must become base table in ИЗ');
        assert.ok(uiFormatted.includes('ЛЕВОЕ СОЕДИНЕНИЕ Справочник.ТаблицаА КАК ТабА'), 'Left table must become joined table');

        // Click save button and verify saved AST
        env.elements.btnSave.click();
        const saveMessages = env.sentMessages.filter((m: any) => m.command === 'save');
        assert.strictEqual(saveMessages.length, 1, 'Save message must be sent');
        const savedAst = saveMessages[0].ast;
        const savedQuery = savedAst.queries[0];

        assert.strictEqual(savedQuery.from[0].source.name, 'Справочник.ТаблицаБ', 'Base table in saved AST must be ТаблицаБ');
        assert.strictEqual(savedQuery.from[0].joins[0].joinType, 'Left', 'Join in saved AST must be normalized to Left');
        assert.strictEqual(savedQuery.from[0].joins[0].source.name, 'Справочник.ТаблицаА', 'Joined table in saved AST must be ТаблицаА');

        // Verify production backend formatSdbl
        const backendFormatted = formatSdbl(savedAst);
        assert.ok(!backendFormatted.includes('ПРАВОЕ СОЕДИНЕНИЕ'), 'Backend formatSdbl must NEVER contain ПРАВОЕ СОЕДИНЕНИЕ');
        assert.ok(backendFormatted.includes('ЛЕВОЕ СОЕДИНЕНИЕ'), 'Backend formatSdbl must contain ЛЕВОЕ СОЕДИНЕНИЕ');
      });

      test('Joined table is never duplicated as comma-separated root in ИЗ', () => {
        const env = createWebviewEnvironment();
        const q = env.window.getActiveQuery();
        q.fields = [{ expression: 'Товары.Наименование', alias: 'Товар' }];
        // Simulate duplicate from clause where Склады is both a joined table and a separate root
        q.from = [
          {
            source: { type: 'Table', name: 'Справочник.Товары' },
            alias: 'Товары',
            joins: [
              {
                joinType: 'Left',
                source: { type: 'Table', name: 'Справочник.Склады' },
                alias: 'Склады',
                on: { type: 'RawExpression', raw: 'Товары.Склад = Склады.Ссылка' },
              },
            ],
          },
          {
            source: { type: 'Table', name: 'Справочник.Склады' },
            alias: 'Склады',
          },
        ];

        env.window.renderFromTables();

        // Must display only 2 rows in Tab 1 (Товары and Склады), not 3
        const rows = env.elements.tbodyFromTables.children;
        assert.strictEqual(rows.length, 2, 'Tab 1 must display exactly 2 unique tables without duplication');

        const uiFormatted = env.window.formatSdblQuery(q);
        // There should not be a trailing comma or duplicate Склады
        const skladiMatches = uiFormatted.match(/Справочник\.Склады/g);
        assert.strictEqual(skladiMatches ? skladiMatches.length : 0, 1, 'Справочник.Склады must appear exactly once in query text');
        assert.ok(!uiFormatted.includes('Справочник.Склады КАК Склады,'), 'Must not have trailing comma after joined table');
      });

      test('Adding fields or tables for already joined table prevents duplicate roots in q.from', () => {
        const env = createWebviewEnvironment();
        const q = env.window.getActiveQuery();
        q.from = [
          {
            source: { type: 'Table', name: 'Справочник.Товары' },
            alias: 'Товары',
            joins: [
              {
                joinType: 'Left',
                source: { type: 'Table', name: 'Справочник.Склады' },
                alias: 'Склады',
                on: { type: 'RawExpression', raw: 'Товары.Склад = Склады.Ссылка' },
              },
            ],
          },
        ];

        // Try adding Склады as custom table
        env.window.addTableToQuery('Справочник.Склады');
        assert.strictEqual(q.from.length, 1, 'q.from must not add duplicate root for already joined table');

        // Try adding field for Склады
        env.window.addFieldToQuery({ name: 'Наименование', parentTableName: 'Склады', parentTableFullName: 'Справочник.Склады' });
        assert.strictEqual(q.from.length, 1, 'addFieldToQuery must not add duplicate root for already joined table');
        const addedField = q.fields[q.fields.length - 1];
        assert.strictEqual(addedField.expression, 'Склады.Наименование', 'Field must use existing joined table alias');
      });

      test('Reopening query with ЛЕВОЕ СОЕДИНЕНИЕ displays both base and joined tables in Tab 1 and Tab 2', () => {
        const env = createWebviewEnvironment();
        const parsed = parseSdbl('ВЫБРАТЬ Док.Номер ИЗ Документ.Заказ КАК Док ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Контрагенты КАК Контр ПО Док.Контрагент = Контр.Ссылка');

        env.postMessageToWebview({
          command: 'init',
          ast: parsed,
          metadata: [],
        });

        // Check Tab 1: both tables must be visible
        const fromRows = env.elements.tbodyFromTables.children;
        assert.strictEqual(fromRows.length, 2, 'Tab 1 must render both base table and joined table');
        assert.strictEqual(fromRows[0].children[0].textContent, 'Документ.Заказ');
        assert.strictEqual(fromRows[1].children[0].textContent, 'Справочник.Контрагенты');

        // Check Tab 2: joins must render with both tables in dropdowns
        env.window.renderTab2();
        const joinRows = env.elements.tbodyJoins.children;
        assert.strictEqual(joinRows.length, 1, 'Tab 2 must render the join');
        const selT1 = joinRows[0].children[0].querySelector('select');
        const selT2 = joinRows[0].children[2].querySelector('select');
        assert.ok(selT1);
        assert.ok(selT2);
        assert.strictEqual(selT1.value, 'Док');
        assert.strictEqual(selT2.value, 'Контр');
      });

      test('Virtual table parameters modal functions correctly on a joined table', () => {
        const env = createWebviewEnvironment();
        const q = env.window.getActiveQuery();
        q.fields = [{ expression: 'Ном.Ссылка', alias: 'Номенклатура' }];
        q.from = [
          {
            source: { type: 'Table', name: 'Справочник.Номенклатура' },
            alias: 'Ном',
            joins: [
              {
                joinType: 'Left',
                source: { type: 'Table', name: 'РегистрНакопления.ОстаткиТоваров.Остатки' },
                alias: 'Ост',
                on: { type: 'RawExpression', raw: 'Ном.Ссылка = Ост.Номенклатура' },
              },
            ],
          },
        ];

        env.window.renderFromTables();

        // Joined virtual table is row index 1 in Tab 1
        const fromRows = env.elements.tbodyFromTables.children;
        assert.strictEqual(fromRows.length, 2);

        // Open modal for index 1
        env.window.openVirtualTableParamsModal(1);
        assert.strictEqual(env.elements.modalVtTitle.textContent, 'Параметры: РегистрНакопления.ОстаткиТоваров.Остатки');

        const inputs = env.elements.tbodyVtParams.querySelectorAll('input');
        assert.ok(inputs.length >= 2);
        inputs[0].value = '&Период';
        inputs[1].value = 'Номенклатура = &Номенклатура';

        env.window.saveVirtualTableParamsModal();

        const formatted = env.window.formatSdblQuery(q);
        assert.ok(
          formatted.includes('РегистрНакопления.ОстаткиТоваров.Остатки(&Период, Номенклатура = &Номенклатура)'),
          `Formatted query must contain virtual table params on joined table: ${formatted}`
        );

        // Save and verify backend formatSdbl
        env.elements.btnSave.click();
        const saveMessages = env.sentMessages.filter((m: any) => m.command === 'save');
        assert.strictEqual(saveMessages.length, 1);
        const backendFormatted = formatSdbl(saveMessages[0].ast);
        assert.ok(
          backendFormatted.includes('РегистрНакопления.ОстаткиТоваров.Остатки(&Период, Номенклатура = &Номенклатура)'),
          `Backend formatSdbl must contain virtual table params on joined table: ${backendFormatted}`
        );
      });

      test('Deleting joined table in Tab 1 cleanly removes table and its join without corrupting base table', () => {
        const env = createWebviewEnvironment();
        const q = env.window.getActiveQuery();
        q.from = [
          {
            source: { type: 'Table', name: 'Справочник.Номенклатура' },
            alias: 'Ном',
            joins: [
              {
                joinType: 'Left',
                source: { type: 'Table', name: 'Справочник.Склады' },
                alias: 'Скл',
                on: { type: 'RawExpression', raw: 'Ном.Склад = Скл.Ссылка' },
              },
            ],
          },
        ];

        env.window.renderFromTables();
        assert.strictEqual(env.elements.tbodyFromTables.children.length, 2);

        // Click delete button on row 1 (Склады)
        const delBtnJoined = env.elements.tbodyFromTables.children[1].querySelector('button.danger');
        assert.ok(delBtnJoined);
        delBtnJoined.click();

        // Verify Tab 1 now has only 1 table
        assert.strictEqual(env.elements.tbodyFromTables.children.length, 1);
        assert.strictEqual(env.elements.tbodyFromTables.children[0].children[0].textContent, 'Справочник.Номенклатура');

        // Verify Tab 2 has 0 joins
        env.window.renderTab2();
        assert.strictEqual(env.elements.tbodyJoins.children.length, 0);

        // Verify formatted query has no joins
        const formatted = env.window.formatSdblQuery(q);
        assert.ok(!formatted.includes('Справочник.Склады'));
        assert.ok(!formatted.includes('СОЕДИНЕНИЕ'));
      });

      test('chained Right joins (A RIGHT JOIN B RIGHT JOIN C) transpose into canonical Left joins like 1C platform constructor', () => {
        const env = createWebviewEnvironment();
        const q = env.window.getActiveQuery();
        q.fields = [{ expression: 'A.ID', alias: 'A_ID' }];
        q.from = [
          {
            source: { type: 'Table', name: 'Справочник.A' },
            alias: 'A',
            joins: [
              {
                joinType: 'Right',
                source: { type: 'Table', name: 'Справочник.B' },
                alias: 'B',
                on: { type: 'RawExpression', raw: 'A.ID = B.ID' },
              },
              {
                t1: 'B',
                joinType: 'Right',
                source: { type: 'Table', name: 'Справочник.C' },
                alias: 'C',
                on: { type: 'RawExpression', raw: 'B.ID = C.ID' },
              },
            ],
          },
        ];

        const formatted = env.window.formatSdblQuery(q);
        assert.ok(!formatted.includes('ПРАВОЕ СОЕДИНЕНИЕ'), `Must NEVER contain ПРАВОЕ СОЕДИНЕНИЕ: ${formatted}`);
        assert.ok(formatted.includes('Справочник.C КАК C'), `C must be the base table in ИЗ: ${formatted}`);
        assert.ok(formatted.includes('ЛЕВОЕ СОЕДИНЕНИЕ Справочник.B КАК B'), `B must be left joined: ${formatted}`);
        assert.ok(formatted.includes('ЛЕВОЕ СОЕДИНЕНИЕ Справочник.A КАК A'), `A must be left joined: ${formatted}`);
      });
    });

    suite('Tab Query Text Draft Protection on Error (R2 / P2)', () => {
      test('1. Switching away from tab-query-text is blocked on parse error, preserving draft and showing error', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 КАК Поле'),
          mode: 'simple',
        });

        const textTabBtn = env.tabButtons.find((b: any) => b.getAttribute('data-tab') === 'tab-query-text');
        const tab1Btn = env.tabButtons.find((b: any) => b.getAttribute('data-tab') === 'tab-tables-fields');
        const textTabPane = env.document.getElementById('tab-query-text');
        const tab1Pane = env.document.getElementById('tab-tables-fields');

        assert.ok(textTabBtn);
        assert.ok(tab1Btn);

        // Switch to text tab
        textTabBtn.click();
        assert.strictEqual(textTabBtn.classList.contains('active'), true);
        assert.strictEqual(textTabPane.classList.contains('active'), true);
        assert.ok(env.elements.sdblTextEditor.value.includes('1 КАК Поле'));

        // Corrupt text to syntax error: "ВЫБРАТЬ"
        env.elements.sdblTextEditor.value = 'ВЫБРАТЬ';

        // Attempt to switch to Tab 1
        tab1Btn.click();

        // Must NOT switch tabs: tab-query-text remains active
        assert.strictEqual(textTabBtn.classList.contains('active'), true, 'tab-query-text button must remain active');
        assert.strictEqual(textTabPane.classList.contains('active'), true, 'tab-query-text pane must remain active');
        assert.strictEqual(tab1Btn.classList.contains('active'), false, 'tab-tables-fields button must NOT be active');
        assert.strictEqual(tab1Pane.classList.contains('active'), false, 'tab-tables-fields pane must NOT be active');

        // Draft must be preserved in textarea
        assert.strictEqual(env.elements.sdblTextEditor.value, 'ВЫБРАТЬ', 'Draft text in editor must be preserved');

        // Error message must be visible
        assert.strictEqual(env.elements.textParseError.style.display, 'flex');
        assert.ok(env.elements.textParseError.textContent.includes('Ошибка парсинга SDBL'));
      });

      test('2. Changing packageSelect or clicking toolbar query buttons is blocked on parse error, preserving draft', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 КАК Поле1; ВЫБРАТЬ 2 КАК Поле2'),
          mode: 'simple',
        });

        const textTabBtn = env.tabButtons.find((b: any) => b.getAttribute('data-tab') === 'tab-query-text');
        textTabBtn.click();

        // Corrupt text
        env.elements.sdblTextEditor.value = 'ВЫБРАТЬ';

        // Attempt to change packageSelect
        assert.strictEqual(env.state.activeQueryIndex, 0);
        env.elements.packageSelect.value = '1';
        env.elements.packageSelect.dispatchEvent({ type: 'change', target: env.elements.packageSelect });

        // Must be blocked
        assert.strictEqual(env.state.activeQueryIndex, 0, 'activeQueryIndex must remain 0');
        assert.strictEqual(env.elements.packageSelect.value, '0', 'packageSelect value must be reset to 0');
        assert.strictEqual(env.elements.sdblTextEditor.value, 'ВЫБРАТЬ', 'Draft must be preserved');
        assert.strictEqual(env.elements.textParseError.style.display, 'flex');

        // Attempt btnAddQuery
        const prevCount = env.state.ast.queries.length;
        env.elements.btnAddQuery.click();
        assert.strictEqual(env.state.ast.queries.length, prevCount, 'btnAddQuery must be blocked');
        assert.strictEqual(env.elements.sdblTextEditor.value, 'ВЫБРАТЬ', 'Draft must be preserved');

        // Attempt btnRemoveQuery
        env.elements.btnRemoveQuery.click();
        assert.strictEqual(env.state.ast.queries.length, prevCount, 'btnRemoveQuery must be blocked');

        // Attempt btnMoveQueryDown
        env.elements.btnMoveQueryDown.click();
        assert.strictEqual(env.state.activeQueryIndex, 0, 'btnMoveQueryDown must be blocked');
      });

      test('3. Successful error correction allows tab switching and updates AST', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 КАК Поле1'),
          mode: 'simple',
        });

        const textTabBtn = env.tabButtons.find((b: any) => b.getAttribute('data-tab') === 'tab-query-text');
        const tab1Btn = env.tabButtons.find((b: any) => b.getAttribute('data-tab') === 'tab-tables-fields');
        const textTabPane = env.document.getElementById('tab-query-text');
        const tab1Pane = env.document.getElementById('tab-tables-fields');

        textTabBtn.click();

        // Introduce syntax error
        env.elements.sdblTextEditor.value = 'ВЫБРАТЬ';
        tab1Btn.click();
        assert.strictEqual(textTabBtn.classList.contains('active'), true, 'Blocked on error');

        // Now fix error
        env.elements.sdblTextEditor.value = 'ВЫБРАТЬ 2 КАК Поле2';
        tab1Btn.click();

        // Switch succeeds
        assert.strictEqual(tab1Btn.classList.contains('active'), true, 'tab-tables-fields must become active');
        assert.strictEqual(tab1Pane.classList.contains('active'), true, 'tab-tables-fields pane must become active');
        assert.strictEqual(textTabBtn.classList.contains('active'), false, 'tab-query-text must not be active');

        // AST updated
        const q = env.window.getActiveQuery();
        assert.strictEqual(q.fields[0].alias, 'Поле2');

        // Return to Tab 11 -> shows formatted new query
        textTabBtn.click();
        assert.strictEqual(textTabBtn.classList.contains('active'), true);
        assert.ok(env.elements.sdblTextEditor.value.includes('Поле2'));
        assert.strictEqual(env.elements.textParseError.style.display, 'none');
      });

      test('4. Package with multiple queries blocks tab switching when 2nd query has syntax error', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 КАК П1; ВЫБРАТЬ 2 КАК П2'),
          mode: 'simple',
        });

        env.state.activeQueryIndex = 1;
        const textTabBtn = env.tabButtons.find((b: any) => b.getAttribute('data-tab') === 'tab-query-text');
        const tab1Btn = env.tabButtons.find((b: any) => b.getAttribute('data-tab') === 'tab-tables-fields');

        textTabBtn.click();
        assert.ok(env.elements.sdblTextEditor.value.includes('1 КАК П1'));
        assert.ok(env.elements.sdblTextEditor.value.includes('2 КАК П2'));

        // Corrupt 2nd query
        env.elements.sdblTextEditor.value = 'ВЫБРАТЬ 1 КАК П1; ВЫБРАТЬ';

        // Try tab switch
        tab1Btn.click();

        assert.strictEqual(textTabBtn.classList.contains('active'), true, 'Tab switch blocked for package query with error');
        assert.strictEqual(env.elements.sdblTextEditor.value, 'ВЫБРАТЬ 1 КАК П1; ВЫБРАТЬ', 'Package draft preserved');
        assert.strictEqual(env.elements.textParseError.style.display, 'flex');

        // Fix error in 2nd query
        env.elements.sdblTextEditor.value = 'ВЫБРАТЬ 1 КАК П1; ВЫБРАТЬ 3 КАК П3';
        tab1Btn.click();

        assert.strictEqual(tab1Btn.classList.contains('active'), true);
        assert.strictEqual(env.state.ast.queries.length, 2);
        assert.strictEqual(env.state.ast.queries[1].fields[0].alias, 'П3');
      });
    });

    suite('Tab 2 Joins: Field Pickers & Reference Type Auto-Linking', () => {
      const mockMetadataTree: any[] = [
        {
          id: 'Catalogs',
          name: 'Catalogs',
          fullName: 'Справочники',
          nodeType: 'category',
          children: [
            {
              id: 'Catalog.СтарееСтарых',
              name: 'СтарееСтарых',
              fullName: 'Справочник.СтарееСтарых',
              nodeType: 'table',
              attributesLoaded: true,
              children: [
                { id: 'Catalog.СтарееСтарых.Ref', name: 'Ссылка', nodeType: 'field', dataType: 'Ref' },
                { id: 'Catalog.СтарееСтарых.Code', name: 'Код', nodeType: 'field', dataType: 'String' },
                { id: 'Catalog.СтарееСтарых.Description', name: 'Наименование', nodeType: 'field', dataType: 'String' },
                {
                  id: 'Catalog.СтарееСтарых.чекчек',
                  name: 'чекчек',
                  nodeType: 'field',
                  dataType: 'СправочникСсылка.Справочник55',
                },
              ],
            },
            {
              id: 'Catalog.Справочник55',
              name: 'Справочник55',
              fullName: 'Справочник.Справочник55',
              nodeType: 'table',
              attributesLoaded: true,
              children: [
                { id: 'Catalog.Справочник55.Ref', name: 'Ссылка', nodeType: 'field', dataType: 'Ref' },
                { id: 'Catalog.Справочник55.Code', name: 'Код', nodeType: 'field', dataType: 'String' },
                { id: 'Catalog.Справочник55.Description', name: 'Наименование', nodeType: 'field', dataType: 'String' },
              ],
            },
            {
              id: 'Catalog.Валюты',
              name: 'Валюты',
              fullName: 'Справочник.Валюты',
              nodeType: 'table',
              attributesLoaded: true,
              children: [
                { id: 'Catalog.Валюты.Ref', name: 'Ссылка', nodeType: 'field', dataType: 'Ref' },
                { id: 'Catalog.Валюты.Code', name: 'Код', nodeType: 'field', dataType: 'String' },
              ],
            },
          ],
        },
        {
          id: 'Documents',
          name: 'Documents',
          fullName: 'Документы',
          nodeType: 'category',
          children: [
            {
              id: 'Document.РасходнаяНакладная',
              name: 'РасходнаяНакладная',
              fullName: 'Документ.РасходнаяНакладная',
              nodeType: 'table',
              attributesLoaded: true,
              children: [
                { id: 'Document.РасходнаяНакладная.Ref', name: 'Ссылка', nodeType: 'field', dataType: 'Ref' },
                {
                  id: 'Document.РасходнаяНакладная.Номенклатура',
                  name: 'Номенклатура',
                  nodeType: 'field',
                  dataType: 'СправочникСсылка.Номенклатура',
                },
              ],
            },
            {
              id: 'Document.ПриходнаяНакладная',
              name: 'ПриходнаяНакладная',
              fullName: 'Документ.ПриходнаяНакладная',
              nodeType: 'table',
              attributesLoaded: true,
              children: [
                { id: 'Document.ПриходнаяНакладная.Ref', name: 'Ссылка', nodeType: 'field', dataType: 'Ref' },
                {
                  id: 'Document.ПриходнаяНакладная.Номенклатура',
                  name: 'Номенклатура',
                  nodeType: 'field',
                  dataType: 'СправочникСсылка.Номенклатура',
                },
              ],
            },
          ],
        },
      ];

      test('1. autoSuggestJoinCondition links T1 attribute to T2 Ссылка when type matches', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Справочник.СтарееСтарых КАК СтарееСтарых, Справочник.Справочник55 КАК Справочник55'),
          metadata: mockMetadataTree,
        });

        assert.ok(typeof env.window.autoSuggestJoinCondition === 'function', 'autoSuggestJoinCondition must be exported');
        const res = env.window.autoSuggestJoinCondition(
          'СтарееСтарых',
          'Справочник.СтарееСтарых',
          'Справочник55',
          'Справочник.Справочник55'
        );

        assert.strictEqual(res.field1, 'чекчек');
        assert.strictEqual(res.op, '=');
        assert.strictEqual(res.field2, 'Ссылка');
        assert.strictEqual(res.raw, 'СтарееСтарых.чекчек = Справочник55.Ссылка');
      });

      test('2. autoSuggestJoinCondition links T2 attribute to T1 Ссылка when type matches in reverse', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Справочник.Справочник55 КАК Справочник55, Справочник.СтарееСтарых КАК СтарееСтарых'),
          metadata: mockMetadataTree,
        });

        const res = env.window.autoSuggestJoinCondition(
          'Справочник55',
          'Справочник.Справочник55',
          'СтарееСтарых',
          'Справочник.СтарееСтарых'
        );

        assert.strictEqual(res.field1, 'Ссылка');
        assert.strictEqual(res.op, '=');
        assert.strictEqual(res.field2, 'чекчек');
        assert.strictEqual(res.raw, 'Справочник55.Ссылка = СтарееСтарых.чекчек');
      });

      test('3. autoSuggestJoinCondition links common reference attribute', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Документ.РасходнаяНакладная КАК Расходная, Документ.ПриходнаяНакладная КАК Приходная'),
          metadata: mockMetadataTree,
        });

        const res = env.window.autoSuggestJoinCondition(
          'Расходная',
          'Документ.РасходнаяНакладная',
          'Приходная',
          'Документ.ПриходнаяНакладная'
        );

        assert.strictEqual(res.field1, 'Номенклатура');
        assert.strictEqual(res.op, '=');
        assert.strictEqual(res.field2, 'Номенклатура');
        assert.strictEqual(res.raw, 'Расходная.Номенклатура = Приходная.Номенклатура');
      });

      test('4. autoSuggestJoinCondition falls back to ИСТИНА for unrelated tables', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Справочник.Валюты КАК Валюты, Справочник.Справочник55 КАК Справочник55'),
          metadata: mockMetadataTree,
        });

        const res = env.window.autoSuggestJoinCondition(
          'Валюты',
          'Справочник.Валюты',
          'Справочник55',
          'Справочник.Справочник55'
        );

        assert.strictEqual(res.raw, 'ИСТИНА');
      });

      test('5. renderTab2 renders field dropdowns populated with table fields and updates AST on change', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Справочник.СтарееСтарых КАК СтарееСтарых ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Справочник55 КАК Справочник55 ПО ИСТИНА'),
          metadata: mockMetadataTree,
        });

        env.window.renderTab2();

        const tbody = env.elements.tbodyJoins;
        assert.strictEqual(tbody.children.length, 1, 'One join row must be rendered');
        const tr = tbody.children[0];

        const selF1 = tr.querySelector('.join-select-f1') as any;
        const selOp = tr.querySelector('.join-select-op') as any;
        const selF2 = tr.querySelector('.join-select-f2') as any;

        assert.ok(selF1, 'join-select-f1 must exist in join row');
        assert.ok(selOp, 'join-select-op must exist in join row');
        assert.ok(selF2, 'join-select-f2 must exist in join row');

        // Check options in selF1 (from СтарееСтарых)
        const f1OptionValues = selF1.children.map((opt: any) => opt.value);
        assert.ok(f1OptionValues.includes('Ссылка'));
        assert.ok(f1OptionValues.includes('чекчек'));
        assert.ok(f1OptionValues.includes('Наименование'));

        // Check options in selF2 (from Справочник55)
        const f2OptionValues = selF2.children.map((opt: any) => opt.value);
        assert.ok(f2OptionValues.includes('Ссылка'));
        assert.ok(f2OptionValues.includes('Код'));

        // Select чекчек in selF1 and Ссылка in selF2
        selF1.value = 'чекчек';
        selF1.dispatchEvent({ type: 'change', target: selF1 });

        selF2.value = 'Ссылка';
        selF2.dispatchEvent({ type: 'change', target: selF2 });

        const q = env.window.getActiveQuery();
        const join = q.from[0].joins[0];
        const onStr = env.window.getExpressionString(join.on);
        assert.strictEqual(onStr, 'СтарееСтарых.чекчек = Справочник55.Ссылка');
      });

      test('6. btnAddJoin automatically applies autoSuggestJoinCondition', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Справочник.СтарееСтарых КАК СтарееСтарых, Справочник.Справочник55 КАК Справочник55'),
          metadata: mockMetadataTree,
        });

        // Click add join
        env.elements.btnAddJoin.click();

        const q = env.window.getActiveQuery();
        assert.strictEqual(q.from[0].joins.length, 1);
        const join = q.from[0].joins[0];
        const onStr = env.window.getExpressionString(join.on);
        assert.strictEqual(onStr, 'СтарееСтарых.чекчек = Справочник55.Ссылка');
      });

      test('7. Auto-link button (⚡) re-calculates link condition for row', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Справочник.СтарееСтарых КАК СтарееСтарых ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Справочник55 КАК Справочник55 ПО ИСТИНА'),
          metadata: mockMetadataTree,
        });

        env.window.renderTab2();
        const tr = env.elements.tbodyJoins.children[0];
        const btnAutoLink = tr.querySelector('.btn-auto-link') as any;
        assert.ok(btnAutoLink, 'btn-auto-link must exist in row');

        btnAutoLink.click();

        const q = env.window.getActiveQuery();
        const onStr = env.window.getExpressionString(q.from[0].joins[0].on);
        assert.strictEqual(onStr, 'СтарееСтарых.чекчек = Справочник55.Ссылка');
      });

      test('8. Freeform text input allows editing custom expressions and syncs', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Справочник.СтарееСтарых КАК СтарееСтарых ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Справочник55 КАК Справочник55 ПО ИСТИНА'),
          metadata: mockMetadataTree,
        });

        env.window.renderTab2();
        const tr = env.elements.tbodyJoins.children[0];
        const inputRaw = tr.querySelector('.join-input-raw') as any;
        assert.ok(inputRaw, 'join-input-raw must exist');
        assert.strictEqual(inputRaw.value, 'ИСТИНА');

        // Type custom expression
        inputRaw.value = 'СтарееСтарых.Код = Справочник55.Код И СтарееСтарых.ПометкаУдаления = ЛОЖЬ';
        inputRaw.dispatchEvent({ type: 'change', target: inputRaw });

        const q = env.window.getActiveQuery();
        const onStr = env.window.getExpressionString(q.from[0].joins[0].on);
        assert.strictEqual(onStr, 'СтарееСтарых.Код = Справочник55.Код И СтарееСтарых.ПометкаУдаления = ЛОЖЬ');
      });
    });

    suite('Expression Builder, From-Tables Tree & Custom Joins', () => {
      const mockMetadataTree: any[] = [
        {
          id: 'Catalogs',
          name: 'Catalogs',
          fullName: 'Справочники',
          nodeType: 'category',
          children: [
            {
              id: 'Catalog.СтарееСтарых',
              name: 'СтарееСтарых',
              fullName: 'Справочник.СтарееСтарых',
              nodeType: 'table',
              attributesLoaded: true,
              children: [
                { id: 'Catalog.СтарееСтарых.Ref', name: 'Ссылка', nodeType: 'field', dataType: 'Ref' },
                { id: 'Catalog.СтарееСтарых.Code', name: 'Код', nodeType: 'field', dataType: 'String' },
                { id: 'Catalog.СтарееСтарых.Description', name: 'Наименование', nodeType: 'field', dataType: 'String' },
                {
                  id: 'Catalog.СтарееСтарых.чекчек',
                  name: 'чекчек',
                  nodeType: 'field',
                  dataType: 'СправочникСсылка.Справочник55',
                },
              ],
            },
            {
              id: 'Catalog.Справочник55',
              name: 'Справочник55',
              fullName: 'Справочник.Справочник55',
              nodeType: 'table',
              attributesLoaded: true,
              children: [
                { id: 'Catalog.Справочник55.Ref', name: 'Ссылка', nodeType: 'field', dataType: 'Ref' },
                { id: 'Catalog.Справочник55.Code', name: 'Код', nodeType: 'field', dataType: 'String' },
                { id: 'Catalog.Справочник55.Description', name: 'Наименование', nodeType: 'field', dataType: 'String' },
              ],
            },
          ],
        },
      ];

      test('1. Expression Builder Modal elements and API exist', () => {
        const env = createWebviewEnvironment();
        assert.ok(env.elements.modalExprBuilder, 'modalExprBuilder must exist in elements');
        assert.ok(env.elements.exprFieldsTree, 'exprFieldsTree must exist in elements');
        assert.ok(env.elements.exprFunctionsTree, 'exprFunctionsTree must exist in elements');
        assert.ok(env.elements.exprBuilderTextarea, 'exprBuilderTextarea must exist in elements');
        assert.ok(env.elements.btnExprSave, 'btnExprSave must exist in elements');
        assert.ok(env.elements.btnExprCancel, 'btnExprCancel must exist in elements');
        assert.strictEqual(typeof env.window.openExpressionBuilder, 'function', 'openExpressionBuilder must be exposed on window');
      });

      test('2. Pencil button ✏️ on selected fields opens Expression Builder modal', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 + 1 КАК Выражение ИЗ Справочник.СтарееСтарых КАК СтарееСтарых'),
          metadata: mockMetadataTree,
        });

        env.window.renderSelectedFields();
        const tr = env.elements.tbodySelectedFields.children[0];
        assert.ok(tr, 'Row in selected fields must exist');
        const btnEdit = tr.querySelector('.btn-edit-field-expr') as any;
        assert.ok(btnEdit, '.btn-edit-field-expr pencil button must exist in field row');

        btnEdit.click();

        assert.ok(env.elements.modalExprBuilder.classList.contains('open'), 'Modal must have class open');
        assert.strictEqual(env.elements.exprBuilderTextarea.value, '1 + 1');
      });

      test('3. expr-fields-tree renders tables and double-click inserts Table.Field', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Справочник.СтарееСтарых КАК СтарееСтарых'),
          metadata: mockMetadataTree,
        });

        env.window.openExpressionBuilder({ value: '' });

        const tree = env.elements.exprFieldsTree;
        assert.ok(tree.children.length > 0, 'exprFieldsTree must contain nodes');

        // Look for field node 'Ссылка'
        const fieldRows = tree.querySelectorAll('.tree-row');
        const refRow = fieldRows.find((r: any) => r.textContent.includes('Ссылка'));
        assert.ok(refRow, 'Field row for Ссылка must exist in expr-fields-tree');

        refRow.dispatchEvent({ type: 'dblclick' });

        assert.ok(env.elements.exprBuilderTextarea.value.includes('СтарееСтарых.Ссылка'));
      });

      test('4. Reference field in expr-fields-tree expands target table attributes through dot', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Справочник.СтарееСтарых КАК СтарееСтарых'),
          metadata: mockMetadataTree,
        });

        env.window.openExpressionBuilder({ value: '' });

        const tree = env.elements.exprFieldsTree;
        const fieldRows = tree.querySelectorAll('.tree-row');
        const checkRow = fieldRows.find((r: any) => r.textContent.includes('чекчек'));
        assert.ok(checkRow, 'чекчек row must exist');

        // Find toggle on checkRow or its parent
        const parentNode = checkRow.parentElement;
        const toggle = checkRow.querySelector('.tree-toggle') || parentNode.querySelector('.tree-toggle');
        assert.ok(toggle, 'Toggle for reference field must exist');

        toggle.click();

        // After toggle click, child fields from Справочник55 should be present
        const subFieldRows = parentNode.querySelectorAll('.tree-row');
        const nameSubRow = subFieldRows.filter((r: any) => r.textContent.includes('Наименование')).pop();
        assert.ok(nameSubRow, 'Referenced attribute Наименование must be rendered under чекчек');

        nameSubRow.dispatchEvent({ type: 'dblclick' });

        assert.ok(env.elements.exprBuilderTextarea.value.includes('СтарееСтарых.чекчек.Наименование'));
      });

      test('5. expr-functions-tree inserts function templates with cursor positioning', () => {
        const env = createWebviewEnvironment();
        env.window.openExpressionBuilder({ value: '' });

        const tree = env.elements.exprFunctionsTree;
        assert.ok(tree.children.length > 0, 'exprFunctionsTree must contain category nodes');

        const rows = tree.querySelectorAll('.tree-row');
        const isNullRow = rows.find((r: any) => r.textContent.includes('ЕСТЬNULL'));
        assert.ok(isNullRow, 'ЕСТЬNULL function row must exist');

        isNullRow.dispatchEvent({ type: 'dblclick' });

        assert.ok(env.elements.exprBuilderTextarea.value.includes('ЕСТЬNULL('));

        const caseRow = rows.find((r: any) => r.textContent.includes('ВЫБОР'));
        assert.ok(caseRow, 'ВЫБОР function row must exist');

        caseRow.dispatchEvent({ type: 'dblclick' });

        assert.ok(env.elements.exprBuilderTextarea.value.includes('ВЫБОР КОГДА'));
      });

      test('6. Saving Expression Builder updates field in AST and closes modal', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 КАК Поле1 ИЗ Справочник.СтарееСтарых КАК СтарееСтарых'),
          metadata: mockMetadataTree,
        });

        env.window.renderSelectedFields();
        const tr = env.elements.tbodySelectedFields.children[0];
        const btnEdit = tr.querySelector('.btn-edit-field-expr') as any;
        btnEdit.click();

        env.elements.exprBuilderTextarea.value = 'ЕСТЬNULL(СтарееСтарых.чекчек.Наименование, "")';
        env.elements.btnExprSave.click();

        assert.strictEqual(env.elements.modalExprBuilder.classList.contains('open'), false, 'Modal must be closed');
        const q = env.window.getActiveQuery();
        assert.strictEqual(env.window.getExpressionString(q.fields[0].expression), 'ЕСТЬNULL(СтарееСтарых.чекчек.Наименование, "")');
      });

      test('7. Tab 1 Column 2: From-tables hierarchical tree with reference expansion', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Справочник.СтарееСтарых КАК СтарееСтарых'),
          metadata: mockMetadataTree,
        });

        env.window.renderFromTables();

        // from-tables-tree container must exist and contain the table
        const tree = env.elements.fromTablesTree || env.elements.tbodyFromTables;
        assert.ok(tree, 'fromTablesTree must exist');

        const rows = tree.querySelectorAll('.tree-row');
        const tableRow = rows.find((r: any) => r.textContent.includes('СтарееСтарых'));
        assert.ok(tableRow, 'СтарееСтарых table row must exist');

        const toggle = tableRow.querySelector('.tree-toggle');
        assert.ok(toggle, 'Table row must have expander toggle');
        toggle.click();

        // Should show fields of СтарееСтарых
        const fieldRows = tree.querySelectorAll('.tree-row');
        const checkField = fieldRows.find((r: any) => r.textContent.includes('чекчек'));
        assert.ok(checkField, 'чекчек field must be visible after expanding table');

        // Expand чекчек
        const checkToggle = checkField.querySelector('.tree-toggle');
        assert.ok(checkToggle, 'чекчек must have expander toggle for reference type');
        checkToggle.click();

        const subFieldRows = tree.querySelectorAll('.tree-row');
        const nameSub = subFieldRows.filter((r: any) => r.textContent.includes('Наименование')).pop();
        assert.ok(nameSub, 'Наименование sub-field must be visible under чекчек');

        // Double clicking adds field to q.fields
        nameSub.dispatchEvent({ type: 'dblclick' });

        const q = env.window.getActiveQuery();
        const lastField = q.fields[q.fields.length - 1];
        assert.strictEqual(env.window.getExpressionString(lastField.expression), 'СтарееСтарых.чекчек.Наименование');
      });

      test('8. Tab 2 Joins: Checkbox [ ] Произвольное with bi-directional translation and pencil button', () => {
        const env = createWebviewEnvironment();
        env.postMessageToWebview({
          command: 'init',
          ast: env.window.parseSdblClient('ВЫБРАТЬ 1 ИЗ Справочник.СтарееСтарых КАК СтарееСтарых ЛЕВОЕ СОЕДИНЕНИЕ Справочник.Справочник55 КАК Справочник55 ПО СтарееСтарых.чекчек = Справочник55.Ссылка'),
          metadata: mockMetadataTree,
        });

        env.window.renderTab2();
        const tr = env.elements.tbodyJoins.children[0];
        const chkCustom = tr.querySelector('.join-check-custom') as any;
        const btnEdit = tr.querySelector('.btn-edit-join-expr') as any;
        const structDiv = tr.querySelector('.join-on-structured') as any;
        const rawDiv = tr.querySelector('.join-on-raw') as any;

        assert.ok(chkCustom, 'Checkbox .join-check-custom must exist in join row');
        assert.ok(btnEdit, 'Button .btn-edit-join-expr must exist in join row');

        // Check custom
        chkCustom.checked = true;
        chkCustom.dispatchEvent({ type: 'change', target: chkCustom });

        assert.strictEqual(structDiv.style.display, 'none', 'Structured controls must be hidden when custom join is checked');
        assert.strictEqual(rawDiv.style.display, 'block', 'Raw input must be visible when custom join is checked');

        // Click pencil to edit in Expression Builder
        btnEdit.click();
        assert.ok(env.elements.modalExprBuilder.classList.contains('open'));
        assert.strictEqual(env.elements.exprBuilderTextarea.value, 'СтарееСтарых.чекчек = Справочник55.Ссылка');

        // Edit expression in modal and save
        env.elements.exprBuilderTextarea.value = 'СтарееСтарых.чекчек = Справочник55.Ссылка И СтарееСтарых.ПометкаУдаления = ЛОЖЬ';
        env.elements.btnExprSave.click();

        const q = env.window.getActiveQuery();
        assert.strictEqual(env.window.getExpressionString(q.from[0].joins[0].on), 'СтарееСтарых.чекчек = Справочник55.Ссылка И СтарееСтарых.ПометкаУдаления = ЛОЖЬ');

        // Uncheck custom: if it has simple condition, parses back into selectors
        const inputRaw = tr.querySelector('.join-input-raw') as any;
        inputRaw.value = 'СтарееСтарых.Код = Справочник55.Код';
        inputRaw.dispatchEvent({ type: 'change', target: inputRaw });

        chkCustom.checked = false;
        chkCustom.dispatchEvent({ type: 'change', target: chkCustom });

        assert.strictEqual(structDiv.style.display, 'flex', 'Structured controls must be visible when custom join is unchecked');
        const selF1 = tr.querySelector('.join-select-f1') as any;
        const selF2 = tr.querySelector('.join-select-f2') as any;
        assert.strictEqual(selF1.value, 'Код');
        assert.strictEqual(selF2.value, 'Код');
      });
    });
  });
});



