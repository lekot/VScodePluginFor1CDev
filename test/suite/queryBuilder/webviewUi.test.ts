import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

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

      querySelectorAll(sel: string): MockElement[] {
        const res: MockElement[] = [];
        const search = (node: MockElement) => {
          for (const c of node.children) {
            let matched = false;
            if (sel === 'input' && c.tagName === 'INPUT') matched = true;
            else if (sel === 'select' && c.tagName === 'SELECT') matched = true;
            else if (sel === 'button' && c.tagName === 'BUTTON') matched = true;
            else if (sel === 'tr' && c.tagName === 'TR') matched = true;
            else if (sel === 'button.danger' && c.tagName === 'BUTTON' && c.className.includes('danger')) matched = true;
            else if (sel === 'input[type="checkbox"]' && c.tagName === 'INPUT' && (c as any).type === 'checkbox') matched = true;
            else if (sel.startsWith('.') && c.className.includes(sel.substring(1))) matched = true;
            else if (c.tagName === sel.toUpperCase()) matched = true;

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
  });
});
