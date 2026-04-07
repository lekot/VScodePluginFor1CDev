import * as assert from 'assert';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';

/** Contract tests for Block 2 Phase A: Pages/Page tabs in form editor preview (embedded in formWebviewHtml template). */
suite('form webview Pages/Page preview (1CVIEWER-36 block 2 phase A)', () => {
  let html: string;

  suiteSetup(() => {
    html = getWebviewHtml({} as any);
  });

  test('CSS: tab strip, TabsOnTop/TabsOnBottom layout hooks', () => {
    assert.ok(html.includes('.preview-pages-outer.TabsOnTop'), 'TabsOnTop class hook');
    assert.ok(html.includes('.preview-pages-outer.TabsOnBottom'), 'TabsOnBottom class hook');
    assert.ok(
      html.includes('.preview-pages-outer.TabsOnBottom .preview-pages-tablist { order: 2; }'),
      'tabs below content when TabsOnBottom'
    );
    assert.ok(html.includes('.preview-pages-tablist'), 'tablist container styles');
    assert.ok(html.includes(".preview-pages-tab[aria-selected='true']"), 'active tab styling');
  });

  test('JS: per-Pages active tab map keyed by id||name', () => {
    assert.ok(
      html.includes('var activePageIdByPagesKey = Object.create(null);'),
      'state map for multiple Pages nodes'
    );
    assert.ok(html.includes('function getFormItemKey(it)'), 'stable key helper');
    assert.ok(
      html.includes('function buildTabsState(pagesNode)'),
      'tab state builder'
    );
    assert.ok(
      html.includes('if (activePageId && pageOrderIds.indexOf(activePageId) < 0) activePageId = null;'),
      'stored selection cleared when page list changes'
    );
    assert.ok(
      html.includes('if (!pageOrderIds.length)'),
      'empty page list branch'
    );
    assert.ok(
      html.includes("tab.setAttribute('data-pages-key', pagesKey);"),
      'tab binds to parent Pages key'
    );
    assert.ok(
      html.includes("tab.setAttribute('data-page-id', pid);"),
      'tab binds to Page id/name'
    );
  });

  test('JS: PagesRepresentation normalizer regex uses whitespace class (template escape)', () => {
    assert.ok(
      html.includes('[\\s_-]+/g'),
      'outer TS template must emit /[\\s_-]+/g in the webview script, not /[s_-]+/g (broken \\s escape)'
    );
    assert.ok(
      !html.includes('String(raw || \'\').toLowerCase().replace(/[s_-]+/g'),
      'must not emit character class that strips letter s instead of whitespace'
    );
  });

  test('JS: PagesRepresentation → TabsOnTop | TabsOnBottom (ADR-1)', () => {
    assert.ok(html.includes('function getPagesRepresentationClass(item)'), 'mapper function');
    assert.ok(
      html.includes("'PagesRepresentation',") && html.includes("'ПредставлениеСтраниц'"),
      'property aliases for representation'
    );
    assert.ok(
      html.includes("v.indexOf('bottom') >= 0 || v.indexOf('низ') >= 0 || v.indexOf('внизу') >= 0"),
      'bottom placement: EN + RU tokens'
    );
    assert.ok(html.includes("return 'TabsOnBottom';"), 'TabsOnBottom return');
    assert.ok(html.includes("return 'TabsOnTop';"), 'default TabsOnTop');
  });

  test('JS: renderPagesInPreview — ARIA tablist/tab/tabpanel and active panel only', () => {
    assert.ok(html.includes('function renderPagesInPreview(pagesNode, outerEl, pagesLayoutMeta)'), 'renderer');
    assert.ok(html.includes('function findPageById(pages, pageId)'), 'resolve active page by key');
    assert.ok(
      html.includes("tablist.setAttribute('role', 'tablist');"),
      'tablist role'
    );
    assert.ok(
      html.includes("tab.setAttribute('role', 'tab');"),
      'tab role'
    );
    assert.ok(
      html.includes("panel.setAttribute('role', 'tabpanel');"),
      'tabpanel role'
    );
    assert.ok(
      html.includes("tab.setAttribute('aria-selected', pid === activeId ? 'true' : 'false');"),
      'exactly one tab selected in ARIA'
    );
    assert.ok(
      html.includes("tab.setAttribute('tabindex', pid === activeId ? '0' : '-1');"),
      'roving tabindex: active tab in tab order'
    );
    assert.ok(
      html.includes("tab.setAttribute('aria-controls', 'preview-panel-' + sid);"),
      'tab → panel id'
    );
    assert.ok(
      html.includes("panel.setAttribute('aria-labelledby', 'preview-tab-' + aid);"),
      'panel → tab id'
    );
    assert.ok(
      html.includes('renderPreview(activePage.childItems, panel);'),
      'only active Page subtree is rendered into panel'
    );
    assert.ok(
      html.includes("panel.textContent = 'Нет страниц';"),
      'empty Pages message'
    );
    assert.ok(
      html.includes('preview-empty-state'),
      'empty state CSS hook when no Page children'
    );
  });

  test('JS: renderPreview branches to renderPagesInPreview for Pages tag', () => {
    assert.ok(
      html.includes("if (tag === 'Pages') {\n            renderPagesInPreview(item, childWrap, layoutMeta);"),
      'Pages uses tabbed preview path'
    );
    assert.ok(
      html.includes("((item.childItems && item.childItems.length) || tag === 'Pages')"),
      'Pages renders tab chrome even with no child items yet'
    );
  });

  test('JS: tab click re-runs full preview with updated selection', () => {
    assert.ok(
      html.includes('activePageIdByPagesKey[pagesKey] = pid;'),
      'persists selection on click'
    );
    assert.ok(
      html.includes('if (String(activePageIdByPagesKey[pagesKey]) === String(pid)) return;'),
      'no full re-render when clicking already active tab'
    );
    assert.ok(
      html.includes('renderPreview(getDisplayItems(), root);'),
      'full preview refresh after tab change'
    );
  });

  test('JS: non-Page children under Pages still rendered below tab panel', () => {
    assert.ok(html.includes("'preview-pages-nonpage-children'"), 'sibling bucket class');
    assert.ok(
      html.includes("var otherKids = (pagesNode.childItems || []).filter(function(it) { return it && it.tag !== 'Page'; });"),
      'filters Page vs other'
    );
    assert.ok(html.includes('renderPreview(otherKids, extra);'), 'renders non-page children');
  });
});
