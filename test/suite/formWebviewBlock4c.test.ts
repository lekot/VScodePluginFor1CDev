import '../helpers/vscodeStubRegister';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { getWebviewHtml } from '../../src/formEditor/formWebviewHtml';
import type { FormChildItem, FormModel } from '../../src/formEditor/formModel';
import { createFormWebviewRuntimeFixture } from '../helpers/formWebviewRuntime';

function item(tag: string, id: string, name: string, properties: Record<string, unknown> = {}): FormChildItem {
  return { tag, id, name, properties, childItems: [] };
}

function sendItems(items: FormChildItem[]): ReturnType<typeof createFormWebviewRuntimeFixture> {
  const fixture = createFormWebviewRuntimeFixture();
  try {
    const formModel: FormModel = { childItemsRoot: items, attributes: [], commands: [], formEvents: [] };
    fixture.send({ type: 'formData', formModel });
    return fixture;
  } catch (error) {
    fixture.close();
    throw error;
  }
}

/** Contract tests for 1CVIEWER-36 Block 4 phase C: Title multilang, TitleLocation, rare-tag fallback widget. */
suite('form webview Block 4C - title/location/fallback (1CVIEWER-36)', () => {
  let html: string;

  suiteSetup(() => {
    html = getWebviewHtml({} as vscode.Webview, vscode.ColorThemeKind.Dark);
  });

  test('uses a non-empty title and falls back to the item name when Title is missing or blank', () => {
    const fixture = sendItems([
      item('Button', 'with-title', 'ButtonName', { Title: 'Visible title' }),
      item('Button', 'empty-title', 'Fallback name', { Title: '   ' }),
    ]);
    try {
      const buttons = Array.from(fixture.dom.window.document.querySelectorAll('.preview-item .preview-button'));
      assert.strictEqual(buttons[0]?.textContent, 'Visible title');
      assert.strictEqual(buttons[1]?.textContent, 'Fallback name');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('resolves namespaced multilingual Title values and ignores XML attributes', () => {
    const fixture = sendItems([
      item('Button', 'localized', 'Fallback', {
        'v8:Title': {
          ':@': { '@_v8:ignored': 'must not be displayed' },
          'v8:item': [
            { ':@': { '@_lang': 'ru' }, 'v8:lang': 'ru', 'v8:content': 'Русская кнопка' },
            { ':@': { '@_lang': 'en' }, 'v8:lang': 'en', 'v8:content': 'English button' },
          ],
        },
      }),
    ]);
    try {
      const button = fixture.dom.window.document.querySelector('.preview-item[data-id="localized"] .preview-button');
      assert.strictEqual(button?.textContent, 'English button', 'the runtime locale selects matching namespaced content');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('finds namespaced Title properties and rejects whitespace-only localized content', () => {
    const fixture = sendItems([
      item('Button', 'namespaced-title', 'Stable name', { 'v8:Title': '  ' }),
    ]);
    try {
      const button = fixture.dom.window.document.querySelector('.preview-item[data-id="namespaced-title"] .preview-button');
      assert.strictEqual(button?.textContent, 'Stable name');
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('renders input-like controls with each supported TitleLocation and its CSS class', () => {
    const fixture = sendItems(['Left', 'Right', 'Top', 'Bottom', 'None'].map((location) =>
      item('InputField', `field-${location.toLowerCase()}`, `Field${location}`, { Title: `Title${location}`, TitleLocation: location })
    ));
    try {
      const document = fixture.dom.window.document;
      for (const location of ['left', 'right', 'top', 'bottom', 'none']) {
        assert.ok(document.querySelector(`.preview-item[data-id="field-${location}"] .preview-field-row.preview-title-${location}`), `${location} title location renders`);
      }
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
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('normalizes English and Russian TitleLocation values and defaults unknown values to left', () => {
    const fixture = sendItems([
      item('InputField', 'default', 'Default'),
      item('InputField', 'none-ru', 'NoneRu', { TitleLocation: 'Нет' }),
      item('InputField', 'right-ru', 'RightRu', { TitleLocation: 'Справа' }),
      item('InputField', 'top-ru', 'TopRu', { TitleLocation: 'Сверху' }),
      item('InputField', 'bottom-ru', 'BottomRu', { TitleLocation: 'Снизу' }),
      item('InputField', 'unknown', 'Unknown', { TitleLocation: 'Unexpected' }),
    ]);
    try {
      const document = fixture.dom.window.document;
      assert.ok(document.querySelector('.preview-item[data-id="default"] .preview-title-left'));
      assert.ok(document.querySelector('.preview-item[data-id="none-ru"] .preview-title-none'));
      assert.ok(document.querySelector('.preview-item[data-id="right-ru"] .preview-title-right'));
      assert.ok(document.querySelector('.preview-item[data-id="top-ru"] .preview-title-top'));
      assert.ok(document.querySelector('.preview-item[data-id="bottom-ru"] .preview-title-bottom'));
      assert.ok(document.querySelector('.preview-item[data-id="unknown"] .preview-title-left'));
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });

  test('rare controls use the fallback widget while RadioButtonField keeps its specialized mock', () => {
    const rareTags = [
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
    ];
    const fixture = sendItems([
      ...rareTags.map((tag) => item(tag, `rare-${tag}`, `Label-${tag}`)),
      item('RadioButtonField', 'radio-field', 'Radio label'),
    ]);
    try {
      const document = fixture.dom.window.document;
      for (const tag of rareTags) {
        const widget = document.querySelector<HTMLElement>(`.preview-item[data-id="rare-${tag}"] .preview-fallback-widget`);
        assert.ok(widget, `${tag} uses the common fallback widget`);
        assert.strictEqual(widget.querySelector('.fallback-label')?.textContent, `Label-${tag}`);
        assert.strictEqual(widget.querySelector('.fallback-tag')?.textContent, tag);
      }
      assert.strictEqual(document.querySelectorAll('.preview-item[data-id="radio-field"] input[type="radio"]').length, 3);
    assert.ok(html.includes('.preview-fallback-widget {'), 'fallback widget CSS block');
    assert.ok(
      html.includes('.preview-fallback-widget .fallback-label') &&
        html.includes('.preview-fallback-widget .fallback-tag'),
      'fallback widget sub-element styles'
    );
      assert.deepStrictEqual(fixture.runtimeErrors, []);
    } finally {
      fixture.close();
    }
  });
});
