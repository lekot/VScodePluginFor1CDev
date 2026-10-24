import * as assert from 'assert';
import type { FormChildItem, FormModel } from '../../src/formEditor/formModel';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';
import { createFormWebviewRuntimeFixture, type FormWebviewRuntimeFixture } from '../helpers/formWebviewRuntime';

function item(tag: string, id: string | undefined, name: string, childItems: FormChildItem[] = [], properties: Record<string, unknown> = {}): FormChildItem {
  return { tag, id, name, childItems, properties };
}

function model(root: FormChildItem[]): FormModel {
  return { childItemsRoot: root, attributes: [], commands: [], formEvents: [] };
}

function sendModel(fixture: FormWebviewRuntimeFixture, formModel: FormModel): void {
  fixture.send({ type: 'formData', formModel });
}

function withRuntime(testBody: (fixture: FormWebviewRuntimeFixture) => void): void {
  const fixture = createFormWebviewRuntimeFixture();
  try {
    testBody(fixture);
  } finally {
    fixture.close();
  }
}

/** Runtime contract tests for Pages/Page tabs in the generated webview bundle. */
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

  test('keeps independent active tabs per Pages node and falls back when a page disappears', () => {
    withRuntime((fixture) => {
      const firstPages = item('Pages', 'pages-main', 'MainPages', [
        item('Page', 'main-one', 'MainOne', [item('Button', 'main-control-one', 'One')]),
        item('Page', 'main-two', 'MainTwo', [item('Button', 'main-control-two', 'Two')]),
      ]);
      const secondPages = item('Pages', undefined, 'pages-by-name', [
        item('Page', undefined, 'named-one', [item('Button', 'named-control-one', 'NamedOne')]),
        item('Page', undefined, 'named-two', [item('Button', 'named-control-two', 'NamedTwo')]),
      ]);
      let currentModel = model([firstPages, secondPages]);
      sendModel(fixture, currentModel);
      const document = fixture.dom.window.document;
      const firstSecondTab = document.querySelector<HTMLButtonElement>('[data-pages-key="pages-main"][data-page-id="main-two"]');
      const namedSecondTab = document.querySelector<HTMLButtonElement>('[data-pages-key="pages-by-name"][data-page-id="named-two"]');
      assert.ok(firstSecondTab && namedSecondTab);
      firstSecondTab.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      namedSecondTab.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      assert.strictEqual(document.querySelector('[data-pages-key="pages-main"][data-page-id="main-two"]')?.getAttribute('aria-selected'), 'true');
      assert.strictEqual(document.querySelector('[data-pages-key="pages-by-name"][data-page-id="named-two"]')?.getAttribute('aria-selected'), 'true');

      sendModel(fixture, currentModel);
      assert.strictEqual(document.querySelector('[data-pages-key="pages-main"][data-page-id="main-two"]')?.getAttribute('aria-selected'), 'true');
      assert.strictEqual(document.querySelector('[data-pages-key="pages-by-name"][data-page-id="named-two"]')?.getAttribute('aria-selected'), 'true');

      currentModel = model([
        item('Pages', 'pages-main', 'MainPages', [
          item('Page', 'main-one', 'MainOne', [item('Button', 'main-control-one', 'One')]),
        ]),
        secondPages,
      ]);
      sendModel(fixture, currentModel);
      assert.strictEqual(document.querySelector('[data-pages-key="pages-main"][data-page-id="main-one"]')?.getAttribute('aria-selected'), 'true');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });

  test('normalizes localized PagesRepresentation values and keeps tabs above or below content', () => {
    withRuntime((fixture) => {
      const english = item('Pages', 'pages-english', 'English', [item('Page', 'english-page', 'EnglishPage')], { PagesRepresentation: 'Tabs On Bottom' });
      const russian = item('Pages', 'pages-russian', 'Russian', [item('Page', 'russian-page', 'RussianPage')], { 'ПредставлениеСтраниц': 'Внизу' });
      sendModel(fixture, model([english, russian]));
      const document = fixture.dom.window.document;
      const englishOuter = document.querySelector('.preview-item[data-id="pages-english"] .preview-pages-outer');
      const russianOuter = document.querySelector('.preview-item[data-id="pages-russian"] .preview-pages-outer');
      assert.ok(englishOuter?.classList.contains('TabsOnBottom'), 'spaces in the English value are normalized');
      assert.ok(russianOuter?.classList.contains('TabsOnBottom'), 'Russian alias selects bottom tabs');
      assert.strictEqual(document.querySelectorAll('.preview-pages-outer.TabsOnTop').length, 0);
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });

  test('renders ARIA tab relationships and only the selected Page subtree', () => {
    withRuntime((fixture) => {
      const pages = item('Pages', 'pages', 'Pages', [
        item('Page', 'page-one', 'One', [item('Button', 'button-one', 'ButtonOne')]),
        item('Page', 'page-two', 'Two', [item('Button', 'button-two', 'ButtonTwo')]),
      ]);
      sendModel(fixture, model([pages]));
      const document = fixture.dom.window.document;
      const tabList = document.querySelector('.preview-pages-tablist[role="tablist"]');
      const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.preview-pages-tablist [role="tab"]'));
      const panel = document.querySelector<HTMLElement>('.preview-pages-active-panel[role="tabpanel"]');
      assert.ok(tabList && panel);
      assert.strictEqual(tabs.length, 2);
      const activeTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
      const inactiveTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'false');
      assert.ok(activeTab && inactiveTab);
      assert.strictEqual(activeTab.tabIndex, 0);
      assert.strictEqual(inactiveTab.tabIndex, -1);
      assert.strictEqual(activeTab.getAttribute('aria-controls'), panel.id);
      assert.strictEqual(panel.getAttribute('aria-labelledby'), activeTab.id);
      assert.ok(panel.querySelector('[data-id="button-one"]'));
      assert.strictEqual(panel.querySelector('[data-id="button-two"]'), null);

      inactiveTab.dispatchEvent(new fixture.dom.window.MouseEvent('click', { bubbles: true }));
      const refreshedActive = document.querySelector<HTMLButtonElement>('.preview-pages-tablist [role="tab"][aria-selected="true"]');
      const refreshedPanel = document.querySelector<HTMLElement>('.preview-pages-active-panel[role="tabpanel"]');
      assert.strictEqual(refreshedActive?.dataset.pageId, 'page-two');
      assert.ok(refreshedPanel?.querySelector('[data-id="button-two"]'));
      assert.deepStrictEqual(fixture.messages.filter((message) => message.type === 'selectElement'), [], 'tab navigation stays local');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });

  test('renders tab chrome for empty Pages and keeps non-Page children after its active panel', () => {
    withRuntime((fixture) => {
      const emptyPages = item('Pages', 'empty-pages', 'EmptyPages');
      const populatedPages = item('Pages', 'populated-pages', 'PopulatedPages', [
        item('Page', 'active-page', 'Active', [item('LabelField', 'inside-page', 'Inside')]),
        item('Button', 'outside-page', 'Outside'),
      ]);
      sendModel(fixture, model([emptyPages, populatedPages]));
      const document = fixture.dom.window.document;
      const emptyOuter = document.querySelector('.preview-item[data-id="empty-pages"]');
      assert.ok(emptyOuter?.querySelector('[role="tablist"]'), 'Pages has tab chrome before Page children are added');
      assert.strictEqual(emptyOuter?.querySelector('[role="tabpanel"]')?.textContent, 'Нет страниц');
      assert.ok(emptyOuter?.querySelector('[role="tabpanel"]')?.classList.contains('preview-empty-state'));
      const populatedOuter = document.querySelector('.preview-item[data-id="populated-pages"] .preview-pages-outer');
      assert.ok(populatedOuter?.querySelector('.preview-pages-active-panel [data-id="inside-page"]'));
      assert.ok(populatedOuter?.querySelector('.preview-pages-nonpage-children [data-id="outside-page"]'));
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    });
  });
});
