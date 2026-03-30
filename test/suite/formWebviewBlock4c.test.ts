import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';

/** Contract tests for 1CVIEWER-36 Block 4 phase C: Title multilang, TitleLocation, rare-tag fallback widget. */
suite('form webview Block 4C - title/location/fallback (1CVIEWER-36)', () => {
  let html: string;

  suiteSetup(() => {
    html = getWebviewHtml({} as vscode.Webview, vscode.ColorThemeKind.Dark);
  });

  test('JS: resolvePreviewTitle exists and falls back to item.name', () => {
    assert.ok(html.includes('function resolvePreviewTitle(item, localeHint)'), 'title resolver function');
    assert.ok(html.includes('if (!item) return \'\';'), 'null-safe guard');
    assert.ok(
      html.includes('return String(item.name || \'\').trim();'),
      'fallback to item.name when Title is absent/empty'
    );
  });

  test('JS: Title extraction supports multilang nodes via v8:item aliases', () => {
    assert.ok(html.includes('function extractTitleValue(rawTitle, localeHint)'), 'title extraction helper');
    assert.ok(
      html.includes("if (local !== 'item') continue;"),
      'accepts namespaced local key "item" (including v8:item)'
    );
    assert.ok(
      html.includes('var localized = pickLocalizedContent(items, localeHint);'),
      'multilang selection for item list'
    );
    assert.ok(
      html.includes("if (key === ':@' || key.startsWith('@')) continue;"),
      'ignores XML attributes while parsing Title payload'
    );
  });

  test('JS: Title property lookup supports namespaced Title key', () => {
    assert.ok(
      html.includes('if (local === \'Title\') {') && html.includes('titleRaw = props[propKey];'),
      'resolves Title by local key even when property is namespaced'
    );
    assert.ok(
      html.includes('if (title && String(title).trim() !== \'\') return String(title).trim();'),
      'empty/whitespace title is rejected before fallback'
    );
  });

  test('CSS + JS: Input-like controls branch by TitleLocation Left/Right/Top/Bottom/None', () => {
    assert.ok(
      html.includes("if (tag === 'InputField' || tag === 'SearchStringAddition' || tag === 'ValueList')"),
      'TitleLocation branch applies to all input-like controls in contract C'
    );
    assert.ok(
      html.includes("wrap.className = 'preview-control-wrap preview-field-row preview-title-' + titleLocation;"),
      'location class composed dynamically'
    );
    assert.ok(html.includes('.preview-field-row.preview-title-right { flex-direction: row-reverse; justify-content: flex-end; }'), 'right title location CSS');
    assert.ok(
      html.includes('.preview-field-row.preview-title-top,') &&
        html.includes('.preview-field-row.preview-title-bottom {'),
      'top/bottom title location CSS'
    );
    assert.ok(
      html.includes('.preview-field-row.preview-title-bottom .preview-field-label { order: 2; }') &&
        html.includes('.preview-field-row.preview-title-bottom .preview-input { order: 1; }'),
      'bottom location reorders label and input'
    );
    assert.ok(
      html.includes('.preview-field-row.preview-title-none .preview-field-label { display: none; }'),
      'none location hides label'
    );
  });

  test('JS: normalizeTitleLocation handles defaults, RU/EN aliases, and None', () => {
    assert.ok(html.includes('function normalizeTitleLocation(raw)'), 'TitleLocation normalizer');
    assert.ok(html.includes("if (!value) return 'left';"), 'default location is left');
    assert.ok(
      html.includes("if (value === 'none' || value.indexOf('нет') >= 0) return 'none';"),
      'none alias in EN/RU'
    );
    assert.ok(
      html.includes("if (value === 'right' || value.indexOf('прав') >= 0) return 'right';"),
      'right alias in EN/RU'
    );
    assert.ok(
      html.includes("if (value === 'top' || value.indexOf('верх') >= 0) return 'top';"),
      'top alias in EN/RU'
    );
    assert.ok(
      html.includes("if (value === 'bottom' || value.indexOf('низ') >= 0) return 'bottom';"),
      'bottom alias in EN/RU'
    );
    assert.ok(
      html.includes("if (!item || !item.properties) return 'left';"),
      'resolver fallback for missing properties'
    );
  });

  test('JS + CSS: rare controls from §17 use unified fallback widget', () => {
    assert.ok(html.includes('var RARE_TAG_FALLBACKS = new Set(['), 'rare-tag set exists');
    [
      'RadioButtonField',
      'TrackBarField',
      'ProgressBarField',
      'TextDocumentField',
      'SpreadSheetDocumentField',
      'HTMLDocumentField',
      'ChartField',
      'GanttChartField',
      'PlannerField',
      'GraphicalSchemaField',
      'FormattedDocumentField'
    ].forEach((tag) => assert.ok(html.includes(`'${tag}'`), `rare tag listed: ${tag}`));

    assert.ok(html.includes('function createRareTagFallbackWidget(label, tag)'), 'factory for single fallback widget');
    assert.ok(html.includes("widget.className = 'preview-fallback-widget';"), 'fallback widget class');
    assert.ok(html.includes("text.className = 'fallback-label';"), 'fallback label class');
    assert.ok(html.includes("pill.className = 'fallback-tag';"), 'fallback tag class');
    assert.ok(
      html.includes('} else if (RARE_TAG_FALLBACKS.has(tag)) {') &&
        html.includes('wrap.appendChild(createRareTagFallbackWidget(label, tag));'),
      'createPreviewControl routes rare tags to unified widget'
    );
    assert.ok(html.includes('.preview-fallback-widget {'), 'fallback widget CSS block');
    assert.ok(
      html.includes('.preview-fallback-widget .fallback-label') &&
        html.includes('.preview-fallback-widget .fallback-tag'),
      'fallback widget sub-element styles'
    );
  });
});
