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
});
