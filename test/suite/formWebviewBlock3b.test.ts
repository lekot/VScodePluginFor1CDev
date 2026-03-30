import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';

/** Contract tests for 1CVIEWER-36 Block 3 phase B: layout meta parity (spacing, align, ChildItemsWidth, ThroughAlign) in embedded preview script/CSS. */
suite('form webview Block 3B — groups & alignment (1CVIEWER-36)', () => {
  let html: string;

  suiteSetup(() => {
    html = getWebviewHtml({} as vscode.Webview, vscode.ColorThemeKind.Dark);
  });

  test('CSS: ChildItemsWidth and ThroughAlign preview hooks', () => {
    assert.ok(html.includes('preview-ciwidth-equal'), 'equal width hook');
    assert.ok(html.includes('preview-ciwidth-leftwidest'), 'left widest hook');
    assert.ok(html.includes('preview-ciwidth-rightwidest'), 'right widest hook');
    assert.ok(html.includes('preview-throughalign-use'), 'through-align stretch hooks');
  });

  test('JS: getContainerLayoutMeta distinguishes Pages root (no group B layout)', () => {
    assert.ok(html.includes("var isPagesRoot = tag === 'Pages';"), 'Pages root flag');
    assert.ok(
      html.includes('if (!isPagesRoot)') && html.includes('horizontalSpacing = normalizeSpacingKindJs'),
      'spacing extracted only for non-Pages containers'
    );
    assert.ok(
      html.includes("'ChildItemsWidth', 'childItemsWidth', 'ШиринаДочернихЭлементов'"),
      'ChildItemsWidth aliases'
    );
    assert.ok(
      html.includes("'ThroughAlign', 'throughAlign', 'СквозноеВыравнивание'"),
      'ThroughAlign aliases'
    );
  });

  test('JS: spacing → gap via applyPreviewContainerLayout', () => {
    assert.ok(html.includes('function spacingKindToPxJs(k)'), 'pixel map for spacing');
    assert.ok(html.includes('function applyPreviewContainerLayout(el, meta)'), 'applies gap + flex');
    assert.ok(html.includes("el.style.rowGap = r + 'px'"), 'vertical spacing → rowGap');
    assert.ok(html.includes("el.style.columnGap = c + 'px'"), 'horizontal spacing → columnGap');
    assert.ok(html.includes("el.style.justifyContent = meta.flexJustifyContent || ''"), 'justify from meta');
    assert.ok(html.includes("el.style.alignItems = meta.flexAlignItems || ''"), 'align from meta');
  });

  test('JS: layoutPreviewFlexBoxJs mirrors TS (swap axes + ThroughAlign stretch)', () => {
    assert.ok(html.includes('function layoutPreviewFlexBoxJs(orientation, gh, gv, throughAlign)'), 'flex mapper');
    assert.ok(
      html.includes("if (throughAlign === 'use') flexAlignItems = 'stretch';"),
      'ThroughAlign forces stretch on cross axis'
    );
  });

  test('JS: normalizers for spacing / child width / through align', () => {
    assert.ok(html.includes('function normalizeSpacingKindJs(raw)'), 'spacing kind');
    assert.ok(html.includes('function normalizeChildItemsWidthJs(raw)'), 'ChildItemsWidth kind');
    assert.ok(html.includes('function normalizeThroughAlignJs(raw)'), 'ThroughAlign kind');
  });
});
